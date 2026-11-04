import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

async function game(t, createPlayState = createPlay) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-feedback-http-'));
  let server, base;
  async function restart() {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState,
      initialItemOrder: ['walkie_talkie', 'spirit_pen', 'ventriloquist_doll'],
      dataFile: join(directory, 'rooms.json') });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await restart();
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  const people = [(await request('/api/rooms', { name: '箱娃' })).body];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const joined = await request(`/api/rooms/${people[0].roomCode}/join`, { name });
    assert.equal(joined.status, 201);
    people.push(joined.body);
  }
  async function action(person, type, values = {}) {
    return request(`/api/rooms/${person.roomCode}/actions`, { playerId: person.playerId,
      token: person.token, type, ...values });
  }
  async function act(person, type, values = {}) {
    const response = await action(person, type, values);
    assert.equal(response.status, 200, `${type}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  async function snapshot(person = people[0], poll = false) {
    const response = await request(`/api/rooms/${person.roomCode}?${new URLSearchParams({
      playerId: person.playerId, token: person.token, ...(poll ? { poll: '1' } : {}),
    })}`);
    assert.equal(response.status, 200);
    return response.body;
  }
  for (const person of people) await act(person, 'ready', { ready: true });
  await act(people[0], 'start');
  let state = await act(people[0], 'claim_hako');
  assert.equal(state.initialItems.length, 3);
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = await act(person, 'draw');
    state = await act(person, 'place', state.setup.legalPlacements[0]);
  }
  const hako = people[0];
  await act(hako, 'prepare_opening');
  await act(hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await act(hako, 'place_remains', { cornerId: 'living_sofa' });
  await act(hako, 'inspect_initial_room', { roomId: 'children_room' });
  await act(hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  return { people, act, action, snapshot, restart, dataFile: join(directory, 'rooms.json') };
}

test('a pending NO4 candidate is preserved on restart but rejected atomically while other initial powers remain selectable', async t => {
  const g = await game(t);
  const data = JSON.parse(await readFile(g.dataFile, 'utf8'));
  data.rooms[0].opening.initialPowerCandidates = [4, 2, 3];
  await writeFile(g.dataFile, JSON.stringify(data), 'utf8');
  await g.restart();
  const [hako] = g.people;
  const before = await g.snapshot(hako);
  const bytes = await readFile(g.dataFile, 'utf8');
  assert.deepEqual(before.opening.initialPowerOptions.map(card => card.id), [4, 2, 3]);
  assert.equal(before.opening.initialPowerOptions[0].canChoose, false);
  const rejected = await g.action(hako, 'choose_initial_power', { powerId: 4 });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /不能选作初始能力/);
  assert.deepEqual(await g.snapshot(hako), before);
  assert.equal(await readFile(g.dataFile, 'utf8'), bytes);
  await g.restart();
  assert.deepEqual((await g.snapshot(hako)).opening.initialPowerOptions, before.opening.initialPowerOptions);
  const chosen = await g.act(hako, 'choose_initial_power', { powerId: 2 });
  assert.equal(chosen.phase, 'practice');
  const stored = JSON.parse(await readFile(g.dataFile, 'utf8')).rooms[0];
  assert.equal(stored.opening.powerDeck.filter(id => id === 4).length, 1);
  assert.equal(stored.play.powers.deck.filter(id => id === 4).length, 1);
});

function moveToken(play, tokenId, destination) {
  const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === tokenId);
  assert.ok(source, `Fixture must relocate an existing token: ${tokenId}`);
  if (typeof destination === 'string') {
    [play.tokens[source], play.tokens[destination]] = [play.tokens[destination], play.tokens[source]];
  } else {
    play.inventories[destination.playerId].tokens.push(play.tokens[source]);
    play.tokens[source] = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
  }
}

function feedbackFixture(setup, opening, options) {
  const play = createPlay(setup, opening, options);
  moveToken(play, 'notebook_2', 'bathroom_toilet');
  moveToken(play, 'password_4', { playerId: setup.visitorIds[0] });
  moveToken(play, 'password_5', { playerId: setup.visitorIds[1] });
  moveToken(play, 'password_6', 'bathroom_washer');
  play.round.visitors[0].roomId = 'bathroom_room';
  return play;
}

async function nextHakoStage(g) {
  for (let count = 0; count < 20; count++) {
    const state = await g.snapshot();
    const round = state.round;
    if (round.phase === 'hako_phase') return state;
    if (round.phase === 'hako_reaction') {
      await g.act(g.people[0], 'pass_noise_reaction');
      continue;
    }
    const person = g.people.find(person => person.playerId === round.silent.turnPlayerId);
    const own = await g.snapshot(person);
    if (round.phase === 'visitor_reveal') {
      await g.act(person, 'silent_reveal', { index: own.round.silent.cards.find(card => card.status === 'down').index });
    } else {
      assert.equal(round.phase, 'visitor_action');
      assert.ok(own.round.moveTargets.length);
      await g.act(person, 'move', { roomId: own.round.moveTargets[0] });
      await g.act(g.people[0], 'resolve_visitor_action');
    }
  }
  assert.fail('A normal silent cycle must reach the next hako stage');
}

test('three initial candidates persist across reload and restart and remain private to hako', { timeout: 20000 }, async t => {
  let created = 0;
  const g = await game(t, (...args) => { created++; return createPlay(...args); });
  const [hako, first, second] = g.people;
  const before = await g.snapshot(hako);
  const candidates = before.opening.initialPowerOptions;
  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map(card => card.id)).size, 3);
  assert.ok(candidates.every(card => card.id >= 1 && card.id <= 11 && card.description));
  assert.deepEqual((await g.snapshot(hako, true)).opening.initialPowerOptions, candidates);
  for (const person of [first, second]) {
    const view = await g.snapshot(person);
    assert.equal(Object.hasOwn(view.opening, 'initialPowerOptions'), false);
    assert.equal(Object.hasOwn(view.opening, 'initialPowerId'), false);
    assert.equal(Object.hasOwn(view.opening, 'lastInspectedRoom'), false);
  }
  await g.restart();
  assert.deepEqual((await g.snapshot(hako)).opening.initialPowerOptions, candidates);
  const absent = Array.from({ length: 11 }, (_, index) => index + 1).find(id => !candidates.some(card => card.id === id));
  assert.equal((await g.action(hako, 'choose_initial_power', { powerId: absent })).status, 409);
  assert.equal((await g.snapshot(hako)).version, before.version);
  await g.act(hako, 'choose_initial_power', { powerId: candidates.find(card => card.canChoose !== false).id });
  assert.equal((await g.snapshot(hako)).initialPower.id, candidates.find(card => card.canChoose !== false).id);
  for (const person of [first, second]) {
    const view = await g.snapshot(person, true);
    assert.equal(view.initialPower == null, true);
    assert.equal(Object.hasOwn(view.round.powers, 'hand'), false);
  }
  await g.restart();
  assert.equal((await g.snapshot(hako)).initialPower.id, candidates.find(card => card.canChoose !== false).id);
  assert.equal((await g.snapshot(first)).initialPower == null, true);
  assert.equal(created, 1, 'Restart restores the chosen ability without creating another play state');
});

test('global discoveries preserve action and inventory privacy while cry markers and total rounds survive restart', { timeout: 25000 }, async t => {
  const g = await game(t, feedbackFixture);
  const [hako, first, second, third] = g.people;
  const candidates = (await g.snapshot()).opening.initialPowerOptions;
  await g.act(hako, 'choose_initial_power', { powerId: candidates.find(card => card.canChoose !== false).id });
  const before = await g.snapshot(first);
  assert.equal(before.round.totalRounds, 0);
  assert.equal(JSON.stringify(await g.snapshot(third)).includes('password_4'), false);
  assert.equal((await g.action(second, 'publish_token', { tokenId: 'password_4' })).status, 409);
  const published = await g.act(first, 'publish_token', { tokenId: 'password_4' });
  assert.deepEqual(published.round.silent, before.round.silent, 'Public disclosure uses no standard action');
  assert.deepEqual(published.round.inventory, before.round.inventory, 'Disclosure does not move the carried piece');
  for (const person of g.people) {
    const view = await g.snapshot(person, true);
    assert.equal(view.round.publicDiscoveries[0].token.id, 'password_4');
    if (person !== second) assert.equal(JSON.stringify(view.round.inventory).includes('password_5'), false);
    if (person === third) assert.equal(JSON.stringify(view).includes('password_5'), false);
  }
  const revealed = await g.act(first, 'silent_reveal', { index: 0 });
  assert.ok(revealed.round.peekTargets.includes('bathroom_toilet'), 'A visitor in the bathroom can peek into its printed stall');
  await g.act(first, 'peek', { cornerId: 'bathroom_toilet' });
  await g.act(hako, 'resolve_visitor_action');
  const found = await g.snapshot(first);
  assert.equal(found.round.resolution.token.power.id, 2);
  assert.match(found.round.resolution.token.power.description, /先发动/);
  assert.equal(found.round.notebooks[0].power.name, '马上就到哟');
  assert.equal((await g.action(first, 'publish_token', { tokenId: 'notebook_2' })).status, 409, 'Notebooks are already mandatory public information');
  const disclosed = await g.snapshot(first);
  assert.deepEqual(disclosed.round.silent, found.round.silent);
  assert.deepEqual(disclosed.round.resolution, found.round.resolution, 'The player still chooses the normal peek resolution');
  for (const person of g.people) assert.equal((await g.snapshot(person)).round.publicDiscoveries.length, 1);
  await g.restart();
  assert.equal((await g.snapshot(first)).round.resolution.token.power.id, 2);
  assert.equal((await g.snapshot(third)).round.publicDiscoveries.length, 1);
  await g.act(first, 'resolve_peek', { take: true, replacement: 'empty_box' });
  for (const person of [second, third]) {
    const own = await g.snapshot(person);
    await g.act(person, 'silent_reveal', { index: own.round.silent.cards.find(card => card.status === 'down').index });
    await g.act(person, 'move', { roomId: (await g.snapshot(person)).round.moveTargets[0] });
    await g.act(hako, 'resolve_visitor_action');
  }
  await g.act(first, 'silent_reveal', { index: 3 });
  await g.act(first, 'peek', { cornerId: 'bathroom_washer' });
  await g.act(hako, 'resolve_visitor_action');
  const privateFind = await g.snapshot(first);
  assert.equal(privateFind.round.resolution.token.id, 'password_6');
  assert.equal(JSON.stringify(await g.snapshot(third)).includes('password_6'), false);
  const publicFind = await g.act(first, 'publish_token', { tokenId: 'password_6' });
  assert.deepEqual(publicFind.round.silent, privateFind.round.silent);
  assert.deepEqual(publicFind.round.resolution, { ...privateFind.round.resolution, canPublish: false });
  assert.equal((await g.snapshot(third)).round.publicDiscoveries.at(-1).token.id, 'password_6');
  await g.act(first, 'resolve_peek', { take: false });
  let stage = await nextHakoStage(g);
  assert.equal(stage.round.totalRounds, 1);
  await g.act(hako, 'hako_cry');
  let announcement = (await g.snapshot(third)).round.powers.announcement;
  assert.deepEqual(announcement, { roomId: 'children_room', cycle: 1 });
  assert.equal(Object.hasOwn(announcement, 'cornerId'), false);
  await g.restart();
  assert.deepEqual((await g.snapshot(third)).round.powers.announcement, announcement);
  assert.equal((await g.snapshot(hako)).round.totalRounds, 1);
  await g.act(hako, 'begin_hako_action');
  await g.act(hako, 'inspect_hiding_room', { roomId: 'children_room' });
  await g.act(hako, 'hako_hide', { cornerId: 'children_cabinet' });
  assert.deepEqual((await g.snapshot(third)).round.powers.announcement, announcement);
  assert.equal((await g.snapshot(third)).round.totalRounds, 1);
  stage = await nextHakoStage(g);
  assert.equal(stage.round.totalRounds, 2);
  assert.equal(stage.round.powers.announcement, null);
  await g.restart();
  assert.equal((await g.snapshot(third)).round.totalRounds, 2);
  assert.equal((await g.snapshot(third)).round.powers.announcement, null);
});

test('door ability metadata stays private unless hako explicitly publishes the activation', { timeout: 20000 }, async t => {
  for (const publish of [false, true]) {
    const g = await game(t, (setup, opening, options) => {
      const play = createPlay(setup, opening, options);
      const inHand = play.powers.hand.findIndex(card => card.id === 3);
      let card;
      if (inHand >= 0) card = play.powers.hand.splice(inHand, 1)[0];
      else {
        const inDeck = play.powers.deck.indexOf(3);
        assert.notEqual(inDeck, -1, 'The trusted fixture moves the existing door card');
        play.powers.deck.splice(inDeck, 1);
        card = { id: 3, ignoreThreshold: false };
      }
      play.powers.slots[0] = { ...card, faceUp: false };
      return play;
    });
    const [hako, first] = g.people;
    const candidates = (await g.snapshot()).opening.initialPowerOptions;
    await g.act(hako, 'choose_initial_power', { powerId: candidates.find(card => card.canChoose !== false).id });
    await nextHakoStage(g);
    const stage = await g.act(hako, 'begin_hako_action');
    const option = stage.round.powers.activationOptions.find(option => option.card.id === 3);
    assert.ok(option.canActivate && option.doors.length);
    const door = option.doors[0];
    await g.act(hako, 'activate_power', { slot: 0, fromRoomId: door.fromRoomId,
      toRoomId: door.toRoomId, ...(publish ? { public: true } : {}) });
    const own = await g.snapshot(hako);
    assert.equal(own.round.blockedDoors.length, 1);
    const visitor = await g.snapshot(first, true);
    assert.equal(visitor.round.blockedDoors.length, publish ? 1 : 0);
    assert.equal(visitor.round.powers.lastActivation.powerId, publish ? 3 : undefined);
    assert.equal(visitor.round.powers.lastActivation.name, publish ? '打不开的门' : undefined);
    assert.equal(JSON.stringify(visitor).includes('sourcePowerId'), false);
    await g.restart();
    const restored = await g.snapshot(first);
    assert.deepEqual(restored.round.blockedDoors, visitor.round.blockedDoors);
    assert.deepEqual(restored.round.powers.lastActivation, visitor.round.powers.lastActivation);
  }
});
