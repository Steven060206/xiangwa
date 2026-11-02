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

function feedbackFixture(setup, opening, options) {
  const play = createPlay(setup, opening, options);
  const move = (tokenId, destination) => {
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
    assert.ok(source, `Fixture must relocate an existing piece: ${tokenId}`);
    if (typeof destination === 'string') {
      [play.tokens[source], play.tokens[destination]] = [play.tokens[destination], play.tokens[source]];
    } else {
      play.inventories[destination.playerId].tokens.push(play.tokens[source]);
      play.tokens[source] = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
    }
  };
  move('notebook_2', 'bathroom_toilet');
  move('password_4', { playerId: setup.visitorIds[0] });
  move('password_5', { playerId: setup.visitorIds[1] });
  play.round.visitors[0].roomId = 'bathroom_room';
  return play;
}

test('mobile feedback flow names tapped corners, explains notebooks and shares discoveries with temporary room-only cry markers', { timeout: 90000 }, async t => {
  const server = createGameServer({ deck, initialItemOrder: ['walkie_talkie', 'spirit_pen', 'ventriloquist_doll'], silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState: feedbackFixture });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [], errors = [];
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'The corrected game flow must not raise browser errors');
  });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const people = [await request('/api/rooms', { name: '箱娃' })];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    people.push(await request(`/api/rooms/${people[0].roomCode}/join`, { name }));
  }
  async function sync(version) {
    await Promise.all(pages.map(page => page.waitForFunction(expected => window.__feedbackState?.version >= expected, version)));
  }
  async function act(person, type, values = {}) {
    const state = await request(`/api/rooms/${person.roomCode}/actions`, {
      playerId: person.playerId, token: person.token, type, ...values,
    });
    await sync(state.version);
    return state;
  }
  const snapshot = (person = people[0]) => request(`/api/rooms/${person.roomCode}?${new URLSearchParams({
    playerId: person.playerId, token: person.token,
  })}`);
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
  assert.equal(state.phase, 'map_setup');
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  await act(hako, 'prepare_opening');
  await act(hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await act(hako, 'place_remains', { cornerId: 'living_sofa' });
  await act(hako, 'inspect_initial_room', { roomId: 'children_room' });
  await act(hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  for (const [index, person] of [hako, first].entries()) {
    const context = await browser.newContext({ viewport: index ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      ...(index ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(identity => {
      sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity));
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => { window.__feedbackState = JSON.parse(event.data); });
        }
      };
    }, person);
    const page = await context.newPage();
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), async () => { await page.keyboard.press('Escape'); });
    page.on('pageerror', error => errors.push(error.message));
    pages.push(page);
    await page.goto(`${base}/?room=${person.roomCode}`);
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  }
  const [hp, fp] = pages;
  await sync((await snapshot()).version);
  const candidates = (await snapshot()).opening.initialPowerOptions;
  assert.equal(await hp.getByTestId('initial-power-select').locator('option').count(), 3);
  assert.equal(await fp.getByTestId('initial-power-select').count(), 0);
  await hp.reload();
  await hp.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.deepEqual(await hp.getByTestId('initial-power-select').locator('option').evaluateAll(options => options.map(option => Number(option.value))),
    candidates.map(card => card.id));
  state = await act(hako, 'choose_initial_power', { powerId: candidates[0].id });
  assert.equal(await fp.locator('.initial-power-public').count(), 0, 'A visitor DOM does not disclose the selected initial power');
  assert.equal((await snapshot(first)).initialPower == null, true);
  assert.match(await fp.getByTestId('total-rounds').innerText(), /0/);

  const toilet = fp.locator('#tile-board .corner-location[data-corner-id="bathroom_toilet"]');
  await toilet.tap();
  const location = await fp.getByTestId('selected-corner-name').innerText();
  assert.match(location, /\d{2}/);
  assert.match(location, /废旧马桶内/);
  assert.equal(await fp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const beforePublish = await snapshot(first);
  state = await click(fp, 'publish_token', () => fp.locator('[data-testid="publish-inventory-token"][data-token-id="password_4"]').click());
  assert.deepEqual(state.round.silent, beforePublish.round.silent);
  assert.match(await hp.getByTestId('public-discoveries').innerText(), /密码4/);
  assert.equal(await fp.getByTestId('inventory-token').filter({ hasText: '密码5' }).count(), 0);
  await click(fp, 'silent_reveal', () => fp.getByTestId('silent-card-0').click());
  await click(fp, 'peek', () => fp.getByTestId('peek-target').filter({ hasText: '废旧马桶内' }).click());
  await click(hp, 'resolve_visitor_action', () => hp.getByTestId('resolve-action').click());
  assert.match(await fp.getByTestId('private-resolution').innerText(), /马上就到哟/);
  assert.match(await fp.getByTestId('private-resolution').innerText(), /先发动/);
  assert.match(await hp.getByTestId('notebook-power').innerText(), /马上就到哟/);
  assert.equal(await fp.getByTestId('publish-peek-token').count(), 0);
  state = await snapshot(first);
  assert.equal(state.round.phase, 'visitor_resolution');
  assert.equal(state.round.silent.phase, 'visitor_action');
  assert.equal(state.round.silent.turnPlayerId, first.playerId);
  await click(fp, 'resolve_peek', () => fp.getByTestId('resolve-peek').click());

  async function nextStage() {
    for (let count = 0; count < 20; count++) {
      const current = await snapshot();
      if (current.round.phase === 'hako_phase') return current;
      if (current.round.phase === 'hako_reaction') {
        await act(hako, 'pass_noise_reaction');
        continue;
      }
      const person = people.find(person => person.playerId === current.round.silent.turnPlayerId);
      const own = await snapshot(person);
      if (current.round.phase === 'visitor_reveal') {
        await act(person, 'silent_reveal', { index: own.round.silent.cards.find(card => card.status === 'down').index });
      } else {
        assert.equal(current.round.phase, 'visitor_action');
        assert.ok(own.round.moveTargets.length);
        await act(person, 'move', { roomId: own.round.moveTargets[0] });
        await act(hako, 'resolve_visitor_action');
      }
    }
    assert.fail('The fixture must finish a normal silent cycle');
  }
  state = await nextStage();
  assert.equal(state.round.totalRounds, 1);
  assert.match(await fp.getByTestId('total-rounds').innerText(), /1/);
  await click(hp, 'hako_cry', () => hp.getByTestId('hako-cry').click());
  await fp.getByTestId('floor-1').click();
  const marker = fp.getByTestId('cry-map-marker');
  assert.equal(await marker.count(), 1);
  assert.equal(await marker.getAttribute('data-room-id'), 'children_room');
  assert.equal(await marker.getAttribute('data-corner-id'), null, 'The public marker identifies a room without disclosing a hiding corner');
  assert.equal(await fp.locator(`#tile-board .map-player-marker[data-player-id="${hako.playerId}"]`).count(), 0);
  await fp.reload();
  await fp.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.equal(await fp.getByTestId('cry-map-marker').count(), 1);
  await fp.getByTestId('cry-map-marker').scrollIntoViewIfNeeded();
  const markerGeometry = await fp.getByTestId('cry-map-marker').evaluate(element => {
    const marker = element.getBoundingClientRect();
    const viewport = document.getElementById('board-viewport').getBoundingClientRect();
    return { visible: marker.bottom > viewport.top && marker.top < viewport.bottom
      && marker.right > viewport.left && marker.left < viewport.right };
  });
  assert.equal(markerGeometry.visible, true, 'The cry marker is visible when the player browses its map board');
  await mkdir('test-results', { recursive: true });
  await fp.screenshot({ path: 'test-results/feedback-mobile.png', fullPage: true });
  await act(hako, 'begin_hako_action');
  await act(hako, 'inspect_hiding_room', { roomId: 'children_room' });
  await act(hako, 'hako_hide', { cornerId: 'children_cabinet' });
  assert.equal(await fp.getByTestId('cry-map-marker').count(), 1);
  assert.equal((await snapshot()).round.totalRounds, 1);
  state = await nextStage();
  assert.equal(state.round.totalRounds, 2);
  assert.equal(await fp.getByTestId('cry-map-marker').count(), 0);
  assert.match(await fp.getByTestId('total-rounds').innerText(), /2/);
});
