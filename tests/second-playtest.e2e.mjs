import { openGamePane, locateSeat } from './game-navigation.mjs';
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

async function game(t, { death = false, fixture, playerCount = 4, draftItems = ['smartphone', 'walkie_talkie', 'deduction'] } = {}) {
  const server = createGameServer({ deck, initialItemOrder: draftItems, silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      if (fixture) { fixture(play, setup); return play; }
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
  const people = [await request('/api/rooms', { name: '箱娃守夜人', playerCount })];
  const visitors = ['访问者小满', '访问者青禾', '访问者阿照', '访问者远山'].slice(0, playerCount - 1);
  for (const name of visitors) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
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
  assert.deepEqual(state.initialItems.map(choice => choice.itemId), draftItems);
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
    const context = await browser.newContext({ viewport: index === 1 ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      ...(index === 1 ? { isMobile: true, hasTouch: true } : {}) });
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
  assert.match(await hp.getByTestId('power-delayed-death').innerText(), /NO\.5 我在你身后.*下一箱娃阶段开始时/);
  assert.equal(await fp.getByTestId('power-delayed-death').count(), 0);
  assert.equal(await sp.getByTestId('power-delayed-death').count(), 0);
  assert.match(await fp.getByTestId('inventory').innerText(), /白木椿/);
  assert.doesNotMatch(await fp.getByTestId('inventory').innerText(), /白木棒/);
  assert.equal(await fp.getByTestId('safe-landmark').count(), 1, 'Opened safe landmark remains after its corner receives a different piece');
  assert.equal(await fp.getByTestId('public-empty-box').count(), 1, 'The public face-up X is visible on the actual map');
  assert.equal(await fp.getByTestId('public-empty-box').getAttribute('data-corner-id'), 'study_desk');
  assert.equal(await fp.locator('.corner-location[data-token-type]').count(), 0, 'Hidden corner tokens are not rendered before the terminal review');
  assert.match(await fp.getByTestId('safe-public-status').innerText(), /已打开/);
  await openGamePane(hp, 'inventory');
  assert.equal(await hp.locator('#inventory-pane [data-testid="hiding-room-memory"]').isVisible(), true, 'Only the owner can read the remembered piece in their own pane');
  await openGamePane(fp, 'inventory');
  const cornerSize = await fp.locator('.corner-mark').first().getAttribute('width');
  assert.equal(cornerSize, '14');
  assert.ok(Number(await fp.locator('.corner-hit-area').first().getAttribute('width')) >= 36,
    'The touch hit area is larger than the visible corner marker');
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
  await openGamePane(fp, 'action');
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
  const ended = await snapshot(people[1]);
  const review = ended.round.review;
  const tabs = fp.getByTestId('game-review').getByRole('tablist');
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(), ['盘面', '玩家物品', '箱娃能力', '行动记录']);
  assert.equal(await tabs.getByRole('tab', { name: '盘面', selected: true }).count(), 1);
  assert.equal(await fp.getByRole('tabpanel').count(), 1);
  assert.equal(await fp.getByTestId('review-inventory').count(), 0);
  const requests = [];
  fp.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) requests.push(request.postDataJSON().type);
  });
  const listed = [];
  for (const floor of ['1', '2', '-1']) {
    await fp.getByTestId('review-floor').selectOption(floor);
    const roomIds = await fp.getByTestId('review-room').locator('option').evaluateAll(options => options.map(option => option.value));
    for (const roomId of roomIds) {
      await fp.getByTestId('review-room').selectOption(roomId);
      const rows = await fp.getByTestId('review-corner').evaluateAll(rows => rows.map(row => ({
        id: row.dataset.cornerId, name: row.querySelector('dd').firstChild.textContent,
      })));
      assert.deepEqual(rows, review.corners.filter(corner => corner.roomId === roomId)
        .map(corner => ({ id: corner.id, name: corner.token?.name || '空角落' })));
      listed.push(...rows.map(row => row.id));
    }
  }
  assert.deepEqual(listed.sort(), review.corners.map(corner => corner.id).sort());
  await tabs.getByRole('tab', { name: '盘面' }).focus();
  await fp.keyboard.press('ArrowRight');
  assert.equal(await tabs.getByRole('tab', { name: '玩家物品', selected: true }).count(), 1);
  const picker = fp.getByTestId('review-player');
  assert.deepEqual(await picker.locator('option').evaluateAll(options => options.map(option => option.value)),
    [...ended.players].sort((left, right) => left.seat - right.seat).map(player => player.id));
  for (const inventory of review.inventories) {
    await picker.selectOption(inventory.playerId);
    const player = fp.getByTestId('review-inventory');
    assert.equal(await player.getAttribute('data-player-id'), inventory.playerId);
    const text = await player.innerText();
    for (const possession of [...inventory.tokens, ...inventory.items]) assert.ok(text.includes(possession.name));
  }
  assert.match(await fp.getByTestId('review-items').innerText(), /已消耗或移出的标志\s+转轮式保险箱/);
  await tabs.getByRole('tab', { name: '箱娃能力' }).click();
  const powers = await fp.getByTestId('review-powers').innerText();
  assert.match(powers, /NO\.1 /);
  assert.match(powers, /NO\.11 /);
  assert.match(powers, /已移出游戏\s+NO\.12 天旋地转/);
  assert.match(powers, /已使用的能力记录\s+NO\.11 虚假的哭喊/);
  assert.match(powers, /保险箱密码/);
  assert.match(powers, /汽油/);
  assert.deepEqual(await fp.locator('#review-powers .review-deck li').allTextContents(),
    review.powers.deck.map(card => card.id === 'despair' ? card.name : `NO.${card.id} ${card.name}`));
  await tabs.getByRole('tab', { name: '行动记录' }).click();
  assert.deepEqual(await fp.locator('#review-log .review-log-list li').allTextContents(), ended.log);
  await fp.keyboard.press('Home');
  assert.equal(await tabs.getByRole('tab', { name: '盘面', selected: true }).count(), 1);
  await fp.getByTestId('review-floor').selectOption('1');
  await fp.getByTestId('review-room').selectOption('study_room');
  await fp.getByTestId('review-map-target').filter({ hasText: '写字台下' }).click();
  assert.equal(await fp.locator('#setup-view').getAttribute('data-panel'), 'map');
  assert.match(await fp.getByTestId('map-context').innerText(), /写字台下[\s\S]*空箱/);
  assert.equal(await fp.getByTestId('map-confirm-action').count(), 0);
  await fp.getByRole('button', { name: '返回终局盘面', exact: true }).click();
  assert.equal(await fp.getByTestId('review-room').inputValue(), 'study_room');
  assert.equal(await fp.evaluate(() => document.activeElement.id), 'review-corner-study_desk');
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await fp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 1, 'Terminal review exposes the Hako position to visitors');
  await fp.locator('#game-navigation [data-view="map"]').click();
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
  assert.deepEqual(requests, [], 'Reading the entire terminal review sends no game action');
});

test('a five-seat terminal review keeps the fifth inventory, ghost storage, removed skills and death history navigable', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot } = await game(t, { playerCount: 5,
    draftItems: ['smartphone', 'walkie_talkie', 'deduction', 'night_vision'],
    fixture(play) { play.round.visitors[0].roomId = 'children_room'; },
  });
  const [hako, first] = people;
  const phone = pages[1];
  await act(first, 'silent_reveal', { index: 0 });
  await act(first, 'peek', { cornerId: 'children_cabinet' });
  await act(hako, 'resolve_visitor_action');
  for (const survivor of people.slice(2)) await act(survivor, 'surrender', { agree: true });
  const ended = await snapshot(first);
  const review = ended.round.review;
  const summary = await phone.getByTestId('game-result').innerText();
  assert.ok(ended.round.result.winners.every(id => summary.includes(ended.players.find(player => player.id === id).name)));
  assert.match(summary, /访问者全体投降/);
  const tabs = phone.getByTestId('game-review').getByRole('tablist');
  await tabs.getByRole('tab', { name: '玩家物品' }).click();
  const player = phone.getByTestId('review-player');
  assert.equal(await player.locator('option').count(), 5);
  assert.match(await player.locator('option').last().textContent(), /5号座.*远山/);
  await player.selectOption(people[4].playerId);
  assert.match(await phone.getByTestId('review-inventory').innerText(), /远山.*访问者[\s\S]*夜视仪/);
  await player.selectOption(first.playerId);
  assert.match(await phone.getByTestId('review-inventory').innerText(), /小满.*箱人[\s\S]*暂存于/);
  assert.match(await phone.getByTestId('review-items').innerText(), /死亡后移出的技能牌\s+智能手机/);
  await tabs.getByRole('tab', { name: '盘面' }).click();
  const placement = ended.setup.placements.find(placement => placement.tileId === 'children');
  await phone.getByTestId('review-floor').selectOption(String(placement.floor));
  await phone.getByTestId('review-room').selectOption('children_room');
  const corner = phone.getByTestId('review-corner').filter({ has: phone.locator('[data-corner-id="children_cabinet"]') });
  assert.match(await corner.innerText(), /箱娃守夜人（箱娃）[\s\S]*访问者小满（箱人）/);
  const actual = review.corners.find(corner => corner.id === 'children_cabinet');
  if (actual.underToken) assert.ok((await corner.innerText()).includes(actual.underToken.name));
  await tabs.getByRole('tab', { name: '行动记录' }).click();
  await phone.getByTestId('review-log-target').click();
  assert.match(await phone.getByTestId('map-context').innerText(), /小满.*在此死亡/);
  assert.equal(await phone.getByTestId('map-confirm-action').count(), 0);
  await phone.getByRole('button', { name: '返回行动记录', exact: true }).click();
  assert.equal(await tabs.getByRole('tab', { name: '行动记录', selected: true }).count(), 1);
  assert.equal(await phone.evaluate(() => document.activeElement.id), 'review-location-death-0');
  assert.equal((await snapshot(first)).version, ended.version);
});

test('publishing a peek shows the numbered discovery location in the event, history and map', { timeout: 90000 }, async t => {
  const { people, pages, act, click, snapshot } = await game(t, { fixture(play) {
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'password');
    [play.tokens.study_books, play.tokens[source]] = [play.tokens[source], play.tokens.study_books];
    const [first, second] = play.round.visitors;
    first.roomId = second.roomId = 'study_room';
    for (const [corner, token] of Object.entries(play.tokens).filter(([, value]) => value?.type === 'weapon').slice(0, 2)) {
      play.inventories[second.id].tokens.push(token);
      play.tokens[corner] = null;
    }
  } });
  const [hako, visitor, second] = people;
  const [, phone, observer] = pages;
  const location = '02 · 书房 · 装满书的架子旁';
  const nav = (page, view) => page.locator(`#game-navigation [data-view="${view}"]`).click();
  const checkHistoryMap = async page => {
    assert.equal(await page.locator('#setup-view').getAttribute('data-panel'), 'map');
    assert.equal(await page.locator('#board-section').isVisible(), true);
    assert.equal(await page.locator('#tile-board .selected-corner').getAttribute('data-corner-id'), 'study_books');
    assert.equal(await page.locator('#map-context-title').innerText(), location);
    assert.match(await page.getByTestId('map-context').innerText(), /访问者小满曾在此发现密码/);
    assert.equal(await page.getByTestId('map-confirm-action').count(), 0);
  };
  await act(visitor, 'silent_reveal', { index: 0 });
  await act(visitor, 'peek', { cornerId: 'study_books' });
  await act(hako, 'resolve_visitor_action');
  assert.equal(await observer.getByTestId('public-discoveries').count(), 0);
  await nav(observer, 'chat');
  await observer.getByTestId('chat-text').fill('消息草稿');
  const publish = phone.getByTestId('publish-peek-token');
  assert.match(await publish.innerText(), /02号位置/);
  await click(phone, 'publish_token', () => publish.click());
  assert.equal(await observer.locator('#event-dialog[open]').count(), 0);
  assert.equal(await observer.evaluate(() => document.activeElement.id), 'chat-text');
  assert.equal(await observer.getByTestId('chat-text').inputValue(), '消息草稿');
  assert.ok((await observer.getByTestId('discovery-banner').innerText()).includes(location));
  assert.match(await phone.locator('#event-dialog[open] #event-body').innerText(), /发现时的位置/);
  for (const page of pages) {
    assert.equal(await page.getByTestId('discovery-map-target').textContent(), `发现时的位置 · ${location}`);
  }
  await observer.getByTestId('discovery-banner-locate').click();
  await checkHistoryMap(observer);
  await observer.keyboard.press('Escape');
  assert.equal(await observer.locator('#setup-view').getAttribute('data-panel'), 'chat');
  assert.equal(await observer.getByTestId('discovery-banner-locate').evaluate(button => document.activeElement === button), true);
  assert.equal(await observer.getByTestId('chat-text').inputValue(), '消息草稿');

  await act(visitor, 'resolve_peek', { take: true, replacement: 'empty_box' });
  await phone.reload();
  await nav(phone, 'public');
  const publicLink = phone.getByTestId('discovery-map-target');
  await publicLink.scrollIntoViewIfNeeded();
  const phoneScroll = await phone.locator('.setup-sidebar').evaluate(panel => panel.scrollTop);
  await publicLink.tap();
  await checkHistoryMap(phone);
  await phone.getByRole('button', { name: '返回公开记录' }).tap();
  assert.equal(await phone.locator('#public-pane').isVisible(), true);
  assert.equal(await publicLink.evaluate(button => document.activeElement === button), true);
  assert.equal(await phone.locator('.setup-sidebar').evaluate(panel => panel.scrollTop), phoneScroll);

  await act(second, 'silent_reveal', { index: 1 });
  await nav(observer, 'action');
  await observer.getByTestId('action-categories').getByRole('link', { name: '讨伐' }).click();
  const weapon = observer.getByTestId('weapon-select');
  const weaponId = await weapon.locator('option').last().getAttribute('value');
  await weapon.selectOption(weaponId);
  const target = observer.getByTestId('weapon-corner-select');
  await target.selectOption('dark_bed');
  await observer.locator('#map-focus').click();
  await observer.getByTestId('floor-2').click();
  await nav(observer, 'inventory');
  await observer.getByTestId('event-history-toggle').click();
  const history = observer.getByTestId('event-history');
  const historical = history.locator('li').filter({ hasText: /访问者小满公开了密码/ });
  const historyLocate = historical.getByTestId('history-locate');
  await historyLocate.scrollIntoViewIfNeeded();
  const historyScroll = await history.evaluate(panel => panel.scrollTop);
  const version = (await snapshot(second)).version;
  const actions = [];
  observer.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/actions')) actions.push(req.postDataJSON()?.type);
  });
  await historyLocate.click();
  await checkHistoryMap(observer);
  const guide = observer.getByTestId('corner-guide-toggle');
  await guide.click();
  const guideCorner = observer.locator('.corner-guide-entry[data-corner-id="study_desk"] button');
  await guideCorner.focus();
  await observer.keyboard.press('Enter');
  assert.match(await observer.locator('#map-context-title').innerText(), /写字台下/);
  assert.equal(await observer.getByTestId('map-confirm-action').count(), 0);
  await act(visitor, 'chat_send', { text: '保留阅读位置', channelKind: 'room', roomId: 'study_room' });
  await observer.waitForFunction(() => window.__secondPlaytest.chat.messages.some(message => message.text === '保留阅读位置'));
  assert.equal(await observer.getByTestId('map-confirm-action').count(), 0);
  await observer.getByRole('button', { name: '返回事件记录' }).click();
  assert.equal(await observer.locator('#inventory-pane').isVisible(), true);
  assert.equal(await history.isVisible(), true);
  assert.equal(await historyLocate.evaluate(button => document.activeElement === button), true);
  assert.equal(await history.evaluate(panel => panel.scrollTop), historyScroll);
  await observer.removeLocatorHandler(observer.locator('#event-dialog[open]'));
  const historyCard = historical.locator('.event-history-entry');
  await historyCard.click();
  const eventTitle = await observer.getByTestId('event-title').innerText();
  await observer.getByTestId('event-locate').click();
  await checkHistoryMap(observer);
  await observer.keyboard.press('Escape');
  assert.equal(await observer.locator('#event-dialog[open]').isVisible(), true);
  assert.equal(await observer.getByTestId('event-title').innerText(), eventTitle);
  assert.equal(await observer.getByTestId('event-locate').evaluate(button => document.activeElement === button), true);
  await observer.keyboard.press('Escape');
  assert.equal(await history.isVisible(), true);
  assert.equal(await historyCard.evaluate(button => document.activeElement === button), true);
  await observer.keyboard.press('Escape');
  await observer.locator('#map-focus').click();
  assert.equal(await observer.getByTestId('floor-2').getAttribute('aria-selected'), 'true');
  await observer.getByTestId('floor-1').click();
  assert.equal(await observer.locator('#tile-board .selected-corner').getAttribute('data-corner-id'), 'dark_bed');
  assert.equal(await target.inputValue(), 'dark_bed');
  assert.equal(await weapon.inputValue(), weaponId);
  await guide.click();
  await guideCorner.click();
  assert.match(await observer.getByTestId('map-context').innerText(), /确认窥探此角落/);
  assert.match(await observer.getByTestId('map-context').innerText(), /确认讨伐此角落/);
  assert.equal((await snapshot(second)).version, version);
  assert.deepEqual(actions, []);
});

test('death without a ring requires one living heir and hidden allies can locate one another', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, { death: true });
  const [hp, fp, sp] = pages;
  assert.equal((await snapshot(people[1])).round.inventory.items.some(item => item.id === 'relic_ring'), false);
  await act(people[1], 'silent_reveal', { index: 0 });
  await fp.locator('#game-navigation [data-view="map"]').click();
  await locateSeat(fp, people[1].playerId);
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
  await fp.locator('#game-navigation [data-view="action"]').click();
  await fp.getByTestId('inheritance-target').waitFor();
  assert.equal(await fp.getByTestId('bequeath-none').count(), 0);
  assert.doesNotMatch(await fp.getByTestId('private-resolution').innerText(), /放弃继承|遗物戒指/);
  assert.equal(await hp.locator(`.map-position[data-player-id="${people[1].playerId}"]`).count(), 1);
  assert.equal(await fp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 1);
  assert.equal(await sp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 0);
  for (const page of [hp, fp, sp]) {
    await openGamePane(page, 'map');
    await locateSeat(page, people[1].playerId);
    assert.equal(await page.locator(`.map-player-marker[data-player-id="${people[1].playerId}"]`).count(), 1, 'Death and allied positions never duplicate a player marker');
    assert.equal(await page.locator(`.map-player-marker[data-player-id="${people[1].playerId}"]`).getAttribute('data-corner-id'), 'children_cabinet');
    assert.match(await page.getByTestId('death-location-history').innerText(), /死亡位置记录/);
  }
  const stacked = await hp.locator('.map-player-marker[data-corner-id="children_cabinet"]').evaluateAll(markers => markers.map(marker => Number(marker.getAttribute('transform').match(/translate\(([^ ]+)/)[1])));
  assert.equal(stacked.length, 2);
  assert.ok(Math.abs(Math.abs(stacked[1] - stacked[0]) - 7.2) < .001, 'Two colocated actors overlap one third, not completely');
  await fp.locator('#game-navigation [data-view="action"]').click();
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

function nearOverflow(play) {
  play.round.silent.total = 9;
  for (const card of play.round.silent.cards) card.status = card.number >= 4 ? 'up' : 'down';
}

function givePower(play, id, slot) {
  play.powers.hand = play.powers.hand.filter(card => card.id !== id);
  play.powers.deck = play.powers.deck.filter(cardId => cardId !== id);
  play.powers.slots[slot] = { id, ignoreThreshold: true, faceUp: false };
}

function giveExtinguisher(play, playerId) {
  const source = Object.keys(play.tokens).find(corner => play.tokens[corner]?.type === 'extinguisher');
  assert.ok(source, 'The fixture relocates the one real extinguisher');
  play.inventories[playerId].tokens.push(play.tokens[source]);
  play.tokens[source] = null;
}

test('silent door and rearrangement powers empty their slots without names, notices or a publication control', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, { fixture(play, setup) {
    nearOverflow(play);
    givePower(play, 3, 0);
    givePower(play, 4, 1);
    giveExtinguisher(play, setup.visitorIds[1]);
  } });
  const [hp, fp, sp] = pages;
  await act(people[1], 'silent_reveal', { index: 2 });
  for (const page of pages) assert.equal(await page.getByTestId('extinguisher-response').count(), 0,
    'The holder cannot respond to another visitor\'s overflow');
  assert.equal((await snapshot(people[2])).round.inventory.tokens.some(token => token.type === 'extinguisher'), true);
  assert.equal((await snapshot(people[0])).round.phase, 'hako_phase');
  await click(hp, 'begin_hako_action', () => hp.getByTestId('begin-hako-action').click());
  assert.equal(await hp.locator('[id^="power-public-"]').count(), 0);
  await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="3"]').click());
  const beforeRearrange = (await snapshot(people[1])).round.cornerState;
  await hp.getByTestId('power-room-1').selectOption('study_room');
  await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="4"]').click());
  assert.equal(await hp.getByTestId('power-rearrangement').count(), 1);
  for (const page of [fp, sp]) {
    assert.equal(await page.getByTestId('power-rearrangement').count(), 0);
    assert.equal(await page.getByTestId('power-last-activation').count(), 0);
    for (const slot of [0, 1]) assert.match(await page.locator(`[data-testid="power-slot"][data-slot="${slot}"]`).textContent(), /空栏/);
    assert.doesNotMatch(await page.locator('#practice-panel').textContent(), /NO\.[34]|打不开的门|动来动去/);
    assert.doesNotMatch(await page.locator('#event-history-list').textContent(), /箱娃发动了|打不开的门|动来动去/);
  }
  assert.deepEqual((await snapshot(people[1])).round.cornerState, beforeRearrange,
    'The secret rearrangement does not change a visitor\'s frozen board snapshot');
  await click(hp, 'power_rearrange', () => hp.getByTestId('power-rearrange-submit').click());
  assert.equal((await snapshot(people[1])).round.powers.activationNotice, null);
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('anonymous stage activation and truthful or false passive answers announce without revealing the source', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, {
    draftItems: ['spirit_pen', 'dowsing_rod', 'deduction'],
    fixture(play) { nearOverflow(play); givePower(play, 5, 0); givePower(play, 9, 1); },
  });
  const [hp, fp, sp] = pages;
  await act(people[1], 'silent_reveal', { index: 2 });
  assert.equal((await snapshot(people[0])).round.phase, 'hako_phase');
  await act(people[0], 'begin_hako_action');
  await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="5"]').click());
  for (const page of [fp, sp]) {
    assert.equal(await page.getByTestId('power-last-activation').textContent(), '箱娃发动了能力。');
    assert.equal(await page.getByTestId('power-delayed-death').count(), 0);
    assert.doesNotMatch(await page.locator('#practice-panel').textContent(), /NO\.[59]|我在你身后|虚假的回应/);
    assert.equal(await page.locator('#event-history-list strong').filter({ hasText: '箱娃发动了能力' }).count(), 1);
  }
  await act(people[0], 'inspect_hiding_room', { roomId: 'children_room' });
  await act(people[0], 'hako_hide', { cornerId: 'children_cabinet' });
  const questions = [
    { item: { itemId: 'spirit_pen', roomId: 'hall_room' }, truth: false, answer: false },
    { item: { itemId: 'dowsing_rod' }, truth: 1, answer: 2 },
  ];
  for (const [index, { item, truth, answer }] of questions.entries()) {
    await act(people[index + 1], 'silent_reveal', { index });
    await act(people[index + 1], 'use_item', item);
    await act(people[0], 'resolve_visitor_action');
    assert.equal((await snapshot(people[0])).round.resolution.truth, truth);
    await hp.getByTestId('item-answer-select').selectOption(JSON.stringify(answer));
    await click(hp, 'answer_item', () => hp.getByTestId('answer-item').click());
    const count = index + 2;
    for (const page of [fp, sp]) {
      assert.equal(await page.locator('#event-history-list strong').filter({ hasText: '箱娃发动了能力' }).count(), count);
      assert.doesNotMatch(await page.locator('#event-history-list').textContent(), /NO\.9|虚假的回应/);
    }
    assert.equal((await snapshot(people[1])).round.powers.activationNotice.serial, count);
  }
  await fp.reload();
  await fp.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.equal(await fp.locator('#event-dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await fp.locator('#event-history-list strong').count(), 0, 'Refresh quietly establishes the existing notice serial');
});

for (const use of [true, false]) test(`mobile overflow owner can ${use ? 'use' : 'pass'} the extinguisher before the stage`, { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, { fixture(play, setup) {
    nearOverflow(play);
    giveExtinguisher(play, setup.visitorIds[0]);
    givePower(play, 5, 0);
  } });
  const [hp, fp, sp] = pages;
  await click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-2').tap());
  assert.equal(await fp.getByTestId('extinguisher-response').count(), 1);
  for (const page of [hp, sp]) assert.equal(await page.getByTestId('extinguisher-response').count(), 0);
  assert.match(await fp.getByTestId('extinguisher-response').textContent(), /你翻出的无声数字使累计超过10/);
  assert.equal(await hp.getByTestId('pass-noise-reaction').count(), 0, 'Hako cannot advance during the visitor’s response window');
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await click(fp, 'extinguisher_response', () => fp.getByTestId(use ? 'extinguisher-use' : 'extinguisher-pass').tap());
  const state = await snapshot(people[1]);
  assert.equal(state.round.interruption, null);
  assert.equal(state.round.inventory.tokens.some(token => token.type === 'extinguisher'), !use);
  if (use) {
    assert.equal(state.round.phase, 'visitor_reveal');
    assert.equal(state.round.silent.turnPlayerId, people[1].playerId);
    assert.equal(state.round.silent.cycle, 2);
  } else {
    assert.equal(state.round.phase, 'hako_phase');
    assert.equal(await hp.getByTestId('pass-noise-reaction').count(), 0);
    await act(people[0], 'begin_hako_action');
    await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="5"]').click());
    assert.equal((await snapshot(people[1])).round.interruption, null);
    assert.equal(await fp.getByTestId('extinguisher-response').count(), 0,
      'Holding the extinguisher does not reopen a response when NO.5 activates');
    assert.equal((await snapshot(people[1])).round.inventory.tokens.some(token => token.type === 'extinguisher'), true);
  }
});
