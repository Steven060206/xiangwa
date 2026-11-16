import test from 'node:test';
import assert from 'node:assert/strict';
import { clueSummary, renderClueSummary, createHelpUI } from '../public/help.js';
import { createFeedbackUI } from '../public/feedback-view.js';
import { createFeedbackTracker } from '../public/feedback.js';

function state(version = 1) {
  return { code: 'ROOM01', you: 'visitor-a', version, phase: 'exploration', log: [],
    players: [{ id: 'hako', name: '箱娃' }, { id: 'visitor-a', name: '访问者甲' }, { id: 'visitor-b', name: '访问者乙' }],
    undo: { steps: 1 },
    round: { phase: 'visitor_action', hako: { playerId: 'hako' }, silent: { turnPlayerId: 'visitor-b' },
      visitors: [{ id: 'visitor-a', status: 'alive' }, { id: 'visitor-b', status: 'alive' }],
      inventory: { tokens: [], items: [] }, powers: { slots: [] }, items: {},
      publicDiscoveries: [], safe: { publicNumbers: [] }, notebooks: [], exchangeOffers: [] } };
}
const nextState = (old, edit) => { const next = structuredClone(old); next.version++; edit(next); return next; };

function mockDocument(t) {
  const oldDocument = globalThis.document;
  const nodes = new Map();
  const emitted = [];
  const cleanups = [];
  const doc = new EventTarget();
  class Element extends EventTarget {
    children = [];
    dataset = {};
    attributes = {};
    textContent = '';
    hidden = false;
    open = false;
    disabled = false;
    isConnected = true;
    scrollTop = 0;
    classList = { toggle() {} };
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...elements) { this.children.push(...elements); }
    replaceChildren(...elements) { this.children = elements; }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    hidePopover() { this.hidden = true; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 100 }; }
    click() { this.dispatchEvent(new Event('click')); }
  }
  doc.getElementById = id => nodes.get(id) || null;
  doc.createElement = () => new Element();
  doc.createElementNS = () => new Element();
  doc.body = new Element();
  doc.activeElement = new Element();
  const dispatch = doc.dispatchEvent.bind(doc);
  doc.dispatchEvent = event => { emitted.push(event.type); return dispatch(event); };
  for (const id of ['event-dialog', 'event-count', 'event-history-toggle', 'event-history-empty', 'event-history-list',
    'event-history', 'event-position', 'event-next', 'event-primary-action', 'event-title', 'event-body',
    'event-visibility', 'event-symbol', 'event-companions', 'event-toast', 'event-close', 'focus-current-action',
    'room-menu-toggle', 'room-menu', 'room-menu-content']) {
    const element = new Element();
    element.id = id;
  }
  globalThis.document = doc;
  t.after(() => { for (const cleanup of cleanups) cleanup(); globalThis.document = oldDocument; });
  return { doc, node: id => nodes.get(id), emitted, cleanup: callback => cleanups.push(callback) };
}
const textOf = element => [element.textContent, ...element.children.map(textOf)].join(' ');

test('clue summary distinguishes exclusion, ineffective weapon and confirmed numbers, deduplicating provenance', () => {
  const snapshot = state();
  snapshot.round.inventory.tokens = [{ id: 'password_4', type: 'password', number: 4 },
    { id: 'clue_gasoline', type: 'weakness_clue', tool: 'gasoline' }];
  snapshot.round.publicDiscoveries = [
    { playerId: 'visitor-a', token: { id: 'password_4', type: 'password', number: 4 }, cornerId: 'old_corner' },
    { playerId: 'visitor-b', token: { id: 'same_number', type: 'password', number: 4 } },
  ];
  snapshot.round.safe.publicNumbers = [2, 2];
  const entries = clueSummary(snapshot);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].title, '排除数字 4');
  assert.equal(entries[0].sources.length, 2);
  assert.match(entries[0].effect, /未使用的数字/);
  assert.match(entries[1].title, /汽油无效/);
  assert.equal(entries[2].title, '确认正确数字 2');
  assert.doesNotMatch(JSON.stringify(entries), /old_corner|same_number|playerId/);
  entries[0].sources.push('edited');
  assert.equal(clueSummary(snapshot)[0].sources.length, 2);
});

test('clue summary reads no secrets, chat, logs, review, historical holdings or other inventories', () => {
  const snapshot = state();
  for (const name of ['review', 'tokens', 'alliedActors', 'inventories', 'opening', 'items']) {
    Object.defineProperty(snapshot.round, name, { get() { throw new Error(`Unexpected source: ${name}`); } });
  }
  Object.defineProperty(snapshot, 'chat', { get() { throw new Error('Unexpected chat'); } });
  Object.defineProperty(snapshot, 'log', { get() { throw new Error('Unexpected log'); } });
  snapshot.round.inventory.tokens.push({ id: 'clue', type: 'password', number: 6 });
  assert.equal(clueSummary(snapshot).length, 1);
  snapshot.round.inventory.tokens = [];
  assert.deepEqual(clueSummary(snapshot), []);
});

test('clue view is folded, private, and marks public discoveries as history', t => {
  mockDocument(t);
  const snapshot = state();
  snapshot.round.inventory.tokens.push({ id: 'notebook_3', type: 'notebook', number: 3 });
  const view = renderClueSummary(snapshot);
  assert.equal(view.id, 'private-clue-summary');
  assert.equal(view.open, false);
  assert.match(textOf(view), /仅你可见/);
  assert.match(textOf(view), /不代表物品现在的位置/);
  assert.match(textOf(view), /手记不代表能力已发动/);
});

test('help is opt-in, keyboard closable, restores focus and never navigates or submits', t => {
  const { doc, node, emitted } = mockDocument(t);
  const help = createHelpUI();
  const snapshot = state();
  help.receive(snapshot);
  help.addMenuButton(node('room-menu-content'));
  const menuButton = node('show-help');
  assert.equal(menuButton.dataset.uiControl, '');
  assert.equal(menuButton.disabled, false);
  assert.equal(node('help-dialog').open, false);
  node('room-menu-toggle').focus();
  menuButton.click();
  assert.equal(node('help-dialog').open, true);
  assert.equal(doc.activeElement, node('help-close'));
  assert.match(node('help-role').textContent, /访问者/);
  node('help-dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
  assert.equal(node('help-dialog').open, false);
  assert.equal(doc.activeElement, node('room-menu-toggle'));
  assert.deepEqual(emitted, ['game-help-open', 'game-help-close']);
  help.open();
  node('help-close').click();
  assert.equal(node('help-dialog').open, false);
  assert.equal(emitted.includes('game-navigate'), false);
});

test('same-operation snapshots keep reading position; role, room and restart changes clear old context', t => {
  const { node } = mockDocument(t);
  const help = createHelpUI();
  const snapshot = state();
  help.receive(snapshot);
  help.open();
  node('help-dialog').scrollTop = 120;
  help.receive(structuredClone(snapshot));
  assert.equal(node('help-dialog').open, true);
  assert.equal(node('help-dialog').scrollTop, 120);
  const changed = nextState(snapshot, value => { value.round.visitors[0].status = 'box_person'; });
  help.receive(changed);
  assert.equal(node('help-dialog').open, false);
  assert.equal(node('help-dialog').scrollTop, 0);
  assert.match(node('help-role').textContent, /箱人/);
  help.open();
  help.receive({ ...state(), phase: 'lobby', round: null });
  assert.equal(node('help-dialog').open, false);
  assert.doesNotMatch(node('help-role').textContent, /你是箱人/);
  help.open();
  help.receive({ ...state(), code: 'ROOM02', you: 'hako' });
  assert.equal(node('help-dialog').open, false);
  assert.match(node('help-role').textContent, /你是箱娃/);
  help.clear();
  assert.equal(node('help-role').textContent, '');
  help.open();
  assert.equal(node('help-dialog').open, false);
});

test('ordinary highlighted events wait while help is read, then resume without stacked dialogs', t => {
  const { node, cleanup } = mockDocument(t);
  const feedback = createFeedbackUI();
  const help = createHelpUI();
  cleanup(() => feedback.clear());
  const snapshot = state();
  help.receive(snapshot);
  feedback.receive(snapshot);
  help.open();
  const gained = nextState(snapshot, value => value.round.inventory.tokens.push({ id: 'password_4', type: 'password', number: 4 }));
  help.receive(gained);
  feedback.receive(gained);
  assert.equal(node('help-dialog').open, true);
  assert.equal(node('event-dialog').open, false);
  node('help-close').click();
  assert.equal(node('help-dialog').open, false);
  assert.equal(node('event-dialog').open, true);
  assert.match(node('event-body').textContent, /未使用的数字/);
  help.open();
  assert.equal(node('help-dialog').open, true);
  assert.equal(node('event-dialog').open, false);
});

for (const scenario of ['response', 'death', 'victory']) test(`${scenario} interrupts help and shows a single event dialog`, t => {
  const { node, cleanup } = mockDocument(t);
  const feedback = createFeedbackUI();
  const help = createHelpUI();
  cleanup(() => feedback.clear());
  const snapshot = state();
  help.receive(snapshot);
  feedback.receive(snapshot);
  help.open();
  const changed = nextState(snapshot, value => {
    if (scenario === 'response') value.round.interruption = { canRespond: true };
    if (scenario === 'death') value.round.visitors[1].status = 'box_person';
    if (scenario === 'victory') value.round.result = { winner: 'visitors', reason: '访问者成功逃脱。' };
  });
  help.receive(changed);
  feedback.receive(changed);
  assert.equal(node('help-dialog').open, false);
  assert.equal(node('event-dialog').open, true);
  if (scenario === 'response') assert.match(node('event-title').textContent, /回应灭火器/);
  if (scenario === 'death') assert.match(node('event-title').textContent, /死亡/);
  if (scenario === 'victory') assert.match(node('event-primary-action').textContent, /复盘/);
});

test('combined overflow and death point at inheritance, and final victory supersedes stage instructions', () => {
  const snapshot = state();
  const tracker = createFeedbackTracker();
  tracker.receive(snapshot);
  const inheritance = nextState(snapshot, value => {
    value.round.phase = 'hako_phase';
    value.round.visitors[0].status = 'box_person';
    value.round.resolution = { kind: 'inheritance', playerId: value.you };
  });
  const events = tracker.receive(inheritance);
  assert.equal(events.some(event => /进入箱娃阶段|轮到箱娃行动/.test(event.title)), false);
  assert.ok(events.some(event => event.requiresResponse && /遗物/.test(event.title)));
  assert.match(events.find(event => event.symbol === 'death').body, /先选择.*遗物/);
  const terminal = nextState(inheritance, value => {
    value.round.visitors[1].status = 'box_person';
    value.round.result = { winner: 'hako', reason: '所有访问者均已死亡。' };
  });
  const ending = tracker.receive(terminal);
  assert.equal(ending.find(event => event.symbol === 'victory').view, 'review');
  assert.doesNotMatch(ending.find(event => event.symbol === 'death').body, /随后|等待箱娃|继续潜伏/);
});

test('legacy token descriptions cannot turn exclusion numbers into correct-password advice', () => {
  const snapshot = state();
  const tracker = createFeedbackTracker();
  tracker.receive(snapshot);
  const gained = nextState(snapshot, value => value.round.inventory.tokens.push({ id: 'password_4',
    type: 'password', number: 4, description: '这枚数字是保险箱正确密码。' }));
  const [event] = tracker.receive(gained);
  assert.match(event.body, /未使用的数字，用于排除/);
  assert.doesNotMatch(event.body, /是保险箱正确密码/);
});
