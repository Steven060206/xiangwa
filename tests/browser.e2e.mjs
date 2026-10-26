import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';

const deck = ['study', 'upstairs', 'bathroom', 'basement', 'dining', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('four browser sessions complete private opening and synchronized silent rounds', { timeout: 180000 }, async t => {
  const server = createGameServer({ deck, silentNumbers: [5, 4, 1, 2, 0, 3] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const contexts = [];
  const pages = [];
  const identities = [];
  const browserErrors = [];
  t.after(async () => {
    await browser.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function getState(person) {
    const query = new URLSearchParams({ playerId: person.playerId, token: person.token });
    const response = await fetch(`${base}/api/rooms/${person.roomCode}?${query}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  async function waitForSSE(version) {
    await Promise.all(pages.map(page => page.waitForFunction(
      expected => window.__hakoLastState?.version >= expected, version,
    )));
  }

  async function performAction(page, type, trigger) {
    const pendingResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions')
      && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await pendingResponse;
    assert.equal(response.status(), 200, `${type} should succeed`);
    const snapshot = await response.json();
    await waitForSSE(snapshot.version);
    return snapshot;
  }

  const privateKeys = new Set(['password', 'weakness', 'passwordOptions', 'weaknessOptions',
    'remainsCornerId', 'remainsTargets', 'inspectedRoom', 'hidingRooms', 'hidingTargets',
    'hidingCornerId', 'hidingUnderToken', 'initialPowerOptions', 'cornerTokens', 'powerDeck']);
  function assertNoPrivateKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(privateKeys.has(key), false, `Visitor payload must not contain ${key}`);
      assertNoPrivateKeys(child);
    }
  }

  async function assertVisitorPrivacy(openingPhase) {
    const snapshots = await Promise.all(identities.map(getState));
    for (let i = 1; i < pages.length; i++) {
      const snapshot = snapshots[i];
      assertNoPrivateKeys(snapshot);
      assertNoPrivateKeys(await pages[i].evaluate(() => window.__hakoLastState));
      assert.equal(await pages[i].getByTestId('opening-controls').count(), 0);
      assert.equal(await pages[i].getByTestId('hako-location').count(), 0);
      assert.equal(await pages[i].getByTestId('hiding-room-select').count(), 0);
      assert.equal(await pages[i].getByTestId('inspect-hiding-room').count(), 0);
      assert.equal(await pages[i].locator('.inspected-tokens').count(), 0);
      if (openingPhase) {
        assert.equal(snapshot.opening.phase, openingPhase);
        await pages[i].locator(`#opening-panel[data-phase="${openingPhase}"]`).waitFor();
        const panelText = await pages[i].getByTestId('opening-panel').innerText();
        for (const secretText of ['手记 ·', '密码 ·', '讨伐道具 ·', '玛丽小姐的人偶',
          '隐藏出口', '古怪护符', '灭火器', '白木棒', '汽油', '锈锁链']) {
          assert.equal(panelText.includes(secretText), false, `Visitor opening panel must not show ${secretText}`);
        }
        for (const corner of snapshot.opening.corners) {
          assert.deepEqual(Object.keys(corner).sort(), ['id', 'occupied', 'roomId']);
        }
      }
      if (snapshot.round) {
        assert.deepEqual(snapshot.round.hako, { playerId: identities[0].playerId });
        for (const card of snapshot.round.silent.cards) {
          if (card.status === 'up') continue;
          assert.equal(Object.hasOwn(card, 'number'), false, 'Covered silent numbers must stay off the wire');
          const face = pages[i].getByTestId(`silent-card-${card.index}`);
          assert.equal(await face.locator('.silent-card-value').textContent(), card.status === 'held' ? '持' : '无声');
          assert.equal((await face.getAttribute('aria-label')).includes('数字'), false);
          assert.equal(await face.getAttribute('data-number'), null);
        }
      }
    }
    return snapshots;
  }

  const names = ['守夜人', '青禾', '小满', '阿照'];
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext({ viewport: i === 1 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    contexts.push(context);
    await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__hakoLastState = JSON.parse(event.data); });
        }
      };
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(`${base}/${i ? `?room=${identities[0].roomCode}` : ''}`);
    await page.getByTestId('nickname').fill(names[i]);
    const endpoint = i ? `/api/rooms/${identities[0].roomCode}/join` : '/api/rooms';
    if (i) assert.equal(await page.getByTestId('room-code').inputValue(), identities[0].roomCode);
    const joined = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await page.getByTestId(i ? 'join-room' : 'create-room').click();
    const response = await joined;
    assert.equal(response.status(), 201);
    identities.push(await response.json());
    await page.getByTestId('room-code-display').waitFor();
  }

  for (const page of pages) {
    await performAction(page, 'ready', () => page.getByTestId('ready-button').click());
  }
  let state = await performAction(pages[0], 'start', () => pages[0].getByTestId('start-setup').click());
  assert.equal(state.phase, 'item_draft');
  for (let choice = 0; choice < 3; choice++) {
    const currentIndex = identities.findIndex(person => person.playerId === state.draft.turnPlayerId);
    const page = pages[currentIndex];
    const item = page.getByTestId('item-choice').first();
    await item.waitFor();
    const itemId = await item.getAttribute('data-item-id');
    state = await performAction(page, 'choose_item', () => item.click());
    assert.equal(state.initialItems.length, choice + 1);
    assert.equal(state.initialItems.at(-1).playerId, identities[currentIndex].playerId);
    assert.equal(state.initialItems.at(-1).itemId, itemId);
  }
  assert.equal(state.phase, 'map_setup');

  for (let turn = 0; turn < deck.length; turn++) {
    const currentIndex = identities.findIndex(person => person.playerId === state.setup.turnPlayerId);
    const page = pages[currentIndex];
    state = await performAction(page, 'draw', () => page.getByTestId('draw-tile').click());
    assert.equal(state.setup.drawnTileId, deck[turn]);
    await page.getByTestId('rotate-tile').click();
    if (turn >= 4 && state.setup.legalPlacements.some(position => position.floor === 2 && position.rotation === 1)) {
      await page.getByTestId('floor-2').click();
    }
    const target = page.getByTestId('legal-position').first();
    await target.waitFor();
    const placement = await target.evaluate(element => ({
      floor: Number(element.dataset.floor), x: Number(element.dataset.x),
      y: Number(element.dataset.y), rotation: Number(element.dataset.rotation),
    }));
    await target.click();
    if (turn === 0) {
      await mkdir('test-results', { recursive: true });
      await pages[0].screenshot({ path: 'test-results/setup-desktop.png', fullPage: true });
      await pages[1].screenshot({ path: 'test-results/setup-mobile.png', fullPage: true });
    }
    state = await performAction(page, 'place', () => page.getByTestId('confirm-placement').click());
    const actual = state.setup.placements.at(-1);
    assert.deepEqual(actual, { tileId: deck[turn], ...placement });
    assert.equal(state.setup.placements.length, turn + 2);
    const snapshots = await Promise.all(identities.map(getState));
    snapshots.forEach(snapshot => assert.deepEqual(snapshot.setup, state.setup));

    if (turn === 1) {
      const oldId = identities[2].playerId;
      const roomSnapshot = url => url.pathname === `/api/rooms/${identities[2].roomCode}`;
      await pages[2].route(roomSnapshot, route => route.abort('connectionfailed'));
      await pages[2].reload();
      await pages[2].locator('#error-banner').waitFor({ state: 'visible' });
      assert.equal(await pages[2].evaluate(() => JSON.parse(sessionStorage.getItem('hako.room.session.v1'))?.playerId), oldId,
        'A temporary resume failure must preserve the reserved seat credentials');
      await pages[2].unroute(roomSnapshot);
      await pages[2].reload();
      await pages[2].getByTestId('room-code-display').waitFor();
      assert.equal((await getState(identities[2])).you, oldId);
      assert.equal((await getState(identities[2])).players.length, 4);
    }
  }

  assert.equal(state.phase, 'map_ready');
  assert.equal(state.setup.placements.length, 9);
  assert.ok(state.setup.placements.some(placement => placement.floor === 2 && placement.tileId !== 'upstairs'));
  for (const page of pages) {
    await page.getByTestId('map-complete').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Page must fit the viewport');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('h2,p')].filter(element => element.textContent === '地图已拼好' && element.checkVisibility()).length), 1,
      'Completion should be announced once');
    assert.equal(await page.locator('.map-progress > span').evaluate(element => {
      const style = getComputedStyle(element);
      return style.writingMode === 'horizontal-tb' && element.getBoundingClientRect().height <= parseFloat(style.lineHeight) * 1.5;
    }), true, 'Map progress caption should remain horizontal on desktop and mobile');
  }
  await pages[0].screenshot({ path: 'test-results/complete-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/complete-mobile.png', fullPage: true });

  const hakoPage = pages[0];
  state = await performAction(hakoPage, 'prepare_opening', () => hakoPage.getByTestId('prepare-opening').click());
  assert.equal(state.phase, 'opening_setup');
  await hakoPage.getByTestId('opening-controls').waitFor();
  await assertVisitorPrivacy('secrets');
  for (const value of ['1', '3', '6']) {
    await hakoPage.locator(`[data-testid="password-choice"][value="${value}"]`).check();
  }
  await hakoPage.getByTestId('weakness-select').selectOption('gasoline');
  state = await performAction(hakoPage, 'choose_secrets', () => hakoPage.getByTestId('confirm-secrets').click());
  assert.deepEqual(state.opening.password, [1, 3, 6]);
  assert.equal(state.opening.weakness, 'gasoline');
  assert.equal(state.opening.corners.filter(corner => corner.occupied).length, 23);
  await assertVisitorPrivacy('remains');

  const remainsCorner = state.opening.remainsTargets[0];
  await hakoPage.getByTestId('remains-select').selectOption(remainsCorner);
  state = await performAction(hakoPage, 'place_remains', () => hakoPage.getByTestId('confirm-remains').click());
  assert.equal(state.opening.remainsCornerId, remainsCorner);
  assert.equal(state.opening.corners.filter(corner => corner.occupied).length, 24);
  await assertVisitorPrivacy('hiding_room');
  await hakoPage.getByTestId('initial-room-select').selectOption('children_room');
  state = await performAction(hakoPage, 'inspect_initial_room', () => hakoPage.getByTestId('inspect-initial-room').click());
  assert.equal(state.opening.inspectedRoom.id, 'children_room');
  assert.equal(await hakoPage.locator('.inspected-tokens > div').count(), state.opening.inspectedRoom.corners.length);
  await assertVisitorPrivacy('hiding_corner');
  await hakoPage.screenshot({ path: 'test-results/opening-hako.png', fullPage: true });

  const initialHiding = state.opening.hidingTargets[0];
  await hakoPage.getByTestId('initial-hiding-select').selectOption(initialHiding);
  state = await performAction(hakoPage, 'choose_initial_hiding', () => hakoPage.getByTestId('confirm-initial-hiding').click());
  assert.equal(state.opening.hidingCornerId, initialHiding);
  await assertVisitorPrivacy('power');
  await hakoPage.reload();
  await hakoPage.getByTestId('initial-power-select').waitFor();
  const restoredHako = await getState(identities[0]);
  await waitForSSE(restoredHako.version);
  assert.equal(restoredHako.you, identities[0].playerId);
  assert.deepEqual(restoredHako.opening.password, [1, 3, 6]);
  assert.equal(restoredHako.opening.weakness, 'gasoline');
  assert.equal(restoredHako.opening.hidingCornerId, initialHiding);
  await assertVisitorPrivacy('power');

  await hakoPage.getByTestId('initial-power-select').selectOption('1');
  state = await performAction(hakoPage, 'choose_initial_power', () => hakoPage.getByTestId('confirm-initial-power').click());
  assert.equal(state.phase, 'practice');
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.hako.cornerId, initialHiding);
  assert.equal(state.round.silent.total, 0);
  assert.ok(state.round.visitors.every(visitor => visitor.roomId === 'hall_room'));
  for (const page of pages) {
    await page.getByTestId('practice-panel').waitFor();
    assert.equal(await page.getByTestId('initial-power').textContent(), '初始箱娃之力：就在你身旁');
  }
  await hakoPage.getByTestId('hako-location').waitFor();
  await assertVisitorPrivacy();

  for (let turn = 0; turn < 3; turn++) {
    const visitorId = state.round.silent.turnPlayerId;
    const visitorIndex = identities.findIndex(person => person.playerId === visitorId);
    const page = pages[visitorIndex];
    state = await performAction(page, 'silent_reveal', () => page.getByTestId(`silent-card-${turn}`).click());
    assert.equal(state.round.phase, 'visitor_action');
    assert.equal(state.round.silent.total, [5, 9, 10][turn], 'A total of exactly 10 still permits movement');
    const previousRoom = state.round.visitors.find(visitor => visitor.id === visitorId).roomId;
    const move = page.getByTestId('move-target').first();
    await move.waitFor();
    const targetRoom = await move.getAttribute('data-room-id');
    state = await performAction(page, 'move', () => move.click());
    assert.equal(state.round.phase, 'visitor_reaction');
    assert.equal(state.round.pendingAction.toRoomId, targetRoom);
    const pendingSnapshots = await assertVisitorPrivacy();
    for (let i = 0; i < pages.length; i++) {
      assert.equal(pendingSnapshots[i].round.visitors.find(visitor => visitor.id === visitorId).roomId, previousRoom);
      const location = pages[i].locator(`[data-testid="visitor-location"][data-player-id="${visitorId}"]`);
      assert.equal(await location.getAttribute('data-room-id'), previousRoom, 'Movement remains pending until hako confirms');
      if (i) assert.equal(await pages[i].getByTestId('resolve-action').count(), 0);
    }
    state = await performAction(hakoPage, 'resolve_visitor_action', () => hakoPage.getByTestId('resolve-action').click());
    assert.equal(state.round.pendingAction, null);
    const resolvedSnapshots = await assertVisitorPrivacy();
    for (let i = 0; i < pages.length; i++) {
      assert.equal(resolvedSnapshots[i].round.visitors.find(visitor => visitor.id === visitorId).roomId, targetRoom);
      const location = pages[i].locator(`[data-testid="visitor-location"][data-player-id="${visitorId}"]`);
      assert.equal(await location.getAttribute('data-room-id'), targetRoom);
    }
  }

  const interruptedVisitorId = state.round.silent.turnPlayerId;
  const interruptedIndex = identities.findIndex(person => person.playerId === interruptedVisitorId);
  const beforeOverflow = structuredClone(state.round.visitors);
  state = await performAction(pages[interruptedIndex], 'silent_reveal', () => pages[interruptedIndex].getByTestId('silent-card-3').click());
  assert.equal(state.round.phase, 'hako_reaction');
  assert.equal(state.round.silent.total, 12);
  assert.deepEqual(state.round.visitors, beforeOverflow, 'Overflow prevents the interrupted visitor from acting');
  await assertVisitorPrivacy();
  for (const page of pages) assert.equal(await page.getByTestId('move-target').count(), 0);
  for (const page of pages.slice(1)) assert.equal(await page.getByTestId('pass-noise-reaction').count(), 0);
  state = await performAction(hakoPage, 'pass_noise_reaction', () => hakoPage.getByTestId('pass-noise-reaction').click());
  assert.equal(state.round.phase, 'hako_phase');
  assert.deepEqual(state.round.hako.hidingTargets, [], 'Hako must inspect a room before selecting its corner');
  const hidingRoom = state.round.hako.hidingRooms[0].id;
  await hakoPage.getByTestId('hiding-room-select').selectOption(hidingRoom);
  state = await performAction(hakoPage, 'inspect_hiding_room', () => hakoPage.getByTestId('inspect-hiding-room').click());
  assert.equal(state.round.hako.inspectedRoom.id, hidingRoom);
  assert.ok(state.round.hako.inspectedRoom.corners.length > 0);
  await assertVisitorPrivacy();
  const nextHiding = state.round.hako.hidingTargets[0];
  await hakoPage.getByTestId('hiding-select').selectOption(nextHiding);
  state = await performAction(hakoPage, 'hako_hide', () => hakoPage.getByTestId('confirm-hiding').click());
  assert.equal(state.round.hako.cornerId, nextHiding);
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.silent.total, 0);
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.silent.turnPlayerId, interruptedVisitorId, 'The visitor interrupted by overflow resumes after hako');
  assert.ok(state.round.silent.cards.every(card => card.status === 'down'));
  assert.deepEqual(state.round.visitors, beforeOverflow);
  await assertVisitorPrivacy();
  for (const page of pages) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Opening and round controls must fit desktop and mobile viewports');
  }
  await hakoPage.screenshot({ path: 'test-results/round-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/round-mobile.png', fullPage: true });

  await pages[3].evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('hako.room.session.v1'));
    saved.token = 'invalid-token';
    sessionStorage.setItem('hako.room.session.v1', JSON.stringify(saved));
  });
  await pages[3].reload();
  await pages[3].locator('#error-banner').waitFor({ state: 'visible' });
  assert.equal(await pages[3].evaluate(() => sessionStorage.getItem('hako.room.session.v1')), null,
    'A confirmed invalid identity should clear unusable credentials');
  assert.deepEqual(browserErrors, []);
});
