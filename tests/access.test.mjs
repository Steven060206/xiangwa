import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createGameServer } from '../src/server.mjs';
import { createAccessControl } from '../src/access.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xiangwa-access-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  let clock = Date.UTC(2026, 9, 27, 12);
  const access = createAccessControl({ directory, now: () => clock });
  const dataFile = join(directory, 'rooms.json');
  let server, base;
  async function restart() {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    server = createGameServer({ dataFile, accessDirectory: directory, accessNow: () => clock, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await restart();
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, body, cookie, headers = {}) {
    const response = await fetch(`${base}${path}`, { headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers,
    }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const admin = input => request('/api/access/admin', input, undefined, { authorization: `Bearer ${access.adminKey}` });
  const issue = async (input = {}) => {
    const result = await admin({ action: 'create', ...input });
    assert.equal(result.status, 200);
    return result.body;
  };
  const redeem = (code, cookie, headers) => request('/api/access/redeem', { code }, cookie, headers);
  return { directory, dataFile, request, admin, issue, redeem, restart,
    advance(ms) { clock += ms; }, get now() { return clock; }, get base() { return base; }, get server() { return server; } };
}

test('protected entry rejects creating and joining before invitation validation and keeps administration private', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/access')).body, { required: true, authorized: false });
  for (const path of ['/api/rooms', '/api/rooms/ABCDEF/join']) {
    assert.equal((await f.request(path, { name: '陌生人' })).status, 401);
  }
  assert.equal((await f.request('/api/access/admin', { action: 'create' })).status, 403);
  assert.equal((await f.request('/api/access/admin', { action: 'list' }, undefined, { authorization: 'Bearer guessed' })).status, 403);
  assert.equal((await f.request('/api/access/redeem', { code: 'guessed' })).status, 401);
  await assert.rejects(readFile(f.dataFile), { code: 'ENOENT' });
  for (const path of ['/data/access.json', '/access.json', '/data/rooms.json', '/scripts/manage-invites.mjs']) {
    const response = await fetch(`${f.base}${path}`);
    assert.equal(response.status, 404);
  }
});

test('issued codes grant persistent HttpOnly access, normalize formatting and consume one use per browser', async t => {
  const f = await fixture(t);
  const invite = await f.issue({ maxUses: 2 });
  assert.match(invite.code, /^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/);
  const first = await f.redeem(invite.code.toLowerCase().replaceAll('-', ' '));
  assert.equal(first.status, 200);
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await f.redeem(invite.code, first.cookie)).status, 200);
  const second = await f.redeem(invite.code);
  assert.equal(second.status, 200);
  assert.equal((await f.redeem(invite.code)).status, 401);
  assert.equal((await f.admin({ action: 'list' })).body.invites[0].uses, 2);
  assert.equal((await f.request('/api/access', undefined, first.cookie)).body.authorized, true);
  await f.restart();
  assert.equal((await f.request('/api/access', undefined, first.cookie)).body.authorized, true);
  const saved = await readFile(join(f.directory, 'access.json'), 'utf8');
  assert.ok(!saved.includes(invite.code) && !saved.includes(first.cookie.split('=')[1]), 'Bearer codes and browser tokens are stored as digests');
});

test('new invitation defaults admit five browsers and retain that limit after restart', async t => {
  const f = await fixture(t);
  const invite = await f.issue();
  assert.equal(invite.maxUses, 5);
  assert.equal(invite.expiresAt - f.now, 30 * 60 * 1000);
  for (let index = 0; index < 4; index++) assert.equal((await f.redeem(invite.code)).status, 200);
  await f.restart();
  assert.equal((await f.redeem(invite.code)).status, 200);
  assert.equal((await f.redeem(invite.code)).status, 401);
  const saved = (await f.admin({ action: 'list' })).body.invites[0];
  assert.equal(saved.maxUses, 5);
  assert.equal(saved.uses, 5);
});

test('explicit four-browser invitation limits remain four when restored from disk', async t => {
  const f = await fixture(t);
  const invite = await f.issue({ maxUses: 4 });
  for (let index = 0; index < 2; index++) assert.equal((await f.redeem(invite.code)).status, 200);
  await f.restart();
  for (let index = 0; index < 2; index++) assert.equal((await f.redeem(invite.code)).status, 200);
  assert.equal((await f.redeem(invite.code)).status, 401);
  assert.equal((await f.admin({ action: 'list' })).body.invites[0].maxUses, 4);
});

test('public-host cookies are Secure and cross-origin invitation or room submissions fail', async t => {
  const f = await fixture(t);
  const invite = await f.issue();
  // fetch ignores a supplied Host header; raw HTTP reproduces the tunnel's public Host.
  const accepted = await new Promise((resolve, reject) => {
    const request = http.request(`${f.base}/api/access/redeem`, { method: 'POST', headers: {
      host: 'game.example.com', 'content-type': 'application/json',
    } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, cookie: response.headers['set-cookie']?.[0].split(';')[0],
        headers: new Headers({ 'set-cookie': response.headers['set-cookie']?.[0] || '' }), body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ code: invite.code }));
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie'), /; Secure/);
  const forged = { origin: 'https://other.example', host: 'game.example.com' };
  assert.equal((await f.redeem(invite.code, undefined, forged)).status, 403);
  assert.equal((await f.request('/api/rooms', { name: '伪造' }, accepted.cookie, forged)).status, 403);
});

test('simultaneous redemption cannot exceed an invitation usage limit', async t => {
  const f = await fixture(t);
  const invite = await f.issue({ maxUses: 1 });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.redeem(invite.code)));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 401).length, 5);
});

test('expiry blocks new admission while original credentials, actions, polling, SSE and restart recovery survive', async t => {
  const f = await fixture(t);
  const invite = await f.issue({ hours: 1 / 60 });
  const { cookie } = await f.redeem(invite.code);
  const created = await f.request('/api/rooms', { name: '原玩家' }, cookie);
  assert.equal(created.status, 201);
  const person = created.body;
  const query = new URLSearchParams({ playerId: person.playerId, token: person.token });
  const path = `/api/rooms/${person.roomCode}`;
  f.advance(60001);
  assert.equal((await f.request('/api/access', undefined, cookie)).body.authorized, false);
  assert.equal((await f.redeem(invite.code)).status, 401);
  assert.equal((await f.request('/api/rooms', { name: '新房间' }, cookie)).status, 401);
  assert.equal((await f.request(`${path}/join`, { name: '新人' }, cookie)).status, 401);
  assert.equal((await f.request(`${path}?${query}&poll=1`)).status, 200);
  assert.equal((await f.request(`${path}/actions`, { playerId: person.playerId, token: person.token, type: 'ready', ready: true })).status, 200);
  const controller = new AbortController();
  const stream = await fetch(`${f.base}${path}/events?${query}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /event-stream/);
  controller.abort();
  await f.restart();
  const recovered = await f.request(`${path}?${query}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.players.length, 1);
  assert.equal(recovered.body.players[0].ready, true);
  assert.ok(!JSON.stringify(recovered.body).includes(invite.code));
});

test('a default invitation expires at thirty minutes while a started five-player game survives actions, reconnect and restart', async t => {
  const f = await fixture(t, { silentNumbers: [0, 1, 2, 3, 4, 5] });
  const invite = await f.issue();
  const people = [];
  let cookie;
  for (let index = 0; index < 5; index++) {
    const accepted = await f.redeem(invite.code);
    assert.equal(accepted.status, 200);
    cookie = accepted.cookie;
    const joined = await f.request(index ? `/api/rooms/${people[0].roomCode}/join` : '/api/rooms',
      { name: `半小时玩家${index}`, ...(!index ? { playerCount: 5 } : {}) }, cookie);
    assert.equal(joined.status, 201);
    people.push(joined.body);
  }
  const [host, visitor] = people;
  const path = `/api/rooms/${host.roomCode}`;
  const query = new URLSearchParams({ playerId: visitor.playerId, token: visitor.token });
  async function act(person, type, input = {}) {
    const response = await f.request(`${path}/actions`, { playerId: person.playerId, token: person.token, type, ...input });
    assert.equal(response.status, 200, `${type}: ${response.body.error ?? ''}`);
    return response.body;
  }
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(host, 'start');
  let state = await act(host, 'claim_hako');
  while (state.phase === 'item_draft') {
    state = await act(people.find(person => person.playerId === state.draft.turnPlayerId), 'choose_item',
      { itemId: state.draft.availableItems[0].id });
  }
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  await act(host, 'prepare_opening');
  await act(host, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await act(host, 'place_remains', { cornerId: 'living_sofa' });
  await act(host, 'inspect_initial_room', { roomId: 'children_room' });
  state = await act(host, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  state = await act(host, 'choose_initial_power', { powerId: state.opening.initialPowerOptions[0].id });
  assert.equal(state.phase, 'practice');
  f.advance(30 * 60 * 1000 - 1);
  assert.equal((await f.request('/api/access', undefined, cookie)).body.authorized, true);
  f.advance(1);
  assert.equal((await f.request('/api/access', undefined, cookie)).body.authorized, false);
  assert.equal((await f.redeem(invite.code)).status, 401);
  assert.equal((await f.request('/api/rooms', { name: '过期新房' }, cookie)).status, 401);
  assert.equal((await f.request(`${path}/join`, { name: '过期新人' }, cookie)).status, 401);
  assert.equal((await f.request(`${path}?${query}&poll=1`)).body.phase, 'practice');
  state = await act(visitor, 'silent_reveal', { index: 0 });
  await act(visitor, 'move', { roomId: state.round.moveTargets[0] });
  state = await act(host, 'resolve_visitor_action');
  assert.equal(state.phase, 'practice');
  const controller = new AbortController();
  const stream = await fetch(`${f.base}${path}/events?${query}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /event-stream/);
  controller.abort();
  await f.restart();
  const recovered = await f.request(`${path}?${query}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.phase, 'practice');
  assert.equal(recovered.body.players.length, 5);
  assert.equal(recovered.body.round.silent.turnPlayerId, people[2].playerId);
  assert.equal((await f.request(`${path}?${query}&poll=1`)).status, 200);
  await act(people[2], 'silent_reveal', { index: 1 });
});

test('revocation stops unused codes and browser permissions without removing an existing player', async t => {
  const f = await fixture(t);
  const invite = await f.issue();
  const accepted = await f.redeem(invite.code);
  const created = (await f.request('/api/rooms', { name: '保留席位' }, accepted.cookie)).body;
  assert.equal((await f.admin({ action: 'revoke', id: invite.id })).status, 200);
  assert.equal((await f.redeem(invite.code)).status, 401);
  assert.equal((await f.request('/api/access', undefined, accepted.cookie)).body.authorized, false);
  const query = new URLSearchParams({ playerId: created.playerId, token: created.token });
  assert.equal((await f.request(`/api/rooms/${created.roomCode}?${query}`)).status, 200);
});

test('four players on one network may validate, join, poll and open duplicate SSE tabs', async t => {
  const f = await fixture(t);
  const invite = await f.issue();
  const people = [];
  for (let index = 0; index < 4; index++) {
    const accepted = await f.redeem(invite.code);
    assert.equal(accepted.status, 200);
    const joined = await f.request(index ? `/api/rooms/${people[0].roomCode}/join` : '/api/rooms', { name: `玩家${index}` }, accepted.cookie);
    assert.equal(joined.status, 201);
    people.push(joined.body);
  }
  for (const person of people) {
    const query = new URLSearchParams({ playerId: person.playerId, token: person.token });
    assert.equal((await f.request(`/api/rooms/${person.roomCode}?${query}&poll=1`)).body.players.length, 4);
  }
  const controllers = [];
  try {
    for (let index = 0; index < 2; index++) {
      const controller = new AbortController(); controllers.push(controller);
      const first = people[0], query = new URLSearchParams({ playerId: first.playerId, token: first.token });
      const response = await fetch(`${f.base}/api/rooms/${first.roomCode}/events?${query}`, { signal: controller.signal });
      assert.equal(response.status, 200);
    }
  } finally { controllers.forEach(controller => controller.abort()); }
});

test('room limits remain enforced during concurrent requests and release after the last player leaves', async t => {
  const f = await fixture(t, { limits: { maxRooms: 2 } });
  const invite = await f.issue();
  const { cookie } = await f.redeem(invite.code);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => f.request('/api/rooms', { name: `房主${index}` }, cookie)));
  const created = results.filter(result => result.status === 201);
  assert.equal(created.length, 2);
  assert.equal(results.filter(result => result.status === 503).length, 4);
  const person = created[0].body;
  assert.equal((await f.request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type: 'leave' })).status, 200);
  assert.equal((await f.request('/api/rooms', { name: '空出名额' }, cookie)).status, 201);
});

test('SSE player and global limits reject overflow while polling remains available', async t => {
  const f = await fixture(t, { limits: { maxStreams: 2, streamsPerPlayer: 1 } });
  const invite = await f.issue();
  const { cookie } = await f.redeem(invite.code);
  const first = (await f.request('/api/rooms', { name: '一号' }, cookie)).body;
  const second = (await f.request(`/api/rooms/${first.roomCode}/join`, { name: '二号' }, cookie)).body;
  const third = (await f.request(`/api/rooms/${first.roomCode}/join`, { name: '三号' }, cookie)).body;
  const query = person => new URLSearchParams({ playerId: person.playerId, token: person.token });
  const controllers = [];
  t.after(() => controllers.forEach(controller => controller.abort()));
  for (const person of [first, second]) {
    const controller = new AbortController(); controllers.push(controller);
    assert.equal((await fetch(`${f.base}/api/rooms/${person.roomCode}/events?${query(person)}`, { signal: controller.signal })).status, 200);
  }
  for (const person of [first, third]) {
    assert.equal((await f.request(`/api/rooms/${person.roomCode}/events?${query(person)}`)).status, 429);
  }
  assert.equal((await f.request(`/api/rooms/${first.roomCode}?${query(first)}&poll=1`)).status, 200);
  assert.equal(f.server.maxConnections, 128);
});

test('global request and invitation throttles ignore forged proxy headers and recover with time', async t => {
  const f = await fixture(t, { limits: { inviteAttemptBurst: 2, inviteAttemptsPerMinute: 2 } });
  for (let index = 0; index < 2; index++) assert.equal((await f.redeem('wrong')).status, 401);
  const refused = await f.redeem('wrong', undefined, { 'x-forwarded-for': '203.0.113.1', 'cf-connecting-ip': '203.0.113.2' });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '5');
  f.advance(30000);
  assert.equal((await f.redeem('wrong')).status, 401);
  const constrained = await fixture(t, { limits: { requestBurst: 2, requestsPerMinute: 2 } });
  assert.equal((await constrained.request('/api/health')).status, 200);
  assert.equal((await constrained.request('/api/health')).status, 200);
  assert.equal((await constrained.request('/api/access', undefined, undefined, { 'cf-connecting-ip': '1.2.3.4' })).status, 429);
  constrained.advance(30000);
  assert.equal((await constrained.request('/api/access')).status, 200);
});

test('failed access persistence consumes no invitation use and issues no cookie', async t => {
  const f = await fixture(t);
  const invite = await f.issue({ maxUses: 1 });
  const temporary = join(f.directory, 'access.json.tmp');
  await mkdir(temporary);
  const before = await readFile(join(f.directory, 'access.json'), 'utf8');
  const failed = await f.redeem(invite.code);
  assert.equal(failed.status, 503);
  assert.equal(failed.cookie, undefined);
  assert.equal(await readFile(join(f.directory, 'access.json'), 'utf8'), before);
  await rm(temporary, { recursive: true });
  assert.equal((await f.redeem(invite.code)).status, 200);
});

test('corrupt access stores stop startup and preserve original data', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'access.json');
  await writeFile(file, 'corrupt access state');
  assert.throws(() => createAccessControl({ directory: f.directory }), /保留原文件/);
  assert.equal(await readFile(file, 'utf8'), 'corrupt access state');
});

test('invalid invite duration and usage bounds do not mutate the store', async t => {
  const f = await fixture(t);
  for (const input of [{ hours: 0 }, { hours: 200 }, { hours: '4' }, { maxUses: 0 }, { maxUses: 33 }, { maxUses: 1.5 }]) {
    assert.equal((await f.admin({ action: 'create', ...input })).status, 400);
  }
  assert.deepEqual((await f.admin({ action: 'list' })).body, { invites: [] });
});

test('local CLI creates, lists and revokes through its private key without changing room data', async t => {
  const f = await fixture(t);
  async function run(args) {
    const child = spawn(process.execPath, ['scripts/manage-invites.mjs', '--directory', f.directory,
      '--port', String(f.server.address().port), '--json', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    return JSON.parse(output);
  }
  const invite = await run(['--hours', '2', '--uses', '3']);
  assert.equal(invite.maxUses, 3);
  assert.equal(invite.expiresAt - f.now, 2 * 60 * 60 * 1000);
  const defaultInvite = await run([]);
  assert.equal(defaultInvite.maxUses, 5);
  assert.equal(defaultInvite.expiresAt - f.now, 30 * 60 * 1000);
  const list = await run(['--list']);
  assert.equal(list.invites.length, 2);
  assert.ok(!JSON.stringify(list).includes(invite.code));
  assert.equal((await run(['--revoke', invite.id])).ok, true);
  assert.equal((await f.redeem(invite.code)).status, 401);
  await assert.rejects(readFile(f.dataFile), { code: 'ENOENT' });
});
