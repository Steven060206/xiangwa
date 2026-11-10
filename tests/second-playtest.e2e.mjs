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

async function game(t, { death = false, fixture, draftItems = ['smartphone', 'walkie_talkie', 'deduction'] } = {}) {
  const server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5],
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
        play.tokens.study_desk = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
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
  for (const itemId of draftItems) {
    state = await act(people.find(person => person.playerId === state.draft.turnPlayerId), 'choose_item', { itemId });
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
  const powerId = state.opening.initialPowerOptions[0].id;
  await act(people[0], 'choose_initial_power', { powerId });
  assert.match(await pages[0].getByTestId('initial-power').textContent(), new RegExp(`NO\\.${powerId} `));
  return { people, pages, act, snapshot, click, sync };
}

test('second playtest shows owned items privately, preserves the safe landmark and reveals a complete terminal review', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t);
  const [hp, fp, sp] = pages;
  assert.match(await fp.getByTestId('item-private-result').innerText(), /NO\.4 动来动去/);
  assert.equal(await hp.getByTestId('item-private-result').count(), 0);
  assert.match(await fp.getByTestId('power-cry-count').innerText(), /累计哭喊 7 次.*第10次哭喊保底/);
  assert.match(await fp.getByTestId('total-rounds').innerText(), /0/);
  assert.match(await hp.getByTestId('power-delayed-death').innerText(), /NO\.5 我在你身后.*下一箱娃阶段开始时/);
  assert.equal(await fp.getByTestId('power-delayed-death').count(), 0);
  assert.equal(await sp.getByTestId('power-delayed-death').count(), 0);
  assert.match(await fp.getByTestId('inventory').innerText(), /白木椿/);
  assert.doesNotMatch(await fp.getByTestId('inventory').innerText(), /白木棒/);
  assert.equal(await fp.getByTestId('safe-landmark').count(), 1, 'Opened safe landmark remains after its corner receives a different piece');
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
});

test('death without a ring requires one living heir and hidden allies can locate one another', { timeout: 90000 }, async t => {
  const { people, pages, act, snapshot, click } = await game(t, { death: true });
  const [hp, fp, sp] = pages;
  assert.equal((await snapshot(people[1])).round.inventory.items.some(item => item.id === 'relic_ring'), false);
  await act(people[1], 'silent_reveal', { index: 0 });
  await act(people[1], 'peek', { cornerId: 'children_cabinet' });
  await act(people[0], 'resolve_visitor_action');
  await fp.getByTestId('inheritance-target').waitFor();
  assert.equal(await fp.getByTestId('bequeath-none').count(), 0);
  assert.doesNotMatch(await fp.getByTestId('private-resolution').innerText(), /放弃继承|遗物戒指/);
  assert.equal(await hp.locator(`.map-position[data-player-id="${people[1].playerId}"]`).count(), 1);
  assert.equal(await fp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 1);
  assert.equal(await sp.locator(`.map-position[data-player-id="${people[0].playerId}"]`).count(), 0);
  await fp.getByTestId('inheritance-target').selectOption(people[2].playerId);
  await click(fp, 'bequeath', () => fp.getByTestId('bequeath').click());
  assert.match(await sp.getByTestId('inventory').innerText(), /密码4/);
  assert.match(await sp.getByTestId('inventory').innerText(), /智能手机/);
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
  await act(people[0], 'pass_noise_reaction');
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
  await act(people[0], 'pass_noise_reaction');
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
  assert.equal(await hp.getByTestId('pass-noise-reaction').isDisabled(), true);
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
    assert.equal(state.round.phase, 'hako_reaction');
    await click(hp, 'pass_noise_reaction', () => hp.getByTestId('pass-noise-reaction').click());
    await act(people[0], 'begin_hako_action');
    await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="5"]').click());
    assert.equal((await snapshot(people[1])).round.interruption, null);
    assert.equal(await fp.getByTestId('extinguisher-response').count(), 0,
      'Holding the extinguisher does not reopen a response when NO.5 activates');
    assert.equal((await snapshot(people[1])).round.inventory.tokens.some(token => token.type === 'extinguisher'), true);
  }
});
