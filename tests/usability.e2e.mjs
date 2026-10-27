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

function usabilityFixture(setup, opening, options) {
  const play = createPlay(setup, opening, options);
  const relocate = (tokenId, destination) => {
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
    assert.ok(source, `The fixture relocates an actual piece: ${tokenId}`);
    if (typeof destination === 'string') {
      [play.tokens[source], play.tokens[destination]] = [play.tokens[destination], play.tokens[source]];
    } else {
      play.inventories[destination.playerId].tokens.push(play.tokens[source]);
      play.tokens[source] = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
    }
  };
  relocate('password_4', { playerId: setup.visitorIds[0] });
  relocate('password_5', 'bathroom_toilet');
  relocate('password_6', 'bathroom_washer');
  play.round.visitors[0].roomId = 'bathroom_room';
  return play;
}

test('important private events appear above the game, dismiss without acting, and remain readable in history', { timeout: 90000 }, async t => {
  const server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState: usabilityFixture });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [], errors = [];
  let uiActionRequests = 0;
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'The new status and event surfaces must not raise browser errors');
  });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const people = [await request('/api/rooms', { name: '守夜箱娃' })];
  for (const name of ['寻路小满', '青禾', '阿照']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  async function sync(version) {
    await Promise.all(pages.map(page => page.waitForFunction(expected => window.__usabilityState?.version >= expected, version)));
  }
  async function act(person, type, values = {}) {
    const state = await request(`/api/rooms/${person.roomCode}/actions`, {
      playerId: person.playerId, token: person.token, type, ...values,
    });
    await sync(state.version);
    return state;
  }
  const snapshot = person => request(`/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  async function click(page, type, trigger) {
    const received = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await received;
    const state = await response.json();
    assert.equal(response.status(), 200, `${type}: ${JSON.stringify(state)}`);
    await sync(state.version);
    return state;
  }
  const [hako, first] = people;
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(hako, 'start');
  let state = await act(hako, 'claim_hako');
  for (let index = 0; index < 3; index++) {
    const person = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = await act(person, 'choose_item', { itemId: state.draft.availableItems[0].id });
  }
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  await act(hako, 'prepare_opening');
  await act(hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await act(hako, 'place_remains', { cornerId: 'living_sofa' });
  await act(hako, 'inspect_initial_room', { roomId: 'children_room' });
  state = await act(hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  await act(hako, 'choose_initial_power', { powerId: state.opening.initialPowerOptions[0].id });

  async function open(person, mobile) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          window.__usabilitySource = this;
          this.addEventListener('state', event => { window.__usabilityState = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) uiActionRequests += 1;
    });
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    return page;
  }
  const mobile = await open(first, true);
  const observer = await open(hako, false);
  const dialogOpen = page => page.locator('#event-dialog').evaluate(dialog => dialog.open);
  async function assertHeadingInSidebar(locator, message) {
    const geometry = await locator.evaluate(section => {
      const heading = section.querySelector('h2, h3');
      const rect = heading.getBoundingClientRect();
      const sidebar = document.querySelector('.setup-sidebar').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, sidebarTop: sidebar.top, sidebarBottom: sidebar.bottom };
    });
    assert.ok(geometry.top >= geometry.sidebarTop && geometry.bottom <= geometry.sidebarBottom,
      `${message}: ${JSON.stringify(geometry)}`);
  }
  assert.equal(await dialogOpen(mobile), false, 'Loading an existing inventory does not announce it as newly acquired');
  assert.match(await mobile.getByTestId('turn-owner').innerText(), /你|寻路小满/);
  assert.match(await mobile.getByTestId('current-task').innerText(), /翻|无声|轮到/);
  assert.match(await mobile.locator('#personal-status').innerText(), /访问者|求生者/);
  await mobile.getByTestId('focus-inventory').click();
  await assertHeadingInSidebar(mobile.getByTestId('inventory'), 'Inventory navigation brings its heading into the sidebar viewport');
  await mobile.getByTestId('focus-current-action').click();
  await click(mobile, 'silent_reveal', () => mobile.getByTestId('silent-card-0').click());
  await click(mobile, 'peek', () => mobile.getByTestId('peek-target').filter({ hasText: '废旧马桶内' }).click());
  await act(hako, 'resolve_visitor_action');
  await mobile.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.match(await mobile.getByTestId('event-title').innerText(), /密码5/);
  assert.equal(await mobile.locator('#event-dialog').evaluate(dialog => dialog.matches(':modal')), true,
    'An important finding uses the browser top layer, above clipped map and operation containers');
  assert.equal((await observer.getByTestId('event-title').allTextContents()).some(title => title.includes('密码5')), false,
    'The other role never receives the private finding in its notification DOM');

  async function dismissOutside(page) {
    const card = await page.getByTestId('event-highlight').boundingBox();
    assert.ok(card);
    let point;
    for (const selector of ['#map-focus', '[data-testid="floor-2"]', '[data-testid="floor-1"]']) {
      const rect = await page.locator(selector).boundingBox();
      if (!rect) continue;
      const candidate = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (candidate.x < card.x || candidate.x > card.x + card.width || candidate.y < card.y || candidate.y > card.y + card.height) {
        point = candidate;
        break;
      }
    }
    assert.ok(point, 'A visible map control lies outside the event card for the click-through regression');
    const before = await snapshot(first);
    const calls = uiActionRequests;
    const focused = await page.locator('#setup-view').evaluate(element => element.classList.contains('map-focused'));
    const floor = await page.locator('#floor-tabs [aria-selected="true"]').getAttribute('data-floor');
    await page.mouse.click(point.x, point.y);
    assert.equal(await dialogOpen(page), false);
    assert.equal((await snapshot(first)).version, before.version, 'Dismissing a finding does not perform or resolve a game action');
    assert.equal(uiActionRequests, calls, 'The dismissal click is not forwarded to an underlying game control');
    assert.equal(await page.locator('#setup-view').evaluate(element => element.classList.contains('map-focused')), focused);
    assert.equal(await page.locator('#floor-tabs [aria-selected="true"]').getAttribute('data-floor'), floor);
  }
  await dismissOutside(mobile);
  assert.match(await mobile.getByTestId('private-resolution').innerText(), /密码5/,
    'The original decision remains available after the event is dismissed');
  const decisionOrder = await mobile.getByTestId('private-resolution').evaluate(response => {
    const inventory = document.getElementById('personal-inventory');
    return { before: Boolean(response.compareDocumentPosition(inventory) & Node.DOCUMENT_POSITION_FOLLOWING),
      responseTop: response.getBoundingClientRect().top, inventoryTop: inventory.getBoundingClientRect().top };
  });
  assert.equal(decisionOrder.before, true, 'The pending finding is before inventory in DOM reading order');
  assert.ok(decisionOrder.responseTop < decisionOrder.inventoryTop, 'The pending finding is positioned before inventory');
  await mobile.getByTestId('focus-inventory').click();
  await assertHeadingInSidebar(mobile.getByTestId('inventory'), 'Inventory navigation scrolls past the current finding');
  await mobile.getByTestId('focus-current-action').click();
  await assertHeadingInSidebar(mobile.getByTestId('private-resolution'), 'Current-action navigation returns to the unresolved finding');
  await mobile.getByTestId('floor-2').click();
  await mobile.getByTestId('floor-1').click();
  assert.equal(await dialogOpen(mobile), false, 'Local map redraws do not repeat an already dismissed event');
  state = await click(mobile, 'resolve_peek', () => mobile.getByTestId('resolve-peek').click());
  await mobile.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.match(await mobile.getByTestId('event-title').innerText(), /获得|得到|取得/);
  assert.match(await mobile.getByTestId('event-title').innerText(), /密码5/);
  assert.equal((await observer.getByTestId('event-title').allTextContents()).some(title => title.includes('密码5')), false);
  await mkdir('test-results', { recursive: true });
  await mobile.screenshot({ path: 'test-results/usability-mobile.png', fullPage: true });
  const afterTake = await snapshot(first);
  await mobile.locator('#event-close').click();
  assert.equal(await dialogOpen(mobile), false);
  assert.equal((await snapshot(first)).version, afterTake.version);
  assert.equal(await mobile.getByTestId('inventory-token').filter({ hasText: '密码5' }).count(), 1);
  await mobile.getByTestId('event-history-toggle').click();
  assert.match(await mobile.getByTestId('event-history').innerText(), /密码5/);
  assert.equal(await dialogOpen(mobile), false, 'Opening history does not reopen a closed announcement');
  await mobile.getByTestId('event-history-toggle').click();
  await mobile.screenshot({ path: 'test-results/usability-mobile-game.png', fullPage: true });

  const desktop = await open(first, false);
  assert.equal(await dialogOpen(desktop), false, 'A second tab starts from the current possessions without replaying old gains');
  await desktop.getByTestId('focus-inventory').click();
  await desktop.screenshot({ path: 'test-results/usability-desktop.png', fullPage: true });
  const layouts = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await mobile.setViewportSize(viewport);
    if (viewport.width === 375) {
      await mobile.locator('#tile-board .corner-location[data-corner-id="bathroom_toilet"]').tap();
      const selected = mobile.getByTestId('selected-corner-name');
      assert.equal(await selected.isVisible(), true, 'A short-screen tap visibly names the selected corner');
      assert.match(await selected.innerText(), /废旧马桶内/);
      assert.match(await selected.innerText(), /\d{2}/);
      const placement = await selected.evaluate(label => {
        const rect = label.getBoundingClientRect();
        const board = document.getElementById('board-section').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          boardTop: board.top, boardBottom: board.bottom, boardLeft: board.left, boardRight: board.right };
      });
      assert.ok(placement.top >= placement.boardTop && placement.bottom <= placement.boardBottom
        && placement.left >= placement.boardLeft && placement.right <= placement.boardRight,
      `The selected-corner label stays inside the short-screen map: ${JSON.stringify(placement)}`);
    }
    const geometry = await mobile.evaluate(() => {
      const elements = Object.fromEntries(['#board-section', '.board-toolbar', '#map-positions', '.board-caption', '.corner-guide', '.game-layout', '.setup-sidebar', '#game-status', '.room-header', '#undo-panel'].map(selector => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const rect = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        return [selector, { top: rect.top, height: rect.height, width: rect.width, display: css.display, gridRows: css.gridTemplateRows, minHeight: css.minHeight }];
      }));
      return {
        fitsWidth: document.documentElement.scrollWidth <= innerWidth,
        mapHeight: document.getElementById('board-viewport').getBoundingClientRect().height,
        controlsHeight: document.querySelector('.setup-sidebar').getBoundingClientRect().height,
        statusWidth: document.getElementById('game-status').getBoundingClientRect().width,
        viewportWidth: innerWidth,
        elements,
      };
    });
    layouts.push({ viewport, geometry });
  }
  console.log(`Usability layout metrics: ${JSON.stringify(layouts)}`);
  for (const { viewport, geometry } of layouts) {
    assert.equal(geometry.fitsWidth, true, `${viewport.width}×${viewport.height}: the page has no horizontal overflow`);
    assert.ok(geometry.mapHeight >= 150, `${viewport.width}×${viewport.height}: the map retains useful space: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.controlsHeight >= 160, `${viewport.width}×${viewport.height}: the current controls retain useful space: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.statusWidth <= geometry.viewportWidth, 'The status strip fits small and landscape viewports');
  }
  await mobile.setViewportSize({ width: 390, height: 844 });

  for (const person of people.slice(2)) {
    const view = await snapshot(person);
    const down = view.round.silent.cards.find(card => card.status === 'down');
    let current = await act(person, 'silent_reveal', { index: down.index });
    await act(person, 'move', { roomId: current.round.moveTargets[0] });
    await act(hako, 'resolve_visitor_action');
  }
  state = await snapshot(first);
  await act(first, 'silent_reveal', { index: state.round.silent.cards.find(card => card.status === 'down').index });
  await act(first, 'peek', { cornerId: 'bathroom_washer' });
  await act(hako, 'resolve_visitor_action');
  await mobile.waitForFunction(() => document.getElementById('event-dialog').open);
  assert.match(await mobile.getByTestId('event-title').innerText(), /密码6/);
  await desktop.waitForFunction(() => document.getElementById('event-dialog').open);
  await desktop.screenshot({ path: 'test-results/usability-desktop-event.png', fullPage: true });
  const beforeEscape = await snapshot(first);
  await mobile.keyboard.press('Escape');
  assert.equal(await dialogOpen(mobile), false);
  assert.equal((await snapshot(first)).version, beforeEscape.version, 'Escape returns to the same unresolved game decision');
  // The desktop tab saw the same private event; dismiss it before voting.
  if (await dialogOpen(desktop)) await desktop.keyboard.press('Escape');
  const pending = await act(first, 'undo_request', { version: beforeEscape.version });
  assert.ok(pending.undo.pending);
  if (await dialogOpen(mobile)) await mobile.keyboard.press('Escape');
  await mobile.getByTestId('focus-current-action').click();
  assert.equal(await mobile.getByTestId('resolve-peek').isDisabled(), true,
    'Locating the current decision cannot bypass the undo freeze');
  assert.equal(await mobile.getByTestId('surrender').isDisabled(), true);
  assert.equal((await snapshot(first)).undo.pending.id, pending.undo.pending.id);
  await act(hako, 'undo_respond', { requestId: pending.undo.pending.id, accept: false });
  // Exercise the filtered ghost view before and after the server unlocks hiding.
  const ghostWait = structuredClone(await snapshot(first));
  ghostWait.version += 1;
  ghostWait.round.phase = 'hako_phase';
  ghostWait.round.resolution = null;
  ghostWait.round.pendingAction = null;
  ghostWait.round.interruption = null;
  ghostWait.round.powers.step = 'action';
  ghostWait.round.visitors.find(visitor => visitor.id === first.playerId).status = 'box_person';
  ghostWait.round.ghost = { status: 'box_person', cornerId: 'children_cabinet', roomId: 'children_room',
    finished: false, hidingRooms: [], hidingTargets: [] };
  const receiveFiltered = view => window.__usabilitySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(view) }));
  await mobile.evaluate(receiveFiltered, ghostWait);
  if (await dialogOpen(mobile)) await mobile.keyboard.press('Escape');
  assert.match(await mobile.locator('#setup-title').innerText(), /等待箱娃开始潜伏/);
  assert.doesNotMatch(await mobile.getByTestId('turn-owner').innerText(), /现在轮到你/);
  assert.equal(await mobile.getByTestId('focus-current-action').innerText(), '查看进度');
  ghostWait.version += 1;
  ghostWait.round.ghost.hidingRooms = [{ id: 'children_room', name: '儿童房' }];
  await mobile.evaluate(receiveFiltered, ghostWait);
  assert.match(await mobile.locator('#setup-title').innerText(), /轮到你行动与潜伏/);
  await mobile.getByTestId('focus-current-action').click();
  assert.equal(await mobile.locator('.hako-sequence').count(), 1);
  ghostWait.version += 1;
  delete ghostWait.round.ghost;
  ghostWait.round.visitors.find(visitor => visitor.id === first.playerId).status = 'alive';
  await mobile.evaluate(receiveFiltered, ghostWait);
  assert.match(await mobile.locator('#setup-title').innerText(), /等待箱娃与箱人行动/);
});
