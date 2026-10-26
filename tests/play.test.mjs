import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import {
  INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower,
} from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hakoId = 'hako';
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const item = id => structuredClone(INITIAL_ITEMS.find(candidate => candidate.id === id));
const token = (id, type, fields = {}) => ({ id, type, ...fields });

function newPlay(firstItem = 'walkie_talkie') {
  const setup = createSetup(visitors, { deck });
  const positions = [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ];
  for (const [floor, x, y, rotation] of positions) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  const opening = createOpening(setup, { hakoId, itemChoices: visitors.map((playerId, index) => ({
    playerId, itemId: [firstItem, 'spirit_pen', 'ventriloquist_doll'][index],
  })) });
  chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  placeRemains(opening, hakoId, 'hall_clock');
  inspectInitialRoom(opening, hakoId, 'children_room');
  chooseInitialHiding(opening, hakoId, 'children_bed');
  chooseInitialPower(opening, hakoId, 1);
  return createPlay(setup, opening, { numbers: [0, 1, 2, 3, 4, 5] });
}

function act(play, playerId, action) {
  const before = JSON.stringify(play);
  const next = applyPlayAction(play, playerId, action);
  assert.equal(JSON.stringify(play), before, 'successful action mutated its input state');
  assert.notEqual(next, play);
  return next;
}

function rejects(play, playerId, action, pattern = /[\u4e00-\u9fff]/) {
  const before = JSON.stringify(play);
  assert.throws(() => applyPlayAction(play, playerId, action), pattern);
  assert.equal(JSON.stringify(play), before, 'rejected action mutated its input state');
}

function reveal(play, playerId = first) {
  const index = play.round.silent.cards.findIndex(card => card.status === 'down');
  return act(play, playerId, { type: 'silent_reveal', index });
}

function peek(play, cornerId, playerId = first, extra = {}) {
  play = act(play, playerId, { type: 'peek', cornerId, ...extra });
  return act(play, hakoId, { type: 'resolve_visitor_action' });
}

function attack(play, cornerId, weapon, playerId = first) {
  play.inventories[playerId].tokens.push(weapon);
  play = act(play, playerId, { type: 'use_weapon', cornerId, tokenId: weapon.id });
  return act(play, hakoId, { type: 'resolve_visitor_action' });
}

function enterHakoStage(play, resumePlayerId = third) {
  // A completed overflow window is a legal precursor independent of prior test actions.
  Object.assign(play.round.silent, {
    phase: 'hako_reaction', turnPlayerId: null, resumePlayerId, total: 11, trigger: 'overflow',
  });
  play.round.silent.cards.forEach(card => {
    card.status = [2, 4, 5].includes(card.number) ? 'up' : 'down';
    delete card.holderId;
  });
  play = act(play, hakoId, { type: 'pass_noise_reaction' });
  return act(play, hakoId, { type: 'begin_hako_action' });
}

function addGhost(play, playerId, cornerId, carriedTokens = []) {
  const player = play.round.visitors.find(candidate => candidate.id === playerId);
  player.status = 'box_person';
  delete player.roomId;
  play.round.silent.visitorIds = play.round.silent.visitorIds.filter(id => id !== playerId);
  play.ghosts.push({ playerId, cornerId, banished: false, carriedTokens });
}

test('peek requires a revealed turn and a local occupied corner, then waits for hako before disclosing contents', () => {
  let play = newPlay();
  const secret = token('private-peek-password', 'password', { number: 2 });
  play.tokens.hall_clock = secret;
  rejects(play, first, { type: 'peek', cornerId: 'hall_clock' });
  rejects(play, 'outsider', { type: 'peek', cornerId: 'hall_clock' });
  play = reveal(play);
  rejects(play, second, { type: 'peek', cornerId: 'hall_clock' });
  rejects(play, hakoId, { type: 'peek', cornerId: 'hall_clock' });
  rejects(play, first, { type: 'peek', cornerId: 'study_books' });
  rejects(play, first, { type: 'peek', cornerId: 'unknown-corner' });
  play.tokens.hall_clock = null;
  rejects(play, first, { type: 'peek', cornerId: 'hall_clock' });
  play.tokens.hall_clock = secret;
  play = act(play, first, { type: 'peek', cornerId: 'hall_clock' });
  for (const id of [first, second, third, hakoId]) {
    assert.equal(JSON.stringify(getPlayView(play, id)).includes(secret.id), false);
  }
  assert.equal(play.resolution, null);
  assert.equal(getPlayView(play, first).phase, 'visitor_reaction');
  rejects(play, second, { type: 'resolve_visitor_action' });
  rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, first).resolution.token.id, secret.id);
  for (const id of [second, third, hakoId]) {
    assert.deepEqual(getPlayView(play, id).resolution, { kind: 'waiting', playerId: first });
    assert.equal(JSON.stringify(getPlayView(play, id)).includes(secret.id), false);
  }
  rejects(play, second, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
  rejects(play, first, { type: 'move', roomId: 'study_room' });
});

test('take and leave are distinct decisions and an acquired piece cannot replace itself', () => {
  for (const take of [false, true]) {
    let play = newPlay();
    const found = token('take-or-leave', 'password', { number: 4 });
    play.tokens.hall_clock = found;
    play = peek(reveal(play), 'hall_clock');
    const boxesBefore = play.opening.emptyBoxTokens.length;
    rejects(play, first, { type: 'resolve_peek', replacement: 'empty_box' });
    rejects(play, first, { type: 'resolve_peek', take: true, replacement: found.id });
    play = act(play, first, { type: 'resolve_peek', take, replacement: 'empty_box' });
    assert.equal(play.inventories[first].tokens.some(held => held.id === found.id), take);
    assert.equal(play.tokens.hall_clock.type, take ? 'empty_box' : 'password');
    assert.equal(play.opening.emptyBoxTokens.length, boxesBefore - Number(take));
    assert.equal(play.round.silent.turnPlayerId, second);
    assert.equal(play.resolution, null);
  }
});

test('notebooks are forced public before resolution and require corner replacement', () => {
  let play = newPlay();
  play.tokens.hall_clock = token('discovered-notebook', 'notebook', { number: 7 });
  play = peek(reveal(play), 'hall_clock');
  assert.equal(play.tokens.hall_clock, null);
  for (const id of [first, second, third, hakoId]) {
    assert.deepEqual(getPlayView(play, id).notebooks.map(note => note.number), [7]);
  }
  rejects(play, first, { type: 'resolve_peek', take: false });
  rejects(play, first, { type: 'resolve_peek', replacement: 'none' });
  rejects(play, first, { type: 'resolve_peek', replacement: 'empty_box', itemId: 'smartphone' });
  play = act(play, first, { type: 'resolve_peek', take: false, replacement: 'empty_box' });
  assert.equal(play.tokens.hall_clock.type, 'empty_box');
  assert.equal(play.inventories[first].tokens.some(held => held.type === 'notebook'), false);
});

test('replacement allows an owned piece even with boxes available, and empty corners only when boxes run out', () => {
  for (const replacement of ['owned-piece', 'none', 'empty_box']) {
    let play = newPlay(replacement === 'empty_box' ? 'deduction' : 'walkie_talkie');
    play.tokens.hall_clock = token('found-password', 'password', { number: 2 });
    const owned = token('owned-piece', 'weakness_clue', { tool: 'white_stick' });
    play.inventories[first].tokens.push(owned);
    if (replacement === 'none') play.opening.emptyBoxTokens = [];
    play = peek(reveal(play), 'hall_clock');
    rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'not-owned' });
    if (replacement === 'none') rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
    else rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'none' });
    if (replacement === 'owned-piece') {
      rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box', faceUp: true });
    }
    const boxesBefore = play.opening.emptyBoxTokens.length;
    play = act(play, first, { type: 'resolve_peek', take: true, replacement, faceUp: replacement === 'empty_box' });
    if (replacement === 'none') assert.equal(play.tokens.hall_clock, null);
    if (replacement === 'owned-piece') {
      assert.deepEqual(play.tokens.hall_clock, owned);
      assert.equal(play.opening.emptyBoxTokens.length, boxesBefore);
      assert.equal(play.inventories[first].tokens.some(held => held.id === owned.id), false);
    }
    if (replacement === 'empty_box') {
      assert.equal(play.tokens.hall_clock.faceUp, true);
      for (const id of [first, second, third, hakoId]) {
        assert.equal(getPlayView(play, id).cornerState.find(corner => corner.id === 'hall_clock').token.type, 'empty_box');
      }
    }
  }
});

test('unmet exit and remains conditions and empty boxes leave their markers in place', () => {
  for (const type of ['hidden_exit', 'remains', 'empty_box']) {
    let play = newPlay();
    const found = token(`unobtainable-${type}`, type, { faceUp: type === 'empty_box' });
    play.tokens.hall_clock = found;
    play = peek(reveal(play), 'hall_clock');
    assert.equal(getPlayView(play, first).resolution.canTake, false);
    rejects(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
    play = act(play, first, { type: 'resolve_peek', take: false });
    assert.deepEqual(play.tokens.hall_clock, found);
    assert.deepEqual(play.inventories[first].tokens, []);
    assert.equal(play.result, null);
  }
});

test('safe guesses require three distinct valid digits, ignore order and never reveal partial matches', () => {
  for (const numbers of [[5, 1, 3], [1, 2, 3]]) {
    let play = newPlay();
    play.round.visitors[0].roomId = 'study_room';
    play = peek(reveal(play), 'study_desk');
    for (const invalid of [[], [1, 3], [1, 1, 5], [0, 3, 5], [1, 3, 7], ['1', 3, 5]]) {
      rejects(play, first, { type: 'safe_guess', numbers: invalid });
    }
    rejects(play, second, { type: 'safe_guess', numbers });
    play = act(play, first, { type: 'safe_guess', numbers });
    const correct = numbers.includes(5);
    assert.equal(play.safeOpened, correct);
    assert.equal(play.inventories[first].tokens.some(held => held.type === 'key'), correct);
    assert.deepEqual(play.publicNumbers, []);
    assert.equal(play.tokens.study_desk.type, 'safe');
    assert.deepEqual(getPlayView(play, first).sharedTokens, { kind: 'safe_result', correct, usedStethoscope: false });
    for (const id of [second, third]) {
      assert.equal(getPlayView(play, id).sharedTokens, null);
      assert.deepEqual(getPlayView(play, id).safe.publicNumbers, []);
      assert.equal(JSON.stringify(getPlayView(play, id)).includes('password'), false);
    }
  }
});

test('stethoscope reveals only a declared matching digit, while same-room hako kills before disclosure', () => {
  for (const [number, sameRoom] of [[3, false], [2, false], [3, true]]) {
    let play = newPlay('stethoscope');
    play.round.visitors[0].roomId = 'study_room';
    if (sameRoom) play.round.hidingCornerId = 'study_books';
    play = peek(reveal(play), 'study_desk');
    rejects(play, first, { type: 'safe_guess', useStethoscope: true, numbers: [1, 3, 5] });
    play = act(play, first, { type: 'safe_guess', useStethoscope: true, numbers: [number] });
    const expected = number === 3 && !sameRoom ? [3] : [];
    for (const id of [first, second, third, hakoId]) assert.deepEqual(getPlayView(play, id).safe.publicNumbers, expected);
    assert.equal(play.safeOpened, false);
    assert.equal(play.opening.safeBoard.key.type, 'key');
    if (sameRoom) {
      assert.equal(play.round.visitors[0].status, 'box_person');
      assert.equal(play.ghosts[0].cornerId, 'study_books');
      assert.equal(play.sharedTokens[first], undefined);
    }
  }
  let withoutItem = newPlay();
  withoutItem.round.visitors[0].roomId = 'study_room';
  withoutItem = peek(reveal(withoutItem), 'study_desk');
  rejects(withoutItem, first, { type: 'safe_guess', useStethoscope: true, numbers: [3] });
});

test('carrying the key or doll wins on the corresponding successful peek and locks the result', () => {
  for (const [carried, target, reason] of [['key', 'hidden_exit', '逃脱'], ['doll', 'remains', '超度']]) {
    let play = newPlay();
    play.inventories[first].tokens.push(token(`winning-${carried}`, carried));
    if (carried === 'key') play.opening.safeBoard.key = null;
    play.tokens.hall_clock = token(`winning-${target}`, target);
    play = peek(reveal(play), 'hall_clock');
    assert.equal(play.result.winner, 'visitors');
    assert.equal(play.result.reason, reason);
    assert.equal(play.result.playerId, first);
    assert.deepEqual(play.result.winners, visitors);
    assert.equal(getPlayView(play, first).phase, 'game_over');
    for (const id of [first, second, third, hakoId]) rejects(play, id, { type: 'surrender' }, /已经结束/);
  }
});

test('weapons require a local target and owned weapon and wait for hako confirmation', () => {
  let play = newPlay();
  const weapon = token('private-weapon', 'weapon', { tool: 'white_stick' });
  play.inventories[first].tokens.push(weapon);
  rejects(play, first, { type: 'use_weapon', cornerId: 'hall_clock', tokenId: weapon.id });
  play = reveal(play);
  rejects(play, first, { type: 'use_weapon', cornerId: 'study_books', tokenId: weapon.id });
  rejects(play, first, { type: 'use_weapon', cornerId: 'hall_clock', tokenId: 'not-owned' });
  play = act(play, first, { type: 'use_weapon', cornerId: 'hall_clock', tokenId: weapon.id });
  assert.equal(play.inventories[first].tokens[0].id, weapon.id);
  assert.equal(play.removedTokens.length, 0);
  assert.equal(getPlayView(play, second).pendingAction.type, 'weapon');
  assert.equal(JSON.stringify(getPlayView(play, second)).includes(weapon.id), false);
  rejects(play, first, { type: 'resolve_visitor_action' });
});

test('a weapon hitting a marker without a hidden actor removes both pieces and leaves the corner empty', () => {
  for (const base of [token('destroyed-password', 'password', { number: 4 }), null]) {
    let play = newPlay();
    play.tokens.hall_clock = base;
    const boxes = play.opening.emptyBoxTokens.length;
    const weapon = token('spent-weapon', 'weapon', { tool: 'rusty_chain' });
    play = attack(reveal(play), 'hall_clock', weapon);
    assert.equal(play.tokens.hall_clock, null);
    assert.deepEqual(play.removedTokens.map(piece => piece.id).sort(), [weapon.id, ...(base ? [base.id] : [])].sort());
    assert.equal(play.opening.emptyBoxTokens.length, boxes);
    assert.equal(play.round.visitors[0].status, 'alive');
    assert.equal(play.round.silent.turnPlayerId, second);
  }
});

test('matching the hako weakness wins immediately', () => {
  let play = newPlay();
  play.round.visitors[0].roomId = 'children_room';
  play = attack(reveal(play), 'children_bed', token('correct-gasoline', 'weapon', { tool: 'gasoline' }));
  assert.equal(play.result.winner, 'visitors');
  assert.equal(play.result.reason, '讨伐');
  assert.equal(play.round.visitors[0].status, 'alive');
  assert.equal(play.ghosts.length, 0);
});

test('wrong weapon at stacked hako banishes old ghosts and base, then stacks the dead attacker at the killer', () => {
  let play = newPlay();
  play.round.visitors[0].roomId = 'children_room';
  const base = token('destroyed-under-hako', 'password', { number: 6 });
  const carried = token('destroyed-ghost-cargo', 'doll');
  play.tokens.children_bed = base;
  addGhost(play, second, 'children_bed', [carried]);
  play = attack(reveal(play), 'children_bed', token('wrong-white-stick', 'weapon', { tool: 'white_stick' }));
  assert.equal(play.result, null);
  assert.equal(play.ghosts.find(ghost => ghost.playerId === second).banished, true);
  assert.equal(play.round.visitors.find(player => player.id === second).status, 'banished');
  assert.equal(play.ghosts.find(ghost => ghost.playerId === first).cornerId, 'children_bed');
  assert.equal(play.round.hidingCornerId, 'children_bed');
  assert.equal(play.tokens.children_bed, null);
  assert.ok([base.id, carried.id, 'wrong-white-stick'].every(id => play.removedTokens.some(piece => piece.id === id)));
  assert.deepEqual(play.round.silent.visitorIds, [third]);
  assert.equal(JSON.stringify(getPlayView(play, third)).includes('gasoline'), false);
});

test('every weapon can banish a box person and removes its base and carried original', () => {
  for (const tool of ['gasoline', 'white_stick', 'rusty_chain']) {
    let play = newPlay();
    const base = token('ghost-base', 'password', { number: 2 });
    const carried = token('ghost-carried', 'weakness_clue', { tool: 'white_stick' });
    play.tokens.hall_clock = base;
    addGhost(play, second, 'hall_clock', [carried]);
    play = attack(reveal(play), 'hall_clock', token(`weapon-${tool}`, 'weapon', { tool }));
    assert.equal(play.ghosts[0].banished, true);
    assert.deepEqual(play.ghosts[0].carriedTokens, []);
    assert.equal(play.tokens.hall_clock, null);
    assert.equal(play.round.visitors[0].status, 'alive');
    assert.ok([base.id, carried.id].every(id => play.removedTokens.some(piece => piece.id === id)));
    assert.deepEqual(getPlayView(play, second).ghost, { status: 'banished' });
    rejects(play, second, { type: 'inspect_hiding_room', roomId: 'hall_room' });
  }
});

test('fatal peeking discards possessions publicly, stacks at the killer even in a one-corner room and removes the silent seat', () => {
  for (const killer of ['hako', 'box_person']) {
    let play = newPlay();
    const held = token('public-on-death', 'key');
    play.inventories[first].tokens.push(held);
    const expectedItems = structuredClone(play.inventories[first].items);
    if (killer === 'hako') play.round.hidingCornerId = 'hall_clock';
    else addGhost(play, second, 'hall_clock');
    play.tokens.hall_clock = token('hidden-exit-under-killer', 'hidden_exit');
    play = peek(reveal(play), 'hall_clock');
    assert.equal(play.result, null, 'the underlying exit must not win before the killer is resolved');
    assert.equal(play.round.visitors[0].status, 'box_person');
    assert.equal(Object.hasOwn(play.round.visitors[0], 'roomId'), false);
    assert.equal(play.ghosts.find(ghost => ghost.playerId === first).cornerId, 'hall_clock');
    assert.equal(play.round.silent.visitorIds.includes(first), false);
    assert.equal(play.round.silent.turnPlayerId, killer === 'hako' ? second : third);
    assert.deepEqual(play.inventories[first], { tokens: [], items: [] });
    for (const id of [first, second, third, hakoId]) {
      const entry = getPlayView(play, id).discarded.find(discard => discard.playerId === first);
      assert.equal(entry.tokens[0].id, held.id);
      assert.deepEqual(entry.items, expectedItems);
      assert.equal(Object.hasOwn(getPlayView(play, id).visitors[0], 'roomId'), false);
    }
    assert.equal(getPlayView(play, third).ghost, undefined);
    rejects(play, first, { type: 'silent_reveal', index: 1 });
  }
});

test('hako and every surviving ghost inspect one room and hide once before silent mode resets', () => {
  let play = newPlay();
  addGhost(play, first, 'children_bed');
  addGhost(play, second, 'children_bed');
  play.round.silent.turnPlayerId = third;
  play.tokens.children_cabinet = token('deduced-empty', 'empty_box', { faceUp: true });
  play = enterHakoStage(play);
  const cycle = play.round.silent.cycle;
  rejects(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  rejects(play, third, { type: 'inspect_hiding_room', roomId: 'children_room' });
  rejects(play, hakoId, { type: 'inspect_hiding_room', roomId: 'living_room' });
  for (const id of [hakoId, first, second]) {
    play = act(play, id, { type: 'inspect_hiding_room', roomId: 'children_room' });
    const privateView = getPlayView(play, id)[id === hakoId ? 'hako' : 'ghost'];
    assert.equal(privateView.inspectedRoom.corners.find(corner => corner.id === 'children_bed').actors.length, 3);
    rejects(play, id, { type: 'inspect_hiding_room', roomId: 'children_room' });
    rejects(play, id, { type: id === hakoId ? 'hako_hide' : 'ghost_hide', cornerId: 'dark_bed' });
    play = act(play, id, { type: id === hakoId ? 'hako_hide' : 'ghost_hide', cornerId: 'children_bed',
      faceDownCornerIds: ['children_cabinet'] });
    if (id !== second) {
      assert.equal(play.round.silent.phase, 'hako_phase');
      assert.equal(play.round.silent.cycle, cycle);
      rejects(play, id, { type: 'inspect_hiding_room', roomId: 'children_room' });
      rejects(play, third, { type: 'silent_reveal', index: 0 });
    }
  }
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.round.silent.cycle, cycle + 1);
  assert.equal(play.round.silent.turnPlayerId, third);
  assert.ok(play.round.silent.cards.every(card => card.status === 'down'));
  assert.equal(play.hakoStage, null);
  assert.equal(play.tokens.children_cabinet.faceUp, false);
  assert.deepEqual(getPlayView(play, third).hako, { playerId: hakoId });
  assert.equal(getPlayView(play, third).ghost, undefined);
});

test('relic ring passes all possessions to a living visitor anywhere or publicly discards all, then its alliance expires', () => {
  for (const inherit of [true, false]) {
    let play = newPlay('relic_ring');
    play.inventories[first].tokens.push(token('ring-key', 'key'), token('ring-password', 'password', { number: 2 }));
    play.opening.safeBoard.key = null;
    const original = structuredClone(play.inventories[first]);
    play.round.visitors[0].roomId = 'children_room';
    play = peek(reveal(play), 'children_bed');
    assert.deepEqual(play.ringAllies, [first]);
    assert.equal(play.resolution.kind, 'inheritance');
    assert.deepEqual(play.inventories[first], original);
    assert.equal(play.discarded.some(entry => entry.playerId === first), false);
    rejects(play, second, { type: 'bequeath', targetId: third });
    rejects(play, first, { type: 'bequeath', targetId: first });
    play = act(play, first, { type: 'bequeath', targetId: inherit ? second : null });
    assert.deepEqual(play.inventories[first], { tokens: [], items: [] });
    assert.equal(play.resolution, null);
    if (inherit) {
      assert.ok(original.tokens.every(piece => play.inventories[second].tokens.some(held => held.id === piece.id)));
      assert.ok(original.items.every(piece => play.inventories[second].items.some(held => held.id === piece.id)));
      let win = structuredClone(play);
      win.tokens.hall_clock = token('ring-exit', 'hidden_exit');
      win = peek(reveal(win, second), 'hall_clock', second);
      assert.ok(win.result.winners.includes(first), 'ring owner should share a visitor win before the next hako phase');
    } else {
      const discarded = play.discarded.find(entry => entry.playerId === first);
      assert.deepEqual(discarded.tokens, original.tokens);
      assert.deepEqual(discarded.items, original.items);
    }
    play = enterHakoStage(play, second);
    assert.deepEqual(play.ringAllies, []);
    assert.equal(play.ghosts[0].playerId, first);
  }
});

test('night vision grants only an available item unselected at setup and leaves notebook disclosure mandatory', () => {
  let play = newPlay('night_vision');
  play.tokens.hall_clock = token('night-notebook', 'notebook', { number: 6 });
  play = peek(reveal(play), 'hall_clock', first, { useNightVision: true });
  const options = getPlayView(play, first).resolution.nightVisionItems.map(candidate => candidate.id);
  assert.ok(options.includes('relic_ring'));
  assert.ok(['night_vision', 'spirit_pen', 'ventriloquist_doll'].every(id => !options.includes(id)));
  for (const itemId of ['night_vision', 'spirit_pen', 'unknown-item', undefined]) {
    rejects(play, first, { type: 'resolve_peek', itemId, replacement: 'empty_box' });
  }
  play = act(play, first, { type: 'resolve_peek', itemId: 'relic_ring', replacement: 'empty_box' });
  assert.ok(play.inventories[first].items.some(candidate => candidate.id === 'relic_ring'));
  assert.equal(play.availableItems.some(candidate => candidate.id === 'relic_ring'), false);
  assert.deepEqual(play.notebooks.map(note => note.number), [6]);
});

test('night vision in the hako room reveals the notebook then kills before obtaining an item, while opting out survives', () => {
  for (const useNightVision of [true, false]) {
    let play = newPlay('night_vision');
    play.round.visitors[0].roomId = 'children_room';
    play.tokens.children_cabinet = token('fatal-night-notebook', 'notebook', { number: 8 });
    play = peek(reveal(play), 'children_cabinet', first, { useNightVision });
    assert.deepEqual(play.notebooks.map(note => note.number), [8]);
    assert.equal(play.round.visitors[0].status, useNightVision ? 'box_person' : 'alive');
    assert.equal(play.availableItems.some(candidate => candidate.id === 'relic_ring'), true);
    if (useNightVision) {
      assert.equal(play.ghosts[0].cornerId, 'children_bed');
      assert.equal(play.tokens.children_cabinet.type, 'empty_box');
      assert.equal(play.inventories[first].items.length, 0);
    } else {
      rejects(play, first, { type: 'resolve_peek', itemId: 'relic_ring', replacement: 'empty_box' });
      play = act(play, first, { type: 'resolve_peek', replacement: 'empty_box' });
      assert.equal(play.round.visitors[0].status, 'alive');
    }
  }
  let withoutItem = reveal(newPlay());
  rejects(withoutItem, first, { type: 'peek', cornerId: 'hall_clock', useNightVision: true });
});

test('showing a held token reveals it only to the selected co-located visitor', () => {
  let play = newPlay();
  const held = token('private-shown-key', 'key');
  play.inventories[first].tokens.push(held);
  rejects(play, first, { type: 'show_token', targetId: first, tokenId: held.id });
  rejects(play, first, { type: 'show_token', targetId: second, tokenId: 'not-owned' });
  play = act(play, first, { type: 'show_token', targetId: second, tokenId: held.id });
  assert.equal(getPlayView(play, second).sharedTokens.token.id, held.id);
  assert.equal(getPlayView(play, second).sharedTokens.fromId, first);
  for (const id of [third, hakoId]) {
    assert.equal(getPlayView(play, id).sharedTokens, null);
    assert.equal(JSON.stringify(getPlayView(play, id)).includes(held.id), false);
  }
  assert.equal(play.inventories[first].tokens[0].id, held.id);
  play.round.visitors[1].roomId = 'study_room';
  rejects(play, first, { type: 'show_token', targetId: second, tokenId: held.id });
});

test('exchange changes no ownership before target acceptance and supports key and visitor-item swaps', () => {
  let play = newPlay();
  play.inventories[first].tokens.push(token('given-key', 'key'));
  play.inventories[second].tokens.push(token('requested-password', 'password', { number: 6 }));
  const before = structuredClone(play.inventories);
  const offer = { type: 'offer_exchange', targetId: second, giveTokenIds: ['given-key'],
    requestTokenIds: ['requested-password'], giveItemIds: ['walkie_talkie'], requestItemIds: ['spirit_pen'] };
  play = act(play, first, offer);
  assert.deepEqual(play.inventories, before);
  assert.deepEqual(getPlayView(play, third).exchangeOffers, []);
  const offerId = play.exchangeOffers[0].id;
  rejects(play, first, { type: 'respond_exchange', offerId, accept: true });
  rejects(play, third, { type: 'respond_exchange', offerId, accept: true });
  let declined = act(play, second, { type: 'respond_exchange', offerId, accept: false });
  assert.deepEqual(declined.inventories, before);
  assert.deepEqual(declined.exchangeOffers, []);
  play = act(play, second, { type: 'respond_exchange', offerId, accept: true });
  assert.deepEqual(play.inventories[first].tokens.map(piece => piece.id), ['requested-password']);
  assert.deepEqual(play.inventories[second].tokens.map(piece => piece.id), ['given-key']);
  assert.deepEqual(play.inventories[first].items.map(piece => piece.id), ['spirit_pen']);
  assert.deepEqual(play.inventories[second].items.map(piece => piece.id), ['walkie_talkie']);
  assert.deepEqual(play.exchangeOffers, []);
});

test('accepting an offer rechecks co-location and current inventories without partial transfer', () => {
  let play = newPlay();
  play.inventories[first].tokens.push(token('offered-token', 'password', { number: 2 }));
  play.inventories[second].tokens.push(token('requested-token', 'key'));
  play = act(play, first, { type: 'offer_exchange', targetId: second,
    giveTokenIds: ['offered-token'], requestTokenIds: ['requested-token'] });
  const offerId = play.exchangeOffers[0].id;
  for (const invalidation of ['location', 'giver-inventory', 'target-inventory']) {
    const changed = structuredClone(play);
    if (invalidation === 'location') changed.round.visitors[1].roomId = 'study_room';
    if (invalidation === 'giver-inventory') changed.inventories[first].tokens = [];
    if (invalidation === 'target-inventory') changed.inventories[second].tokens = [];
    rejects(changed, second, { type: 'respond_exchange', offerId, accept: true });
    assert.equal(changed.exchangeOffers.length, 1);
  }
});

test('guessing someone else token ID produces identical offer creation and initiator views whether the piece exists or not', () => {
  const baseline = newPlay();
  const results = [];
  for (const exists of [true, false]) {
    let play = structuredClone(baseline);
    play.inventories[second].tokens.push(token(exists ? 'guessed-secret-id' : 'another-secret-id', 'key'));
    play = act(play, first, { type: 'offer_exchange', targetId: second, requestTokenIds: ['guessed-secret-id'] });
    results.push(getPlayView(play, first));
    assert.equal(play.exchangeOffers.length, 1);
    if (!exists) rejects(play, second, { type: 'respond_exchange', offerId: play.exchangeOffers[0].id, accept: true });
  }
  assert.deepEqual(results[0], results[1]);
});

test('dropping is a free action into a local unoccupied corner and relinquishes ownership', () => {
  let play = newPlay();
  const held = token('dropped-key', 'key');
  play.inventories[first].tokens.push(held);
  rejects(play, first, { type: 'drop_token', cornerId: 'study_books', tokenId: held.id });
  rejects(play, first, { type: 'drop_token', cornerId: 'hall_clock', tokenId: held.id });
  play.tokens.hall_clock = null;
  play.round.hidingCornerId = 'hall_clock';
  rejects(play, first, { type: 'drop_token', cornerId: 'hall_clock', tokenId: held.id });
  play.round.hidingCornerId = 'children_bed';
  rejects(play, first, { type: 'drop_token', cornerId: 'hall_clock', tokenId: 'not-owned' });
  play = act(play, first, { type: 'drop_token', cornerId: 'hall_clock', tokenId: held.id });
  assert.deepEqual(play.tokens.hall_clock, held);
  assert.deepEqual(play.inventories[first].tokens, []);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(JSON.stringify(getPlayView(play, second)).includes(held.id), false);
});

test('all three permanently broken routes end the game, while a weapon hidden under hako keeps its route possible', () => {
  for (const keepWeapon of [true, false]) {
    let play = newPlay();
    for (const cornerId of Object.keys(play.tokens)) play.tokens[cornerId] = token(`empty-${cornerId}`, 'empty_box');
    if (keepWeapon) play.tokens.children_bed = token('hidden-winning-weapon', 'weapon', { tool: 'gasoline' });
    play = reveal(play);
    if (keepWeapon) assert.equal(play.result, null);
    else {
      assert.equal(play.result.winner, 'hako');
      assert.match(play.result.reason, /三条/);
      rejects(play, first, { type: 'peek', cornerId: 'hall_clock' }, /已经结束/);
    }
  }
});

test('all visitors dying ends the game with every box person on the hako side and prevents further actions', () => {
  let play = newPlay();
  play.round.hidingCornerId = 'hall_clock';
  for (const id of visitors) play = peek(reveal(play, id), 'hall_clock', id);
  assert.equal(play.result.winner, 'hako');
  assert.match(play.result.reason, /所有访问者/);
  assert.deepEqual(play.result.winners, [hakoId, ...visitors]);
  assert.deepEqual(play.round.silent.visitorIds, []);
  for (const id of [hakoId, ...visitors]) rejects(play, id, { type: 'inspect_hiding_room', roomId: 'hall_room' }, /已经结束/);
});

test('nested player views detach inventories, reveals, public state, offers and inspected rooms from internal state', () => {
  let play = newPlay();
  play.inventories[first].tokens.push(token('detached-secret', 'password', { number: 4 }));
  play = act(play, first, { type: 'show_token', targetId: second, tokenId: 'detached-secret' });
  play = act(play, first, { type: 'offer_exchange', targetId: second, giveTokenIds: ['detached-secret'] });
  const before = JSON.stringify(play);
  const own = getPlayView(play, first);
  own.inventory.tokens[0].number = 99;
  own.inventory.items[0].name = 'changed';
  own.exchangeOffers[0].giveTokenIds.push('changed');
  own.exchangeOffers[0].giveTokens[0].number = 99;
  own.visitors[0].roomId = 'changed';
  own.safe.publicNumbers.push(99);
  own.cornerState[0].occupied = false;
  own.silent.cards[0].number = 99;
  const target = getPlayView(play, second);
  target.sharedTokens.token.number = 99;
  assert.equal(JSON.stringify(play), before);
  assert.throws(() => getPlayView(play, 'outsider'), /本局玩家/);
  play = enterHakoStage(play, first);
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  const inspectedBefore = JSON.stringify(play);
  const view = getPlayView(play, hakoId);
  view.hako.hidingTargets.push('changed');
  view.hako.inspectedRoom.corners[0].token.id = 'changed';
  view.hako.inspectedRoom.corners[0].actors.push({ playerId: 'changed' });
  assert.equal(JSON.stringify(play), inspectedBefore);
});
