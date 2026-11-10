import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { createOpening, chooseSecrets, placeRemains, inspectInitialRoom, chooseInitialHiding, chooseInitialPower, INITIAL_ITEMS } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hako = 'hako';

function newPlay(itemId = 'spirit_pen') {
  const setup = createSetup(visitors, { deck: ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'] });
  const positions = [[1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0]];
  for (const [floor, x, y, rotation] of positions) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  const opening = createOpening(setup, { hakoId: hako, itemChoices: visitors.map((playerId, index) => ({
    playerId, itemId: [itemId, 'walkie_talkie', 'deduction'][index],
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
  assert.deepEqual(play, before, 'an accepted action must leave its input detached');
  return next;
}
function rejects(play, id, action) {
  const before = structuredClone(play);
  assert.throws(() => applyPlayAction(play, id, action), /[\u4e00-\u9fff]/);
  assert.deepEqual(play, before, 'an invalid action must not mutate its input');
}
function reveal(play, id = first) {
  return act(play, id, { type: 'silent_reveal', index: play.round.silent.cards.findIndex(card => card.status === 'down') });
}
function use(play, itemId, extra = {}, id = first) {
  play = act(play, id, { type: 'use_item', itemId, ...extra });
  return act(play, hako, { type: 'resolve_visitor_action' });
}
function nextFirstTurn(play) {
  while (play.round.silent.turnPlayerId !== first) {
    const id = play.round.silent.turnPlayerId;
    play = reveal(play, id);
    play = act(play, id, { type: 'move', roomId: getPlayView(play, id).moveTargets[0] });
    play = act(play, hako, { type: 'resolve_visitor_action' });
  }
  return reveal(play);
}

test('item selections and held cards expose current effect descriptions, including old saved suitcase text', () => {
  let play = reveal(newPlay('suitcase'));
  play.inventories[first].items[0].description = '卡面未注明动作消耗。';
  const view = getPlayView(play, first);
  const expected = INITIAL_ITEMS.find(item => item.id === 'suitcase').description;
  assert.match(expected, /消耗标准行动/);
  assert.equal(view.items.usableItems.find(item => item.id === 'suitcase').description, expected);
  assert.equal(view.inventory.items.find(item => item.id === 'suitcase').description, expected);
  assert.equal(play.inventories[first].items[0].description, '卡面未注明动作消耗。', 'Reading the current help does not rewrite saved inventory');
  view.inventory.items[0].description = 'changed';
  assert.equal(getPlayView(play, first).inventory.items[0].description, expected);
});

test('active items wait for hako, consume one standard action, and remain reusable', () => {
  let play = newPlay('dowsing_rod');
  rejects(play, first, { type: 'use_item', itemId: 'dowsing_rod' });
  play = reveal(play);
  rejects(play, first, { type: 'use_item', itemId: 'smartphone', targetZone: 'hand', index: 0 });
  rejects(play, second, { type: 'use_item', itemId: 'dowsing_rod' });
  play = act(play, first, { type: 'use_item', itemId: 'dowsing_rod' });
  assert.equal(play.round.pendingAction.type, 'item');
  assert.equal(play.resolution, null);
  assert.equal(play.itemEvents.length, 0);
  rejects(play, second, { type: 'resolve_visitor_action' });
  rejects(play, first, { type: 'use_item', itemId: 'dowsing_rod' });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, hako).resolution.truth, 1);
  assert.deepEqual(getPlayView(play, first).resolution, { kind: 'waiting', playerId: hako });
  rejects(play, first, { type: 'answer_item', answer: 1 });
  rejects(play, hako, { type: 'answer_item', answer: 2 });
  play = act(play, hako, { type: 'answer_item', answer: 1 });
  assert.equal(play.round.silent.turnPlayerId, second);
  assert.equal(play.round.silent.phase, 'visitor_reveal');
  assert.equal(play.inventories[first].items[0].id, 'dowsing_rod');
  assert.equal(play.itemEvents[0].answer, 1);
  for (const id of visitors) {
    const event = getPlayView(play, id).items.events[0];
    assert.equal(Object.hasOwn(event, 'truth'), false);
    assert.equal(Object.hasOwn(event, 'canLie'), false);
  }
  play = use(nextFirstTurn(play), 'dowsing_rod');
  play = act(play, hako, { type: 'answer_item', answer: 1 });
  assert.equal(play.itemEvents.length, 2);
  assert.equal(play.inventories[first].items[0].id, 'dowsing_rod');
});

test('spirit pen requires a companion and active NO9 announces every legal truthful or false answer alike', () => {
  for (const [active, answer] of [[false, true], [true, true], [true, false]]) {
    let play = reveal(newPlay());
    play.round.visitors.find(player => player.id === second).roomId = 'study_room';
    play.round.visitors.find(player => player.id === third).roomId = 'study_room';
    rejects(play, first, { type: 'use_item', itemId: 'spirit_pen', roomId: 'children_room' });
    play.round.visitors.find(player => player.id === second).roomId = 'hall_room';
    if (active) play.powers.slots[0] = { id: 9, ignoreThreshold: false, faceUp: false };
    rejects(play, first, { type: 'use_item', itemId: 'spirit_pen', roomId: 'not-a-room' });
    play = use(play, 'spirit_pen', { roomId: 'children_room' });
    assert.equal(getPlayView(play, hako).resolution.truth, true);
    assert.equal(getPlayView(play, hako).resolution.answerOptions.length, active ? 2 : 1);
    rejects(play, hako, { type: 'answer_item', answer: 'true' });
    if (!active) rejects(play, hako, { type: 'answer_item', answer: false });
    assert.equal(play.powers.activationNotice, null, 'Rejected answers cannot produce an announcement');
    play = act(play, hako, { type: 'answer_item', answer });
    assert.equal(play.itemEvents.at(-1).answer, answer);
    assert.equal(getPlayView(play, first).powers.lastActivation, null);
    assert.deepEqual(getPlayView(play, first).powers.activationNotice, active ? { serial: 1, cycle: 1 } : null);
    assert.equal(getPlayView(play, hako).powers.lastActivation?.powerId, active ? 9 : undefined);
    assert.equal(getPlayView(play, first).powers.slots[0].card, undefined);
    for (const id of visitors) {
      const event = getPlayView(play, id).items.events.at(-1);
      for (const key of ['truth', 'canLie', 'sourcePowerId', 'powerId', 'card']) {
        assert.equal(Object.hasOwn(event, key), false);
      }
    }
    assert.equal(play.round.silent.turnPlayerId, second);
  }
});

test('item room options contain whole boards and a companion in a printed subdivision counts as same-room', () => {
  let play = reveal(newPlay('spirit_pen'));
  play.round.visitors.find(player => player.id === first).roomId = 'bathroom_room';
  play.round.visitors.find(player => player.id === second).roomId = 'toilet_stall';
  const options = getPlayView(play, first).items.roomOptions;
  assert.equal(options.length, 9);
  assert.ok(!options.some(room => ['toilet_stall', 'dark_room', 'blue_bedroom', 'kitchen'].includes(room.id)));
  assert.ok(getPlayView(play, first).items.usableItems.some(item => item.id === 'spirit_pen'));
  play = use(play, 'spirit_pen', { roomId: 'dark_room' });
  assert.equal(play.resolution.roomId, 'study_room');
  assert.equal(play.resolution.truth, false);
});

test('active item same-room death spans the entire printed board', () => {
  let play = reveal(newPlay('smartphone'));
  play.round.visitors.find(player => player.id === first).roomId = 'study_room';
  play.round.hidingCornerId = 'dark_bed';
  play = use(play, 'smartphone', { targetZone: 'hand', index: 0 });
  assert.equal(play.round.visitors.find(player => player.id === first).status, 'box_person');
  assert.equal(play.itemResults[first], null);
});

test('a suitcase saved in a subdivision prevents placing a second suitcase elsewhere on the same board', () => {
  const play = reveal(newPlay('suitcase'));
  play.round.visitors.find(player => player.id === first).roomId = 'bathroom_room';
  const cornerId = 'suitcase:toilet_stall';
  play.extraCorners[cornerId] = { id: cornerId, roomId: 'toilet_stall', name: '行李箱中' };
  play.tokens[cornerId] = { id: 'saved-suitcase-empty', type: 'empty_box' };
  assert.ok(!getPlayView(play, first).items.usableItems.some(item => item.id === 'suitcase'));
  rejects(play, first, { type: 'use_item', itemId: 'suitcase' });
});

test('smartphone reveals exactly the selected card to its user and views are detached', () => {
  let play = reveal(newPlay('smartphone'));
  play.powers.hand = [{ id: 2, ignoreThreshold: false }, { id: 9, ignoreThreshold: true }];
  play.powers.slots[0] = { id: 5, ignoreThreshold: false, faceUp: false };
  rejects(play, first, { type: 'use_item', itemId: 'smartphone', targetZone: 'hand', index: 2 });
  rejects(play, first, { type: 'use_item', itemId: 'smartphone', targetZone: 'slot', index: 1 });
  play = use(play, 'smartphone', { targetZone: 'hand', index: 1 });
  const mine = getPlayView(play, first);
  assert.equal(mine.items.result.card.id, 9);
  assert.equal(mine.items.result.card.name, '虚假的回应');
  assert.equal(mine.items.result.card.ignoreThreshold, true);
  assert.equal(Object.hasOwn(mine.items.result, 'hand'), false);
  for (const id of [second, third, hako]) assert.equal(getPlayView(play, id).items.result, null);
  for (const id of [second, third]) {
    assert.equal(JSON.stringify(getPlayView(play, id)).includes('虚假的回应'), false);
    assert.equal(Object.hasOwn(getPlayView(play, id).items.events[0], 'card'), false);
  }
  const before = structuredClone(play);
  mine.items.result.card.name = 'changed';
  mine.items.events[0].itemId = 'changed';
  mine.items.roomOptions[0].name = 'changed';
  assert.deepEqual(play, before);
});

test('same-room lethal active items kill before returning answers or applying effects', () => {
  for (const itemId of ['smartphone', 'spirit_pen', 'ventriloquist_doll', 'nightmare_letter', 'dowsing_rod']) {
    let play = reveal(newPlay(itemId));
    play.round.hidingCornerId = 'hall_clock';
    const deckBefore = [...play.powers.deck];
    const notesBefore = structuredClone(play.notebooks);
    play = use(play, itemId, { roomId: 'children_room', targetZone: 'hand', index: 0 });
    assert.equal(play.round.visitors.find(player => player.id === first).status, 'box_person');
    assert.equal(play.ghosts.find(ghost => ghost.playerId === first).cornerId, 'hall_clock');
    assert.deepEqual(play.resolution, { kind: 'inheritance', playerId: first });
    assert.equal(play.itemResults[first], null);
    assert.deepEqual(play.powers.deck, deckBefore);
    assert.deepEqual(play.notebooks, notesBefore);
    assert.equal(play.itemEvents.length, 0);
  }
});

test('nightmare letter moves despair to the bottom without discarding the reusable item', () => {
  let play = reveal(newPlay('nightmare_letter'));
  play.powers.deck = [2, 'despair', 3, 4];
  play = use(play, 'nightmare_letter');
  assert.deepEqual(play.powers.deck, [2, 3, 4, 'despair']);
  assert.equal(play.inventories[first].items[0].id, 'nightmare_letter');
  assert.equal(play.discarded.length, 0);
  assert.equal(play.round.silent.turnPlayerId, second);
});

test('ventriloquist publishes real notebooks with replacements, excludes hidden base pieces, and only lies about the doll', () => {
  let play = reveal(newPlay('ventriloquist_doll'));
  play.powers.slots[0] = { id: 9, ignoreThreshold: false, faceUp: false };
  play.tokens.children_cabinet = { id: 'room-notebook', type: 'notebook', number: 7 };
  play.tokens.children_toys = { id: 'private-room-doll', type: 'doll' };
  play.tokens.children_bed = { id: 'hidden-base-notebook', type: 'notebook', number: 8 };
  const boxes = play.opening.emptyBoxTokens.length;
  play = use(play, 'ventriloquist_doll', { roomId: 'children_room' });
  assert.deepEqual(play.notebooks.map(note => note.number), [7]);
  assert.equal(play.tokens.children_cabinet.type, 'empty_box');
  assert.equal(play.tokens.children_cabinet.faceUp, false);
  assert.equal(play.opening.emptyBoxTokens.length, boxes - 1);
  assert.equal(play.tokens.children_bed.id, 'hidden-base-notebook');
  assert.equal(getPlayView(play, hako).resolution.truth, true);
  for (const id of visitors) {
    const view = getPlayView(play, id);
    assert.deepEqual(view.notebooks.map(note => note.number), [7]);
    assert.equal(JSON.stringify(view).includes('private-room-doll'), false);
    assert.equal(JSON.stringify(view).includes('hidden-base-notebook'), false);
  }
  play = act(play, hako, { type: 'answer_item', answer: false });
  assert.equal(play.itemEvents.at(-1).answer, false);
  assert.deepEqual(play.itemEvents.at(-1).notebooks.map(note => note.number), [7]);
  assert.deepEqual(play.notebooks.map(note => note.number), [7]);
});

test('suitcase is single-use and its corner participates in peeking, attacks and hiding', () => {
  let play = reveal(newPlay('suitcase'));
  const cornerId = 'suitcase:hall_room';
  const boxes = play.opening.emptyBoxTokens.length;
  play = use(play, 'suitcase');
  assert.equal(play.inventories[first].items.length, 0);
  assert.equal(play.placedItems[0].id, 'suitcase');
  assert.equal(play.extraCorners[cornerId].roomId, 'hall_room');
  assert.equal(play.opening.emptyBoxTokens.length, boxes - 1);
  assert.equal(play.tokens[cornerId].faceUp, false);
  play = reveal(play, second);
  rejects(play, second, { type: 'use_item', itemId: 'suitcase' });
  assert.ok(getPlayView(play, second).peekTargets.includes(cornerId));
  play = act(play, second, { type: 'peek', cornerId });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(getPlayView(play, second).resolution.token.type, 'empty_box');
  play = act(play, second, { type: 'resolve_peek', take: false });
  play = reveal(play, third);
  play.inventories[third].tokens.push({ id: 'suitcase-test-weapon', type: 'weapon', tool: 'white_stick' });
  assert.ok(getPlayView(play, third).weaponTargets.includes(cornerId));
  play = act(play, third, { type: 'use_weapon', tokenId: 'suitcase-test-weapon', cornerId });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(play.tokens[cornerId], null);
  assert.equal(play.extraCorners[cornerId].id, cornerId, 'destroying its marker leaves the suitcase location');
  play.round.hidingCornerId = 'hall_clock';
  Object.assign(play.round.silent, { phase: 'hako_reaction', turnPlayerId: null, resumePlayerId: first, total: 11, trigger: 'overflow' });
  play = act(play, hako, { type: 'pass_noise_reaction' });
  play = act(play, hako, { type: 'begin_hako_action' });
  play = act(play, hako, { type: 'inspect_hiding_room', roomId: 'hall_room' });
  assert.ok(getPlayView(play, hako).hako.hidingTargets.includes(cornerId));
  play = act(play, hako, { type: 'hako_hide', cornerId });
  assert.equal(play.round.hidingCornerId, cornerId);
  assert.deepEqual(getPlayView(play, first).hako, { playerId: hako });
});

test('amulet consumes its own token, removes the selected power and clears persistent NO10 state', () => {
  let play = reveal(newPlay('smartphone'));
  play.inventories[first].tokens.push({ id: 'owned-amulet', type: 'amulet' });
  play.powers.slots[0] = { id: 10, ignoreThreshold: false, faceUp: true };
  rejects(play, first, { type: 'use_item', itemId: 'amulet', tokenId: 'not-owned', index: 0 });
  rejects(play, first, { type: 'use_item', itemId: 'amulet', tokenId: 'owned-amulet', index: 1 });
  play = act(play, first, { type: 'use_item', itemId: 'amulet', tokenId: 'owned-amulet', index: 0 });
  // Exercise cleanup of the persistent flag while this declared action awaits resolution.
  play.powers.ghostCall.active = true;
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(play.powers.ghostCall.active, false);
  assert.equal(play.powers.slots[0], null);
  assert.ok(play.powers.removed.some(card => card?.id === 10));
  assert.ok(play.removedTokens.some(token => token.id === 'owned-amulet'));
  assert.equal(play.inventories[first].tokens.length, 0);
  assert.equal(play.inventories[first].items[0].id, 'smartphone');
  assert.equal(play.round.silent.turnPlayerId, second);
});
