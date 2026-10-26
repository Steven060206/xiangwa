import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import {
  INITIAL_ITEMS, createItemDraft, chooseItem, getItemDraftView, createOpening,
  chooseSecrets, placeRemains, inspectInitialRoom, chooseInitialHiding,
  chooseInitialPower, getOpeningView,
} from '../src/preparation.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const hakoId = 'hako';
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

function completedSetup() {
  const setup = createSetup(visitors, { deck });
  const positions = [
    [1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0],
  ];
  for (const [floor, x, y, rotation] of positions) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  return setup;
}

function itemChoices() {
  return visitors.map((playerId, index) => ({ playerId, itemId: INITIAL_ITEMS[index].id }));
}

function newOpening() {
  return createOpening(completedSetup(), { hakoId, itemChoices: itemChoices() });
}

function afterSecrets() {
  const opening = newOpening();
  chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  return opening;
}

function afterRemains() {
  const opening = afterSecrets();
  placeRemains(opening, hakoId, 'hall_clock');
  return opening;
}

function beforePower() {
  const opening = afterRemains();
  inspectInitialRoom(opening, hakoId, 'children_room');
  chooseInitialHiding(opening, hakoId, 'children_bed');
  return opening;
}

function rejectsWithoutMutation(state, action) {
  const before = structuredClone(state);
  assert.throws(action, /[\u4e00-\u9fff]/);
  assert.deepEqual(state, before);
}

function assertPublicOpening(opening) {
  const forbidden = new Set([
    'password', 'passwordOptions', 'weakness', 'weaknessOptions', 'remainsCornerId',
    'hidingCornerId', 'hidingUnderToken', 'inspectedRoom', 'powerDeck', 'deck',
    'cornerTokens', 'token', 'number', 'tool', 'type', 'safeBoard', 'emptyBoxTokens',
    'remainsTargets', 'hidingRooms', 'hidingTargets', 'initialPowerOptions',
    'initialPowerIgnoresNotebookRequirement',
  ]);
  function checkKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `visitor view contains private key ${key}`);
      checkKeys(child);
    }
  }
  for (const playerId of visitors) {
    const view = getOpeningView(opening, playerId);
    assert.equal(view.phase, opening.phase);
    assert.equal(view.hakoId, hakoId);
    assert.equal(view.corners.length, 24);
    assert.ok(view.corners.every(corner => typeof corner.occupied === 'boolean'));
    checkKeys(view);
    const keys = ['phase', 'hakoId', 'itemChoices', 'corners'];
    if (opening.initialPowerId !== null) keys.push('initialPowerId', 'initialPowerName');
    assert.deepEqual(Object.keys(view).sort(), keys.sort());
  }
  assert.throws(() => getOpeningView(opening, 'outsider'), /本局玩家/);
}

test('item draft requires three distinct visitors and a complete pool with distinct card ids', () => {
  for (const ids of [[], ['a', 'b'], ['a', 'a', 'b'], ['a', 'b', ''], ['a', 'b', 3]]) {
    assert.throws(() => createItemDraft(ids), /访问者/);
  }
  const items = INITIAL_ITEMS.slice(0, 3).map(item => ({ ...item }));
  for (const pool of [[], items.slice(0, 2), [items[0], items[0], items[1]],
    [{ ...items[0], id: '' }, items[1], items[2]],
    [{ ...items[0], name: '' }, items[1], items[2]],
    [{ ...items[0], description: null }, items[1], items[2]]]) {
    assert.throws(() => createItemDraft(visitors, { items: pool }), /道具/);
  }
  // Separate physical copies may share a printed name but must have separate ids.
  items[1].name = items[0].name;
  const ids = [...visitors];
  const draft = createItemDraft(ids, { items });
  assert.equal(getItemDraftView(draft).availableItems.length, 3);
  ids[0] = 'changed';
  items[0].name = 'changed';
  assert.equal(draft.visitorIds[0], visitors[0]);
  assert.notEqual(draft.items[0].name, 'changed');
});

test('visitors choose distinct initial items in seat order and the draft stops after three choices', () => {
  const draft = createItemDraft(visitors);
  const [first, second, third] = INITIAL_ITEMS;
  assert.equal(draft.phase, 'item_draft');
  assert.equal(draft.turnPlayerId, visitors[0]);
  rejectsWithoutMutation(draft, () => chooseItem(draft, hakoId, first.id));
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[1], first.id));
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[0], 'unknown-card'));
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[0], undefined));
  chooseItem(draft, visitors[0], first.id);
  assert.equal(draft.turnPlayerId, visitors[1]);
  assert.equal(getItemDraftView(draft).availableItems.some(item => item.id === first.id), false);
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[1], first.id));
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[0], second.id));
  chooseItem(draft, visitors[1], second.id);
  const view = chooseItem(draft, visitors[2], third.id);
  assert.equal(view.phase, 'items_ready');
  assert.equal(view.turnPlayerId, null);
  assert.deepEqual(view.choices.map(({ playerId, itemId }) => ({ playerId, itemId })), itemChoices());
  assert.equal(view.availableItems.length, INITIAL_ITEMS.length - 3);
  rejectsWithoutMutation(draft, () => chooseItem(draft, visitors[0], first.id));
});

test('item draft views detach participant ids, choices, card names and descriptions', () => {
  const draft = createItemDraft(visitors);
  chooseItem(draft, visitors[0], INITIAL_ITEMS[0].id);
  const before = structuredClone(draft);
  const view = getItemDraftView(draft);
  assert.equal(view.choices[0].itemDescription, INITIAL_ITEMS[0].description,
    'A picked card retains its effect for later viewing');
  view.visitorIds[0] = 'changed';
  view.choices[0].itemId = 'changed';
  view.choices[0].itemDescription = 'changed';
  view.choices.push({ playerId: 'changed', itemId: 'changed' });
  view.availableItems[0].name = 'changed';
  view.availableItems[0].description = 'changed';
  view.availableItems.pop();
  assert.deepEqual(draft, before);
});

test('opening requires all nine map tiles, a separate hako and one distinct item per visitor', () => {
  const setup = completedSetup();
  const choices = itemChoices();
  const options = { hakoId, itemChoices: choices };
  for (const invalid of [createSetup(visitors), { ...setup, phase: 'map_setup' },
    { ...setup, placements: setup.placements.slice(1) },
    { ...setup, placements: [...setup.placements.slice(0, -1), setup.placements[0]] },
    { ...setup, placements: setup.placements.map((placement, index) => index ? placement : { ...placement, tileId: 'unknown' }) }]) {
    assert.throws(() => createOpening(invalid, options), /九块/);
  }
  for (const invalidId of [undefined, '', ' ', visitors[0]]) {
    assert.throws(() => createOpening(setup, { ...options, hakoId: invalidId }), /箱娃/);
  }
  for (const invalidChoices of [undefined, choices.slice(1),
    choices.map((choice, index) => index ? choice : { ...choice, playerId: 'outsider' }),
    choices.map((choice, index) => index ? choice : { ...choice, playerId: visitors[1] }),
    choices.map((choice, index) => index ? choice : { ...choice, itemId: choices[1].itemId }),
    choices.map((choice, index) => index ? choice : { ...choice, itemId: '' })]) {
    assert.throws(() => createOpening(setup, { ...options, itemChoices: invalidChoices }), /道具/);
  }
  assert.throws(() => createOpening({ ...setup, visitorIds: [visitors[0], visitors[0], visitors[2]] }, options), /访问者/);
  const before = structuredClone({ setup, choices });
  const opening = createOpening(setup, options);
  assert.equal(opening.phase, 'secrets');
  assert.equal(opening.cornerTokens.study_desk.type, 'safe');
  assert.equal(opening.emptyBoxTokens.length, 24);
  assert.equal(new Set(opening.emptyBoxTokens.map(token => token.id)).size, 24);
  assert.ok(opening.emptyBoxTokens.every(token => token.type === 'empty_box'));
  assert.deepEqual(opening.safeBoard.key, { id: 'key', type: 'key' });
  opening.placements[0].x = 99;
  opening.visitorIds[0] = 'changed';
  opening.itemChoices[0].itemId = 'changed';
  assert.deepEqual({ setup, choices }, before);
});

test('passwords use three different numbers from 1 to 6 and invalid secret choices never alter state', () => {
  const opening = newOpening();
  for (const password of [undefined, [], [1, 2], [1, 2, 3, 4], [1, 1, 2], [0, 2, 3],
    [1, 2, 7], [1, 2, 2.5], [1, 2, '3'], [1, 2, NaN]]) {
    rejectsWithoutMutation(opening, () => chooseSecrets(opening, hakoId, { password, weakness: 'gasoline' }));
  }
  rejectsWithoutMutation(opening, () => chooseSecrets(opening, hakoId, null));
  rejectsWithoutMutation(opening, () => chooseSecrets(opening, visitors[0], { password: [1, 2, 3], weakness: 'gasoline' }));
  rejectsWithoutMutation(opening, () => chooseSecrets(opening, hakoId, { password: [1, 2, 3], weakness: 'unknown-tool' }));
  const password = [6, 2, 4];
  chooseSecrets(opening, hakoId, { password, weakness: 'white_stick' });
  assert.deepEqual(opening.password, [2, 4, 6]);
  password[0] = 1;
  assert.deepEqual(opening.password, [2, 4, 6]);
  rejectsWithoutMutation(opening, () => chooseSecrets(opening, hakoId, { password: [1, 2, 3], weakness: 'gasoline' }));
});

test('the complete p4 mix has 22 tokens, the fixed study safe and exactly one empty corner', () => {
  for (const weakness of ['white_stick', 'gasoline', 'rusty_chain']) {
    const opening = newOpening();
    chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness });
    const tokens = Object.values(opening.cornerTokens).filter(Boolean);
    const types = {};
    for (const token of tokens) types[token.type] = (types[token.type] ?? 0) + 1;
    assert.equal(Object.keys(opening.cornerTokens).length, 24);
    assert.equal(Object.values(opening.cornerTokens).filter(token => token === null).length, 1);
    assert.equal(tokens.length, 23);
    assert.equal(new Set(tokens.map(token => token.id)).size, 23);
    assert.deepEqual(types, {
      safe: 1, notebook: 10, weapon: 3, password: 3, weakness_clue: 2,
      doll: 1, hidden_exit: 1, amulet: 1, extinguisher: 1,
    });
    assert.deepEqual(opening.cornerTokens.study_desk, { id: 'safe', type: 'safe' });
    assert.deepEqual(tokens.filter(token => token.type === 'notebook').map(token => token.number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(tokens.filter(token => token.type === 'password').map(token => token.number).sort(), [2, 4, 6]);
    assert.deepEqual(tokens.filter(token => token.type === 'weapon').map(token => token.tool).sort(), ['gasoline', 'rusty_chain', 'white_stick']);
    assert.deepEqual(tokens.filter(token => token.type === 'weakness_clue').map(token => token.tool).sort(),
      ['white_stick', 'gasoline', 'rusty_chain'].filter(tool => tool !== weakness).sort());
    assert.equal(tokens.some(token => ['empty_box', 'hako', 'box_person', 'remains', 'key'].includes(token.type)), false);
    assert.equal(opening.phase, 'remains');
  }
});

test('remains cannot replace the safe and displaced contents move to the one empty corner', () => {
  const opening = afterSecrets();
  rejectsWithoutMutation(opening, () => placeRemains(opening, hakoId, 'study_desk'));
  rejectsWithoutMutation(opening, () => placeRemains(opening, hakoId, 'unknown-corner'));
  rejectsWithoutMutation(opening, () => placeRemains(opening, visitors[0], 'hall_clock'));
  const emptyId = Object.keys(opening.cornerTokens).find(id => opening.cornerTokens[id] === null);
  const targetId = Object.keys(opening.cornerTokens).find(id => id !== 'study_desk' && opening.cornerTokens[id] !== null);
  const displaced = structuredClone(opening.cornerTokens[targetId]);
  const before = structuredClone(opening.cornerTokens);
  placeRemains(opening, hakoId, targetId);
  assert.equal(opening.phase, 'hiding_room');
  assert.equal(opening.remainsCornerId, targetId);
  assert.deepEqual(opening.cornerTokens[targetId], { id: 'remains', type: 'remains' });
  assert.deepEqual(opening.cornerTokens[emptyId], displaced);
  for (const [cornerId, token] of Object.entries(before)) {
    if (![emptyId, targetId].includes(cornerId)) assert.deepEqual(opening.cornerTokens[cornerId], token);
  }
  assert.ok(Object.values(opening.cornerTokens).every(Boolean));
  assert.equal(Object.values(opening.cornerTokens).filter(token => token.id === displaced.id).length, 1);
  rejectsWithoutMutation(opening, () => placeRemains(opening, hakoId, targetId));
});

test('remains may directly fill the empty corner without moving any other token', () => {
  const opening = afterSecrets();
  const emptyId = Object.keys(opening.cornerTokens).find(id => opening.cornerTokens[id] === null);
  const before = structuredClone(opening.cornerTokens);
  placeRemains(opening, hakoId, emptyId);
  assert.equal(opening.remainsCornerId, emptyId);
  assert.equal(opening.cornerTokens[emptyId].type, 'remains');
  for (const [cornerId, token] of Object.entries(before)) {
    if (cornerId !== emptyId) assert.deepEqual(opening.cornerTokens[cornerId], token);
  }
  assert.ok(Object.values(opening.cornerTokens).every(Boolean));
});

test('hako inspects exactly one haunted room and hides only there, preserving the covered token', () => {
  for (const [roomId, cornerIds, outsideId] of [
    ['children_room', ['children_cabinet', 'children_toys', 'children_bed'], 'dark_wardrobe'],
    ['dark_room', ['dark_wardrobe', 'dark_bed'], 'children_bed'],
  ]) {
    const opening = afterRemains();
    rejectsWithoutMutation(opening, () => inspectInitialRoom(opening, hakoId, 'hall_room'));
    rejectsWithoutMutation(opening, () => inspectInitialRoom(opening, visitors[0], roomId));
    rejectsWithoutMutation(opening, () => chooseInitialHiding(opening, hakoId, cornerIds[0]));
    const view = inspectInitialRoom(opening, hakoId, roomId);
    assert.equal(opening.phase, 'hiding_corner');
    assert.equal(view.inspectedRoom.id, roomId);
    assert.deepEqual(view.inspectedRoom.corners.map(corner => corner.id), cornerIds);
    assert.deepEqual(view.hidingTargets, cornerIds);
    for (const corner of view.inspectedRoom.corners) assert.deepEqual(corner.token, opening.cornerTokens[corner.id]);
    rejectsWithoutMutation(opening, () => inspectInitialRoom(opening, hakoId, roomId === 'dark_room' ? 'children_room' : 'dark_room'));
    rejectsWithoutMutation(opening, () => chooseInitialHiding(opening, hakoId, outsideId));
    rejectsWithoutMutation(opening, () => chooseInitialHiding(opening, visitors[0], cornerIds[0]));
    const previous = structuredClone(opening.cornerTokens[cornerIds[0]]);
    const otherTokens = structuredClone(opening.cornerTokens);
    chooseInitialHiding(opening, hakoId, cornerIds[0]);
    assert.equal(opening.phase, 'power');
    assert.equal(opening.hidingCornerId, cornerIds[0]);
    assert.deepEqual(opening.hidingUnderToken, previous);
    assert.deepEqual(opening.cornerTokens[cornerIds[0]], { id: 'hako', type: 'hako' });
    for (const [id, token] of Object.entries(otherTokens)) {
      if (id !== cornerIds[0]) assert.deepEqual(opening.cornerTokens[id], token);
    }
    rejectsWithoutMutation(opening, () => chooseInitialHiding(opening, hakoId, cornerIds[1]));
  }
});

test('initial power forbids 4 and 12, bypasses notebook threshold, and keeps remaining powers secret', () => {
  const opening = beforePower();
  const options = getOpeningView(opening, hakoId).initialPowerOptions;
  assert.deepEqual(options.map(power => power.id), [1, 2, 3, 5, 6, 7, 8, 9, 10]);
  for (const powerId of [0, 4, 11, 12, 13, 1.5, '1', undefined]) {
    rejectsWithoutMutation(opening, () => chooseInitialPower(opening, hakoId, powerId));
  }
  rejectsWithoutMutation(opening, () => chooseInitialPower(opening, visitors[0], 1));
  chooseInitialPower(opening, hakoId, 1);
  assert.equal(opening.phase, 'opening_ready');
  assert.equal(opening.initialPowerId, 1);
  assert.equal(opening.initialPowerIgnoresNotebookRequirement, true);
  assert.equal(opening.powerDeck.length, 11);
  assert.equal(new Set(opening.powerDeck).size, 11);
  assert.deepEqual(opening.powerDeck.filter(id => typeof id === 'number').sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(opening.powerDeck.includes('despair'));
  assert.equal(opening.powerDeck.includes(1), false);
  assert.equal(opening.powerDeck.includes(12), false);
  for (const playerId of [hakoId, ...visitors]) {
    const view = getOpeningView(opening, playerId);
    assert.equal(view.initialPowerId, 1);
    assert.equal(view.initialPowerName, '就在你身旁');
    assert.equal(Object.hasOwn(view, 'powerDeck'), false);
  }
  rejectsWithoutMutation(opening, () => chooseInitialPower(opening, hakoId, 2));
});

test('each preparation stage exposes only public occupancy and the public initial power to visitors', () => {
  const opening = newOpening();
  assertPublicOpening(opening);
  chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  assertPublicOpening(opening);
  placeRemains(opening, hakoId, 'children_bed');
  assertPublicOpening(opening);
  inspectInitialRoom(opening, hakoId, 'children_room');
  assertPublicOpening(opening);
  chooseInitialHiding(opening, hakoId, 'children_bed');
  assert.equal(opening.hidingUnderToken.type, 'remains');
  assertPublicOpening(opening);
  chooseInitialPower(opening, hakoId, 1);
  assertPublicOpening(opening);
});

test('all opening views copy nested secret options, inspected tokens and public choice records', () => {
  const opening = newOpening();
  const initial = getOpeningView(opening, hakoId);
  const initialBefore = structuredClone(opening);
  initial.passwordOptions[0] = 99;
  initial.weaknessOptions[0].id = 'changed';
  initial.weaknessOptions[0].name = 'changed';
  initial.itemChoices[0].itemId = 'changed';
  initial.corners[0].occupied = false;
  assert.deepEqual(opening, initialBefore);
  assert.deepEqual(getOpeningView(opening, hakoId).passwordOptions, [1, 2, 3, 4, 5, 6]);
  assert.equal(getOpeningView(opening, hakoId).weaknessOptions[0].name, '白木棒');
  chooseSecrets(opening, hakoId, { password: [1, 3, 5], weakness: 'gasoline' });
  const secretsBefore = structuredClone(opening);
  const secrets = getOpeningView(opening, hakoId);
  secrets.password[0] = 99;
  secrets.remainsTargets.push('changed');
  assert.deepEqual(opening, secretsBefore);
  placeRemains(opening, hakoId, 'hall_clock');
  const rooms = getOpeningView(opening, hakoId);
  rooms.hidingRooms[0].name = 'changed';
  assert.notEqual(getOpeningView(opening, hakoId).hidingRooms[0].name, 'changed');
  inspectInitialRoom(opening, hakoId, 'children_room');
  const inspectedBefore = structuredClone(opening);
  const inspected = getOpeningView(opening, hakoId);
  inspected.inspectedRoom.corners[0].token.id = 'changed';
  inspected.inspectedRoom.corners[0].token.type = 'changed';
  inspected.inspectedRoom.corners.push({ id: 'changed', token: null });
  inspected.hidingTargets.push('changed');
  assert.deepEqual(opening, inspectedBefore);
  chooseInitialHiding(opening, hakoId, 'children_bed');
  const powerBefore = structuredClone(opening);
  const power = getOpeningView(opening, hakoId);
  power.hidingUnderToken.id = 'changed';
  power.initialPowerOptions[0].name = 'changed';
  const publicView = getOpeningView(opening, visitors[0]);
  publicView.itemChoices[0].playerId = 'changed';
  publicView.corners[0].id = 'changed';
  publicView.corners.push({ id: 'changed', roomId: 'changed', occupied: false });
  assert.deepEqual(opening, powerBefore);
});
