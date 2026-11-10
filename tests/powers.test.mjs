import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { getTile } from '../src/maps.mjs';
import { getRoom, getMoveTargets, getHidingTargets } from '../src/movement.mjs';
import { INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView, normalizePlayForRules } from '../src/play.mjs';
import { createPowers, powerCard, powerHidingTargets } from '../src/powers.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hakoId = 'hako';
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
  const opening = createOpening(setup, { hakoId,
    itemChoices: visitorIds.map((playerId, index) => ({ playerId, itemId: INITIAL_ITEMS[index].id })) });
  chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  placeRemains(opening, hakoId, 'hall_clock');
  inspectInitialRoom(opening, hakoId, 'children_room');
  chooseInitialHiding(opening, hakoId, 'children_bed');
  opening.initialPowerCandidates = [1, 4, 11];
  chooseInitialPower(opening, hakoId, 1);
  return createPlay(setup, opening, { numbers: [0, 1, 2, 3, 4, 5] });
}
function act(play, id, action) {
  const before = JSON.stringify(play);
  const next = applyPlayAction(play, id, action);
  assert.equal(JSON.stringify(play), before, 'action mutated the original state');
  return next;
}
function reject(play, id, action) {
  const before = JSON.stringify(play);
  assert.throws(() => applyPlayAction(play, id, action), /[\u4e00-\u9fff]/);
  assert.equal(JSON.stringify(play), before, 'illegal action changed the original state');
}
function stage(play, triggerId = play.round.silent.visitorIds[0]) {
  Object.assign(play.round.silent, { phase: 'hako_reaction', turnPlayerId: null,
    resumePlayerId: triggerId, trigger: 'overflow', total: 11 });
  play.round.silent.cards.forEach(card => {
    card.status = [2, 4, 5].includes(card.number) ? 'up' : 'down';
    delete card.holderId;
  });
  play.powers.noiseRespondedCycle = play.round.silent.cycle;
  return act(play, hakoId, { type: 'pass_noise_reaction' });
}
function begin(play) { return act(play, hakoId, { type: 'begin_hako_action' }); }
function givePower(play, id, { slot = null, ignoreThreshold = false } = {}) {
  play.powers.deck = play.powers.deck.filter(cardId => cardId !== id);
  play.powers.hand = play.powers.hand.filter(card => card.id !== id);
  const card = { id, ignoreThreshold };
  if (slot === null) play.powers.hand.push(card);
  else play.powers.slots[slot] = { ...card, faceUp: false };
}
function notes(play, count) {
  play.notebooks = Array.from({ length: count }, (_, index) => piece(`public-note-${index + 1}`, 'notebook', { number: index + 1 }));
}
function reveal(play, id = first) {
  return act(play, id, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.status === 'down') });
}
function finishStage(play) {
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  return act(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
}
function ghost(play, id, cornerId) {
  const visitor = play.round.visitors.find(player => player.id === id);
  visitor.status = 'box_person';
  delete visitor.roomId;
  play.round.silent.visitorIds = play.round.silent.visitorIds.filter(playerId => playerId !== id);
  play.ghosts.push({ playerId: id, cornerId, banished: false, carriedTokens: [] });
}

test('cry draws the top card only, returns a locked card to the bottom and never exposes the draw', () => {
  let play = fixture();
  play.powers.deck = [2, 3, 'despair'];
  reject(play, hakoId, { type: 'hako_cry' });
  play = stage(play);
  reject(play, first, { type: 'hako_cry' });
  reject(play, hakoId, { type: 'hako_cry', roomId: 'hall_room' });
  play = act(play, hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.deck, [3, 'despair', 2]);
  assert.deepEqual(play.powers.hand.map(card => card.id), [1, 11]);
  assert.deepEqual(getPlayView(play, first).powers.announcement, { roomId: 'children_room', cycle: 1 });
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'lastDraw'), false);
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'hand'), false);
  assert.deepEqual(getPlayView(play, hakoId).powers.lastDraw, { kind: 'returned', cards: [2] });
  reject(play, hakoId, { type: 'hako_cry' });
  play = begin(play);
  play = finishStage(play);
  assert.deepEqual(getPlayView(play, first).powers.announcement, { roomId: 'children_room', cycle: 1 });
  reject(play, hakoId, { type: 'hako_cry' });
  play = stage(play);
  assert.equal(getPlayView(play, first).powers.announcement, null);
  assert.equal(getPlayView(play, hakoId).powers.canCry, true);
});

test('public matching notebooks enter the hand without granting other exemptions', () => {
  for (const id of [2, 3, 4]) {
    let play = fixture();
    play.powers.deck = [id, 5];
    play.notebooks.push(piece(`note-${id}`, 'notebook', { number: id }));
    play = act(stage(play), hakoId, { type: 'hako_cry' });
    assert.deepEqual(play.powers.hand.find(card => card.id === id), { id, ignoreThreshold: false });
    assert.deepEqual(play.powers.deck, [5]);
    if (id === 4) {
      play = act(play, hakoId, { type: 'set_power', powerId: 4, slot: 0 });
      assert.equal(play.powers.slots[0].id, 4, 'Only the initial choice is forbidden; NO.4 can be acquired and set normally');
    }
  }
});

test('despair returns itself to the bottom, grants up to two distinct cards with notebook exemptions and preserves single-use restrictions', () => {
  let play = fixture();
  play.powers.deck = ['despair', 10, 3, 2];
  play.powers.cryCount = 9;
  play = act(stage(play), hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.deck, [2, 'despair']);
  assert.deepEqual(play.powers.hand.filter(card => [10, 3].includes(card.id)), [
    { id: 10, ignoreThreshold: true }, { id: 3, ignoreThreshold: true },
  ]);
  play.powers.used.push(11);
  reject(play, hakoId, { type: 'set_power', powerId: 11, slot: 0 });
  play = act(play, hakoId, { type: 'set_power', powerId: 10, slot: 0 });
  play.powers.used.push(10);
  play.round.silent.phase = 'visitor_action';
  play.round.silent.turnPlayerId = first;
  play.round.pendingAction = { type: 'peek', playerId: first, cornerId: 'hall_clock' };
  reject(play, hakoId, { type: 'activate_power', slot: 0 });
  let short = fixture();
  short.powers.deck = ['despair', 2];
  short.powers.cryCount = 9;
  short = act(stage(short), hakoId, { type: 'hako_cry' });
  assert.deepEqual(short.powers.deck, ['despair']);
  assert.equal(short.powers.hand.filter(card => card.id === 2).length, 1);
});

test('NO.11 is an innate card alongside the private initial choice and never remains in the deck', () => {
  const play = fixture();
  assert.deepEqual(play.powers.hand.map(card => card.id), [1, 11]);
  assert.equal(play.powers.deck.includes(11), false);
  const legacy = createPowers({ initialPowerId: 11, powerDeck: [1, 2, 11, 'despair'] });
  assert.deepEqual(legacy.hand.map(card => card.id), [11]);
  assert.deepEqual(legacy.deck, [1, 2, 'despair']);
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'hand'), false);
});

test('legacy games gain innate NO.11 without read-side mutation, duplication, or resetting its use limit', () => {
  let play = fixture();
  play.powers.hand = play.powers.hand.filter(card => card.id !== 11);
  play.powers.deck.unshift(11);
  delete play.powers.cryCount;
  const before = structuredClone(play);
  const view = getPlayView(play, hakoId).powers;
  assert.equal(view.hand.filter(card => card.id === 11).length, 1);
  assert.equal(view.cryCount, 0);
  assert.deepEqual(play, before);
  play = stage(play);
  play = act(play, hakoId, { type: 'set_power', powerId: 11, slot: 0 });
  assert.equal(play.powers.deck.includes(11), false);
  assert.equal(play.powers.hand.some(card => card.id === 11), false);
  assert.equal(getPlayView(play, hakoId).powers.hand.some(card => card.id === 11), false);
  play.powers.used.push(11);
  play.powers.hand.push({ id: 11, ignoreThreshold: true });
  assert.equal(getPlayView(play, hakoId).powers.hand.some(card => card.id === 11), false);
});

test('bottom-deck despair appears on the tenth actual cry after skipped stages and survives save restoration', () => {
  let play = fixture();
  play.powers.deck = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'despair'];
  play.notebooks.push(piece('known-note-two', 'notebook', { number: 2 }));
  for (let count = 0; count < 3; count++) play = stage(finishStage(begin(stage(play))));
  assert.equal(play.powers.cryCount, 0);
  for (let count = 1; count <= 9; count++) {
    play = act(play, hakoId, { type: 'hako_cry' });
    assert.equal(play.powers.cryCount, count);
    assert.notEqual(play.powers.lastDraw.kind, 'despair');
    play = stage(finishStage(begin(play)));
  }
  assert.equal(play.powers.deck[0], 'despair', 'Acquiring an ordinary card does not advance the initial despair draw');
  play = JSON.parse(JSON.stringify(play));
  play = act(play, hakoId, { type: 'hako_cry' });
  assert.equal(play.powers.cryCount, 10);
  assert.deepEqual(play.powers.lastDraw, { kind: 'despair', cards: [3, 4] });
  assert.deepEqual(play.powers.deck, [5, 6, 7, 8, 9, 10, 'despair']);
  assert.equal(play.powers.hand.find(card => card.id === 3).ignoreThreshold, true);
  reject(play, hakoId, { type: 'hako_cry' });
  assert.equal(play.powers.cryCount, 10);
});

test('legacy early despair returns to the bottom without granting cards or substituting rounds for cries', () => {
  let play = fixture();
  play.round.silent.cycle = 10;
  play.powers.deck = [2, 'despair', 3];
  play = act(stage(play), hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.lastDraw, { kind: 'returned', cards: [2] });
  assert.equal(play.powers.cryCount, 1);
  play = act(stage(finishStage(begin(play))), hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.lastDraw, { kind: 'despair_locked', cards: [] });
  assert.deepEqual(play.powers.deck, [3, 2, 'despair']);
  assert.deepEqual(play.powers.hand.map(card => card.id), [1, 11]);
  assert.equal(play.powers.cryCount, 2);
});

test('a real nightmare-letter action delays despair beyond ten cries and later draws repeat its effect', () => {
  let play = fixture();
  play.powers.deck = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'despair'];
  play.inventories[first].items = [{ ...INITIAL_ITEMS.find(item => item.id === 'nightmare_letter') }];
  for (let count = 0; count < 9; count++) {
    play = act(stage(play), hakoId, { type: 'hako_cry' });
    play = finishStage(begin(play));
  }
  assert.equal(play.powers.deck[0], 'despair');
  play = reveal(play);
  play = act(play, first, { type: 'use_item', itemId: 'nightmare_letter' });
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(play.powers.deck.at(-1), 'despair');
  for (let count = 10; count <= 18; count++) {
    play = act(stage(play), hakoId, { type: 'hako_cry' });
    assert.equal(play.powers.cryCount, count);
    assert.notEqual(play.powers.lastDraw.kind, 'despair');
    play = finishStage(begin(play));
  }
  play = act(stage(play), hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.lastDraw, { kind: 'despair', cards: [2, 3] });
  play = finishStage(begin(play));
  for (let index = 0; index < 7; index++) {
    play = act(stage(play), hakoId, { type: 'hako_cry' });
    play = finishStage(begin(play));
  }
  play = act(stage(play), hakoId, { type: 'hako_cry' });
  assert.deepEqual(play.powers.lastDraw, { kind: 'despair', cards: [4, 5] });
  assert.equal(play.powers.cryCount, 27);
});

test('setting and recalling share one management choice and later slots conceal their identities', () => {
  let play = stage(fixture());
  givePower(play, 2);
  play = act(play, hakoId, { type: 'set_power', powerId: 2, slot: 0 });
  assert.equal(play.powers.slots[0].ignoreThreshold, false);
  assert.equal(getPlayView(play, hakoId).powers.slots[0].card.id, 2);
  assert.deepEqual(getPlayView(play, first).powers.slots[0], { slot: 0, occupied: true, faceUp: false });
  reject(play, hakoId, { type: 'set_power', powerId: 1, slot: 1 });
  reject(play, hakoId, { type: 'recall_power', slot: 0 });
  reject(play, hakoId, { type: 'hako_cry' });
  play = finishStage(begin(play));
  play = stage(play);
  play = act(play, hakoId, { type: 'recall_power', slot: 0 });
  assert.equal(play.powers.slots[0], null);
  assert.equal(play.powers.hand.find(card => card.id === 2).ignoreThreshold, false);
  reject(play, hakoId, { type: 'set_power', powerId: 2, slot: 0 });
  reject(play, hakoId, { type: 'recall_power', slot: 1 });
  for (const id of [7, 8]) assert.equal(powerCard(id).supported, true);
  assert.equal(powerCard(12).supported, false);
});

test('same-floor movement includes dynamic corners, excludes other floors and cannot be activated after final inspection', () => {
  let play = fixture();
  givePower(play, 1, { slot: 0, ignoreThreshold: true });
  givePower(play, 2, { slot: 1, ignoreThreshold: true });
  play.extraCorners['suitcase:living_room'] = { id: 'suitcase:living_room', roomId: 'living_room', name: '行李箱中' };
  play.tokens['suitcase:living_room'] = piece('suitcase-empty', 'empty_box');
  play = stage(play);
  reject(play, hakoId, { type: 'activate_power', slot: 0 });
  play = act(begin(play), hakoId, { type: 'activate_power', slot: 0 });
  const targets = powerHidingTargets(play, play.round.hidingCornerId);
  for (const placement of play.round.placements.filter(placement => placement.floor === 1)) {
    for (const room of getTile(placement.tileId).rooms) for (const corner of room.corners) assert.ok(targets.includes(corner.id));
  }
  assert.ok(targets.includes('suitcase:living_room'));
  assert.equal(targets.includes('upstairs_armor'), false);
  assert.equal(targets.includes('basement_barrel'), false);
  assert.equal(getPlayView(play, first).powers.lastActivation, null);
  assert.deepEqual(getPlayView(play, hakoId).powers.lastActivation, { powerId: 1, name: '就在你身旁', cycle: 1 });
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'living_room' });
  reject(play, hakoId, { type: 'activate_power', slot: 1 });
  reject(play, hakoId, { type: 'inspect_path_room', roomId: 'study_room' });
});

test('two-room movement requires selecting its actual path without viewing its hidden tokens', () => {
  let play = fixture();
  givePower(play, 2, { slot: 0, ignoreThreshold: true });
  const origin = 'children_room';
  const near = getMoveTargets(play.round.placements, origin, { actor: 'hako' });
  const path = near.flatMap(intermediate => getMoveTargets(play.round.placements, intermediate, { actor: 'hako' })
    .filter(target => target !== origin && !near.includes(target)).map(target => ({ intermediate, target })))[0];
  assert.ok(path, 'fixture must contain a room exactly two moves away');
  const extraId = `suitcase:${path.target}`;
  play.extraCorners[extraId] = { id: extraId, roomId: path.target, name: '行李箱中' };
  play.tokens[extraId] = piece('two-hop-empty', 'empty_box');
  play.tokens[getRoom(path.intermediate).corners[0].id] = piece('private-path-token', 'password', { number: 6 });
  play = begin(stage(play));
  reject(play, hakoId, { type: 'inspect_path_room', roomId: path.intermediate });
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(powerHidingTargets(play, 'children_bed').includes(extraId), false);
  reject(play, hakoId, { type: 'inspect_hiding_room', roomId: path.target });
  play = act(play, hakoId, { type: 'inspect_path_room', roomId: path.intermediate });
  assert.deepEqual(getPlayView(play, hakoId).powers.pathInspection, { roomId: path.intermediate });
  assert.equal(JSON.stringify(getPlayView(play, hakoId).powers).includes('private-path-token'), false);
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'pathInspection'), false);
  assert.ok(powerHidingTargets(play, 'children_bed').includes(extraId));
  reject(play, hakoId, { type: 'inspect_path_room', roomId: path.intermediate });
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: path.target });
  reject(play, hakoId, { type: 'inspect_path_room', roomId: path.intermediate });
});

test('two-room power cannot be activated after the final room has already been inspected', () => {
  let play = fixture();
  givePower(play, 2, { slot: 0, ignoreThreshold: true });
  play = begin(stage(play));
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  const option = getPlayView(play, hakoId).powers.activationOptions.find(option => option.card.id === 2);
  assert.equal(option.canActivate, false);
  assert.match(option.reason, /潜伏/);
  reject(play, hakoId, { type: 'activate_power', slot: 0 });
  assert.deepEqual(getPlayView(play, hakoId).powers.pathRooms, []);
});

test('powers one through four silently empty the slot even if an old client requests publication', () => {
  for (const powerId of [1, 2, 3, 4]) for (const publicChoice of [false, true]) {
    let play = fixture();
    givePower(play, powerId, { slot: 0, ignoreThreshold: true });
    play = begin(stage(play));
    play = act(play, hakoId, { type: 'activate_power', slot: 0, public: publicChoice,
      ...(powerId === 3 ? { fromRoomId: 'hall_room', toRoomId: 'study_room' } : {}),
      ...(powerId === 4 ? { roomId: 'study_room' } : {}),
    });
    assert.equal(getPlayView(play, hakoId).powers.lastActivation.powerId, powerId);
    for (const id of visitors) {
      const view = getPlayView(play, id);
      assert.equal(view.powers.lastActivation, null);
      assert.equal(view.powers.activationNotice, null);
      assert.deepEqual(view.powers.slots[0], { slot: 0, occupied: false });
      assert.deepEqual(view.blockedDoors, []);
      assert.equal(Object.hasOwn(view.powers, 'rearrangement'), false);
    }
    if (powerId === 4) {
      assert.ok(getPlayView(play, hakoId).powers.rearrangement.corners.length);
      play = act(play, hakoId, { type: 'power_rearrange', order: play.powers.rearrangement.cornerIds });
      assert.equal(play.powers.hand.filter(card => card.id === 4).length, 1);
    }
  }
});

test('powers five through ten announce without a card identity, including legacy public flags', () => {
  for (const powerId of [5, 6, 7, 8, 10]) {
    let play = fixture();
    givePower(play, powerId, { slot: 0, ignoreThreshold: true });
    play.inventories[first].tokens.push(piece('test-doll', 'doll'));
    if (powerId === 5) play = begin(stage(play));
    else {
      play = reveal(play);
      play = act(play, first, { type: 'move', roomId: 'study_room' });
    }
    play = act(play, hakoId, { type: 'activate_power', slot: 0, public: true,
      ...(powerId === 7 ? { stealKind: 'item', itemIndex: 0 } : {}),
    });
    // Simulate records already persisted by older clients and servers.
    play.powers.lastActivation.public = true;
    if (play.powers.slots[0]) Object.assign(play.powers.slots[0], { faceUp: true, public: true });
    play = JSON.parse(JSON.stringify(play));
    for (const id of visitors) {
      const powers = getPlayView(play, id).powers;
      assert.equal(powers.lastActivation, null);
      assert.deepEqual(powers.activationNotice, { serial: 1, cycle: 1 });
      assert.equal(powers.slots[0].card, undefined);
      assert.equal(powers.pendingBehindYou, null);
      assert.equal(JSON.stringify(powers).includes(powerCard(powerId).name), false);
    }
    assert.equal(getPlayView(play, hakoId).powers.lastActivation.powerId, powerId);
  }
});

test('ghosts stacked at hako do not inherit hako movement abilities', () => {
  let play = fixture();
  ghost(play, second, 'children_bed');
  givePower(play, 1, { slot: 0, ignoreThreshold: true });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  const ordinary = getHidingTargets(play.round.placements, 'children_bed');
  assert.deepEqual(powerHidingTargets(play, 'children_bed', second), ordinary);
  assert.ok(powerHidingTargets(play, 'children_bed', hakoId).length > ordinary.length);
  reject(play, second, { type: 'activate_power', slot: 0 });
});

test('door locking rejects stairs, expires next stage and cannot be used in the following stage', () => {
  let play = fixture();
  givePower(play, 3);
  play = stage(play);
  play = act(play, hakoId, { type: 'set_power', powerId: 3, slot: 0 });
  play = begin(play);
  const doors = getPlayView(play, hakoId).powers.activationOptions.find(option => option.card.id === 3).doors;
  assert.equal(doors.some(door => door.fromRoomId === door.toRoomId), false);
  assert.equal(doors.some(door => [door.fromRoomId, door.toRoomId].includes('dark_room')), false);
  reject(play, hakoId, { type: 'activate_power', slot: 0, fromRoomId: 'study_room', toRoomId: 'dark_room' });
  reject(play, hakoId, { type: 'activate_power', slot: 0, fromRoomId: 'hall_room', toRoomId: 'upstairs_hall' });
  play = act(play, hakoId, { type: 'activate_power', slot: 0, fromRoomId: 'hall_room', toRoomId: 'study_room' });
  assert.ok(play.round.blockedDoors.some(door => [door.from, door.to].includes('hall_room')));
  play = finishStage(play);
  play = stage(play);
  assert.deepEqual(play.round.blockedDoors, []);
  play = act(play, hakoId, { type: 'set_power', powerId: 3, slot: 0 });
  play = begin(play);
  reject(play, hakoId, { type: 'activate_power', slot: 0, fromRoomId: 'hall_room', toRoomId: 'study_room' });
  play = finishStage(play);
  play = begin(stage(play));
  play = act(play, hakoId, { type: 'activate_power', slot: 0, fromRoomId: 'study_room', toRoomId: 'hall_room' });
  assert.equal(play.round.blockedDoors.length, 1);
});

test('rearrangement conserves free tokens and never exposes or moves originals covered by actors', () => {
  let play = fixture();
  givePower(play, 4, { slot: 0 });
  play.tokens.children_cabinet = piece('rearrange-empty', 'empty_box', { faceUp: true });
  play.tokens.children_toys = piece('rearrange-weapon', 'weapon', { tool: 'white_stick' });
  play.tokens.children_bed = piece('covered-secret-base', 'password', { number: 6 });
  play = begin(stage(play));
  const publicBefore = getPlayView(play, first).cornerState;
  const tokensBefore = Object.values(play.tokens).filter(Boolean).map(token => token.id).sort();
  play = act(play, hakoId, { type: 'activate_power', slot: 0, roomId: 'children_room' });
  assert.deepEqual(getPlayView(play, hakoId).powers.rearrangement.corners.map(corner => corner.id), ['children_cabinet', 'children_toys']);
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'rearrangement'), false);
  assert.equal(JSON.stringify(getPlayView(play, first)).includes('covered-secret-base'), false);
  reject(play, hakoId, { type: 'power_rearrange', order: ['children_bed', 'children_cabinet'] });
  reject(play, hakoId, { type: 'power_rearrange', order: ['children_toys', 'children_toys'] });
  reject(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  play = act(play, hakoId, { type: 'power_rearrange', order: ['children_toys', 'children_cabinet'], faceDownCornerIds: ['children_toys'] });
  assert.equal(play.tokens.children_cabinet.id, 'rearrange-weapon');
  assert.equal(play.tokens.children_toys.id, 'rearrange-empty');
  assert.equal(play.tokens.children_toys.faceUp, false);
  assert.equal(play.tokens.children_bed.id, 'covered-secret-base');
  assert.equal(play.round.hidingCornerId, 'children_bed');
  assert.deepEqual(Object.values(play.tokens).filter(Boolean).map(token => token.id).sort(), tokensBefore);
  assert.deepEqual(getPlayView(play, first).cornerState, publicBefore);
});

test('rearrangement targets one whole map board including its subrooms and old suitcase room aliases', () => {
  let play = fixture();
  givePower(play, 4, { slot: 0 });
  play.extraCorners['suitcase:dark_room'] = { id: 'suitcase:dark_room', roomId: 'dark_room', name: '行李箱中' };
  play.tokens['suitcase:dark_room'] = piece('board-suitcase', 'empty_box');
  play = begin(stage(play));
  const options = getPlayView(play, hakoId).powers.activationOptions.find(option => option.card.id === 4);
  assert.equal(options.rooms.length, 9);
  assert.equal(options.rooms.some(room => room.id === 'dark_room'), false);
  assert.ok(options.rooms.some(room => room.id === 'study_room' && room.name.includes('深色房间')));
  play = act(play, hakoId, { type: 'activate_power', slot: 0, roomId: 'dark_room' });
  const pending = getPlayView(play, hakoId).powers.rearrangement;
  assert.equal(pending.roomId, 'study_room');
  assert.deepEqual(pending.corners.map(corner => corner.id).sort(), [
    'study_books', 'study_desk', 'dark_wardrobe', 'dark_bed', 'suitcase:dark_room',
  ].sort());
  assert.ok(pending.corners.every(corner => Object.hasOwn(corner, 'token')));
  const before = pending.corners.map(corner => corner.token?.id ?? null).sort();
  play = act(play, hakoId, { type: 'power_rearrange', order: pending.corners.map(corner => corner.id).reverse() });
  assert.deepEqual(pending.corners.map(corner => play.tokens[corner.id]?.id ?? null).sort(), before);
});

test('legacy NO.4 saves return the old occupied slot once and keep private rearrangement usable', () => {
  for (const legacySlot of ['four', 'empty', 'other']) {
    let play = fixture();
    givePower(play, 4, { slot: 0 });
    play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0, roomId: 'study_room' });
    play.powers.rearrangement.slot = 0;
    if (legacySlot === 'four') {
      play.powers.slots[0] = { ...play.powers.hand.find(card => card.id === 4), faceUp: true, public: true };
      play.powers.hand = play.powers.hand.filter(card => card.id !== 4);
    } else if (legacySlot === 'other') {
      givePower(play, 3, { slot: 0 });
    }
    play.powers.lastActivation.public = true;
    play = JSON.parse(JSON.stringify(play));
    const before = JSON.stringify(play);
    const privateView = getPlayView(play, hakoId).powers;
    assert.equal(privateView.hand.filter(card => card.id === 4).length, 1);
    assert.equal(privateView.slots[0].occupied, legacySlot === 'other');
    for (const id of visitors) {
      const view = getPlayView(play, id).powers;
      assert.equal(view.slots[0].occupied, legacySlot === 'other');
      assert.equal(view.lastActivation, null);
      assert.equal(view.activationNotice, null);
      assert.equal(Object.hasOwn(view, 'rearrangement'), false);
    }
    assert.equal(JSON.stringify(play), before, 'Legacy view filtering cannot write to the save');
    const restored = structuredClone(play);
    normalizePlayForRules(restored);
    const normalized = JSON.stringify(restored);
    normalizePlayForRules(restored);
    assert.equal(JSON.stringify(restored), normalized, 'Repeated restore cannot return the card twice');
    assert.equal(Object.hasOwn(restored.powers.rearrangement, 'slot'), false);
    reject(play, hakoId, { type: 'power_rearrange', order: [] });
    const order = [...play.powers.rearrangement.cornerIds].reverse();
    play = act(play, hakoId, { type: 'power_rearrange', order });
    assert.equal(play.powers.rearrangement, null);
    assert.equal(play.powers.hand.filter(card => card.id === 4).length, 1);
    assert.equal(play.powers.slots[0]?.id ?? null, legacySlot === 'other' ? 3 : null);
  }
});

test('an anonymous activation followed by a silent power retains the same public notice', () => {
  let play = fixture();
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  givePower(play, 4, { slot: 1 });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  assert.deepEqual(getPlayView(play, first).powers.activationNotice, { serial: 1, cycle: 1 });
  play = act(play, hakoId, { type: 'activate_power', slot: 1, roomId: 'study_room', public: true });
  for (const id of visitors) {
    const view = getPlayView(play, id).powers;
    assert.deepEqual(view.activationNotice, { serial: 1, cycle: 1 });
    assert.equal(view.lastActivation, null);
    assert.equal(view.slots[0].occupied, false);
    assert.equal(view.slots[1].occupied, false);
    assert.equal(Object.hasOwn(view, 'rearrangement'), false);
  }
  assert.equal(getPlayView(play, hakoId).powers.lastActivation.powerId, 4);
});

test('same-board visitors share the behind-you effect across printed subroom boundaries', () => {
  let play = fixture();
  play.round.hidingCornerId = 'dark_bed';
  play.round.visitors[0].roomId = 'study_room';
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.round.visitors[0].status, 'alive');
  assert.deepEqual(play.powers.pendingBehindYou, { cycle: 2 });
  play.round.silent.cycle++;
  play = stage(play);
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(play.powers.pendingBehindYou, null);
});

test('behind-you uses six notebooks for hako and eight for box-person rooms', () => {
  for (const count of [6, 8]) {
    let play = fixture();
    ghost(play, second, 'hall_clock');
    play.round.visitors[0].roomId = 'children_room';
    play.round.visitors[2].roomId = 'hall_room';
    notes(play, count);
    givePower(play, 5, { slot: 0 });
    play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
    assert.equal(play.round.visitors[0].status, 'alive');
    assert.equal(play.round.visitors[2].status, 'alive');
    play.round.silent.cycle++;
    play = stage(play);
    assert.equal(play.round.visitors[0].status, 'box_person');
    assert.equal(play.round.visitors[2].status, count === 8 ? 'box_person' : 'alive');
    if (count === 8) assert.equal(play.ghosts.find(actor => actor.playerId === third).cornerId, 'hall_clock');
  }
});

test('behind-you settles once using next-stage positions and notebooks before any new hiding action', () => {
  let play = fixture();
  ghost(play, second, 'hall_clock');
  play.round.visitors[0].roomId = 'children_room';
  play.round.visitors[2].roomId = 'hall_room';
  notes(play, 6);
  givePower(play, 5, { slot: 0 });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.round.visitors[0].status, 'alive');
  // The visitor escaped, while another visitor entered a ghost room before the next stage.
  play.round.visitors[0].roomId = 'study_room';
  notes(play, 8);
  play = JSON.parse(JSON.stringify(play));
  play.round.silent.cycle++;
  play = stage(play);
  assert.equal(play.round.visitors[0].status, 'alive');
  assert.equal(play.round.visitors[2].status, 'box_person');
  assert.equal(play.powers.step, 'preparation');
  assert.equal(play.powers.pendingBehindYou, null);
  assert.equal(play.interruption, null);
  assert.equal(play.resolution, null, 'A visitor with skills but no tokens has no inheritance decision');
  assert.deepEqual(play.inventories[third], { items: [], tokens: [] });
  play = begin(play);
  assert.equal(play.round.visitors[0].status, 'alive');
});

test('four and five player games allow only the overflow flipper to use or decline their extinguisher', () => {
  for (const visitorIds of [visitors, [...visitors, 'visitor-d']]) {
    for (const triggerId of visitorIds) for (const use of [false, true]) {
      let play = fixture(visitorIds);
      for (const id of visitorIds) play.inventories[id].tokens.push(piece(`extinguisher-${id}`, 'extinguisher'));
      Object.assign(play.round.silent, { turnPlayerId: triggerId, total: 9 });
      play = act(play, triggerId, { type: 'silent_reveal', index: 5 });
      assert.equal(play.round.silent.resumePlayerId, triggerId);
      assert.equal(Object.hasOwn(play.round.silent, 'triggerPlayerId'), false);
      assert.deepEqual(play.interruption, { kind: 'noise', responders: [triggerId], passed: [] });
      reject(play, hakoId, { type: 'pass_noise_reaction' });
      for (const id of visitorIds) {
        assert.equal(getPlayView(play, id).interruption.canRespond, id === triggerId);
        if (id !== triggerId) {
          reject(play, id, { type: 'extinguisher_response', use: true });
          reject(play, id, { type: 'extinguisher_response', use: false });
        }
      }
      play = JSON.parse(JSON.stringify(play));
      play = act(play, triggerId, { type: 'extinguisher_response', use });
      assert.equal(play.interruption, null);
      assert.equal(play.inventories[triggerId].tokens.some(token => token.type === 'extinguisher'), !use);
      if (use) {
        assert.equal(play.round.silent.phase, 'visitor_reveal');
        assert.equal(play.round.silent.cycle, 2);
        assert.equal(play.round.silent.turnPlayerId, triggerId);
        assert.equal(play.hakoStage, null);
        assert.equal(play.powers.step, null);
        assert.equal(play.totalRounds, 1);
        assert.equal(play.round.hidingCornerId, 'children_bed');
      } else {
        assert.equal(play.round.silent.phase, 'hako_reaction');
        play = act(play, hakoId, { type: 'pass_noise_reaction' });
        assert.equal(play.round.silent.phase, 'hako_phase');
        reject(play, triggerId, { type: 'extinguisher_response', use: true });
      }
      for (const id of visitorIds.filter(id => id !== triggerId)) {
        assert.ok(play.inventories[id].tokens.some(token => token.type === 'extinguisher'));
      }
    }
  }
});

test('another visitor holding an extinguisher cannot respond when the overflow flipper owns none', () => {
  for (const visitorIds of [visitors, [...visitors, 'visitor-d']]) {
    let play = fixture(visitorIds);
    for (const id of visitorIds.slice(1)) play.inventories[id].tokens.push(piece(`other-${id}`, 'extinguisher'));
    play.round.silent.total = 9;
    play = act(play, first, { type: 'silent_reveal', index: 5 });
    assert.equal(play.interruption, null);
    for (const id of visitorIds) reject(play, id, { type: 'extinguisher_response', use: true });
    play = act(play, hakoId, { type: 'pass_noise_reaction' });
    assert.equal(play.round.silent.phase, 'hako_phase');
  }
});

test('exactly ten and the last hidden card never open extinguisher windows, including NO.5 activation', () => {
  let exact = fixture();
  exact.inventories[first].tokens.push(piece('exact-ten', 'extinguisher'));
  exact.round.silent.total = 5;
  exact = act(exact, first, { type: 'silent_reveal', index: 5 });
  assert.equal(exact.round.silent.total, 10);
  assert.equal(exact.round.silent.phase, 'visitor_action');
  assert.equal(exact.interruption, null);
  reject(exact, first, { type: 'extinguisher_response', use: true });
  let play = fixture();
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  for (const id of visitors) play.inventories[id].tokens.push(piece(`last-hidden-${id}`, 'extinguisher'));
  for (let index = 0; index < 5; index++) {
    play = act(play, play.round.silent.turnPlayerId, { type: 'silent_skip', index });
  }
  assert.equal(play.round.silent.trigger, 'one_hidden');
  assert.equal(play.round.silent.resumePlayerId, third);
  assert.equal(play.interruption, null);
  for (const id of visitors) reject(play, id, { type: 'extinguisher_response', use: true });
  play = act(begin(play), hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.interruption, null);
  assert.deepEqual(play.powers.pendingBehindYou, { cycle: 2 });
  assert.equal(play.powers.slots[0], null);
  assert.equal(play.powers.hand.filter(card => card.id === 5).length, 1);
  for (const id of visitors) reject(play, id, { type: 'extinguisher_response', use: true });
  play = finishStage(play);
  assert.equal(play.round.silent.turnPlayerId, third);
});

test('NO.5 activation after declining an overflow response has no second extinguisher window', () => {
  let play = fixture();
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play.inventories[first].tokens.push(piece('declined-extinguisher', 'extinguisher'));
  play.round.silent.total = 9;
  play = act(play, first, { type: 'silent_reveal', index: 5 });
  play = act(play, first, { type: 'extinguisher_response', use: false });
  play = act(play, hakoId, { type: 'pass_noise_reaction' });
  play = act(begin(play), hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.interruption, null);
  assert.deepEqual(play.powers.pendingBehindYou, { cycle: 2 });
  reject(play, first, { type: 'extinguisher_response', use: true });
  assert.ok(play.inventories[first].tokens.some(token => token.type === 'extinguisher'));
  play = finishStage(play);
  assert.equal(play.round.silent.cycle, 2);
});

test('continuous Mary and bell reveals stop at overflow and only the actual flipper can respond', () => {
  for (const overflowIndex of [0, 1, 2]) {
    let play = fixture();
    play.inventories[first].tokens.push(piece('mary-doll', 'doll'), piece('mary-extinguisher', 'extinguisher'));
    play.inventories[second].tokens.push(piece('other-extinguisher', 'extinguisher'));
    play.inventories[first].items.push(structuredClone(INITIAL_ITEMS.find(item => item.id === 'shrine_bell')));
    play.noiseEffects = { mary: { playerId: first, deferredCycle: 0, deferredTurn: -1,
      card: { id: 8, ignoreThreshold: true } } };
    const indices = overflowIndex === 0 ? [5] : overflowIndex === 1 ? [0, 5] : [0, 1, 5];
    play.round.silent.total = 9;
    for (let index = 0; index <= overflowIndex; index++) {
      play = act(play, first, { type: 'silent_reveal', index: indices[index],
        ...(index === 0 ? { useBell: true } : {}) });
      if (index < overflowIndex) assert.equal(play.interruption, null);
    }
    assert.equal(play.round.silent.phase, 'hako_reaction');
    assert.equal(play.round.silent.revealsRemaining, 0);
    assert.equal(play.round.silent.resumePlayerId, first);
    assert.deepEqual(play.interruption.responders, [first]);
    reject(play, second, { type: 'extinguisher_response', use: true });
    play = act(play, first, { type: 'extinguisher_response', use: true });
    assert.equal(play.round.silent.turnPlayerId, first);
    assert.equal(play.round.silent.revealsRemaining, 0);
    assert.equal(play.noiseEffects.bellIntent, null);
    assert.equal(play.noiseEffects.bellReady, null);
  }
});

test('legacy overflow windows retain only a living unpassed flipper and GET never changes saved state', () => {
  for (const kind of ['valid', 'passed', 'other', 'missing', 'dead', 'stage']) {
    let play = fixture();
    for (const id of kind === 'missing' ? [second] : [first, second]) {
      play.inventories[id].tokens.push(piece(`old-${id}`, 'extinguisher'));
    }
    Object.assign(play.round.silent, { phase: 'hako_reaction', turnPlayerId: null,
      resumePlayerId: first, trigger: 'overflow', total: 11 });
    play.round.silent.triggerPlayerId = second;
    if (kind === 'dead') play.round.visitors[0].status = 'box_person';
    if (kind === 'stage') play.round.silent.phase = 'hako_phase';
    play.interruption = { kind: 'noise', responders: kind === 'other' ? [second] : [first, second],
      passed: kind === 'passed' ? [first] : [] };
    play = JSON.parse(JSON.stringify(play));
    const before = JSON.stringify(play);
    for (const id of [hakoId, ...visitors]) {
      assert.equal(getPlayView(play, id).interruption?.canRespond ?? false, kind === 'valid' && id === first);
    }
    assert.equal(JSON.stringify(play), before, 'Reading an old window cannot normalize or kill in the saved state');
    reject(play, second, { type: 'extinguisher_response', use: true });
    const restored = structuredClone(play);
    normalizePlayForRules(restored);
    assert.equal(Object.hasOwn(restored.round.silent, 'triggerPlayerId'), false);
    assert.deepEqual(restored.interruption, kind === 'valid' ? { kind: 'noise', responders: [first], passed: [] } : null);
    normalizePlayForRules(restored);
    if (kind === 'valid') play = act(play, first, { type: 'extinguisher_response', use: false });
    if (kind !== 'stage') {
      play = act(play, hakoId, { type: 'pass_noise_reaction' });
      assert.equal(play.interruption, null);
      assert.equal(play.round.silent.phase, 'hako_phase');
    }
  }
});

test('legacy NO.5 response windows close without rolling back powers or settling deaths during GET or normalization', () => {
  let play = fixture();
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play.round.visitors[0].roomId = 'children_room';
  play.inventories[first].tokens.push(piece('old-power-extinguisher', 'extinguisher'));
  play = begin(stage(play));
  const restorePowers = structuredClone(play.powers);
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  play.interruption = { kind: 'power', responders: [first], passed: [], restorePowers,
    deaths: [{ playerId: first, killerCornerId: 'children_bed' }] };
  play = JSON.parse(JSON.stringify(play));
  const before = JSON.stringify(play);
  for (const id of [hakoId, ...visitors]) assert.equal(getPlayView(play, id).interruption, null);
  assert.equal(JSON.stringify(play), before);
  const restored = structuredClone(play);
  normalizePlayForRules(restored);
  assert.equal(restored.interruption, null);
  assert.deepEqual(restored.powers.pendingBehindYou, { cycle: 2 });
  assert.equal(restored.powers.slots[0], null);
  assert.equal(restored.round.visitors[0].status, 'alive');
  reject(play, first, { type: 'extinguisher_response', use: true });
  play = finishStage(play);
  assert.equal(play.interruption, null);
  assert.equal(play.powers.slots[0], null);
  play = stage(play);
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(play.powers.pendingBehindYou, null);
});

test('using an extinguisher still settles due group deaths and inheritance, skips ghosts and resumes after the dead flipper', () => {
  let play = fixture([...visitors, 'visitor-d']);
  ghost(play, 'visitor-d', 'children_toys');
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  play = act(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  play = act(play, 'visitor-d', { type: 'inspect_hiding_room', roomId: 'children_room' });
  play = act(play, 'visitor-d', { type: 'ghost_hide', cornerId: 'children_toys' });
  play.round.visitors[0].roomId = 'children_room';
  play.round.visitors[1].roomId = 'children_room';
  play.inventories[first].tokens.push(piece('spent-before-death', 'extinguisher'), piece('inherited-key', 'key'));
  play.inventories[second].tokens.push(piece('inherited-password', 'password', { number: 4 }));
  play.inventories[first].items.push(structuredClone(INITIAL_ITEMS.find(item => item.id === 'relic_ring')));
  // Restart before the due boundary and again while inheritance is pending.
  play = JSON.parse(JSON.stringify(play));
  play.round.silent.cards.forEach((card, index) => { card.number = index; });
  play.round.silent.total = 9;
  play = act(play, first, { type: 'silent_reveal', index: 5 });
  const beforeBoundary = JSON.stringify(play);
  for (const id of [hakoId, ...visitors, 'visitor-d']) getPlayView(play, id);
  assert.equal(JSON.stringify(play), beforeBoundary, 'Reading a due effect cannot settle its deaths');
  assert.ok(play.round.visitors.filter(player => player.id !== 'visitor-d').every(player => player.status === 'alive'));
  play = act(play, first, { type: 'extinguisher_response', use: true });
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(play.round.visitors[1].status, 'box_person');
  assert.equal(play.round.visitors[2].status, 'alive');
  assert.equal(play.powers.pendingBehindYou, null);
  assert.deepEqual(play.inventories[first].items, []);
  assert.deepEqual(play.inventories[second].items, []);
  assert.ok(play.removedItems.some(item => item.id === 'relic_ring'));
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.round.silent.turnPlayerId, third);
  assert.equal(play.round.silent.cycle, 3);
  assert.equal(play.hakoStage, null);
  assert.equal(play.powers.step, null);
  assert.equal(play.round.hidingCornerId, 'children_bed');
  assert.equal(play.ghosts.find(actor => actor.playerId === 'visitor-d').cornerId, 'children_toys');
  assert.ok(play.removedTokens.some(token => token.id === 'spent-before-death'));
  assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: first });
  reject(play, hakoId, { type: 'begin_hako_action' });
  reject(play, 'visitor-d', { type: 'inspect_hiding_room', roomId: 'children_room' });
  reject(play, third, { type: 'silent_reveal', index: 0 });
  play = JSON.parse(JSON.stringify(play));
  play = act(play, first, { type: 'bequeath', targetId: third });
  assert.ok(play.inventories[third].tokens.some(token => token.id === 'inherited-key'));
  assert.equal(play.inventories[third].tokens.some(token => token.id === 'spent-before-death'), false);
  assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: second });
  play = act(play, second, { type: 'bequeath', targetId: third });
  assert.ok(play.inventories[third].tokens.some(token => token.id === 'inherited-password'));
  assert.equal(play.inventories[third].items.some(item => item.id === 'relic_ring'), false);
  assert.equal(play.resolution, null);
  play = act(play, third, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.number === 0) });
  assert.equal(play.round.silent.phase, 'visitor_action');
  play.round.visitors[2].roomId = 'children_room';
  play = stage(play);
  assert.equal(play.round.visitors[2].status, 'alive', 'The settled NO.5 effect must not run again at the following stage');
  assert.equal(play.ghosts.length, 3);
});

test('a due NO.5 effect can end the game despite an extinguisher and leaves no inheritance decisions', () => {
  let play = fixture();
  play.round.visitors.forEach(player => { player.roomId = 'children_room'; });
  play.inventories[first].tokens.push(piece('last-extinguisher', 'extinguisher'));
  play.powers.pendingBehindYou = { cycle: 1 };
  play.round.silent.total = 9;
  play = act(play, first, { type: 'silent_reveal', index: 5 });
  play = act(play, first, { type: 'extinguisher_response', use: true });
  assert.equal(play.result.winner, 'hako');
  assert.ok(play.round.visitors.every(player => player.status === 'box_person'));
  assert.equal(play.powers.pendingBehindYou, null);
  assert.equal(play.resolution, null);
  assert.equal(play.inheritanceQueue.length, 0);
  assert.ok(play.removedTokens.some(token => token.id === 'last-extinguisher'));
  for (const id of [hakoId, ...visitors]) reject(play, id, { type: 'extinguisher_response', use: false });
});

test('due group deaths finish before relic-ring inheritance when no extinguisher is used', () => {
  let play = fixture();
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play.round.visitors[0].roomId = 'children_room';
  play.round.visitors[1].roomId = 'children_room';
  play.inventories[first].items.push(structuredClone(INITIAL_ITEMS.find(item => item.id === 'relic_ring')));
  play.inventories[first].tokens.push(piece('inherited-key', 'key'));
  play.inventories[second].tokens.push(piece('inherited-password', 'password', { number: 4 }));
  play.inventories[third].tokens.push(piece('unused-extinguisher', 'extinguisher'));
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.round.visitors[0].status, 'alive');
  assert.equal(play.round.visitors[1].status, 'alive');
  assert.equal(play.resolution, null);
  play = finishStage(play);
  play = stage(play);
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(play.round.visitors[1].status, 'box_person');
  assert.equal(play.round.visitors[2].status, 'alive');
  assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: first });
  play = act(play, first, { type: 'bequeath', targetId: third });
  assert.ok(play.inventories[third].tokens.some(token => token.id === 'inherited-key'));
  assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: second });
  play = act(play, second, { type: 'bequeath', targetId: third });
  assert.ok(play.inventories[third].tokens.some(token => token.id === 'inherited-password'));
  assert.equal(play.resolution, null);
});

for (const survivor of [true, false]) test(`delayed group death returns Mary before its first view ${survivor ? 'with inheritance' : 'without a surviving heir'}`, () => {
  let play = fixture();
  for (const [cornerId, token] of Object.entries(play.tokens)) if (token?.type === 'doll') play.tokens[cornerId] = null;
  play.inventories[first].tokens.push(piece('delayed-mary-doll', 'doll'));
  const acquired = ['relic_ring', 'night_vision', 'smartphone'];
  play.inventories[first].items.push(...acquired.map(id => structuredClone(INITIAL_ITEMS.find(item => item.id === id))));
  play.availableItems = play.availableItems.filter(item => !acquired.includes(item.id));
  givePower(play, 8, { slot: 0, ignoreThreshold: true });
  play = act(reveal(play), first, { type: 'move', roomId: 'study_room' });
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  givePower(play, 5, { slot: 0, ignoreThreshold: true });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0 });
  play = finishStage(play);
  play.round.visitors[0].roomId = 'children_room';
  play.round.visitors[1].roomId = 'children_room';
  if (!survivor) play.round.visitors[2].roomId = 'children_room';
  play = stage(play);
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(play.round.visitors[1].status, 'box_person');
  assert.equal(play.round.visitors[2].status, survivor ? 'alive' : 'box_person');
  assert.deepEqual(play.inventories[first].items, []);
  assert.ok(acquired.every(id => play.removedItems.some(item => item.id === id)));
  assert.equal(play.availableItems.some(item => acquired.includes(item.id)), false);
  assert.ok(play.ringAllies.includes(first));
  assert.equal(play.noiseEffects.mary, null);
  assert.equal(play.powers.hand.filter(card => card.id === 8).length, 1);
  assert.equal(getPlayView(play, hakoId).powers.hand.filter(card => card.id === 8).length, 1);
  assert.equal(getPlayView(play, first).noiseEffects.maryPlayerId, null);
  play = JSON.parse(JSON.stringify(play));
  assert.equal(getPlayView(play, hakoId).powers.hand.filter(card => card.id === 8).length, 1);
  if (survivor) {
    assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: first });
    reject(play, first, { type: 'bequeath', targetId: second });
    play = act(play, first, { type: 'bequeath', targetId: third });
    assert.ok(play.inventories[third].tokens.some(token => token.id === 'delayed-mary-doll'));
    assert.equal(play.inventories[third].items.some(item => acquired.includes(item.id)), false);
    assert.equal(play.resolution, null);
    assert.equal(play.powers.hand.filter(card => card.id === 8).length, 1);
    play = act(play, hakoId, { type: 'set_power', powerId: 8, slot: 0 });
    assert.equal(play.powers.slots[0].id, 8);
  } else {
    assert.equal(play.resolution, null);
    assert.equal(play.result.winner, 'hako');
    assert.equal(play.result.winners.includes(first), false);
  }
});

test('forced peek cancels the original move and lets only that visitor choose a nonempty local corner', () => {
  let play = fixture();
  givePower(play, 6, { slot: 0, ignoreThreshold: true });
  play.tokens.hall_clock = piece('forced-password', 'password', { number: 4 });
  play = reveal(play);
  play = act(play, first, { type: 'move', roomId: 'study_room' });
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.round.pendingAction, null);
  assert.equal(play.round.visitors[0].roomId, 'hall_room');
  assert.equal(play.resolution.kind, 'forced_peek');
  assert.deepEqual(getPlayView(play, first).resolution.cornerIds, ['hall_clock']);
  reject(play, hakoId, { type: 'choose_forced_peek', cornerId: 'hall_clock' });
  reject(play, second, { type: 'choose_forced_peek', cornerId: 'hall_clock' });
  reject(play, first, { type: 'choose_forced_peek', cornerId: 'study_books' });
  play = act(play, first, { type: 'choose_forced_peek', cornerId: 'hall_clock' });
  assert.equal(play.resolution.kind, 'peek');
  assert.equal(getPlayView(play, first).resolution.token.id, 'forced-password');
  assert.equal(getPlayView(play, second).resolution.kind, 'waiting');
  play = act(play, first, { type: 'resolve_peek', take: false });
  assert.equal(play.round.visitors[0].roomId, 'hall_room');
  assert.equal(play.round.silent.turnPlayerId, second);
});

test('false response gives hako a choice of lie without changing actual information or revealing the passive card', () => {
  for (const lyingAllowed of [false, true]) {
    let play = fixture();
    if (lyingAllowed) givePower(play, 9, { slot: 0 });
    play.round.silent.turnPlayerId = second;
    play = reveal(play, second);
    play = act(play, second, { type: 'use_item', itemId: 'spirit_pen', roomId: 'children_room' });
    play = act(play, hakoId, { type: 'resolve_visitor_action' });
    const resolution = getPlayView(play, hakoId).resolution;
    assert.equal(resolution.truth, true);
    assert.equal(resolution.canLie, lyingAllowed);
    assert.equal(getPlayView(play, first).resolution.kind, 'waiting');
    if (!lyingAllowed) reject(play, hakoId, { type: 'answer_item', answer: false });
    else {
      assert.equal(Object.hasOwn(getPlayView(play, first).powers.slots[0], 'card'), false);
      play = act(play, hakoId, { type: 'answer_item', answer: false });
      assert.equal(play.itemEvents.at(-1).answer, false);
      assert.equal(play.powers.slots[0].id, 9);
      assert.equal(play.powers.slots[0].faceUp, false);
    }
  }
});

test('ghost call replaces the declared action, forces shortest moves and ends for everyone on the first arrival only once', () => {
  let play = fixture();
  givePower(play, 10, { slot: 0 });
  play = reveal(play);
  play = act(play, first, { type: 'peek', cornerId: 'hall_clock' });
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.round.pendingAction, null);
  assert.equal(play.powers.ghostCall.active, true);
  assert.equal(getPlayView(play, second).powers.slots[0].card, undefined);
  assert.equal(getPlayView(play, second).powers.lastActivation, null);
  assert.deepEqual(getPlayView(play, second).powers.activationNotice, { serial: 1, cycle: 1 });
  reject(play, first, { type: 'peek', cornerId: 'hall_clock' });
  reject(play, first, { type: 'move', roomId: 'upstairs_hall' });
  play = act(play, first, { type: 'move', roomId: 'dining_room' });
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  const skipProbe = structuredClone(play);
  skipProbe.round.silent.cards[0].number = 5;
  skipProbe.round.silent.cards[5].number = 0;
  skipProbe.round.silent.total = 5;
  reject(skipProbe, second, { type: 'silent_skip', index: 1 });
  for (const id of [second, third]) {
    play = reveal(play, id);
    play = act(play, id, { type: 'move', roomId: 'dining_room' });
    play = act(play, hakoId, { type: 'resolve_visitor_action' });
  }
  play = reveal(play, first);
  play = act(play, first, { type: 'move', roomId: 'living_room' });
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(play.powers.ghostCall.active, false);
  assert.equal(play.powers.slots[0], null);
  assert.ok(play.powers.hand.some(card => card.id === 10));
  assert.equal(play.round.visitors[1].roomId, 'dining_room');
  play.powers.slots[0] = { id: 10, faceUp: false, ignoreThreshold: true };
  play.round.silent.phase = 'visitor_action';
  play.round.silent.turnPlayerId = second;
  play.round.pendingAction = { type: 'move', playerId: second, fromRoomId: 'dining_room', toRoomId: 'hall_room' };
  reject(play, hakoId, { type: 'activate_power', slot: 0 });
});

test('ghost call ends immediately when a living visitor already occupies the destination', () => {
  let play = fixture();
  givePower(play, 10, { slot: 0 });
  play.round.visitors[2].roomId = 'living_room';
  play = act(reveal(play), first, { type: 'peek', cornerId: 'hall_clock' });
  play = act(play, hakoId, { type: 'activate_power', slot: 0 });
  assert.equal(play.powers.ghostCall.active, false);
  assert.equal(play.powers.slots[0], null);
  assert.ok(play.powers.used.includes(10));
});

test('unreachable ghost-call routes finish revealed actions until the next stage reopens the door', () => {
  let play = fixture();
  givePower(play, 3, { slot: 0 });
  givePower(play, 10, { slot: 1 });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0,
    fromRoomId: 'dining_room', toRoomId: 'living_room' });
  play = finishStage(play);
  play.round.silent.cards.forEach((card, index) => { card.number = index; });
  play = reveal(play);
  play = act(play, first, { type: 'move', roomId: 'dining_room' });
  play = act(play, hakoId, { type: 'activate_power', slot: 1 });
  assert.equal(play.round.pendingAction, null);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.round.silent.turnPlayerId, second);
  assert.equal(play.round.visitors[0].roomId, 'hall_room', 'The cancelled movement must not occur');
  assert.equal(getPlayView(play, first).blockedWait.playerId, first);
  for (const id of [second, third, first, second]) {
    play = reveal(play, id);
    assert.equal(play.round.pendingAction, null);
    assert.equal(play.resolution, null);
  }
  assert.equal(play.round.silent.phase, 'hako_phase');
  assert.equal(play.round.blockedDoors.length, 0, 'The normal next stage must still be reachable to release the door');
  play = finishStage(begin(play));
  const current = play.round.silent.turnPlayerId;
  const zero = play.round.silent.cards.findIndex(card => card.number === 0);
  play = act(play, current, { type: 'silent_reveal', index: zero });
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.deepEqual(getPlayView(play, current).moveTargets, ['dining_room']);
  assert.equal(getPlayView(play, current).blockedWait, null);
});

test('false crying points elsewhere, returns its card at action start and cannot be set again this game', () => {
  let play = fixture();
  givePower(play, 11, { slot: 0 });
  play.powers.deck = [2, 3];
  play = stage(play);
  play = act(play, hakoId, { type: 'hako_cry', roomId: 'hall_room' });
  assert.equal(getPlayView(play, first).powers.announcement.roomId, 'hall_room');
  assert.equal(Object.hasOwn(getPlayView(play, first).powers, 'falseCryPending'), false);
  play = begin(play);
  assert.equal(play.powers.slots[0], null);
  assert.ok(play.powers.hand.some(card => card.id === 11));
  play = finishStage(play);
  play = stage(play);
  reject(play, hakoId, { type: 'set_power', powerId: 11, slot: 0 });
});

test('power views are detached and do not expose hidden hand, rearrangement or draw data to visitors', () => {
  let play = fixture();
  givePower(play, 4, { slot: 0 });
  play = act(begin(stage(play)), hakoId, { type: 'activate_power', slot: 0, roomId: 'study_room' });
  const before = JSON.stringify(play);
  const own = getPlayView(play, hakoId).powers;
  own.hand[0].description = 'changed';
  own.hand[0].id = 99;
  own.rearrangement.corners[0].token.id = 'changed';
  own.lastActivation.powerId = 99;
  const publicView = getPlayView(play, first).powers;
  assert.equal(publicView.lastActivation, null);
  assert.equal(Object.hasOwn(publicView.slots[0], 'card'), false);
  assert.equal(Object.hasOwn(publicView, 'hand'), false);
  assert.equal(Object.hasOwn(publicView, 'rearrangement'), false);
  assert.equal(Object.hasOwn(publicView, 'lastDraw'), false);
  assert.equal(JSON.stringify(play), before);
});
