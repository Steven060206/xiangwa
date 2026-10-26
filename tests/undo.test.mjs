import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../src/server.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

async function service(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-undo-'));
  const dataFile = join(directory, 'rooms.json');
  let server, base;
  const close = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  const restart = async () => {
    await close();
    server = createGameServer({ deck, silentNumbers: [5, 4, 1, 2, 0, 3], dataFile, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await restart();
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, restart, close, dataFile };
}

function action(request, person, type, input = {}) {
  return request(`/api/rooms/${person.roomCode}/actions`, {
    playerId: person.playerId, token: person.token, type, ...input,
  });
}

async function state(request, person, poll = false) {
  const response = await request(`/api/rooms/${person.roomCode}?${new URLSearchParams({
    playerId: person.playerId, token: person.token, ...(poll ? { poll: '1' } : {}),
  })}`);
  assert.equal(response.status, 200);
  return response.body;
}

async function four(request) {
  const first = await request('/api/rooms', { name: '房主箱娃' });
  assert.equal(first.status, 201);
  const people = [first.body];
  for (const name of ['甲', '乙', '丙']) {
    const response = await request(`/api/rooms/${first.body.roomCode}/join`, { name });
    assert.equal(response.status, 201);
    people.push(response.body);
  }
  for (const person of people) await state(request, person, true);
  return people;
}

async function readyAndStart(request, people) {
  for (const person of people) assert.equal((await action(request, person, 'ready', { ready: true })).status, 200);
  const started = await action(request, people[0], 'start');
  assert.equal(started.status, 200);
  assert.equal(started.body.phase, 'hako_selection');
  return started.body;
}

async function readyOpening(request, people) {
  await readyAndStart(request, people);
  let result = await action(request, people[0], 'claim_hako');
  assert.equal(result.status, 200);
  for (let index = 0; index < 3; index++) {
    const person = people.find(person => person.playerId === result.body.draft.turnPlayerId);
    result = await action(request, person, 'choose_item', { itemId: result.body.draft.availableItems[0].id });
    assert.equal(result.status, 200);
  }
  while (result.body.phase === 'map_setup') {
    const person = people.find(person => person.playerId === result.body.setup.turnPlayerId);
    const drawn = await action(request, person, 'draw');
    assert.equal(drawn.status, 200);
    result = await action(request, person, 'place', drawn.body.setup.legalPlacements[0]);
    assert.equal(result.status, 200);
  }
  result = await action(request, people[0], 'prepare_opening');
  assert.equal(result.status, 200);
  return result.body;
}

async function play(request, people) {
  await readyOpening(request, people);
  const entries = [
    ['choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' }],
    ['place_remains', { cornerId: 'living_sofa' }],
    ['inspect_initial_room', { roomId: 'children_room' }],
    ['choose_initial_hiding', { cornerId: 'children_cabinet' }],
    ['choose_initial_power', { powerId: 1 }],
  ];
  let result;
  for (const [type, input] of entries) {
    result = await action(request, people[0], type, input);
    assert.equal(result.status, 200);
  }
  return result.body;
}

function position(snapshot) {
  const { undo, version, log, ...game } = snapshot;
  return game;
}

async function requestUndo(request, person, snapshot) {
  return action(request, person, 'undo_request', { version: snapshot.version });
}

async function consent(request, people, pending) {
  let result;
  for (const id of pending.requiredIds.filter(id => !pending.approvedIds.includes(id))) {
    const person = people.find(person => person.playerId === id);
    assert.ok(person, 'Only real participants need a vote');
    result = await action(request, person, 'undo_respond', { requestId: pending.id, accept: true });
    assert.equal(result.status, 200);
  }
  return result?.body;
}

async function waitState(request, person, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await state(request, person);
    if (predicate(snapshot)) return snapshot;
    await delay(10);
  }
  assert.fail('The room did not reach the expected state');
}

test('undo directly restores only the owner readiness and caps private history at forty steps', async t => {
  const { request } = await service(t);
  const people = await four(request);
  const first = people[1];
  const before = await state(request, first);
  const changed = await action(request, first, 'ready', { ready: true });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.undo.mode, 'direct');
  assert.equal(changed.body.undo.actorId, first.playerId);
  const restored = await requestUndo(request, first, changed.body);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.undo.pending, null);
  assert.deepEqual(position(restored.body), position(before));
  assert.ok(restored.body.version > changed.body.version);
  for (let index = 0; index < 45; index++) {
    assert.equal((await action(request, first, 'ready', { ready: index % 2 === 0 })).status, 200);
  }
  const recent = await state(request, first);
  assert.equal(recent.undo.steps, 40);
  assert.equal(Object.hasOwn(recent.undo, 'history'), false);
  assert.equal(Object.hasOwn(recent.undo, 'before'), false);
});

test('shared role selection requires online human consent, freezes actions and rejects stale or duplicate votes', async t => {
  const { request } = await service(t);
  const people = await four(request);
  await readyAndStart(request, people);
  const before = await Promise.all(people.map(person => state(request, person)));
  const claim = await action(request, people[0], 'claim_hako');
  assert.equal(claim.body.undo.mode, 'vote');
  const stale = await requestUndo(request, people[0], before[0]);
  assert.equal(stale.status, 409);
  const attempts = await Promise.all([
    requestUndo(request, people[0], claim.body), requestUndo(request, people[0], claim.body),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409], 'Concurrent requests create only one pending vote');
  const proposed = attempts.find(result => result.status === 200);
  assert.equal(proposed.status, 200);
  const pending = proposed.body.undo.pending;
  assert.ok(pending);
  assert.equal(pending.requestedBy, people[0].playerId);
  assert.deepEqual(new Set(pending.requiredIds), new Set(people.map(person => person.playerId)));
  assert.ok(pending.approvedIds.includes(people[0].playerId));
  assert.equal((await action(request, people[1], 'choose_item', { itemId: 'spirit_pen' })).status, 409);
  assert.equal((await action(request, people[1], 'undo_respond', { requestId: 'old-request', accept: true })).status, 409);
  assert.equal((await requestUndo(request, people[1], proposed.body)).status, 409);
  for (const person of people) assert.deepEqual((await state(request, person)).undo.pending, pending);
  await consent(request, people, pending);
  for (let index = 0; index < people.length; index++) {
    const restored = await state(request, people[index]);
    assert.deepEqual(position(restored), position(before[index]));
    assert.equal(restored.undo.pending, null);
    assert.ok(restored.version > proposed.body.version);
  }
  assert.equal((await action(request, people[1], 'undo_respond', { requestId: pending.id, accept: true })).status, 409);
});

test('rejecting and cancelling an undo keeps the current game and history while unauthorized cancellation fails', async t => {
  const { request } = await service(t);
  const people = await four(request);
  await readyAndStart(request, people);
  const claimed = (await action(request, people[0], 'claim_hako')).body;
  let proposed = (await requestUndo(request, people[1], await state(request, people[1]))).body;
  let pending = proposed.undo.pending;
  assert.equal((await action(request, people[2], 'undo_cancel', { requestId: pending.id })).status, 409);
  const rejected = await action(request, people[2], 'undo_respond', { requestId: pending.id, accept: false });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.undo.pending, null);
  assert.deepEqual(position(await state(request, people[0])), position(claimed));
  assert.equal(rejected.body.undo.steps, claimed.undo.steps);
  proposed = (await requestUndo(request, people[1], await state(request, people[1]))).body;
  pending = proposed.undo.pending;
  const cancelled = await action(request, people[0], 'undo_cancel', { requestId: pending.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.undo.pending, null);
  assert.deepEqual(position(cancelled.body), position(claimed));
  assert.equal(cancelled.body.undo.steps, claimed.undo.steps);
});

test('joining cannot cancel a pending lobby undo or change its history', async t => {
  const { request } = await service(t);
  const host = (await request('/api/rooms', { name: '房主' })).body;
  const second = (await request(`/api/rooms/${host.roomCode}/join`, { name: '第二位' })).body;
  await state(request, host, true);
  await state(request, second, true);
  assert.equal((await action(request, host, 'ready', { ready: true })).status, 200);
  const proposed = await requestUndo(request, second, await state(request, second));
  assert.equal(proposed.status, 200);
  const pending = proposed.body.undo.pending;
  assert.deepEqual(new Set(pending.requiredIds), new Set([host.playerId, second.playerId]));
  const before = await state(request, second);
  const joined = await request(`/api/rooms/${host.roomCode}/join`, { name: '第三位' });
  assert.equal(joined.status, 409);
  assert.deepEqual(await state(request, second), before, 'A rejected join preserves the vote, history, seats and version');
  const approved = await action(request, host, 'undo_respond', { requestId: pending.id, accept: true });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.undo.pending, null);
  assert.equal(approved.body.players.find(player => player.id === host.playerId).ready, false);
  const admitted = await request(`/api/rooms/${host.roomCode}/join`, { name: '第三位' });
  assert.equal(admitted.status, 201);
  assert.equal(admitted.body.state.players.length, 3);
});

test('private opening steps undo immediately and restore the actual token arrangement without publishing secrets', async t => {
  const { request } = await service(t);
  const people = await four(request);
  const hako = people[0];
  const opening = await readyOpening(request, people);
  const secrets = await action(request, hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  assert.equal(secrets.status, 200);
  assert.equal(secrets.body.undo.mode, 'direct');
  const oldSecret = await requestUndo(request, hako, secrets.body);
  assert.equal(oldSecret.status, 200);
  assert.equal(oldSecret.body.undo.pending, null);
  assert.deepEqual(position(oldSecret.body), position(opening));
  let current = (await action(request, hako, 'choose_secrets', { password: [2, 3, 6], weakness: 'white_stick' })).body;
  for (const [type, input] of [
    ['place_remains', { cornerId: 'living_sofa' }],
    ['inspect_initial_room', { roomId: 'children_room' }],
    ['choose_initial_hiding', { cornerId: 'children_cabinet' }],
  ]) {
    const before = current;
    const changed = await action(request, hako, type, input);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.undo.mode, 'direct');
    const restored = await requestUndo(request, hako, changed.body);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.undo.pending, null);
    assert.deepEqual(position(restored.body), position(before), `${type} restores the full private preparation view`);
    current = (await action(request, hako, type, input)).body;
  }
  for (const visitor of people.slice(1)) {
    const view = await state(request, visitor);
    for (const name of ['password', 'weakness', 'hidingCornerId', 'cornerTokens', 'inspectedRoom']) {
      assert.equal(Object.hasOwn(view.opening, name), false);
      assert.equal(Object.hasOwn(view.undo, name), false);
    }
    assert.equal(JSON.stringify(view.undo).includes('children_cabinet'), false);
  }
});

test('undoing draw and placement restores the same deck order and pending map without advancing the next visitor', async t => {
  const { request } = await service(t);
  const people = await four(request);
  await readyAndStart(request, people);
  let result = await action(request, people[0], 'claim_hako');
  for (let index = 0; index < 3; index++) {
    const person = people.find(person => person.playerId === result.body.draft.turnPlayerId);
    result = await action(request, person, 'choose_item', { itemId: result.body.draft.availableItems[0].id });
    assert.equal(result.status, 200);
  }
  const visitor = people.find(person => person.playerId === result.body.setup.turnPlayerId);
  const before = await state(request, visitor);
  const drawn = await action(request, visitor, 'draw');
  assert.equal(drawn.status, 200);
  let proposed = await requestUndo(request, visitor, drawn.body);
  assert.equal(proposed.status, 200);
  await consent(request, people, proposed.body.undo.pending);
  assert.deepEqual(position(await state(request, visitor)), position(before));
  const sameDraw = await action(request, visitor, 'draw');
  assert.equal(sameDraw.status, 200);
  assert.deepEqual(sameDraw.body.setup, drawn.body.setup, 'An undone draw cannot reroll the map deck');
  const placed = await action(request, visitor, 'place', sameDraw.body.setup.legalPlacements[0]);
  assert.equal(placed.status, 200);
  assert.notEqual(placed.body.setup.turnPlayerId, visitor.playerId);
  proposed = await requestUndo(request, visitor, placed.body);
  await consent(request, people, proposed.body.undo.pending);
  assert.deepEqual(position(await state(request, visitor)), position(sameDraw.body));
});

test('undo restores a revealed silent card, round turn and final result for every participant', async t => {
  const { request } = await service(t);
  const people = await four(request);
  await play(request, people);
  const before = await Promise.all(people.map(person => state(request, person)));
  const first = people.find(person => person.playerId === before[0].round.silent.turnPlayerId);
  const revealed = await action(request, first, 'silent_reveal', { index: 0 });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.round.silent.total, 5);
  assert.equal(revealed.body.undo.mode, 'vote');
  let proposed = await requestUndo(request, first, revealed.body);
  assert.ok(proposed.body.undo.pending);
  await consent(request, people, proposed.body.undo.pending);
  for (let index = 0; index < people.length; index++) {
    assert.deepEqual(position(await state(request, people[index])), position(before[index]));
  }
  for (const person of people.slice(1)) assert.equal((await action(request, person, 'surrender')).status, 200);
  const finished = await state(request, people[3]);
  assert.equal(finished.phase, 'game_over');
  proposed = await requestUndo(request, people[3], finished);
  assert.equal(proposed.status, 200);
  await consent(request, people, proposed.body.undo.pending);
  const restored = await state(request, people[0]);
  assert.equal(restored.phase, 'practice');
  assert.equal(restored.round.result, null);
  assert.equal(restored.round.surrenderVotes.length, 2);
});

test('undo requests and approvals survive restart, and failed writes change neither votes nor the board', async t => {
  const saved = await service(t);
  const people = await four(saved.request);
  await readyAndStart(saved.request, people);
  await action(saved.request, people[0], 'claim_hako');
  const claimed = await state(saved.request, people[0]);
  const beforeFile = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await requestUndo(saved.request, people[0], claimed)).status, 503);
    assert.deepEqual(await state(saved.request, people[0]), claimed);
    assert.equal(await readFile(saved.dataFile, 'utf8'), beforeFile);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const proposed = await requestUndo(saved.request, people[0], claimed);
  assert.equal(proposed.status, 200);
  const pending = proposed.body.undo.pending;
  await saved.restart();
  const resumed = await state(saved.request, people[0]);
  assert.deepEqual(resumed.undo.pending, pending);
  const disk = await readFile(saved.dataFile, 'utf8');
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    assert.equal((await action(saved.request, people[1], 'undo_respond', { requestId: pending.id, accept: true })).status, 503);
    assert.deepEqual((await state(saved.request, people[0])).undo.pending, pending);
    assert.equal(await readFile(saved.dataFile, 'utf8'), disk);
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  await consent(saved.request, people, pending);
  const restored = await state(saved.request, people[0]);
  assert.equal(restored.phase, 'hako_selection');
  assert.equal(restored.players.every(player => player.role === 'visitor'), true);
  await saved.restart();
  assert.equal((await state(saved.request, people[0])).phase, 'hako_selection');
  assert.equal((await action(saved.request, { ...people[0], token: people[1].token }, 'claim_hako')).status, 403);
});

test('seat changes clear history, and old saves without history remain recoverable', async t => {
  const saved = await service(t);
  const host = (await saved.request('/api/rooms', { name: '原房主' })).body;
  await action(saved.request, host, 'ready', { ready: true });
  assert.equal((await state(saved.request, host)).undo.available, true);
  const joined = await saved.request(`/api/rooms/${host.roomCode}/join`, { name: '新玩家' });
  assert.equal(joined.status, 201);
  assert.equal((await state(saved.request, host)).undo.available, false);
  await action(saved.request, host, 'ready', { ready: true });
  await action(saved.request, joined.body, 'leave');
  assert.equal((await state(saved.request, host)).undo.available, false);
  await saved.close();
  const disk = JSON.parse(await readFile(saved.dataFile, 'utf8'));
  for (const room of disk.rooms) for (const key of Object.keys(room)) {
    if (/undo/i.test(key)) delete room[key];
  }
  await writeFile(saved.dataFile, JSON.stringify(disk));
  await saved.restart();
  assert.equal((await state(saved.request, host)).undo.available, false);
  assert.equal((await action(saved.request, host, 'ready', { ready: false })).status, 200);
});

test('one human can undo a bot step without a vote and bots stay paused until the host resumes', async t => {
  const { request } = await service(t, { botDelayMs: 200 });
  const host = (await request('/api/rooms', { name: '真人' })).body;
  await state(request, host, true);
  assert.equal((await action(request, host, 'add_bots')).status, 200);
  await action(request, host, 'ready', { ready: true });
  await action(request, host, 'start');
  await action(request, host, 'claim_hako');
  const chosen = await waitState(request, host, value => value.initialItems.length === 1);
  const undone = await requestUndo(request, host, chosen);
  assert.equal(undone.status, 200);
  assert.equal(undone.body.undo.pending, null);
  assert.equal(undone.body.initialItems.length, 0);
  assert.equal(undone.body.undo.paused, true);
  assert.equal(undone.body.undo.canResume, true);
  await delay(450);
  assert.equal((await state(request, host)).version, undone.body.version, 'A scheduled bot must not immediately replay an undone step');
  const resumed = await action(request, host, 'undo_resume');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.undo.paused, false);
  assert.ok((await waitState(request, host, value => value.initialItems.length >= 1)).version > resumed.body.version);
});
