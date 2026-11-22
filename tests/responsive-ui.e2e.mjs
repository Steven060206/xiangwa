import { openGamePane as nav } from './game-navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function session(t, playerCount) {
  const initialItemOrder = ['night_vision', 'stethoscope', 'relic_ring', 'deduction'].slice(0, playerCount - 1);
  const server = createGameServer({ deck, initialItemOrder, silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      for (const [tokenId, target] of [['notebook_2', 'bathroom_toilet'], ['password_5', 'bathroom_washer']]) {
        const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
        assert.ok(source, `Move an existing fixture piece: ${tokenId}`);
        [play.tokens[source], play.tokens[target]] = [play.tokens[target], play.tokens[source]];
      }
      play.round.visitors[0].roomId = 'bathroom_room';
      play.round.visitors[1].roomId = 'bathroom_room';
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
    assert.deepEqual(errors, [], 'Responsive navigation does not raise browser errors');
  });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const people = [await request('/api/rooms', { name: '守夜箱娃', playerCount })];
  for (let index = 1; index < playerCount; index++) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name: `寻路者${index}` }));
  const sync = version => Promise.all(pages.filter(page => !page.isClosed()).map(page => page.waitForFunction(expected => window.__responsiveState?.version >= expected, version)));
  async function act(person, type, payload = {}) {
    const result = await request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...payload });
    await sync(result.version);
    return result;
  }
  const snapshot = person => request(`/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  async function click(page, type, trigger) {
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await pending;
    const result = await response.json();
    assert.equal(response.status(), 200, `${type}: ${JSON.stringify(result)}`);
    await sync(result.version);
    return result;
  }
  async function open(person, viewport = { width: 375, height: 667 }, mode = 'sse') {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: true });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (response.ok && new URL(response.url).pathname.startsWith('/api/rooms')) {
          try {
            const body = await response.clone().json();
            const state = body.state || body;
            if (Number.isInteger(state.version) && (!window.__responsiveState || state.version >= window.__responsiveState.version)) window.__responsiveState = state;
          } catch { /* An intentionally truncated response is handled by the app. */ }
        }
        return response;
      };
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__responsiveState = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}${mode === 'poll' ? '&sync=poll' : ''}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    return page;
  }
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  async function prepare({ finish = true } = {}) {
    state = await snapshot(people[0]);
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
    if (finish) state = await finishOpening();
    return state;
  }
  async function finishOpening() {
    const current = await snapshot(people[0]);
    state = await act(people[0], 'choose_initial_power', { powerId: current.opening.initialPowerOptions.find(card => card.canChoose !== false).id });
    return state;
  }
  return { people, state, act, snapshot, click, open, prepare, finishOpening };
}

async function dismiss(page) {
  if (await page.locator('#event-dialog').evaluate(dialog => dialog.open)) await page.locator('#event-close').click();
}

test('five-player random deals and responsive exploration keep actions and the map reachable', { timeout: 120000 }, async t => {
  const game = await session(t, 5);
  const { people, snapshot, act, open } = game;
  const first = people[1];
  const page = await open(first);
  assert.equal(await page.getByTestId('item-choice').count(), 0, 'Random dealing proceeds directly to map setup');
  const dealt = await snapshot(first);
  assert.equal(dealt.phase, 'map_setup');
  assert.equal(dealt.initialItems.length, 4);
  assert.equal(new Set(dealt.initialItems.map(choice => choice.itemId)).size, 4, 'All four visitors receive distinct cards');
  assert.equal(dealt.initialItems.find(item => item.playerId === first.playerId).itemId, 'night_vision');
  await game.prepare({ finish: false });
  await dismiss(page);
  await nav(page, 'map');
  await page.getByTestId('floor-basement').click();
  assert.equal(await page.getByTestId('floor-basement').getAttribute('aria-selected'), 'true');
  await game.finishOpening();
  await dismiss(page);
  assert.equal(await page.getByTestId('floor-1').getAttribute('aria-selected'), 'true', 'Entering exploration locates the participant once');
  const visitor = await snapshot(first);
  assert.equal(Object.hasOwn(visitor.round.hako, 'cornerId'), false);
  assert.equal(await page.getByTestId('hako-location').count(), 0);
  await page.getByTestId('floor-basement').click();
  await act(first, 'silent_reveal', { index: 0 });
  assert.equal(await page.getByTestId('floor-basement').getAttribute('aria-selected'), 'true', 'Later snapshots respect a manually chosen floor');
  await nav(page, 'action');
  const compact = await page.locator('#board-viewport').evaluate(element => element.getBoundingClientRect().height);
  const controls = await page.locator('.setup-sidebar').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(controls >= 260, `375×667 gives the current controls usable space: ${controls}`);
  assert.equal(await page.getByTestId('action-categories').isVisible(), true);
  await nav(page, 'map');
  assert.equal(await page.locator('#setup-view').evaluate(element => element.classList.contains('map-focused')), true);
  assert.ok(await page.locator('#board-viewport').evaluate(element => element.getBoundingClientRect().height) > compact,
    'The map expands from the compact action layout');
  await nav(page, 'action');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/responsive-ui-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  const desktopMap = await page.locator('#board-viewport').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(desktopMap >= 360, `1366×768 retains a useful map: ${desktopMap}`);
  await page.screenshot({ path: 'test-results/responsive-ui-desktop.png', fullPage: true });
  for (const viewport of [{ width: 667, height: 375 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await nav(page, 'action');
    const geometry = await page.getByTestId('action-categories').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: innerHeight, fits: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.equal(geometry.fits, true, `${viewport.width}×${viewport.height} has no horizontal overflow`);
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height,
      `${viewport.width}×${viewport.height} shows the current action categories on screen: ${JSON.stringify(geometry)}`);
  }
});

test('a five-seat waiting player can read the board and respond to a gift without losing their chat draft', { timeout: 90000 }, async t => {
  const { people, prepare, open, act, click } = await session(t, 5);
  await prepare();
  const [hako, first, second] = people;
  const page = await open(second);
  assert.equal(await page.locator('#setup-view').getAttribute('data-layout'), 'waiting');
  const waitingHeight = (await page.locator('#board-viewport').boundingBox()).height;
  assert.ok(waitingHeight > 220, 'A waiting phone can see a whole board tile');
  await page.locator('#seats-toggle').click();
  assert.equal(await page.locator('#setup-seats > li').count(), 5);
  assert.equal(await page.locator(`#table-seats .map-position[data-player-id="${hako.playerId}"]`).count(), 0);
  await page.keyboard.press('Escape');

  await nav(page, 'chat');
  const draft = page.getByTestId('chat-text');
  await draft.fill('等会儿告诉同伴');
  await act(first, 'offer_exchange', { targetId: second.playerId, giveItemIds: ['night_vision'], giveTokenIds: [], requestItemIds: [], requestTokenIds: [] });
  assert.match(await page.getByTestId('current-task').innerText(), /回应寻路者1的赠送/);
  assert.match(await page.getByTestId('turn-owner').innerText(), /寻路者1的回合/);
  assert.equal(await page.locator('#setup-view').getAttribute('data-panel'), 'chat');
  assert.equal(await draft.inputValue(), '等会儿告诉同伴');
  await page.getByTestId('focus-current-action').click();
  const accept = page.getByTestId('exchange-accept');
  const geometry = await accept.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const pane = document.querySelector('.setup-sidebar').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, paneTop: pane.top, paneBottom: pane.bottom };
  });
  assert.ok(geometry.top >= geometry.paneTop && geometry.bottom <= geometry.paneBottom, 'The gift can be answered on the first screen');
  assert.ok((await page.locator('#board-viewport').boundingBox()).height < waitingHeight);
  assert.equal(await page.getByTestId('inventory').isVisible(), false);
  assert.equal(await page.locator('.public-progress').isVisible(), false);
  const accepted = await click(page, 'respond_exchange', () => accept.click());
  assert.equal(accepted.round.silent.turnPlayerId, first.playerId);
  await dismiss(page);
  await nav(page, 'inventory');
  assert.equal(await page.locator('[data-testid="inventory-item"][data-item-id="night_vision"]').isVisible(), true);
  await nav(page, 'chat');
  assert.equal(await draft.inputValue(), '等会儿告诉同伴');
});

test('slow and truncated successful actions recover through read-only state checks and unchanged polls without replay', { timeout: 90000 }, async t => {
  const { people, act, snapshot, open, prepare } = await session(t, 4);
  await prepare();
  const [hako, first] = people;
  const mine = await open(first);
  const mirror = await open(first, { width: 390, height: 844 }, 'poll');
  let posts = 0;
  mine.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) posts++; });
  let release, intercepted;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { intercepted = resolve; });
  await mine.route('**/actions', async route => {
    assert.equal(route.request().postDataJSON().type, 'silent_reveal');
    intercepted();
    await held;
    assert.equal((await route.fetch()).status(), 200);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
  }, { times: 1 });
  await mine.getByTestId('silent-card-0').click();
  await started;
  assert.match(await mine.locator('#action-feedback').innerText(), /正在提交/);
  assert.equal(await mine.getByTestId('silent-card-0').isDisabled(), true);
  await mine.getByTestId('silent-card-0').evaluate(button => button.click());
  assert.equal(posts, 1, 'A disabled control cannot repeat the pending POST');
  const confirmation = mine.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/rooms/${first.roomCode}` && !new URL(response.url()).searchParams.has('poll'));
  release();
  assert.equal((await confirmation).status(), 200);
  await mine.waitForFunction(() => /已取得最新进度|已连接，按当前任务继续/.test(document.getElementById('action-feedback').textContent)
    && document.getElementById('connection-state').textContent === '已连接');
  assert.equal((await snapshot(first)).round.phase, 'visitor_action');
  assert.equal(posts, 1, 'A truncated success is checked with GET rather than another game POST');

  let mirrorPosts = 0, finishTruncated;
  const holdTruncated = new Promise(resolve => { finishTruncated = resolve; });
  mirror.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) mirrorPosts++; });
  await mirror.route('**/actions', async route => {
    assert.equal(route.request().postDataJSON().type, 'peek');
    assert.equal((await route.fetch()).status(), 200);
    await holdTruncated;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
  }, { times: 1 });
  await mirror.locator('[data-testid="peek-target"][data-corner-id="bathroom_washer"]').click();
  await mirror.waitForFunction(() => window.__responsiveState?.round.pendingAction?.cornerId === 'bathroom_washer');
  const beforeRecovery = await snapshot(first);
  const confirmationPath = url => url.pathname === `/api/rooms/${first.roomCode}` && !url.searchParams.has('poll');
  await mirror.route(confirmationPath, route => route.abort('connectionfailed'), { times: 1 });
  const failedCheck = mirror.waitForEvent('requestfailed', { predicate: request => confirmationPath(new URL(request.url())) });
  finishTruncated();
  await failedCheck;
  await mirror.waitForFunction(() => /已取得最新进度|已连接，按当前任务继续/.test(document.getElementById('action-feedback').textContent)
    && document.getElementById('connection-state').textContent === '已连接');
  assert.equal((await snapshot(first)).version, beforeRecovery.version, 'An unchanged poll confirms the same accepted action');
  assert.equal(mirrorPosts, 1, 'Polling recovery never resends the uncertain action');
  await dismiss(mirror);
  await act(hako, 'resolve_visitor_action');
  await mirror.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.match(await mirror.getByTestId('event-title').innerText(), /密码5/);
  const eventCount = await mirror.locator('#event-history-list > li').count();
  for (let count = 0; count < 2; count++) await mirror.waitForResponse(response => new URL(response.url()).searchParams.has('poll') && response.status() === 200);
  assert.equal(await mirror.locator('#event-history-list > li').count(), eventCount, 'Repeated polls do not duplicate a private result');
  assert.equal(posts, 1);
  assert.equal(mirrorPosts, 1);
});

test('four-player notebook feedback, chat drafts and undo navigation preserve private information and pending decisions', { timeout: 120000 }, async t => {
  const { people, act, snapshot, click, open, prepare } = await session(t, 4);
  await prepare();
  const [hako, first, second] = people;
  const mine = await open(first);
  const peer = await open(second, { width: 1366, height: 768 });
  let posts = 0;
  mine.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) posts++; });
  await click(mine, 'silent_reveal', () => mine.getByTestId('silent-card-0').click());
  await mine.getByTestId('action-categories').getByRole('link', { name: /窥探/ }).click();
  await mine.getByTestId('peek-use-night-vision').uncheck();
  await click(mine, 'peek', () => mine.locator('[data-testid="peek-target"][data-corner-id="bathroom_toilet"]').click());
  await act(hako, 'resolve_visitor_action');
  await mine.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.equal(await mine.getByTestId('event-title').innerText(), '发现手记2 · 已自动公开');
  assert.equal((await mine.locator('#event-body').innerText()).match(/对应能力/g)?.length, 1);
  assert.match(await mine.locator('#event-visibility').innerText(), /手记内容全员可见；发现位置不公开/);
  assert.equal(await mine.locator('#event-companions > li').count(), 0);
  assert.doesNotMatch(await mine.locator('#event-dialog').innerText(), /bathroom_toilet|废旧马桶/);
  await peer.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.equal(await peer.getByTestId('event-title').innerText(), '手记2已公开');
  assert.equal(await peer.locator('#event-visibility').innerText(), '全员可见');
  assert.doesNotMatch(await peer.locator('#event-dialog').innerText(), /bathroom_toilet|废旧马桶|发现位置/);
  await dismiss(peer);
  const pending = await snapshot(first);
  const beforeClose = posts;
  await mine.locator('#event-close').click();
  assert.equal(posts, beforeClose, 'Closing the result sends no game action');
  assert.equal((await snapshot(first)).version, pending.version);
  await mine.getByTestId('event-history-toggle').click();
  await mine.locator('.event-history-entry').filter({ hasText: '发现手记2' }).click();
  assert.match(await mine.locator('#event-position').innerText(), /历史事件/);
  assert.equal(await mine.locator('#event-count').isVisible(), false);
  await mine.locator('#event-primary-action').click();
  assert.equal(await mine.locator('#setup-view').getAttribute('data-panel'), 'action');
  assert.equal((await snapshot(first)).version, pending.version, 'History navigation does not finish the old decision');
  await click(mine, 'resolve_peek', () => mine.getByTestId('resolve-peek').click());
  await nav(mine, 'inventory');
  assert.equal(await mine.getByTestId('inventory').isVisible(), true);
  await nav(mine, 'action');
  await act(second, 'chat_send', { text: '这里发现了手记', channelKind: 'room', roomId: 'bathroom_room' });
  await mine.locator('#chat-unread').waitFor({ state: 'visible' });
  assert.equal(await mine.locator('#chat-unread').innerText(), '1');
  await nav(mine, 'chat');
  assert.equal(await mine.locator('#chat-unread').isVisible(), false);
  assert.match(await mine.getByTestId('chat-messages').innerText(), /这里发现了手记/);
  await mine.getByTestId('chat-text').fill('尚未发送的同房草稿');
  await act(second, 'silent_reveal', { index: 1 });
  assert.equal(await mine.getByTestId('chat-text').inputValue(), '尚未发送的同房草稿');
  await nav(mine, 'inventory');
  await nav(mine, 'chat');
  assert.equal(await mine.getByTestId('chat-text').inputValue(), '尚未发送的同房草稿');
  await mine.getByTestId('chat-return').click();
  assert.equal(await mine.locator('#setup-view').getAttribute('data-panel'), 'action');
  await mine.getByTestId('room-menu-toggle').click();
  assert.equal(await mine.getByTestId('undo-request').isVisible(), true);
  await click(mine, 'undo_request', () => mine.getByTestId('undo-request').click());
  await dismiss(peer);
  await peer.getByTestId('undo-reject').waitFor();
  for (const view of ['map', 'inventory', 'chat', 'action']) await nav(peer, view);
  assert.equal(await peer.getByTestId('move-target').first().isDisabled(), true, 'Navigation does not unlock an action during the vote');
  assert.equal(await peer.getByTestId('undo-reject').isEnabled(), true);
  await click(peer, 'undo_respond', () => peer.getByTestId('undo-reject').click());
  assert.equal((await snapshot(first)).undo.pending, null);
  await nav(mine, 'chat');
  assert.equal(await mine.getByTestId('chat-text').inputValue(), '尚未发送的同房草稿');
});

for (const mode of ['sse', 'poll']) test('late committed flip unlocks the next action after the ten-second check over ' + mode, { timeout: 60000 }, async t => {
  const { people, open, prepare, snapshot } = await session(t, 4);
  await prepare();
  const mine = await open(people[1], undefined, mode);
  let sent = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  await mine.route('**/actions', async route => {
    sent++;
    assert.equal(route.request().postDataJSON().index, 2);
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  const checked = mine.waitForResponse(r => r.request().method() === 'GET'
    && new URL(r.url()).pathname.endsWith('/' + people[1].roomCode) && !new URL(r.url()).searchParams.has('poll'));
  const start = Date.now();
  await mine.getByTestId('silent-card-2').click();
  await checked;
  await mine.waitForFunction(() => !document.querySelector('[data-testid="move-target"]')?.disabled
    && document.getElementById('action-feedback').textContent.includes('最新进度'));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, start + 12100 - Date.now())));
  assert.equal(await mine.getByTestId('move-target').first().isEnabled(), true);
  assert.equal((await snapshot(people[1])).round.silent.cards[2].status, 'up');
  assert.equal(sent, 1);
  release();
});

test('unreceived flip waits for an explicit identical retry across chat-only updates', { timeout: 60000 }, async t => {
  const { people, open, prepare, act, snapshot, click } = await session(t, 4);
  await prepare();
  const first = people[1];
  const mine = await open(first);
  const requests = [];
  mine.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/actions')) requests.push(r.postDataJSON()); });
  await mine.route('**/actions', route => route.abort('connectionreset'), { times: 1 });
  await mine.getByTestId('silent-card-2').click();
  const retry = mine.getByRole('button', { name: '重试刚才的选择' });
  await retry.waitFor();
  const version = (await snapshot(first)).version;
  await act(people[2], 'chat_send', { text: '还在这一步', channelKind: 'room', roomId: 'bathroom_room' });
  await mine.locator('#chat-unread').waitFor();
  assert.equal(await mine.getByTestId('silent-card-0').isDisabled(), true);
  assert.equal(await retry.isVisible(), true);
  const check = mine.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(first.roomCode));
  await mine.getByRole('button', { name: '重新核对' }).click();
  await check;
  assert.equal(requests.length, 1);
  const accepted = await click(mine, 'silent_reveal', () => retry.click());
  assert.equal(accepted.version, version + 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].index, 2);
  assert.equal(accepted.round.silent.cards[2].status, 'up');
  assert.equal(await retry.isVisible(), false);
});

test('phone touch reaches map corners and keyboard reaches the live card without submitting; a held third card keeps its index', { timeout: 90000 }, async t => {
  const { people, open, prepare, act, click } = await session(t, 4);
  await prepare();
  const mine = await open(people[1]);
  const requests = [];
  mine.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/actions')) requests.push(r.postDataJSON()); });
  await nav(mine, 'map');
  await mine.getByTestId('floor-1').click();
  const guide = mine.locator('#corner-guide-toggle');
  for (const [width, height] of [[375, 667], [667, 375]]) {
    await mine.setViewportSize({ width, height });
    for (const id of ['dining_fireplace', 'study_desk']) {
      const corner = mine.locator('#tile-board .corner-location[data-corner-id="' + id + '"]');
      await corner.scrollIntoViewIfNeeded();
      const box = await corner.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      assert.equal(await mine.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.corner-location')?.dataset.cornerId, point), id);
      await mine.touchscreen.tap(point.x, point.y);
      assert.equal(await mine.locator('#tile-board .selected-corner').getAttribute('data-corner-id'), id);
      assert.equal(await guide.getAttribute('aria-expanded'), 'false');
      await mine.keyboard.press('Escape');
    }
    await guide.click();
    const close = mine.locator('#corner-guide').getByRole('button', { name: '收起', exact: true });
    await close.click();
    assert.equal(await guide.evaluate(b => b === document.activeElement), true);
  }
  await mine.setViewportSize({ width: 1366, height: 768 });
  await nav(mine, 'action');
  await mine.locator('#seats-toggle').focus();
  await mine.keyboard.press('Tab');
  assert.equal(await mine.locator('#focus-current-action').evaluate(b => b === document.activeElement && b.matches(':focus-visible')), true);
  await mine.keyboard.press('Enter');
  assert.equal(await mine.getByTestId('silent-card-0').evaluate(b => b === document.activeElement), true);
  const hold = mine.getByTestId('silent-hold-mode');
  await hold.click();
  await mine.keyboard.press('Escape');
  assert.equal(await hold.getAttribute('aria-pressed'), 'false');
  await hold.click();
  await act(people[2], 'chat_send', { channelKind: 'room', roomId: 'bathroom_room', text: '选牌中' });
  await mine.locator('#chat-unread').waitFor();
  assert.equal(await hold.getAttribute('aria-pressed'), 'true');
  assert.equal(requests.length, 0);
  const result = await click(mine, 'silent_skip', () => mine.getByTestId('silent-card-2').click());
  assert.equal(requests[0].index, 2);
  assert.equal(result.round.silent.cards[2].holderId, people[1].playerId);
});

test('a named offline actor retains the turn and the last tab controls the reconnect hint', async t => {
  const { people, prepare, open, snapshot } = await session(t, 4);
  await prepare();
  const host = await open(people[0]);
  const first = await open(people[1]);
  const mirror = await open(people[1]);
  await first.close();
  assert.equal((await snapshot(people[0])).players[1].connected, true);
  assert.doesNotMatch(await host.getByTestId('current-task').innerText(), /重新连接/);
  await mirror.close();
  await host.waitForFunction(() => /等待 2 号.*重新连接.*翻牌/.test(document.getElementById('setup-title').textContent));
  const back = await open(people[1]);
  await host.waitForFunction(() => !document.getElementById('setup-title').textContent.includes('重新连接'));
  assert.equal(await back.getByTestId('silent-card-0').isEnabled(), true);
  assert.equal((await snapshot(people[0])).round.silent.turnPlayerId, people[1].playerId);
});

test('after 72 exploration actions every seat can download the same public milestones and retain the final report in the lobby', { timeout: 120000 }, async t => {
  const { people, prepare, open, act, snapshot } = await session(t, 4);
  await prepare();
  const [hako, first, second] = people;
  const privateMessage = '这是不会进入复盘的同房私聊';
  await act(second, 'chat_send', { channelKind: 'room', roomId: 'bathroom_room', text: privateMessage });
  await act(first, 'silent_reveal', { index: 0 });
  await act(first, 'peek', { cornerId: 'bathroom_washer' });
  await act(hako, 'resolve_visitor_action');
  await act(first, 'publish_token', { tokenId: 'password_5' });
  await act(first, 'resolve_peek', { take: false });
  let count = 0;
  for (;;) {
    const { round: r } = await snapshot(hako);
    if (count >= 72 && r.phase === 'visitor_reveal') break;
    assert.ok(count++ < 94, 'A new playable round boundary is reached');
    const turn = people.find(p => p.playerId === r.silent.turnPlayerId);
    if (r.pendingAction) await act(hako, 'resolve_visitor_action');
    else if (r.phase === 'visitor_reveal') await act(turn, 'silent_reveal', { index: r.silent.cards.find(c => c.status === 'down').index });
    else if (r.phase === 'visitor_action') await act(turn, 'move', { roomId: (await snapshot(turn)).round.moveTargets[0] });
    else if (r.phase === 'hako_reaction') await act(hako, 'pass_noise_reaction');
    else if (r.powers?.canBegin) await act(hako, 'begin_hako_action');
    else if (r.hako.hidingTargets?.length) await act(hako, 'hako_hide', { cornerId: r.hako.hidingTargets[0] });
    else if (r.hako.hidingRooms?.length) await act(hako, 'inspect_hiding_room', { roomId: r.hako.hidingRooms[0].id });
    else assert.fail('Unexpected exploration phase ' + r.phase);
  }
  const viewers = [];
  for (const p of people) viewers.push(await open(p));
  for (const p of people.slice(1)) await act(p, 'surrender', { agree: true });
  const ended = await snapshot(first);
  assert.equal(ended.phase, 'game_over');
  assert.equal(ended.log.length, 64);
  assert.ok(ended.log.every(line => !line.includes('公开了一条发现')));
  async function download(page, button) {
    await dismiss(page);
    assert.equal(await button.isEnabled(), true);
    const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return readFile(await file.path(), 'utf8');
  }
  const reports = [];
  for (const page of viewers) reports.push(await download(page, page.getByTestId('save-review')));
  assert.equal(new Set(reports).size, 1);
  assert.match(reports[0], /第1轮.*公开了密码5.*洗衣机/);
  for (const text of ['一楼', '二楼', '地下室', '获胜玩家', '玩家物品', '箱娃能力', '保险箱内', '最近 64 条房间行动']) assert.ok(reports[0].includes(text));
  for (const sensitive of [privateMessage, first.token, hako.token, first.roomCode, 'privateClues', 'undoHistory', 'recoveryDigest']) assert.ok(!reports[0].includes(sensitive));
  const undo = await act(first, 'undo_request', { version: ended.version });
  for (const id of undo.undo.pending.requiredIds.filter(id => id !== first.playerId)) {
    await act(people.find(p => p.playerId === id), 'undo_respond', { requestId: undo.undo.pending.id, accept: true });
  }
  assert.equal(await viewers[0].getByTestId('save-review').count(), 0);
  assert.equal(await viewers[0].locator('#save-last-review').isVisible(), false);
  await act(people.at(-1), 'surrender', { agree: true });
  assert.equal((await snapshot(hako)).phase, 'game_over');
  const latestReport = await download(viewers[0], viewers[0].getByTestId('save-review'));
  await viewers.at(-1).close();
  await act(people.at(-1), 'leave', { endGame: true });
  assert.equal(await download(viewers[0], viewers[0].locator('#save-last-review')), latestReport);
  await viewers[1].reload();
  await viewers[1].getByTestId('ready-button').waitFor();
  assert.equal(await viewers[1].locator('#save-last-review').isVisible(), false);
  await act(hako, 'add_bots');
  for (const person of people.slice(0, -1)) await act(person, 'ready', { ready: true });
  await act(hako, 'start');
  assert.equal(await viewers[0].locator('#save-last-review').isVisible(), false);
});

test('a new origin restores the same visitor, their inventory and their pending gift response', { timeout: 60000 }, async t => {
  const { people, prepare, open, act, snapshot } = await session(t, 5);
  await prepare();
  const [, first, second] = people;
  const original = await open(second);
  await act(first, 'offer_exchange', { targetId: second.playerId, giveItemIds: ['night_vision'], giveTokenIds: [], requestItemIds: [], requestTokenIds: [] });
  const waiting = await snapshot(second);
  await original.getByTestId('room-menu-toggle').click();
  const issued = original.waitForResponse(r => r.url().endsWith('/recovery-code'));
  await original.locator('#issue-seat-code').click();
  const { recoveryCode } = await (await issued).json();
  const context = await original.context().browser().newContext();
  t.after(() => context.close());
  const fresh = await context.newPage();
  await fresh.goto(original.url().replace('127.0.0.1', 'localhost'));
  await fresh.locator('#seat-recovery summary').click();
  await fresh.locator('#recover-code').fill(recoveryCode);
  const exchanged = fresh.waitForResponse(r => r.url().endsWith('/recover'));
  await fresh.locator('#recover-seat').click();
  const { state } = await (await exchanged).json();
  assert.equal(state.you, second.playerId);
  assert.equal(state.version, waiting.version);
  assert.equal(state.hostId, waiting.hostId);
  assert.deepEqual(state.round.inventory, waiting.round.inventory);
  assert.deepEqual(state.round.exchangeOffers, waiting.round.exchangeOffers);
  assert.match(await fresh.getByTestId('current-task').innerText(), /回应.*赠送/);
  await fresh.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  const accepted = fresh.waitForResponse(r => r.url().endsWith('/actions'));
  await fresh.getByTestId('exchange-accept').click();
  assert.equal((await accepted).status(), 200);
  assert.ok((await snapshot(second)).round.inventory.items.some(item => item.id === 'night_vision'));
});

test('a delayed accepted action cannot replace the newer board after undo', { timeout: 60000 }, async t => {
  const { people, prepare, open, act, snapshot } = await session(t, 4);
  await prepare();
  const first = people[1];
  const mine = await open(first);
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; });
  const committed = new Promise(resolve => { announce = resolve; });
  t.after(release);
  await mine.route('**/actions', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    announce(await response.json());
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  await mine.getByTestId('silent-card-2').click();
  const state = await committed;
  const restored = await act(first, 'undo_request', { version: state.version });
  assert.equal(restored.round.phase, 'visitor_reveal');
  const returned = mine.waitForResponse(r => r.url().endsWith('/actions'));
  release();
  await returned;
  await mine.waitForFunction(() => document.querySelector('[data-testid="silent-card-2"]')?.disabled === false);
  assert.equal((await snapshot(first)).version, restored.version);
  assert.equal((await snapshot(first)).round.silent.cards[2].status, 'down');
});
