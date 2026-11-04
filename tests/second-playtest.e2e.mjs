import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';
import { powerCard } from '../src/powers.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function game(t, { death = false } = {}) {
  const server = createGameServer({ deck, initialItemOrder: ['smartphone', 'walkie_talkie', 'deduction'], silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const firstId = setup.visitorIds[0];
      const take = id => {
        const source = Object.keys(play.tokens).find(corner => play.tokens[corner]?.id === id);
        assert.ok(source, `Move a real piece into the fixture inventory: ${id}`);
        const piece = play.tokens[source];
        play.tokens[source] = null;
        play.inventories[firstId].tokens.push(piece);
      };
      take('password_4');
      const white = Object.values(play.tokens).find(piece => piece?.type === 'weapon' && piece.tool === 'white_stick');
      take(white.id);
      if (death) {
        play.round.visitors[0].roomId = 'children_room';
      } else {
        const notebook = Object.keys(play.tokens).find(corner => play.tokens[corner]?.id === 'notebook_2');
        [play.tokens.hall_clock, play.tokens[notebook]] = [play.tokens[notebook], play.tokens.hall_clock];
        play.inventories[firstId].tokens.push(play.opening.safeBoard.key);
        play.opening.safeBoard.key = null;
        play.safeOpened = true;
        play.removedTokens.push(play.tokens.study_desk);
        play.tokens.study_desk = { ...play.opening.emptyBoxTokens.shift(), faceUp: true };
        play.itemResults[firstId] = { kind: 'phone', card: powerCard(4) };
        play.powers.cryCount = 7;
        play.powers.pendingBehindYou = { cycle: 2 };
        play.powers.used = [11];
      }
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
    assert.deepEqual(errors, [], 'The playtest controls and private views have no browser errors');
  });
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const state = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(state)}`);
    return state;
  };
  const people = [await request('/api/rooms', { name: '箱娃守夜人' })];
  for (const name of ['访问者小满', '访问者青禾', '访问者阿照']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  const sync = version => Promise.all(pages.map(page => page.waitForFunction(expected => window.__secondPlaytest?.version >= expected, version)));
  const act = async (person, type, values = {}) => {
    const state = await request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...values });
    await sync(state.version);
    return state;
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
  for (const [index, person] of people.slice(0, 3).entries()) {
    const context = await browser.newContext({ viewport: index === 1 ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__secondPlaytest = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), () => page.keyboard.press('Escape'));
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  }
  const options = await pages[0].getByTestId('initial-power-select').locator('option').allTextContents();
  assert.equal(options.length, 3);
  assert.ok(options.every(name => /^NO\.\d+ /.test(name)), 'Every initial power choice includes its printed card number');
  const powerId = state.opening.initialPowerOptions.find(card => card.canChoose !== false).id;
  await act(people[0], 'choose_initial_power', { powerId });
  assert.match(await pages[0].getByTestId('initial-power').textContent(), new RegExp(`NO\\.${powerId} `));
  return { people, pages, act, snapshot, click, sync };
}

test('second playtest shows owned items privately, preserves the safe landmark and reveals a complete terminal review', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t);
  const [hp, fp, sp] = pages;
  assert.match(await fp.getByTestId('item-private-result').innerText(), /NO\.4 动来动去/);
  assert.equal(await hp.getByTestId('item-private-result').count(), 0);
  const cryRule = await fp.getByTestId('power-cry-count').innerText();
  assert.match(cryRule, /累计哭喊 7 次.*前9次不能获得.*第10次起按牌序抽取.*来信可以延后/);
  assert.doesNotMatch(cryRule, /保底|必得|保证取得/);
  assert.match(await fp.getByTestId('total-rounds').innerText(), /0/);
  assert.match(await fp.getByTestId('power-delayed-death').innerText(), /NO\.5 我在你身后.*下一箱娃阶段开始时/);
  assert.match(await fp.getByTestId('inventory').innerText(), /白木椿/);
  assert.doesNotMatch(await fp.getByTestId('inventory').innerText(), /白木棒/);
  assert.equal(await fp.getByTestId('safe-landmark').count(), 1, 'Opened safe landmark remains after its corner receives a different piece');
  assert.equal(await fp.getByTestId('public-empty-box').count(), 1, 'The public face-up X is visible on the actual map');
  assert.equal(await fp.getByTestId('public-empty-box').getAttribute('data-corner-id'), 'study_desk');
  assert.equal(await fp.locator('.corner-location[data-token-type]').count(), 0, 'Hidden corner tokens are not rendered before the terminal review');
  assert.match(await fp.getByTestId('safe-public-status').innerText(), /已打开/);
  const memoryBeforeControls = await hp.evaluate(() => Boolean(document.querySelector('[data-testid="hiding-room-memory"]')
    .compareDocumentPosition(document.querySelector('[data-testid="practice-controls"]')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.equal(memoryBeforeControls, true, 'Private replaced-piece record sits next to the current position, before action controls');
  const cornerSize = await fp.locator('.corner-mark').first().getAttribute('width');
  assert.equal(cornerSize, '14');
  assert.equal(await fp.locator('.corner-hit-area').first().getAttribute('width'), '18');
  await fp.getByTestId('possession-sharing').locator('summary').click();
  await fp.getByTestId('show-possession-target').selectOption(people[2].playerId);
  await fp.getByTestId('show-possession-select').selectOption('item:smartphone');
  const before = await snapshot(people[1]);
  await click(fp, 'show_possession', () => fp.getByTestId('show-possession').click());
  assert.match(await sp.getByTestId('shared-token').innerText(), /智能手机/);
  assert.equal(await hp.getByTestId('shared-token').count(), 0);
  assert.deepEqual((await snapshot(people[1])).round.silent, before.round.silent, 'Showing possessions does not spend a turn');
  await click(fp, 'publish_token', () => fp.locator('[data-testid="publish-inventory-token"][data-token-id="password_4"]').click());
  const published = await hp.getByTestId('public-discoveries').innerText();
  assert.match(published, /密码4/);
  assert.doesNotMatch(published, /发现时|角落|公开时持有|写字台|大钟/);
  await act(people[1], 'silent_reveal', { index: 0 });
  await act(people[1], 'peek', { cornerId: 'hall_clock' });
  await act(people[0], 'resolve_visitor_action');
  await fp.locator('.corner-location[data-corner-id="hall_clock"]').click();
  assert.equal(await fp.locator('#map-context .map-context-content').innerText(), '手记2', 'The private map result does not append its number twice');
  await fp.keyboard.press('Escape');
  assert.equal(await fp.getByTestId('publish-peek-token').count(), 0, 'A forced-public notebook has no optional publish action');
  assert.equal(await fp.getByTestId('resolve-peek-take').count(), 0, 'A notebook has no redundant button asking to publish it again');
  assert.match(await hp.getByTestId('notebook-power').innerText(), /NO\.2 马上就到哟/);
  await click(fp, 'resolve_peek', () => fp.getByTestId('resolve-peek').click());
  await mkdir('test-results', { recursive: true });
  await fp.screenshot({ path: 'test-results/second-playtest-mobile.png', fullPage: true });
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const person of people.slice(1)) await act(person, 'surrender', { agree: true });
  await fp.getByTestId('game-review').waitFor();
  assert.equal(await fp.getByTestId('review-corner').count(), 24);
  assert.equal(await fp.getByTestId('review-inventory').count(), 4);
  const powers = await fp.getByTestId('review-powers').innerText();
  assert.match(powers, /NO\.1 /);
  assert.match(powers, /NO\.11 /);
  assert.match(powers, /已移出游戏\s+NO\.12 天旋地转/);
  assert.match(powers, /已使用的能力记录\s+NO\.11 虚假的哭喊/);
  assert.match(powers, /保险箱密码/);
  assert.match(powers, /汽油/);
  assert.equal(await fp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 1, 'Terminal review exposes the Hako position to visitors');
  const review = (await snapshot(people[1])).round.review;
  const mapped = [];
  for (const floor of ['floor-1', 'floor-2', 'floor-basement']) {
    await fp.getByTestId(floor).click();
    mapped.push(...await fp.getByTestId('review-map-corner').evaluateAll(corners => corners.map(corner => ({ id: corner.dataset.cornerId, type: corner.dataset.tokenType }))));
  }
  assert.deepEqual(mapped.sort((a, b) => a.id.localeCompare(b.id)), review.corners.map(corner => ({ id: corner.id, type: corner.token?.type || 'empty' })).sort((a, b) => a.id.localeCompare(b.id)));
  await fp.getByTestId('floor-1').click();
  await fp.locator('.corner-location[data-corner-id="hall_clock"]').click();
  assert.match(await fp.getByTestId('map-context').innerText(), /终局盘面 · 全员可见/);
  assert.equal(await fp.getByTestId('map-confirm-action').count(), 0);
  await fp.screenshot({ path: 'test-results/third-playtest-review-mobile.png', fullPage: true });
  await fp.keyboard.press('Escape');
  const password = review.corners.find(corner => corner.token?.type === 'password');
  assert.ok(password, 'The complete terminal map includes a password token');
  const passwordFloor = await fp.evaluate(async cornerId => {
    const { getLogicalRooms } = await import('/shared/maps.mjs');
    const { cornerRoomId } = await import('/tile.js');
    const tileId = getLogicalRooms().find(room => room.id === cornerRoomId(cornerId)).tileId;
    return window.__secondPlaytest.setup.placements.find(tile => tile.tileId === tileId).floor;
  }, password.id);
  await fp.getByTestId(passwordFloor === -1 ? 'floor-basement' : `floor-${passwordFloor}`).click();
  await fp.locator(`.corner-location[data-corner-id="${password.id}"]`).click();
  assert.equal(await fp.locator('#map-context .map-context-content').innerText(), `密码${password.token.number}`, 'The terminal map result displays the actual single password digit');
});

test('death without a ring requires one living heir and hidden allies can locate one another', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, { death: true });
  const [hp, fp, sp] = pages;
  assert.equal((await snapshot(people[1])).round.inventory.items.some(item => item.id === 'relic_ring'), false);
  await act(people[1], 'silent_reveal', { index: 0 });
  await fp.locator(`#map-positions [data-player-id="${people[1].playerId}"]`).click();
  await fp.locator('.corner-location[data-corner-id="children_cabinet"]').click();
  assert.match(await fp.getByTestId('map-context').innerText(), /确认窥探此角落/);
  await fp.screenshot({ path: 'test-results/third-playtest-map-mobile.png', fullPage: true });
  for (const [viewport, path] of [[{ width: 1366, height: 900 }, 'desktop'], [{ width: 844, height: 390 }, 'landscape']]) {
    await fp.setViewportSize(viewport);
    await fp.waitForFunction(() => {
      const rect = document.getElementById('map-context').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    assert.equal(await fp.getByTestId('map-context').evaluate(panel => panel.matches(':popover-open')), true, `${path}: rotation preserves the open confirmation`);
    await fp.screenshot({ path: `test-results/third-playtest-map-${path}.png` });
  }
  await fp.setViewportSize({ width: 390, height: 844 });
  await fp.keyboard.press('Escape');
  await fp.locator('.corner-location[data-corner-id="children_cabinet"]').click();
  await click(fp, 'peek', () => fp.getByTestId('map-confirm-action').filter({ hasText: '确认窥探' }).click());
  assert.equal((await snapshot(people[1])).round.pendingAction.cornerId, 'children_cabinet');
  assert.equal((await snapshot(people[0])).round.pendingAction.cornerId, undefined);
  assert.equal(await fp.locator(`.map-player-marker[data-player-id="${people[1].playerId}"]`).getAttribute('data-corner-id'), 'children_cabinet');
  await act(people[0], 'resolve_visitor_action');
  await fp.getByTestId('inheritance-target').waitFor();
  assert.equal(await fp.getByTestId('bequeath-none').count(), 0);
  assert.doesNotMatch(await fp.getByTestId('private-resolution').innerText(), /放弃继承|遗物戒指/);
  assert.equal(await hp.locator(`.map-position[data-player-id="${people[1].playerId}"]`).count(), 1);
  assert.equal(await fp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 1);
  assert.equal(await sp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 0);
  for (const page of [hp, fp, sp]) {
    await page.locator(`#map-positions [data-player-id="${people[1].playerId}"]`).click();
    assert.equal(await page.locator(`.map-player-marker[data-player-id="${people[1].playerId}"]`).count(), 1, 'Death and allied positions never duplicate a player marker');
    assert.equal(await page.locator(`.map-player-marker[data-player-id="${people[1].playerId}"]`).getAttribute('data-corner-id'), 'children_cabinet');
    assert.match(await page.getByTestId('death-location-history').innerText(), /死亡位置记录/);
  }
  const stacked = await hp.locator('.map-player-marker[data-corner-id="children_cabinet"]').evaluateAll(markers => markers.map(marker => Number(marker.getAttribute('transform').match(/translate\(([^ ]+)/)[1])));
  assert.equal(stacked.length, 2);
  assert.ok(Math.abs(Math.abs(stacked[1] - stacked[0]) - 7.2) < .001, 'Two colocated actors overlap one third, not completely');
  await fp.getByTestId('inheritance-target').selectOption(people[2].playerId);
  await click(fp, 'bequeath', () => fp.getByTestId('bequeath').click());
  assert.match(await sp.getByTestId('inventory').innerText(), /密码4/);
  assert.doesNotMatch(await sp.getByTestId('inventory').innerText(), /智能手机/);
  const deadInventory = (await snapshot(people[1])).round.inventory;
  assert.deepEqual(deadInventory, { tokens: [], items: [] });
  await mkdir('test-results', { recursive: true });
  await fp.screenshot({ path: 'test-results/second-playtest-ghost-mobile.png', fullPage: true });
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
