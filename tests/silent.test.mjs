import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSilentRound, revealSilent, skipSilent, finishVisitorAction,
  passNoiseReaction, finishHakoPhase, getSilentView,
} from '../src/silent.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const numbers = [0, 1, 2, 3, 4, 5];
const round = (order = numbers) => createSilentRound(visitors, { numbers: order });

function rejectsWithoutMutation(state, action) {
  const before = structuredClone(state);
  assert.throws(action, error => error instanceof Error && /[\u4e00-\u9fff]/.test(error.message));
  assert.deepEqual(state, before);
}

function revealAndFinish(state, playerId, index) {
  const revealed = revealSilent(state, playerId, index);
  assert.equal(revealed.phase, 'visitor_action');
  return finishVisitorAction(state, playerId);
}

function skipToHako(state) {
  for (let index = 0; index < 5; index++) {
    const view = getSilentView(state);
    skipSilent(state, view.turnPlayerId, index);
  }
  assert.equal(getSilentView(state).phase, 'hako_phase');
}

test('silent round starts with six secret slots and the first visitor in seat order', () => {
  const state = round();
  assert.deepEqual(getSilentView(state), {
    phase: 'visitor_reveal', cycle: 1, turnPlayerId: visitors[0], total: 0, trigger: null,
    cards: numbers.map(index => ({ index, status: 'down' })),
  });
});

test('initial visitor order and injected numbers are copied from caller input', () => {
  const seatOrder = [...visitors];
  const order = [5, 4, 3, 2, 1, 0];
  const state = createSilentRound(seatOrder, { numbers: order });
  seatOrder[1] = 'changed-player';
  order[0] = 0;
  const revealed = revealSilent(state, visitors[0], 0);
  assert.equal(revealed.cards[0].number, 5);
  assert.equal(finishVisitorAction(state, visitors[0]).turnPlayerId, visitors[1]);
});

test('three distinct nonempty visitor IDs are required, including sparse-array validation', () => {
  const sparse = ['visitor-a', , 'visitor-c'];
  for (const ids of [
    undefined, null, 'abc', [], ['a', 'b'], ['a', 'b', 'c', 'd'],
    ['a', 'a', 'b'], ['a', 'b', ''], ['a', 'b', '  '], ['a', 'b', 3], sparse,
  ]) assert.throws(() => createSilentRound(ids), /访问者/);
});

test('injected numbers must be a complete permutation of zero through five', () => {
  const sparse = [0, 1, 2, 3, 4, ,];
  for (const order of [
    null, '012345', [], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5, 6],
    [0, 1, 2, 3, 4, 4], [0, 1, 2, 3, 4, 6], [0, 1, 2, 3, 4, -1],
    [0, 1, 2, 3, 4, 5.5], [0, 1, 2, 3, 4, '5'], [0, 1, 2, 3, 4, NaN], sparse,
  ]) assert.throws(() => round(order), /无声标志/);
});

test('default shuffling preserves all six numbers without revealing them publicly', () => {
  for (let iteration = 0; iteration < 8; iteration++) {
    const state = createSilentRound(visitors);
    assert.deepEqual(state.cards.map(card => card.number).sort((a, b) => a - b), numbers);
    assert.deepEqual(getSilentView(state).cards, numbers.map(index => ({ index, status: 'down' })));
  }
});

test('exactly ten still permits an action and continues with the next visitor', () => {
  const state = round([5, 4, 1, 0, 2, 3]);
  revealAndFinish(state, visitors[0], 0);
  revealAndFinish(state, visitors[1], 1);
  let view = revealSilent(state, visitors[2], 2);
  assert.equal(view.total, 10);
  assert.equal(view.phase, 'visitor_action');
  assert.equal(view.turnPlayerId, visitors[2]);
  assert.equal(view.trigger, null);
  view = finishVisitorAction(state, visitors[2]);
  assert.equal(view.phase, 'visitor_reveal');
  assert.equal(view.turnPlayerId, visitors[0]);
  view = revealSilent(state, visitors[0], 3);
  assert.equal(view.total, 10);
  assert.equal(view.phase, 'visitor_action');
  assert.equal(finishVisitorAction(state, visitors[0]).turnPlayerId, visitors[1]);
});

test('overflow keeps a reaction window, denies the action, and resumes the same visitor after hako', () => {
  const state = round([5, 4, 2, 0, 1, 3]);
  revealAndFinish(state, visitors[0], 0);
  revealAndFinish(state, visitors[1], 1);
  let view = revealSilent(state, visitors[2], 2);
  assert.equal(view.total, 11);
  assert.equal(view.phase, 'hako_reaction');
  assert.equal(view.trigger, 'overflow');
  assert.equal(view.turnPlayerId, null);
  for (const action of [
    () => finishVisitorAction(state, visitors[2]),
    () => revealSilent(state, visitors[2], 3),
    () => skipSilent(state, visitors[2], 3),
    () => finishHakoPhase(state),
  ]) rejectsWithoutMutation(state, action);
  view = passNoiseReaction(state);
  assert.equal(view.phase, 'hako_phase');
  assert.equal(view.total, 11);
  assert.equal(view.trigger, 'overflow');
  assert.equal(view.turnPlayerId, null);
  rejectsWithoutMutation(state, () => passNoiseReaction(state));
  rejectsWithoutMutation(state, () => finishVisitorAction(state, visitors[2]));
  rejectsWithoutMutation(state, () => revealSilent(state, visitors[2], 3));
  rejectsWithoutMutation(state, () => skipSilent(state, visitors[2], 3));
  view = finishHakoPhase(state, { numbers: [3, 2, 1, 0, 5, 4] });
  assert.equal(view.phase, 'visitor_reveal');
  assert.equal(view.cycle, 2);
  assert.equal(view.total, 0);
  assert.equal(view.trigger, null);
  assert.equal(view.turnPlayerId, visitors[2]);
  assert.ok(view.cards.every(card => card.status === 'down' && !('number' in card)));
  assert.equal(revealSilent(state, visitors[2], 0).cards[0].number, 3);
});

test('one remaining hidden card triggers hako only after the current action finishes', () => {
  const state = round();
  for (let index = 0; index < 4; index++) revealAndFinish(state, visitors[index % 3], index);
  let view = revealSilent(state, visitors[1], 4);
  assert.equal(view.cards.filter(card => card.status === 'down').length, 1);
  assert.equal(view.total, 10);
  assert.equal(view.phase, 'visitor_action');
  rejectsWithoutMutation(state, () => finishHakoPhase(state));
  view = finishVisitorAction(state, visitors[1]);
  assert.equal(view.phase, 'hako_phase');
  assert.equal(view.trigger, 'one_hidden');
  assert.equal(view.turnPlayerId, null);
  rejectsWithoutMutation(state, () => passNoiseReaction(state));
  view = finishHakoPhase(state, { numbers });
  assert.equal(view.turnPlayerId, visitors[2]);
  assert.equal(view.cycle, 2);
});

test('overflow takes precedence when its reveal also leaves one hidden card', () => {
  const state = round([5, 4, 1, 0, 2, 3]);
  for (let index = 0; index < 4; index++) revealAndFinish(state, visitors[index % 3], index);
  let view = revealSilent(state, visitors[1], 4);
  assert.equal(view.total, 12);
  assert.equal(view.cards.filter(card => card.status === 'down').length, 1);
  assert.equal(view.phase, 'hako_reaction');
  assert.equal(view.trigger, 'overflow');
  passNoiseReaction(state);
  view = finishHakoPhase(state, { numbers });
  assert.equal(view.turnPlayerId, visitors[1]);
});

test('skipping secretly holds a card, preserves total, ends the turn and returns held cards after hako', () => {
  const state = round([0, 5, 4, 3, 2, 1]);
  let view = skipSilent(state, visitors[0], 0);
  assert.deepEqual(view.cards[0], { index: 0, status: 'held', holderId: visitors[0] });
  assert.equal(view.total, 0);
  assert.equal(view.phase, 'visitor_reveal');
  assert.equal(view.turnPlayerId, visitors[1]);
  revealAndFinish(state, visitors[1], 1);
  // Holding the zero privately does not forbid later visitors from skipping.
  view = skipSilent(state, visitors[2], 2);
  assert.equal(view.total, 5);
  assert.equal(view.turnPlayerId, visitors[0]);
  skipSilent(state, visitors[0], 3);
  view = skipSilent(state, visitors[1], 4);
  assert.equal(view.phase, 'hako_phase');
  assert.equal(view.trigger, 'one_hidden');
  assert.equal(view.total, 5);
  assert.equal(view.cards.filter(card => card.status === 'held').length, 4);
  assert.ok(view.cards.filter(card => card.status === 'held').every(card => !('number' in card)));
  view = finishHakoPhase(state, { numbers });
  assert.equal(view.turnPlayerId, visitors[2]);
  assert.equal(view.total, 0);
  assert.deepEqual(view.cards, numbers.map(index => ({ index, status: 'down' })));
});

test('face-up zero forbids skipping without changing the pending turn or selected card', () => {
  const state = round();
  revealAndFinish(state, visitors[0], 0);
  rejectsWithoutMutation(state, () => skipSilent(state, visitors[1], 1));
  const view = revealSilent(state, visitors[1], 1);
  assert.equal(view.phase, 'visitor_action');
  assert.equal(view.total, 1);
});

test('wrong roles, turns, phases, indices and repeated cards cannot change state', () => {
  const state = round([5, 4, 3, 2, 1, 0]);
  for (const playerId of ['hako', visitors[1], visitors[2], null]) {
    rejectsWithoutMutation(state, () => revealSilent(state, playerId, 0));
    rejectsWithoutMutation(state, () => skipSilent(state, playerId, 0));
  }
  for (const index of [-1, 6, 0.5, NaN, Infinity, '0', null, undefined, {}, []]) {
    rejectsWithoutMutation(state, () => revealSilent(state, visitors[0], index));
    rejectsWithoutMutation(state, () => skipSilent(state, visitors[0], index));
  }
  rejectsWithoutMutation(state, () => finishVisitorAction(state, visitors[0]));
  rejectsWithoutMutation(state, () => passNoiseReaction(state));
  rejectsWithoutMutation(state, () => finishHakoPhase(state));
  skipSilent(state, visitors[0], 0);
  rejectsWithoutMutation(state, () => revealSilent(state, visitors[1], 0));
  rejectsWithoutMutation(state, () => skipSilent(state, visitors[1], 0));
  revealSilent(state, visitors[1], 1);
  rejectsWithoutMutation(state, () => revealSilent(state, visitors[1], 2));
  rejectsWithoutMutation(state, () => skipSilent(state, visitors[1], 2));
  rejectsWithoutMutation(state, () => finishVisitorAction(state, visitors[0]));
  rejectsWithoutMutation(state, () => finishVisitorAction(state, 'hako'));
  finishVisitorAction(state, visitors[1]);
  rejectsWithoutMutation(state, () => revealSilent(state, visitors[2], 1));
  rejectsWithoutMutation(state, () => skipSilent(state, visitors[2], 1));
  assert.equal(revealSilent(state, visitors[2], 2).total, 7);
});

test('public snapshots whitelist fields and cannot mutate hidden state or later snapshots', () => {
  const state = round([5, 4, 3, 2, 1, 0]);
  skipSilent(state, visitors[0], 0);
  const view = revealSilent(state, visitors[1], 1);
  const before = getSilentView(state);
  assert.deepEqual(Object.keys(view).sort(), ['cards', 'cycle', 'phase', 'total', 'trigger', 'turnPlayerId']);
  assert.deepEqual(Object.keys(view.cards[0]).sort(), ['holderId', 'index', 'status']);
  assert.deepEqual(Object.keys(view.cards[1]).sort(), ['index', 'number', 'status']);
  assert.deepEqual(Object.keys(view.cards[2]).sort(), ['index', 'status']);
  view.phase = 'hako_phase';
  view.total = 999;
  view.cards[0].holderId = 'changed-player';
  view.cards[0].number = 5;
  view.cards[1].number = 999;
  view.cards[2].status = 'up';
  view.cards.push({ index: 6, number: 999, status: 'up' });
  assert.deepEqual(getSilentView(state), before);
  assert.equal(finishVisitorAction(state, visitors[1]).turnPlayerId, visitors[2]);
});

test('invalid reset permutations leave hako intact and a valid reset copies its order', () => {
  const state = round();
  skipToHako(state);
  for (const order of [null, [], [0, 1, 2, 3, 4, 4], [0, 1, 2, 3, 4, ,]]) {
    rejectsWithoutMutation(state, () => finishHakoPhase(state, { numbers: order }));
  }
  const replacement = [5, 4, 3, 2, 1, 0];
  const view = finishHakoPhase(state, { numbers: replacement });
  replacement[0] = 0;
  assert.equal(view.cycle, 2);
  assert.equal(view.turnPlayerId, visitors[2]);
  assert.equal(revealSilent(state, visitors[2], 0).cards[0].number, 5);
});

test('successive hako resets advance cycles and retain the saved seat order', () => {
  const state = round();
  skipToHako(state);
  let view = finishHakoPhase(state, { numbers });
  assert.equal(view.cycle, 2);
  assert.equal(view.turnPlayerId, visitors[2]);
  skipToHako(state);
  view = finishHakoPhase(state);
  assert.equal(view.cycle, 3);
  assert.equal(view.turnPlayerId, visitors[1]);
  assert.equal(view.trigger, null);
  assert.equal(view.total, 0);
  assert.deepEqual(state.cards.map(card => card.number).sort((a, b) => a - b), numbers);
  assert.deepEqual(view.cards, numbers.map(index => ({ index, status: 'down' })));
});
