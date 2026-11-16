import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'upstairs', 'bathroom', 'basement', 'dining', 'children', 'storage', 'living'];
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function createSession(t, { poll = false } = {}) {
  // The human-Hako scenario covers confirming ordinary exploration, while the
  // polling scenario below explicitly covers item questions. Keep the former
  // free of random questions that require an additional human answer.
  const server = createGameServer({ deck, initialItemOrder: poll ? ['walkie_talkie', 'deduction', 'dowsing_rod']
    : ['deduction', 'stethoscope', 'relic_ring'], botDelayMs: 25, silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      if (!poll) return play;
      // This scenario verifies automatic answers and movement confirmations.
      // A random legal NO.6/7/10 interruption cancels that movement, so use
      // non-interrupting real cards while preserving the entire card pool.
      const chosen = play.powers.hand.find(card => card.id !== 11);
      if (chosen.id !== 1) {
        const index = play.powers.deck.indexOf(1);
        assert.ok(index >= 0);
        play.powers.deck[index] = chosen.id;
        chosen.id = 1;
      }
      const passive = play.powers.deck.indexOf(9);
      assert.ok(passive >= 0);
      play.powers.deck.unshift(...play.powers.deck.splice(passive, 1));
      return play;
    } });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const record = value => {
      const next = value?.state ?? value;
      if (typeof next?.version === 'number' && (!window.__hakoTestState || next.version >= window.__hakoTestState.version)) {
        window.__hakoTestState = next;
      }
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
  const errors = [];
  const openPage = async url => {
    const page = await context.newPage();
    await page.addLocatorHandler(page.locator('#event-dialog[open]'), async () => { await page.keyboard.press('Escape'); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    return page;
  };
  const page = await openPage(`${base}/${poll ? '?sync=poll' : ''}`);
  await page.getByTestId('nickname').fill(poll ? '独行访问者' : '独行箱娃');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms' && response.request().method() === 'POST');
  await page.getByTestId('create-room').click();
  const identity = await (await created).json();
  await page.getByTestId('room-code-display').waitFor();
  await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  async function state() {
    const response = await fetch(`${base}/api/rooms/${identity.roomCode}?${new URLSearchParams({ playerId: identity.playerId, token: identity.token })}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  return { base, browser, context, page, identity, state, openPage, errors };
}

async function act(page, type, trigger) {
  const pendingResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/actions')
    && response.request().postDataJSON()?.type === type);
  await trigger();
  const response = await pendingResponse;
  const result = await response.json();
  assert.equal(response.status(), 200, `${type}: ${result.error ?? 'should succeed'}`);
  return result;
}

async function current(page) {
  return page.evaluate(() => window.__hakoTestState);
}

async function waitState(page, predicate, argument) {
  try { await page.waitForFunction(predicate, argument); }
  catch (error) {
    const value = await current(page);
    const diagnostic = `Bot wait state: ${JSON.stringify({ phase: value?.phase, initialItems: value?.initialItems?.map(item => item.itemId),
      round: value?.round && { phase: value.round.phase, pendingAction: value.round.pendingAction,
        resolution: value.round.resolution, silent: value.round.silent, result: value.round.result } })}`;
    throw new Error(diagnostic, { cause: error });
  }
  return current(page);
}

async function expectStable(session, message) {
  const before = await session.state();
  await session.page.waitForTimeout(150);
  assert.equal((await session.state()).version, before.version, message);
}

async function expectMobile(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'Human and bot controls fit the mobile viewport');
}

function assertVisitorPrivacy(value) {
  const privateKeys = new Set(['password', 'weakness', 'passwordOptions', 'weaknessOptions', 'remainsCornerId',
    'hidingCornerId', 'hidingUnderToken', 'hidingTargets', 'hidingRooms', 'inspectedRoom', 'cornerTokens', 'lastInspectedRoom',
    'initialPowerOptions', 'initialPowerId', 'initialPowerName', 'initialPowerCandidates', 'powerDeck', 'hand', 'truth', 'canLie', 'answerOptions']);
  function visit(child) {
    if (!child || typeof child !== 'object') return;
    for (const [key, nested] of Object.entries(child)) {
      assert.equal(privateKeys.has(key), false, `Visitor state must not reveal ${key}`);
      visit(nested);
    }
  }
  visit(value);
  if (value.round) assert.deepEqual(value.round.hako, { playerId: value.players.find(player => player.role === 'hako').id });
}

async function fillBotsAndStart(session, roleAction) {
  const { page, identity } = session;
  let state = await act(page, 'add_bots', () => page.getByTestId('add-bots').click());
  assert.equal(state.players.filter(player => player.isBot).length, 3);
  assert.equal(state.players.filter(player => player.isBot).every(player => player.connected && player.ready), true);
  assert.equal(state.players.find(player => player.id === identity.playerId).ready, false);
  assert.equal(await page.locator('#lobby-seats').getByTestId('bot-label').count(), 3);
  assert.equal(await page.getByTestId('add-bots').isVisible(), false);
  await expectMobile(page);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/bots-lobby-mobile.png', fullPage: true });
  await expectStable(session, 'Bots wait for the person to ready and start the game');
  state = await act(page, 'ready', () => page.getByTestId('ready-button').click());
  assert.equal(state.players.every(player => player.ready), true);
  state = await act(page, 'start', () => page.getByTestId('start-setup').click());
  assert.equal(state.phase, 'hako_selection');
  assert.equal(await page.getByTestId('claim-hako').isEnabled(), true);
  assert.equal(await page.getByTestId('bot-claim-hako').isEnabled(), true);
  assert.equal(await page.getByTestId('add-bots').isVisible(), false);
  assert.equal(await page.getByTestId('remove-bot-player').count(), 0);
  await expectStable(session, 'Bots do not choose Hako before the person chooses a side');
  const button = roleAction === 'claim_hako' ? 'claim-hako' : 'bot-claim-hako';
  return act(page, roleAction, () => page.getByTestId(button).click());
}

test('a mobile human Hako adds three bots and confirms their exploration actions', { timeout: 90000 }, async t => {
  const session = await createSession(t);
  const { page, identity } = session;
  assert.equal(await page.getByTestId('add-bots').isVisible(), true);
  assert.equal(await page.getByTestId('bot-claim-hako').isVisible(), false);

  const guestContext = await session.browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`${session.base}/?room=${identity.roomCode}`);
  await guest.getByTestId('nickname').fill('暂时入席的朋友');
  const joined = guest.waitForResponse(response => new URL(response.url()).pathname.endsWith('/join') && response.request().method() === 'POST');
  await guest.getByTestId('join-room').click();
  const guestIdentity = await (await joined).json();
  await guest.getByTestId('room-code-display').waitFor();
  await guest.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  assert.equal(await guest.getByTestId('add-bots').isVisible(), false);
  assert.equal(await guest.getByTestId('start-setup').isVisible(), false);
  const forbidden = await fetch(`${session.base}/api/rooms/${identity.roomCode}/actions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: guestIdentity.playerId, token: guestIdentity.token, type: 'add_bots' }),
  });
  assert.equal(forbidden.status, 403, 'A non-host cannot add bots');
  await act(guest, 'leave', () => guest.locator('#leave-room').click());
  await guestContext.close();

  await act(page, 'add_bots', () => page.getByTestId('add-bots').click());
  const removedId = await page.getByTestId('remove-bot-player').first().getAttribute('data-player-id');
  let state = await act(page, 'remove_player', () => page.getByTestId('remove-bot-player').first().click());
  assert.equal(state.players.some(player => player.id === removedId), false);
  assert.equal(state.players.filter(player => player.isBot).length, 2);
  assert.equal(await page.getByTestId('add-bots').isVisible(), true);
  state = await fillBotsAndStart(session, 'claim_hako');
  assert.equal(state.players.find(player => player.role === 'hako').id, identity.playerId);
  state = await waitState(page, () => window.__hakoTestState?.phase === 'map_ready');
  assert.equal(state.initialItems.length, 3);
  assert.equal(state.setup.placements.length, 9);
  assert.equal(await page.getByTestId('claim-hako').isVisible(), false);
  assert.equal(await page.getByTestId('bot-claim-hako').isVisible(), false);
  await expectStable(session, 'The host starts opening preparation after the bots finish the map');
  state = await act(page, 'prepare_opening', () => page.getByTestId('prepare-opening').click());
  assert.equal(state.opening.phase, 'secrets');
  await expectStable(session, 'Bots cannot choose the human Hako password and weakness');
  const password = state.opening.passwordOptions.slice(0, 3);
  for (const number of password) await page.locator(`[data-testid="password-choice"][value="${number}"]`).check();
  await page.getByTestId('weakness-select').selectOption(state.opening.weaknessOptions[0].id);
  state = await act(page, 'choose_secrets', () => page.getByTestId('confirm-secrets').click());
  assert.deepEqual(state.opening.password, password);
  await page.getByTestId('remains-select').selectOption(state.opening.remainsTargets[0]);
  state = await act(page, 'place_remains', () => page.getByTestId('confirm-remains').click());
  const room = state.opening.hidingRooms.find(room => room.id === 'children_room') ?? state.opening.hidingRooms[0];
  await page.getByTestId('initial-room-select').selectOption(room.id);
  state = await act(page, 'inspect_initial_room', () => page.getByTestId('inspect-initial-room').click());
  await page.getByTestId('initial-hiding-select').selectOption(state.opening.hidingTargets[0]);
  state = await act(page, 'choose_initial_hiding', () => page.getByTestId('confirm-initial-hiding').click());
  await page.getByTestId('initial-power-select').selectOption(String(state.opening.initialPowerOptions.find(card => card.canChoose !== false).id));
  await act(page, 'choose_initial_power', () => page.getByTestId('confirm-initial-power').click());

  for (let turn = 0; turn < 2; turn++) {
    state = await waitState(page, () => Boolean(window.__hakoTestState?.round?.pendingAction));
    const actorId = state.round.pendingAction.playerId;
    assert.notEqual(actorId, identity.playerId);
    assert.equal(state.players.find(player => player.id === actorId).isBot, true);
    assert.equal(state.round.phase, 'visitor_reaction');
    assert.ok(state.round.silent.cards.some(card => card.status === 'up'));
    await expectStable(session, 'The bot declaration waits for the human Hako confirmation');
    await act(page, 'resolve_visitor_action', () => page.getByTestId('resolve-action').click());
    state = await waitState(page, playerId => window.__hakoTestState?.round?.silent.turnPlayerId !== playerId, actorId);
    assert.notEqual(state.round.resolution?.playerId, actorId, 'The bot resolves its own private peek result');
  }
  await expectMobile(page);
  await page.screenshot({ path: 'test-results/bots-play-mobile.png', fullPage: true });
  assert.deepEqual(session.errors, []);
});

async function awaitHumanAction(session, page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let state = await waitState(page, () => {
      const state = window.__hakoTestState;
      return state?.round?.result || state?.round?.silent.turnPlayerId === state.you
        && ['visitor_reveal', 'visitor_action'].includes(state.round.phase) && !state.round.resolution && !state.round.pendingAction;
    });
    assert.equal(state.round.result, null, 'The person remains able to play');
    assert.equal(state.round.visitors.find(visitor => visitor.id === state.you).status, 'alive');
    if (state.round.phase === 'visitor_action') return state;
    const before = await session.state();
    await page.waitForTimeout(150);
    assert.equal((await session.state()).version, before.version, 'Bots never reveal the human player’s silent card');
    const card = state.round.silent.cards.find(card => card.status === 'down');
    state = await act(page, 'silent_reveal', () => page.getByTestId(`silent-card-${card.index}`).click());
    if (state.round.phase === 'visitor_action') return state;
  }
  assert.fail('The human must regain a legal action after an overflow cycle');
}

test('a polling human visitor plays with a bot Hako and recovers the same seat after closing the page', { timeout: 120000 }, async t => {
  const session = await createSession(t, { poll: true });
  let page = session.page;
  const { identity } = session;
  let state = await fillBotsAndStart(session, 'bot_claim_hako');
  assert.equal(state.players.find(player => player.role === 'hako').isBot, true);
  assert.equal(state.players.find(player => player.id === identity.playerId).role, 'visitor');
  assert.equal(state.initialItems.find(choice => choice.playerId === identity.playerId).itemId, 'dowsing_rod');
  assert.equal(await page.getByTestId('item-choice').count(), 0, 'The human receives a random card without a draft stop');
  let humanPlacements = 0;
  while (humanPlacements < deck.length) {
    state = await waitState(page, () => {
      const state = window.__hakoTestState;
      return state?.phase === 'map_ready' || state?.phase === 'map_setup' && state.setup.turnPlayerId === state.you;
    });
    if (state.phase === 'map_ready') break;
    assert.equal(state.setup.drawnTileId, null, 'The bot does not draw the human player’s tile');
    await expectStable(session, 'Bots wait for the human to draw and place their map board');
    state = await act(page, 'draw', () => page.getByTestId('draw-tile').click());
    const placement = state.setup.legalPlacements[0];
    const floor = placement.floor === -1 ? 'basement' : placement.floor;
    await page.getByTestId(`floor-${floor}`).click();
    await page.locator(`[data-testid="legal-position"][data-x="${placement.x}"][data-y="${placement.y}"][data-floor="${placement.floor}"][data-rotation="${placement.rotation}"]`).click();
    await act(page, 'place', () => page.getByTestId('confirm-placement').click());
    humanPlacements++;
  }
  assert.ok(humanPlacements >= 2);
  assert.equal(state.phase, 'map_ready');
  assert.equal(state.setup.placements.length, 9);
  state = await act(page, 'prepare_opening', () => page.getByTestId('prepare-opening').click());
  assertVisitorPrivacy(state);
  state = await waitState(page, () => window.__hakoTestState?.phase === 'practice');
  assertVisitorPrivacy(state);
  for (const testid of ['password-choice', 'weakness-select', 'initial-hiding-select', 'opening-controls', 'hako-location']) {
    assert.equal(await page.getByTestId(testid).count(), 0, 'The human visitor never gets bot Hako secret controls');
  }

  state = await awaitHumanAction(session, page);
  assertVisitorPrivacy(state);
  assert.ok(state.round.inventory.items.some(item => item.id === 'dowsing_rod'));
  await page.getByTestId('active-item-select').selectOption('dowsing_rod');
  await act(page, 'use_item', () => page.getByTestId('use-item').click());
  state = await waitState(page, playerId => window.__hakoTestState?.round?.items.events.some(event =>
    event.kind === 'item_answer' && event.userId === playerId && event.itemId === 'dowsing_rod'), identity.playerId);
  assertVisitorPrivacy(state);
  assert.equal(await page.getByTestId('answer-item').count(), 0, 'The bot Hako confirms and answers the human’s question');

  state = await awaitHumanAction(session, page);
  assert.ok(state.round.moveTargets.length > 0);
  const destination = state.round.moveTargets[0];
  await act(page, 'move', () => page.locator(`[data-testid="move-target"][data-room-id="${destination}"]`).click());
  state = await waitState(page, expected => {
    const round = window.__hakoTestState?.round;
    return round?.visitors.find(visitor => visitor.id === expected.playerId)?.roomId === expected.roomId
      && round.pendingAction?.playerId !== expected.playerId;
  }, { playerId: identity.playerId, roomId: destination });
  assertVisitorPrivacy(state);
  assert.equal(await page.getByTestId('resolve-action').count(), 0, 'The bot Hako resolves movement without asking the visitor to confirm it');
  await expectMobile(page);

  await waitState(page, () => window.__hakoTestState?.round?.silent.turnPlayerId === window.__hakoTestState.you
    && window.__hakoTestState.round.phase === 'visitor_reveal');
  const beforeClose = await session.state();
  await page.close();
  page = await session.openPage(`${session.base}/?room=${identity.roomCode}&sync=poll`);
  await page.getByTestId('room-code-display').waitFor();
  await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  state = await current(page);
  assert.equal(state.you, identity.playerId);
  assert.equal(state.players.length, 4);
  assert.equal(state.players.filter(player => player.isBot).length, 3);
  assert.equal(state.version, beforeClose.version, 'Closing and reopening cannot make bots act for the human');
  assert.equal(new URL(page.url()).searchParams.get('sync'), 'poll');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('hako.room.session.v1')).playerId), identity.playerId);
  assertVisitorPrivacy(state);
  await expectMobile(page);
  assert.deepEqual(session.errors, []);
});
