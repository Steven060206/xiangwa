import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';

const deck = ['study', 'upstairs', 'bathroom', 'basement', 'dining', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('four browser sessions configure the same manor and retain their seats after refresh', { timeout: 120000 }, async t => {
  const server = createGameServer({ deck });
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

  const names = ['守夜人', '青禾', '小满', '阿照'];
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext({ viewport: i === 1 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    contexts.push(context);
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
    await page.getByTestId('ready-button').click();
  }
  const started = pages[0].waitForResponse(response => new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === 'start');
  await pages[0].getByTestId('start-setup').click();
  assert.equal((await started).status(), 200);
  let state = await getState(identities[0]);
  assert.equal(state.phase, 'map_setup');

  for (let turn = 0; turn < deck.length; turn++) {
    const currentIndex = identities.findIndex(person => person.playerId === state.setup.turnPlayerId);
    const page = pages[currentIndex];
    const drawnResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === 'draw');
    await page.getByTestId('draw-tile').click();
    assert.equal((await drawnResponse).status(), 200);
    state = await getState(identities[currentIndex]);
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
    const placedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === 'place');
    await page.getByTestId('confirm-placement').click();
    assert.equal((await placedResponse).status(), 200);
    state = await getState(identities[currentIndex]);
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
