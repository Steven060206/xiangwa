import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';
import { INITIAL_ITEMS } from '../src/preparation.mjs';

const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

test('mobile random deal records show effects and update active and night-vision explanations', { timeout: 45000 }, async t => {
  const server = createGameServer({ deck, initialItemOrder: ['night_vision', 'walkie_talkie', 'deduction'], silentNumbers: [0, 1, 2, 3, 4, 5],
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'notebook');
      assert.ok(source, 'The real pool contains a notebook for the night-vision scenario');
      [play.tokens.hall_clock, play.tokens[source]] = [play.tokens[source], play.tokens.hall_clock];
      // Move real unused cards into this visitor's inventory to exercise a choice
      // between multiple usable items without inventing or duplicating cards.
      for (const itemId of ['dowsing_rod', 'suitcase']) {
        const index = play.availableItems.findIndex(item => item.id === itemId);
        assert.ok(index >= 0);
        play.inventories[opening.itemChoices[0].playerId].items.push(play.availableItems.splice(index, 1)[0]);
      }
      return play;
    },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, input) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, path.endsWith('/actions') ? 200 : 201, `${path}: ${result.error || 'request succeeds'}`);
    return result;
  };
  const hako = await post('/api/rooms', { name: '箱娃' });
  const people = [hako];
  for (const name of ['道具体验者', '访问者二', '访问者三']) people.push(await post(`/api/rooms/${hako.roomCode}/join`, { name }));
  const act = (person, type, payload = {}) => post(`/api/rooms/${hako.roomCode}/actions`, { playerId: person.playerId, token: person.token, type, ...payload });
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(hako, 'start');
  let state = await act(hako, 'claim_hako');
  const first = people.find(person => person.playerId === state.setup.turnPlayerId);
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(identity => sessionStorage.setItem('hako.room.session.v1', JSON.stringify(identity)), first);
  const page = await context.newPage();
  await page.addLocatorHandler(page.locator('#event-dialog[open]'), async () => { await page.keyboard.press('Escape'); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?room=${hako.roomCode}`);
  await page.getByTestId('initial-dealt-item').first().waitFor({ state: 'attached' });
  assert.equal(await page.getByTestId('item-choice').count(), 0);
  await page.locator('.initial-deal-panel > details > summary').click();
  await page.locator('.draft-chosen-item summary').first().waitFor();
  await page.locator('.draft-chosen-item summary').first().click();
  assert.equal(await page.locator('.draft-chosen-item .item-description').first().textContent(), INITIAL_ITEMS.find(item => item.id === 'night_vision').description);
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  state = await act(hako, 'prepare_opening');
  state = await act(hako, 'choose_secrets', { password: [1, 3, 5], weakness: 'gasoline' });
  state = await act(hako, 'place_remains', { cornerId: 'hall_clock' });
  state = await act(hako, 'inspect_initial_room', { roomId: 'children_room' });
  state = await act(hako, 'choose_initial_hiding', { cornerId: 'children_bed' });
  state = await act(hako, 'choose_initial_power', { powerId: state.opening.initialPowerOptions.find(card => card.canChoose !== false).id });
  await act(first, 'silent_reveal', { index: 0 });
  await page.getByTestId('active-item-select').waitFor();
  for (const itemId of ['dowsing_rod', 'suitcase']) {
    await page.getByTestId('active-item-select').selectOption(itemId);
    assert.equal(await page.getByTestId('active-item-description').textContent(), INITIAL_ITEMS.find(item => item.id === itemId).description);
    assert.equal(await page.getByTestId('active-item-description').isVisible(), true);
  }
  const owned = page.locator('[data-testid="inventory-item"][data-item-id="suitcase"]');
  await owned.locator('summary').click();
  assert.match(await owned.locator('.item-description').textContent(), /消耗标准行动/);
  await act(first, 'peek', { cornerId: 'hall_clock', useNightVision: true });
  await act(hako, 'resolve_visitor_action');
  await page.getByTestId('night-vision-item').waitFor();
  for (const itemId of ['spirit_pen', 'nightmare_letter']) {
    await page.getByTestId('night-vision-item').selectOption(itemId);
    assert.equal(await page.getByTestId('night-vision-item-description').textContent(), INITIAL_ITEMS.find(item => item.id === itemId).description);
    assert.equal(await page.getByTestId('night-vision-item-description').isVisible(), true);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
