import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';

const deck = ['study', 'upstairs', 'bathroom', 'basement', 'dining', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function session(t) {
  const server = createGameServer({ deck, botDelayMs: 15, silentNumbers: [0, 1, 2, 3, 4, 5] });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const pages = [];
  const identities = [];
  const errors = [];
  async function enter({ mobile = false, join = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      const record = value => {
        const next = value?.state ?? value;
        if (typeof next?.version === 'number' && (!window.__fiveState || next.version >= window.__fiveState.version)) window.__fiveState = next;
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (response.ok && new URL(response.url).pathname.startsWith('/api/rooms')) record(await response.clone().json());
        return response;
      };
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener('state', event => record(JSON.parse(event.data)));
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), () => page.keyboard.press('Escape'));
    await page.goto(`${base}/${join ? `?room=${identities[0].roomCode}` : ''}`);
    await page.getByTestId('nickname').fill(`五人玩家${pages.length + 1}`);
    assert.equal(await page.getByTestId('player-count').inputValue(), '4', 'The existing four-player default stays available');
    if (!join) await page.getByTestId('player-count').selectOption('5');
    const endpoint = join ? `/api/rooms/${identities[0].roomCode}/join` : '/api/rooms';
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await page.getByTestId(join ? 'join-room' : 'create-room').click();
    const response = await pending;
    assert.equal(response.status(), 201);
    if (!join) assert.equal(response.request().postDataJSON().playerCount, 5);
    identities.push(await response.json());
    pages.push(page);
    await page.getByTestId('room-code-display').waitFor();
    await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
    return page;
  }
  async function act(page, type, trigger) {
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await pending;
    const state = await response.json();
    assert.equal(response.status(), 200, `${type}: ${state.error ?? 'should succeed'}`);
    await Promise.all(pages.map(target => target.waitForFunction(version => window.__fiveState?.version >= version, state.version)));
    return state;
  }
  return { enter, pages, identities, errors, act };
}

async function fits(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'Five-player content fits the viewport');
}

test('five independent browsers choose five-player mode and complete opening plus all four visitor turns', { timeout: 120000 }, async t => {
  const { enter, pages, identities, errors, act } = await session(t);
  for (let index = 0; index < 4; index++) await enter({ join: index > 0 });
  assert.equal(await pages[0].locator('#lobby-count').innerText(), '4 / 5 人入席');
  assert.equal(await pages[0].getByTestId('start-setup').isDisabled(), true);
  assert.equal(await pages[0].locator('#lobby-seats > li').count(), 5);
  await enter({ join: true, mobile: true });
  const fifth = pages[4];
  await fifth.reload();
  await fifth.getByTestId('room-code-display').waitFor();
  await fifth.waitForFunction(() => window.__fiveState?.players.length === 5 && document.getElementById('connection-state').textContent === '已连接');
  assert.equal(await fifth.locator('#lobby-count').innerText(), '5 / 5 人入席');
  assert.equal(await fifth.locator('#visitor-role-count').innerText(), '四名访问者');
  assert.equal(await fifth.evaluate(() => window.__fiveState.you), identities[4].playerId);
  for (const page of pages) await act(page, 'ready', () => page.getByTestId('ready-button').click());
  await act(pages[0], 'start', () => pages[0].getByTestId('start-setup').click());
  assert.equal(await fifth.getByTestId('hako-claim-status').innerText(), '五人已准备，点击按钮抢当箱娃，先抢先得。');
  let state = await act(pages[0], 'claim_hako', () => pages[0].getByTestId('claim-hako').click());
  const pageFor = id => pages[identities.findIndex(person => person.playerId === id)];
  const recipients = [];
  for (let index = 0; index < 4; index++) {
    const id = state.draft.turnPlayerId;
    recipients.push(id);
    const page = pageFor(id);
    state = await act(page, 'choose_item', () => page.getByTestId('item-choice').first().click());
  }
  assert.deepEqual(recipients, identities.slice(1).map(person => person.playerId));
  assert.equal(state.initialItems.length, 4);
  const mapActors = [];
  for (let index = 0; index < deck.length; index++) {
    const id = state.setup.turnPlayerId;
    mapActors.push(id);
    const page = pageFor(id);
    state = await act(page, 'draw', () => page.getByTestId('draw-tile').click());
    const placement = state.setup.legalPlacements[0];
    for (let rotation = 0; rotation < placement.rotation; rotation++) await page.getByTestId('rotate-tile').click();
    await page.getByTestId(placement.floor === -1 ? 'floor-basement' : `floor-${placement.floor}`).click();
    await page.getByTestId('legal-position').first().click();
    state = await act(page, 'place', () => page.getByTestId('confirm-placement').click());
  }
  assert.deepEqual(mapActors, [...recipients, ...recipients]);
  assert.equal(state.phase, 'map_ready');
  assert.equal(await fifth.locator('#setup-seats > li').count(), 5);
  const host = pages[0];
  state = await act(host, 'prepare_opening', () => host.getByTestId('prepare-opening').click());
  for (const value of state.opening.passwordOptions.slice(0, 3)) await host.locator(`[data-testid="password-choice"][value="${value}"]`).check();
  await host.getByTestId('weakness-select').selectOption(state.opening.weaknessOptions[0].id);
  state = await act(host, 'choose_secrets', () => host.getByTestId('confirm-secrets').click());
  await host.getByTestId('remains-select').selectOption(state.opening.remainsTargets[0]);
  state = await act(host, 'place_remains', () => host.getByTestId('confirm-remains').click());
  await host.getByTestId('initial-room-select').selectOption(state.opening.hidingRooms[0].id);
  state = await act(host, 'inspect_initial_room', () => host.getByTestId('inspect-initial-room').click());
  await host.getByTestId('initial-hiding-select').selectOption(state.opening.hidingTargets[0]);
  state = await act(host, 'choose_initial_hiding', () => host.getByTestId('confirm-initial-hiding').click());
  await host.getByTestId('initial-power-select').selectOption(String(state.opening.initialPowerOptions[0].id));
  state = await act(host, 'choose_initial_power', () => host.getByTestId('confirm-initial-power').click());
  assert.equal(state.round.visitors.length, 4);
  await fifth.reload();
  await fifth.getByTestId('room-code-display').waitFor();
  await fifth.waitForFunction(() => window.__fiveState?.round && document.getElementById('connection-state').textContent === '已连接');
  assert.equal(await fifth.locator('#room-mode-label').innerText(), '五人联机 · 无声模式');
  assert.equal(await fifth.locator('.map-player-marker.seat-color-4 text').textContent(), '5');
  assert.notEqual(await fifth.locator('.map-player-marker.seat-color-4 circle').evaluate(element => getComputedStyle(element).fill), 'rgb(0, 0, 0)');
  assert.equal(await fifth.evaluate(() => Object.hasOwn(window.__fiveState.round.hako, 'cornerId')), false);
  await fits(fifth);
  await mkdir('test-results', { recursive: true });
  await fifth.screenshot({ path: 'test-results/five-players-mobile.png', fullPage: true });
  const turnActors = [];
  for (let index = 0; index < 4; index++) {
    const id = state.round.silent.turnPlayerId;
    turnActors.push(id);
    const page = pageFor(id);
    state = await act(page, 'silent_reveal', () => page.getByTestId(`silent-card-${index}`).click());
    assert.equal(state.round.phase, 'visitor_action');
    state = await act(page, 'move', () => page.getByTestId('move-target').first().click());
    state = await act(host, 'resolve_visitor_action', () => host.getByTestId('resolve-action').click());
  }
  assert.deepEqual(turnActors, recipients, 'The fourth visitor gets a normal exploration turn');
  assert.equal(state.round.silent.turnPlayerId, recipients[0]);
  assert.deepEqual(errors, []);
});

test('a mobile host fills a five-player room with four bots and reaches opening preparation', { timeout: 60000 }, async t => {
  const { enter, pages, errors, act } = await session(t);
  const host = await enter({ mobile: true });
  let state = await act(host, 'add_bots', () => host.getByTestId('add-bots').click());
  assert.equal(state.playerCount, 5);
  assert.equal(state.players.filter(player => player.isBot && player.ready).length, 4);
  assert.equal(await host.locator('#lobby-seats').getByTestId('bot-label').count(), 4);
  assert.equal(await host.getByTestId('add-bots').isVisible(), false);
  await fits(host);
  await act(host, 'ready', () => host.getByTestId('ready-button').click());
  await act(host, 'start', () => host.getByTestId('start-setup').click());
  await act(host, 'claim_hako', () => host.getByTestId('claim-hako').click());
  await host.waitForFunction(() => window.__fiveState?.phase === 'map_ready');
  state = await host.evaluate(() => window.__fiveState);
  assert.equal(state.initialItems.length, 4);
  assert.equal(state.setup.placements.length, 9);
  assert.equal(await host.locator('#setup-seats > li').count(), 5);
  assert.equal(await host.getByTestId('prepare-opening').isEnabled(), true);
  assert.equal(pages.length, 1);
  await fits(host);
  assert.deepEqual(errors, []);
});
