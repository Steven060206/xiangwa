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

async function session(t, { exploring = false, pauseInitialPower = false, tileDeck = deck,
  initialItemOrder = ['smartphone', 'walkie_talkie', 'deduction'], arrangePlay = () => {} } = {}) {
  const server = createGameServer({ deck: tileDeck, initialItemOrder, silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.round.visitors[2].roomId = 'study_room';
      arrangePlay(play, setup);
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
  assert.equal(state.phase, 'map_setup');
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
    if (!pauseInitialPower) state = await act(people[0], 'choose_initial_power', { powerId: state.opening.initialPowerOptions.find(card => card.canChoose !== false).id });
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

test('initial power UI displays all three drawn cards but disables NO4 and confirms another card after reload', { timeout: 60000 }, async t => {
  t.mock.method(Math, 'random', () => 0);
  const g = await session(t, { exploring: true, pauseInitialPower: true });
  const hako = g.people[0];
  assert.deepEqual(g.state.opening.initialPowerOptions.map(card => card.id), [2, 3, 4]);
  const page = await g.open(hako, true);
  const select = page.getByTestId('initial-power-select');
  assert.equal(await select.locator('option').count(), 3);
  assert.equal(await select.locator('option[value="4"]').evaluate(option => option.disabled), true);
  assert.match(await select.locator('option[value="4"]').textContent(), /不可选作初始能力/);
  assert.notEqual(await select.inputValue(), '4');
  await page.reload();
  await select.waitFor();
  assert.equal(await select.locator('option[value="4"]').evaluate(option => option.disabled), true);
  assert.deepEqual((await g.snapshot(hako)).opening.initialPowerOptions, g.state.opening.initialPowerOptions);
  const before = (await g.snapshot(hako)).version;
  const rejected = await page.evaluate(async identity => {
    const response = await fetch(`/api/rooms/${identity.roomCode}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: identity.playerId,
        token: identity.token, type: 'choose_initial_power', powerId: 4 }) });
    return response.status;
  }, hako);
  assert.equal(rejected, 409);
  assert.equal((await g.snapshot(hako)).version, before);
  await select.selectOption('2');
  const chosen = await g.click(page, 'choose_initial_power', () => page.getByTestId('confirm-initial-power').click());
  assert.equal(chosen.phase, 'practice');
  assert.equal(chosen.initialPower.id, 2);
});

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

test('rotation skips an impossible orientation and always keeps a confirmable legal placement', { timeout: 60000 }, async t => {
  const { people, open, click, state, snapshot } = await session(t, { tileDeck: ['storage', ...deck.filter(id => id !== 'storage')] });
  const current = people.find(person => person.playerId === state.setup.turnPlayerId);
  const mine = await open(current, true);
  const other = await open(people[0]);
  const drawn = await click(mine, 'draw', () => mine.getByTestId('draw-tile').click());
  assert.deepEqual([...new Set(drawn.setup.legalPlacements.map(value => value.rotation))], [0, 2, 3]);
  for (const rotation of [2, 3, 0]) {
    await mine.getByTestId('rotate-tile').click();
    await other.waitForFunction(expected => window.__socialState?.setup.preview?.rotation === expected, rotation);
    assert.equal(await mine.getByTestId('confirm-placement').isEnabled(), true);
    const preview = (await snapshot(current)).setup.preview;
    assert.ok(drawn.setup.legalPlacements.some(value => value.rotation === rotation && value.floor === preview.placement.floor
      && value.x === preview.placement.x && value.y === preview.placement.y));
  }
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
  await click(first, 'chat_send', () => first.getByTestId('chat-text').press('Enter'));
  await second.getByTestId('chat-messages').getByText(text, { exact: true }).waitFor();
  assert.equal(await second.getByTestId('chat-messages').locator('img, unknown-card').count(), 0);
  assert.equal(await second.evaluate(() => window.__chatInjected === true), false);
  assert.doesNotMatch(await third.getByTestId('chat-messages').innerText(), /同房线索/);
  assert.equal((await snapshot(people[0])).chat.messages.length, 0, 'The hidden faction does not receive visitor-room messages');
  await first.getByTestId('chat-text').fill('第一行');
  await first.getByTestId('chat-text').press('Shift+Enter');
  await first.getByTestId('chat-text').pressSequentially('second line');
  assert.equal(await first.getByTestId('chat-text').inputValue(), '第一行\nsecond line');
  await first.getByTestId('chat-text').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }));
  });
  assert.equal((await snapshot(people[1])).chat.messages.length, 1, 'IME confirmation, repeat and Shift+Enter never send');
  await first.getByTestId('chat-text').fill('移动前尚未发送的草稿');
  await act(people[1], 'silent_reveal', { index: 0 });
  let state = await snapshot(people[1]);
  assert.ok(state.round.moveTargets.includes('study_room'));
  await first.locator(`.map-player-marker[data-player-id="${people[3].playerId}"]`).click();
  await first.getByTestId('map-context').waitFor();
  await click(first, 'move', () => first.getByTestId('map-confirm-action').filter({ hasText: '确认移动' }).click());
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

test('fixed walkie partners accept, privately chat and confirm selected-token exchanges in two browsers', { timeout: 90000 }, async t => {
  const fixtureTokens = [];
  const { people, open, click, snapshot } = await session(t, { exploring: true,
    arrangePlay(play, setup) {
      for (const [corner, token] of Object.entries(play.tokens)) {
        if (!['password', 'weapon'].includes(token?.type) || fixtureTokens.length >= 5) continue;
        const playerId = setup.visitorIds[fixtureTokens.length < 3 ? 1 : 0];
        play.tokens[corner] = null;
        play.inventories[playerId].tokens.push(token);
        fixtureTokens.push(token.id);
      }
      assert.equal(fixtureTokens.length, 5, 'Move five actual pieces into the two partners’ inventories');
    },
  });
  const owner = await open(people[2]);
  const partner = await open(people[1], true);
  const outsider = await open(people[3]);
  await owner.getByTestId('walkie-partner').selectOption(people[1].playerId);
  await click(owner, 'walkie_propose', () => owner.getByTestId('walkie-propose').click());
  await partner.getByTestId('walkie-accept').waitFor();
  assert.equal(await outsider.getByTestId('walkie-accept').count(), 0);
  await click(partner, 'walkie_respond', () => partner.getByTestId('walkie-accept').click());
  await owner.getByTestId('chat-channel').selectOption('walkie');
  await owner.getByTestId('chat-text').fill('固定同伴的私密线索');
  await click(owner, 'chat_send', () => owner.getByTestId('chat-text').press('Enter'));
  await partner.getByTestId('chat-messages').getByText('固定同伴的私密线索', { exact: true }).waitFor();
  assert.doesNotMatch(await outsider.getByTestId('chat-messages').innerText(), /固定同伴的私密线索/);
  assert.equal((await snapshot(people[0])).chat.messages.length, 0);
  await click(owner, 'walkie_show_propose', () => owner.getByTestId('walkie-show-propose').click());
  assert.equal(await owner.getByTestId('walkie-last-show').count(), 0);
  assert.equal(await partner.getByTestId('walkie-last-show').count(), 0);
  assert.equal(await owner.getByTestId('walkie-token-choices').locator('input').count(), 3);
  assert.equal(await partner.getByTestId('walkie-token-choices').locator('input').count(), 2);
  for (const id of fixtureTokens.slice(0, 2)) await owner.locator(`[data-testid="walkie-token-choices"] input[data-token-id="${id}"]`).check();
  await partner.locator(`[data-testid="walkie-token-choices"] input[data-token-id="${fixtureTokens[3]}"]`).check();
  await click(owner, 'walkie_show_confirm', () => owner.getByTestId('walkie-show-confirm').click());
  assert.equal(await partner.getByTestId('walkie-last-show').count(), 0);
  assert.equal((await snapshot(people[1])).round.walkie.lastShow, null, 'The first confirmation does not reveal selected tokens');
  await click(partner, 'walkie_show_confirm', () => partner.getByTestId('walkie-show-confirm').click());
  assert.match(await owner.getByTestId('walkie-last-show').innerText(), /仅你可见/);
  assert.equal(await owner.getByTestId('walkie-last-show').locator('li').count(), 1);
  assert.equal(await partner.getByTestId('walkie-last-show').locator('li').count(), 2);
  assert.deepEqual((await snapshot(people[2])).round.walkie.lastShow.tokens.map(token => token.id), [fixtureTokens[3]]);
  assert.deepEqual((await snapshot(people[1])).round.walkie.lastShow.tokens.map(token => token.id), fixtureTokens.slice(0, 2));
  assert.deepEqual((await snapshot(people[2])).round.inventory.tokens.map(token => token.id), fixtureTokens.slice(0, 3), 'Showing pieces does not transfer them');
  assert.equal(await outsider.getByTestId('walkie-last-show').count(), 0);
  assert.equal((await snapshot(people[0])).round.walkie, null);
  const outsiderDom = await outsider.locator('body').innerHTML();
  for (const id of fixtureTokens) assert.equal(outsiderDom.includes(id), false, 'An outsider receives no chosen or unchosen token ids');
});

test('ventriloquist inspection preserves the named Hako actor without revealing its stored underlying token', { timeout: 60000 }, async t => {
  const { people, open, click, act, snapshot } = await session(t, { exploring: true,
    initialItemOrder: ['ventriloquist_doll', 'walkie_talkie', 'deduction'],
    arrangePlay(play) {
      const source = Object.keys(play.tokens).find(corner => play.tokens[corner]?.id === 'password_4');
      assert.ok(source);
      [play.tokens.children_cabinet, play.tokens[source]] = [play.tokens[source], play.tokens.children_cabinet];
    },
  });
  const hako = await open(people[0]);
  const user = await open(people[1], true);
  const outsider = await open(people[2]);
  await act(people[1], 'silent_reveal', { index: 0 });
  await user.getByTestId('active-item-select').selectOption('ventriloquist_doll');
  await user.getByTestId('active-item-room').selectOption('children_room');
  await click(user, 'use_item', () => user.getByTestId('use-item').click());
  await act(people[0], 'resolve_visitor_action');
  const inspection = hako.getByTestId('item-room-inspection');
  const actorRow = inspection.locator('dl > div').filter({ has: hako.locator('dt', { hasText: '橱柜中' }) });
  assert.match(await actorRow.locator('dd').innerText(), /箱娃守夜人 · 箱娃/);
  assert.doesNotMatch(await actorRow.locator('dd').innerText(), /空角落|密码4/);
  const memory = (await snapshot(people[0])).round.items.inspection;
  const hiddenCorner = memory.corners.find(corner => corner.id === 'children_cabinet');
  assert.equal(hiddenCorner.token, null);
  assert.equal(hiddenCorner.actors[0].playerId, people[0].playerId);
  assert.equal(JSON.stringify(memory).includes('password_4'), false);
  for (const [page, person] of [[user, people[1]], [outsider, people[2]]]) {
    assert.equal(await page.getByTestId('item-room-inspection').count(), 0);
    assert.equal((await snapshot(person)).round.items.inspection, undefined);
  }
  await click(hako, 'answer_item', () => hako.getByTestId('answer-item').click());
  await hako.reload();
  await inspection.waitFor();
  assert.match(await actorRow.locator('dd').innerText(), /箱娃守夜人 · 箱娃/);
  assert.deepEqual((await snapshot(people[0])).round.items.inspection, memory, 'Answering and refreshing retain the actual private inspection snapshot');
});
