import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

async function persistentServer(t, createPlayState) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-cards-http-'));
  const dataFile = join(directory, 'rooms.json');
  let server, base;
  async function restart() {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState, dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  await restart();
  t.after(async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { request, restart, dataFile, get base() { return base; } };
}

function snapshot(client, person, poll = false) {
  return client.request(`/api/rooms/${person.roomCode}?${new URLSearchParams({
    playerId: person.playerId, token: person.token, ...(poll ? { poll: '1' } : {}),
  })}`);
}

async function action(client, person, type, values = {}) {
  return client.request(`/api/rooms/${person.roomCode}/actions`, {
    playerId: person.playerId, token: person.token, type, ...values,
  });
}

async function ok(client, person, type, values = {}) {
  const response = await action(client, person, type, values);
  assert.equal(response.status, 200, `${type}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function preparePlay(client, { powerId = 7, items = ['walkie_talkie', 'spirit_pen', 'ventriloquist_doll'] } = {}) {
  const created = await client.request('/api/rooms', { name: '箱娃' });
  assert.equal(created.status, 201);
  const people = [created.body];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const response = await client.request(`/api/rooms/${people[0].roomCode}/join`, { name });
    assert.equal(response.status, 201);
    people.push(response.body);
  }
  for (const person of people) await ok(client, person, 'ready', { ready: true });
  assert.equal((await ok(client, people[0], 'start')).phase, 'hako_selection');
  let state = await ok(client, people[0], 'claim_hako');
  for (const itemId of items) {
    const person = people.find(candidate => candidate.playerId === state.draft.turnPlayerId);
    state = await ok(client, person, 'choose_item', { itemId });
  }
  while (state.phase === 'map_setup') {
    const person = people.find(candidate => candidate.playerId === state.setup.turnPlayerId);
    state = await ok(client, person, 'draw');
    state = await ok(client, person, 'place', state.setup.legalPlacements[0]);
  }
  const hako = people[0];
  await ok(client, hako, 'prepare_opening');
  await ok(client, hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await ok(client, hako, 'place_remains', { cornerId: 'living_sofa' });
  await ok(client, hako, 'inspect_initial_room', { roomId: 'children_room' });
  await ok(client, hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  await ok(client, hako, 'choose_initial_power', { powerId });
  return people;
}

// The trusted midgame fixture moves existing physical pieces; it does not invent tokens or cards.
function carryToken(play, playerId, predicate) {
  const cornerId = Object.keys(play.tokens).find(id => predicate(play.tokens[id]));
  assert.ok(cornerId, 'The fixture token must exist in this real opening');
  const piece = play.tokens[cornerId];
  const empty = play.opening.emptyBoxTokens.shift();
  assert.ok(empty);
  play.tokens[cornerId] = { ...empty, faceUp: false };
  play.inventories[playerId].tokens.push(piece);
  return piece;
}

function setInitialPower(play, powerId) {
  const index = play.powers.hand.findIndex(card => card.id === powerId);
  assert.ok(index >= 0, 'The fixture uses the selected initial power exactly once');
  play.powers.slots[0] = { ...play.powers.hand.splice(index, 1)[0], faceUp: false };
}

async function stream(client, person) {
  const abort = new AbortController();
  const response = await fetch(`${client.base}/api/rooms/${person.roomCode}/events?${new URLSearchParams({
    playerId: person.playerId, token: person.token,
  })}`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return {
    async close() { abort.abort(); await reader.cancel().catch(() => {}); },
    async state(predicate = () => true) {
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
          assert.equal(done, false, 'SSE closed before the expected version');
          buffer += decoder.decode(value, { stream: true });
        }
      }
    },
  };
}

async function declareMove(client, person) {
  const state = (await snapshot(client, person)).body;
  assert.ok(state.round.moveTargets.length, 'This real map provides a legal movement');
  return ok(client, person, 'move', { roomId: state.round.moveTargets[0] });
}

async function finishMove(client, hako, person) {
  await declareMove(client, person);
  return ok(client, hako, 'resolve_visitor_action');
}

async function finishHako(client, hako, { setPowerId } = {}) {
  if (setPowerId !== undefined) await ok(client, hako, 'set_power', { powerId: setPowerId, slot: 0 });
  await ok(client, hako, 'begin_hako_action');
  await ok(client, hako, 'inspect_hiding_room', { roomId: 'children_room' });
  return ok(client, hako, 'hako_hide', { cornerId: 'children_cabinet' });
}

async function assertRestored(client, people) {
  const before = await Promise.all(people.map(async person => (await snapshot(client, person)).body));
  await client.restart();
  for (let index = 0; index < people.length; index++) {
    const restored = await snapshot(client, people[index]);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body, { ...before[index],
      players: before[index].players.map(player => ({ ...player, connected: false })),
    });
  }
}

test('NO.7 filters theft options and stolen tokens across HTTP, SSE and polling, then returns the old theft to its next victim', { timeout: 20000 }, async t => {
  let created = 0;
  const client = await persistentServer(t, (setup, opening, options) => {
    created++;
    const play = createPlay(setup, opening, options);
    carryToken(play, setup.visitorIds[0], token => token?.id === 'password_4');
    setInitialPower(play, 7);
    return play;
  });
  const people = await preparePlay(client), [hako, first, second, third] = people;
  const streams = await Promise.all(people.map(person => stream(client, person)));
  t.after(() => Promise.all(streams.map(live => live.close())));
  await ok(client, first, 'silent_reveal', { index: 0 });
  await declareMove(client, first);
  const beforeTheft = (await snapshot(client, hako)).body;
  const theft = beforeTheft.round.powers.activationOptions.find(option => option.card.id === 7);
  assert.equal(theft.canActivate, true);
  assert.deepEqual(theft.stealOptions, { items: [{ id: 'walkie_talkie', name: '对讲机' }], canStealToken: true });
  assert.equal(JSON.stringify(theft.stealOptions).includes('password_4'), false);
  assert.equal(JSON.stringify(theft.stealOptions).includes('number'), false);
  const rejected = await action(client, hako, 'activate_power', { slot: 0, stealKind: 'token', tokenId: 'password_4' });
  assert.equal(rejected.status, 409);
  assert.deepEqual((await snapshot(client, hako)).body, beforeTheft);
  const stolen = await ok(client, hako, 'activate_power', { slot: 0, stealKind: 'token' });
  assert.equal(stolen.round.powers.stolen.piece.id, 'password_4');
  assert.equal(stolen.round.powers.stolen.piece.number, 4);
  assert.equal(stolen.round.pendingAction, null);
  assert.equal(stolen.round.silent.phase, 'visitor_action');
  assert.equal(stolen.round.silent.turnPlayerId, first.playerId);
  assert.equal(stolen.round.silent.total, 0);
  assert.ok(stolen.round.powers.hand.some(card => card.id === 7));
  for (let index = 0; index < people.length; index++) {
    const http = (await snapshot(client, people[index], true)).body;
    const pushed = await streams[index].state(state => state.version === stolen.version);
    assert.deepEqual(pushed.round, http.round);
    if (index === 0) assert.equal(http.round.powers.stolen.piece.id, 'password_4');
    else {
      assert.equal(Object.hasOwn(http.round.powers, 'stolen'), false);
      assert.equal(JSON.stringify(http).includes('password_4'), false);
      assert.equal(JSON.stringify(pushed).includes('password_4'), false);
    }
  }
  await Promise.all(streams.map(live => live.close()));
  await assertRestored(client, people);
  await finishMove(client, hako, first);
  await ok(client, second, 'silent_reveal', { index: 4 });
  await finishMove(client, hako, second);
  await ok(client, third, 'silent_reveal', { index: 5 });
  await finishMove(client, hako, third);
  const overflow = await ok(client, first, 'silent_reveal', { index: 2 });
  assert.equal(overflow.round.silent.total, 11);
  await ok(client, hako, 'pass_noise_reaction');
  await finishHako(client, hako, { setPowerId: 7 });
  await ok(client, first, 'silent_reveal', { index: 0 });
  await finishMove(client, hako, first);
  await ok(client, second, 'silent_reveal', { index: 1 });
  await declareMove(client, second);
  const next = await ok(client, hako, 'activate_power', { slot: 0, stealKind: 'item', itemId: 'spirit_pen' });
  assert.equal(next.round.powers.stolen.kind, 'item');
  assert.equal(next.round.powers.stolen.piece.id, 'spirit_pen');
  const secondView = (await snapshot(client, second)).body;
  assert.equal(secondView.round.inventory.tokens.find(token => token.id === 'password_4').number, 4);
  assert.equal(secondView.round.inventory.items.some(item => item.id === 'spirit_pen'), false);
  assert.equal(secondView.round.silent.turnPlayerId, second.playerId);
  await assertRestored(client, people);
  assert.equal(created, 1, 'Restart must restore the actual cards instead of rebuilding the fixture');
});

test('a failed NO.7 save changes neither inventory, pending action, card, disk nor the next SSE event', { timeout: 15000 }, async t => {
  const client = await persistentServer(t, (setup, opening, options) => {
    const play = createPlay(setup, opening, options);
    carryToken(play, setup.visitorIds[0], token => token?.id === 'password_4');
    setInitialPower(play, 7);
    return play;
  });
  const people = await preparePlay(client), [hako, first] = people;
  await ok(client, first, 'silent_reveal', { index: 0 });
  await declareMove(client, first);
  const live = await stream(client, hako);
  t.after(() => live.close());
  const before = await live.state(), bytes = await readFile(client.dataFile, 'utf8');
  await mkdir(`${client.dataFile}.tmp`);
  try {
    const failed = await action(client, hako, 'activate_power', { slot: 0, stealKind: 'token' });
    assert.equal(failed.status, 503);
    assert.match(failed.body.error, /本次操作未生效/);
    assert.deepEqual((await snapshot(client, hako)).body, before);
    assert.equal((await snapshot(client, first)).body.round.inventory.tokens[0].id, 'password_4');
    assert.equal(await readFile(client.dataFile, 'utf8'), bytes);
  } finally { await rm(`${client.dataFile}.tmp`, { recursive: true }); }
  const retry = await ok(client, hako, 'activate_power', { slot: 0, stealKind: 'token' });
  assert.equal(retry.version, before.version + 1);
  assert.deepEqual(await live.state(), retry, 'A rejected save must never have been broadcast');
  await live.close();
  await assertRestored(client, people);
  const restored = (await snapshot(client, hako)).body;
  assert.equal(restored.round.powers.stolen.piece.id, 'password_4');
  assert.ok(restored.round.powers.hand.some(card => card.id === 7));
  assert.equal(restored.round.pendingAction, null);
});

test('NO.8 curse, its attached card and the remaining required reveal survive separate HTTP service restarts', { timeout: 20000 }, async t => {
  const client = await persistentServer(t, (setup, opening, options) => {
    const play = createPlay(setup, opening, options);
    carryToken(play, setup.visitorIds[0], token => token?.type === 'doll');
    setInitialPower(play, 8);
    return play;
  });
  const people = await preparePlay(client, { powerId: 8 }), [hako, first, second, third] = people;
  await ok(client, first, 'silent_reveal', { index: 0 });
  await declareMove(client, first);
  const cursed = await ok(client, hako, 'activate_power', { slot: 0 });
  assert.equal(cursed.round.noiseEffects.maryPlayerId, first.playerId);
  assert.equal(cursed.round.powers.slots[0].occupied, false);
  assert.equal(cursed.round.powers.hand.some(card => card.id === 8), false);
  await assertRestored(client, people);
  let disk = JSON.parse(await readFile(client.dataFile, 'utf8')).rooms[0].play;
  assert.equal(disk.noiseEffects.mary.playerId, first.playerId);
  assert.deepEqual(disk.noiseEffects.mary.card, { id: 8, ignoreThreshold: true });
  await ok(client, hako, 'resolve_visitor_action');
  await ok(client, second, 'silent_reveal', { index: 1 });
  await finishMove(client, hako, second);
  await ok(client, third, 'silent_reveal', { index: 2 });
  await finishMove(client, hako, third);
  const partial = await ok(client, first, 'silent_reveal', { index: 3 });
  assert.equal(partial.round.silent.total, 6);
  assert.equal(partial.round.silent.phase, 'visitor_reveal');
  assert.equal(partial.round.silent.revealsRemaining, 1);
  assert.equal(partial.round.noiseEffects.requiredReveals, 2);
  assert.equal(Object.hasOwn(partial.round.silent.cards[4], 'number'), false);
  await assertRestored(client, people);
  disk = JSON.parse(await readFile(client.dataFile, 'utf8')).rooms[0].play;
  assert.equal(disk.round.silent.revealsRemaining, 1);
  assert.equal(disk.noiseEffects.bellIntent.revealed, 1);
  assert.equal(disk.noiseEffects.bellIntent.useBell, false);
  const completed = await ok(client, first, 'silent_reveal', { index: 4 });
  assert.equal(completed.round.silent.total, 10);
  assert.equal(completed.round.silent.phase, 'visitor_action');
  assert.equal(completed.round.silent.turnPlayerId, first.playerId);
  assert.equal(completed.round.silent.revealsRemaining ?? 0, 0);
  await finishMove(client, hako, first);
  await assertRestored(client, people);
});

test('a declared bell plan, completed extra reveal and pending bell use each resume after a restart', { timeout: 20000 }, async t => {
  const client = await persistentServer(t);
  const people = await preparePlay(client, { items: ['shrine_bell', 'spirit_pen', 'ventriloquist_doll'] });
  const [hako, first, second] = people;
  const partial = await ok(client, first, 'silent_reveal', { index: 0, useBell: true });
  assert.equal(partial.round.silent.phase, 'visitor_reveal');
  assert.equal(partial.round.silent.revealsRemaining, 1);
  assert.equal(partial.round.noiseEffects.bellChosen, true);
  assert.equal(partial.round.noiseEffects.canUseBell, false);
  await assertRestored(client, people);
  const before = (await snapshot(client, first)).body;
  assert.equal((await action(client, first, 'silent_reveal', { index: 1, useBell: false })).status, 409);
  assert.deepEqual((await snapshot(client, first)).body, before);
  const ready = await ok(client, first, 'silent_reveal', { index: 1 });
  assert.equal(ready.round.silent.total, 1);
  assert.equal(ready.round.noiseEffects.canUseBell, true);
  await assertRestored(client, people);
  assert.equal((await snapshot(client, first)).body.round.items.usableItems.some(item => item.id === 'shrine_bell'), true);
  const pending = await ok(client, first, 'use_item', { itemId: 'shrine_bell' });
  assert.deepEqual(pending.round.pendingAction, { type: 'item', playerId: first.playerId, itemId: 'shrine_bell' });
  await assertRestored(client, people);
  const used = await ok(client, hako, 'resolve_visitor_action');
  assert.equal(used.round.noiseEffects.bellUserId, first.playerId);
  assert.equal(used.round.pendingAction, null);
  assert.equal(used.round.silent.turnPlayerId, second.playerId);
  await assertRestored(client, people);
  for (const person of people) {
    const view = (await snapshot(client, person, true)).body;
    assert.equal(view.round.noiseEffects.bellUserId, first.playerId);
    assert.equal(view.round.noiseEffects.canUseBell, false);
  }
});
