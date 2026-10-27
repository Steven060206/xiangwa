import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function session(t, { exploring = false } = {}) {
  const server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.round.visitors[2].roomId = 'study_room';
      return play;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [], errors = [];
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'Shared previews and chat raise no browser errors');
  });
  const request = async (path, data) => {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const people = [await request('/api/rooms', { name: '箱娃守夜人' })];
  for (const name of ['访问者小满', '访问者青禾', '访问者阿照']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  const sync = version => Promise.all(pages.map(page => page.waitForFunction(expected => window.__socialState?.version >= expected, version)));
  const act = async (person, type, payload = {}) => {
    const result = await request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...payload });
    await sync(result.version);
    return result;
  };
  const snapshot = person => request(`/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  const click = async (page, type, trigger) => {
    const received = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await received;
    const state = await response.json();
    assert.equal(response.status(), 200, `${type}: ${JSON.stringify(state)}`);
    await sync(state.version);
    return state;
  };
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  for (const itemId of ['smartphone', 'walkie_talkie', 'deduction']) state = await act(
    people.find(person => person.playerId === state.draft.turnPlayerId), 'choose_item', { itemId });
  if (exploring) {
    while (state.phase === 'map_setup') {
      const person = people.find(person => person.playerId === state.setup.turnPlayerId);
      state = await act(person, 'draw');
      state = await act(person, 'place', state.setup.legalPlacements[0]);
    }
    await act(people[0], 'prepare_opening');
    await act(people[0], 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
    await act(people[0], 'place_remains', { cornerId: 'living_sofa' });
    await act(people[0], 'inspect_initial_room', { roomId: 'children_room' });
    state = await act(people[0], 'choose_initial_hiding', { cornerId: 'children_cabinet' });
    state = await act(people[0], 'choose_initial_power', { powerId: state.opening.initialPowerOptions[0].id });
  }
  const open = async (person, mobile = false) => {
    const context = await browser.newContext({ viewport: mobile ? { width: 375, height: 667 } : { width: 1366, height: 900 } });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__socialState = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), () => page.keyboard.press('Escape'));
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    return page;
  };
  return { people, act, snapshot, click, open, state };
}

test('two real browser sessions share live tile position and rotation without committing until confirmation', { timeout: 60000 }, async t => {
  const { people, open, click, snapshot, state } = await session(t);
  const current = people.find(person => person.playerId === state.setup.turnPlayerId);
  const mine = await open(current, true);
  const other = await open(people[0]);
  let places = 0;
  mine.on('request', request => {
    if (request.method() === 'POST' && request.postDataJSON()?.type === 'place') places++;
  });
  await click(mine, 'draw', () => mine.getByTestId('draw-tile').click());
  await other.getByTestId('shared-map-preview').waitFor();
  const before = await snapshot(current);
  const target = mine.getByTestId('legal-position').last();
  const position = await target.evaluate(element => ({ x: Number(element.dataset.x), y: Number(element.dataset.y) }));
  await target.click();
  await other.waitForFunction(expected => window.__socialState?.setup.preview?.placement?.x === expected.x
    && window.__socialState?.setup.preview?.placement?.y === expected.y, position);
  assert.equal((await snapshot(current)).version, before.version, 'A live placement preview never commits a move');
  await mine.getByTestId('rotate-tile').click();
  await other.waitForFunction(() => window.__socialState?.setup.preview?.rotation === 1);
  assert.equal(await other.getByTestId('shared-map-preview').getAttribute('data-rotation'), '1');
  assert.match(await other.getByTestId('shared-map-preview').locator('svg').getAttribute('aria-label'), /旋转90度/);
  assert.match(await other.locator('#drawn-preview svg').getAttribute('aria-label'), /旋转90度/);
  assert.equal(places, 0);
  const confirmed = await click(mine, 'place', () => mine.getByTestId('confirm-placement').click());
  await other.waitForFunction(() => !document.querySelector('[data-testid="shared-map-preview"]'));
  assert.equal(confirmed.setup.placements.length, 2);
  assert.equal(await other.locator('.placed-tile').count(), 2);
  assert.equal(places, 1, 'A single confirmation produces a single committed placement');
  assert.equal(await mine.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('room chat treats markup as text, changes audience on movement and remains usable during an undo vote', { timeout: 90000 }, async t => {
  const { people, open, click, act, snapshot } = await session(t, { exploring: true });
  const first = await open(people[1], true);
  const second = await open(people[2]);
  const third = await open(people[3]);
  assert.match(await first.getByTestId('chat-scope').innerText(), /1楼大厅.*访问者青禾/);
  assert.match(await third.getByTestId('chat-scope').innerText(), /书房/);
  const text = '<unknown-card>同房线索</unknown-card><img src=x onerror="window.__chatInjected=true">';
  await first.getByTestId('chat-text').fill(text);
  await click(first, 'chat_send', () => first.getByTestId('chat-send').click());
  await second.getByTestId('chat-messages').getByText(text, { exact: true }).waitFor();
  assert.equal(await second.getByTestId('chat-messages').locator('img, unknown-card').count(), 0);
  assert.equal(await second.evaluate(() => window.__chatInjected === true), false);
  assert.doesNotMatch(await third.getByTestId('chat-messages').innerText(), /同房线索/);
  assert.equal((await snapshot(people[0])).chat.messages.length, 0, 'The hidden faction does not receive visitor-room messages');
  await first.getByTestId('chat-text').fill('移动前尚未发送的草稿');
  await act(people[1], 'silent_reveal', { index: 0 });
  let state = await snapshot(people[1]);
  assert.ok(state.round.moveTargets.includes('study_room'));
  await act(people[1], 'move', { roomId: 'study_room' });
  await act(people[0], 'resolve_visitor_action');
  assert.match(await first.getByTestId('chat-scope').innerText(), /书房.*访问者阿照/);
  assert.equal(await first.getByTestId('chat-text').inputValue(), '', 'A change of audience clears the unsent draft');
  const studyText = '书房的新线索只告诉此时同房的人';
  await third.getByTestId('chat-text').fill(studyText);
  await click(third, 'chat_send', () => third.getByTestId('chat-send').click());
  await first.getByTestId('chat-messages').getByText(studyText, { exact: true }).waitFor();
  assert.doesNotMatch(await second.getByTestId('chat-messages').innerText(), /书房的新线索/);
  state = await snapshot(people[1]);
  state = await act(people[1], 'undo_request', { version: state.version });
  assert.ok(state.undo.pending, 'Shared movement requires an active multiplayer undo vote');
  assert.equal(await second.getByTestId('chat-send').isDisabled(), false);
  const voteText = '投票期间仍可继续交流';
  await second.getByTestId('chat-text').fill(voteText);
  await click(second, 'chat_send', () => second.getByTestId('chat-send').click());
  await second.getByTestId('chat-messages').getByText(voteText, { exact: true }).waitFor();
  assert.equal((await snapshot(people[1])).undo.pending.id, state.undo.pending.id, 'Chat never approves or cancels the vote');
  assert.equal(await first.getByTestId('chat-send').isDisabled(), false);
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('test-results', { recursive: true });
  await first.getByTestId('chat-text').scrollIntoViewIfNeeded();
  await first.screenshot({ path: 'test-results/social-chat-mobile.png', fullPage: true });
});
