import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';
import { MAP_TILES } from '../src/maps.mjs';

const deck = ['study', 'upstairs', 'bathroom', 'basement', 'dining', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mapRooms = MAP_TILES.flatMap(tile => tile.rooms);
const mapCorners = mapRooms.flatMap(room => room.corners.map(corner => ({ ...corner, room })));
const numberedCornerName = id => {
  const index = mapCorners.findIndex(corner => corner.id === id);
  const corner = mapCorners[index];
  return `${String(index + 1).padStart(2, '0')} · ${corner.room.name} · ${corner.name}`;
};

test('four browser sessions complete private opening, powers, exploration, item answers, exchanges and surrender', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hako-browser-'));
  let server;
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'Only remove the test directory under the system temporary directory');
      await rm(directory, { recursive: true, force: true });
    }
  });
  const serverOptions = { dataFile: join(directory, 'rooms.json'), deck, silentNumbers: [5, 4, 1, 2, 0, 3], createPlayState(setup, opening, options) {
    const play = createPlay(setup, opening, options);
    // Keep this power-specific midgame scenario deterministic after the real
    // private three-card draft, without adding or removing any numbered card.
    const selected = play.powers.hand[0];
    if (selected.id !== 1) {
      const index = play.powers.deck.indexOf(1);
      assert.ok(index >= 0);
      play.powers.deck[index] = selected.id;
      selected.id = 1;
    }
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_2');
    assert.ok(source, 'The unused password 2 must be in the initial token pool');
    const before = Object.values(play.tokens).filter(Boolean).map(token => token.id).sort();
    [play.tokens.dark_wardrobe, play.tokens[source]] = [play.tokens[source], play.tokens.dark_wardrobe];
    assert.deepEqual(Object.values(play.tokens).filter(Boolean).map(token => token.id).sort(), before,
      'The trusted fixture swaps existing pieces without creating or removing them');
    // Arrange a previously cleared corner with an X from the real reserve so the
    // browser must exercise the optional face-down control during hiding.
    assert.notEqual(play.round.hidingCornerId, 'children_toys');
    play.removedTokens.push(play.tokens.children_toys);
    play.tokens.children_toys = { ...play.opening.emptyBoxTokens.shift(), faceUp: true };
    const powersBefore = [...play.powers.deck].sort();
    const cryCardIndex = play.powers.deck.indexOf(10);
    assert.notEqual(cryCardIndex, -1, 'The unused power 10 must be in the real deck');
    [play.powers.deck[0], play.powers.deck[cryCardIndex]] = [play.powers.deck[cryCardIndex], play.powers.deck[0]];
    assert.deepEqual([...play.powers.deck].sort(), powersBefore,
      'The cry fixture reorders the real deck without introducing or removing cards');
    return play;
  } };
  server = createGameServer(serverOptions);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const contexts = [];
  const pages = [];
  const identities = [];
  const browserErrors = [];

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
    'hidingCornerId', 'hidingUnderToken', 'initialPowerOptions', 'initialPowerId', 'initialPowerName',
    'initialPowerCandidates', 'cornerTokens', 'powerDeck', 'lastInspectedRoom',
    'hand', 'activationOptions', 'rearrangement', 'pathInspection', 'cryRooms', 'lastDraw',
    'truth', 'canLie', 'answerOptions']);
  // A declared target's cornerId is public. Hako/ghost locations and unrevealed contents
  // remain private; rejecting every cornerId would also reject a valid peek declaration.
  function assertNoPrivateKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(privateKeys.has(key), false, `Visitor payload must not contain ${key}`);
      assertNoPrivateKeys(child);
    }
  }

  function assertNoPasswordTwo(value) {
    assert.notEqual(value, 'password_2', 'Private token IDs must not reach an uninvited player');
    if (!value || typeof value !== 'object') return;
    assert.notEqual(value.id, 'password_2', 'An uninvited player must not receive the private password token');
    assert.equal(value.type === 'password' && value.number === 2, false);
    for (const child of Object.values(value)) assertNoPasswordTwo(child);
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
      assert.equal(await pages[i].getByTestId('hiding-room-memory').count(), 0);
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

  async function assertInspectedRoom(page, room, selectId) {
    const names = { safe: '转轮式保险箱', notebook: '手记', password: '密码', weakness_clue: '讨伐情况',
      weapon: '讨伐道具', doll: '玛丽小姐的人偶', hidden_exit: '隐藏出口', amulet: '古怪护符',
      extinguisher: '灭火器', remains: '亡骸', empty_box: '空箱', key: '钥匙' };
    assert.equal(await page.locator('.inspected-tokens > [data-corner-id]').count(), room.corners.length);
    for (const corner of room.corners) {
      const row = page.locator(`.inspected-tokens > [data-corner-id="${corner.id}"]`);
      assert.equal(await row.isVisible(), true, 'Every public corner name must be visible before choosing a hiding location');
      const expected = !Object.hasOwn(corner, 'token') ? null
        : corner.token?.type === 'weapon'
        ? { white_stick: '白木棒', gasoline: '汽油', rusty_chain: '锈锁链' }[corner.token.tool]
        : corner.token ? names[corner.token.type] : '无标志';
      if (Object.hasOwn(corner, 'token')) assert.ok(expected, `Missing test name for ${corner.token?.type}`);
      const option = page.getByTestId(selectId).locator(`option[value="${corner.id}"]`);
      for (const text of [await row.innerText(), await option.textContent()]) {
        assert.ok(text.includes(numberedCornerName(corner.id)), 'Room list and location option share the map number and full name');
        if (expected) assert.ok(text.includes(expected), `Room list and location option must identify ${expected}`);
        if (corner.token?.number !== undefined) assert.ok(text.includes(`数字${corner.token.number}`));
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }

  async function assertCornerGuide(page, setup) {
    const guideToggle = page.locator('#corner-guide-toggle');
    const wasExpanded = await guideToggle.getAttribute('aria-expanded') === 'true';
    if (!wasExpanded) await guideToggle.click();
    for (const floor of [1, 2, -1]) {
      await page.getByTestId(floor === -1 ? 'floor-basement' : `floor-${floor}`).click();
      const expectedRooms = setup.placements.filter(placement => placement.floor === floor)
        .flatMap(placement => MAP_TILES.find(tile => tile.id === placement.tileId).rooms);
      const actual = await page.evaluate(() => ({
        visible: document.getElementById('corner-guide').checkVisibility(),
        rooms: [...document.querySelectorAll('#corner-guide .corner-guide-room')].map(room => ({
          id: room.dataset.roomId, name: room.querySelector('h3').textContent,
          corners: [...room.querySelectorAll('.corner-guide-entry')].map(corner => ({
            id: corner.dataset.cornerId, number: corner.querySelector('.corner-guide-number').textContent,
            name: corner.querySelector('.corner-guide-name').textContent,
            visible: corner.querySelector('.corner-guide-name').checkVisibility(),
          })),
        })),
        markers: [...document.querySelectorAll('#tile-board .placed-tile .corner-location')]
          .map(corner => ({ id: corner.dataset.cornerId, number: corner.querySelector('.corner-number').textContent })),
        fits: document.documentElement.scrollWidth <= innerWidth,
      }));
      assert.equal(actual.visible, true, 'The corner guide is visible without hovering on desktop and mobile');
      assert.deepEqual(actual.rooms, expectedRooms.map(room => ({
        id: room.id, name: room.name,
        corners: room.corners.map(corner => ({
          id: corner.id, number: String(mapCorners.findIndex(candidate => candidate.id === corner.id) + 1).padStart(2, '0'),
          name: corner.name, visible: true,
        })),
      })), 'The guide describes exactly the rooms and public locations on the selected floor');
      const expectedMarkers = actual.rooms.flatMap(room => room.corners.map(({ id, number }) => ({ id, number })));
      assert.deepEqual(actual.markers.sort((a, b) => a.id.localeCompare(b.id)),
        expectedMarkers.sort((a, b) => a.id.localeCompare(b.id)), 'Map marks and the readable guide use matching stable numbers');
      assert.equal(actual.fits, true, 'The location guide fits the page at desktop and mobile widths');
    }
    await page.getByTestId('floor-1').click();
    if (!wasExpanded) await guideToggle.click();
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

  let lobbyState = await getState(identities[0]);
  await waitForSSE(lobbyState.version);
  assert.equal(lobbyState.players.every(player => player.role === 'visitor'), true);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    assert.equal(await page.getByTestId('claim-hako').isVisible(), false);
    assert.equal(await page.locator('#hako-claim-controls').isVisible(), false);
    assert.equal(await page.getByTestId('ready-button').isEnabled(), true);
    assert.equal(await page.getByTestId('start-setup').isVisible(), index === 0);
  }
  assert.equal(await pages[0].getByTestId('start-setup').innerText(), '开始游戏');
  for (const page of pages) {
    lobbyState = await performAction(page, 'ready', () => page.getByTestId('ready-button').click());
  }
  assert.equal(lobbyState.phase, 'lobby');
  assert.equal(lobbyState.players.every(player => player.ready), true);
  for (const page of pages) assert.equal(await page.getByTestId('claim-hako').isVisible(), false,
    'All four players being ready must still wait for the host to start');

  let state = await performAction(pages[0], 'start', () => pages[0].getByTestId('start-setup').click());
  assert.equal(state.phase, 'hako_selection');
  assert.equal(state.draft, null);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const snapshot = await getState(identities[index]);
    assert.equal(snapshot.phase, 'hako_selection');
    assert.equal(snapshot.draft, null);
    assert.equal(snapshot.players.every(player => player.role === 'visitor' && player.ready), true);
    assert.equal(await page.locator('#lobby-view').isVisible(), true);
    assert.equal(await page.locator('#lobby-title').innerText(), '谁来扮演箱娃？');
    assert.equal(await page.locator('#lobby-seats > li').count(), 4);
    assert.equal(await page.getByTestId('ready-button').isVisible(), false);
    assert.equal(await page.getByTestId('start-setup').isVisible(), false);
    assert.equal(await page.locator('#leave-room').isVisible(), false);
    assert.equal(await page.locator('#hako-claim-controls').isVisible(), true);
    assert.equal(await page.getByTestId('claim-hako').isVisible(), true);
    assert.equal(await page.getByTestId('claim-hako').isEnabled(), true);
    assert.equal(await page.getByTestId('claim-hako').innerText(), '抢当箱娃');
    assert.equal(await page.getByTestId('hako-claim-status').innerText(), '四人已准备，点击按钮抢当箱娃，先抢先得。');
    assert.equal(await page.getByTestId('hako-claim-status').getAttribute('aria-live'), 'polite');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'The Hako selection must fit desktop and mobile viewports');
  }
  await mkdir('test-results', { recursive: true });
  await pages[0].screenshot({ path: 'test-results/lobby-claim-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/lobby-claim-mobile.png', fullPage: true });

  await pages[1].reload();
  await pages[1].getByTestId('room-code-display').waitFor();
  lobbyState = await getState(identities[1]);
  await waitForSSE(lobbyState.version);
  assert.equal(lobbyState.you, identities[1].playerId, 'Refreshing preserves the player identity');
  assert.equal(lobbyState.players.length, 4);
  assert.equal(lobbyState.phase, 'hako_selection');
  assert.equal(lobbyState.draft, null);
  assert.equal(lobbyState.players.every(player => player.role === 'visitor' && player.ready), true,
    'Refreshing during Hako selection preserves readiness');
  assert.equal(await pages[1].getByTestId('claim-hako').isVisible(), true);
  assert.equal(await pages[1].getByTestId('claim-hako').isEnabled(), true);

  state = await performAction(pages[0], 'claim_hako', () => pages[0].getByTestId('claim-hako').click());
  assert.equal(state.phase, 'item_draft');
  assert.equal(state.players.find(player => player.role === 'hako').id, identities[0].playerId);
  for (const page of pages) assert.equal(await page.getByTestId('claim-hako').isVisible(), false);
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

  for (const page of pages.slice(0, 2)) await assertCornerGuide(page, state.setup);
  const rotationErrors = await pages[0].evaluate(async expected => {
    const { createTileSvg, cornerNumber, cornerName } = await import('/tile.js');
    const { MAP_TILES } = await import('/shared/maps.mjs');
    const errors = [];
    const locations = new Map([...expected.base, ...expected.extra].map(corner => [corner.id, corner]));
    const extras = expected.extra.toReversed().map(corner => ({ id: corner.id, roomId: corner.roomId, name: corner.name }));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:160px;pointer-events:none';
    document.body.append(host);
    try {
      for (const tile of MAP_TILES) for (let rotation = 0; rotation < 4; rotation++) {
        const svg = createTileSvg(tile.id, rotation, extras);
        host.replaceChildren(svg);
        const markers = [...svg.querySelectorAll('.corner-location')];
        const count = tile.rooms.reduce((total, room) => total + room.corners.length + 1, 0);
        if (markers.length !== count) errors.push(`${tile.id}/${rotation}: missing or duplicate corner marks`);
        for (const marker of markers) {
          const id = marker.dataset.cornerId;
          const corner = locations.get(id);
          const label = marker.querySelector('.corner-number');
          const matrix = label?.getCTM();
          if (!corner || label?.textContent !== corner.number || cornerNumber(id) !== corner.number)
            errors.push(`${id}/${rotation}: number differs from public location`);
          if (corner && cornerName(id) !== `${corner.number} · ${corner.roomName} · ${corner.name}`)
            errors.push(`${id}/${rotation}: incomplete location name`);
          if (!matrix || matrix.a <= 0 || matrix.d <= 0 || Math.abs(matrix.b) > 0.001 || Math.abs(matrix.c) > 0.001)
            errors.push(`${id}/${rotation}: number turns with the board`);
          if (!label?.checkVisibility() || !marker.querySelector('.corner-mark'))
            errors.push(`${id}/${rotation}: location cannot be read without hovering`);
        }
      }
    } finally {
      host.remove();
    }
    return errors;
  }, {
    base: mapCorners.map((corner, index) => ({ id: corner.id, name: corner.name, roomName: corner.room.name,
      number: String(index + 1).padStart(2, '0') })),
    extra: mapRooms.map((room, index) => ({ id: `suitcase:${room.id}`, roomId: room.id, name: '行李箱中',
      roomName: room.name, number: String(index + 25).padStart(2, '0') })),
  });
  assert.deepEqual(rotationErrors, [], 'All map locations and additional suitcases retain upright, stable numbers in every rotation');
  await pages[0].screenshot({ path: 'test-results/corner-guide-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/corner-guide-mobile.png', fullPage: true });

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

  assert.deepEqual(await hakoPage.getByTestId('remains-select').locator('option').evaluateAll(options =>
    options.map(option => ({ id: option.value, name: option.textContent }))),
  state.opening.remainsTargets.map(id => ({ id, name: numberedCornerName(id) })),
  'Every remains option identifies the same numbered position as the map and its guide');

  const remainsCorner = state.opening.remainsTargets[0];
  await hakoPage.getByTestId('remains-select').selectOption(remainsCorner);
  state = await performAction(hakoPage, 'place_remains', () => hakoPage.getByTestId('confirm-remains').click());
  assert.equal(state.opening.remainsCornerId, remainsCorner);
  assert.equal(state.opening.corners.filter(corner => corner.occupied).length, 24);
  await assertVisitorPrivacy('hiding_room');
  await hakoPage.getByTestId('initial-room-select').selectOption('children_room');
  state = await performAction(hakoPage, 'inspect_initial_room', () => hakoPage.getByTestId('inspect-initial-room').click());
  assert.equal(state.opening.inspectedRoom.id, 'children_room');
  await hakoPage.setViewportSize({ width: 390, height: 844 });
  await assertInspectedRoom(hakoPage, state.opening.inspectedRoom, 'initial-hiding-select');
  await hakoPage.getByTestId('opening-panel').screenshot({ path: 'test-results/hiding-initial-mobile.png' });
  await hakoPage.setViewportSize({ width: 1440, height: 1000 });
  await assertInspectedRoom(hakoPage, state.opening.inspectedRoom, 'initial-hiding-select');
  await assertVisitorPrivacy('hiding_corner');
  await hakoPage.screenshot({ path: 'test-results/opening-hako.png', fullPage: true });

  const initialRoomContents = structuredClone(state.opening.inspectedRoom);
  assert.ok(initialRoomContents.corners.every(corner => !Object.hasOwn(corner, 'token')));
  const initialHiding = state.opening.hidingTargets[0];
  await hakoPage.getByTestId('initial-hiding-select').selectOption(initialHiding);
  state = await performAction(hakoPage, 'choose_initial_hiding', () => hakoPage.getByTestId('confirm-initial-hiding').click());
  assert.equal(state.opening.hidingCornerId, initialHiding);
  assert.deepEqual(state.opening.lastInspectedRoom, { id: initialRoomContents.id, cycle: 0,
    corners: [{ id: initialHiding, token: state.opening.hidingUnderToken }] });
  const roomMemory = hakoPage.getByTestId('hiding-room-memory');
  assert.equal(await roomMemory.isVisible(), true);
  const initialRoomText = await roomMemory.locator('dd').allTextContents();
  assert.equal(initialRoomText.length, 1, 'Only the replaced piece is remembered');
  const initialCandidates = structuredClone(state.opening.initialPowerOptions);
  await assertVisitorPrivacy('power');
  await hakoPage.reload();
  await hakoPage.getByTestId('initial-power-select').waitFor();
  assert.deepEqual(await roomMemory.locator('dd').allTextContents(), initialRoomText, 'Opening room memory survives refresh');
  assert.equal(await hakoPage.locator('#initial-power-select option').count(), 3,
    'Exactly the dealt three cards are available as opening choices');
  const restoredHako = await getState(identities[0]);
  await waitForSSE(restoredHako.version);
  assert.equal(restoredHako.you, identities[0].playerId);
  assert.deepEqual(restoredHako.opening.password, [1, 3, 6]);
  assert.equal(restoredHako.opening.weakness, 'gasoline');
  assert.equal(restoredHako.opening.hidingCornerId, initialHiding);
  assert.deepEqual(restoredHako.opening.initialPowerOptions, initialCandidates, 'Refresh preserves the private three-card draw');
  await assertVisitorPrivacy('power');

  const chosenInitial = initialCandidates[0];
  await hakoPage.getByTestId('initial-power-select').selectOption(String(chosenInitial.id));
  state = await performAction(hakoPage, 'choose_initial_power', () => hakoPage.getByTestId('confirm-initial-power').click());
  assert.equal(state.phase, 'practice');
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.hako.cornerId, initialHiding);
  assert.equal(state.round.silent.total, 0);
  assert.ok(state.round.visitors.every(visitor => visitor.roomId === 'hall_room'));
  for (const page of pages) {
    await page.getByTestId('practice-panel').waitFor();
    if (page === hakoPage) assert.match(await page.getByTestId('initial-power').textContent(), new RegExp(chosenInitial.name));
    else assert.equal(await page.getByTestId('initial-power').count(), 0, 'The selected initial power stays private');
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
  assert.equal(state.round.powers.step, 'preparation');
  assert.equal(await hakoPage.getByTestId('inspect-hiding-room').count(), 0,
    'Hiding starts after the public preparation step');
  state = await performAction(hakoPage, 'hako_cry', () => hakoPage.getByTestId('hako-cry').click());
  assert.deepEqual(state.round.powers.announcement, { roomId: 'children_room', cycle: 1 });
  assert.deepEqual(state.round.powers.lastDraw, { kind: 'returned', cards: [10] });
  assert.equal(state.round.powers.handCount, 1, 'An unqualified cry card returns to the real deck');
  for (const page of pages) assert.match(await page.getByTestId('cry-announcement').innerText(), /儿童房/);
  await assertVisitorPrivacy();
  await hakoPage.getByTestId('set-power-select').selectOption('1');
  await hakoPage.getByTestId('set-power-slot').selectOption('0');
  state = await performAction(hakoPage, 'set_power', () => hakoPage.getByTestId('set-power').click());
  assert.equal(state.round.powers.slots[0].card.id, 1);
  assert.equal(state.round.powers.slots[0].faceUp, false);
  const preparedSnapshots = await assertVisitorPrivacy();
  for (let index = 1; index < pages.length; index++) {
    assert.deepEqual(preparedSnapshots[index].round.powers.slots[0], { slot: 0, occupied: true, faceUp: false });
    assert.equal(Object.hasOwn(preparedSnapshots[index].round.powers, 'hand'), false);
    assert.equal(Object.hasOwn(preparedSnapshots[index].round.powers.announcement, 'cornerId'), false);
    assert.equal(await pages[index].getByTestId('power-hand-card').count(), 0);
    assert.match(await pages[index].locator('[data-testid="power-slot"][data-slot="0"]').innerText(), /背面能力/);
    assert.equal(await pages[index].getByTestId('set-power').count(), 0);
    assert.equal(await pages[index].getByTestId('activate-power').count(), 0);
  }
  state = await performAction(hakoPage, 'begin_hako_action', () => hakoPage.getByTestId('begin-hako-action').click());
  assert.equal(state.round.powers.step, 'action');
  state = await performAction(hakoPage, 'activate_power', () => hakoPage.locator('[data-testid="activate-power"][data-power-id="1"]').click());
  assert.equal(state.round.powers.slots[0].occupied, false);
  assert.equal(state.round.powers.handCount, 1, 'A used ordinary ability returns to hako hand');
  assert.deepEqual(state.round.powers.lastActivation, { powerId: 1, name: '就在你身旁', cycle: 1 });
  for (const page of pages) {
    const activationText = await page.getByTestId('power-last-activation').innerText();
    if (page === hakoPage) assert.match(activationText, /发动了就在你身旁/);
    else {
      assert.match(activationText, /发动了能力/);
      assert.equal(activationText.includes('就在你身旁'), false, 'NO.1 stays anonymous unless Hako explicitly reveals it');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Power preparation and activation controls fit desktop and mobile viewports');
  }
  await hakoPage.screenshot({ path: 'test-results/powers-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/powers-mobile.png', fullPage: true });
  assert.deepEqual(state.round.hako.hidingTargets, [], 'Hako must inspect a room before selecting its corner');
  const hidingRoom = 'children_room';
  assert.ok(state.round.hako.hidingRooms.some(room => room.id === hidingRoom));
  await hakoPage.getByTestId('hiding-room-select').selectOption(hidingRoom);
  state = await performAction(hakoPage, 'inspect_hiding_room', () => hakoPage.getByTestId('inspect-hiding-room').click());
  assert.equal(state.round.hako.inspectedRoom.id, hidingRoom);
  assert.ok(state.round.hako.inspectedRoom.corners.length > 0);
  await hakoPage.setViewportSize({ width: 390, height: 844 });
  await assertInspectedRoom(hakoPage, state.round.hako.inspectedRoom, 'hiding-select');
  await hakoPage.getByTestId('practice-panel').screenshot({ path: 'test-results/hiding-later-mobile.png' });
  await hakoPage.setViewportSize({ width: 1440, height: 1000 });
  await assertInspectedRoom(hakoPage, state.round.hako.inspectedRoom, 'hiding-select');
  await assertVisitorPrivacy();
  const faceDown = hakoPage.locator('[data-testid="hide-face-down"][data-corner-id="children_toys"]');
  await faceDown.check();
  assert.equal((await getState(identities[1])).round.cornerState.find(corner => corner.id === 'children_toys').faceUp, true,
    'Selecting the checkbox must wait for hiding confirmation before covering the public X');
  for (const page of pages.slice(1)) assert.equal(await page.getByTestId('hide-face-down').count(), 0);
  const nextHiding = state.round.hako.hidingTargets[0];
  assert.ok(state.round.hako.inspectedRoom.corners.every(corner => !Object.hasOwn(corner, 'token')
    || corner.id === 'children_toys' && corner.token.type === 'empty_box' && corner.token.faceUp === true),
  'The already public face-up X is visible; covered pieces remain unknown');
  await hakoPage.getByTestId('hiding-select').selectOption(nextHiding);
  state = await performAction(hakoPage, 'hako_hide', () => hakoPage.getByTestId('confirm-hiding').click());
  assert.equal(state.round.hako.cornerId, nextHiding);
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.hako.lastInspectedRoom.id, hidingRoom);
  assert.equal(state.round.hako.lastInspectedRoom.cycle, 1);
  assert.equal(state.round.hako.lastInspectedRoom.corners.length, 1);
  assert.equal(state.round.hako.lastInspectedRoom.corners[0].id, nextHiding);
  assert.equal(await roomMemory.isVisible(), true);
  const laterRoomText = await roomMemory.locator('dd').allTextContents();
  assert.equal(laterRoomText.length, 1);
  assert.match(await roomMemory.innerText(), /之后的取放变化不会自动更新/);
  await hakoPage.setViewportSize({ width: 390, height: 844 });
  await roomMemory.screenshot({ path: 'test-results/hiding-memory-mobile.png' });
  await hakoPage.reload();
  await roomMemory.waitFor();
  assert.deepEqual(await roomMemory.locator('dd').allTextContents(), laterRoomText, 'Confirmed hiding memory survives refresh');
  await hakoPage.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(state.round.powers.step, null, 'Ending the hako stage clears its action step');
  assert.equal(state.round.silent.total, 0);
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.silent.turnPlayerId, interruptedVisitorId, 'The visitor interrupted by overflow resumes after hako');
  assert.ok(state.round.silent.cards.every(card => card.status === 'down'));
  assert.deepEqual(state.round.visitors, beforeOverflow);
  await assertVisitorPrivacy();
  const coveredX = (await getState(identities[1])).round.cornerState.find(corner => corner.id === 'children_toys');
  assert.equal(coveredX.occupied, true);
  assert.equal(coveredX.faceUp, undefined);
  assert.equal(coveredX.token, undefined, 'The covered X must disappear from other players’ payloads');
  for (const page of pages) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Opening and round controls must fit desktop and mobile viewports');
  }
  await hakoPage.screenshot({ path: 'test-results/round-desktop.png', fullPage: true });
  assert.ok(await hakoPage.locator('#board-section').evaluate(element => element.getBoundingClientRect().height < 800),
    'Lengthy ability controls must not stretch the map into a column of empty space');
  await pages[1].screenshot({ path: 'test-results/round-mobile.png', fullPage: true });

  const explorerPage = pages[interruptedIndex];
  const recipientIndex = identities.findIndex((person, index) => index > 0 && index !== interruptedIndex);
  const recipient = identities[recipientIndex];
  const recipientPage = pages[recipientIndex];
  const bystanderIndices = [0, identities.findIndex((person, index) => index > 0 && index !== interruptedIndex && index !== recipientIndex)];
  assert.ok(state.round.visitors.every(visitor => visitor.roomId === 'study_room'), 'The three visitors share the logical study board for free actions');
  state = await performAction(explorerPage, 'silent_reveal', () => explorerPage.getByTestId('silent-card-0').click());
  assert.equal(state.round.phase, 'visitor_action');
  const peek = explorerPage.locator('[data-testid="peek-target"][data-corner-id="dark_wardrobe"]');
  state = await performAction(explorerPage, 'peek', () => peek.click());
  assert.deepEqual(state.round.pendingAction, { type: 'peek', playerId: interruptedVisitorId, cornerId: 'dark_wardrobe' });
  assert.equal(state.round.resolution, null, 'Peeking waits for hako confirmation');
  for (let i = 0; i < pages.length; i++) {
    assert.equal(await pages[i].getByTestId('peek-result').count(), 0);
    assertNoPasswordTwo(await pages[i].evaluate(() => window.__hakoLastState));
  }
  const beforeRestart = await Promise.all(identities.map(getState));
  const restartPort = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await Promise.all(pages.map(page => page.locator('#connection-banner').waitFor({ state: 'visible' })));
  server = createGameServer(serverOptions);
  server.listen(restartPort, '127.0.0.1');
  await once(server, 'listening');
  await Promise.all(pages.map(page => page.waitForFunction(previousVersion =>
    window.__hakoLastState?.version >= previousVersion
      && window.__hakoLastState.players.every(player => player.connected)
      && document.getElementById('connection-state').textContent === '已连接', beforeRestart[0].version)));
  const afterRestart = await Promise.all(identities.map(getState));
  for (let index = 0; index < pages.length; index++) {
    assert.deepEqual(afterRestart[index].round, beforeRestart[index].round,
      'Restarting preserves the pending peek, private state and all game progress');
    assert.deepEqual(afterRestart[index].players, beforeRestart[index].players);
    assert.equal(afterRestart[index].you, identities[index].playerId);
    assert.equal(afterRestart[index].code, identities[index].roomCode);
  }
  await explorerPage.reload();
  await explorerPage.getByTestId('practice-panel').waitFor();
  const resumedIdentity = await explorerPage.evaluate(() => JSON.parse(sessionStorage.getItem('hako.room.session.v1')));
  assert.equal(resumedIdentity.playerId, interruptedVisitorId);
  assert.equal(resumedIdentity.token, identities[interruptedIndex].token);
  await waitForSSE((await getState(identities[interruptedIndex])).version);
  await assertVisitorPrivacy();
  state = await performAction(hakoPage, 'resolve_visitor_action', () => hakoPage.getByTestId('resolve-action').click());
  let snapshots = await Promise.all(identities.map(getState));
  assert.equal(snapshots[interruptedIndex].round.resolution.token.id, 'password_2');
  assert.equal(snapshots[interruptedIndex].round.resolution.token.number, 2);
  assert.equal(snapshots[interruptedIndex].round.resolution.canUseEmptyBox, true);
  assert.match(await explorerPage.getByTestId('peek-result').innerText(), /密码.*2/);
  for (let i = 0; i < pages.length; i++) {
    if (i === interruptedIndex) continue;
    assert.deepEqual(snapshots[i].round.resolution, { kind: 'waiting', playerId: interruptedVisitorId });
    assertNoPasswordTwo(snapshots[i]);
    assertNoPasswordTwo(await pages[i].evaluate(() => window.__hakoLastState));
    assert.equal(await pages[i].getByTestId('peek-result').count(), 0);
  }
  await explorerPage.getByTestId('resolve-peek-take').click();
  await explorerPage.getByTestId('replacement-select').selectOption('empty_box');
  state = await performAction(explorerPage, 'resolve_peek', () => explorerPage.getByTestId('resolve-peek').click());
  assert.equal(state.round.resolution, null);
  assert.equal(state.round.inventory.tokens[0].id, 'password_2');
  assert.equal(state.round.cornerState.find(corner => corner.id === 'dark_wardrobe').occupied, true,
    'Taking the password replaces it with a covered empty box');
  assert.equal(state.round.cornerState.find(corner => corner.id === 'dark_wardrobe').token, undefined,
    'The replacement remains covered');
  await explorerPage.reload();
  await explorerPage.locator('[data-testid="inventory-token"][data-token-id="password_2"]').waitFor();
  state = await getState(identities[interruptedIndex]);
  await waitForSSE(state.version);
  assert.equal(state.you, interruptedVisitorId);
  assert.equal(state.round.inventory.tokens[0].number, 2, 'Refreshing restores the private inventory');
  await explorerPage.screenshot({ path: 'test-results/exploration-mobile.png', fullPage: true });

  await explorerPage.getByText('展示、赠送与放置（自由行动）', { exact: true }).click();
  await explorerPage.getByTestId('exchange-target').selectOption(recipient.playerId);
  await explorerPage.getByTestId('show-token-select').selectOption('password_2');
  state = await performAction(explorerPage, 'show_token', () => explorerPage.getByTestId('show-token').click());
  snapshots = await Promise.all(identities.map(getState));
  assert.equal(snapshots[recipientIndex].round.sharedTokens.token.id, 'password_2');
  assert.match(await recipientPage.getByTestId('shared-token').innerText(), /密码.*2/);
  for (const index of [interruptedIndex, ...bystanderIndices]) {
    assert.equal(snapshots[index].round.sharedTokens, null, 'Only the invited recipient receives the private display');
    assert.equal(await pages[index].getByTestId('shared-token').count(), 0);
  }
  for (const index of bystanderIndices) {
    assertNoPasswordTwo(snapshots[index]);
    assertNoPasswordTwo(await pages[index].evaluate(() => window.__hakoLastState));
  }

  await explorerPage.getByText('展示、赠送与放置（自由行动）', { exact: true }).click();
  await explorerPage.getByTestId('exchange-target').selectOption(recipient.playerId);
  await explorerPage.locator('[data-testid="gift-item"][data-item-id="password_2"]').check();
  state = await performAction(explorerPage, 'offer_exchange', () => explorerPage.getByTestId('offer-gift').click());
  assert.equal(state.round.exchangeOffers[0].giveTokens[0].id, 'password_2');
  assert.match(await recipientPage.getByTestId('exchange-offer').innerText(), /密码.*2/,
    'The recipient sees the offered piece before deciding');
  for (const index of bystanderIndices) {
    assert.equal(await pages[index].getByTestId('exchange-offer').count(), 0);
    assertNoPasswordTwo(await pages[index].evaluate(() => window.__hakoLastState));
  }
  state = await performAction(recipientPage, 'respond_exchange', () => recipientPage.getByTestId('exchange-accept').click());
  assert.equal(state.round.inventory.tokens[0].id, 'password_2');
  snapshots = await Promise.all(identities.map(getState));
  assert.equal(snapshots[interruptedIndex].round.inventory.tokens.length, 0);
  assert.equal(snapshots[recipientIndex].round.inventory.tokens[0].id, 'password_2');
  assert.equal(await explorerPage.getByTestId('inventory-token').count(), 0);
  assert.equal(await recipientPage.locator('[data-testid="inventory-token"][data-token-id="password_2"]').count(), 1);
  for (const index of bystanderIndices) {
    assertNoPasswordTwo(snapshots[index]);
    assertNoPasswordTwo(await pages[index].evaluate(() => window.__hakoLastState));
  }
  await recipientPage.screenshot({ path: 'test-results/exploration-desktop.png', fullPage: true });
  await assertVisitorPrivacy();

  const penIndex = 2;
  const penPerson = identities[penIndex];
  const penPage = pages[penIndex];
  state = await getState(penPerson);
  assert.ok(state.round.inventory.items.some(item => item.id === 'spirit_pen'));
  assert.equal(state.round.silent.turnPlayerId, penPerson.playerId,
    'The visitor after the completed peek owns the spirit pen in the real draft order');
  const penCard = state.round.silent.cards.find(card => card.status === 'down');
  assert.ok(penCard);
  state = await performAction(penPage, 'silent_reveal', () => penPage.getByTestId(`silent-card-${penCard.index}`).click());
  assert.equal(state.round.phase, 'visitor_action');
  await penPage.getByTestId('active-item-select').selectOption('spirit_pen');
  await penPage.getByTestId('active-item-room').selectOption('children_room');
  state = await performAction(penPage, 'use_item', () => penPage.getByTestId('use-item').click());
  assert.deepEqual(state.round.pendingAction, { type: 'item', playerId: penPerson.playerId,
    itemId: 'spirit_pen', roomId: 'children_room' });
  assert.equal(state.round.resolution, null, 'Active items use the declaration and hako confirmation window');
  state = await performAction(hakoPage, 'resolve_visitor_action', () => hakoPage.getByTestId('resolve-action').click());
  assert.equal(state.round.resolution.kind, 'item_answer');
  assert.equal(state.round.resolution.playerId, identities[0].playerId);
  assert.equal(state.round.resolution.truth, true, 'The hako remained in the original children room');
  assert.equal(state.round.resolution.canLie, false, 'No false-response ability has been set');
  snapshots = await assertVisitorPrivacy();
  for (let index = 1; index < pages.length; index++) {
    assert.deepEqual(snapshots[index].round.resolution, { kind: 'waiting', playerId: identities[0].playerId });
    assertNoPrivateKeys(snapshots[index]);
    assertNoPrivateKeys(await pages[index].evaluate(() => window.__hakoLastState));
    assert.equal(await pages[index].getByTestId('item-answer').count(), 0);
    assert.equal(await pages[index].getByTestId('item-answer-select').count(), 0);
    assert.equal(await pages[index].getByTestId('answer-item').count(), 0);
  }
  for (const page of pages) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Item question and private answer controls fit desktop and mobile viewports');
  }
  await hakoPage.screenshot({ path: 'test-results/item-answer-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/item-answer-mobile.png', fullPage: true });
  await hakoPage.getByTestId('item-answer-select').selectOption('true');
  state = await performAction(hakoPage, 'answer_item', () => hakoPage.getByTestId('answer-item').click());
  assert.equal(state.round.resolution, null);
  snapshots = await assertVisitorPrivacy();
  const publicAnswer = { kind: 'item_answer', itemId: 'spirit_pen', userId: penPerson.playerId,
    answer: true, roomId: 'children_room' };
  for (let index = 0; index < pages.length; index++) {
    assert.deepEqual(snapshots[index].round.items.events.at(-1), publicAnswer);
    assert.equal(Object.hasOwn(snapshots[index].round.items.events.at(-1), 'cornerId'), false,
      'The public reply identifies a room and never a hiding corner');
    assert.equal(JSON.stringify(snapshots[index].round.items.events).includes(nextHiding), false);
    assert.equal(await pages[index].getByTestId('item-answer').count(), 0);
    const events = pages[index].getByTestId('item-events');
    await events.locator('summary').click();
    assert.match(await events.innerText(), /小满使用笔仙.*儿童房.*箱娃回答：是/);
  }
  assert.ok(snapshots[penIndex].round.inventory.items.some(item => item.id === 'spirit_pen'),
    'Using the spirit pen does not consume its card');
  assert.equal(snapshots[penIndex].round.silent.turnPlayerId, identities[3].playerId,
    'The item answer completes the pen owner’s standard action');

  for (let index = 1; index < pages.length; index++) {
    const page = pages[index];
    await page.getByText('访问者投降', { exact: true }).click();
    state = await performAction(page, 'surrender', () => page.getByTestId('surrender').click());
    assert.equal(state.round.surrenderVotes.length, index);
    if (index < 3) assert.equal(state.round.result, null, 'A single visitor cannot surrender for the whole team');
  }
  assert.equal(state.phase, 'game_over');
  assert.equal(state.round.result.winner, 'hako');
  assert.equal(state.round.result.reason, '访问者全体投降');
  for (const page of pages) {
    await page.getByTestId('game-result').waitFor();
    assert.match(await page.getByTestId('game-result').innerText(), /箱娃胜利/);
    assert.equal(await page.getByTestId('practice-panel').locator('button:not(:disabled)').count(), 0,
      'All round actions are locked after the result');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Exploration and result controls must fit desktop and mobile viewports');
  }
  await hakoPage.screenshot({ path: 'test-results/result-desktop.png', fullPage: true });
  await pages[1].screenshot({ path: 'test-results/result-mobile.png', fullPage: true });

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

for (const mode of ['sse', 'poll']) test(`closed pages recover the original seat and hosts clear abandoned seats over ${mode}`, { timeout: 60000 }, async t => {
  const server = createGameServer();
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const visitorContext = await browser.newContext();
  const errors = [];
  let joins = 0;
  for (const context of [hostContext, visitorContext]) context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  visitorContext.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/join')) joins++; });
  const url = code => `${base}/?${new URLSearchParams({ ...(mode === 'poll' ? { sync: 'poll' } : {}), ...(code ? { room: code } : {}) })}`;
  const identity = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('hako.room.session.v1')));
  const connected = page => page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  async function open(context, code) {
    const page = await context.newPage();
    await page.goto(url(code));
    return page;
  }
  async function enter(page, create) {
    await page.getByTestId('nickname').fill('同名玩家');
    const response = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === (create ? '/api/rooms' : `/api/rooms/${new URL(page.url()).searchParams.get('room')}/join`));
    await page.getByTestId(create ? 'create-room' : 'join-room').click();
    const joined = await response;
    assert.equal(joined.status(), 201);
    await connected(page);
    return identity(page);
  }
  const hostPage = await open(hostContext);
  const host = await enter(hostPage, true);
  const originalPage = await open(visitorContext, host.roomCode);
  // This tab was already on the entry form before the browser acquired a seat.
  const waitingTab = await open(visitorContext, host.roomCode);
  const visitor = await enter(originalPage, false);
  await waitingTab.getByTestId('nickname').fill('不会新增的玩家');
  await waitingTab.getByTestId('join-room').click();
  await connected(waitingTab);
  assert.equal((await identity(waitingTab)).playerId, visitor.playerId);
  assert.equal(joins, 1, 'An already open tab rechecks saved credentials before joining');
  await waitingTab.close();
  // Migrate a legacy tab-only session on reload, then really close the tab.
  await originalPage.evaluate(() => localStorage.removeItem('hako.room.saved.v1'));
  await originalPage.reload();
  await connected(originalPage);
  assert.equal(await originalPage.evaluate(code => JSON.parse(localStorage.getItem('hako.room.saved.v1')).rooms[code].playerId,
    host.roomCode), visitor.playerId);
  await originalPage.close();
  const reopened = await open(visitorContext, host.roomCode);
  await connected(reopened);
  assert.equal((await identity(reopened)).playerId, visitor.playerId);
  const rootPage = await open(visitorContext);
  await connected(rootPage);
  assert.equal(new URL(rootPage.url()).searchParams.get('room'), host.roomCode);
  assert.equal((await identity(rootPage)).playerId, visitor.playerId);
  await hostPage.waitForFunction(() => document.querySelectorAll('#lobby-seats .seat:not(.empty)').length === 2
    && document.querySelectorAll('#lobby-seats .disconnected').length === 0);
  assert.equal(joins, 1, 'Closing and reopening pages never creates a second seat');
  const leaving = rootPage.waitForResponse(response => response.request().postDataJSON()?.type === 'leave');
  await rootPage.locator('#leave-room').click();
  assert.equal((await leaving).status(), 200);
  await rootPage.locator('#entry-view').waitFor({ state: 'visible' });
  await Promise.all([rootPage.close(), reopened.close()]);
  const freshPage = await open(visitorContext, host.roomCode);
  await freshPage.locator('#entry-view').waitFor({ state: 'visible' });
  assert.equal(await identity(freshPage), null, 'Explicit departure clears the browser recovery identity');
  const newVisitor = await enter(freshPage, false);
  assert.notEqual(newVisitor.playerId, visitor.playerId);
  await freshPage.close();
  const remove = hostPage.locator(`[data-testid="remove-offline-player"][data-player-id="${newVisitor.playerId}"]`);
  await remove.waitFor({ state: 'visible', timeout: 20000 });
  await mkdir('test-results', { recursive: true });
  await hostPage.screenshot({ path: `test-results/offline-seat-${mode}-mobile.png`, fullPage: true });
  const removal = hostPage.waitForResponse(response => response.request().postDataJSON()?.type === 'remove_player');
  await remove.click();
  assert.equal((await removal).status(), 200);
  await hostPage.waitForFunction(() => document.querySelectorAll('#lobby-seats .seat:not(.empty)').length === 1);
  const removedPage = await open(visitorContext, host.roomCode);
  await removedPage.locator('#error-banner').waitFor({ state: 'visible' });
  assert.match(await removedPage.locator('#error-text').textContent(), /无法恢复上次入席/);
  assert.equal(await identity(removedPage), null);
  const replacement = await enter(removedPage, false);
  assert.notEqual(replacement.playerId, newVisitor.playerId);
  await hostPage.waitForFunction(() => document.querySelectorAll('#lobby-seats .seat:not(.empty)').length === 2);
  // Another room's invite must not silently restore the previous room.
  const otherCode = host.roomCode === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  const otherPage = await open(visitorContext, otherCode);
  await otherPage.locator('#entry-view').waitFor({ state: 'visible' });
  const otherRoom = await enter(otherPage, true);
  assert.notEqual(otherRoom.roomCode, host.roomCode);
  await otherPage.close();
  const originalRoomPage = await open(visitorContext, host.roomCode);
  await connected(originalRoomPage);
  assert.equal((await identity(originalRoomPage)).playerId, replacement.playerId, 'Room-specific credentials survive visits to another room');
  assert.equal(joins, 3, 'Only explicit joins after leaving or being removed allocate a new seat');
  assert.deepEqual(errors, []);
});

test('four polling browsers retain identity, recover connections and complete first-come role selection', { timeout: 60000 }, async t => {
  const server = createGameServer({ deck });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const contexts = [];
  const pages = [];
  const identities = [];
  const pollRequests = [0, 0, 0, 0];
  const browserErrors = [];
  let streamRequests = 0;

  async function getState(person) {
    const response = await fetch(`${base}/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  async function waitForPoll(version) {
    await Promise.all(pages.map(page => page.waitForFunction(
      expected => window.__hakoPollState?.version >= expected, version,
    )));
  }

  async function performAction(page, type, trigger) {
    const pendingResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions')
      && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await pendingResponse;
    assert.equal(response.status(), 200, `${type} should succeed over polling`);
    const snapshot = await response.json();
    if (type !== 'leave') await waitForPoll(snapshot.version);
    return snapshot;
  }

  async function postAction(person, type, payload = {}) {
    const response = await fetch(`${base}/api/rooms/${person.roomCode}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: person.playerId, token: person.token, type, ...payload }),
    });
    assert.equal(response.status, 200, `${type} should succeed in the setup fixture`);
    return response.json();
  }

  async function joinPage(index, create = false) {
    const page = pages[index];
    await page.getByTestId('nickname').fill(`轮询玩家${index + 1}`);
    if (!create) await page.getByTestId('room-code').fill(identities[0].roomCode);
    const endpoint = create ? '/api/rooms' : `/api/rooms/${identities[0].roomCode}/join`;
    const joined = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await page.getByTestId(create ? 'create-room' : 'join-room').click();
    const response = await joined;
    assert.equal(response.status(), 201);
    identities[index] = await response.json();
    await page.getByTestId('room-code-display').waitFor();
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    assert.equal(new URL(page.url()).searchParams.get('sync'), 'poll');
  }

  for (let index = 0; index < 4; index++) {
    const context = await browser.newContext({ viewport: index === 1 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__hakoPollCount = 0;
      window.__hakoEventSourceCalls = 0;
      window.EventSource = class {
        constructor() {
          window.__hakoEventSourceCalls++;
          throw new Error('Polling mode must not construct EventSource');
        }
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (new URL(response.url).searchParams.get('poll') === '1' && response.ok) {
          window.__hakoPollState = await response.clone().json();
          window.__hakoPollCount++;
        }
        return response;
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) { window.__copiedInvite = value; },
      } });
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.searchParams.get('poll') === '1') pollRequests[index]++;
      if (url.pathname.endsWith('/events')) streamRequests++;
    });
    await page.goto(`${base}/?sync=poll${index ? `&room=${identities[0].roomCode}` : ''}`);
    await joinPage(index, index === 0);
  }
  await Promise.all(pages.map(page => page.waitForFunction(
    () => window.__hakoPollState?.players.length === 4 && window.__hakoPollState.players.every(player => player.connected),
  )));

  await pages[0].locator('#copy-invite').click();
  const invitation = new URL(await pages[0].evaluate(() => window.__copiedInvite));
  assert.equal(invitation.searchParams.get('sync'), 'poll');
  assert.equal(invitation.searchParams.get('room'), identities[0].roomCode);
  const mobileIdentity = identities[1].playerId;
  await pages[1].reload();
  await pages[1].waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.equal(new URL(pages[1].url()).searchParams.get('sync'), 'poll');
  assert.equal(await pages[1].evaluate(() => JSON.parse(sessionStorage.getItem('hako.room.session.v1')).playerId), mobileIdentity);
  assert.equal((await getState(identities[1])).you, mobileIdentity);
  assert.equal((await getState(identities[1])).players.length, 4);

  const pollRoute = url => url.pathname === `/api/rooms/${identities[0].roomCode}` && url.searchParams.get('poll') === '1';
  await contexts[1].route(pollRoute, route => route.abort('connectionfailed'));
  await pages[1].locator('#connection-banner').waitFor({ state: 'visible' });
  assert.equal(await pages[1].getByTestId('ready-button').isEnabled(), false);
  await pages[0].waitForFunction(playerId => window.__hakoPollState?.players.find(player => player.id === playerId)?.connected === false,
    mobileIdentity, { timeout: 20000 });
  await contexts[1].unroute(pollRoute);
  await pages[1].locator('#connection-banner').waitFor({ state: 'hidden' });
  await Promise.all(pages.map(page => page.waitForFunction(
    () => window.__hakoPollState?.players.every(player => player.connected),
  )));
  assert.equal(await pages[1].getByTestId('ready-button').isEnabled(), true);

  await performAction(pages[3], 'leave', () => pages[3].locator('#leave-room').click());
  await pages[3].locator('#entry-view').waitFor({ state: 'visible' });
  const requestsAfterLeave = pollRequests[3];
  const observerPollCount = await pages[0].evaluate(() => window.__hakoPollCount);
  await pages[0].waitForFunction(count => window.__hakoPollCount >= count + 2, observerPollCount);
  assert.equal(pollRequests[3], requestsAfterLeave, 'Leaving a room cancels subsequent poll requests');
  assert.equal(await pages[3].evaluate(() => sessionStorage.getItem('hako.room.session.v1')), null);
  assert.equal(new URL(pages[3].url()).searchParams.get('sync'), 'poll');
  await joinPage(3);
  let state = await getState(identities[0]);
  await waitForPoll(state.version);
  for (const page of pages) state = await performAction(page, 'ready', () => page.getByTestId('ready-button').click());
  state = await performAction(pages[0], 'start', () => pages[0].getByTestId('start-setup').click());
  assert.equal(state.phase, 'hako_selection');
  assert.equal(state.draft, null);
  for (const page of pages) {
    assert.equal(await page.getByTestId('claim-hako').isVisible(), true);
    assert.equal(await page.getByTestId('claim-hako').isEnabled(), true);
  }

  let releaseClaims;
  const claimsReady = new Promise(resolve => { releaseClaims = resolve; });
  let arrivals = 0;
  const claimRoute = async route => {
    if (route.request().postDataJSON()?.type !== 'claim_hako') return route.continue();
    if (++arrivals === 2) releaseClaims();
    await claimsReady;
    return route.continue();
  };
  for (const context of contexts.slice(0, 2)) await context.route('**/actions', claimRoute);
  const pendingClaims = pages.slice(0, 2).map(page => page.waitForResponse(response => response.request().postDataJSON()?.type === 'claim_hako'));
  await Promise.all(pages.slice(0, 2).map(page => page.getByTestId('claim-hako').click()));
  const claims = await Promise.all(pendingClaims);
  assert.deepEqual(claims.map(response => response.status()).sort(), [200, 409]);
  for (const context of contexts.slice(0, 2)) await context.unroute('**/actions', claimRoute);
  state = await getState(identities[0]);
  await waitForPoll(state.version);
  assert.equal(state.phase, 'item_draft');
  assert.equal(state.players.filter(player => player.role === 'hako').length, 1);
  assert.equal(state.players.filter(player => player.role === 'visitor').length, 3);
  const hakoIndex = identities.findIndex(person => person.playerId === state.players.find(player => player.role === 'hako').id);
  for (let choice = 0; choice < 3; choice++) {
    const currentIndex = identities.findIndex(person => person.playerId === state.draft.turnPlayerId);
    assert.equal(currentIndex, (hakoIndex + choice + 1) % 4);
    const page = pages[currentIndex];
    state = await performAction(page, 'choose_item', () => page.getByTestId('item-choice').first().click());
  }
  assert.equal(state.phase, 'map_setup', 'The first successful claim starts the draft without another ready step');

  // Move through the map fixture via the real API to reach editable opening controls.
  for (let turn = 0; turn < deck.length; turn++) {
    const person = identities.find(person => person.playerId === state.setup.turnPlayerId);
    state = await postAction(person, 'draw');
    state = await postAction(person, 'place', state.setup.legalPlacements[0]);
  }
  assert.equal(state.phase, 'map_ready');
  state = await postAction(identities[0], 'prepare_opening');
  await waitForPoll(state.version);
  const hakoPage = pages[hakoIndex];
  const passwordChoice = hakoPage.getByTestId('password-choice').first();
  await passwordChoice.check();
  const weakness = hakoPage.getByTestId('weakness-select');
  const lastWeakness = await weakness.locator('option').last().getAttribute('value');
  await weakness.selectOption(lastWeakness);
  await weakness.focus();
  const formPollCount = await hakoPage.evaluate(() => {
    window.__openingFormControl = document.getElementById('weakness-select');
    return window.__hakoPollCount;
  });
  await hakoPage.waitForFunction(count => window.__hakoPollCount >= count + 2, formPollCount);
  assert.equal(await hakoPage.evaluate(() => window.__openingFormControl === document.getElementById('weakness-select')
    && document.activeElement === window.__openingFormControl), true,
  'Unchanged poll snapshots preserve the form control and its focus');
  assert.equal(await weakness.inputValue(), lastWeakness);
  assert.equal(await passwordChoice.isChecked(), true);
  assert.equal(streamRequests, 0);
  for (const page of pages) assert.equal(await page.evaluate(() => window.__hakoEventSourceCalls), 0);
  assert.deepEqual(browserErrors, []);
});
