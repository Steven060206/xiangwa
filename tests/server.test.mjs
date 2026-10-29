import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const underlyingTokens = corners => corners.map(({ id, token }) => ({
  id, token: token ? Object.fromEntries(Object.entries(token).filter(([key]) => key !== 'name')) : null,
}));

async function startServer(t, options = {}) {
  const server = createGameServer({ deck, silentNumbers: [5, 4, 1, 2, 0, 3], ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.listening && new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  return { base, request, server };
}

async function persistentServer(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-persistence-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const dataFile = join(directory, 'rooms.json');
  let running;
  async function restart() {
    if (running) await new Promise((resolve, reject) => running.server.close(error => error ? reject(error) : resolve()));
    running = await startServer(t, { ...options, dataFile });
  }
  await restart();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { dataFile, restart, request: (...args) => running.request(...args),
    get base() { return running.base; } };
}

async function checkRestart(saved, people) {
  const before = await Promise.all(people.map(async person => (await snapshot(saved.request, person)).body));
  await saved.restart();
  for (let i = 0; i < people.length; i++) {
    const recovered = await snapshot(saved.request, people[i]);
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, { ...before[i],
      players: before[i].players.map(player => ({ ...player, connected: !!player.isBot })),
    });
  }
}

async function createFour(request) {
  const first = await request('/api/rooms', { name: '箱娃' });
  assert.equal(first.status, 201);
  const identities = [first.body];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const joined = await request(`/api/rooms/${first.body.roomCode.toLowerCase()}/join`, { name });
    assert.equal(joined.status, 201);
    identities.push(joined.body);
  }
  return identities;
}

function action(request, identity, type, values = {}) {
  return request(`/api/rooms/${identity.roomCode}/actions`, {
    playerId: identity.playerId, token: identity.token, type, ...values,
  });
}

function snapshot(request, identity, { poll = false } = {}) {
  return request(`/api/rooms/${identity.roomCode}?${new URLSearchParams({
    playerId: identity.playerId, token: identity.token,
    ...(poll ? { poll: '1' } : {}),
  })}`);
}

async function waitForSnapshot(request, identity, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  do {
    const response = await snapshot(request, identity);
    assert.equal(response.status, 200);
    state = response.body;
    if (predicate(state)) return state;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Room did not reach the expected state: phase=${state.phase}, round=${state.round?.phase}, version=${state.version}`);
}

async function preparePlay(request, people, hako = people[0]) {
  for (const person of people) await action(request, person, 'ready', { ready: true });
  assert.equal((await action(request, people[0], 'start')).body.phase, 'hako_selection');
  let state = (await action(request, hako, 'claim_hako')).body;
  for (let index = 0; index < 3; index += 1) {
    const person = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = (await action(request, person, 'choose_item', { itemId: state.draft.availableItems[0].id })).body;
  }
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = (await action(request, person, 'draw')).body;
    state = (await action(request, person, 'place', state.setup.legalPlacements[0])).body;
  }
  await action(request, people[0], 'prepare_opening');
  await action(request, hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await action(request, hako, 'place_remains', { cornerId: 'living_sofa' });
  await action(request, hako, 'inspect_initial_room', { roomId: 'children_room' });
  const hidden = (await action(request, hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' })).body;
  const result = await action(request, hako, 'choose_initial_power', { powerId: hidden.opening.initialPowerOptions[0].id });
  assert.equal(result.status, 200);
  return result.body;
}

async function stream(t, base, identity) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/rooms/${identity.roomCode}/events?${new URLSearchParams({
    playerId: identity.playerId, token: identity.token,
  })}`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const closed = () => { abort.abort(); return reader.cancel().catch(() => {}); };
  t.after(closed);
  return {
    close: closed,
    async state(predicate = () => true, timeoutMs = 3000) {
      const readState = async () => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!event.startsWith('event: state\n')) continue;
            const state = JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6));
            if (predicate(state)) return state;
          } else {
            const { value, done } = await reader.read();
            assert.equal(done, false, 'SSE connection ended before matching state');
            buffer += decoder.decode(value, { stream: true });
          }
        }
      };
      let timeout;
      try {
        return await Promise.race([
          readState(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE state timed out')), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

test('four HTTP identities enforce lobby capacity, roles, readiness and authorization', async t => {
  const { request } = await startServer(t);
  for (const name of ['', '  ', '名'.repeat(17)]) {
    assert.equal((await request('/api/rooms', { name })).status, 400);
  }
  const people = await createFour(request);
  const [host, visitor, third, fourth] = people;
  assert.match(host.roomCode, /^[A-Z0-9]{6}$/);
  assert.equal(new Set(people.map(person => person.token)).size, 4);
  assert.equal(new Set(people.map(person => person.playerId)).size, 4);
  const state = (await snapshot(request, host)).body;
  assert.equal(state.hostId, host.playerId);
  assert.ok(state.players.every(player => player.role === 'visitor'));
  assert.deepEqual(state.players.map(player => player.seat), [0, 1, 2, 3]);
  assert.equal(state.you, host.playerId);
  assert.equal(state.setup, null);
  assert.ok(state.log.every(entry => typeof entry === 'string'));
  for (const person of people) assert.equal(JSON.stringify(state).includes(person.token), false);
  assert.equal((await request(`/api/rooms/${host.roomCode}/join`, { name: '第五人' })).status, 409);
  assert.equal((await action(request, { ...visitor, token: host.token }, 'ready', { ready: true })).status, 403);
  assert.equal((await request(`/api/rooms/${host.roomCode}`)).status, 403);
  assert.equal((await action(request, visitor, 'release_hako')).status, 400);
  assert.equal((await action(request, third, 'claim_hako')).status, 409);
  assert.equal((await action(request, visitor, 'start')).status, 403);
  assert.equal((await action(request, host, 'start')).status, 409);
  assert.equal((await action(request, visitor, 'ready', { ready: 'yes' })).status, 400);
  assert.equal((await action(request, visitor, 'ready', { ready: true })).status, 200);
  for (const person of people) assert.equal((await action(request, person, 'ready', { ready: true })).status, 200);
  const started = await action(request, host, 'start');
  assert.equal(started.status, 200);
  assert.equal(started.body.phase, 'hako_selection');
  assert.equal(started.body.draft, null);
  assert.ok(started.body.players.every(player => player.role === 'visitor' && player.ready));
  assert.equal((await action(request, host, 'ready', { ready: false })).status, 409);
  assert.equal((await action(request, fourth, 'leave')).status, 409);
  assert.equal((await request(`/api/rooms/${host.roomCode}/join`, { name: '后来者' })).status, 409);
  assert.equal((await action(request, host, 'start')).status, 409);
  const claimed = await action(request, third, 'claim_hako', { targetId: host.playerId });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.phase, 'item_draft');
  assert.deepEqual(claimed.body.players.filter(player => player.role === 'hako').map(player => player.id), [third.playerId],
    'An extra target cannot assign another player the role');
  assert.equal(claimed.body.draft.turnPlayerId, fourth.playerId, 'visitor after hako chooses first');
  assert.equal(claimed.body.draft.availableItems.length, 12);
  assert.equal((await action(request, third, 'choose_item', { itemId: 'spirit_pen' })).status, 409);
  assert.equal((await action(request, host, 'start')).status, 409);
  assert.equal((await action(request, host, 'claim_hako')).status, 409);
  assert.equal((await action(request, third, 'release_hako')).status, 400);
  assert.equal((await action(request, fourth, 'ready', { ready: false })).status, 409);
  assert.equal((await action(request, fourth, 'leave')).status, 409);
  assert.equal((await action(request, third, 'draw')).status, 409);
});

test('only a started selection accepts all four contenders and the first claim starts drafting atomically', async t => {
  const { base, request } = await startServer(t);
  const people = await createFour(request);
  const [host, first] = people;
  assert.ok(people.every(person => person.state.players.every(player => player.role === 'visitor')),
    'Creating and joining a room must not assign hako automatically');
  const streams = await Promise.all(people.map(person => stream(t, base, person)));
  for (const person of people) assert.equal((await action(request, person, 'claim_hako')).status, 409);
  for (const person of people) await action(request, person, 'ready', { ready: true });
  const before = (await snapshot(request, host)).body;
  for (const person of people) assert.equal((await action(request, person, 'claim_hako')).status, 409);
  assert.deepEqual((await snapshot(request, host)).body, before);
  assert.equal((await action(request, { ...first, token: host.token }, 'claim_hako')).status, 403);
  const selection = await action(request, host, 'start');
  assert.equal(selection.status, 200);
  assert.equal(selection.body.phase, 'hako_selection');
  assert.equal(selection.body.draft, null);
  assert.ok(selection.body.players.every(player => player.role === 'visitor' && player.ready));
  for (let i = 0; i < people.length; i++) {
    const refreshed = (await snapshot(request, people[i])).body;
    assert.deepEqual(refreshed, { ...selection.body, you: people[i].playerId });
    assert.deepEqual(await streams[i].state(update => update.version >= selection.body.version), refreshed);
  }
  const attempts = await Promise.all(people.map(person => action(request, person, 'claim_hako')));
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409, 409, 409]);
  const winnerIndex = attempts.findIndex(result => result.status === 200);
  const winner = people[winnerIndex];
  const state = (await snapshot(request, host)).body;
  assert.equal(state.phase, 'item_draft', 'The first claim starts drafting without another ready or start action');
  assert.deepEqual(state.players.filter(player => player.role === 'hako').map(player => player.id), [winner.playerId]);
  assert.equal(state.hostId, host.playerId, 'Claiming a role does not transfer host authority');
  assert.ok(state.players.every(player => player.ready));
  for (let i = 0; i < people.length; i++) {
    const refreshed = (await snapshot(request, people[i])).body;
    assert.deepEqual(refreshed, { ...state, you: people[i].playerId });
    assert.deepEqual(await streams[i].state(update => update.version >= state.version), refreshed);
  }
  for (const person of people) {
    assert.equal((await action(request, person, 'claim_hako')).status, 409);
    assert.equal((await action(request, person, 'release_hako', { targetId: winner.playerId })).status, 400);
  }
  assert.equal((await action(request, host, 'set_hako', { targetId: host.playerId })).status, 400);
  let drafted = state;
  const visitorOrder = [1, 2, 3].map(offset => people[(winnerIndex + offset) % 4]);
  for (const visitor of visitorOrder) {
    assert.equal(drafted.draft.turnPlayerId, visitor.playerId, 'Drafting follows seats clockwise from the chosen hako');
    const result = await action(request, visitor, 'choose_item', { itemId: drafted.draft.availableItems[0].id });
    assert.equal(result.status, 200);
    drafted = result.body;
  }
  assert.equal(drafted.phase, 'map_setup');
  assert.equal((await action(request, winner, 'claim_hako')).status, 409);
});

test('the ready selection and the claimed role survive restart and disconnected players keep their seats', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  await checkRestart(saved, people);
  const claimant = people[1];
  for (const person of people) await action(request, person, 'ready', { ready: true });
  assert.equal((await action(request, people[0], 'start')).body.phase, 'hako_selection');
  const disk = JSON.parse(await readFile(saved.dataFile, 'utf8'));
  assert.equal(disk.format, 1);
  assert.equal(disk.rooms[0].selectingHako, true);
  assert.ok(disk.rooms[0].players.every(player => player.role === 'visitor' && player.ready));
  const live = await stream(t, saved.base, claimant);
  assert.equal((await live.state()).phase, 'hako_selection');
  await live.close();
  await checkRestart(saved, people);
  const restored = (await snapshot(request, claimant)).body;
  assert.equal(restored.phase, 'hako_selection');
  assert.equal(restored.draft, null);
  assert.ok(restored.players.every(player => player.role === 'visitor' && player.ready));
  assert.equal((await action(request, claimant, 'leave')).status, 409);
  const claimed = await action(request, claimant, 'claim_hako');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.phase, 'item_draft');
  assert.equal(JSON.parse(await readFile(saved.dataFile, 'utf8')).rooms[0].selectingHako, false);
  const reconnected = await stream(t, saved.base, claimant);
  assert.equal((await reconnected.state()).players.find(player => player.role === 'hako').id, claimant.playerId);
  await reconnected.close();
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, people[0])).body.players.find(player => player.role === 'hako').id, claimant.playerId);
  assert.equal((await action(request, people[2], 'claim_hako')).status, 409);
  assert.equal((await action(request, claimant, 'claim_hako')).status, 409);
  assert.equal((await action(request, claimant, 'release_hako')).status, 400);
  assert.equal((await action(request, claimant, 'leave')).status, 409);
});

test('leaving the lobby frees a seat and transfers host authority', async t => {
  const { request } = await startServer(t);
  const [host, next] = await createFour(request);
  assert.equal((await action(request, host, 'leave')).status, 200);
  const state = (await snapshot(request, next)).body;
  assert.equal(state.hostId, next.playerId);
  assert.equal(state.players.length, 3);
  assert.equal(state.players.some(player => player.role === 'hako'), false);
  assert.equal((await snapshot(request, host)).status, 403);
  const replacement = await request(`/api/rooms/${next.roomCode}/join`, { name: '替补' });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.state.players.length, 4);
  assert.equal(replacement.body.state.players.find(player => player.id === replacement.body.playerId).seat, 0);
});

test('only the lobby host can remove an offline seat, and the server rechecks live connections', async t => {
  const { base, request } = await startServer(t);
  const people = await createFour(request);
  const [host, liveVisitor, pollingVisitor, offlineVisitor] = people;
  for (const person of people) await action(request, person, 'ready', { ready: true });
  const observer = await stream(t, base, host);
  await observer.state();
  const live = await stream(t, base, liveVisitor);
  await live.state();
  await observer.state(state => state.players.find(player => player.id === liveVisitor.playerId).connected);
  await snapshot(request, pollingVisitor, { poll: true });
  const before = (await snapshot(request, host)).body;
  for (const [actor, targetId, status] of [
    [liveVisitor, offlineVisitor.playerId, 403],
    [host, host.playerId, 409],
    [host, 'missing-player', 404],
    [host, liveVisitor.playerId, 409],
    [host, pollingVisitor.playerId, 409],
  ]) {
    assert.equal((await action(request, actor, 'remove_player', { targetId })).status, status);
    assert.deepEqual((await snapshot(request, host)).body, before);
  }
  const removed = await action(request, host, 'remove_player', { targetId: offlineVisitor.playerId });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.players.length, 3);
  assert.equal(removed.body.hostId, host.playerId);
  assert.ok(removed.body.players.every(player => !player.ready));
  assert.deepEqual(await observer.state(state => state.version >= removed.body.version), removed.body);
  assert.equal((await snapshot(request, offlineVisitor)).status, 403);
  const replacement = await request(`/api/rooms/${host.roomCode}/join`, { name: '新访问者' });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.state.players.find(player => player.id === replacement.body.playerId).seat, 3);
  for (const person of [host, liveVisitor, pollingVisitor, replacement.body]) await action(request, person, 'ready', { ready: true });
  const started = await action(request, host, 'start');
  assert.equal(started.status, 200);
  assert.equal((await action(request, host, 'remove_player', { targetId: replacement.body.playerId })).status, 409);
  assert.deepEqual((await snapshot(request, host)).body, started.body);
  const claimed = await action(request, host, 'claim_hako');
  assert.equal(claimed.status, 200);
  assert.equal((await action(request, host, 'remove_player', { targetId: replacement.body.playerId })).status, 409);
  assert.deepEqual((await snapshot(request, host)).body, claimed.body);
});

test('offline seat removal saves atomically and remains removed after restarting', async t => {
  const saved = await persistentServer(t);
  const host = (await saved.request('/api/rooms', { name: '房主' })).body;
  const visitor = (await saved.request(`/api/rooms/${host.roomCode}/join`, { name: '暂离玩家' })).body;
  await action(saved.request, host, 'ready', { ready: true });
  const before = (await snapshot(saved.request, host)).body;
  const bytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(saved.request, host, 'remove_player', { targetId: visitor.playerId })).status, 503);
    assert.deepEqual((await snapshot(saved.request, host)).body, before);
    assert.equal(await readFile(saved.dataFile, 'utf8'), bytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const removed = await action(saved.request, host, 'remove_player', { targetId: visitor.playerId });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.players.length, 1);
  assert.equal(removed.body.players[0].ready, false);
  await checkRestart(saved, [host]);
  assert.equal((await snapshot(saved.request, visitor)).status, 403);
  const replacement = await saved.request(`/api/rooms/${host.roomCode}/join`, { name: '接替玩家' });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.state.players.length, 2);
  assert.equal(replacement.body.state.players.find(player => player.id === replacement.body.playerId).seat, 1);
});

test('bot seats fill the lobby securely, can be removed online, and never inherit human host authority', async t => {
  const saved = await persistentServer(t, { botDelayMs: 10 });
  const { request } = saved;
  const host = (await request('/api/rooms', { name: '真人房主', isBot: true })).body;
  assert.equal(host.state.players[0].isBot, undefined, 'A client cannot create a bot by supplying its flag');
  assert.equal((await action(request, host, 'bot_claim_hako')).status, 409);
  const filled = await action(request, host, 'add_bots');
  assert.equal(filled.status, 200);
  assert.equal(filled.body.you, host.playerId);
  assert.equal(filled.body.players.length, 4);
  const bots = filled.body.players.filter(player => player.isBot);
  assert.equal(bots.length, 3);
  assert.ok(bots.every(bot => bot.ready && bot.connected && bot.role === 'visitor'));
  assert.deepEqual(filled.body.players.map(player => player.seat), [0, 1, 2, 3]);
  assert.equal((await action(request, host, 'add_bots')).status, 409);
  assert.equal((await request(`/api/rooms/${host.roomCode}/join`, { name: '第五席' })).status, 409);
  const disk = JSON.parse(await readFile(saved.dataFile, 'utf8'));
  for (const bot of disk.rooms[0].players.filter(player => player.isBot)) {
    assert.equal(JSON.stringify(filled.body).includes(bot.token), false, 'A bot credential must not reach a client');
    const forged = { ...host, playerId: bot.id, token: bot.token };
    assert.equal((await snapshot(request, forged)).status, 403);
    assert.equal((await snapshot(request, forged, { poll: true })).status, 403);
    assert.equal((await action(request, forged, 'ready', { ready: false })).status, 403);
    assert.equal((await request(`/api/rooms/${host.roomCode}/events?${new URLSearchParams({ playerId: bot.id, token: bot.token })}`)).status, 403);
  }
  assert.equal(JSON.stringify(filled.body).includes('"token"'), false);
  const removed = await action(request, host, 'remove_player', { targetId: bots[1].id });
  assert.equal(removed.status, 200, 'A bot can be removed while displayed as online');
  assert.ok(removed.body.players.filter(player => player.isBot).every(bot => bot.ready));
  assert.equal(removed.body.players.find(player => player.id === host.playerId).ready, false);
  const guest = (await request(`/api/rooms/${host.roomCode}/join`, { name: '真人来客' })).body;
  assert.equal(guest.state.players.find(player => player.id === guest.playerId).seat, 2);
  assert.equal((await action(request, guest, 'add_bots')).status, 403);
  assert.equal((await action(request, guest, 'bot_claim_hako')).status, 403);
  assert.equal((await action(request, guest, 'remove_player', { targetId: bots[0].id })).status, 403);
  assert.equal((await action(request, host, 'leave')).status, 200);
  const transferred = (await snapshot(request, guest)).body;
  assert.equal(transferred.hostId, guest.playerId, 'Host authority skips an earlier bot seat');
  assert.ok(transferred.players[0].isBot);
  assert.equal((await action(request, guest, 'leave')).status, 200);
  assert.equal((await snapshot(request, guest)).status, 404, 'The last human leaving removes the remaining bots and room');
  assert.equal(JSON.parse(await readFile(saved.dataFile, 'utf8')).rooms.length, 0);
});

test('a human hako gets three automatic bot visitors through drafting and maps, then controls opening and reactions', async t => {
  const { base, request } = await startServer(t, { botDelayMs: 10 });
  const host = (await request('/api/rooms', { name: '真人箱娃' })).body;
  const live = await stream(t, base, host);
  await live.state();
  const added = await action(request, host, 'add_bots');
  const bots = added.body.players.filter(player => player.isBot);
  await action(request, host, 'ready', { ready: true });
  const started = await action(request, host, 'start');
  assert.equal(started.body.phase, 'hako_selection');
  assert.equal((await action(request, host, 'add_bots')).status, 409);
  assert.equal((await action(request, host, 'remove_player', { targetId: bots[0].id })).status, 409);
  const claimed = await action(request, host, 'claim_hako');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.players.find(player => player.role === 'hako').id, host.playerId);
  assert.equal((await action(request, host, 'bot_claim_hako')).status, 409);
  const mapped = await live.state(state => state.phase === 'map_ready');
  assert.equal(mapped.initialItems.length, 3);
  assert.ok(mapped.initialItems.every(choice => bots.some(bot => bot.id === choice.playerId)));
  assert.equal(mapped.setup.placements.length, 9);
  await delay(40);
  assert.equal((await snapshot(request, host)).body.version, mapped.version, 'Bots wait for the human host to prepare opening');
  for (const [type, values] of [
    ['prepare_opening', {}], ['choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' }],
    ['place_remains', { cornerId: 'living_sofa' }], ['inspect_initial_room', { roomId: 'children_room' }],
    ['choose_initial_hiding', { cornerId: 'children_cabinet' }],
  ]) assert.equal((await action(request, host, type, values)).status, 200);
  const initialOptions = (await snapshot(request, host)).body.opening.initialPowerOptions;
  assert.equal((await action(request, host, 'choose_initial_power', { powerId: initialOptions[0].id })).status, 200);
  const pending = await live.state(state => state.round?.phase === 'visitor_reaction');
  assert.equal(pending.round.pendingAction.playerId, bots[0].id);
  await delay(40);
  assert.equal((await snapshot(request, host)).body.version, pending.version, 'Bots wait for the human hako to confirm their declared action');
  const resolved = await action(request, host, 'resolve_visitor_action');
  assert.equal(resolved.status, 200);
  const continued = await live.state(state => state.version > resolved.body.version
    && state.round.silent.turnPlayerId !== bots[0].id);
  assert.ok(continued.round);
});

test('a human visitor plays beside two bot visitors and receives automatic private responses from a bot hako', async t => {
  const { base, request } = await startServer(t, { botDelayMs: 10 });
  const host = (await request('/api/rooms', { name: '真人访问者' })).body;
  const live = await stream(t, base, host);
  await live.state();
  const added = await action(request, host, 'add_bots');
  const hako = added.body.players.find(player => player.isBot);
  await action(request, host, 'ready', { ready: true });
  await action(request, host, 'start');
  const claimed = await action(request, host, 'bot_claim_hako');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.you, host.playerId, 'Choosing a bot hako must keep the human HTTP identity');
  assert.equal(claimed.body.players.find(player => player.role === 'hako').id, hako.id);
  let state = await live.state(update => update.phase === 'item_draft' && update.draft.turnPlayerId === host.playerId);
  assert.equal(state.initialItems.length, 2);
  await delay(40);
  assert.equal((await snapshot(request, host)).body.version, state.version, 'Bots wait for the human item choice');
  const chosen = await action(request, host, 'choose_item', { itemId: 'ventriloquist_doll' });
  assert.equal(chosen.status, 200);
  state = chosen.body;
  while (state.phase === 'map_setup') {
    if (state.setup.turnPlayerId !== host.playerId) {
      const version = state.version;
      state = await live.state(update => update.version > version
        && (update.phase !== 'map_setup' || update.setup.turnPlayerId === host.playerId));
      continue;
    }
    const drawn = await action(request, host, 'draw');
    assert.equal(drawn.status, 200);
    const placed = await action(request, host, 'place', drawn.body.setup.legalPlacements[0]);
    assert.equal(placed.status, 200);
    state = placed.body;
  }
  assert.equal(state.phase, 'map_ready');
  assert.equal(state.setup.placements.length, 9);
  assert.equal((await action(request, host, 'prepare_opening')).status, 200);
  const opened = await live.state(update => update.phase === 'practice');
  assert.equal(opened.initialPower, null);
  const visitorText = JSON.stringify(opened);
  for (const field of ['password', 'weakness', 'hidingCornerId', 'cornerTokens', 'powerDeck']) {
    assert.equal(visitorText.includes(`"${field}":`), false, `The human visitor must not see bot hako ${field}`);
  }
  state = await live.state(update => update.phase === 'practice' && update.round.phase === 'visitor_reveal'
    && update.round.silent.turnPlayerId === host.playerId);
  await delay(40);
  assert.equal((await snapshot(request, host)).body.version, state.version, 'Bots leave the human silent-card decision untouched');
  const lowestDown = [4, 2, 3, 5, 1, 0].find(index => state.round.silent.cards[index].status === 'down');
  const revealed = await action(request, host, 'silent_reveal', { index: lowestDown });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.round.phase, 'visitor_action');
  const questioned = await action(request, host, 'use_item', {
    itemId: 'ventriloquist_doll', roomId: revealed.body.round.items.roomOptions[0].id,
  });
  assert.equal(questioned.status, 200);
  const waiting = await live.state(update => update.round?.resolution?.kind === 'waiting'
    && update.round.resolution.playerId === hako.id);
  assert.deepEqual(waiting.round.resolution, { kind: 'waiting', playerId: hako.id });
  const answered = await live.state(update => update.round?.items.events.some(event => event.itemId === 'ventriloquist_doll'
    && event.userId === host.playerId));
  const answer = answered.round.items.events.find(event => event.itemId === 'ventriloquist_doll' && event.userId === host.playerId);
  assert.equal(typeof answer.answer, 'boolean');
  assert.equal(Object.hasOwn(answer, 'truth'), false);
});

test('bot seats and paused progress survive restart and resume only when a human reconnects', async t => {
  const saved = await persistentServer(t, { botDelayMs: 25 });
  const { request } = saved;
  const host = (await request('/api/rooms', { name: '暂停测试' })).body;
  const added = await action(request, host, 'add_bots');
  const botSeats = added.body.players.filter(player => player.isBot).map(({ id, seat }) => ({ id, seat }));
  await action(request, host, 'ready', { ready: true });
  await action(request, host, 'start');
  const claimed = await action(request, host, 'claim_hako');
  await delay(75);
  assert.deepEqual((await snapshot(request, host)).body, claimed.body, 'Ordinary GETs and connected-looking bots cannot start bot timers');
  const live = await stream(t, saved.base, host);
  await live.state(state => state.initialItems.length === 1);
  await live.close();
  const paused = await waitForSnapshot(request, host, state => !state.players.find(player => player.id === host.playerId).connected);
  await delay(75);
  assert.deepEqual((await snapshot(request, host)).body, paused, 'Bot timers stop after the last human disconnects');
  await checkRestart(saved, [host]);
  const restored = (await snapshot(request, host)).body;
  assert.deepEqual(restored.players.filter(player => player.isBot).map(({ id, seat }) => ({ id, seat })), botSeats);
  assert.ok(restored.players.filter(player => player.isBot).every(player => player.connected && player.ready));
  await delay(75);
  assert.deepEqual((await snapshot(request, host)).body, restored, 'Restoring a room does not run bots without a human');
  assert.equal((await snapshot(request, host, { poll: true })).status, 200);
  const resumed = await waitForSnapshot(request, host, state => state.phase === 'map_ready');
  assert.equal(resumed.initialItems.length, 3);
  assert.equal(resumed.setup.placements.length, 9);
});

test('bot seat changes and scheduled bot actions commit only after successful storage and retry safely', async t => {
  const saved = await persistentServer(t, { botDelayMs: 10 });
  const { request } = saved;
  const host = (await request('/api/rooms', { name: '人机存档测试' })).body;
  const before = (await snapshot(request, host)).body;
  const originalBytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, host, 'add_bots')).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, before);
    assert.equal(await readFile(saved.dataFile, 'utf8'), originalBytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  assert.equal((await action(request, host, 'add_bots')).status, 200);
  await action(request, host, 'ready', { ready: true });
  const selection = await action(request, host, 'start');
  const selectionBytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, host, 'bot_claim_hako')).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, selection.body);
    assert.equal(await readFile(saved.dataFile, 'utf8'), selectionBytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const claimed = await action(request, host, 'bot_claim_hako');
  assert.equal(claimed.status, 200);
  const claimedBytes = await readFile(saved.dataFile, 'utf8');
  const errors = [];
  t.mock.method(console, 'error', (...values) => errors.push(values.join(' ')));
  await mkdir(`${saved.dataFile}.tmp`);
  let live;
  try {
    live = await stream(t, saved.base, host);
    const connected = await live.state();
    const deadline = Date.now() + 2000;
    while (!errors.some(message => message.includes('人机行动失败')) && Date.now() < deadline) await delay(10);
    assert.ok(errors.some(message => message.includes('人机行动失败') && message.includes('本次操作未生效')),
      'A scheduled bot action must actually attempt the blocked write');
    assert.deepEqual((await snapshot(request, host)).body, connected);
    assert.equal(await readFile(saved.dataFile, 'utf8'), claimedBytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const retried = await live.state(state => state.version > claimed.body.version, 4000);
  assert.equal(retried.initialItems.length, 1, 'The same pending bot draft choice succeeds once storage is repaired');
  assert.equal(retried.version, claimed.body.version + 1);
});

test('authenticated polling expires despite ordinary GETs and shares transient presence with SSE', { timeout: 25000 }, async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  const [host, pollingVisitor, mixedVisitor, offlineVisitor] = people;
  const connected = (state, person) => state.players.find(player => player.id === person.playerId).connected;
  const before = (await snapshot(request, host)).body;
  const bytes = await readFile(saved.dataFile, 'utf8');
  assert.ok(before.players.every(player => !player.connected));
  assert.equal((await request(`/api/rooms/${host.roomCode}?poll=1`)).status, 403);
  assert.equal((await snapshot(request, { ...offlineVisitor, token: host.token }, { poll: true })).status, 403);
  assert.equal(connected((await snapshot(request, offlineVisitor)).body, offlineVisitor), false,
    'Neither an invalid poll nor an authenticated ordinary GET marks a player online');

  const observer = await stream(t, saved.base, host);
  await observer.state();
  const mixedStream = await stream(t, saved.base, mixedVisitor);
  await mixedStream.state();
  await observer.state(state => connected(state, mixedVisitor));
  const polled = await Promise.all([pollingVisitor, mixedVisitor].map(person => snapshot(request, person, { poll: true })));
  const pollsFinished = Date.now();
  for (let index = 0; index < polled.length; index++) {
    assert.equal(polled[index].status, 200);
    assert.equal(connected(polled[index].body, [pollingVisitor, mixedVisitor][index]), true);
    assert.equal(polled[index].body.version, before.version);
    assert.deepEqual(polled[index].body.log, before.log);
  }
  const online = await observer.state(state => connected(state, pollingVisitor));
  assert.deepEqual(online, { ...polled[0].body, you: host.playerId }, 'SSE observes polling players joining');

  await delay(8000);
  assert.equal(connected((await snapshot(request, pollingVisitor)).body, pollingVisitor), true);
  assert.equal(connected((await snapshot(request, offlineVisitor)).body, offlineVisitor), false);
  const expired = await observer.state(state => !connected(state, pollingVisitor), 10000);
  assert.equal(expired.version, before.version);
  assert.deepEqual(expired.log, before.log);
  await delay(Math.max(0, pollsFinished + 15100 - Date.now()));
  const afterExpiry = (await snapshot(request, host)).body;
  assert.equal(connected(afterExpiry, pollingVisitor), false, 'An ordinary GET must not extend the polling heartbeat');
  assert.equal(connected(afterExpiry, mixedVisitor), true, 'An active SSE connection keeps a player online after polling expires');
  assert.equal(connected(afterExpiry, offlineVisitor), false);
  await mixedStream.close();
  const disconnected = await observer.state(state => !connected(state, mixedVisitor));
  assert.equal(disconnected.version, before.version);
  assert.deepEqual(disconnected.log, before.log);
  assert.equal(await readFile(saved.dataFile, 'utf8'), bytes, 'Online presence must not rewrite persistent game state');
});

test('SSE synchronizes all players, preserves disconnected seats and completes nine maps', async t => {
  const { base, request } = await startServer(t);
  const people = await createFour(request);
  const streams = [];
  for (const person of people) streams.push(await stream(t, base, person));
  const connected = await streams[0].state(state => state.players.every(player => player.connected));
  assert.equal(connected.you, people[0].playerId);
  await streams[3].close();
  await streams[0].state(state => !state.players.find(player => player.id === people[3].playerId).connected);
  assert.equal((await request(`/api/rooms/${people[0].roomCode}/join`, { name: '不能占位' })).status, 409);
  const resumed = (await snapshot(request, people[3])).body;
  assert.equal(resumed.you, people[3].playerId);
  assert.equal(resumed.players.length, 4);
  streams[3] = await stream(t, base, people[3]);
  await streams[0].state(state => state.players.every(player => player.connected));
  for (const person of people) await action(request, person, 'ready', { ready: true });
  assert.equal((await action(request, people[0], 'start')).body.phase, 'hako_selection');
  let state = (await action(request, people[0], 'claim_hako')).body;
  for (let index = 0; index < 3; index += 1) {
    const current = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = (await action(request, current, 'choose_item', { itemId: state.draft.availableItems[0].id })).body;
  }
  assert.equal(state.phase, 'map_setup');
  assert.equal(state.draft, null);
  assert.equal(state.initialItems.length, 3);
  assert.equal(state.setup.placements.length, 1);
  for (let turn = 0; turn < 8; turn += 1) {
    const current = people.find(person => person.playerId === state.setup.turnPlayerId);
    const other = people.find(person => person.playerId !== current.playerId);
    assert.equal((await action(request, other, 'draw')).status, 409);
    const draws = await Promise.all([action(request, current, 'draw'), action(request, current, 'draw')]);
    assert.deepEqual(draws.map(result => result.status).sort(), [200, 409]);
    const drawn = draws.find(result => result.status === 200).body;
    assert.equal(drawn.setup.drawnTileId, deck[turn]);
    assert.equal(Object.hasOwn(drawn.setup, 'deck'), false);
    assert.ok(drawn.setup.legalPlacements.length > 0);
    assert.equal((await action(request, current, 'place', { floor: 1, x: 0, y: 0, rotation: 0 })).status, 409);
    const placed = await action(request, current, 'place', drawn.setup.legalPlacements[0]);
    assert.equal(placed.status, 200);
    state = placed.body;
    assert.equal(state.setup.placements.length, turn + 2);
    assert.equal((await action(request, current, 'place', drawn.setup.legalPlacements[0])).status, 409);
    for (let index = 0; index < people.length; index += 1) {
      const update = await streams[index].state(update => update.version >= state.version);
      assert.equal(update.you, people[index].playerId);
      assert.deepEqual(update.setup, state.setup);
    }
  }
  assert.equal(state.phase, 'map_ready');
  assert.equal(state.setup.remaining, 0);
  assert.equal(state.setup.placements.length, 9);
  assert.equal((await action(request, people[1], 'draw')).status, 409);
  const finalViews = await Promise.all(people.map(person => snapshot(request, person)));
  for (const view of finalViews) assert.deepEqual(view.body.setup, state.setup);

  const [hako, firstVisitor] = people;
  assert.equal((await action(request, firstVisitor, 'prepare_opening')).status, 403);
  state = (await action(request, hako, 'prepare_opening')).body;
  assert.equal(state.phase, 'opening_setup');
  assert.equal((await action(request, firstVisitor, 'choose_secrets', {
    password: [1, 2, 3], weakness: 'gasoline',
  })).status, 409);
  const version = state.version;
  assert.equal((await action(request, hako, 'choose_secrets', {
    password: [1, 1, 2], weakness: 'gasoline',
  })).status, 409);
  assert.equal((await snapshot(request, hako)).body.version, version);

  async function assertPrivateViews() {
    const current = (await snapshot(request, hako)).body;
    for (let index = 1; index < people.length; index += 1) {
      const view = (await snapshot(request, people[index])).body;
      assert.equal(view.version, current.version);
      const text = JSON.stringify(view);
      for (const field of ['password', 'weakness', 'remainsCornerId', 'hidingCornerId', 'hidingUnderToken',
        'inspectedRoom', 'lastInspectedRoom', 'cornerTokens', 'powerDeck', 'hidingTargets', 'hidingRooms', 'cornerId',
        'initialPowerId', 'initialPowerName', 'initialPowerOptions', 'initialPowerCandidates']) {
        assert.equal(text.includes(`"${field}":`), false, `visitor HTTP must omit ${field}`);
      }
      const pushed = await streams[index].state(update => update.version >= current.version);
      assert.deepEqual(pushed, view, 'SSE must use the same filtered participant view as HTTP');
    }
  }

  state = (await action(request, hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' })).body;
  await assertPrivateViews();
  assert.equal(state.opening.corners.filter(corner => !corner.occupied).length, 1);
  assert.equal((await action(request, hako, 'place_remains', { cornerId: 'study_desk' })).status, 409);
  state = (await action(request, hako, 'place_remains', { cornerId: 'living_sofa' })).body;
  await assertPrivateViews();
  state = (await action(request, hako, 'inspect_initial_room', { roomId: 'children_room' })).body;
  await assertPrivateViews();
  assert.equal(state.opening.inspectedRoom.id, 'children_room');
  const initialContents = structuredClone(state.opening.inspectedRoom.corners);
  assert.ok(initialContents.every(corner => !Object.hasOwn(corner, 'token')));
  const initialCorner = state.opening.hidingTargets[0];
  assert.equal((await action(request, hako, 'inspect_initial_room', { roomId: 'dark_room' })).status, 409);
  assert.equal((await action(request, hako, 'choose_initial_hiding', { cornerId: 'dark_bed' })).status, 409);
  state = (await action(request, hako, 'choose_initial_hiding', { cornerId: state.opening.hidingTargets[0] })).body;
  assert.equal(state.opening.lastInspectedRoom.id, 'children_room');
  assert.equal(state.opening.lastInspectedRoom.cycle, 0);
  assert.deepEqual(state.opening.lastInspectedRoom.corners, [{ id: initialCorner, token: state.opening.hidingUnderToken }]);
  const initialMemory = underlyingTokens(state.opening.lastInspectedRoom.corners);
  await assertPrivateViews();
  assert.equal(state.opening.initialPowerOptions.length, 3);
  const candidates = state.opening.initialPowerOptions.map(card => card.id);
  const unoffered = Array.from({ length: 11 }, (_, index) => index + 1).find(id => !candidates.includes(id));
  assert.equal((await action(request, hako, 'choose_initial_power', { powerId: unoffered })).status, 409);
  const chosenPowerId = candidates[0];
  state = (await action(request, hako, 'choose_initial_power', { powerId: chosenPowerId })).body;
  await assertPrivateViews();
  assert.equal(state.phase, 'practice');
  assert.equal(state.initialPower.id, chosenPowerId);
  assert.deepEqual(underlyingTokens(state.round.hako.lastInspectedRoom.corners), initialMemory);
  assert.equal(state.round.visitors.every(visitor => visitor.roomId === 'hall_room'), true);
  assert.equal((await action(request, hako, 'prepare_opening')).status, 409);
  assert.equal((await action(request, hako, 'silent_reveal', { index: 0 })).status, 409);

  for (let index = 0; index < 3; index += 1) {
    const current = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    const revealed = await action(request, current, 'silent_reveal', { index });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.body.round.phase, 'visitor_action');
    assert.equal(revealed.body.round.silent.total, [5, 9, 10][index]);
    const target = revealed.body.round.moveTargets[0];
    const declared = await action(request, current, 'move', { roomId: target });
    assert.equal(declared.body.round.phase, 'visitor_reaction');
    assert.equal(declared.body.round.visitors.find(visitor => visitor.id === current.playerId).roomId, 'hall_room');
    assert.equal((await action(request, current, 'resolve_visitor_action')).status, 409);
    const resolved = await action(request, hako, 'resolve_visitor_action');
    assert.equal(resolved.status, 200);
    state = resolved.body;
    assert.equal(state.round.visitors.find(visitor => visitor.id === current.playerId).roomId, target);
  }
  const interrupted = state.round.silent.turnPlayerId;
  const current = people.find(person => person.playerId === interrupted);
  state = (await action(request, current, 'silent_reveal', { index: 3 })).body;
  assert.equal(state.round.phase, 'hako_reaction');
  assert.equal(state.round.silent.total, 12);
  assert.equal((await action(request, current, 'move', { roomId: 'hall_room' })).status, 409);
  assert.equal((await action(request, current, 'pass_noise_reaction')).status, 409);
  state = (await action(request, hako, 'pass_noise_reaction')).body;
  assert.equal(state.round.phase, 'hako_phase');
  await assertPrivateViews();
  assert.equal(state.round.powers.step, 'preparation');
  state = (await action(request, hako, 'begin_hako_action')).body;
  assert.equal((await action(request, hako, 'hako_hide', { cornerId: initialCorner })).status, 409);
  assert.equal((await action(request, firstVisitor, 'inspect_hiding_room', { roomId: 'children_room' })).status, 409);
  state = (await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).body;
  assert.deepEqual(state.round.hako.inspectedRoom.corners.map(corner => corner.id), initialContents.map(corner => corner.id));
  assert.ok(state.round.hako.inspectedRoom.corners.every(corner => !Object.hasOwn(corner, 'token')));
  assert.equal((await action(request, hako, 'inspect_hiding_room', { roomId: 'dark_room' })).status, 409);
  await assertPrivateViews();
  const nextHiding = state.round.hako.hidingTargets.find(id => id !== initialCorner);
  state = (await action(request, hako, 'hako_hide', { cornerId: nextHiding })).body;
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.hako.lastInspectedRoom.cycle, 1);
  assert.equal(state.round.hako.lastInspectedRoom.corners.length, 1);
  assert.equal(state.round.hako.lastInspectedRoom.corners[0].id, nextHiding);
  assert.equal(state.round.silent.turnPlayerId, interrupted);
  assert.equal(state.round.silent.cards.every(card => card.status === 'down' && !Object.hasOwn(card, 'number')), true);
  await assertPrivateViews();
  for (let index = 0; index < 5; index += 1) {
    const visitor = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    const skipped = await action(request, visitor, 'silent_skip', { index });
    assert.equal(skipped.status, 200);
    state = skipped.body;
  }
  assert.equal(state.round.phase, 'hako_phase');
  assert.equal(state.round.silent.trigger, 'one_hidden');
  assert.equal(state.round.silent.cards.filter(card => card.status === 'held').length, 5);
  state = (await action(request, hako, 'begin_hako_action')).body;
  state = (await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).body;
  assert.ok(state.round.hako.inspectedRoom.corners.every(corner => !Object.hasOwn(corner, 'token')),
    'Returning to a room never reveals its other pieces');
  state = (await action(request, hako, 'hako_hide', { cornerId: nextHiding })).body;
  assert.equal(state.round.silent.cycle, 3);
  assert.equal(state.round.silent.cards.every(card => card.status === 'down'), true);
});

test('HTTP, polling and SSE isolate peeks, inventories, deliberate sharing and consensual transfers', async t => {
  let firstId;
  const { base, request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      firstId = setup.visitorIds[0];
      const found = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'password' && play.tokens[id].number === 4);
      [play.tokens.hall_clock, play.tokens[found]] = [play.tokens[found], play.tokens.hall_clock];
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second, third] = people;
  assert.equal(first.playerId, firstId);
  const originalMemory = (await snapshot(request, hako)).body.round.hako.lastInspectedRoom;
  const streams = await Promise.all(people.map(person => stream(t, base, person)));
  await action(request, first, 'silent_reveal', { index: 0 });
  const declared = await action(request, first, 'peek', { cornerId: 'hall_clock', useNightVision: false });
  assert.equal(declared.status, 200);
  assert.equal(declared.body.round.resolution, null);
  assert.equal((await action(request, second, 'resolve_visitor_action')).status, 409);
  const confirmed = await action(request, hako, 'resolve_visitor_action');
  assert.equal(confirmed.status, 200);
  for (let index = 0; index < people.length; index += 1) {
    const view = (await snapshot(request, people[index])).body;
    const polled = await snapshot(request, people[index], { poll: true });
    assert.equal(polled.status, 200);
    assert.deepEqual(polled.body, view, 'Polling uses the same authenticated private view as HTTP and SSE');
    const pushed = await streams[index].state(update => update.version >= confirmed.body.version);
    assert.deepEqual(pushed, view);
    if (index === 1) {
      assert.equal(view.round.resolution.token.number, 4);
      assert.equal(view.round.resolution.token.type, 'password');
    } else {
      assert.deepEqual(view.round.resolution, { kind: 'waiting', playerId: firstId });
      if (index === 0) {
        // The fixture relocates the token after the initial room was remembered.
        // Preserve legitimately seen history while denying the new private result.
        assert.deepEqual(view.round.hako.lastInspectedRoom, originalMemory);
        const { lastInspectedRoom, ...hakoWithoutHistory } = view.round.hako;
        assert.equal(JSON.stringify({ ...view.round, hako: hakoWithoutHistory }).includes('password_4'), false);
      } else assert.equal(JSON.stringify(view.round).includes('password_4'), false);
    }
  }
  const before = (await snapshot(request, first)).body;
  assert.equal((await action(request, second, 'resolve_peek', { take: true, replacement: 'empty_box' })).status, 409);
  assert.equal((await action(request, first, 'resolve_peek', { take: true, replacement: 'none' })).status, 409);
  assert.deepEqual((await snapshot(request, first)).body, before);
  const taken = await action(request, first, 'resolve_peek', { take: true, replacement: 'empty_box' });
  assert.equal(taken.status, 200);
  const tokenId = taken.body.round.inventory.tokens[0].id;
  assert.equal(taken.body.round.inventory.tokens[0].number, 4);
  assert.equal(taken.body.round.silent.turnPlayerId, second.playerId);
  assert.equal((await snapshot(request, hako)).body.round.inventory.tokens.length, 0);
  await action(request, first, 'show_token', { tokenId, targetId: second.playerId });
  assert.equal((await snapshot(request, second)).body.round.sharedTokens.token.id, tokenId);
  assert.equal((await snapshot(request, third)).body.round.sharedTokens, null);
  let offered = await action(request, first, 'offer_exchange', {
    targetId: second.playerId, giveTokenIds: [tokenId],
  });
  assert.equal(offered.status, 200);
  const offerId = offered.body.round.exchangeOffers[0].id;
  const recipient = (await snapshot(request, second)).body;
  assert.equal(recipient.round.exchangeOffers[0].giveTokens[0].number, 4);
  assert.equal((await snapshot(request, third)).body.round.exchangeOffers.length, 0);
  assert.equal((await action(request, third, 'respond_exchange', { offerId, accept: true })).status, 409);
  assert.equal((await action(request, second, 'respond_exchange', { offerId, accept: true })).status, 200);
  assert.equal((await snapshot(request, first)).body.round.inventory.tokens.length, 0);
  assert.equal((await snapshot(request, second)).body.round.inventory.tokens[0].id, tokenId);
  assert.equal((await action(request, second, 'respond_exchange', { offerId, accept: true })).status, 409);
  for (const requested of [[tokenId], ['unknown_secret_id']]) {
    offered = await action(request, third, 'offer_exchange', { targetId: second.playerId, requestTokenIds: requested });
    assert.equal(offered.status, 200, 'The sender must not learn whether a guessed private id exists');
    const requestOffer = offered.body.round.exchangeOffers.at(-1);
    assert.equal(Object.hasOwn(requestOffer, 'requestTokens'), false);
  }
  const logs = (await snapshot(request, hako)).body.log.join('\n');
  assert.equal(logs.includes(tokenId), false);
  assert.equal(logs.includes('密码4'), false);
});

test('HTTP deaths hide ghost locations, preserve one-person turns, and lock a declared result', async t => {
  const { request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.round.hidingCornerId = 'hall_clock';
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, ...visitors] = people;
  for (let index = 0; index < 2; index += 1) {
    const person = visitors[index];
    await action(request, person, 'silent_reveal', { index });
    await action(request, person, 'peek', { cornerId: 'hall_clock' });
    assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
    const inheritance = (await snapshot(request, person)).body.round.resolution;
    assert.equal(inheritance.kind, 'inheritance');
    assert.equal((await action(request, person, 'bequeath', { targetId: visitors[2].playerId })).status, 200);
    const owner = (await snapshot(request, person)).body;
    assert.equal(owner.round.ghost.cornerId, 'hall_clock');
    assert.equal(owner.round.visitors.find(player => player.id === person.playerId).status, 'box_person');
    const living = (await snapshot(request, visitors[2])).body;
    assert.equal(Object.hasOwn(living.round.visitors[index], 'roomId'), false);
    assert.equal(Object.hasOwn(living.round, 'ghost'), false);
    assert.equal(living.round.hako.cornerId, undefined);
    assert.equal((await action(request, person, 'silent_reveal', { index: index + 1 })).status, 409);
  }
  let state = (await snapshot(request, visitors[2])).body;
  assert.equal(state.round.silent.turnPlayerId, visitors[2].playerId);
  const voted = await action(request, visitors[2], 'surrender');
  assert.equal(voted.status, 200);
  assert.equal(voted.body.phase, 'game_over');
  assert.equal(voted.body.round.result.winner, 'hako');
  assert.equal((await action(request, visitors[2], 'silent_reveal', { index: 2 })).status, 409);
  assert.equal((await action(request, hako, 'pass_noise_reaction')).status, 409);
  state = (await snapshot(request, visitors[2])).body;
  assert.deepEqual(state, voted.body);
});

test('a box-person host can abandon a pending peek with an offline hako, saving and broadcasting the reset atomically', async t => {
  const saved = await persistentServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.round.hidingCornerId = 'hall_clock';
      return play;
    },
  });
  const { request } = saved;
  const people = await createFour(request);
  const [host, visitor, , hako] = people;
  assert.equal((await action(request, host, 'restart_game', { abandon: true })).status, 409);
  await preparePlay(request, people, hako);
  await action(request, host, 'silent_reveal', { index: 0 });
  await action(request, host, 'peek', { cornerId: 'hall_clock' });
  await action(request, hako, 'resolve_visitor_action');
  assert.equal((await action(request, host, 'bequeath', { targetId: visitor.playerId })).status, 200);
  await action(request, visitor, 'silent_reveal', { index: 1 });
  assert.equal((await action(request, visitor, 'peek', { cornerId: 'hall_clock' })).status, 200);
  const live = await stream(t, saved.base, host);
  const before = await live.state();
  assert.equal(before.round.phase, 'visitor_reaction');
  assert.equal(before.round.pendingAction.type, 'peek');
  assert.equal(before.round.visitors.find(player => player.id === host.playerId).status, 'box_person');
  assert.equal(before.players.find(player => player.id === hako.playerId).connected, false);
  assert.equal(before.round.result, null);
  for (const abandon of [undefined, false, 'true']) {
    assert.equal((await action(request, host, 'restart_game', { abandon })).status, 409);
  }
  assert.equal((await action(request, hako, 'restart_game', { abandon: true })).status, 403);
  assert.equal((await action(request, host, 'restart_game', { abandon: true, expectedVersion: before.version - 1 })).status, 409);
  assert.deepEqual((await snapshot(request, host)).body, before);
  const bytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, host, 'restart_game', { abandon: true, expectedVersion: before.version })).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, before);
    assert.equal(await readFile(saved.dataFile, 'utf8'), bytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const reset = await action(request, host, 'restart_game', { abandon: true, expectedVersion: before.version });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.phase, 'lobby');
  assert.equal(reset.body.version, before.version + 1);
  assert.equal(reset.body.hostId, host.playerId);
  assert.deepEqual(reset.body.players, before.players.map(player => ({ ...player, role: 'visitor', ready: false })));
  assert.equal(reset.body.round, null);
  assert.equal(reset.body.undo.available, false);
  assert.deepEqual(await live.state(), reset.body, 'Only the successfully saved reset reaches SSE');
  assert.equal((await action(request, hako, 'resolve_visitor_action', { expectedVersion: before.version })).status, 409);
  await live.close();
  await checkRestart(saved, people);
});

test('hosts can abandon unfinished role selection and item drafting while preserving the original seats', async t => {
  const { request } = await startServer(t);
  const people = await createFour(request);
  const [host, guest] = people;
  for (const claim of [false, true]) {
    for (const person of people) await action(request, person, 'ready', { ready: true });
    let current = (await action(request, host, 'start')).body;
    if (claim) current = (await action(request, guest, 'claim_hako')).body;
    assert.equal(current.phase, claim ? 'item_draft' : 'hako_selection');
    assert.equal((await action(request, host, 'restart_game')).status, 409);
    const reset = await action(request, host, 'restart_game', { abandon: true, expectedVersion: current.version });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.phase, 'lobby');
    assert.deepEqual(reset.body.players.map(player => player.id), people.map(person => person.playerId));
    assert.ok(reset.body.players.every(player => player.role === 'visitor' && !player.ready));
    assert.equal(reset.body.draft, null);
  }
});

test('finished rooms restart in place over SSE and polling, persist clean lobbies and allow a different hako', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  const [host, first, second, third] = people;
  assert.equal((await action(request, host, 'restart_game')).status, 409);
  await preparePlay(request, people);
  assert.equal((await action(request, host, 'restart_game')).status, 409);
  assert.equal((await action(request, first, 'chat_send', {
    channelKind: 'room', roomId: 'hall_room', text: '上一局的私密消息',
  })).status, 200);
  for (const person of people.slice(1)) assert.equal((await action(request, person, 'surrender')).status, 200);
  const observer = await stream(t, saved.base, host);
  await observer.state();
  const guestStream = await stream(t, saved.base, first);
  await guestStream.state();
  await snapshot(request, second, { poll: true });
  const ended = (await snapshot(request, host)).body;
  assert.equal(ended.phase, 'game_over');
  assert.equal((await action(request, first, 'restart_game', { expectedVersion: ended.version })).status, 403);
  assert.equal((await action(request, host, 'restart_game', { expectedVersion: ended.version - 1 })).status, 409);
  const reset = await action(request, host, 'restart_game', { expectedVersion: ended.version });
  assert.equal(reset.status, 200);
  const lobby = reset.body;
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.code, ended.code);
  assert.equal(lobby.hostId, host.playerId);
  assert.equal(lobby.version, ended.version + 1);
  assert.deepEqual(lobby.players, ended.players.map(player => ({ ...player, role: 'visitor', ready: false })));
  for (const field of ['round', 'setup', 'opening', 'draft', 'initialPower']) assert.equal(lobby[field], null);
  assert.deepEqual(lobby.initialItems, []);
  assert.deepEqual(lobby.chat.messages, []);
  assert.equal(lobby.chat.channel, null);
  assert.ok(lobby.chat.revision > ended.chat.revision);
  assert.equal(lobby.undo.available, false);
  assert.equal(lobby.undo.steps, 0);
  assert.equal(lobby.log.length, 1);
  assert.deepEqual(await observer.state(state => state.version === lobby.version), lobby);
  assert.deepEqual(await guestStream.state(state => state.version === lobby.version), { ...lobby, you: first.playerId });
  assert.deepEqual((await snapshot(request, second, { poll: true })).body, { ...lobby, you: second.playerId });
  assert.equal((await action(request, host, 'restart_game')).status, 409);
  assert.equal((await action(request, first, 'silent_reveal', { index: 0, expectedVersion: ended.version })).status, 409);
  assert.equal((await action(request, host, 'undo_request', { version: lobby.version })).status, 409);
  await observer.close();
  await guestStream.close();
  await checkRestart(saved, people);
  assert.equal((await action(request, host, 'start')).status, 409, 'Humans must prepare again');
  for (const person of people) await action(request, person, 'ready', { ready: true });
  assert.equal((await action(request, host, 'start')).body.phase, 'hako_selection');
  let state = (await action(request, third, 'claim_hako')).body;
  assert.equal(state.players.find(player => player.role === 'hako').id, third.playerId);
  assert.equal(state.initialPower, null);
  for (let index = 0; index < 3; index++) {
    const person = people.find(candidate => candidate.playerId === state.draft.turnPlayerId);
    state = (await action(request, person, 'choose_item', { itemId: state.draft.availableItems[0].id })).body;
  }
  assert.equal(state.phase, 'map_setup');
  assert.equal(state.setup.placements.length, 1);
  assert.equal(state.setup.remaining, 8);
  assert.equal(state.round, null);
});

test('restart waits for undo voting and failed saves preserve the result, review, identities and SSE', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  const [host, guest] = people;
  await preparePlay(request, people);
  for (const person of people.slice(1)) await action(request, person, 'surrender');
  const live = await stream(t, saved.base, host);
  let before = await live.state();
  const proposed = await action(request, guest, 'undo_request', { version: before.version });
  assert.equal(proposed.status, 200);
  assert.ok(proposed.body.undo.pending);
  assert.equal((await action(request, host, 'restart_game')).status, 409);
  await action(request, guest, 'undo_cancel', { requestId: proposed.body.undo.pending.id });
  before = (await snapshot(request, host)).body;
  await live.state(state => state.version === before.version);
  const bytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, host, 'restart_game', { expectedVersion: before.version })).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, before);
    assert.equal(await readFile(saved.dataFile, 'utf8'), bytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const reset = await action(request, host, 'restart_game', { expectedVersion: before.version });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.version, before.version + 1);
  assert.deepEqual(await live.state(), reset.body, 'Failed reset must never reach the SSE stream');
});

test('rematching preserves bot seats and automatic readiness while waiting for the human to start', async t => {
  const { base, request } = await startServer(t, { botDelayMs: 10,
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.result = { winner: 'hako', reason: 'all_dead', winners: [opening.hakoId] };
      return play;
    },
  });
  const host = (await request('/api/rooms', { name: '再开一局的人机房主' })).body;
  const live = await stream(t, base, host);
  await live.state();
  const filled = (await action(request, host, 'add_bots')).body;
  await action(request, host, 'ready', { ready: true });
  await action(request, host, 'start');
  await action(request, host, 'claim_hako');
  await live.state(state => state.phase === 'map_ready');
  for (const [type, input] of [
    ['prepare_opening', {}], ['choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' }],
    ['place_remains', { cornerId: 'living_sofa' }], ['inspect_initial_room', { roomId: 'children_room' }],
    ['choose_initial_hiding', { cornerId: 'children_cabinet' }],
  ]) assert.equal((await action(request, host, type, input)).status, 200);
  const options = (await snapshot(request, host)).body.opening.initialPowerOptions;
  assert.equal((await action(request, host, 'choose_initial_power', { powerId: options[0].id })).body.phase, 'game_over');
  const lobby = (await action(request, host, 'restart_game')).body;
  assert.equal(lobby.phase, 'lobby');
  assert.deepEqual(lobby.players, filled.players);
  await delay(50);
  assert.equal((await snapshot(request, host)).body.version, lobby.version, 'Bots must not start or claim on their own');
  assert.equal((await action(request, host, 'start')).status, 409);
  await action(request, host, 'ready', { ready: true });
  assert.equal((await action(request, host, 'start')).body.phase, 'hako_selection');
  assert.equal((await action(request, host, 'bot_claim_hako')).body.phase, 'item_draft');
});

test('HTTP and SSE keep phone results and false answers private while allowing a forced-peek interruption', async t => {
  const { base, request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const phoneIndex = play.availableItems.findIndex(item => item.id === 'smartphone');
      play.inventories[setup.visitorIds[0]].items.push(play.availableItems.splice(phoneIndex, 1)[0]);
      for (const id of [4, 6, 9]) play.powers.deck.splice(play.powers.deck.indexOf(id), 1);
      play.powers.hand.push({ id: 4, ignoreThreshold: false });
      play.powers.slots = [{ id: 6, ignoreThreshold: true, faceUp: false }, { id: 9, ignoreThreshold: false, faceUp: false }];
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_4');
      [play.tokens.hall_clock, play.tokens[source]] = [play.tokens[source], play.tokens.hall_clock];
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second, third] = people;
  const streams = await Promise.all(people.map(person => stream(t, base, person)));
  const initial = (await snapshot(request, first)).body;
  assert.deepEqual(initial.round.powers.slots.map(slot => slot.card), [undefined, undefined]);
  assert.equal(initial.round.powers.hand, undefined);
  assert.equal((await action(request, first, 'activate_power', { slot: 0 })).status, 409);
  assert.deepEqual((await snapshot(request, first)).body, initial);
  await action(request, first, 'silent_reveal', { index: 0 });
  const photographedIndex = (await snapshot(request, hako)).body.round.powers.hand.findIndex(card => card.id === 4);
  assert.ok(photographedIndex >= 0);
  assert.equal((await action(request, first, 'use_item', { itemId: 'smartphone', targetZone: 'hand', index: photographedIndex })).status, 200);
  const photo = await action(request, hako, 'resolve_visitor_action');
  assert.equal(photo.status, 200);
  for (let index = 0; index < people.length; index++) {
    const state = (await snapshot(request, people[index])).body;
    assert.deepEqual(await streams[index].state(update => update.version >= photo.body.version), state);
    assert.equal(state.round.items.result?.card?.id, index === 1 ? 4 : undefined);
    if (index > 1) assert.equal(JSON.stringify(state).includes('动来动去'), false);
  }
  await action(request, second, 'silent_reveal', { index: 1 });
  await action(request, second, 'use_item', { itemId: 'spirit_pen', roomId: 'children_room' });
  const question = await action(request, hako, 'resolve_visitor_action');
  assert.equal(question.body.round.resolution.truth, true);
  for (const person of people.slice(1)) {
    const waiting = (await snapshot(request, person)).body.round.resolution;
    assert.deepEqual(waiting, { kind: 'waiting', playerId: hako.playerId });
  }
  const beforeAnswer = (await snapshot(request, second)).body;
  assert.equal((await action(request, second, 'answer_item', { answer: true })).status, 409);
  assert.deepEqual((await snapshot(request, second)).body, beforeAnswer);
  const answer = await action(request, hako, 'answer_item', { answer: false });
  assert.equal(answer.status, 200);
  for (let index = 1; index < people.length; index++) {
    const state = await streams[index].state(update => update.version >= answer.body.version);
    assert.equal(state.round.items.events.at(-1).answer, false);
    assert.equal(Object.hasOwn(state.round.items.events.at(-1), 'truth'), false);
    assert.equal(state.round.powers.slots[1].card, undefined, 'A false response must not reveal the hidden NO.9 card');
  }
  await action(request, third, 'silent_reveal', { index: 2 });
  await action(request, third, 'use_item', { itemId: 'ventriloquist_doll', roomId: 'study_room' });
  assert.equal((await action(request, hako, 'activate_power', { slot: 0 })).status, 200);
  const forced = (await snapshot(request, third)).body;
  assert.equal(forced.round.resolution.kind, 'forced_peek');
  assert.ok(forced.round.resolution.cornerIds.includes('hall_clock'));
  assert.equal(forced.round.pendingAction, null);
  assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 409);
  const picked = await action(request, third, 'choose_forced_peek', { cornerId: 'hall_clock' });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.round.resolution.token.number, 4);
  assert.equal((await action(request, third, 'resolve_peek', { take: false })).status, 200);
  const logs = (await snapshot(request, hako)).body.log.join('\n');
  assert.equal(logs.includes('动来动去'), false);
  assert.equal(logs.includes('password_4'), false);
});

test('HTTP extinguisher windows block progression and cancel NO.5 without exposing hidden victims', async t => {
  const { request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'extinguisher');
      play.inventories[setup.visitorIds[0]].tokens.push(play.tokens[source]);
      play.tokens[source] = null;
      play.powers.deck.splice(play.powers.deck.indexOf(5), 1);
      play.powers.slots[0] = { id: 5, ignoreThreshold: true, faceUp: false };
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second] = people;
  let state;
  for (let index = 0; index < 3; index++) {
    const person = people[index + 1];
    state = (await action(request, person, 'silent_reveal', { index })).body;
    await action(request, person, 'move', { roomId: state.round.moveTargets[0] });
    assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
  }
  state = (await action(request, first, 'silent_reveal', { index: 3 })).body;
  assert.deepEqual(state.round.interruption, { kind: 'noise', canRespond: true });
  assert.equal((await action(request, hako, 'pass_noise_reaction')).status, 409);
  assert.equal((await action(request, second, 'extinguisher_response', { use: true })).status, 409);
  assert.equal((await action(request, first, 'extinguisher_response', { use: false })).status, 200);
  await action(request, hako, 'pass_noise_reaction');
  await action(request, hako, 'begin_hako_action');
  const activation = await action(request, hako, 'activate_power', { slot: 0 });
  assert.equal(activation.status, 200);
  state = (await snapshot(request, first)).body;
  assert.deepEqual(state.round.interruption, { kind: 'power', canRespond: true });
  assert.equal(JSON.stringify(state).includes('killerCornerId'), false);
  assert.equal(JSON.stringify(state).includes('restorePowers'), false);
  assert.equal((await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).status, 409);
  state = (await action(request, first, 'extinguisher_response', { use: true })).body;
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.silent.turnPlayerId, first.playerId);
  assert.equal(state.round.inventory.tokens.some(token => token.type === 'extinguisher'), false);
  assert.ok(state.round.visitors.every(visitor => visitor.status === 'alive'));
  const owner = (await snapshot(request, hako)).body;
  assert.equal(owner.round.powers.slots[0].card.id, 5);
  assert.equal(owner.round.powers.slots[0].faceUp, false);
  assert.equal((await action(request, first, 'extinguisher_response', { use: true })).status, 409);
});

test('stored lobbies recover identities, readiness, presence and multiple rooms; leaving stays final', async t => {
  const saved = await persistentServer(t);
  const people = await createFour(saved.request);
  const other = (await saved.request('/api/rooms', { name: '另一房间' })).body;
  await action(saved.request, people[1], 'ready', { ready: true });
  const live = await stream(t, saved.base, people[0]);
  assert.equal((await live.state()).players[0].connected, true);
  const disk = JSON.parse(await readFile(saved.dataFile, 'utf8'));
  assert.equal(disk.rooms.length, 2);
  assert.ok(disk.rooms.every(room => room.selectingHako === false));
  assert.ok(disk.rooms.every(room => room.players.every(player => player.role === 'visitor')));
  assert.ok(disk.rooms.every(room => room.players.every(player => !Object.hasOwn(player, 'connections'))));
  await checkRestart(saved, [...people, other]);
  assert.equal((await snapshot(saved.request, { ...people[0], token: people[1].token })).status, 403);
  await action(saved.request, people[0], 'leave');
  await action(saved.request, other, 'leave');
  await saved.restart();
  assert.equal((await snapshot(saved.request, people[0])).status, 403);
  assert.equal((await snapshot(saved.request, other)).status, 404);
  const remaining = (await snapshot(saved.request, people[1])).body;
  assert.equal(remaining.hostId, people[1].playerId);
  assert.equal(remaining.players.length, 3);
  assert.equal((await saved.request(`/api/rooms/${people[0].roomCode}/join`, { name: '替补' })).body.state.players.length, 4);
});

test('draft, a drawn map, secret opening and original shuffled decks survive restarts', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  for (const person of people) await action(request, person, 'ready', { ready: true });
  assert.equal((await action(request, people[0], 'start')).body.phase, 'hako_selection');
  let state = (await action(request, people[0], 'claim_hako')).body;
  const first = people.find(person => person.playerId === state.draft.turnPlayerId);
  await action(request, first, 'choose_item', { itemId: 'spirit_pen' });
  await checkRestart(saved, people);
  for (let i = 0; i < 2; i++) {
    state = (await snapshot(request, people[0])).body;
    const current = people.find(person => person.playerId === state.draft.turnPlayerId);
    await action(request, current, 'choose_item', { itemId: state.draft.availableItems[0].id });
  }
  state = (await snapshot(request, people[0])).body;
  while (state.phase === 'map_setup') {
    const current = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = (await action(request, current, 'draw')).body;
    if (state.setup.placements.length === 1) {
      const before = await readFile(saved.dataFile, 'utf8');
      await checkRestart(saved, people);
      assert.equal(await readFile(saved.dataFile, 'utf8'), before, 'Loading must not reshuffle the remaining maps');
    }
    state = (await action(request, current, 'place', state.setup.legalPlacements[0])).body;
  }
  await action(request, people[0], 'prepare_opening');
  await action(request, people[0], 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  const before = await readFile(saved.dataFile, 'utf8');
  await checkRestart(saved, people);
  assert.equal(await readFile(saved.dataFile, 'utf8'), before, 'Loading must preserve randomly assigned corner tokens');
  await action(request, people[0], 'place_remains', { cornerId: 'living_sofa' });
  await action(request, people[0], 'inspect_initial_room', { roomId: 'children_room' });
  await checkRestart(saved, people);
  const hidden = (await action(request, people[0], 'choose_initial_hiding', { cornerId: 'children_cabinet' })).body;
  const candidates = hidden.opening.initialPowerOptions;
  await checkRestart(saved, people);
  assert.deepEqual((await snapshot(request, people[0])).body.opening.initialPowerOptions, candidates,
    'Restart keeps the same privately dealt three-card choice');
  assert.equal((await action(request, people[0], 'choose_initial_power', { powerId: candidates[0].id })).status, 200);
  await checkRestart(saved, people);
});

test('confirmed hiding history survives HTTP refresh and restart without revealing later marker changes or visitor secrets', async t => {
  const rememberedId = 'remembered-http-password';
  const coveredId = 'remembered-covered-password';
  const saved = await persistentServer(t, { createPlayState(setup, opening, options) {
    const play = createPlay(setup, opening, options);
    play.tokens.children_cabinet = { id: rememberedId, type: 'password', number: 4 };
    play.tokens.children_bed = { id: coveredId, type: 'password', number: 6 };
    play.round.visitors.forEach(visitor => { visitor.roomId = 'children_room'; });
    play.opening.emptyBoxTokens = [];
    return play;
  } });
  const { request } = saved;
  const people = await createFour(request);
  const [hako, first] = people;
  let state = await preparePlay(request, people);
  for (let index = 0; index < 5; index++) {
    const current = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    const response = await action(request, current, 'silent_skip', { index });
    assert.equal(response.status, 200);
    state = response.body;
  }
  assert.equal((await action(request, hako, 'begin_hako_action')).status, 200);
  const hakoEvents = await stream(t, saved.base, hako);
  const visitorEvents = await stream(t, saved.base, first);
  const inspected = await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' });
  assert.equal(inspected.status, 200);
  assert.ok(inspected.body.round.hako.inspectedRoom.corners.every(corner => !Object.hasOwn(corner, 'token')));
  assert.equal(JSON.stringify(inspected.body.round.hako).includes(coveredId), false,
    'Selecting the room does not reveal the future replaced piece');
  const confirmed = await action(request, hako, 'hako_hide', { cornerId: 'children_bed' });
  assert.equal(confirmed.status, 200);
  assert.equal(Object.hasOwn(confirmed.body.round.hako, 'inspectedRoom'), false);
  const memory = confirmed.body.round.hako.lastInspectedRoom;
  assert.equal(memory.cycle, 1);
  assert.equal(memory.corners.length, 1);
  assert.equal(memory.corners[0].id, 'children_bed');
  assert.equal(memory.corners[0].token.id, coveredId);
  const ownerPush = await hakoEvents.state(update => update.version >= confirmed.body.version);
  assert.deepEqual(ownerPush.round.hako.lastInspectedRoom, memory);
  const visitorPush = await visitorEvents.state(update => update.version >= confirmed.body.version);
  assert.equal(JSON.stringify(visitorPush).includes('lastInspectedRoom'), false);
  assert.equal(JSON.stringify(visitorPush).includes(rememberedId), false);
  await hakoEvents.close();
  await visitorEvents.close();
  await checkRestart(saved, people);
  assert.deepEqual((await snapshot(request, hako)).body.round.hako.lastInspectedRoom, memory);

  state = (await snapshot(request, hako)).body;
  const current = people.find(person => person.playerId === state.round.silent.turnPlayerId);
  assert.equal((await action(request, current, 'silent_reveal', { index: 0 })).status, 200);
  assert.equal((await action(request, current, 'peek', { cornerId: 'children_cabinet' })).status, 200);
  assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
  assert.equal((await action(request, current, 'resolve_peek', { take: true, replacement: 'none' })).status, 200);
  assert.equal((await snapshot(request, current)).body.round.inventory.tokens.some(token => token.id === rememberedId), true);
  assert.deepEqual((await snapshot(request, hako)).body.round.hako.lastInspectedRoom, memory,
    'A visitor taking another marker cannot turn the private replaced-piece history into a live room view');
  await checkRestart(saved, people);
  assert.deepEqual((await snapshot(request, hako)).body.round.hako.lastInspectedRoom, memory);
  for (const person of people.slice(1)) {
    const view = (await snapshot(request, person, { poll: true })).body;
    assert.equal(JSON.stringify(view).includes('lastInspectedRoom'), false);
    assert.equal(JSON.stringify(view).includes('hidingMemories'), false);
  }
});

test('pending peeks, private results, inventory, exchanges and the final result recover without leaks', async t => {
  let created = 0;
  const saved = await persistentServer(t, { createPlayState(setup, opening, options) {
    created++;
    const play = createPlay(setup, opening, options);
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_4');
    [play.tokens.hall_clock, play.tokens[source]] = [play.tokens[source], play.tokens.hall_clock];
    return play;
  } });
  const { request } = saved;
  const people = await createFour(request);
  const [hako, first, second, third] = people;
  await preparePlay(request, people);
  const originalHakoMemory = (await snapshot(request, hako)).body.round.hako.lastInspectedRoom;
  await action(request, first, 'silent_reveal', { index: 0 });
  await action(request, first, 'peek', { cornerId: 'hall_clock' });
  await checkRestart(saved, people);
  assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, first)).body.round.resolution.token.id, 'password_4');
  for (const person of [hako, second, third]) {
    const live = await stream(t, saved.base, person);
    const view = await live.state();
    assert.deepEqual(view.round.resolution, { kind: 'waiting', playerId: first.playerId });
    if (person.playerId === hako.playerId) {
      // The fixture moves password_4 after opening. The owner may already have
      // seen it in the randomly dealt room; that unchanged history is allowed.
      assert.deepEqual(view.round.hako.lastInspectedRoom, originalHakoMemory,
        'Peeking must not add private visitor results to the owner\'s existing room history');
      const { lastInspectedRoom, ...hakoWithoutHistory } = view.round.hako;
      assert.equal(JSON.stringify({ ...view, round: { ...view.round, hako: hakoWithoutHistory } }).includes('password_4'), false);
    } else {
      assert.equal(JSON.stringify(view).includes('password_4'), false);
    }
    await live.close();
  }
  await action(request, first, 'resolve_peek', { take: true, replacement: 'empty_box' });
  await action(request, first, 'offer_exchange', { targetId: second.playerId, giveTokenIds: ['password_4'] });
  await checkRestart(saved, people);
  const offer = (await snapshot(request, second)).body.round.exchangeOffers[0];
  assert.equal((await action(request, second, 'respond_exchange', { offerId: offer.id, accept: true })).status, 200);
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, second)).body.round.inventory.tokens[0].id, 'password_4');
  for (const person of people.slice(1)) await action(request, person, 'surrender');
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, hako)).body.phase, 'game_over');
  assert.equal((await action(request, second, 'silent_reveal', { index: 1 })).status, 409);
  assert.equal(created, 1, 'Restoring must not recreate opening state or redraw decks');
  for (const path of ['/data/rooms.json', '/data/rooms.json.tmp', '/src/storage.mjs']) {
    assert.equal((await fetch(`${saved.base}${path}`)).status, 404);
  }
});

test('failed disk writes leave actions, joins, departures and SSE unchanged and allow retry', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const host = (await request('/api/rooms', { name: '房主' })).body;
  const live = await stream(t, saved.base, host);
  const before = await live.state();
  const bytes = await readFile(saved.dataFile, 'utf8');
  // An occupied temporary path makes replacement fail consistently on Windows and Unix.
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    for (const attempt of [
      () => action(request, host, 'ready', { ready: true }),
      () => request(`/api/rooms/${host.roomCode}/join`, { name: '未入席' }),
      () => action(request, host, 'leave'),
      () => request('/api/rooms', { name: '未创建' }),
    ]) {
      const failed = await attempt();
      assert.equal(failed.status, 503);
      assert.match(failed.body.error, /本次操作未生效/);
      assert.deepEqual((await snapshot(request, host)).body, before);
      assert.equal(await readFile(saved.dataFile, 'utf8'), bytes);
    }
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const retry = await action(request, host, 'ready', { ready: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.version, before.version + 1);
  assert.deepEqual(await live.state(), retry.body, 'No uncommitted state may have entered the SSE stream');
  const people = [host];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const joined = await request(`/api/rooms/${host.roomCode}/join`, { name });
    assert.equal(joined.status, 201);
    people.push(joined.body);
    assert.equal((await action(request, joined.body, 'ready', { ready: true })).status, 200);
  }
  const ready = (await snapshot(request, host)).body;
  await live.state(update => update.version >= ready.version);
  const readyBytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, host, 'start')).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, ready);
    assert.equal(await readFile(saved.dataFile, 'utf8'), readyBytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const selection = await action(request, host, 'start');
  assert.equal(selection.status, 200);
  assert.equal(selection.body.phase, 'hako_selection');
  assert.equal(selection.body.version, ready.version + 1);
  assert.deepEqual(await live.state(), selection.body, 'A failed start must not have published a selection');
  const selectionBytes = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(request, people[2], 'claim_hako')).status, 503);
    assert.deepEqual((await snapshot(request, host)).body, selection.body);
    assert.ok(selection.body.players.every(player => player.role === 'visitor'));
    assert.equal(selection.body.draft, null);
    assert.equal(await readFile(saved.dataFile, 'utf8'), selectionBytes);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const claimed = await action(request, people[2], 'claim_hako');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.phase, 'item_draft');
  assert.equal(claimed.body.version, selection.body.version + 1);
  assert.deepEqual(claimed.body.players.filter(player => player.role === 'hako').map(player => player.id), [people[2].playerId]);
  assert.deepEqual(await live.state(), { ...claimed.body, you: host.playerId },
    'A failed claim must not publish a role or advance drafting');
  await live.close();
  await checkRestart(saved, people);
});

test('invalid actions and presence changes do not rewrite stored game state', async t => {
  const saved = await persistentServer(t);
  const people = await createFour(saved.request);
  const before = await readFile(saved.dataFile, 'utf8');
  const live = await stream(t, saved.base, people[0]);
  await live.state();
  await live.close();
  assert.equal((await action(saved.request, people[1], 'start')).status, 403);
  assert.equal((await action(saved.request, people[0], 'ready', { ready: 'yes' })).status, 400);
  await snapshot(saved.request, people[0]);
  assert.equal(await readFile(saved.dataFile, 'utf8'), before);
});

test('corrupt or unsupported storage refuses startup and preserves the original file', async t => {
  const saved = await persistentServer(t);
  const host = (await saved.request('/api/rooms', { name: '房主' })).body;
  const valid = await readFile(saved.dataFile, 'utf8');
  const invalidRoom = JSON.parse(valid);
  invalidRoom.rooms[0].players[0].seat = 8;
  const invalidGame = JSON.parse(valid);
  invalidGame.rooms[0].game = { phase: 'map_setup', placements: null };
  const botHost = JSON.parse(valid);
  botHost.rooms[0].players[0].isBot = true;
  const invalidBotFlag = JSON.parse(valid);
  invalidBotFlag.rooms[0].players[0].isBot = 'true';
  for (const content of ['{', JSON.stringify({ format: 2, rooms: [] }),
    JSON.stringify(invalidRoom), JSON.stringify(invalidGame), JSON.stringify(botHost), JSON.stringify(invalidBotFlag)]) {
    await writeFile(saved.dataFile, content);
    assert.throws(() => createGameServer({ dataFile: saved.dataFile }), /存档/);
    assert.equal(await readFile(saved.dataFile, 'utf8'), content);
  }
  await writeFile(saved.dataFile, valid);
  await checkRestart(saved, [host]);
});

test('the real entry point saves to DATA_DIR before an abrupt process restart', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hako-process-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory, ACCESS_DIR: directory },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    let timer;
    const base = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Entry point did not start: ${output}`)), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /http:\/\/localhost:(\d+)/.exec(output);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Entry point exited: ${output}`)));
    }).finally(() => clearTimeout(timer));
    return { child, base };
  }
  const first = await boot();
  const denied = await fetch(`${first.base}/api/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '未验证' }),
  });
  assert.equal(denied.status, 401, 'The real entry point enables admission protection by default');
  const { adminKey } = JSON.parse(await readFile(join(directory, 'access.json'), 'utf8'));
  const issued = await fetch(`${first.base}/api/access/admin`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ action: 'create', maxUses: 1 }),
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const admitted = await fetch(`${first.base}/api/access/redeem`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  assert.equal(admitted.status, 200);
  const cookie = admitted.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${first.base}/api/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '重启测试' }),
  });
  assert.equal(response.status, 201);
  const person = await response.json();
  assert.equal(JSON.parse(await readFile(join(directory, 'rooms.json'), 'utf8')).rooms[0].code, person.roomCode);
  await stop(first.child);
  const second = await boot();
  const recovered = await fetch(`${second.base}/api/rooms/${person.roomCode}?${new URLSearchParams({
    playerId: person.playerId, token: person.token,
  })}`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), person.state);
});

test('HTTP boundary rejects malformed requests and only exposes intended static resources', async t => {
  const { base, request } = await startServer(t);
  assert.deepEqual((await request('/api/health')).body, { ok: true });
  const malformed = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, 'string');
  const oversized = await fetch(`${base}/api/rooms`, { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(oversized.status, 413);
  assert.equal((await request('/api/rooms', undefined, 'PUT')).status, 405);
  assert.equal((await request('/api/rooms/NOPE00/join', { name: '访客' })).status, 404);
  assert.equal((await request('/api/nothing')).status, 404);
  assert.equal((await request('/package.json')).status, 404);
  assert.equal((await request('/src/server.mjs')).status, 404);
  const maps = await fetch(`${base}/shared/maps.mjs`);
  assert.equal(maps.status, 200);
  assert.match(maps.headers.get('content-type'), /javascript/);
  assert.match(await maps.text(), /MAP_TILES/);
});
