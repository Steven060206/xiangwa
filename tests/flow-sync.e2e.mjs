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
const nav = (page, view) => page.locator(`#game-navigation [data-view="${view}"]`).click();
const checkedNumbers = (page, testid) => page.getByTestId(testid).evaluateAll(inputs => inputs.filter(input => input.checked).map(input => Number(input.value)));
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const stepKey = page => page.evaluate(async () => (await import('/view-state.js')).stepKey(window.__flowState));

function fixture({ roomId = 'bathroom_room', power4 = false } = {}) {
  return (setup, opening, options) => {
    const play = createPlay(setup, opening, options);
    const pieces = () => [...Object.values(play.tokens).filter(Boolean), ...Object.values(play.inventories).flatMap(held => held.tokens)].map(piece => piece.id).sort();
    const cards = () => [...play.powers.deck, ...play.powers.hand.map(card => card.id), ...play.powers.slots.filter(Boolean).map(card => card.id)].map(String).sort();
    const beforePieces = pieces(), beforeCards = cards();
    const move = (tokenId, cornerId) => {
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
      assert.ok(source, `Fixture relocates the existing piece ${tokenId}`);
      [play.tokens[source], play.tokens[cornerId]] = [play.tokens[cornerId], play.tokens[source]];
    };
    move('notebook_2', 'bathroom_toilet');
    move('password_2', 'bathroom_washer');
    const heldSource = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_4');
    assert.ok(heldSource);
    play.inventories[play.round.visitors[0].id].tokens.push(play.tokens[heldSource]);
    play.tokens[heldSource] = null;
    play.round.visitors[0].roomId = roomId;
    play.round.visitors[1].roomId = roomId;
    if (power4) {
      const inHand = play.powers.hand.findIndex(card => card.id === 4);
      if (inHand >= 0) play.powers.slots[0] = { ...play.powers.hand.splice(inHand, 1)[0], faceUp: false };
      else {
        const index = play.powers.deck.indexOf(4);
        assert.ok(index >= 0);
        play.powers.deck.splice(index, 1);
        play.powers.slots[0] = { id: 4, ignoreThreshold: false, faceUp: false };
      }
    }
    assert.deepEqual(pieces(), beforePieces, 'Fixture preserves every real token');
    assert.deepEqual(cards(), beforeCards, 'Fixture preserves every real ability card');
    return play;
  };
}

async function session(t, options = {}) {
  const initialItemOrder = options.items || ['night_vision', 'stethoscope', 'walkie_talkie'];
  const server = createGameServer({ deck, initialItemOrder, silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState: fixture(options) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [], errors = [];
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'Flow synchronization raises no browser errors');
  });
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const people = [await request('/api/rooms', { name: '箱娃' })];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  async function sync(version) {
    await Promise.all(pages.map(async page => {
      await page.waitForFunction(expected => window.__flowState?.version >= expected, version);
      await frame(page);
    }));
  }
  async function act(person, type, payload = {}) {
    const state = await request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...payload });
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
    return { state, payload: response.request().postDataJSON() };
  }
  async function open(person, mode = 'sse') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (response.ok && new URL(response.url).pathname.startsWith('/api/rooms')) {
          try {
            const body = await response.clone().json();
            const state = body.state || body;
            if (Number.isInteger(state.version) && (!window.__flowState || state.version >= window.__flowState.version)) window.__flowState = state;
          } catch { /* Unknown action results are recovered by the application. */ }
        }
        return response;
      };
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__flowState = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), () => page.keyboard.press('Escape'));
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}${mode === 'poll' ? '&sync=poll' : ''}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    await frame(page);
    return page;
  }
  async function chat(person, text) {
    const current = await snapshot(person);
    const channel = current.chat.channel;
    const result = await act(person, 'chat_send', { text, channelKind: channel.kind, roomId: channel.roomId });
    await Promise.all(pages.map(page => page.waitForFunction(revision => window.__flowState?.chat.revision >= revision, result.chat.revision)));
    await Promise.all(pages.map(frame));
  }
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  assert.equal(state.phase, 'map_setup');
  assert.deepEqual(state.initialItems.map(choice => choice.itemId), initialItemOrder);
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  await act(people[0], 'prepare_opening');
  async function finishOpening({ secrets = true } = {}) {
    if (secrets) await act(people[0], 'choose_secrets', { password: [1, 3, 6], weakness: 'gasoline' });
    await act(people[0], 'place_remains', { cornerId: 'living_sofa' });
    await act(people[0], 'inspect_initial_room', { roomId: 'children_room' });
    state = await act(people[0], 'choose_initial_hiding', { cornerId: 'children_cabinet' });
    return act(people[0], 'choose_initial_power', { powerId: state.opening.initialPowerOptions.find(card => card.canChoose !== false).id });
  }
  return { people, act, snapshot, click, open, chat, finishOpening };
}

for (const mode of ['sse', 'poll']) {
  test(`${mode}: presence and chat preserve password and gift payloads; leaving a peek submits once`, { timeout: 120000 }, async t => {
    const game = await session(t);
    const { people: [hako, first, second], act, snapshot, click, open, chat } = game;
    const hp = await open(hako, mode);
    for (const value of [1, 3, 6]) await hp.locator(`[data-testid="password-choice"][value="${value}"]`).check();
    await hp.getByTestId('weakness-select').selectOption('gasoline');
    const fp = await open(first, mode);
    await hp.waitForFunction(id => window.__flowState.players.find(player => player.id === id)?.connected, first.playerId);
    await frame(hp);
    assert.deepEqual(await checkedNumbers(hp, 'password-choice'), [1, 3, 6]);
    assert.equal(await hp.getByTestId('confirm-secrets').isEnabled(), true);
    const secrets = await click(hp, 'choose_secrets', () => hp.getByTestId('confirm-secrets').click());
    assert.deepEqual(secrets.payload.password, [1, 3, 6]);
    assert.equal(secrets.payload.weakness, 'gasoline');
    await game.finishOpening({ secrets: false });
    await open(second, mode);
    await nav(fp, 'inventory');
    await fp.locator('details.free-actions').filter({ has: fp.getByTestId('offer-gift') }).locator('summary').click();
    await fp.locator('[data-testid="gift-item"][data-item-id="night_vision"]').check();
    await chat(second, '只赠送选中的道具');
    assert.equal(await fp.locator('[data-testid="gift-item"][data-item-id="night_vision"]').isChecked(), true);
    assert.equal(await fp.locator('[data-testid="gift-item"][data-item-id="password_4"]').isChecked(), false);
    const gift = await click(fp, 'offer_exchange', () => fp.getByTestId('offer-gift').click());
    assert.deepEqual(gift.payload.giveItemIds, ['night_vision']);
    assert.deepEqual(gift.payload.giveTokenIds, [], 'A repeated test id must never add the password token to a gift');
    assert.deepEqual(gift.payload.requestItemIds, []);
    assert.deepEqual(gift.payload.requestTokenIds, []);
    const offer = (await snapshot(second)).round.exchangeOffers[0];
    await act(second, 'respond_exchange', { offerId: offer.id, accept: true });
    const sender = await snapshot(first), recipient = await snapshot(second);
    assert.deepEqual(sender.round.inventory.tokens.map(token => token.id), ['password_4'], 'No unselected token was gifted');
    assert.deepEqual(recipient.round.inventory.tokens, [], 'Recipient receives no unintended token');
    assert.deepEqual(recipient.round.inventory.items.map(item => item.id).sort(), ['night_vision', 'stethoscope']);
    await act(first, 'silent_reveal', { index: 0 });
    await act(first, 'peek', { cornerId: 'bathroom_washer' });
    await act(hako, 'resolve_visitor_action');
    await nav(fp, 'action');
    await chat(first, '这枚密码留在原处');
    let posts = 0;
    fp.on('request', request => { if (request.method() === 'POST' && request.postDataJSON()?.type === 'resolve_peek') posts++; });
    const left = await click(fp, 'resolve_peek', () => fp.getByTestId('resolve-peek-leave').click());
    assert.equal(left.payload.take, false);
    assert.equal(left.payload.replacement, 'none');
    assert.equal(posts, 1, 'The explicit leave button submits a single complete decision');
    assert.equal(left.state.round.resolution, null);
    assert.equal(await fp.getByTestId('resolve-peek').count(), 0, 'Leaving does not leave an obsolete confirmation');
    assert.deepEqual((await snapshot(first)).round.inventory.tokens.map(token => token.id), ['password_4']);
  });

  test(`${mode}: safe digits and stethoscope mode survive chat and submit exactly the displayed selection`, { timeout: 90000 }, async t => {
    const game = await session(t, { roomId: 'study_room', items: ['stethoscope', 'night_vision', 'walkie_talkie'] });
    const { people: [hako, first, second], act, click, open, chat } = game;
    await game.finishOpening();
    const fp = await open(first, mode);
    await open(second, mode);
    await act(first, 'silent_reveal', { index: 0 });
    await act(first, 'peek', { cornerId: 'study_desk' });
    await act(hako, 'resolve_visitor_action');
    await nav(fp, 'action');
    for (const value of [1, 3, 6]) await fp.locator(`[data-testid="guess-number-checkbox"][value="${value}"]`).check();
    await chat(second, '保险箱数字保持原选择');
    assert.deepEqual(await checkedNumbers(fp, 'guess-number-checkbox'), [1, 3, 6]);
    await fp.getByTestId('safe-use-stethoscope').check();
    assert.deepEqual(await checkedNumbers(fp, 'guess-number-checkbox'), [1], 'Switching to one-digit mode keeps only a valid digit');
    await fp.locator('[data-testid="guess-number-checkbox"][value="1"]').uncheck();
    await fp.locator('[data-testid="guess-number-checkbox"][value="6"]').check();
    if (mode === 'sse') {
      await fp.getByTestId('safe-use-stethoscope').uncheck();
      for (const value of [1, 3]) await fp.locator(`[data-testid="guess-number-checkbox"][value="${value}"]`).check();
    }
    await chat(first, '检查听诊器切换后的数字');
    const displayed = await checkedNumbers(fp, 'guess-number-checkbox');
    assert.deepEqual(displayed, mode === 'sse' ? [1, 3, 6] : [6]);
    const guessed = await click(fp, 'safe_guess', () => fp.getByTestId('safe-guess-submit').click());
    assert.deepEqual(guessed.payload.numbers, displayed);
    assert.equal(guessed.payload.useStethoscope, mode === 'poll');
    assert.equal(guessed.state.round.resolution, null);
    if (mode === 'poll') assert.deepEqual(guessed.state.round.safe.publicNumbers, [6]);
    else assert.ok(guessed.state.round.inventory.tokens.some(token => token.type === 'key'));
  });
}

test('taking a token commits the selected replacement once and keeps its captured payload during redraws', { timeout: 90000 }, async t => {
  const game = await session(t);
  const { people: [hako, first, second], act, snapshot, click, open, chat } = game;
  await game.finishOpening();
  const fp = await open(first);
  await open(second);
  await act(first, 'silent_reveal', { index: 0 });
  await act(first, 'peek', { cornerId: 'bathroom_washer' });
  await act(hako, 'resolve_visitor_action');
  await nav(fp, 'action');
  await fp.getByTestId('replacement-select').selectOption('password_4');
  assert.match(await fp.getByTestId('resolve-peek-take').innerText(), /密码2.*密码4/);
  const version = (await snapshot(first)).version;
  let release, entered, submitted, posts = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  fp.on('request', request => { if (request.method() === 'POST' && request.postDataJSON()?.type === 'resolve_peek') posts++; });
  await fp.route('**/actions', async route => {
    submitted = route.request().postDataJSON();
    entered();
    await held;
    await route.fulfill({ response: await route.fetch() });
  }, { times: 1 });
  const finished = click(fp, 'resolve_peek', () => fp.getByTestId('resolve-peek-take').click());
  await started;
  await chat(second, '同步不能改变已经提交的补位');
  for (const view of ['map', 'inventory', 'action']) await nav(fp, view);
  assert.equal(await fp.getByTestId('resolve-peek-take').isDisabled(), true, 'Local navigation preserves the pending submission lock');
  assert.equal(submitted.take, true);
  assert.equal(submitted.replacement, 'password_4');
  assert.equal(submitted.expectedVersion, version, 'The request keeps the version at the original click');
  release();
  const resolved = await finished;
  assert.equal(resolved.payload.take, true);
  assert.equal(posts, 1);
  assert.deepEqual((await snapshot(first)).round.inventory.tokens.map(token => token.id), ['password_2']);
  assert.equal(await fp.getByTestId('resolve-peek').count(), 0, 'Taking needs no second confirmation');
});

test('notebook replacement and night-vision reward survive synchronization and local navigation', { timeout: 90000 }, async t => {
  const game = await session(t);
  const { people: [hako, first, second, third], act, snapshot, click, open, chat } = game;
  await game.finishOpening();
  const fp = await open(first), sp = await open(second);
  await act(first, 'silent_reveal', { index: 0 });
  await act(first, 'peek', { cornerId: 'bathroom_toilet', useNightVision: true });
  await act(hako, 'resolve_visitor_action');
  await nav(fp, 'action');
  await fp.getByTestId('replacement-select').selectOption('password_4');
  await fp.getByTestId('night-vision-item').selectOption('smartphone');
  await chat(second, '不要替换已经选好的补位和奖励');
  await open(third);
  await fp.waitForFunction(id => window.__flowState.players.find(player => player.id === id)?.connected, third.playerId);
  for (const view of ['map', 'inventory', 'action']) await nav(fp, view);
  assert.equal(await fp.getByTestId('replacement-select').inputValue(), 'password_4');
  assert.equal(await fp.getByTestId('night-vision-item').inputValue(), 'smartphone');
  const resolved = await click(fp, 'resolve_peek', () => fp.getByTestId('resolve-peek').click());
  assert.equal(resolved.payload.replacement, 'password_4');
  assert.equal(resolved.payload.itemId, 'smartphone');
  assert.equal(resolved.payload.faceUp, false);
  const mine = await snapshot(first);
  assert.deepEqual(mine.round.inventory.tokens, []);
  assert.deepEqual(mine.round.inventory.items.map(item => item.id).sort(), ['night_vision', 'smartphone']);
  assert.equal(await sp.locator('[data-testid="inventory-item"][data-item-id="smartphone"]').count(), 0, 'The reward remains private');
});

test('NO.4 reorder drafts use their own step and hiding room commitment starts a distinct corner step', { timeout: 90000 }, async t => {
  const game = await session(t, { power4: true });
  const { people: [hako, first], people, act, snapshot, click, open, chat } = game;
  await game.finishOpening();
  const hp = await open(hako), fp = await open(first);
  for (let index = 0; index < 5; index++) {
    const state = await snapshot(hako);
    await act(people.find(person => person.playerId === state.round.silent.turnPlayerId), 'silent_skip', { index });
  }
  await act(hako, 'begin_hako_action');
  const beforeReorder = await stepKey(hp);
  await hp.getByTestId('power-room-0').selectOption('bathroom_room');
  await click(hp, 'activate_power', () => hp.locator('[data-testid="activate-power"][data-power-id="4"]').click());
  const duringReorder = await stepKey(hp);
  assert.notEqual(duringReorder, beforeReorder, 'Rearrangement is a distinct operation');
  const ids = await hp.getByTestId('power-rearrange-source').evaluateAll(selects => selects.map(select => select.dataset.cornerId));
  const order = [...ids].reverse();
  for (let index = 0; index < ids.length; index++) await hp.locator(`[data-testid="power-rearrange-source"][data-corner-id="${ids[index]}"]`).selectOption(order[index]);
  await hp.locator(`[data-testid="power-rearrange-face-down"][data-corner-id="${ids[0]}"]`).check();
  const mapContextOpen = () => hp.evaluate(() => Boolean(document.getElementById('map-context')?.matches(':popover-open')));
  assert.equal(await mapContextOpen(), false, 'Direct NO.4 control choices only preview the map');
  await hp.locator(`.corner-location[data-corner-id="${ids[0]}"]`).click();
  assert.equal(await mapContextOpen(), true, 'Clicking the map still opens its nearby context');
  await hp.locator('#map-context').getByRole('button', { name: '收起', exact: true }).click();
  await chat(hako, '重排按当前排列确认');
  assert.equal(await mapContextOpen(), false, 'Restoring a NO.4 draft after chat does not reopen the map context');
  assert.deepEqual(await hp.getByTestId('power-rearrange-source').evaluateAll(selects => selects.map(select => select.value)), order);
  assert.equal(await fp.getByTestId('power-rearrangement').count(), 0, 'Visitors never receive rearrangement controls');
  const reordered = await click(hp, 'power_rearrange', () => hp.getByTestId('power-rearrange-submit').click());
  assert.deepEqual(reordered.payload.order, order);
  assert.deepEqual(reordered.payload.faceDownCornerIds, [ids[0]]);
  assert.notEqual(await stepKey(hp), duringReorder);
  await hp.getByTestId('hiding-room-select').selectOption('children_room');
  const roomStep = await stepKey(hp);
  await click(hp, 'inspect_hiding_room', () => hp.getByTestId('inspect-hiding-room').click());
  assert.notEqual(await stepKey(hp), roomStep, 'Confirming the room starts a separate committed corner step');
  assert.equal(await hp.getByTestId('hiding-room-select').count(), 0);
  assert.equal(await hp.getByTestId('activate-power').count(), 0, 'Room commitment ends phase ability selection');
  const cornerId = (await snapshot(hako)).round.hako.hidingTargets.at(-1);
  await hp.getByTestId('hiding-select').selectOption(cornerId);
  assert.equal(await mapContextOpen(), false, 'Choosing a hiding corner in the action panel does not open the map context');
  await chat(first, '潜伏角落保持当前选择');
  assert.equal(await hp.getByTestId('hiding-select').inputValue(), cornerId);
  assert.equal(await mapContextOpen(), false, 'Synchronizing the hiding draft leaves the map context closed');
  const hidden = await click(hp, 'hako_hide', () => hp.getByTestId('confirm-hiding').click());
  assert.equal(hidden.payload.cornerId, cornerId);
  assert.equal((await snapshot(first)).round.hako.cornerId, undefined);
});

test('help remains readable through undo and disconnect while clue summaries respect private sources', { timeout: 90000 }, async t => {
  const game = await session(t);
  const { people: [hako, first, second], act, snapshot, open, click } = game;
  await game.finishOpening();
  const fp = await open(first, 'poll'), sp = await open(second);
  await nav(fp, 'inventory');
  const clues = fp.getByTestId('private-clue-summary');
  await clues.locator('summary').click();
  assert.match(await clues.innerText(), /仅你可见|当前持有/);
  assert.equal(await clues.locator('[data-clue-id="password:4"]').count(), 1);
  assert.equal(await sp.getByTestId('private-clue-summary').locator('[data-clue-id="password:4"]').count(), 0);
  assert.doesNotMatch(await fp.locator('.public-progress').innerText(), /密码4/, 'Private held clues do not move into public information');
  assert.equal((await snapshot(second)).round.inventory.tokens.length, 0);
  await mkdir('test-results', { recursive: true });
  await fp.screenshot({ path: 'test-results/flow-clues-desktop.png', fullPage: true });
  let posts = 0;
  fp.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions')) posts++; });
  const showHelp = async () => {
    await fp.getByTestId('room-menu-toggle').click();
    await fp.getByTestId('show-help').focus();
    await fp.keyboard.press('Enter');
    await fp.locator('#help-dialog[open]').waitFor();
  };
  assert.equal(await fp.locator('#help-dialog').evaluate(dialog => dialog.open), false);
  await showHelp();
  assert.match(await fp.locator('#help-content').innerText(), /灭火器|继承/);
  await fp.screenshot({ path: 'test-results/flow-help-desktop.png', fullPage: true });
  await fp.keyboard.press('Escape');
  assert.equal(await fp.locator('#help-dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await fp.getByTestId('room-menu-toggle').evaluate(button => document.activeElement === button), true, 'Esc restores keyboard focus to the visible room menu entry');
  assert.equal(posts, 0, 'Reading or dismissing help submits no game action');
  await act(first, 'silent_reveal', { index: 0 });
  await act(first, 'undo_request', { version: (await snapshot(first)).version });
  assert.ok((await snapshot(first)).undo.pending);
  for (const view of ['map', 'inventory', 'action']) await nav(fp, view);
  assert.equal(await fp.getByTestId('move-target').first().isDisabled(), true);
  await showHelp();
  await fp.getByTestId('help-close').click();
  assert.equal(await fp.getByTestId('move-target').first().isDisabled(), true, 'Help and navigation do not unlock a pending vote');
  await click(sp, 'undo_respond', () => sp.getByTestId('undo-reject').click());
  await fp.context().setOffline(true);
  await fp.waitForFunction(() => document.getElementById('connection-state').textContent !== '已连接');
  await showHelp();
  assert.equal(await fp.locator('#help-dialog').evaluate(dialog => dialog.open), true, 'Help stays available while disconnected');
  await fp.setViewportSize({ width: 375, height: 667 });
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile help creates no horizontal overflow');
  await fp.screenshot({ path: 'test-results/flow-help-mobile.png', fullPage: true });
  await fp.getByTestId('help-close').click();
  assert.equal(posts, 0);
  await fp.context().setOffline(false);
  await fp.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.equal((await snapshot(hako)).round.phase, 'visitor_action');
});
