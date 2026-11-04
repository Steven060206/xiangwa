import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import {
  INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower, getOpeningView,
} from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hakoId = 'hako';
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const item = id => structuredClone(INITIAL_ITEMS.find(candidate => candidate.id === id));
const token = (id, type, fields = {}) => ({ id, type, ...fields });

function newOpening(firstItem = 'walkie_talkie') {
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
  opening.initialPowerCandidates = [1, 4, 11];
  return { setup, opening };
}

function newPlay(firstItem = 'walkie_talkie') {
  const { setup, opening } = newOpening(firstItem);
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

test('peek declaration and resolution disclose the selected corner only to its actor', () => {
  let play = reveal(newPlay());
  play.tokens.hall_clock = token('private-peek-target-content', 'key');
  play = act(play, first, { type: 'peek', cornerId: 'hall_clock' });
  assert.equal(getPlayView(play, first).pendingAction.cornerId, 'hall_clock');
  for (const id of [hakoId, second, third]) {
    assert.deepEqual(getPlayView(play, id).pendingAction, { type: 'peek', playerId: first });
  }
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, first).resolution.cornerId, 'hall_clock');
  for (const id of [hakoId, second, third]) {
    assert.deepEqual(getPlayView(play, id).resolution, { kind: 'waiting', playerId: first });
    assert.equal(JSON.stringify(getPlayView(play, id)).includes('private-peek-target-content'), false);
  }
});

test('notebook replacement never exposes a temporary vacant corner to Hako, visitors or ghosts', () => {
  for (const replacement of ['empty_box', 'owned-piece']) {
    let play = newPlay();
    addGhost(play, third, 'children_toys');
    play.tokens.hall_clock = token('private-notebook-position', 'notebook', { number: 7 });
    play.inventories[first].tokens.push(token('owned-piece', 'password', { number: 2 }));
    play = reveal(play);
    const observers = [hakoId, second, third];
    const before = new Map(observers.map(id => [id, getPlayView(play, id).cornerState]));
    play = act(play, first, { type: 'peek', cornerId: 'hall_clock' });
    for (const id of observers) {
      assert.deepEqual(getPlayView(play, id).cornerState, before.get(id));
      assert.deepEqual(getPlayView(play, id).pendingAction, { type: 'peek', playerId: first });
    }
    play = act(play, hakoId, { type: 'resolve_visitor_action' });
    assert.equal(play.tokens.hall_clock, null, 'the real notebook has already left the map');
    assert.equal(getPlayView(play, first).cornerState.find(corner => corner.id === 'hall_clock').occupied, false);
    assert.equal(getPlayView(play, first).resolution.cornerId, 'hall_clock');
    for (const id of observers) {
      const view = getPlayView(play, id);
      assert.deepEqual(view.cornerState, before.get(id), 'temporary vacancy must not disclose the private target');
      assert.deepEqual(view.resolution, { kind: 'waiting', playerId: first });
      assert.deepEqual(view.notebooks.map(note => note.number), [7], 'notebook effects remain public immediately');
    }
    // The same whitelist must protect old/persisted pending notebook resolutions.
    play = JSON.parse(JSON.stringify(play));
    for (const id of observers) assert.deepEqual(getPlayView(play, id).cornerState, before.get(id));
    play = act(play, first, { type: 'resolve_peek', replacement });
    for (const id of observers) assert.deepEqual(getPlayView(play, id).cornerState, before.get(id));
  }
});

test('completed notebook replacement reveals intentional X markers and genuine permanent empty corners', () => {
  for (const leaveEmpty of [false, true]) {
    let play = newPlay('deduction');
    play.tokens.hall_clock = token('public-replacement-note', 'notebook', { number: 7 });
    if (leaveEmpty) play.opening.emptyBoxTokens = [];
    play = peek(reveal(play), 'hall_clock');
    for (const id of [hakoId, second, third]) {
      assert.deepEqual(getPlayView(play, id).cornerState.find(corner => corner.id === 'hall_clock'),
        { id: 'hall_clock', roomId: 'hall_room', occupied: true });
    }
    play = act(play, first, { type: 'resolve_peek', replacement: leaveEmpty ? 'none' : 'empty_box', faceUp: !leaveEmpty });
    for (const id of [hakoId, first, second, third]) {
      const corner = getPlayView(play, id).cornerState.find(corner => corner.id === 'hall_clock');
      assert.equal(corner.occupied, !leaveEmpty, 'completed physical changes are public, not permanently masked');
      if (!leaveEmpty) assert.equal(corner.faceUp, true);
    }
  }
});

test('terminal snapshots disclose the real vacancy even if a saved notebook resolution remains', () => {
  let play = newPlay();
  play.tokens.hall_clock = token('terminal-note', 'notebook', { number: 7 });
  play = peek(reveal(play), 'hall_clock');
  play.result = { winner: 'hako', reason: '三条访问者胜利路线均已无法达成', winners: [hakoId] };
  play = JSON.parse(JSON.stringify(play));
  for (const id of [hakoId, first, second, third]) {
    const view = getPlayView(play, id);
    assert.equal(view.cornerState.find(corner => corner.id === 'hall_clock').occupied, false);
    assert.equal(view.review.corners.find(corner => corner.id === 'hall_clock').token, null);
  }
});

test('ordinary token pickup and safe-key retrieval do not expose intermediate target occupancy changes', () => {
  for (const safe of [false, true]) {
    let play = newPlay();
    addGhost(play, third, 'children_toys');
    play.tokens.hall_clock = token('private-pickup-position', safe ? 'safe' : 'password', { number: 2 });
    play = reveal(play);
    const before = getPlayView(play, hakoId).cornerState;
    play = peek(play, 'hall_clock');
    for (const id of [hakoId, second, third]) assert.deepEqual(getPlayView(play, id).cornerState, before);
    play = act(play, first, safe ? { type: 'safe_guess', numbers: [1, 3, 5] }
      : { type: 'resolve_peek', take: true, replacement: 'empty_box' });
    for (const id of [hakoId, second, third]) assert.deepEqual(getPlayView(play, id).cornerState, before);
    assert.ok(play.inventories[first].tokens.some(piece => piece.type === (safe ? 'key' : 'password')));
  }
});

test('Hako sees current separate card and token counts without receiving visitor inventory lists', () => {
  const play = newPlay();
  play.inventories[first].items.push(item('night_vision'));
  play.inventories[first].tokens.push(token('count-secret-password', 'password', { number: 2 }));
  const hako = getPlayView(play, hakoId);
  assert.equal(hako.visitors[0].itemCount, 2);
  assert.equal(hako.visitors[0].tokenCount, 1);
  assert.deepEqual(hako.inventory, { items: [], tokens: [] });
  assert.equal(Object.hasOwn(hako.visitors[0], 'items'), false);
  assert.equal(JSON.stringify(hako).includes('count-secret-password'), false);
  assert.equal(Object.hasOwn(getPlayView(play, second).visitors[0], 'itemCount'), false);
});

test('death removes acquired skills permanently and skips inheritance when only cards were held', () => {
  let play = newPlay('night_vision');
  play.tokens.hall_clock = token('acquire-skill-notebook', 'notebook', { number: 6 });
  play = peek(reveal(play), 'hall_clock', first, { useNightVision: true });
  play = act(play, first, { type: 'resolve_peek', itemId: 'smartphone', replacement: 'empty_box' });
  assert.equal(play.availableItems.some(card => card.id === 'smartphone'), false);
  Object.assign(play.round.silent, { phase: 'visitor_action', turnPlayerId: first });
  play.round.hidingCornerId = 'hall_clock';
  play = peek(play, 'hall_clock');
  assert.deepEqual(play.inventories[first], { items: [], tokens: [] });
  assert.equal(play.resolution, null);
  assert.ok(['night_vision', 'smartphone'].every(id => play.removedItems.some(card => card.id === id)));
  assert.equal(play.availableItems.some(card => card.id === 'smartphone'), false);
  assert.equal(play.inventories[second].items.some(card => card.id === 'smartphone'), false);
});

test('the final ring owner retains visitor allegiance rather than joining Hako winners', () => {
  let play = newPlay('relic_ring');
  addGhost(play, second, 'children_bed');
  addGhost(play, third, 'children_bed');
  play.round.hidingCornerId = 'hall_clock';
  play = peek(reveal(play), 'hall_clock');
  assert.equal(play.result.winner, 'hako');
  assert.ok(play.ringAllies.includes(first));
  assert.equal(play.result.winners.includes(first), false);
  assert.equal(play.resolution, null);
});

test('precise public death positions become fixed history when later hidden actions begin', () => {
  let play = newPlay();
  play.round.hidingCornerId = 'hall_clock';
  play = peek(reveal(play), 'hall_clock');
  for (const id of [hakoId, first, second, third]) {
    const view = getPlayView(play, id);
    assert.equal(view.deathLocations[0].cornerId, 'hall_clock');
    assert.equal(view.deathLocations[0].userId, first);
    assert.equal(view.deathEvents.length, 1);
  }
  play = enterHakoStage(play, second);
  play.ghosts.find(ghost => ghost.playerId === first).cornerId = 'children_toys';
  const view = getPlayView(play, second);
  assert.deepEqual(view.deathLocations, []);
  assert.equal(view.deathEvents[0].cornerId, 'hall_clock');
  assert.equal(Object.hasOwn(view.visitors[0], 'cornerId'), false);
  assert.equal(Object.hasOwn(view, 'alliedActors'), false);
});

test('weapons are consumed once at resolution, survive interrupted declarations and remain spent after restart', () => {
  let play = reveal(newPlay());
  const weapon = token('single-use-weapon', 'weapon', { tool: 'white_stick' });
  play.inventories[first].tokens.push(weapon);
  play = act(play, first, { type: 'use_weapon', cornerId: 'hall_clock', tokenId: weapon.id });
  assert.ok(play.inventories[first].tokens.some(token => token.id === weapon.id));
  const interrupted = structuredClone(play);
  interrupted.powers.slots[0] = { id: 6, ignoreThreshold: true, faceUp: false };
  const afterInterrupt = act(interrupted, hakoId, { type: 'activate_power', slot: 0 });
  assert.ok(afterInterrupt.inventories[first].tokens.some(token => token.id === weapon.id));
  assert.equal(afterInterrupt.removedTokens.some(token => token.id === weapon.id), false);
  play = act(play, hakoId, { type: 'resolve_visitor_action' });
  play = JSON.parse(JSON.stringify(play));
  Object.assign(play.round.silent, { phase: 'visitor_action', turnPlayerId: first });
  assert.ok(play.removedTokens.some(token => token.id === weapon.id));
  rejects(play, first, { type: 'use_weapon', cornerId: 'hall_clock', tokenId: weapon.id });
});

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

test('fatal peeking requires passing possessions to a survivor, stacks at the killer and removes the silent seat', () => {
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
    assert.equal(play.resolution.kind, 'inheritance');
    assert.equal(play.resolution.playerId, first);
    assert.deepEqual(play.inventories[first], { tokens: [held], items: [] });
    assert.ok(expectedItems.every(item => play.removedItems.some(piece => piece.id === item.id)));
    for (const id of [first, second, third, hakoId]) {
      const entry = getPlayView(play, id).discarded.find(discard => discard.playerId === first);
      assert.equal(entry, undefined, 'a required inheritance is never published as discarded possessions');
      assert.equal(Object.hasOwn(getPlayView(play, id).visitors[0], 'roomId'), false);
    }
    assert.equal(getPlayView(play, third).ghost, undefined);
    rejects(play, first, { type: 'silent_reveal', index: 1 });
    rejects(play, first, { type: 'bequeath', targetId: null });
    rejects(play, first, { type: 'bequeath', targetId: first });
    const heir = killer === 'hako' ? second : third;
    play = act(play, first, { type: 'bequeath', targetId: heir });
    assert.deepEqual(play.inventories[first], { tokens: [], items: [] });
    assert.ok(play.inventories[heir].tokens.some(piece => piece.id === held.id));
    assert.ok(expectedItems.every(item => !play.inventories[heir].items.some(piece => piece.id === item.id)));
    assert.equal(play.resolution, null);
    assert.deepEqual(play.ringAllies, [], 'mandatory inheritance does not grant the ring-only alliance');
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
    assert.deepEqual(privateView.inspectedRoom.corners.find(corner => corner.id === 'children_bed'), { id: 'children_bed' });
    const visibleEmpty = privateView.inspectedRoom.corners.find(corner => corner.id === 'children_cabinet').token;
    if (id === hakoId) assert.equal(visibleEmpty.type, 'empty_box');
    else assert.equal(visibleEmpty, undefined, 'Re-covered public markers no longer reveal their content');
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

test('confirming initial hiding preserves only its replaced marker privately during power selection and exploration', () => {
  const { setup, opening } = newOpening();
  assert.equal(opening.phase, 'power');
  const memory = getOpeningView(opening, hakoId).lastInspectedRoom;
  assert.equal(memory.id, 'children_room');
  assert.equal(memory.cycle, 0);
  assert.deepEqual(memory.corners.map(corner => corner.id), ['children_bed']);
  for (const corner of memory.corners) {
    assert.deepEqual(corner.token, corner.id === opening.hidingCornerId
      ? opening.hidingUnderToken : opening.cornerTokens[corner.id]);
    assert.notEqual(corner.token?.type, 'hako', 'The memory restores the marker seen before the hiding actor was placed');
  }
  for (const id of visitors) assert.equal(Object.hasOwn(getOpeningView(opening, id), 'lastInspectedRoom'), false);
  const before = JSON.stringify(opening);
  memory.corners.push({ id: 'forged-corner', token: token('forged-token', 'key') });
  assert.equal(JSON.stringify(opening), before, 'The opening history returned to a player is detached');
  const expected = getOpeningView(opening, hakoId).lastInspectedRoom;
  chooseInitialPower(opening, hakoId, 1);
  const play = createPlay(setup, opening);
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, expected);
  for (const id of visitors) {
    assert.equal(Object.hasOwn(getPlayView(play, id).hako, 'lastInspectedRoom'), false);
    assert.equal(JSON.stringify(getPlayView(play, id)).includes('hidingMemories'), false);
  }
});

test('confirmed hiding retains only its replaced marker through other corner changes until another hiding is confirmed', () => {
  let play = newPlay();
  play.tokens.children_cabinet = token('remembered-password', 'password', { number: 2 });
  play.inventories[first].tokens.push(token('later-dropped-clue', 'weakness_clue', { tool: 'white_stick' }));
  play.round.visitors[0].roomId = 'children_room';
  play.opening.emptyBoxTokens = [];
  play = enterHakoStage(play, first);
  const inspectedCycle = play.round.silent.cycle;
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  assert.equal(JSON.stringify(getPlayView(play, hakoId).hako.inspectedRoom).includes('remembered-password'), false);
  play = act(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  const memory = structuredClone(getPlayView(play, hakoId).hako.lastInspectedRoom);
  assert.equal(memory.cycle, inspectedCycle);
  assert.deepEqual(memory.corners.map(corner => corner.id), ['children_bed']);
  assert.equal(Object.hasOwn(getPlayView(play, hakoId).hako, 'inspectedRoom'), false);
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, memory);

  play = peek(reveal(play), 'children_cabinet');
  play = act(play, first, { type: 'resolve_peek', take: true, replacement: 'none' });
  assert.equal(play.tokens.children_cabinet, null);
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, memory, 'Taking a marker cannot update old knowledge');
  play = act(play, first, { type: 'drop_token', cornerId: 'children_cabinet', tokenId: 'later-dropped-clue' });
  assert.equal(play.tokens.children_cabinet.id, 'later-dropped-clue');
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, memory, 'Dropping a new marker cannot update old knowledge');

  const before = JSON.stringify(play);
  const detached = getPlayView(play, hakoId).hako.lastInspectedRoom;
  detached.id = 'forged-room';
  detached.corners[0].token = token('forged-marker', 'key');
  detached.corners.pop();
  assert.equal(JSON.stringify(play), before, 'History tokens, actors and arrays must all be cloned');

  play = enterHakoStage(play, first);
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, memory);
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, memory, 'Choosing a room does not reveal new markers');
  play = act(play, hakoId, { type: 'hako_hide', cornerId: 'children_cabinet' });
  const refreshed = getPlayView(play, hakoId).hako.lastInspectedRoom;
  assert.equal(refreshed.cycle, inspectedCycle + 1);
  assert.equal(refreshed.corners.find(corner => corner.id === 'children_cabinet').token.id, 'later-dropped-clue');
  assert.equal(JSON.stringify(refreshed).includes('remembered-password'), false);
});

test('each hidden actor retains only their own latest replaced marker and never another actor records', () => {
  let play = newPlay();
  addGhost(play, first, 'children_bed');
  addGhost(play, second, 'children_bed');
  play = enterHakoStage(play, third);
  play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  play = act(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  const hakoMemory = structuredClone(getPlayView(play, hakoId).hako.lastInspectedRoom);
  assert.equal(Object.hasOwn(getPlayView(play, hakoId).hako, 'inspectedRoom'), false,
    'A finished actor must stop receiving the live room view while others are still hiding');
  play = act(play, first, { type: 'inspect_hiding_room', roomId: 'children_room' });
  assert.equal(getPlayView(play, first).ghost.lastInspectedRoom, undefined);
  play = act(play, first, { type: 'ghost_hide', cornerId: 'children_cabinet' });
  const firstMemory = structuredClone(getPlayView(play, first).ghost.lastInspectedRoom);
  assert.equal(Object.hasOwn(getPlayView(play, hakoId).hako, 'inspectedRoom'), false);
  assert.equal(Object.hasOwn(getPlayView(play, first).ghost, 'inspectedRoom'), false);
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, hakoMemory);
  play = act(play, second, { type: 'inspect_hiding_room', roomId: 'children_room' });
  play = act(play, second, { type: 'ghost_hide', cornerId: 'children_bed' });
  const secondMemory = structuredClone(getPlayView(play, second).ghost.lastInspectedRoom);
  assert.notDeepEqual(firstMemory.corners, secondMemory.corners, 'Different chosen corners produce separate one-marker records');
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, hakoMemory);
  assert.equal(getPlayView(play, hakoId).ghost, undefined);
  for (const [id, expected] of [[first, firstMemory], [second, secondMemory]]) {
    const view = getPlayView(play, id);
    assert.deepEqual(view.ghost.lastInspectedRoom, expected);
    assert.equal(Object.hasOwn(view.hako, 'lastInspectedRoom'), false);
    assert.equal(JSON.stringify(view).includes('hidingMemories'), false);
  }
  const living = getPlayView(play, third);
  assert.equal(Object.hasOwn(living.hako, 'lastInspectedRoom'), false);
  assert.equal(living.ghost, undefined);
});

test('old saves recover only the initially replaced marker and never reconstruct current hidden contents', () => {
  const play = newPlay();
  const expected = structuredClone(getPlayView(play, hakoId).hako.lastInspectedRoom);
  delete play.hidingMemories;
  play.round.silent.cycle = 8;
  play.tokens.children_bed = token('unseen-current-bed', 'password', { number: 6 });
  play.tokens.children_cabinet = token('unseen-current-cabinet', 'key');
  addGhost(play, first, 'children_cabinet');
  const before = JSON.stringify(play);
  const memory = getPlayView(play, hakoId).hako.lastInspectedRoom;
  assert.deepEqual(memory, expected);
  assert.equal(memory.cycle, 0, 'An initial memory must not be labelled as a later inspection');
  assert.equal(JSON.stringify(memory).includes('unseen-current-'), false);
  assert.equal(Object.hasOwn(getPlayView(play, first).ghost, 'lastInspectedRoom'), false);
  assert.equal(Object.hasOwn(getPlayView(play, second).hako, 'lastInspectedRoom'), false);
  memory.corners.push({ id: 'forged-corner', token: null });
  assert.deepEqual(getPlayView(play, hakoId).hako.lastInspectedRoom, expected);
  assert.equal(JSON.stringify(play), before, 'Reading a legacy save must not mutate or populate its state');
});

test('older named weapon memories display 白木椿 without changing saved IDs or private history', () => {
  const play = newPlay();
  play.hidingMemories[hakoId] = { id: 'children_room', cycle: 2, replacedCornerId: 'children_bed',
    corners: [{ id: 'children_bed', token: token('old-white-stick', 'weapon', { tool: 'white_stick', name: '白木棒' }) }] };
  const before = JSON.stringify(play);
  const remembered = getPlayView(play, hakoId).hako.lastInspectedRoom.corners[0].token;
  assert.equal(remembered.name, '白木椿');
  assert.equal(remembered.id, 'old-white-stick');
  assert.equal(remembered.tool, 'white_stick');
  assert.equal(JSON.stringify(play), before);
});

test('legacy saves waiting to confirm hiding replace old whole-room knowledge with the single newly replaced marker', () => {
  for (const absent of [true, false]) {
    let play = newPlay();
    const initialMemory = structuredClone(getPlayView(play, hakoId).hako.lastInspectedRoom);
    play.tokens.children_cabinet = token('legacy-confirmed-password', 'password', { number: 4 });
    play = enterHakoStage(play);
    play = act(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
    if (absent) delete play.hidingMemories;
    else play.hidingMemories[hakoId] = { ...initialMemory,
      corners: [...initialMemory.corners, { id: 'children_cabinet', token: token('legacy-secret-extra', 'key') }] };
    if (!absent) assert.equal(JSON.stringify(getPlayView(play, hakoId).hako.lastInspectedRoom).includes('legacy-secret-extra'), false);
    play = act(play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
    const memory = getPlayView(play, hakoId).hako.lastInspectedRoom;
    assert.equal(memory.cycle, play.round.silent.cycle - 1);
    assert.deepEqual(memory.corners.map(corner => corner.id), ['children_bed']);
    assert.equal(JSON.stringify(memory).includes('legacy-confirmed-password'), false);
  }
});

test('relic ring passes tokens to a living visitor anywhere, removes skills and its special alliance expires', () => {
    let play = newPlay('relic_ring');
    play.inventories[first].tokens.push(token('ring-key', 'key'), token('ring-password', 'password', { number: 2 }));
    play.opening.safeBoard.key = null;
    const original = structuredClone(play.inventories[first]);
    play.round.visitors[0].roomId = 'children_room';
    play = peek(reveal(play), 'children_bed');
    assert.deepEqual(play.ringAllies, [first]);
    assert.equal(play.resolution.kind, 'inheritance');
    assert.deepEqual(play.inventories[first], { tokens: original.tokens, items: [] });
    assert.equal(play.discarded.some(entry => entry.playerId === first), false);
    rejects(play, second, { type: 'bequeath', targetId: third });
    rejects(play, first, { type: 'bequeath', targetId: first });
    rejects(play, first, { type: 'bequeath', targetId: null });
    play = act(play, first, { type: 'bequeath', targetId: second });
    assert.deepEqual(play.inventories[first], { tokens: [], items: [] });
    assert.equal(play.resolution, null);
      assert.ok(original.tokens.every(piece => play.inventories[second].tokens.some(held => held.id === piece.id)));
      assert.ok(original.items.every(piece => !play.inventories[second].items.some(held => held.id === piece.id)));
      let win = structuredClone(play);
      win.tokens.hall_clock = token('ring-exit', 'hidden_exit');
      win = peek(reveal(win, second), 'hall_clock', second);
      assert.ok(win.result.winners.includes(first), 'ring owner should share a visitor win before the next hako phase');
    play = enterHakoStage(play, second);
    assert.deepEqual(play.ringAllies, []);
    assert.equal(play.ghosts[0].playerId, first);
});

test('night vision grants only an available item unselected at setup and leaves notebook disclosure mandatory', () => {
  let play = newPlay('night_vision');
  play.availableItems.find(item => item.id === 'suitcase').description = '卡面未注明动作消耗。';
  play.tokens.hall_clock = token('night-notebook', 'notebook', { number: 6 });
  play = peek(reveal(play), 'hall_clock', first, { useNightVision: true });
  const available = getPlayView(play, first).resolution.nightVisionItems;
  const options = available.map(candidate => candidate.id);
  assert.equal(available.find(item => item.id === 'suitcase').description,
    INITIAL_ITEMS.find(item => item.id === 'suitcase').description, 'Night vision explains the current item effect even after loading older inventory');
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
      assert.deepEqual(play.inventories[first].items, []);
      assert.equal(play.resolution, null, 'no carried tokens means no inheritance step');
      assert.equal(play.inventories[first].items.length, 0);
      assert.ok(!play.inventories[second].items.some(item => item.id === 'night_vision'));
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
  for (const [index, id] of visitors.entries()) {
    play = peek(reveal(play, id), 'hall_clock', id);
    assert.equal(play.resolution, null, 'cards alone never create an inheritance');
  }
  assert.equal(play.result.winner, 'hako');
  assert.match(play.result.reason, /所有访问者/);
  assert.deepEqual(play.result.winners, [hakoId, ...visitors]);
  assert.deepEqual(play.round.silent.visitorIds, []);
  for (const id of [hakoId, ...visitors]) rejects(play, id, { type: 'inspect_hiding_room', roomId: 'hall_room' }, /已经结束/);
});

test('all corners in a printed board are peek targets without spending an internal move, including old subdivision positions', () => {
  let play = newPlay();
  play.round.visitors[0].roomId = 'toilet_stall';
  play.tokens.bathroom_toilet = token('whole-board-password', 'password', { number: 2 });
  play = reveal(play);
  const view = getPlayView(play, first);
  assert.equal(view.visitors[0].roomId, 'bathroom_room');
  for (const id of ['bathroom_tub', 'bathroom_washer', 'bathroom_toilet']) assert.ok(view.peekTargets.includes(id));
  assert.ok(!view.moveTargets.includes('toilet_stall'));
  play = peek(play, 'bathroom_toilet');
  assert.equal(getPlayView(play, first).resolution.token.id, 'whole-board-password');
});

test('visitors can globally publish held markers without spending an action or disclosing other possessions', () => {
  let play = newPlay();
  play.inventories[first].tokens.push(token('public-password', 'password', { number: 2 }), token('private-key', 'key'));
  play.round.visitors[1].roomId = 'basement_room';
  const silent = structuredClone(play.round.silent);
  rejects(play, second, { type: 'publish_token', tokenId: 'public-password' });
  rejects(play, hakoId, { type: 'publish_token', tokenId: 'public-password' });
  play = act(play, first, { type: 'publish_token', tokenId: 'public-password' });
  assert.deepEqual(play.round.silent, silent);
  assert.equal(play.inventories[first].tokens.length, 2);
  for (const id of [hakoId, ...visitors]) {
    const view = getPlayView(play, id);
    assert.equal(view.publicDiscoveries[0].playerId, first);
    assert.equal(view.publicDiscoveries[0].token.id, 'public-password');
    if (id !== first) assert.equal(JSON.stringify(view).includes('private-key'), false);
    view.publicDiscoveries[0].token.number = 99;
    assert.equal(getPlayView(play, id).publicDiscoveries[0].token.number, 2);
  }
  rejects(play, first, { type: 'publish_token', tokenId: 'public-password' });
  rejects(play, second, { type: 'publish_token', tokenId: 'public-password' });
});

test('a current private peek may be published before taking, while its historical record survives later replacement', () => {
  let play = newPlay();
  play.tokens.hall_clock = token('peeked-password', 'password', { number: 4 });
  play = peek(reveal(play), 'hall_clock');
  assert.equal(getPlayView(play, second).publicDiscoveries.length, 0);
  rejects(play, second, { type: 'publish_token', tokenId: 'peeked-password' });
  const silent = structuredClone(play.round.silent);
  const resolution = structuredClone(play.resolution);
  play = act(play, first, { type: 'publish_token', tokenId: 'peeked-password' });
  assert.deepEqual(play.round.silent, silent);
  assert.deepEqual(play.resolution, resolution);
  assert.equal(Object.hasOwn(play.publicDiscoveries[0], 'cornerId'), false);
  play = act(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
  assert.equal(play.tokens.hall_clock.type, 'empty_box');
  const publicRecord = getPlayView(play, third).publicDiscoveries[0];
  assert.equal(publicRecord.token.id, 'peeked-password');
  assert.equal(Object.hasOwn(publicRecord, 'cornerId'), false);
  assert.equal(play.publicDiscoveries.length, 1);
});

test('published discoveries strip historical corner, room and source fields from every player view', () => {
  const play = newPlay();
  play.publicDiscoveries = [{ playerId: first, cornerId: 'hall_clock', cornerNumber: '01',
    roomId: 'hall_room', source: 'private_peek', cycle: 1,
    token: token('legacy-public-password', 'password', { number: 4, cornerId: 'hall_clock', source: 'private_peek' }) }];
  const before = JSON.stringify(play);
  for (const id of [hakoId, ...visitors]) {
    const [entry] = getPlayView(play, id).publicDiscoveries;
    assert.deepEqual(Object.keys(entry).sort(), ['cycle', 'playerId', 'token']);
    assert.deepEqual(Object.keys(entry.token).sort(), ['id', 'name', 'number', 'type']);
    assert.equal(entry.token.name, '密码4');
    assert.equal(JSON.stringify(entry).includes('hall_clock'), false);
    assert.equal(JSON.stringify(entry).includes('private_peek'), false);
  }
  assert.equal(JSON.stringify(play), before);
});

test('notebooks are automatically public and cannot be redundantly published', () => {
  let play = newPlay();
  play.tokens.hall_clock = token('auto-public-note', 'notebook', { number: 3 });
  play = peek(reveal(play), 'hall_clock');
  assert.equal(getPlayView(play, first).resolution.canPublish, false);
  rejects(play, first, { type: 'publish_token', tokenId: 'auto-public-note' }, /手记.*自动公开/);
  assert.deepEqual(play.notebooks.map(note => note.id), ['auto-public-note']);
  assert.deepEqual(play.publicDiscoveries, []);
});

test('current possessions can be privately shown to a living roommate during every game window', () => {
  for (const window of ['reveal', 'action', 'pending', 'resolution', 'interruption', 'hako', 'multiple_reveals']) {
    let play = newPlay();
    play.inventories[first].tokens.push(token('roommate-password', 'password', { number: 4 }));
    play.round.visitors[2].roomId = 'basement_room';
    if (window === 'action') play = reveal(play);
    if (window === 'pending') play = act(reveal(play), first, { type: 'move', roomId: 'study_room' });
    if (window === 'resolution') {
      play.tokens.hall_clock = token('unshared-peek', 'password', { number: 6 });
      play = peek(reveal(play), 'hall_clock');
    }
    if (window === 'interruption') play.interruption = { kind: 'noise', responders: [second], passed: [] };
    if (window === 'hako') play = enterHakoStage(play);
    if (window === 'multiple_reveals') play.round.silent.revealsRemaining = 1;
    const control = structuredClone({ silent: play.round.silent, pending: play.round.pendingAction,
      resolution: play.resolution, interruption: play.interruption });
    assert.deepEqual(getPlayView(play, first).sharePartners.map(partner => partner.id), [second], window);
    rejects(play, first, { type: 'show_possession', targetId: third, tokenId: 'roommate-password' });
    rejects(play, first, { type: 'show_possession', targetId: first, tokenId: 'roommate-password' });
    rejects(play, hakoId, { type: 'show_possession', targetId: second, itemId: 'walkie_talkie' });
    rejects(play, first, { type: 'show_possession', targetId: second, itemId: 'missing-item' });
    rejects(play, first, { type: 'show_possession', targetId: second, tokenId: 'roommate-password', itemId: 'walkie_talkie' });
    play = act(play, first, { type: 'show_possession', targetId: second, tokenId: 'roommate-password' });
    const shown = getPlayView(play, second).sharedTokens;
    assert.equal(shown.kind, 'shown_possession');
    assert.equal(shown.fromId, first);
    assert.equal(shown.token.name, '密码4');
    for (const id of [first, third, hakoId]) assert.equal(getPlayView(play, id).sharedTokens, null);
    play = act(play, first, { type: 'show_possession', targetId: second, itemId: 'walkie_talkie' });
    const received = getPlayView(play, second).sharedTokens;
    assert.equal(received.item.id, 'walkie_talkie');
    assert.equal(received.token, undefined);
    received.item.description = 'forged';
    assert.notEqual(getPlayView(play, second).sharedTokens.item.description, 'forged');
    assert.deepEqual({ silent: play.round.silent, pending: play.round.pendingAction,
      resolution: play.resolution, interruption: play.interruption }, control, window);
    assert.equal(play.inventories[first].tokens[0].id, 'roommate-password');
  }
});

test('hidden allies share their current exact locations while living visitors receive no allied actor field', () => {
  const play = newPlay();
  addGhost(play, second, 'hall_clock');
  addGhost(play, third, 'study_books');
  const before = JSON.stringify(play);
  for (const id of [hakoId, second, third]) {
    const allies = getPlayView(play, id).alliedActors;
    assert.equal(allies.find(actor => actor.playerId === hakoId).cornerId, 'children_bed');
    assert.equal(allies.find(actor => actor.playerId === second).cornerId, 'hall_clock');
    assert.equal(allies.find(actor => actor.playerId === third).cornerId, 'study_books');
    allies[0].cornerId = 'forged';
  }
  assert.equal(Object.hasOwn(getPlayView(play, first), 'alliedActors'), false);
  assert.equal(JSON.stringify(play), before);
  play.round.hidingCornerId = 'children_toys';
  play.ghosts[0].cornerId = 'dining_table';
  assert.equal(getPlayView(play, third).alliedActors.find(actor => actor.playerId === hakoId).cornerId, 'children_toys');
  assert.equal(getPlayView(play, hakoId).alliedActors.find(actor => actor.playerId === second).cornerId, 'dining_table');
  play.ghosts[0].banished = true;
  play.round.visitors[1].status = 'banished';
  const banished = getPlayView(play, third).alliedActors.find(actor => actor.playerId === second);
  assert.equal(banished.status, 'banished');
  assert.equal(Object.hasOwn(banished, 'cornerId'), false);
});

test('the final visitor death ends the game without an inheritance decision or eligible recipient', () => {
  let play = newPlay();
  addGhost(play, second, 'study_books');
  addGhost(play, third, 'dining_table');
  play.round.hidingCornerId = 'hall_clock';
  play.inventories[first].tokens.push(token('last-visitor-key', 'key'));
  play = peek(reveal(play), 'hall_clock');
  assert.equal(play.result.winner, 'hako');
  assert.equal(play.resolution, null);
  assert.deepEqual(play.inheritanceQueue, []);
});

test('game-over review reveals the full current board, stored markers, all inventories and ability deck to every seat', () => {
  let play = newPlay();
  play.tokens.children_bed = token('stored-under-hako', 'weakness_clue', { tool: 'white_stick', name: '白木棒无效' });
  play.tokens.study_books = token('stored-under-box-person', 'password', { number: 4 });
  play.inventories[first].tokens.push(token('review-owner-secret', 'key'));
  play.inventories[second].tokens.push(token('review-other-secret', 'doll'));
  play.powers.hand = [{ id: 7, ignoreThreshold: true }];
  play.powers.deck = [8, 'despair', 9];
  play.powers.slots = [{ id: 4, faceUp: false }, null];
  play.powers.stolen = { kind: 'token', piece: token('review-stolen', 'password', { number: 2 }) };
  play.discarded.push({ playerId: third, tokens: [token('review-discarded', 'password', { number: 3 })], items: [] });
  play.removedTokens.push(token('review-consumed', 'extinguisher'));
  addGhost(play, third, 'study_books', [token('legacy-ghost-cargo', 'amulet')]);
  play.extraCorners['suitcase:hall_room'] = { id: 'suitcase:hall_room', roomId: 'hall_room', name: '行李箱中' };
  play.tokens['suitcase:hall_room'] = token('review-extra-corner', 'empty_box');
  for (const id of [hakoId, ...visitors]) assert.equal(Object.hasOwn(getPlayView(play, id), 'review'), false);
  for (const id of [first, second]) {
    const serialized = JSON.stringify(getPlayView(play, id));
    assert.equal(serialized.includes('stored-under-hako'), false);
    assert.equal(serialized.includes('review-stolen'), false);
  }
  play = act(play, first, { type: 'surrender' });
  assert.equal(play.result, null);
  play = act(play, second, { type: 'surrender' });
  assert.equal(play.result.winner, 'hako');
  const expected = getPlayView(play, hakoId).review;
  const before = JSON.stringify(play);
  for (const id of [hakoId, ...visitors]) {
    const view = getPlayView(play, id);
    assert.equal(view.phase, 'game_over');
    assert.deepEqual(view.review, expected);
    const hakoCorner = view.review.corners.find(corner => corner.id === 'children_bed');
    assert.equal(hakoCorner.token.type, 'hako');
    assert.equal(hakoCorner.underToken.id, 'stored-under-hako');
    assert.equal(hakoCorner.underToken.name, '白木椿无效');
    assert.equal(hakoCorner.actors[0].playerId, hakoId);
    const ghostCorner = view.review.corners.find(corner => corner.id === 'study_books');
    assert.equal(ghostCorner.token.type, 'box_person');
    assert.equal(ghostCorner.underToken.id, 'stored-under-box-person');
    assert.equal(ghostCorner.actors[0].carriedTokens[0].id, 'legacy-ghost-cargo');
    assert.equal(view.review.corners.find(corner => corner.id === 'suitcase:hall_room').token.id, 'review-extra-corner');
    assert.equal(view.review.inventories.find(held => held.playerId === second).tokens[0].id, 'review-other-secret');
    assert.equal(view.review.powers.hand[0].name, '快把它给我');
    assert.deepEqual(view.review.powers.deck.map(card => card.id), [8, 'despair', 9]);
    assert.equal(view.review.powers.slots[0].name, '动来动去');
    assert.equal(view.review.powers.stolen.piece.id, 'review-stolen');
    assert.equal(view.review.discarded[0].tokens[0].id, 'review-discarded');
    assert.equal(view.review.removedTokens[0].id, 'review-consumed');
    assert.deepEqual(view.review.opening.password, [1, 3, 5]);
    view.review.corners[0].token = null;
    view.review.powers.hand[0].name = 'forged';
    view.review.inventories[1].tokens = [];
    view.review.opening.password[0] = 99;
  }
  assert.equal(JSON.stringify(play), before);
  rejects(play, first, { type: 'show_possession', targetId: second, tokenId: 'review-owner-secret' }, /已经结束/);
  assert.throws(() => getPlayView(play, 'spectator'), /本局玩家/);
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
  view.hako.inspectedRoom.corners[0].id = 'changed';
  view.hako.inspectedRoom.corners.push({ id: 'changed', token: token('forged', 'key') });
  assert.equal(JSON.stringify(play), inspectedBefore);
});
