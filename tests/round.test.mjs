import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { createRound, applyRoundAction, getRoundView } from '../src/round.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const hakoId = 'hako';
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

function completedSetup() {
  const setup = createSetup(visitors, { deck });
  const targets = [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ];
  targets.forEach(([floor, x, y, rotation]) => {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  });
  return setup;
}

function newRound(numbers = [5, 4, 1, 2, 3, 0]) {
  return createRound(completedSetup(), { hakoId, hidingCornerId: 'dark_wardrobe', numbers });
}

function rejectsWithoutMutation(round, playerId, action) {
  const before = structuredClone(round);
  assert.throws(() => applyRoundAction(round, playerId, action), /[\u4e00-\u9fff]/);
  assert.deepEqual(round, before);
}

function revealAndMove(round, playerId, index, roomId) {
  applyRoundAction(round, playerId, { type: 'silent_reveal', index });
  applyRoundAction(round, playerId, { type: 'move', roomId });
  applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
}

test('round requires a complete map and an explicitly chosen haunted initial corner', () => {
  const setup = completedSetup();
  const before = structuredClone(setup);
  assert.throws(() => createRound(createSetup(visitors), { hakoId, hidingCornerId: 'dark_wardrobe' }), /九块/);
  assert.throws(() => createRound({ ...setup, placements: setup.placements.slice(1) }, { hakoId }), /九块/);
  assert.throws(() => createRound(setup, { hakoId: visitors[0], hidingCornerId: 'dark_wardrobe' }), /箱娃/);
  assert.throws(() => createRound(setup, { hakoId }), /潜伏/);
  assert.throws(() => createRound(setup, { hakoId, hidingCornerId: 'hall_clock' }), /潜伏/);
  const round = createRound(setup, { hakoId, hidingCornerId: 'children_bed' });
  assert.deepEqual(round.visitors, visitors.map(id => ({ id, roomId: 'hall_room' })));
  round.placements[0].x = 99;
  assert.deepEqual(setup, before);
});

test('movement waits for the hako reaction window and advances only after resolution', () => {
  const round = newRound();
  const [first, second] = visitors;
  rejectsWithoutMutation(round, first, { type: 'move', roomId: 'study_room' });
  rejectsWithoutMutation(round, hakoId, { type: 'silent_reveal', index: 0 });
  rejectsWithoutMutation(round, second, { type: 'silent_reveal', index: 0 });
  applyRoundAction(round, first, { type: 'silent_reveal', index: 0 });
  assert.ok(getRoundView(round, first).moveTargets.includes('study_room'));
  assert.deepEqual(getRoundView(round, second).moveTargets, []);
  rejectsWithoutMutation(round, first, { type: 'move', roomId: 'storage_room' });
  const declaration = applyRoundAction(round, first, { type: 'move', roomId: 'dark_room' });
  assert.equal(declaration.phase, 'visitor_reaction');
  assert.equal(declaration.visitors[0].roomId, 'hall_room');
  assert.deepEqual(declaration.pendingAction, {
    type: 'move', playerId: first, fromRoomId: 'hall_room', toRoomId: 'study_room',
  });
  for (const playerId of visitors) {
    rejectsWithoutMutation(round, playerId, { type: 'resolve_visitor_action' });
    rejectsWithoutMutation(round, playerId, { type: 'silent_skip', index: 1 });
  }
  rejectsWithoutMutation(round, first, { type: 'move', roomId: 'bathroom_room' });
  applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(round.visitors[0].roomId, 'study_room');
  assert.equal(getRoundView(round, first).phase, 'visitor_reveal');
  assert.equal(round.silent.turnPlayerId, second);
  assert.equal(round.pendingAction, null);
  rejectsWithoutMutation(round, hakoId, { type: 'resolve_visitor_action' });
});

test('exactly ten permits movement; overflow preserves an immediate reaction and resumes its visitor', () => {
  const round = newRound();
  revealAndMove(round, visitors[0], 0, 'study_room');
  revealAndMove(round, visitors[1], 1, 'bathroom_room');
  applyRoundAction(round, visitors[2], { type: 'silent_reveal', index: 2 });
  assert.equal(round.silent.total, 10);
  assert.equal(getRoundView(round, visitors[2]).phase, 'visitor_action');
  applyRoundAction(round, visitors[2], { type: 'move', roomId: 'upstairs_hall' });
  applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(round.visitors[2].roomId, 'upstairs_hall');
  applyRoundAction(round, visitors[0], { type: 'silent_reveal', index: 3 });
  assert.equal(getRoundView(round, visitors[0]).phase, 'hako_reaction');
  assert.equal(round.visitors[0].roomId, 'study_room');
  rejectsWithoutMutation(round, visitors[0], { type: 'move', roomId: 'hall_room' });
  rejectsWithoutMutation(round, visitors[0], { type: 'pass_noise_reaction' });
  rejectsWithoutMutation(round, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  applyRoundAction(round, hakoId, { type: 'pass_noise_reaction' });
  assert.equal(getRoundView(round, hakoId).phase, 'hako_phase');
  const beforeMove = visitors.map(id => getRoundView(round, id));
  assert.ok(getRoundView(round, hakoId).hako.hidingTargets.includes('hall_clock'));
  rejectsWithoutMutation(round, visitors[0], { type: 'hako_hide', cornerId: 'hall_clock' });
  rejectsWithoutMutation(round, hakoId, { type: 'hako_hide', cornerId: 'living_sofa' });
  applyRoundAction(round, hakoId, { type: 'hako_hide', cornerId: 'hall_clock' });
  assert.equal(round.silent.cycle, 2);
  assert.equal(round.silent.turnPlayerId, visitors[0]);
  assert.equal(round.silent.total, 0);
  assert.equal(round.hidingCornerId, 'hall_clock');
  for (let i = 0; i < visitors.length; i++) {
    const view = getRoundView(round, visitors[i]);
    assert.deepEqual(view.visitors, beforeMove[i].visitors);
    assert.deepEqual(view.hako, { playerId: hakoId });
    assert.equal(JSON.stringify(view).includes('hall_clock'), false);
    assert.ok(view.silent.cards.every(card => card.status === 'down' && !Object.hasOwn(card, 'number')));
  }
});

test('last hidden marker triggers after the fifth action and resumes the next visitor', () => {
  const round = newRound([0, 1, 2, 3, 4, 5]);
  const destinations = ['study_room', 'bathroom_room', 'upstairs_hall', 'hall_room', 'hall_room'];
  for (let i = 0; i < 5; i++) {
    const playerId = visitors[i % 3];
    applyRoundAction(round, playerId, { type: 'silent_reveal', index: i });
    assert.equal(getRoundView(round, playerId).phase, 'visitor_action');
    applyRoundAction(round, playerId, { type: 'move', roomId: destinations[i] });
    assert.equal(getRoundView(round, playerId).phase, 'visitor_reaction');
    applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
  }
  assert.equal(round.silent.trigger, 'one_hidden');
  assert.equal(getRoundView(round, hakoId).phase, 'hako_phase');
  applyRoundAction(round, hakoId, { type: 'hako_hide', cornerId: 'dark_wardrobe' });
  assert.equal(round.silent.turnPlayerId, visitors[2]);
});

test('skips hold hidden markers, do not move visitors, and return markers on reset', () => {
  const round = newRound();
  for (let index = 0; index < 5; index++) {
    const playerId = visitors[index % 3];
    applyRoundAction(round, playerId, { type: 'silent_skip', index });
    const view = getRoundView(round, playerId);
    assert.deepEqual(view.silent.cards[index], { index, status: 'held', holderId: playerId });
    assert.ok(view.visitors.every(visitor => visitor.roomId === 'hall_room'));
  }
  assert.equal(round.silent.phase, 'hako_phase');
  applyRoundAction(round, hakoId, { type: 'hako_hide', cornerId: 'dark_bed' });
  assert.equal(round.silent.turnPlayerId, visitors[2]);
  assert.ok(getRoundView(round, visitors[0]).silent.cards.every(card => card.status === 'down'));
});

test('blocked visitor doors cannot be declared and a subdivision is not a separate move target', () => {
  const round = newRound();
  round.blockedDoors.push({ from: 'study_room', to: 'hall_room' });
  applyRoundAction(round, visitors[0], { type: 'silent_reveal', index: 0 });
  rejectsWithoutMutation(round, visitors[0], { type: 'move', roomId: 'study_room' });
  assert.equal(getRoundView(round, visitors[0]).moveTargets.includes('study_room'), false);
  round.blockedDoors = [];
  applyRoundAction(round, visitors[0], { type: 'move', roomId: 'study_room' });
  applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
  applyRoundAction(round, visitors[1], { type: 'silent_skip', index: 1 });
  applyRoundAction(round, visitors[2], { type: 'silent_skip', index: 2 });
  applyRoundAction(round, visitors[0], { type: 'silent_reveal', index: 3 });
  assert.deepEqual(getRoundView(round, visitors[0]).moveTargets, ['children_room', 'hall_room']);
  rejectsWithoutMutation(round, visitors[0], { type: 'move', roomId: 'dark_room' });
});

test('participant views and pending declarations are detached and never reveal another player secrets', () => {
  const round = newRound();
  assert.throws(() => getRoundView(round, 'outsider'), /本局玩家/);
  rejectsWithoutMutation(round, 'outsider', { type: 'silent_reveal', index: 0 });
  rejectsWithoutMutation(round, visitors[0], { type: 'unknown' });
  applyRoundAction(round, visitors[0], { type: 'silent_reveal', index: 0 });
  applyRoundAction(round, visitors[0], { type: 'move', roomId: 'study_room' });
  const before = structuredClone(round);
  const visitorView = getRoundView(round, visitors[1]);
  assert.deepEqual(visitorView.hako, { playerId: hakoId });
  visitorView.pendingAction.toRoomId = 'living_room';
  visitorView.visitors[0].roomId = 'living_room';
  visitorView.silent.cards[0].number = 99;
  const hakoView = getRoundView(round, hakoId);
  assert.equal(hakoView.hako.cornerId, 'dark_wardrobe');
  hakoView.hako.hidingTargets.push('anything');
  assert.deepEqual(round, before);
});

test('legacy subdivision positions and pending movement normalize in views and resolve without rewriting reads', () => {
  const round = newRound();
  round.visitors[0].roomId = 'dark_room';
  round.silent.phase = 'visitor_action';
  round.pendingAction = { type: 'move', playerId: visitors[0], fromRoomId: 'dark_room', toRoomId: 'hall_room' };
  const before = structuredClone(round);
  const view = getRoundView(round, visitors[0]);
  assert.equal(view.visitors[0].roomId, 'study_room');
  assert.equal(view.pendingAction.fromRoomId, 'study_room');
  assert.deepEqual(round, before);
  applyRoundAction(round, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(round.visitors[0].roomId, 'hall_room');
});
