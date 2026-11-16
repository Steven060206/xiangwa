import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView, normalizePlayForRules } from '../src/play.mjs';
import { revealWithEffects } from '../src/noise-effects.mjs';
import { createGameServer } from '../src/server.mjs';

const hako = 'hako';
const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const piece = (id, type, rest = {}) => ({ id, type, ...rest });

function fixture(visitorIds = visitors) {
  const setup = createSetup(visitorIds, { deck: ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'] });
  for (const [floor, x, y, rotation] of [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ]) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  const opening = createOpening(setup, { hakoId: hako,
    itemChoices: visitorIds.map((playerId, index) => ({ playerId, itemId: INITIAL_ITEMS[index].id })) });
  chooseSecrets(opening, hako, { password: [1, 3, 5], weakness: 'gasoline' });
  placeRemains(opening, hako, 'hall_clock');
  inspectInitialRoom(opening, hako, 'children_room');
  chooseInitialHiding(opening, hako, 'children_bed');
  opening.initialPowerCandidates = [1, 4, 11];
  chooseInitialPower(opening, hako, 1);
  return createPlay(setup, opening, { numbers: [5, 4, 2, 0, 1, 3] });
}
function beforeOverflow(play = fixture()) {
  play.round.silent.cards.forEach((card, index) => { card.status = index < 2 ? 'up' : 'down'; });
  play.round.silent.total = 9;
  return play;
}
function act(play, id, action) {
  const before = structuredClone(play);
  const result = applyPlayAction(play, id, action);
  assert.deepEqual(play, before, 'the original state must remain detached');
  return result;
}
function legacyRevealed(play, action = { type: 'silent_reveal', index: 2 }) {
  const legacy = structuredClone(play);
  revealWithEffects(legacy, first, action);
  return legacy;
}
function dueGroup(play) {
  play.round.visitors[0].roomId = 'children_room';
  play.round.visitors[1].roomId = 'children_room';
  play.powers.pendingBehindYou = { cycle: play.round.silent.cycle };
  play.inventories[first].items.push(structuredClone(INITIAL_ITEMS.find(item => item.id === 'relic_ring')));
  return play;
}

test('empty overflow confirmation merges into the reveal with the same complete decision-boundary state', () => {
  for (const visitorIds of [visitors, [...visitors, 'visitor-d']]) {
    for (const othersHaveExtinguisher of [false, true]) {
      const play = beforeOverflow(fixture(visitorIds));
      if (othersHaveExtinguisher) for (const id of visitorIds.slice(1)) {
        play.inventories[id].tokens.push(piece(`other-${id}`, 'extinguisher'));
      }
      const legacy = act(legacyRevealed(play), hako, { type: 'pass_noise_reaction' });
      const next = act(play, first, { type: 'silent_reveal', index: 2 });
      assert.deepEqual(next, legacy, 'board, inventory, card order, powers, phase and victory must match the former two actions');
      assert.equal(next.round.silent.phase, 'hako_phase');
      assert.equal(next.powers.step, 'preparation');
      assert.equal(next.totalRounds, 1);
      assert.equal(next.interruption, null);
      assert.throws(() => applyPlayAction(next, hako, { type: 'pass_noise_reaction' }));
      assert.throws(() => applyPlayAction(next, first, { type: 'extinguisher_response', use: true }));
      const after = act(next, hako, { type: 'begin_hako_action' });
      assert.equal(after.totalRounds, 1, 'the next decision must not initialize the stage twice');
      assert.equal(after.round.silent.cycle, 1);
    }
  }
});

test('an eligible flipper retains the exclusive window; explicit decline merges only its empty continuation', () => {
  let play = beforeOverflow();
  for (const id of visitors) play.inventories[id].tokens.push(piece(`held-${id}`, 'extinguisher'));
  play = act(play, first, { type: 'silent_reveal', index: 2 });
  assert.equal(play.round.silent.phase, 'hako_reaction');
  assert.equal(play.totalRounds, 0);
  assert.deepEqual(play.interruption, { kind: 'noise', responders: [first], passed: [] });
  for (const id of [hako, second, third]) {
    assert.throws(() => applyPlayAction(play, id, { type: 'extinguisher_response', use: false }));
    assert.throws(() => applyPlayAction(play, id, { type: 'pass_noise_reaction' }));
  }
  const legacy = structuredClone(play);
  legacy.interruption = null;
  legacy.powers.noiseRespondedCycle = legacy.round.silent.cycle;
  const expected = act(legacy, hako, { type: 'pass_noise_reaction' });
  const declined = act(JSON.parse(JSON.stringify(play)), first, { type: 'extinguisher_response', use: false });
  assert.deepEqual(declined, expected);
  assert.equal(declined.round.silent.phase, 'hako_phase');
  assert.ok(declined.inventories[first].tokens.some(token => token.id === `held-${first}`));
  assert.throws(() => applyPlayAction(declined, first, { type: 'extinguisher_response', use: true }));
});

test('automatic overflow settles due grouped deaths before mandatory empty and relic-ring inheritance', () => {
  for (const decline of [false, true]) {
    let play = dueGroup(beforeOverflow());
    play.inventories[second] = { tokens: [], items: [] };
    if (decline) play.inventories[first].tokens.push(piece('declined', 'extinguisher'));
    const legacy = legacyRevealed(play);
    if (decline) legacy.powers.noiseRespondedCycle = legacy.round.silent.cycle;
    const expected = act(legacy, hako, { type: 'pass_noise_reaction' });
    play = act(play, first, { type: 'silent_reveal', index: 2 });
    if (decline) play = act(play, first, { type: 'extinguisher_response', use: false });
    assert.deepEqual(play, expected);
    assert.deepEqual(play.round.visitors.map(player => player.status), ['box_person', 'box_person', 'alive']);
    assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: first });
    assert.deepEqual(play.inheritanceQueue, [second]);
    assert.deepEqual(play.ringAllies, [first]);
    assert.equal(play.round.silent.resumePlayerId, third);
    assert.equal(play.totalRounds, 1);
    assert.equal(play.powers.pendingBehindYou, null);
    assert.throws(() => applyPlayAction(play, hako, { type: 'begin_hako_action' }));
    play = act(play, first, { type: 'bequeath', targetId: third });
    assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: second }, 'empty inventory still requires its owner to confirm');
    play = act(play, second, { type: 'bequeath', targetId: third });
    assert.equal(play.resolution, null);
    assert.equal(play.totalRounds, 1);
    assert.equal(play.ghosts.length, 2, 'settled deaths cannot run again after inheritance');
  }
});

test('due total death ends automatic overflow without creating a next turn or inheritance', () => {
  let play = dueGroup(beforeOverflow());
  play.round.visitors[2].roomId = 'children_room';
  play = act(play, first, { type: 'silent_reveal', index: 2 });
  assert.equal(play.result.winner, 'hako');
  assert.equal(play.resolution, null);
  assert.deepEqual(play.inheritanceQueue, []);
  assert.equal(play.round.silent.cycle, 1);
  assert.equal(play.round.silent.turnPlayerId, null);
  assert.equal(play.totalRounds, 1);
  assert.throws(() => applyPlayAction(play, hako, { type: 'begin_hako_action' }));
});

test('NO.8 and bell overflow still stop on the exact revealed card without carrying a reveal debt', () => {
  for (const mary of [false, true]) for (const useBell of [false, true]) {
    const play = beforeOverflow();
    if (mary) {
      play.inventories[first].tokens.push(piece('mary-doll', 'doll'));
      play.noiseEffects = { mary: { playerId: first, card: { id: 8, ignoreThreshold: true }, deferredCycle: 0, deferredTurn: -1 } };
    }
    if (useBell) play.inventories[first].items.push(structuredClone(INITIAL_ITEMS.find(item => item.id === 'shrine_bell')));
    const reveal = { type: 'silent_reveal', index: 2, useBell };
    const expected = act(legacyRevealed(play, reveal), hako, { type: 'pass_noise_reaction' });
    const next = act(play, first, reveal);
    assert.deepEqual(next, expected);
    assert.equal(next.round.silent.phase, 'hako_phase');
    assert.equal(next.round.silent.cards.filter(card => card.status === 'up').length, 3);
    assert.equal(next.round.silent.revealsRemaining, 0);
    assert.equal(next.noiseEffects?.bellIntent ?? null, null);
    assert.equal(next.noiseEffects?.bellReady ?? null, null);
  }
});

test('exact ten, last-down-card action ordering and held cards keep their original decisions', () => {
  let exact = beforeOverflow();
  [exact.round.silent.cards[2].number, exact.round.silent.cards[4].number] = [1, 2];
  exact = act(exact, first, { type: 'silent_reveal', index: 2 });
  assert.equal(exact.round.silent.total, 10);
  assert.equal(exact.round.silent.phase, 'visitor_action');
  assert.equal(exact.totalRounds, 0);
  let last = fixture();
  last.round.silent.cards = [0, 1, 2, 3, 4, 5].map((number, index) => ({ index, number, status: index < 4 ? 'up' : 'down' }));
  last.round.silent.total = 6;
  last = act(last, first, { type: 'silent_reveal', index: 4 });
  assert.equal(last.round.silent.phase, 'visitor_action');
  assert.equal(last.totalRounds, 0);
  last = act(last, first, { type: 'move', roomId: getPlayView(last, first).moveTargets[0] });
  assert.equal(last.round.silent.phase, 'visitor_action');
  last = act(last, hako, { type: 'resolve_visitor_action' });
  assert.equal(last.round.silent.phase, 'hako_phase');
  assert.equal(last.round.silent.trigger, 'one_hidden');
  assert.equal(last.totalRounds, 1);
  const held = act(fixture(), first, { type: 'silent_skip', index: 0 });
  assert.equal(held.round.silent.phase, 'visitor_reveal');
  assert.equal(held.round.silent.turnPlayerId, second);
  assert.equal(held.round.silent.cards[0].holderId, first);
});

test('view generation and normalization never advance old empty or already-declined overflow saves', () => {
  for (const declined of [false, true]) {
    const play = legacyRevealed(dueGroup(beforeOverflow()));
    if (declined) {
      play.inventories[first].tokens.push(piece('legacy-declined', 'extinguisher'));
      play.powers.noiseRespondedCycle = play.round.silent.cycle;
    }
    const before = structuredClone(play);
    for (const id of [hako, ...visitors]) {
      const view = getPlayView(play, id);
      assert.equal(view.phase, 'hako_reaction');
      assert.equal(view.interruption, null);
    }
    normalizePlayForRules(play);
    assert.deepEqual(play, before);
    const continued = act(play, hako, { type: 'pass_noise_reaction' });
    assert.equal(continued.totalRounds, 1);
    assert.equal(continued.resolution.kind, 'inheritance');
  }
});

async function savedService(t, play) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-overflow-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const dataFile = join(directory, 'rooms.json');
  const ids = [hako, ...play.round.visitors.map(player => player.id)];
  const room = { code: 'ABCDEF', playerCount: ids.length, hostId: hako, version: 7, log: [],
    players: ids.map((id, seat) => ({ id, seat, name: id, token: `test-token-${id}`, ready: true, role: id === hako ? 'hako' : 'visitor' })),
    selectingHako: false, game: null, opening: null, draft: null, play, undoHistory: [], undoPending: null, undoPaused: false };
  await writeFile(dataFile, JSON.stringify({ format: 1, rooms: [room] }));
  let server, base;
  async function close() {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async function restart() {
    await close();
    server = createGameServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await restart();
  async function request(id, input, poll = false) {
    const credentials = { playerId: id, token: `test-token-${id}` };
    const response = await fetch(`${base}/api/rooms/ABCDEF${input ? '/actions' : `?${new URLSearchParams({ ...credentials, ...(poll ? { poll: '1' } : {}) })}`}`, {
      ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...credentials, ...input }) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { dataFile, restart, request };
}

test('automatic due deaths save as one version and undo checkpoint, with rollback, concurrency, restart and voting', async t => {
  const play = dueGroup(beforeOverflow());
  const { dataFile, restart, request } = await savedService(t, play);
  const initialBytes = await readFile(dataFile, 'utf8');
  const initial = (await request(first)).body;
  assert.equal(initial.round.phase, 'visitor_reveal');
  assert.equal(await readFile(dataFile, 'utf8'), initialBytes, 'startup and GET must not settle a due effect');
  const input = { type: 'silent_reveal', index: 2, expectedVersion: initial.version };
  await mkdir(`${dataFile}.tmp`);
  try {
    const failed = await request(first, input);
    assert.equal(failed.status, 503);
    assert.deepEqual((await request(first)).body, initial);
    assert.equal(await readFile(dataFile, 'utf8'), initialBytes, 'failed saving must preserve history, phase, deaths and inventory');
  } finally { await rm(`${dataFile}.tmp`, { recursive: true }); }
  const concurrent = await Promise.all([request(first, input), request(first, input)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const accepted = concurrent.find(result => result.status === 200).body;
  assert.equal(accepted.version, initial.version + 1);
  assert.equal(accepted.round.phase, 'visitor_resolution');
  assert.equal(accepted.round.resolution.kind, 'inheritance');
  let disk = JSON.parse(await readFile(dataFile, 'utf8')).rooms[0];
  assert.equal(disk.undoHistory.length, 1);
  assert.equal(disk.undoHistory[0].type, 'silent_reveal');
  assert.equal(disk.undoHistory[0].direct, false, 'automatic progression cannot relax voting classification');
  assert.deepEqual(disk.undoHistory[0].before.play, play);
  assert.equal(disk.play.totalRounds, 1);
  assert.deepEqual(disk.play.inheritanceQueue, [second]);
  assert.equal(disk.play.powers.pendingBehindYou, null);
  await restart();
  assert.deepEqual((await request(first)).body, accepted);
  const afterRestartBytes = await readFile(dataFile, 'utf8');
  for (const id of [hako, ...visitors]) {
    const view = (await request(id, undefined, true)).body;
    if (id === third) {
      assert.equal(view.round.resolution.kind, 'waiting');
      assert.equal(Object.hasOwn(view.round.powers, 'hand'), false);
    }
  }
  assert.equal(await readFile(dataFile, 'utf8'), afterRestartBytes, 'polling cannot write or rerun the stage');
  let vote = await request(third, { type: 'undo_request', version: accepted.version });
  assert.equal(vote.status, 200);
  const pending = vote.body.undo.pending;
  assert.ok(pending);
  assert.doesNotMatch(pending.label, /NO\.5|children_bed|relic_ring/);
  for (const id of pending.requiredIds.filter(id => id !== third)) {
    vote = await request(id, { type: 'undo_respond', requestId: pending.id, accept: true });
    assert.equal(vote.status, 200);
  }
  disk = JSON.parse(await readFile(dataFile, 'utf8')).rooms[0];
  assert.deepEqual(disk.play, play, 'one undo restores numbers, due effect, deaths, inventory and inheritance together');
  assert.equal(disk.undoHistory.length, 0);
  const retry = await request(first, { ...input, expectedVersion: vote.body.version });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.version, vote.body.version + 1);
  assert.equal(retry.body.round.resolution.kind, 'inheritance');
  const finalBytes = await readFile(dataFile, 'utf8');
  assert.equal((await request(hako, { type: 'pass_noise_reaction', expectedVersion: accepted.version })).status, 409);
  assert.equal(await readFile(dataFile, 'utf8'), finalBytes, 'delayed legacy confirmation cannot advance a second time');
});
