import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBotAction } from '../src/bots.mjs';
import { createSetup, drawTile, placeTile, getSetupView } from '../src/game.mjs';
import { INITIAL_ITEMS, createItemDraft, chooseItem, getItemDraftView, createOpening,
  chooseSecrets, placeRemains, inspectInitialRoom, chooseInitialHiding, chooseInitialPower, getOpeningView } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';

const visitors = ['visitor-a', 'visitor-b', 'human'];
const [first, second, human] = visitors;
const hakoId = 'hako';
const ids = [hakoId, ...visitors];
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const item = id => structuredClone(INITIAL_ITEMS.find(card => card.id === id));
const piece = (id, type, fields = {}) => ({ id, type, ...fields });
const players = allBots => ids.map(id => ({ id, name: id, role: id === hakoId ? 'hako' : 'visitor',
  ready: true, ...(id !== human || allBots ? { isBot: true } : {}) }));

function seeded(seed) {
  let value = seed >>> 0;
  return () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

function decide(view, random = () => 0.5) {
  const before = JSON.stringify(view);
  const action = chooseBotAction(freeze(view), { random });
  assert.equal(JSON.stringify(view), before, 'bot changed its filtered browser snapshot');
  return action;
}

function snapshot(play, you, allBots = false) {
  return { phase: play.result ? 'game_over' : 'practice', you, hostId: human, players: players(allBots),
    round: getPlayView(play, you) };
}

function botAct(play, id, random = () => 0.5, allBots = false) {
  const action = decide(snapshot(play, id, allBots), random);
  assert.ok(action, `expected ${id} to decide in ${getPlayView(play, id).phase}`);
  return { play: applyPlayAction(play, id, action), action };
}

function setup() {
  const state = createSetup(visitors, { deck });
  for (const [floor, x, y, rotation] of [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ]) {
    drawTile(state, state.turnPlayerId);
    placeTile(state, state.turnPlayerId, { floor, x, y, rotation });
  }
  return state;
}

function opening(map = setup(), firstItem = 'deduction') {
  const choices = [firstItem, ...['walkie_talkie', 'relic_ring', 'deduction'].filter(id => id !== firstItem)];
  return createOpening(map, { hakoId, itemChoices: visitors.map((playerId, index) => ({ playerId,
    itemId: choices[index] })) });
}

function fixture(firstItem = 'deduction') {
  const map = setup();
  const state = opening(map, firstItem);
  chooseSecrets(state, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  // Make fixtures reproducible without changing global randomness. This is test
  // setup only; bot decisions below always receive getPlayView's filtered data.
  const tokens = Object.values(state.cornerTokens).filter(token => token && token.type !== 'safe')
    .sort((a, b) => a.id.localeCompare(b.id));
  Object.keys(state.cornerTokens).filter(id => id !== 'study_desk').sort()
    .forEach((id, index) => { state.cornerTokens[id] = tokens[index] ?? null; });
  placeRemains(state, hakoId, 'hall_clock');
  inspectInitialRoom(state, hakoId, 'children_room');
  chooseInitialHiding(state, hakoId, 'children_bed');
  chooseInitialPower(state, hakoId, 1);
  state.powerDeck = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 'despair'];
  return createPlay(map, state, { numbers: [0, 1, 2, 3, 4, 5] });
}

function reveal(play, id = first) {
  return applyPlayAction(play, id, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.status === 'down') });
}

function peek(play, cornerId = 'hall_clock', id = first, fields = {}) {
  play = applyPlayAction(reveal(play, id), id, { type: 'peek', cornerId, ...fields });
  return applyPlayAction(play, hakoId, { type: 'resolve_visitor_action' });
}

function stage(play) {
  Object.assign(play.round.silent, { phase: 'hako_reaction', turnPlayerId: null,
    resumePlayerId: play.round.silent.visitorIds[0], total: 11, trigger: 'overflow' });
  play.round.silent.cards.forEach(card => { card.status = [2, 4, 5].includes(card.number) ? 'up' : 'down'; });
  play.powers.noiseRespondedCycle = play.round.silent.cycle;
  return applyPlayAction(play, hakoId, { type: 'pass_noise_reaction' });
}

function slot(play, id, at = 0) {
  play.powers.deck = play.powers.deck.filter(cardId => cardId !== id);
  play.powers.hand = play.powers.hand.filter(card => card.id !== id);
  play.powers.slots[at] = { id, ignoreThreshold: true, faceUp: false };
}

test('bots ready once and leave role selection, starting, human seats and finished games to the person', () => {
  const lobby = { phase: 'lobby', you: first, hostId: human, players: players().map(player => ({ ...player, ready: false })) };
  assert.deepEqual(decide(lobby), { type: 'ready', ready: true });
  assert.equal(decide({ ...lobby, players: players() }), null);
  assert.equal(decide({ ...lobby, phase: 'hako_selection' }), null);
  assert.equal(decide({ ...lobby, phase: 'game_over' }), null);
  assert.equal(decide({ ...lobby, you: human }), null);
  assert.equal(chooseBotAction(null), null);
});

test('item drafting uses actual remaining cards and only acts on the bot own turn', () => {
  const draft = createItemDraft(visitors);
  for (const id of visitors) {
    const view = { phase: 'item_draft', you: id, players: players(true), draft: getItemDraftView(draft) };
    assert.equal(decide({ ...view, you: hakoId }), null);
    const action = decide(view);
    assert.equal(action.type, 'choose_item');
    assert.ok(view.draft.availableItems.some(card => card.id === action.itemId));
    chooseItem(draft, id, action.itemId);
  }
  assert.equal(new Set(draft.choices.map(choice => choice.itemId)).size, 3);
  const custom = createItemDraft(visitors, { items: ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id, description: '' })) });
  const action = decide({ phase: 'item_draft', you: first, players: players(), draft: getItemDraftView(custom) });
  chooseItem(custom, first, action.itemId);
});

test('filtered map views let bots draw and place all eight boards with real placement validation', () => {
  const state = createSetup(visitors, { deck });
  const random = seeded(24);
  for (let index = 0; index < 16; index++) {
    const id = state.turnPlayerId;
    const view = { phase: state.phase, you: id, players: players(true), setup: getSetupView(state) };
    assert.equal(decide({ ...view, you: hakoId }, random), null);
    const action = decide(view, random);
    if (action.type === 'draw') drawTile(state, id);
    else {
      assert.ok(view.setup.legalPlacements.some(placement => Object.entries(placement).every(([key, value]) => action[key] === value)));
      placeTile(state, id, action);
    }
  }
  assert.equal(state.phase, 'map_ready');
  const view = { phase: 'map_ready', you: first, hostId: human, players: players(), setup: getSetupView(state) };
  assert.equal(decide(view), null);
  assert.deepEqual(decide({ ...view, hostId: first }), { type: 'prepare_opening' });
});

test('hako completes secret opening choices from its own filtered options without granting visitor access', () => {
  const state = opening();
  const seen = [];
  while (state.phase !== 'opening_ready') {
    const view = { phase: 'opening_setup', you: hakoId, players: players(), opening: getOpeningView(state, hakoId) };
    assert.equal(decide({ ...view, you: first, opening: getOpeningView(state, first) }), null);
    const action = decide(view, seeded(seen.length + 3));
    seen.push(action.type);
    if (action.type === 'choose_secrets') chooseSecrets(state, hakoId, action);
    if (action.type === 'place_remains') placeRemains(state, hakoId, action.cornerId);
    if (action.type === 'inspect_initial_room') inspectInitialRoom(state, hakoId, action.roomId);
    if (action.type === 'choose_initial_hiding') chooseInitialHiding(state, hakoId, action.cornerId);
    if (action.type === 'choose_initial_power') chooseInitialPower(state, hakoId, action.powerId);
  }
  assert.deepEqual(seen, ['choose_secrets', 'place_remains', 'inspect_initial_room', 'choose_initial_hiding', 'choose_initial_power']);
  assert.equal(state.initialPowerId, 1);
});

test('visitors reveal only their own down card, wait during declarations, and hako confirms the declaration', () => {
  let play = fixture();
  assert.equal(decide(snapshot(play, second)), null);
  let result = botAct(play, first);
  assert.equal(result.action.type, 'silent_reveal');
  assert.equal(play.round.silent.cards[result.action.index].status, 'down');
  play = result.play;
  result = botAct(play, first, () => 0.99);
  assert.equal(result.action.type, 'move');
  play = result.play;
  assert.equal(decide(snapshot(play, first)), null);
  assert.equal(decide(snapshot(play, second)), null);
  result = botAct(play, hakoId);
  assert.equal(result.action.type, 'resolve_visitor_action');
  assert.equal(result.play.round.pendingAction, null);
});

test('peek resolutions legally take useful pieces, cover untakeable pieces, and replace mandatory notebooks', () => {
  for (const [type, fields] of [['password', { number: 2 }], ['hidden_exit', {}], ['empty_box', {}], ['notebook', { number: 2 }]]) {
    let play = fixture();
    play.tokens.hall_clock = piece(`found-${type}`, type, fields);
    play = peek(play);
    assert.equal(decide(snapshot(play, second)), null);
    const { play: next, action } = botAct(play, first);
    assert.equal(action.type, 'resolve_peek');
    assert.equal(next.resolution, null);
    if (type === 'password') assert.ok(next.inventories[first].tokens.some(token => token.id === 'found-password'));
    if (type === 'notebook' || type === 'password') assert.equal(next.tokens.hall_clock.faceUp, true);
    else assert.equal(next.tokens.hall_clock.type, type);
  }
  let depleted = fixture();
  depleted.opening.emptyBoxTokens = [];
  depleted.tokens.hall_clock = piece('depleted-box-password', 'password', { number: 2 });
  depleted = peek(depleted);
  const result = botAct(depleted, first);
  assert.equal(result.action.replacement, 'none');
  assert.equal(result.play.tokens.hall_clock, null);
});

test('night vision obtains one real remaining item when a notebook requires that choice', () => {
  let play = fixture('night_vision');
  play.tokens.hall_clock = piece('night-vision-notebook', 'notebook', { number: 2 });
  play = peek(play, 'hall_clock', first, { useNightVision: true });
  const result = botAct(play, first);
  assert.ok(play.availableItems.some(card => card.id === result.action.itemId));
  assert.ok(result.play.inventories[first].items.some(card => card.id === result.action.itemId));
});

test('safe guesses use personal exclusion clues and public correct digits, including stethoscope choices', () => {
  for (const using of [false, true]) {
    let play = fixture(using ? 'stethoscope' : 'deduction');
    play.round.visitors[0].roomId = 'study_room';
    if (!using) play.inventories[first].tokens = [2, 4, 6].map(number => piece(`password-${number}`, 'password', { number }));
    play = peek(play, 'study_desk');
    const result = botAct(play, first, () => 0);
    assert.equal(result.action.type, 'safe_guess');
    assert.equal(result.action.useStethoscope, using);
    if (using) assert.deepEqual(result.play.publicNumbers, [1]);
    else {
      assert.deepEqual(result.action.numbers, [1, 3, 5]);
      assert.equal(result.play.safeOpened, true);
    }
  }
});

test('equal filtered views produce equal choices even when inaccessible board secrets differ', () => {
  const play = reveal(fixture());
  const alternate = structuredClone(play);
  alternate.opening.password = [2, 4, 6];
  alternate.opening.weakness = 'white_stick';
  alternate.round.hidingCornerId = 'dark_bed';
  const a = snapshot(play, first);
  const b = snapshot(alternate, first);
  assert.deepEqual(a, b);
  assert.deepEqual(decide(a, seeded(19)), decide(b, seeded(19)));
});

test('hako answers all supported question items with real legal answer options, including NO9 lies', () => {
  for (const itemId of ['spirit_pen', 'ventriloquist_doll', 'dowsing_rod']) {
    for (const lie of [false, true]) {
      let play = fixture(itemId);
      if (lie) slot(play, 9);
      play = reveal(play);
      play = applyPlayAction(play, first, { type: 'use_item', itemId, roomId: 'hall_room' });
      play = applyPlayAction(play, hakoId, { type: 'resolve_visitor_action' });
      assert.equal(play.resolution.kind, 'item_answer');
      assert.equal(decide(snapshot(play, second)), null);
      const { play: next, action } = botAct(play, hakoId);
      assert.equal(action.type, 'answer_item');
      assert.equal(action.answer === play.resolution.truth, !lie);
      assert.equal(next.resolution, null);
    }
  }
});

test('actual ring deaths transfer possessions to a living human rather than blocking inheritance', () => {
  let play = fixture('relic_ring');
  play.round.hidingCornerId = 'hall_clock';
  play.inventories[first].tokens.push(piece('inherited-key', 'key'));
  play = peek(play);
  assert.equal(play.resolution.kind, 'inheritance');
  const { play: next, action } = botAct(play, first);
  assert.deepEqual(action, { type: 'bequeath', targetId: human });
  assert.ok(next.inventories[human].tokens.some(token => token.id === 'inherited-key'));
  assert.equal(next.resolution, null);
});

test('NO6 interruption is followed by the affected bot selecting and resolving a legal forced peek', () => {
  let play = fixture();
  slot(play, 6);
  play = reveal(play);
  play = applyPlayAction(play, first, { type: 'move', roomId: 'study_room' });
  let result = botAct(play, hakoId);
  assert.equal(result.action.type, 'activate_power');
  play = result.play;
  assert.equal(play.resolution.kind, 'forced_peek');
  result = botAct(play, first);
  assert.equal(result.action.type, 'choose_forced_peek');
  assert.ok(getPlayView(play, first).resolution.cornerIds.includes(result.action.cornerId));
  result = botAct(result.play, first);
  assert.equal(result.action.type, 'resolve_peek');
});

test('extinguisher owners respond to actual overflow and lethal power windows while other bots wait', () => {
  for (const kind of ['noise', 'power']) {
    let play = fixture();
    play.inventories[first].tokens.push(piece('bot-extinguisher', 'extinguisher'));
    if (kind === 'noise') {
      play.round.silent.total = 9;
      play = applyPlayAction(play, first, { type: 'silent_reveal', index: 5 });
    } else {
      play = stage(play);
      play.round.hidingCornerId = 'hall_clock';
      slot(play, 5);
      play = applyPlayAction(play, hakoId, { type: 'begin_hako_action' });
      play = applyPlayAction(play, hakoId, { type: 'activate_power', slot: 0 });
    }
    assert.equal(play.interruption.kind, kind);
    assert.equal(decide(snapshot(play, hakoId)), null);
    assert.equal(decide(snapshot(play, second)), null);
    const result = botAct(play, first);
    assert.deepEqual(result.action, { type: 'extinguisher_response', use: true });
    assert.equal(result.play.interruption, null);
    assert.equal(result.play.round.silent.phase, 'visitor_reveal');
  }
});

test('bots accept valid gifts and reject exchanges requesting nonexistent or excessive possessions', () => {
  for (const kind of ['gift', 'missing', 'excessive', 'moved']) {
    let play = fixture();
    play.inventories[human].tokens.push(piece('gift', 'key'));
    play.inventories[first].tokens.push(piece('held-one', 'password', { number: 2 }), piece('held-two', 'weakness_clue', { tool: 'white_stick' }));
    play = applyPlayAction(play, human, { type: 'offer_exchange', targetId: first, giveTokenIds: ['gift'],
      requestTokenIds: kind === 'missing' ? ['missing'] : kind === 'excessive' ? ['held-one', 'held-two'] : [] });
    if (kind === 'moved') play.round.visitors.find(player => player.id === human).roomId = 'study_room';
    assert.equal(decide(snapshot(play, second)), null);
    const result = botAct(play, first);
    assert.equal(result.action.type, 'respond_exchange');
    assert.equal(result.action.accept, kind === 'gift');
    assert.equal(result.play.exchangeOffers.length, 0);
  }
});

test('active item choices use real available targets and pass existing declaration and resolution validation', () => {
  for (const itemId of ['spirit_pen', 'ventriloquist_doll', 'dowsing_rod', 'smartphone', 'nightmare_letter', 'suitcase', 'amulet']) {
    let play = fixture(itemId === 'amulet' ? 'deduction' : itemId);
    if (['smartphone', 'amulet'].includes(itemId)) slot(play, 9);
    if (itemId === 'amulet') play.inventories[first].tokens.push(piece('amulet-to-use', 'amulet'));
    play = reveal(play);
    let result = botAct(play, first, () => 0);
    assert.equal(result.action.type, 'use_item');
    assert.equal(result.action.itemId, itemId);
    play = applyPlayAction(result.play, hakoId, { type: 'resolve_visitor_action' });
    if (play.resolution?.kind === 'item_answer') play = botAct(play, hakoId).play;
    assert.equal(play.resolution, null);
  }
});

test('bots never initiate surrender and withdraw their vote when the person withdraws theirs', () => {
  let play = fixture();
  assert.notEqual(decide(snapshot(play, first)).type, 'surrender');
  play = applyPlayAction(play, human, { type: 'surrender', agree: true });
  let result = botAct(play, first);
  assert.deepEqual(result.action, { type: 'surrender', agree: true });
  play = applyPlayAction(result.play, human, { type: 'surrender', agree: false });
  result = botAct(play, first);
  assert.deepEqual(result.action, { type: 'surrender', agree: false });
});

test('bots use NO7 and NO8 through their own filtered interruption choices', () => {
  for (const id of [7, 8]) {
    let play = fixture();
    if (id === 7) play.inventories[first].tokens.push(piece('bot-theft-key', 'key'));
    else {
      const cornerId = Object.keys(play.tokens).find(key => play.tokens[key]?.type === 'doll');
      play.inventories[first].tokens.push(play.tokens[cornerId]);
      play.tokens[cornerId] = null;
    }
    slot(play, id);
    play = applyPlayAction(reveal(play), first, { type: 'peek', cornerId: 'hall_clock' });
    const result = botAct(play, hakoId, () => 0);
    assert.equal(result.action.type, 'activate_power');
    if (id === 7) {
      assert.equal(result.action.stealKind, 'token');
      assert.equal(Object.hasOwn(result.action, 'tokenId'), false);
      assert.equal(result.play.powers.stolen.piece.id, 'bot-theft-key');
      assert.equal(result.play.round.pendingAction, null);
    } else {
      assert.equal(result.play.noiseEffects.mary.playerId, first);
      assert.equal(result.play.round.pendingAction.type, 'peek');
    }
  }
});

test('bots finish bell reveals before accepting gifts and then spend their standard action to ring', () => {
  let play = fixture('shrine_bell');
  play.inventories[human].tokens.push(piece('bell-sequence-gift', 'key'));
  play = applyPlayAction(play, human, { type: 'offer_exchange', targetId: first, giveTokenIds: ['bell-sequence-gift'] });
  play = applyPlayAction(play, first, { type: 'silent_reveal', index: 0, useBell: true });
  assert.equal(play.round.silent.revealsRemaining, 1);
  assert.equal(decide(snapshot(play, human)), null);
  let result = botAct(play, first, () => 0);
  assert.equal(result.action.type, 'silent_reveal');
  assert.equal(Object.hasOwn(result.action, 'useBell'), false);
  play = result.play;
  result = botAct(play, first);
  assert.equal(result.action.type, 'respond_exchange');
  play = result.play;
  result = botAct(play, first);
  assert.deepEqual(result.action, { type: 'use_item', itemId: 'shrine_bell' });
  play = applyPlayAction(result.play, hakoId, { type: 'resolve_visitor_action' });
  assert.equal(play.noiseEffects.bell.userId, first);
});

test('bots reject an existing offer that would transfer a newly cursed doll', () => {
  for (const direction of ['incoming', 'outgoing']) {
    let play = fixture();
    const cornerId = Object.keys(play.tokens).find(key => play.tokens[key]?.type === 'doll');
    const doll = play.tokens[cornerId];
    play.tokens[cornerId] = null;
    const owner = direction === 'incoming' ? human : first;
    play.inventories[owner].tokens.push(doll);
    play.inventories[human].tokens.push(piece('mary-trade-key', 'key'));
    play = applyPlayAction(play, human, { type: 'offer_exchange', targetId: first,
      giveTokenIds: [direction === 'incoming' ? doll.id : 'mary-trade-key'],
      requestTokenIds: direction === 'outgoing' ? [doll.id] : [] });
    slot(play, 8);
    play.inventories[first].items.push(item('smartphone'));
    play = applyPlayAction(reveal(play), first, { type: 'use_item', itemId: 'smartphone', targetZone: 'hand', index: 0 });
    play = applyPlayAction(play, hakoId, { type: 'activate_power', slot: 0 });
    play = applyPlayAction(play, hakoId, { type: 'resolve_visitor_action' });
    const result = botAct(play, first);
    assert.equal(result.action.type, 'respond_exchange');
    assert.equal(result.action.accept, false);
    assert.equal(result.play.exchangeOffers.length, 0);
  }
});

test('hako bots cry, manage supported powers, begin their stage, activate and finish real hiding', () => {
  let play = stage(fixture());
  const actions = [];
  for (let index = 0; play.round.silent.cycle === 1 && index < 15; index++) {
    const result = botAct(play, hakoId);
    actions.push(result.action.type);
    play = result.play;
  }
  assert.deepEqual(actions, ['hako_cry', 'set_power', 'begin_hako_action', 'activate_power', 'inspect_hiding_room', 'hako_hide']);
  assert.equal(play.round.silent.cycle, 2);
  assert.equal(play.powers.slots[0], null);
});

test('NO2 paths, NO3 actual doors, NO5 victims, NO10 interruption, existing NO4 rearrangements and recalls are legal', () => {
  for (const powerId of [2, 3, 5]) {
    let play = stage(fixture());
    if (powerId === 5) play.round.hidingCornerId = 'hall_clock';
    slot(play, powerId);
    play = applyPlayAction(play, hakoId, { type: 'begin_hako_action' });
    let result = botAct(play, hakoId);
    assert.deepEqual(result.action.type, 'activate_power');
    play = result.play;
    if (powerId === 2) {
      result = botAct(play, hakoId);
      assert.equal(result.action.type, 'inspect_path_room');
      assert.ok(result.play.powers.movement.pathRoomId);
    }
    if (powerId === 3) assert.equal(play.round.blockedDoors.length, 1);
    if (powerId === 5) assert.equal(play.result?.winner, 'hako');
  }
  let call = reveal(fixture());
  slot(call, 10);
  call = applyPlayAction(call, first, { type: 'peek', cornerId: 'hall_clock' });
  call = botAct(call, hakoId).play;
  assert.equal(call.round.pendingAction, null);
  const forcedMove = botAct(call, first);
  assert.equal(forcedMove.action.type, 'move');
  let rearrange = stage(fixture());
  slot(rearrange, 4);
  rearrange = applyPlayAction(rearrange, hakoId, { type: 'begin_hako_action' });
  rearrange = applyPlayAction(rearrange, hakoId, { type: 'activate_power', slot: 0, roomId: 'study_room' });
  const shuffled = botAct(rearrange, hakoId);
  assert.equal(shuffled.action.type, 'power_rearrange');
  assert.equal(shuffled.play.powers.rearrangement, null);
  let recall = stage(fixture());
  slot(recall, 4);
  slot(recall, 9, 1);
  recall = applyPlayAction(recall, hakoId, { type: 'hako_cry' });
  const recalled = botAct(recall, hakoId);
  assert.equal(recalled.action.type, 'recall_power');
  assert.ok(recalled.play.powers.hand.some(card => card.id === 4));
});

test('unsupported hand cards are skipped and a bot box person waits for hako before its own hiding', () => {
  let unsupported = stage(fixture());
  unsupported.powers.hand = [{ id: 12, ignoreThreshold: true }];
  unsupported = applyPlayAction(unsupported, hakoId, { type: 'hako_cry' });
  assert.deepEqual(botAct(unsupported, hakoId).action, { type: 'begin_hako_action' });
  let play = fixture();
  play.round.visitors[0].roomId = 'children_room';
  play = peek(play, 'children_bed');
  assert.equal(play.round.visitors[0].status, 'box_person');
  assert.equal(decide(snapshot(play, first)), null);
  play = stage(play);
  play = applyPlayAction(play, hakoId, { type: 'begin_hako_action' });
  assert.equal(decide(snapshot(play, first)), null);
  play = applyPlayAction(play, hakoId, { type: 'inspect_hiding_room', roomId: 'children_room' });
  let result = botAct(play, first);
  assert.equal(result.action.type, 'inspect_hiding_room');
  play = result.play;
  result = botAct(play, first);
  assert.equal(result.action.type, 'ghost_hide');
  play = applyPlayAction(result.play, hakoId, { type: 'hako_hide', cornerId: 'children_bed' });
  assert.equal(play.round.silent.cycle, 2);
  const banished = structuredClone(play);
  banished.ghosts[0].banished = true;
  banished.round.visitors[0].status = 'banished';
  assert.equal(decide(snapshot(banished, first)), null);
});

test('seeded games repeatedly complete hako phases using each seat own filtered view without illegal actions or stalls', () => {
  let completedStages = 0;
  let maxCycle = 0;
  for (const seed of [3, 11, 29, 51, 97, 211]) {
    let play = fixture();
    const random = seeded(seed);
    for (let step = 0; step < 1800 && !play.result; step++) {
      let progressed = false;
      for (const id of ids) {
        const action = decide(snapshot(play, id, true), random);
        if (!action) continue;
        try { play = applyPlayAction(play, id, action); }
        catch (error) { assert.fail(`seed ${seed}, step ${step}, ${id}, ${JSON.stringify(action)}: ${error.message}`); }
        progressed = true;
        break;
      }
      assert.ok(progressed, `seed ${seed} stalled at cycle ${play.round.silent.cycle} in ${play.round.silent.phase}`);
    }
    assert.ok(play.result, `seed ${seed} did not finish within 1800 decisions`);
    completedStages += play.round.silent.cycle - 1;
    maxCycle = Math.max(maxCycle, play.round.silent.cycle);
    for (const id of ids) assert.equal(decide(snapshot(play, id, true), random), null);
  }
  assert.ok(maxCycle >= 4, `longest game reached only cycle ${maxCycle}`);
  assert.ok(completedStages >= 12, `only ${completedStages} hako stages completed`);
});
