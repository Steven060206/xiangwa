import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hako = 'hako';
const piece = (id, type, fields = {}) => ({ id, type, ...fields });
const item = id => structuredClone(INITIAL_ITEMS.find(candidate => candidate.id === id));

function fixture() {
  const setup = createSetup(visitors, { deck: ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'] });
  for (const [floor, x, y, rotation] of [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ]) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  const opening = createOpening(setup, { hakoId: hako, itemChoices: visitors.map((playerId, index) => ({
    playerId, itemId: ['shrine_bell', 'walkie_talkie', 'deduction'][index],
  })) });
  chooseSecrets(opening, hako, { password: [1, 3, 5], weakness: 'gasoline' });
  placeRemains(opening, hako, 'hall_clock');
  inspectInitialRoom(opening, hako, 'children_room');
  chooseInitialHiding(opening, hako, 'children_bed');
  opening.initialPowerCandidates = [1, 4, 11];
  chooseInitialPower(opening, hako, 1);
  return createPlay(setup, opening, { numbers: [0, 1, 2, 3, 4, 5] });
}
function act(play, id, action) {
  const before = structuredClone(play);
  const next = applyPlayAction(play, id, action);
  assert.deepEqual(play, before, 'a successful action must preserve its input state');
  return next;
}
function reject(play, id, action, message = /[\u4e00-\u9fff]/) {
  const before = structuredClone(play);
  assert.throws(() => applyPlayAction(play, id, action), message);
  assert.deepEqual(play, before, 'a rejected action must preserve every input field');
}
function power(play, id, slot = 0) {
  play.powers.hand = play.powers.hand.filter(card => card.id !== id);
  play.powers.deck = play.powers.deck.filter(card => card !== id);
  play.powers.slots = play.powers.slots.map(card => card?.id === id ? null : card);
  play.powers.slots[slot] = { id, ignoreThreshold: true, faceUp: false };
}
function doll(play, id = first) {
  for (const [cornerId, token] of Object.entries(play.tokens)) if (token?.type === 'doll') play.tokens[cornerId] = null;
  for (const held of Object.values(play.inventories)) held.tokens = held.tokens.filter(token => token.type !== 'doll');
  play.inventories[id].tokens.push(piece('completion-doll', 'doll'));
}
function mary(play, id = first) {
  doll(play, id);
  power(play, 8);
  play.powers.slots[0] = null;
  play.noiseEffects = { mary: { playerId: id, card: { id: 8, ignoreThreshold: true } } };
  return play;
}
function cards(play, numbers, { up = [], held = [], turn = first } = {}) {
  Object.assign(play.round.silent, { phase: 'visitor_reveal', turnPlayerId: turn, resumePlayerId: null,
    trigger: null, revealsRemaining: 0, total: up.reduce((sum, index) => sum + numbers[index], 0),
    cards: numbers.map((number, index) => ({ index, number,
      status: up.includes(index) ? 'up' : held.includes(index) ? 'held' : 'down',
      ...(held.includes(index) ? { holderId: third } : {}) })),
  });
  return play;
}
function reveal(play, id = first, extra = {}) {
  return act(play, id, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.status === 'down'), ...extra });
}
function declareMove(play, id = first) {
  const roomId = getPlayView(play, id).moveTargets[0];
  assert.ok(roomId, 'fixture must give the visitor a legal move');
  return act(play, id, { type: 'move', roomId });
}
function move(play, id = first) { return act(declareMove(play, id), hako, { type: 'resolve_visitor_action' }); }
function finishStage(play) {
  if (play.round.silent.phase === 'hako_reaction') play = act(play, hako, { type: 'pass_noise_reaction' });
  play = act(play, hako, { type: 'begin_hako_action' });
  play = act(play, hako, { type: 'inspect_hiding_room', roomId: 'children_room' });
  return act(play, hako, { type: 'hako_hide', cornerId: 'children_bed' });
}
function steal(play, extra = {}) {
  return act(play, hako, { type: 'activate_power', slot: 0, stealKind: 'token', ...extra });
}

test('NO8 affects its holder only from the next turn, without adding reveals to the interrupted action', () => {
  let play = fixture();
  doll(play);
  power(play, 8);
  play = declareMove(reveal(play));
  const declaration = structuredClone(play.round.pendingAction);
  play = act(play, hako, { type: 'activate_power', slot: 0 });
  assert.deepEqual(play.round.pendingAction, declaration);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.cards.filter(card => card.status === 'up').length, 1);
  assert.equal(getPlayView(play, second).noiseEffects.maryPlayerId, first);
  assert.equal(play.powers.slots[0], null);
  assert.equal(play.powers.hand.some(card => card.id === 8), false);
  play = act(play, hako, { type: 'resolve_visitor_action' });
  for (const id of [second, third]) play = move(reveal(play, id), id);
  play = reveal(play);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(getPlayView(play, first).silent.revealsRemaining, 1);
  reject(play, first, { type: 'move', roomId: 'hall_room' });
  play = reveal(play);
  assert.equal(play.round.silent.total, 10);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.cards.filter(card => card.status === 'down').length, 1);
  play = move(play);
  assert.equal(play.round.silent.phase, 'hako_phase');
  assert.equal(play.round.silent.trigger, 'one_hidden');
});

test('NO8 with no living doll holder returns to hand and leaves the declared action available', () => {
  let play = fixture();
  power(play, 8);
  play = declareMove(reveal(play));
  play = act(play, hako, { type: 'activate_power', slot: 0 });
  assert.equal(play.noiseEffects?.mary ?? null, null);
  assert.equal(play.powers.hand.filter(card => card.id === 8).length, 1);
  assert.equal(play.round.pendingAction.type, 'move');
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(play.round.silent.turnPlayerId, second);
});

test('NO8 triggered by a free action before the first reveal waits until the holder starts its next turn', () => {
  let play = fixture();
  doll(play);
  power(play, 8);
  play = act(play, first, { type: 'show_token', targetId: second, tokenId: 'completion-doll' });
  assert.equal(play.round.pendingAction.type, 'free');
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  play = act(play, hako, { type: 'activate_power', slot: 0 });
  assert.equal(getPlayView(play, first).noiseEffects.requiredReveals, 1);
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, second).sharedTokens.token.type, 'doll');
  play = reveal(play);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.revealsRemaining, 0);
  assert.equal(play.round.silent.cards.filter(card => card.status === 'up').length, 1);
  play = move(play);
  for (const id of [second, third]) play = move(reveal(play, id), id);
  assert.equal(getPlayView(play, first).noiseEffects.requiredReveals, 2);
  play = reveal(play);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.round.silent.revealsRemaining, 1);
  play = reveal(play);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.total, 10);
});

test('a started reveal sequence freezes every visitor free action until all required numbers have resolved', () => {
  let play = mary(fixture());
  play.tokens.hall_clock = null;
  play.inventories[second].tokens = [piece('between-reveals-key', 'key')];
  play = act(play, second, { type: 'offer_exchange', targetId: third, giveTokenIds: ['between-reveals-key'] });
  const offerId = play.exchangeOffers[0].id;
  play = reveal(play);
  assert.equal(play.round.silent.revealsRemaining, 1);
  for (const [id, action] of [
    [first, { type: 'show_token', targetId: second, tokenId: 'completion-doll' }],
    [second, { type: 'show_token', targetId: first, tokenId: 'between-reveals-key' }],
    [second, { type: 'offer_exchange', targetId: first, giveTokenIds: ['between-reveals-key'] }],
    [third, { type: 'respond_exchange', offerId, accept: true }],
    [second, { type: 'drop_token', tokenId: 'between-reveals-key', cornerId: 'hall_clock' }],
  ]) reject(play, id, action);
  for (const id of visitors) {
    assert.deepEqual(getPlayView(play, id).dropTargets, []);
    assert.deepEqual(getPlayView(play, id).exchangePartners, []);
  }
  assert.equal(play.exchangeOffers.length, 1);
  play = reveal(play);
  play = act(play, second, { type: 'show_token', targetId: first, tokenId: 'between-reveals-key' });
  assert.equal(getPlayView(play, first).sharedTokens.token.id, 'between-reveals-key');
  play = act(play, third, { type: 'respond_exchange', offerId, accept: true });
  assert.equal(play.inventories[third].tokens.some(token => token.id === 'between-reveals-key'), true);
  assert.equal(play.round.silent.turnPlayerId, first);
  assert.equal(play.round.silent.phase, 'visitor_action');
});

test('NO8 plus bell flips three separate secret numbers and exactly ten still permits the bell action', () => {
  let play = cards(mary(fixture()), [0, 4, 1, 5, 2, 3], { up: [1] });
  reject(play, first, { type: 'silent_reveal', index: 0, useBell: 'yes' });
  play = reveal(play, first, { index: 0, useBell: true });
  assert.equal(play.round.silent.revealsRemaining, 2);
  assert.equal(getPlayView(play, first).noiseEffects.bellChosen, true);
  reject(play, first, { type: 'silent_reveal', index: 2, useBell: false });
  reject(play, first, { type: 'use_item', itemId: 'shrine_bell' });
  play = reveal(play, first, { index: 2 });
  assert.equal(play.round.silent.revealsRemaining, 1);
  play = reveal(play, first, { index: 3 });
  assert.equal(play.round.silent.total, 10);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.revealsRemaining, 0);
  assert.equal(getPlayView(play, first).noiseEffects.canUseBell, true);
  assert.equal(Object.hasOwn(getPlayView(play, second).silent.cards.find(card => card.status === 'down'), 'number'), false);
});

test('a three-number plan stops immediately when the first, second or third number exceeds ten and owes nothing next cycle', () => {
  for (const [numbers, up, indices] of [
    [[5, 4, 2, 0, 1, 3], [0, 1], [2]],
    [[5, 2, 4, 0, 1, 3], [0], [1, 2]],
    [[5, 1, 2, 3, 0, 4], [0], [1, 2, 3]],
  ]) {
    let play = cards(mary(fixture()), numbers, { up });
    for (let index = 0; index < indices.length; index++) {
      play = reveal(play, first, { index: indices[index], ...(index === 0 ? { useBell: true } : {}) });
    }
    assert.equal(play.round.silent.phase, 'hako_reaction');
    assert.equal(play.round.silent.total, 11);
    assert.equal(play.round.silent.revealsRemaining, 0);
    assert.equal(play.round.silent.cards.filter(card => card.status === 'up').length, up.length + indices.length);
    assert.equal(play.noiseEffects.bellReady, null);
    reject(play, first, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.status === 'down') });
    play = finishStage(play);
    assert.equal(play.round.silent.cycle, 2);
    assert.equal(play.round.silent.turnPlayerId, first);
    play.round.silent.cards.forEach((card, index) => { card.number = index; });
    play = reveal(play);
    assert.equal(play.round.silent.revealsRemaining, 1, 'new NO8 turn restarts at two, with no old bell debt');
    play = reveal(play);
    assert.equal(play.round.silent.phase, 'visitor_action');
  }
});

test('only the last covered number is reserved: NO8 may finish after one reveal and then enter hako after its action', () => {
  let play = cards(mary(fixture()), [0, 1, 2, 3, 4, 5], { held: [2, 3, 4, 5] });
  assert.equal(getPlayView(play, first).noiseEffects.canChooseBell, false);
  reject(play, first, { type: 'silent_reveal', index: 0, useBell: true });
  play = reveal(play);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.revealsRemaining, 0);
  assert.equal(play.round.silent.cards[1].status, 'down');
  assert.equal(getPlayView(play, first).noiseEffects.canUseBell, false);
  play = move(play);
  assert.equal(play.round.silent.phase, 'hako_phase');
  assert.equal(play.round.silent.trigger, 'one_hidden');
  assert.equal(play.round.silent.resumePlayerId, second);
});

test('bell preselection requires enough covered numbers for every promised reveal plus the last reserved number', () => {
  for (const cursed of [false, true]) {
    let play = fixture();
    if (cursed) play = mary(play);
    cards(play, [0, 1, 2, 3, 4, 5], { held: cursed ? [3, 4, 5] : [2, 3, 4, 5] });
    assert.equal(getPlayView(play, first).noiseEffects.canChooseBell, false);
    reject(play, first, { type: 'silent_reveal', index: 0, useBell: true }, /不足/);
  }
});

test('holding a number still skips with exactly one card; a started sequence or public zero forbids skipping', () => {
  let play = mary(fixture());
  play = act(play, first, { type: 'silent_skip', index: 3 });
  assert.equal(play.round.silent.cards.filter(card => card.status === 'held').length, 1);
  assert.equal(play.round.silent.cards.filter(card => card.status === 'up').length, 0);
  assert.equal(play.round.silent.turnPlayerId, second);
  assert.equal(play.round.silent.revealsRemaining, 0);
  let started = reveal(mary(fixture()), first, { useBell: true });
  reject(started, first, { type: 'silent_skip', index: 1 }, /连续/);
  let zero = move(reveal(fixture()));
  reject(zero, second, { type: 'silent_skip', index: 1 }, /数字0/);
});

test('NO8 blocks doll gifts, accepted requests, drops and peek replacement, including their private selectors', () => {
  let play = mary(fixture());
  play.tokens.hall_clock = null;
  reject(play, first, { type: 'drop_token', tokenId: 'completion-doll', cornerId: 'hall_clock' });
  reject(play, first, { type: 'offer_exchange', targetId: second, giveTokenIds: ['completion-doll'] });
  play = act(play, second, { type: 'offer_exchange', targetId: first, requestTokenIds: ['completion-doll'] });
  reject(play, first, { type: 'respond_exchange', offerId: play.exchangeOffers[0].id, accept: true });
  play = act(play, first, { type: 'respond_exchange', offerId: play.exchangeOffers[0].id, accept: false });
  play.tokens.hall_clock = piece('replace-key', 'key');
  play = reveal(reveal(play));
  play = act(play, first, { type: 'peek', cornerId: 'hall_clock' });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, first).resolution.replacementTokens.some(token => token.type === 'doll'), false);
  reject(play, first, { type: 'resolve_peek', take: true, replacement: 'completion-doll' });
  play = act(play, first, { type: 'resolve_peek', take: true, replacement: 'empty_box' });
  assert.equal(play.inventories[first].tokens.some(token => token.type === 'doll'), true);
});

test('NO8 returns to hand immediately on its holder death while mandatory inheritance still holds the doll, with or without a ring', () => {
  for (const ring of [false, true]) {
    let play = mary(fixture());
    if (ring) play.inventories[first].items.push(item('relic_ring'));
    play.round.visitors.find(player => player.id === first).roomId = 'children_room';
    play = reveal(reveal(play));
    play = act(play, first, { type: 'peek', cornerId: 'children_bed' });
    play = act(play, hako, { type: 'resolve_visitor_action' });
    assert.equal(play.noiseEffects.mary, null);
    assert.equal(play.powers.hand.filter(card => card.id === 8).length, 1);
    assert.equal(getPlayView(play, second).noiseEffects.maryPlayerId, null);
    assert.equal(play.resolution.kind, 'inheritance');
    assert.equal(play.inventories[first].tokens.some(token => token.type === 'doll'), true);
    assert.equal(play.ringAllies.includes(first), ring, 'the ring alone grants a temporary visitor alliance');
    assert.equal(play.discarded.some(entry => entry.tokens.some(token => token.type === 'doll')), false);
    reject(play, first, { type: 'bequeath', targetId: null });
    play = act(play, first, { type: 'bequeath', targetId: second });
    assert.equal(play.inventories[second].tokens.some(token => token.type === 'doll'), true);
    assert.equal(play.inventories[first].tokens.some(token => token.type === 'doll'), false);
    assert.equal(play.noiseEffects.mary, null);
    assert.equal(play.resolution, null);
  }
});

test('bell requires chosen extra reveals and a confirmed standard action; merely finishing the numbers has no effect', () => {
  reject(reveal(fixture()), first, { type: 'use_item', itemId: 'shrine_bell' });
  let play = reveal(fixture(), first, { useBell: true });
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(getPlayView(play, first).noiseEffects.canUseBell, false);
  play = reveal(play);
  assert.equal(play.noiseEffects.bell ?? null, null);
  assert.equal(getPlayView(play, first).items.usableItems.some(option => option.id === 'shrine_bell'), true);
  let abandoned = move(play);
  assert.equal(abandoned.noiseEffects.bellReady, null);
  assert.equal(abandoned.noiseEffects.bell ?? null, null);
  play = act(play, first, { type: 'use_item', itemId: 'shrine_bell' });
  assert.equal(play.noiseEffects.bell ?? null, null);
  assert.equal(play.round.silent.turnPlayerId, first);
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.deepEqual(play.noiseEffects.bell, { userId: first, cycle: 1 });
  assert.equal(play.round.silent.turnPlayerId, second);
  assert.equal(play.inventories[first].items.some(card => card.id === 'shrine_bell'), true);
  assert.equal(getPlayView(play, second).noiseEffects.bellUserId, first);
});

test('bell lasts through its next hako action, permits an already set ability to activate, and expires on cycle reset', () => {
  let play = cards(fixture(), [0, 1, 2, 3, 4, 5], { held: [3, 4, 5] });
  power(play, 2);
  play = reveal(reveal(play, first, { useBell: true }));
  play = act(play, first, { type: 'use_item', itemId: 'shrine_bell' });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(play.round.silent.phase, 'hako_phase');
  assert.equal(play.powers.step, 'preparation');
  play = act(play, hako, { type: 'begin_hako_action' });
  play = act(play, hako, { type: 'activate_power', slot: 0 });
  assert.equal(play.powers.movement.twoRooms, true);
  assert.equal(getPlayView(play, second).noiseEffects.bellUserId, first);
  play = act(play, hako, { type: 'inspect_hiding_room', roomId: 'children_room' });
  play = act(play, hako, { type: 'hako_hide', cornerId: 'children_bed' });
  assert.equal(play.round.silent.cycle, 2);
  assert.equal(play.noiseEffects.bell, null);
  assert.equal(getPlayView(play, first).noiseEffects.bellUserId, null);
  assert.equal(getPlayView(play, first).noiseEffects.canUseBell, false);
});

test('NO7 chooses tokens randomly without accepting an ID, hides the stolen piece, and lets the same visitor redeclare', () => {
  let play = fixture();
  play.inventories[first].tokens = [piece('theft-secret-key', 'key'), piece('theft-secret-password', 'password', { number: 6 })];
  power(play, 7);
  play = declareMove(reveal(play));
  assert.equal(play.round.visitors.find(player => player.id === first).roomId, 'hall_room');
  assert.equal(getPlayView(play, hako).hako.roomId, 'children_room');
  const option = getPlayView(play, hako).powers.activationOptions.find(candidate => candidate.card.id === 7);
  assert.equal(option.stealOptions.canStealToken, true);
  assert.equal(Object.hasOwn(option.stealOptions, 'tokens'), false);
  reject(play, hako, { type: 'activate_power', slot: 0, stealKind: 'token', tokenId: 'theft-secret-key' });
  reject(play, second, { type: 'activate_power', slot: 0, stealKind: 'token' });
  play = steal(play);
  const stolen = play.powers.stolen.piece;
  assert.ok(['theft-secret-key', 'theft-secret-password'].includes(stolen.id));
  assert.equal(play.round.pendingAction, null);
  assert.equal(play.round.silent.phase, 'visitor_action');
  assert.equal(play.round.silent.turnPlayerId, first);
  assert.equal(play.round.silent.cards.filter(card => card.status === 'up').length, 1);
  for (const id of visitors) {
    const view = getPlayView(play, id);
    assert.equal(Object.hasOwn(view.powers, 'stolen'), false);
    assert.equal(JSON.stringify(view).includes(stolen.id), false);
  }
  const ownView = getPlayView(play, hako);
  assert.equal(ownView.powers.stolen.piece.id, stolen.id);
  ownView.powers.stolen.piece.id = 'client mutation';
  assert.equal(play.powers.stolen.piece.id, stolen.id);
  play = move(play);
  assert.equal(play.round.silent.turnPlayerId, second);
});

test('NO7 can select a visitor card, and old loot cannot become eligible until after the new theft succeeds', () => {
  let play = fixture();
  power(play, 7);
  play.powers.stolen = { kind: 'token', piece: piece('previous-key', 'key') };
  play = declareMove(reveal(play));
  reject(play, hako, { type: 'activate_power', slot: 0, stealKind: 'token' });
  assert.equal(play.inventories[first].tokens.length, 0);
  play = steal(play, { stealKind: 'item', itemId: 'shrine_bell' });
  assert.equal(play.powers.stolen.piece.id, 'shrine_bell');
  assert.equal(play.inventories[first].items.some(card => card.id === 'shrine_bell'), false);
  assert.deepEqual(play.inventories[first].tokens.map(token => token.id), ['previous-key']);

  power(play, 7);
  play = declareMove(play);
  play = steal(play);
  assert.equal(play.powers.stolen.piece.id, 'previous-key');
  assert.equal(play.inventories[first].tokens.length, 0);
  assert.equal(play.inventories[first].items.some(card => card.id === 'shrine_bell'), true);
});

test('NO7 takes a free-action interruption before the original gift is committed and does not consume the current standard turn', () => {
  let play = fixture();
  power(play, 7);
  play.inventories[second].tokens = [piece('free-gift-key', 'key')];
  play = act(play, second, { type: 'offer_exchange', targetId: third, giveTokenIds: ['free-gift-key'] });
  assert.equal(play.round.pendingAction.type, 'free');
  assert.equal(play.exchangeOffers.length, 0);
  play = steal(play);
  assert.equal(play.powers.stolen.piece.id, 'free-gift-key');
  assert.equal(play.exchangeOffers.length, 0);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.round.silent.turnPlayerId, first);
});

test('stealing the cursed doll with NO7 returns NO8 to hand and removes its future reveal burden', () => {
  let play = mary(fixture());
  power(play, 7);
  play = declareMove(reveal(reveal(play)));
  play = steal(play);
  assert.equal(play.powers.stolen.piece.type, 'doll');
  assert.equal(play.noiseEffects.mary, null);
  assert.equal(play.powers.hand.filter(card => card.id === 8).length, 1);
  assert.equal(getPlayView(play, first).noiseEffects.requiredReveals, 1);
  assert.equal(getPlayView(play, second).noiseEffects.maryPlayerId, null);
  assert.equal(play.round.silent.phase, 'visitor_action');
});

test('NO7 cannot interrupt amulet use or an extinguisher response', () => {
  let play = fixture();
  power(play, 7);
  power(play, 9, 1);
  play.inventories[first].tokens = [piece('protected-amulet', 'amulet')];
  play = reveal(play);
  play = act(play, first, { type: 'use_item', itemId: 'amulet', tokenId: 'protected-amulet', index: 1 });
  reject(play, hako, { type: 'activate_power', slot: 0, stealKind: 'token' }, /不能打断古怪护符/);
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(play.powers.slots[1], null);
  assert.equal(play.inventories[first].tokens.length, 0);

  let noise = cards(fixture(), [5, 4, 2, 0, 1, 3], { up: [0, 1] });
  power(noise, 7);
  noise.inventories[first].tokens = [piece('protected-extinguisher', 'extinguisher')];
  noise = reveal(noise, first, { index: 2 });
  assert.equal(noise.interruption.kind, 'noise');
  reject(noise, hako, { type: 'activate_power', slot: 0, stealKind: 'token' }, /灭火器/);
  noise = act(noise, first, { type: 'extinguisher_response', use: true });
  assert.equal(noise.round.silent.cycle, 2);
  assert.equal(noise.powers.stolen ?? null, null);
  assert.equal(noise.powers.slots[0].id, 7);
});

test('stealing the last key, doll or effective weapon ends a game whose other two visitor routes are already unavailable', () => {
  for (const route of ['escape', 'exorcism', 'subjugation']) {
    let play = fixture();
    for (const cornerId of Object.keys(play.tokens)) play.tokens[cornerId] = null;
    for (const held of Object.values(play.inventories)) held.tokens = [];
    play.opening.safeBoard.key = null;
    if (route === 'escape') {
      play.tokens.hall_clock = piece('last-exit', 'hidden_exit');
      play.inventories[first].tokens = [piece('last-key', 'key')];
    } else if (route === 'exorcism') {
      play.tokens.hall_clock = piece('last-remains', 'remains');
      play.inventories[first].tokens = [piece('last-doll', 'doll')];
    } else play.inventories[first].tokens = [piece('last-weapon', 'weapon', { tool: 'gasoline' })];
    power(play, 7);
    play = declareMove(reveal(play));
    assert.equal(play.result, null);
    play = steal(play);
    assert.equal(play.result.winner, 'hako', route);
    assert.equal(play.result.reason, '三条访问者胜利路线均已无法达成');
    reject(play, first, { type: 'move', roomId: 'study_room' }, /已经结束/);
  }
});

test('NO8 invalidated doll transfers and phone targets allow a fresh declaration in the same turn', () => {
  for (const kind of ['offer', 'drop', 'accept', 'phone', 'phone-without-doll']) {
    let play = fixture();
    if (kind !== 'phone-without-doll') doll(play);
    if (kind === 'accept') {
      play = act(play, second, { type: 'offer_exchange', targetId: first, requestTokenIds: ['completion-doll'] });
    }
    power(play, 8);
    if (kind.startsWith('phone')) {
      play.inventories[first].items.push(item('smartphone'));
      play = act(reveal(play), first, { type: 'use_item', itemId: 'smartphone', targetZone: 'slot', index: 0 });
    } else if (kind === 'offer') {
      play = act(play, first, { type: 'offer_exchange', targetId: second, giveTokenIds: ['completion-doll'] });
    } else if (kind === 'drop') {
      play.tokens.hall_clock = null;
      play = act(play, first, { type: 'drop_token', tokenId: 'completion-doll', cornerId: 'hall_clock' });
    } else {
      play = act(play, first, { type: 'respond_exchange', offerId: play.exchangeOffers[0].id, accept: true });
    }
    const before = structuredClone(play.round.silent);
    play = act(play, hako, { type: 'activate_power', slot: 0 });
    assert.equal(play.round.pendingAction, null, kind);
    assert.deepEqual(play.round.silent, before, 'interruption must preserve the current turn and reveals');
    if (!kind.startsWith('phone')) play = reveal(play);
    play = declareMove(play);
    play = act(play, hako, { type: 'resolve_visitor_action' });
    assert.equal(play.round.silent.turnPlayerId, second, kind);
  }
});

test('bell prohibits B and C settings including threshold exemptions, allows A and ungraded cards, and expires after the stage', () => {
  let play = reveal(reveal(fixture(), first, { useBell: true }));
  play = act(play, first, { type: 'use_item', itemId: 'shrine_bell' });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  Object.assign(play.round.silent, { phase: 'hako_reaction', turnPlayerId: null, resumePlayerId: first });
  play = act(play, hako, { type: 'pass_noise_reaction' });
  play = act(play, hako, { type: 'hako_cry' });
  play.powers.slots = [null, null];
  play.powers.hand = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, ignoreThreshold: true }));
  const hand = getPlayView(play, hako).powers.hand;
  for (const id of [3, 4, 7, 8, 9, 10]) {
    assert.equal(hand.find(card => card.id === id).settable, false);
    assert.match(hand.find(card => card.id === id).setReason, /铃/);
    reject(play, hako, { type: 'set_power', powerId: id, slot: 0 }, /铃/);
  }
  for (const id of [1, 2, 5, 6, 11]) {
    assert.equal(hand.find(card => card.id === id).settable, true);
    assert.equal(act(play, hako, { type: 'set_power', powerId: id, slot: 0 }).powers.slots[0].id, id);
  }
  let next = finishStage(play);
  assert.equal(next.noiseEffects.bell, null);
  Object.assign(next.round.silent, { phase: 'hako_reaction', turnPlayerId: null, resumePlayerId: first });
  next = act(next, hako, { type: 'pass_noise_reaction' });
  next = act(next, hako, { type: 'hako_cry' });
  assert.equal(act(next, hako, { type: 'set_power', powerId: 3, slot: 0 }).powers.slots[0].id, 3);
});
