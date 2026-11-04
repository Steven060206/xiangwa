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

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function fixture({ slots = [], hand = [], possessions = [] } = {}) {
  return (setup, opening, options) => {
    const play = createPlay(setup, opening, options);
    const tokenIds = () => [...Object.values(play.tokens).filter(Boolean),
      ...Object.values(play.inventories).flatMap(value => value.tokens)].map(piece => piece.id).sort();
    const cardIds = () => [...play.powers.deck, ...play.powers.hand.map(card => card.id),
      ...play.powers.slots.filter(Boolean).map(card => card.id)].map(String).sort();
    const beforeTokens = tokenIds();
    const beforeCards = cardIds();
    // Normalize this trusted midgame hand while preserving every real card.
    const selected = play.powers.hand[0];
    if (selected.id !== 1) {
      const index = play.powers.deck.indexOf(1);
      assert.ok(index >= 0);
      play.powers.deck[index] = selected.id;
      selected.id = 1;
    }
    for (const [visitorIndex, tokenId, cornerId] of possessions) {
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
      assert.ok(source, `The trusted fixture must find the real piece ${tokenId}`);
      if (cornerId && cornerId !== source) [play.tokens[source], play.tokens[cornerId]] = [play.tokens[cornerId], play.tokens[source]];
      const position = cornerId || source;
      play.inventories[play.round.visitors[visitorIndex].id].tokens.push(play.tokens[position]);
      play.tokens[position] = null;
    }
    for (const powerId of [...slots, ...hand]) {
      const handIndex = play.powers.hand.findIndex(card => card.id === powerId);
      let card;
      if (handIndex >= 0) card = play.powers.hand.splice(handIndex, 1)[0];
      else {
        const deckIndex = play.powers.deck.indexOf(powerId);
        assert.notEqual(deckIndex, -1, `The trusted fixture must move the real power ${powerId}`);
        play.powers.deck.splice(deckIndex, 1);
        card = { id: powerId, ignoreThreshold: false };
      }
      if (slots.includes(powerId)) play.powers.slots[slots.indexOf(powerId)] = { ...card, faceUp: false };
      else play.powers.hand.push(card);
    }
    assert.deepEqual(tokenIds(), beforeTokens, 'Fixture only relocates existing pieces');
    assert.deepEqual(cardIds(), beforeCards, 'Fixture only relocates existing cards');
    return play;
  };
}

async function game(t, fixtureOptions, items = ['smartphone', 'deduction', 'walkie_talkie']) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-cards-browser-'));
  const options = { deck, initialItemOrder: items, silentNumbers: [0, 1, 2, 3, 4, 5], dataFile: join(directory, 'rooms.json'), createPlayState: fixture(fixtureOptions) };
  let server = createGameServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [];
  const people = [];
  const errors = [];
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'Browser must not raise runtime errors');
  });
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  async function snapshot(person = people[0]) {
    return request(`/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  }
  async function sync(version) {
    await Promise.all(pages.map(page => page.waitForFunction(expected => window.__hakoLastState?.version >= expected, version)));
  }
  async function act(person, type, values = {}) {
    const result = await request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...values });
    await sync(result.version);
    return result;
  }
  async function click(page, type, trigger) {
    const received = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await received;
    const result = await response.json();
    assert.equal(response.status(), 200, `${type}: ${JSON.stringify(result)}`);
    await sync(result.version);
    return { state: result, payload: response.request().postDataJSON() };
  }
  people.push(await request('/api/rooms', { name: '箱娃' }));
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  assert.deepEqual(state.initialItems.map(choice => choice.itemId), items);
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
  await act(people[0], 'choose_initial_power', { powerId: state.opening.initialPowerOptions.find(card => card.canChoose !== false).id });
  for (let index = 0; index < people.length; index++) {
    const context = await browser.newContext({ viewport: index === 1 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await context.addInitScript(person => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(person));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__hakoLastState = JSON.parse(event.data); });
        }
      };
    }, people[index]);
    const page = await context.newPage();
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), async () => { await page.keyboard.press('Escape'); });
    page.on('pageerror', error => errors.push(error.message));
    pages.push(page);
    await page.goto(`${base}/?room=${people[index].roomCode}`);
    await page.getByTestId('room-code-display').waitFor();
  }
  await sync((await snapshot()).version);
  async function restart() {
    const before = await Promise.all(people.map(snapshot));
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = createGameServer(options);
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    await Promise.all(pages.map(page => page.reload()));
    await Promise.all(pages.map(page => page.getByTestId('room-code-display').waitFor()));
    await sync(before[0].version);
    for (let index = 0; index < people.length; index++) assert.deepEqual((await snapshot(people[index])).round, before[index].round);
  }
  async function moveTurn() {
    let state = await snapshot();
    const person = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    let view = await snapshot(person);
    while (view.round.phase === 'visitor_reveal') {
      const card = view.round.silent.cards.find(card => card.status === 'down');
      view = await act(person, 'silent_reveal', { index: card.index });
    }
    if (view.round.phase === 'visitor_action') {
      await act(person, 'move', { roomId: view.round.moveTargets[0] });
      await act(people[0], 'resolve_visitor_action');
    }
    state = await snapshot();
    if (state.round.phase === 'hako_reaction') state = await act(people[0], 'pass_noise_reaction');
    return state;
  }
  async function finishStage() {
    if ((await snapshot()).round.powers.step === 'preparation') await act(people[0], 'begin_hako_action');
    const state = await snapshot();
    const roomId = state.round.hako.hidingRooms.find(room => room.id === 'children_room')?.id || state.round.hako.hidingRooms[0].id;
    const inspected = await act(people[0], 'inspect_hiding_room', { roomId });
    return act(people[0], 'hako_hide', { cornerId: inspected.round.hako.hidingTargets[0] });
  }
  return { people, pages, snapshot, act, click, restart, moveTurn, finishStage };
}

test('NO7 browser choices protect random-token privacy, preserve free/standard turns and restore stolen property', { timeout: 120000 }, async t => {
  const g = await game(t, { slots: [7], possessions: [[0, 'password_4'], [1, 'password_5'], [2, 'password_6']] });
  const [hako, first] = g.people;
  const [hp, fp, secondPage] = g.pages;
  await fp.getByText('展示、赠送与放置（自由行动）', { exact: true }).click();
  await g.click(fp, 'show_token', () => fp.getByTestId('show-token').click());
  assert.match(await hp.locator('.pending-move').innerText(), /声明展示标志/);
  const declaration = (await g.snapshot(hako)).round.pendingAction;
  assert.deepEqual(Object.keys(declaration).sort(), ['actionType', 'playerId', 'type']);
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  assert.match(await secondPage.getByTestId('shared-token').innerText(), /密码4/);
  assert.equal((await g.snapshot(first)).round.silent.turnPlayerId, first.playerId);
  await fp.getByText('展示、赠送与放置（自由行动）', { exact: true }).click();
  await g.click(fp, 'show_token', () => fp.getByTestId('show-token').click());
  const steal = hp.getByTestId('power-steal-0');
  assert.deepEqual(await steal.locator('option').evaluateAll(options => options.map(option => option.value)), ['item:0', 'token']);
  assert.equal((await steal.innerText()).includes('密码'), false);
  assert.doesNotMatch(await steal.innerText(), /智能手机/);
  await steal.selectOption('item:0');
  const theft = await g.click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="7"]').click());
  assert.equal(theft.payload.stealKind, 'item');
  assert.equal(theft.payload.itemIndex, 0);
  assert.equal(Object.hasOwn(theft.payload, 'itemId'), false);
  assert.match(await hp.getByTestId('power-stolen').innerText(), /智能手机/);
  assert.equal((await g.snapshot(first)).round.phase, 'visitor_reveal');
  for (const person of g.people.slice(1)) assert.equal(Object.hasOwn((await g.snapshot(person)).round.powers, 'stolen'), false);
  for (const page of g.pages.slice(1)) assert.equal(await page.getByTestId('power-stolen').count(), 0);
  await g.restart();
  assert.match(await hp.getByTestId('power-stolen').innerText(), /智能手机/);
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-0').click());
  await g.click(fp, 'move', () => fp.getByTestId('move-target').first().click());
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  while ((await g.snapshot()).round.phase !== 'hako_phase') await g.moveTurn();
  await g.act(hako, 'set_power', { powerId: 7, slot: 0 });
  await g.finishStage();
  const current = (await g.snapshot()).round.silent.turnPlayerId;
  const index = g.people.findIndex(person => person.playerId === current);
  const person = g.people[index];
  const page = g.pages[index];
  await g.click(page, 'silent_reveal', () => page.getByTestId('silent-card-0').click());
  await g.click(page, 'move', () => page.getByTestId('move-target').first().click());
  await hp.getByTestId('power-steal-0').selectOption('token');
  const random = await g.click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="7"]').click());
  assert.equal(random.payload.stealKind, 'token');
  assert.equal(Object.hasOwn(random.payload, 'tokenId'), false);
  assert.match(await hp.getByTestId('power-stolen').innerText(), /密码/);
  const victim = await g.snapshot(person);
  assert.equal(victim.round.silent.turnPlayerId, person.playerId);
  assert.equal(victim.round.phase, 'visitor_action');
  assert.ok(victim.round.inventory.items.some(item => item.id === 'smartphone'), 'Previous stolen card returns to this victim');
  await g.click(page, 'move', () => page.getByTestId('move-target').last().click());
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
});

test('NO8 browser waits until next turn, restores a pending second reveal and keeps the final covered card', { timeout: 120000 }, async t => {
  const g = await game(t, { slots: [8], possessions: [[0, 'doll', 'hall_clock'], [0, 'password_4']] });
  const [hako, first] = g.people;
  const [hp, fp] = g.pages;
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-0').click());
  await fp.getByTestId('active-item-select').selectOption('smartphone');
  await fp.getByTestId('active-item-target').selectOption('hand:0');
  await g.click(fp, 'use_item', () => fp.getByTestId('use-item').click());
  await g.click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="8"]').click());
  let view = await g.snapshot(first);
  assert.equal(view.round.silent.cards.filter(card => card.status === 'up').length, 1, 'Applying NO8 must not reveal another number now');
  assert.equal(view.round.noiseEffects.maryPlayerId, first.playerId);
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  await g.moveTurn();
  await g.moveTurn();
  view = await g.snapshot(first);
  assert.equal(view.round.silent.turnPlayerId, first.playerId);
  await fp.getByText('展示、赠送与放置（自由行动）', { exact: true }).click();
  assert.equal(await fp.locator('[data-testid="gift-item"][data-item-id="doll"]').count(), 0);
  assert.equal(await fp.getByTestId('drop-token-select').locator('option[value="doll"]').count(), 0);
  assert.ok(await fp.getByTestId('drop-token-select').count(), 'A different carried token can still be dropped');
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-3').click());
  assert.equal((await g.snapshot(first)).round.silent.revealsRemaining, 1);
  assert.match(await fp.locator('.practice-status').innerText(), /继续翻开/);
  for (const skip of await fp.locator('.silent-skip').all()) assert.equal(await skip.isDisabled(), true);
  await g.restart();
  assert.equal((await g.snapshot(first)).round.silent.revealsRemaining, 1);
  assert.equal((await g.snapshot(first)).round.noiseEffects.maryPlayerId, first.playerId);
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-4').click());
  view = await g.snapshot(first);
  assert.equal(view.round.phase, 'visitor_action');
  assert.equal(view.round.silent.total, 10);
  assert.equal(view.round.silent.cards.filter(card => card.status === 'down').length, 1);
  assert.equal(await fp.getByTestId('silent-card-5').getAttribute('role'), 'img');
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('test-results', { recursive: true });
  await fp.screenshot({ path: 'test-results/cards-complete-mobile.png', fullPage: true });
  await g.click(fp, 'move', () => fp.getByTestId('move-target').first().click());
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  assert.equal((await g.snapshot(hako)).round.phase, 'hako_phase');
});

test('bell browser rings once, blocks B/C setup while allowing A/ungraded cards and restores next-stage setup', { timeout: 120000 }, async t => {
  const g = await game(t, { hand: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, ['shrine_bell', 'smartphone', 'deduction']);
  const [hako, first] = g.people;
  const [hp, fp] = g.pages;
  await fp.getByTestId('silent-use-bell').check();
  const firstReveal = await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-0').click());
  assert.equal(firstReveal.payload.useBell, true);
  assert.equal(firstReveal.state.round.silent.revealsRemaining, 1);
  assert.equal(await fp.getByTestId('silent-use-bell').count(), 0);
  const nextReveal = await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-1').click());
  assert.equal(Object.hasOwn(nextReveal.payload, 'useBell'), false);
  assert.equal(nextReveal.state.round.noiseEffects.canUseBell, true);
  await fp.getByTestId('active-item-select').selectOption('shrine_bell');
  await g.click(fp, 'use_item', () => fp.getByTestId('use-item').click());
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  assert.equal((await g.snapshot(first)).round.noiseEffects.bellUserId, first.playerId);
  while ((await g.snapshot()).round.phase !== 'hako_phase') await g.moveTurn();
  assert.equal((await g.snapshot(hako)).round.noiseEffects.bellUserId, first.playerId);
  assert.match(await hp.locator('.silent-section').innerText(), /本次箱娃阶段禁止设置危险度B或C/);
  let hand = (await g.snapshot(hako)).round.powers.hand;
  const forbidden = [3, 4, 7, 8, 9, 10];
  const allowed = [1, 2, 5, 6, 11];
  for (const id of forbidden) {
    const card = hand.find(card => card.id === id);
    assert.equal(card.settable, false, `Bell must block setting NO.${id}`);
    assert.match(card.setReason, /铃|危险度/);
    assert.equal(await hp.getByTestId('set-power-select').locator(`option[value="${id}"]`).count(), 0);
  }
  for (const id of allowed) {
    assert.equal(hand.find(card => card.id === id).settable, true, `Bell must permit setting NO.${id}`);
    assert.equal(await hp.getByTestId('set-power-select').locator(`option[value="${id}"]`).count(), 1);
  }
  await hp.getByText(`查看手牌（${hand.length}张）`, { exact: true }).click();
  for (const id of forbidden) assert.match(await hp.locator(`[data-testid="power-hand-card"][data-power-id="${id}"]`).innerText(), /铃|危险度/);
  await g.restart();
  assert.equal((await g.snapshot(hako)).round.noiseEffects.bellUserId, first.playerId);
  await hp.getByTestId('set-power-select').selectOption('11');
  await g.click(hp, 'set_power', () => hp.getByTestId('set-power').click());
  await g.finishStage();
  while ((await g.snapshot()).round.silent.turnPlayerId !== first.playerId) await g.moveTurn();
  assert.equal(await fp.getByTestId('silent-use-bell').isChecked(), false, 'The next turn must require a new explicit bell choice');
  while ((await g.snapshot()).round.phase !== 'hako_phase') await g.moveTurn();
  assert.equal((await g.snapshot(hako)).round.noiseEffects.bellUserId, null);
  hand = (await g.snapshot(hako)).round.powers.hand;
  for (const id of forbidden) {
    assert.equal(hand.find(card => card.id === id).settable, true, `NO.${id} setup must recover at the following stage`);
    assert.equal(await hp.getByTestId('set-power-select').locator(`option[value="${id}"]`).count(), 1);
  }
  await hp.getByTestId('set-power-select').selectOption('3');
  await g.click(hp, 'set_power', () => hp.getByTestId('set-power').click());
  assert.equal((await g.snapshot(hako)).round.powers.slots[1].card.id, 3);
});

test('bell browser still permits recalling C and activating B cards that were already set', { timeout: 120000 }, async t => {
  const g = await game(t, { slots: [3, 4] }, ['shrine_bell', 'smartphone', 'deduction']);
  const [hako] = g.people;
  const [hp, fp] = g.pages;
  await fp.getByTestId('silent-use-bell').check();
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-0').click());
  await g.click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-1').click());
  await fp.getByTestId('active-item-select').selectOption('shrine_bell');
  await g.click(fp, 'use_item', () => fp.getByTestId('use-item').click());
  await g.click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  while ((await g.snapshot()).round.phase !== 'hako_phase') await g.moveTurn();
  assert.equal((await g.snapshot(hako)).round.powers.slots[1].canRecall, true);
  await hp.getByTestId('recall-power-slot').selectOption('1');
  await g.click(hp, 'recall_power', () => hp.getByTestId('recall-power').click());
  assert.equal((await g.snapshot(hako)).round.powers.slots[1].occupied, false);
  await g.click(hp, 'begin_hako_action', () => hp.getByTestId('begin-hako-action').click());
  const activate = hp.locator('[data-testid="activate-power"][data-power-id="3"]');
  assert.equal(await activate.isEnabled(), true);
  await g.click(hp, 'activate_power', () => activate.click());
  assert.ok((await g.snapshot(hako)).round.blockedDoors.length > 0);
  assert.equal((await g.snapshot(hako)).round.powers.slots[0].occupied, false);
  await g.finishStage();
});
