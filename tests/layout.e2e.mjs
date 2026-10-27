import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { MAP_TILES } from '../src/maps.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('compact desktop and mobile boards show public players and only the viewer own hiding position', { timeout: 90000 }, async t => {
  const server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'The compact layout must not cause browser errors');
  });
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const people = [await request('/api/rooms', { name: '守夜人' })];
  for (const name of ['青禾', '小满', '阿照']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  const act = (person, type, data = {}) => request(`/api/rooms/${person.roomCode}/actions`, {
    playerId: person.playerId, token: person.token, type, ...data,
  });
  const snapshot = person => request(`/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  for (let i = 0; i < 3; i++) {
    const person = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = await act(person, 'choose_item', { itemId: state.draft.availableItems[0].id });
  }
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
  await act(people[0], 'choose_initial_power', { powerId: state.opening.initialPowerOptions[0].id });
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [];
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ viewport: index === 0 ? { width: 1366, height: 900 } : { width: 390, height: 844 } });
    await context.addInitScript(person => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(person));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__layoutState = JSON.parse(event.data); });
        }
      };
    }, people[index]);
    const page = await context.newPage();
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), async () => { await page.keyboard.press('Escape'); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?room=${people[index].roomCode}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    pages.push(page);
  }
  const roomFloor = (view, id) => view.setup.placements.find(placement => MAP_TILES.find(tile => tile.id === placement.tileId)
    .rooms.some(room => room.id === id))?.floor;
  async function verifyPage(page, person) {
    const view = await snapshot(person);
    const expected = view.round.visitors.filter(visitor => visitor.status === 'alive').map(visitor => ({
      id: visitor.id, roomId: visitor.roomId, floor: roomFloor(view, visitor.roomId),
    }));
    if (view.round.hako.playerId === view.you) expected.push({ id: view.you,
      roomId: view.round.hako.roomId, floor: roomFloor(view, view.round.hako.roomId) });
    for (const floor of [1, 2, -1]) {
      await page.getByTestId(floor === -1 ? 'floor-basement' : `floor-${floor}`).click();
      const markers = await page.locator('#tile-board .map-player-marker').evaluateAll(elements =>
        elements.map(element => ({ id: element.dataset.playerId, roomId: element.dataset.roomId })));
      assert.deepEqual(markers.sort((a, b) => a.id.localeCompare(b.id)), expected.filter(player => player.floor === floor)
        .map(({ id, roomId }) => ({ id, roomId })).sort((a, b) => a.id.localeCompare(b.id)),
      'Only public visitors and the viewer own actor appear on their actual floor');
      if (person.playerId !== people[0].playerId) assert.equal(await page.locator('#tile-board .private-position').count(), 0);
    }
    await page.locator(`#map-positions [data-player-id="${person.playerId}"]`).click();
    assert.equal(await page.locator(`#tile-board .map-player-marker[data-player-id="${person.playerId}"]`).count(), 1,
      'Selecting a player position switches to its floor and locates its marker');
    const geometry = await page.evaluate(() => ({
      fitsWidth: document.documentElement.scrollWidth <= innerWidth,
      fitsHeight: document.documentElement.scrollHeight <= innerHeight + 1,
      board: document.getElementById('board-section').getBoundingClientRect().toJSON(),
      map: document.getElementById('board-viewport').getBoundingClientRect().toJSON(),
      controls: document.querySelector('.setup-sidebar').getBoundingClientRect().toJSON(),
    }));
    assert.equal(geometry.fitsWidth, true);
    assert.equal(geometry.fitsHeight, true, 'Regular play fits the viewport without scrolling the whole document');
    assert.ok(geometry.board.height >= 180 && geometry.controls.height >= 160,
      'The map and operation panel both have usable space on screen');
    assert.ok(geometry.map.height >= 150, 'The actual map canvas keeps at least 150px of usable height');
    const context = await page.locator(`#tile-board .map-player-marker[data-player-id="${person.playerId}"]`).evaluate(marker => {
      const view = document.getElementById('board-viewport').getBoundingClientRect();
      const tile = marker.closest('.placed-tile').getBoundingClientRect();
      const token = marker.getBoundingClientRect();
      return { tokenVisible: token.top >= view.top && token.bottom <= view.bottom && token.left >= view.left && token.right <= view.right,
        tileHeight: tile.height, visibleHeight: Math.max(0, Math.min(view.bottom, tile.bottom) - Math.max(view.top, tile.top)) };
    });
    assert.equal(context.tokenVisible, true, 'Locating a player brings its full token into the map viewport');
    assert.ok(context.visibleHeight >= Math.min(context.tileHeight, geometry.map.height) - 2,
      'Locating a player shows the surrounding board tile instead of a token at the viewport edge');
  }
  await verifyPage(pages[0], people[0]);
  await verifyPage(pages[1], people[1]);
  const guideToggle = pages[1].getByRole('button', { name: '展开角落位置对照', exact: true });
  assert.equal(await guideToggle.getAttribute('aria-expanded'), 'false', 'The mobile location guide starts as one compact line');
  const controlsBeforeGuide = await pages[1].locator('.setup-sidebar').boundingBox();
  await guideToggle.click();
  assert.equal(await pages[1].locator('#corner-guide-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await pages[1].locator('#corner-guide-body').isVisible(), true);
  const controlsAfterGuide = await pages[1].locator('.setup-sidebar').boundingBox();
  assert.deepEqual(controlsAfterGuide, controlsBeforeGuide, 'Opening the guide overlays the map without pushing or shrinking the current operations');
  await pages[1].getByRole('button', { name: '收起角落位置对照', exact: true }).click();
  const undoHint = pages[1].locator('#undo-panel .undo-hint').first();
  assert.equal(await undoHint.getAttribute('title'), await undoHint.textContent(), 'The compact undo hint retains its complete meaning');
  await pages[1].getByRole('button', { name: '专看地图', exact: true }).click();
  assert.equal(await pages[1].locator('.setup-sidebar').isVisible(), false);
  await pages[1].getByRole('button', { name: '返回操作', exact: true }).click();
  assert.equal(await pages[1].locator('.setup-sidebar').isVisible(), true);
  state = await act(people[1], 'silent_reveal', { index: 0 });
  const destination = state.round.moveTargets[0];
  assert.ok(destination);
  await act(people[1], 'move', { roomId: destination });
  state = await act(people[0], 'resolve_visitor_action');
  await Promise.all(pages.map(page => page.waitForFunction(version => window.__layoutState?.version >= version, state.version)));
  await verifyPage(pages[0], people[0]);
  await verifyPage(pages[1], people[1]);
  const ghostPrivacy = await pages[1].evaluate(async original => {
    const { mapPlayers } = await import('/tile.js');
    const view = structuredClone(original);
    const own = view.round.visitors.find(visitor => visitor.id === view.you);
    own.status = 'box_person';
    delete own.roomId;
    view.round.ghost = { status: 'box_person', roomId: 'children_room', cornerId: 'children_cabinet' };
    const ownMarkers = mapPlayers(view);
    delete view.round.ghost;
    // A different viewer must never derive that box person's corner from a visitor row.
    return { own: ownMarkers.filter(player => player.id === view.you), others: mapPlayers(view).filter(player => player.id === view.you) };
  }, await snapshot(people[1]));
  assert.equal(ghostPrivacy.own.length, 1);
  assert.equal(ghostPrivacy.own[0].cornerId, 'children_cabinet');
  assert.deepEqual(ghostPrivacy.others, []);
  await mkdir('test-results', { recursive: true });
  await pages[0].screenshot({ path: 'test-results/compact-map-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/compact-map-mobile.png', fullPage: true });

  async function undoClick(page, type, testId) {
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await page.getByTestId(testId).click();
    const response = await responsePromise;
    const next = await response.json();
    assert.equal(response.status(), 200, `${type}: ${JSON.stringify(next)}`);
    await Promise.all(pages.map(page => page.waitForFunction(version => window.__layoutState?.version >= version, next.version)));
    return next;
  }
  let requested = await undoClick(pages[1], 'undo_request', 'undo-request');
  assert.deepEqual([...requested.undo.pending.requiredIds].sort(), [people[0].playerId, people[1].playerId].sort(),
    'The vote includes both online human browser sessions');
  assert.equal(await pages[0].getByTestId('undo-accept').isVisible(), true);
  assert.equal(await pages[1].getByTestId('surrender').isDisabled(), true,
    'Ordinary game controls freeze while the table considers an undo');
  await pages[1].getByTestId('floor-2').click();
  assert.equal(await pages[1].getByTestId('surrender').isDisabled(), true,
    'Changing floors must keep newly rendered game controls frozen');
  await pages[1].locator(`#map-positions [data-player-id="${people[1].playerId}"]`).click();
  assert.equal(await pages[1].getByTestId('surrender').isDisabled(), true,
    'Locating a player must preserve the undo lock while allowing map navigation');
  assert.equal((await snapshot(people[1])).undo.pending.id, requested.undo.pending.id,
    'Local map navigation does not change the pending vote');
  let continued = await undoClick(pages[0], 'undo_respond', 'undo-reject');
  assert.equal(continued.undo.pending, null);
  assert.equal(continued.round.visitors.find(visitor => visitor.id === people[1].playerId).roomId, destination);
  assert.equal(await pages[1].getByTestId('surrender').isEnabled(), true,
    'Declining restores normal controls without changing the player position');

  await undoClick(pages[1], 'undo_request', 'undo-request');
  continued = await undoClick(pages[1], 'undo_cancel', 'undo-cancel');
  assert.equal(continued.undo.pending, null);
  assert.equal(continued.round.visitors.find(visitor => visitor.id === people[1].playerId).roomId, destination);
  assert.equal(await pages[1].getByTestId('surrender').isEnabled(), true,
    'Cancelling also restores normal controls and preserves the board');

  requested = await undoClick(pages[1], 'undo_request', 'undo-request');
  assert.ok(requested.undo.pending);
  const restored = await undoClick(pages[0], 'undo_respond', 'undo-accept');
  assert.equal(restored.undo.pending, null);
  assert.deepEqual(restored.round.pendingAction, {
    type: 'move', playerId: people[1].playerId, fromRoomId: 'hall_room', toRoomId: destination,
  }, 'Accepting restores the original move declaration and its confirmation window');
  assert.equal(restored.round.visitors.find(visitor => visitor.id === people[1].playerId).roomId, 'hall_room');
  await verifyPage(pages[0], people[0]);
  await verifyPage(pages[1], people[1]);

  for (const viewport of [{ width: 667, height: 375 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await pages[0].setViewportSize(viewport);
    const geometry = await pages[0].evaluate(() => ({
      fitsWidth: document.documentElement.scrollWidth <= innerWidth,
      fitsHeight: document.documentElement.scrollHeight <= innerHeight + 1,
      boardHeight: document.getElementById('board-viewport').clientHeight,
      boardSectionHeight: document.getElementById('board-section').clientHeight,
      controlsHeight: document.querySelector('.setup-sidebar').clientHeight,
    }));
    const size = `${viewport.width}×${viewport.height}`;
    assert.equal(geometry.fitsWidth, true, `${size}: the layout does not overflow horizontally`);
    assert.ok(geometry.boardHeight >= 150, `${size}: the actual map remains usable (${JSON.stringify(geometry)})`);
    assert.ok(geometry.controlsHeight >= 160, `${size}: operations do not collapse to zero height`);
    if (viewport.height > 600) assert.equal(geometry.fitsHeight, true, `${size}: portrait play keeps the compact layout`);
    await pages[0].getByTestId('resolve-action').click({ trial: true });
    if (viewport.width === 667) {
      await pages[0].evaluate(() => window.scrollTo(0, 0));
      await pages[0].screenshot({ path: 'test-results/audit-short-mobile.png', fullPage: true });
    }
  }
  const resolved = await undoClick(pages[0], 'resolve_visitor_action', 'resolve-action');
  assert.equal(resolved.round.pendingAction, null, 'A short landscape viewport can complete the pending action');
  assert.equal(resolved.round.visitors.find(visitor => visitor.id === people[1].playerId).roomId, destination);
});
