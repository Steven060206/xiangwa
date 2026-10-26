import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const underlyingTokens = corners => corners.map(({ id, token }) => ({
  id, token: token ? Object.fromEntries(Object.entries(token).filter(([key]) => key !== 'name')) : null,
}));

async function startServer(t, options = {}) {
  const server = createGameServer({ deck, silentNumbers: [5, 4, 1, 2, 0, 3], ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.listening && new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  return { base, request, server };
}

async function persistentServer(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-persistence-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const dataFile = join(directory, 'rooms.json');
  let running;
  async function restart() {
    if (running) await new Promise((resolve, reject) => running.server.close(error => error ? reject(error) : resolve()));
    running = await startServer(t, { ...options, dataFile });
  }
  await restart();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { dataFile, restart, request: (...args) => running.request(...args),
    get base() { return running.base; } };
}

async function checkRestart(saved, people) {
  const before = await Promise.all(people.map(async person => (await snapshot(saved.request, person)).body));
  await saved.restart();
  for (let i = 0; i < people.length; i++) {
    const recovered = await snapshot(saved.request, people[i]);
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, { ...before[i],
      players: before[i].players.map(player => ({ ...player, connected: false })),
    });
  }
}

async function createFour(request) {
  const first = await request('/api/rooms', { name: '箱娃' });
  assert.equal(first.status, 201);
  const identities = [first.body];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const joined = await request(`/api/rooms/${first.body.roomCode.toLowerCase()}/join`, { name });
    assert.equal(joined.status, 201);
    identities.push(joined.body);
  }
  return identities;
}

function action(request, identity, type, values = {}) {
  return request(`/api/rooms/${identity.roomCode}/actions`, {
    playerId: identity.playerId, token: identity.token, type, ...values,
  });
}

function snapshot(request, identity) {
  return request(`/api/rooms/${identity.roomCode}?${new URLSearchParams({
    playerId: identity.playerId, token: identity.token,
  })}`);
}

async function preparePlay(request, people) {
  for (const person of people) await action(request, person, 'ready', { ready: true });
  let state = (await action(request, people[0], 'start')).body;
  for (let index = 0; index < 3; index += 1) {
    const person = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = (await action(request, person, 'choose_item', { itemId: state.draft.availableItems[0].id })).body;
  }
  while (state.phase === 'map_setup') {
    const person = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = (await action(request, person, 'draw')).body;
    state = (await action(request, person, 'place', state.setup.legalPlacements[0])).body;
  }
  await action(request, people[0], 'prepare_opening');
  await action(request, people[0], 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  await action(request, people[0], 'place_remains', { cornerId: 'living_sofa' });
  await action(request, people[0], 'inspect_initial_room', { roomId: 'children_room' });
  await action(request, people[0], 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  const result = await action(request, people[0], 'choose_initial_power', { powerId: 1 });
  assert.equal(result.status, 200);
  return result.body;
}

async function stream(t, base, identity) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/rooms/${identity.roomCode}/events?${new URLSearchParams({
    playerId: identity.playerId, token: identity.token,
  })}`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const closed = () => { abort.abort(); return reader.cancel().catch(() => {}); };
  t.after(closed);
  return {
    close: closed,
    async state(predicate = () => true) {
      const readState = async () => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!event.startsWith('event: state\n')) continue;
            const state = JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6));
            if (predicate(state)) return state;
          } else {
            const { value, done } = await reader.read();
            assert.equal(done, false, 'SSE connection ended before matching state');
            buffer += decoder.decode(value, { stream: true });
          }
        }
      };
      let timeout;
      try {
        return await Promise.race([
          readState(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE state timed out')), 3000); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

test('four HTTP identities enforce lobby capacity, roles, readiness and authorization', async t => {
  const { request } = await startServer(t);
  for (const name of ['', '  ', '名'.repeat(17)]) {
    assert.equal((await request('/api/rooms', { name })).status, 400);
  }
  const people = await createFour(request);
  const [host, visitor, third, fourth] = people;
  assert.match(host.roomCode, /^[A-Z0-9]{6}$/);
  assert.equal(new Set(people.map(person => person.token)).size, 4);
  assert.equal(new Set(people.map(person => person.playerId)).size, 4);
  const state = (await snapshot(request, host)).body;
  assert.equal(state.hostId, host.playerId);
  assert.equal(state.players.find(player => player.role === 'hako').id, host.playerId);
  assert.deepEqual(state.players.map(player => player.seat), [0, 1, 2, 3]);
  assert.equal(state.you, host.playerId);
  assert.equal(state.setup, null);
  assert.ok(state.log.every(entry => typeof entry === 'string'));
  for (const person of people) assert.equal(JSON.stringify(state).includes(person.token), false);
  assert.equal((await request(`/api/rooms/${host.roomCode}/join`, { name: '第五人' })).status, 409);
  assert.equal((await action(request, { ...visitor, token: host.token }, 'ready', { ready: true })).status, 403);
  assert.equal((await request(`/api/rooms/${host.roomCode}`)).status, 403);
  assert.equal((await action(request, visitor, 'set_hako', { targetId: third.playerId })).status, 403);
  assert.equal((await action(request, visitor, 'start')).status, 403);
  assert.equal((await action(request, host, 'start')).status, 409);
  assert.equal((await action(request, visitor, 'ready', { ready: 'yes' })).status, 400);
  assert.equal((await action(request, visitor, 'ready', { ready: true })).status, 200);
  assert.equal((await action(request, host, 'set_hako', { targetId: third.playerId })).status, 200);
  const reassigned = (await snapshot(request, third)).body;
  assert.equal(reassigned.players.find(player => player.role === 'hako').id, third.playerId);
  assert.ok(reassigned.players.every(player => player.ready === false));
  for (const person of people) assert.equal((await action(request, person, 'ready', { ready: true })).status, 200);
  const started = await action(request, host, 'start');
  assert.equal(started.status, 200);
  assert.equal(started.body.phase, 'item_draft');
  assert.equal(started.body.draft.turnPlayerId, fourth.playerId, 'visitor after hako chooses first');
  assert.equal(started.body.draft.availableItems.length, 12);
  assert.equal((await action(request, third, 'choose_item', { itemId: 'spirit_pen' })).status, 409);
  assert.equal((await action(request, host, 'start')).status, 409);
  assert.equal((await action(request, host, 'set_hako', { targetId: host.playerId })).status, 409);
  assert.equal((await action(request, fourth, 'leave')).status, 409);
  assert.equal((await action(request, third, 'draw')).status, 409);
});

test('leaving the lobby frees a seat and transfers host authority', async t => {
  const { request } = await startServer(t);
  const [host, next] = await createFour(request);
  assert.equal((await action(request, host, 'leave')).status, 200);
  const state = (await snapshot(request, next)).body;
  assert.equal(state.hostId, next.playerId);
  assert.equal(state.players.length, 3);
  assert.equal(state.players.find(player => player.role === 'hako').id, next.playerId);
  assert.equal((await snapshot(request, host)).status, 403);
  const replacement = await request(`/api/rooms/${next.roomCode}/join`, { name: '替补' });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.state.players.length, 4);
  assert.equal(replacement.body.state.players.find(player => player.id === replacement.body.playerId).seat, 0);
});

test('SSE synchronizes all players, preserves disconnected seats and completes nine maps', async t => {
  const { base, request } = await startServer(t);
  const people = await createFour(request);
  const streams = [];
  for (const person of people) streams.push(await stream(t, base, person));
  const connected = await streams[0].state(state => state.players.every(player => player.connected));
  assert.equal(connected.you, people[0].playerId);
  await streams[3].close();
  await streams[0].state(state => !state.players.find(player => player.id === people[3].playerId).connected);
  assert.equal((await request(`/api/rooms/${people[0].roomCode}/join`, { name: '不能占位' })).status, 409);
  const resumed = (await snapshot(request, people[3])).body;
  assert.equal(resumed.you, people[3].playerId);
  assert.equal(resumed.players.length, 4);
  streams[3] = await stream(t, base, people[3]);
  await streams[0].state(state => state.players.every(player => player.connected));
  for (const person of people) await action(request, person, 'ready', { ready: true });
  let state = (await action(request, people[0], 'start')).body;
  for (let index = 0; index < 3; index += 1) {
    const current = people.find(person => person.playerId === state.draft.turnPlayerId);
    state = (await action(request, current, 'choose_item', { itemId: state.draft.availableItems[0].id })).body;
  }
  assert.equal(state.phase, 'map_setup');
  assert.equal(state.draft, null);
  assert.equal(state.initialItems.length, 3);
  assert.equal(state.setup.placements.length, 1);
  for (let turn = 0; turn < 8; turn += 1) {
    const current = people.find(person => person.playerId === state.setup.turnPlayerId);
    const other = people.find(person => person.playerId !== current.playerId);
    assert.equal((await action(request, other, 'draw')).status, 409);
    const draws = await Promise.all([action(request, current, 'draw'), action(request, current, 'draw')]);
    assert.deepEqual(draws.map(result => result.status).sort(), [200, 409]);
    const drawn = draws.find(result => result.status === 200).body;
    assert.equal(drawn.setup.drawnTileId, deck[turn]);
    assert.equal(Object.hasOwn(drawn.setup, 'deck'), false);
    assert.ok(drawn.setup.legalPlacements.length > 0);
    assert.equal((await action(request, current, 'place', { floor: 1, x: 0, y: 0, rotation: 0 })).status, 409);
    const placed = await action(request, current, 'place', drawn.setup.legalPlacements[0]);
    assert.equal(placed.status, 200);
    state = placed.body;
    assert.equal(state.setup.placements.length, turn + 2);
    assert.equal((await action(request, current, 'place', drawn.setup.legalPlacements[0])).status, 409);
    for (let index = 0; index < people.length; index += 1) {
      const update = await streams[index].state(update => update.version >= state.version);
      assert.equal(update.you, people[index].playerId);
      assert.deepEqual(update.setup, state.setup);
    }
  }
  assert.equal(state.phase, 'map_ready');
  assert.equal(state.setup.remaining, 0);
  assert.equal(state.setup.placements.length, 9);
  assert.equal((await action(request, people[1], 'draw')).status, 409);
  const finalViews = await Promise.all(people.map(person => snapshot(request, person)));
  for (const view of finalViews) assert.deepEqual(view.body.setup, state.setup);

  const [hako, firstVisitor] = people;
  assert.equal((await action(request, firstVisitor, 'prepare_opening')).status, 403);
  state = (await action(request, hako, 'prepare_opening')).body;
  assert.equal(state.phase, 'opening_setup');
  assert.equal((await action(request, firstVisitor, 'choose_secrets', {
    password: [1, 2, 3], weakness: 'gasoline',
  })).status, 409);
  const version = state.version;
  assert.equal((await action(request, hako, 'choose_secrets', {
    password: [1, 1, 2], weakness: 'gasoline',
  })).status, 409);
  assert.equal((await snapshot(request, hako)).body.version, version);

  async function assertPrivateViews() {
    const current = (await snapshot(request, hako)).body;
    for (let index = 1; index < people.length; index += 1) {
      const view = (await snapshot(request, people[index])).body;
      assert.equal(view.version, current.version);
      const text = JSON.stringify(view);
      for (const field of ['password', 'weakness', 'remainsCornerId', 'hidingCornerId', 'hidingUnderToken',
        'inspectedRoom', 'cornerTokens', 'powerDeck', 'hidingTargets', 'hidingRooms', 'cornerId']) {
        assert.equal(text.includes(`"${field}":`), false, `visitor HTTP must omit ${field}`);
      }
      const pushed = await streams[index].state(update => update.version >= current.version);
      assert.deepEqual(pushed, view, 'SSE must use the same filtered participant view as HTTP');
    }
  }

  state = (await action(request, hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' })).body;
  await assertPrivateViews();
  assert.equal(state.opening.corners.filter(corner => !corner.occupied).length, 1);
  assert.equal((await action(request, hako, 'place_remains', { cornerId: 'study_desk' })).status, 409);
  state = (await action(request, hako, 'place_remains', { cornerId: 'living_sofa' })).body;
  await assertPrivateViews();
  state = (await action(request, hako, 'inspect_initial_room', { roomId: 'children_room' })).body;
  await assertPrivateViews();
  assert.equal(state.opening.inspectedRoom.id, 'children_room');
  const initialContents = structuredClone(state.opening.inspectedRoom.corners);
  const initialCorner = state.opening.hidingTargets[0];
  assert.equal((await action(request, hako, 'inspect_initial_room', { roomId: 'dark_room' })).status, 409);
  assert.equal((await action(request, hako, 'choose_initial_hiding', { cornerId: 'dark_bed' })).status, 409);
  state = (await action(request, hako, 'choose_initial_hiding', { cornerId: state.opening.hidingTargets[0] })).body;
  await assertPrivateViews();
  assert.equal((await action(request, hako, 'choose_initial_power', { powerId: 4 })).status, 409);
  state = (await action(request, hako, 'choose_initial_power', { powerId: 1 })).body;
  await assertPrivateViews();
  assert.equal(state.phase, 'practice');
  assert.equal(state.initialPower.id, 1);
  assert.equal(state.round.visitors.every(visitor => visitor.roomId === 'hall_room'), true);
  assert.equal((await action(request, hako, 'prepare_opening')).status, 409);
  assert.equal((await action(request, hako, 'silent_reveal', { index: 0 })).status, 409);

  for (let index = 0; index < 3; index += 1) {
    const current = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    const revealed = await action(request, current, 'silent_reveal', { index });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.body.round.phase, 'visitor_action');
    assert.equal(revealed.body.round.silent.total, [5, 9, 10][index]);
    const target = revealed.body.round.moveTargets[0];
    const declared = await action(request, current, 'move', { roomId: target });
    assert.equal(declared.body.round.phase, 'visitor_reaction');
    assert.equal(declared.body.round.visitors.find(visitor => visitor.id === current.playerId).roomId, 'hall_room');
    assert.equal((await action(request, current, 'resolve_visitor_action')).status, 409);
    const resolved = await action(request, hako, 'resolve_visitor_action');
    assert.equal(resolved.status, 200);
    state = resolved.body;
    assert.equal(state.round.visitors.find(visitor => visitor.id === current.playerId).roomId, target);
  }
  const interrupted = state.round.silent.turnPlayerId;
  const current = people.find(person => person.playerId === interrupted);
  state = (await action(request, current, 'silent_reveal', { index: 3 })).body;
  assert.equal(state.round.phase, 'hako_reaction');
  assert.equal(state.round.silent.total, 12);
  assert.equal((await action(request, current, 'move', { roomId: 'hall_room' })).status, 409);
  assert.equal((await action(request, current, 'pass_noise_reaction')).status, 409);
  state = (await action(request, hako, 'pass_noise_reaction')).body;
  assert.equal(state.round.phase, 'hako_phase');
  await assertPrivateViews();
  assert.equal(state.round.powers.step, 'preparation');
  state = (await action(request, hako, 'begin_hako_action')).body;
  assert.equal((await action(request, hako, 'hako_hide', { cornerId: initialCorner })).status, 409);
  assert.equal((await action(request, firstVisitor, 'inspect_hiding_room', { roomId: 'children_room' })).status, 409);
  state = (await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).body;
  assert.deepEqual(underlyingTokens(state.round.hako.inspectedRoom.corners), initialContents);
  assert.equal((await action(request, hako, 'inspect_hiding_room', { roomId: 'dark_room' })).status, 409);
  await assertPrivateViews();
  const nextHiding = state.round.hako.hidingTargets.find(id => id !== initialCorner);
  state = (await action(request, hako, 'hako_hide', { cornerId: nextHiding })).body;
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.silent.turnPlayerId, interrupted);
  assert.equal(state.round.silent.cards.every(card => card.status === 'down' && !Object.hasOwn(card, 'number')), true);
  await assertPrivateViews();
  for (let index = 0; index < 5; index += 1) {
    const visitor = people.find(person => person.playerId === state.round.silent.turnPlayerId);
    const skipped = await action(request, visitor, 'silent_skip', { index });
    assert.equal(skipped.status, 200);
    state = skipped.body;
  }
  assert.equal(state.round.phase, 'hako_phase');
  assert.equal(state.round.silent.trigger, 'one_hidden');
  assert.equal(state.round.silent.cards.filter(card => card.status === 'held').length, 5);
  state = (await action(request, hako, 'begin_hako_action')).body;
  state = (await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).body;
  assert.deepEqual(underlyingTokens(state.round.hako.inspectedRoom.corners), initialContents,
    'Moving hiding markers restores the old corner and preserves the marker held beneath the new one');
  state = (await action(request, hako, 'hako_hide', { cornerId: nextHiding })).body;
  assert.equal(state.round.silent.cycle, 3);
  assert.equal(state.round.silent.cards.every(card => card.status === 'down'), true);
});

test('HTTP and SSE isolate peeks, inventories, deliberate sharing and consensual transfers', async t => {
  let firstId;
  const { base, request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      firstId = setup.visitorIds[0];
      const found = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'password' && play.tokens[id].number === 4);
      [play.tokens.hall_clock, play.tokens[found]] = [play.tokens[found], play.tokens.hall_clock];
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second, third] = people;
  assert.equal(first.playerId, firstId);
  const streams = await Promise.all(people.map(person => stream(t, base, person)));
  await action(request, first, 'silent_reveal', { index: 0 });
  const declared = await action(request, first, 'peek', { cornerId: 'hall_clock', useNightVision: false });
  assert.equal(declared.status, 200);
  assert.equal(declared.body.round.resolution, null);
  assert.equal((await action(request, second, 'resolve_visitor_action')).status, 409);
  const confirmed = await action(request, hako, 'resolve_visitor_action');
  assert.equal(confirmed.status, 200);
  for (let index = 0; index < people.length; index += 1) {
    const view = (await snapshot(request, people[index])).body;
    const pushed = await streams[index].state(update => update.version >= confirmed.body.version);
    assert.deepEqual(pushed, view);
    if (index === 1) {
      assert.equal(view.round.resolution.token.number, 4);
      assert.equal(view.round.resolution.token.type, 'password');
    } else {
      assert.deepEqual(view.round.resolution, { kind: 'waiting', playerId: firstId });
      assert.equal(JSON.stringify(view.round).includes('password_4'), false);
    }
  }
  const before = (await snapshot(request, first)).body;
  assert.equal((await action(request, second, 'resolve_peek', { take: true, replacement: 'empty_box' })).status, 409);
  assert.equal((await action(request, first, 'resolve_peek', { take: true, replacement: 'none' })).status, 409);
  assert.deepEqual((await snapshot(request, first)).body, before);
  const taken = await action(request, first, 'resolve_peek', { take: true, replacement: 'empty_box' });
  assert.equal(taken.status, 200);
  const tokenId = taken.body.round.inventory.tokens[0].id;
  assert.equal(taken.body.round.inventory.tokens[0].number, 4);
  assert.equal(taken.body.round.silent.turnPlayerId, second.playerId);
  assert.equal((await snapshot(request, hako)).body.round.inventory.tokens.length, 0);
  await action(request, first, 'show_token', { tokenId, targetId: second.playerId });
  assert.equal((await snapshot(request, second)).body.round.sharedTokens.token.id, tokenId);
  assert.equal((await snapshot(request, third)).body.round.sharedTokens, null);
  let offered = await action(request, first, 'offer_exchange', {
    targetId: second.playerId, giveTokenIds: [tokenId],
  });
  assert.equal(offered.status, 200);
  const offerId = offered.body.round.exchangeOffers[0].id;
  const recipient = (await snapshot(request, second)).body;
  assert.equal(recipient.round.exchangeOffers[0].giveTokens[0].number, 4);
  assert.equal((await snapshot(request, third)).body.round.exchangeOffers.length, 0);
  assert.equal((await action(request, third, 'respond_exchange', { offerId, accept: true })).status, 409);
  assert.equal((await action(request, second, 'respond_exchange', { offerId, accept: true })).status, 200);
  assert.equal((await snapshot(request, first)).body.round.inventory.tokens.length, 0);
  assert.equal((await snapshot(request, second)).body.round.inventory.tokens[0].id, tokenId);
  assert.equal((await action(request, second, 'respond_exchange', { offerId, accept: true })).status, 409);
  for (const requested of [[tokenId], ['unknown_secret_id']]) {
    offered = await action(request, third, 'offer_exchange', { targetId: second.playerId, requestTokenIds: requested });
    assert.equal(offered.status, 200, 'The sender must not learn whether a guessed private id exists');
    const requestOffer = offered.body.round.exchangeOffers.at(-1);
    assert.equal(Object.hasOwn(requestOffer, 'requestTokens'), false);
  }
  const logs = (await snapshot(request, hako)).body.log.join('\n');
  assert.equal(logs.includes(tokenId), false);
  assert.equal(logs.includes('密码4'), false);
});

test('HTTP deaths hide ghost locations, preserve one-person turns, and lock a declared result', async t => {
  const { request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      play.round.hidingCornerId = 'hall_clock';
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, ...visitors] = people;
  for (let index = 0; index < 2; index += 1) {
    const person = visitors[index];
    await action(request, person, 'silent_reveal', { index });
    await action(request, person, 'peek', { cornerId: 'hall_clock' });
    assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
    const owner = (await snapshot(request, person)).body;
    assert.equal(owner.round.ghost.cornerId, 'hall_clock');
    assert.equal(owner.round.visitors.find(player => player.id === person.playerId).status, 'box_person');
    const living = (await snapshot(request, visitors[2])).body;
    assert.equal(Object.hasOwn(living.round.visitors[index], 'roomId'), false);
    assert.equal(Object.hasOwn(living.round, 'ghost'), false);
    assert.equal(living.round.hako.cornerId, undefined);
    assert.equal((await action(request, person, 'silent_reveal', { index: index + 1 })).status, 409);
  }
  let state = (await snapshot(request, visitors[2])).body;
  assert.equal(state.round.silent.turnPlayerId, visitors[2].playerId);
  const voted = await action(request, visitors[2], 'surrender');
  assert.equal(voted.status, 200);
  assert.equal(voted.body.phase, 'game_over');
  assert.equal(voted.body.round.result.winner, 'hako');
  assert.equal((await action(request, visitors[2], 'silent_reveal', { index: 2 })).status, 409);
  assert.equal((await action(request, hako, 'pass_noise_reaction')).status, 409);
  state = (await snapshot(request, visitors[2])).body;
  assert.deepEqual(state, voted.body);
});

test('HTTP and SSE keep phone results and false answers private while allowing a forced-peek interruption', async t => {
  const { base, request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const phoneIndex = play.availableItems.findIndex(item => item.id === 'smartphone');
      play.inventories[setup.visitorIds[0]].items.push(play.availableItems.splice(phoneIndex, 1)[0]);
      for (const id of [4, 6, 9]) play.powers.deck.splice(play.powers.deck.indexOf(id), 1);
      play.powers.hand.push({ id: 4, ignoreThreshold: false });
      play.powers.slots = [{ id: 6, ignoreThreshold: true, faceUp: false }, { id: 9, ignoreThreshold: false, faceUp: false }];
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_4');
      [play.tokens.hall_clock, play.tokens[source]] = [play.tokens[source], play.tokens.hall_clock];
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second, third] = people;
  const streams = await Promise.all(people.map(person => stream(t, base, person)));
  const initial = (await snapshot(request, first)).body;
  assert.deepEqual(initial.round.powers.slots.map(slot => slot.card), [undefined, undefined]);
  assert.equal(initial.round.powers.hand, undefined);
  assert.equal((await action(request, first, 'activate_power', { slot: 0 })).status, 409);
  assert.deepEqual((await snapshot(request, first)).body, initial);
  await action(request, first, 'silent_reveal', { index: 0 });
  assert.equal((await action(request, first, 'use_item', { itemId: 'smartphone', targetZone: 'hand', index: 1 })).status, 200);
  const photo = await action(request, hako, 'resolve_visitor_action');
  assert.equal(photo.status, 200);
  for (let index = 0; index < people.length; index++) {
    const state = (await snapshot(request, people[index])).body;
    assert.deepEqual(await streams[index].state(update => update.version >= photo.body.version), state);
    assert.equal(state.round.items.result?.card?.id, index === 1 ? 4 : undefined);
    if (index > 1) assert.equal(JSON.stringify(state).includes('动来动去'), false);
  }
  await action(request, second, 'silent_reveal', { index: 1 });
  await action(request, second, 'use_item', { itemId: 'spirit_pen', roomId: 'children_room' });
  const question = await action(request, hako, 'resolve_visitor_action');
  assert.equal(question.body.round.resolution.truth, true);
  for (const person of people.slice(1)) {
    const waiting = (await snapshot(request, person)).body.round.resolution;
    assert.deepEqual(waiting, { kind: 'waiting', playerId: hako.playerId });
  }
  const beforeAnswer = (await snapshot(request, second)).body;
  assert.equal((await action(request, second, 'answer_item', { answer: true })).status, 409);
  assert.deepEqual((await snapshot(request, second)).body, beforeAnswer);
  const answer = await action(request, hako, 'answer_item', { answer: false });
  assert.equal(answer.status, 200);
  for (let index = 1; index < people.length; index++) {
    const state = await streams[index].state(update => update.version >= answer.body.version);
    assert.equal(state.round.items.events.at(-1).answer, false);
    assert.equal(Object.hasOwn(state.round.items.events.at(-1), 'truth'), false);
    assert.equal(state.round.powers.slots[1].card, undefined, 'A false response must not reveal the hidden NO.9 card');
  }
  await action(request, third, 'silent_reveal', { index: 2 });
  await action(request, third, 'use_item', { itemId: 'ventriloquist_doll', roomId: 'study_room' });
  assert.equal((await action(request, hako, 'activate_power', { slot: 0 })).status, 200);
  const forced = (await snapshot(request, third)).body;
  assert.equal(forced.round.resolution.kind, 'forced_peek');
  assert.ok(forced.round.resolution.cornerIds.includes('hall_clock'));
  assert.equal(forced.round.pendingAction, null);
  assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 409);
  const picked = await action(request, third, 'choose_forced_peek', { cornerId: 'hall_clock' });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.round.resolution.token.number, 4);
  assert.equal((await action(request, third, 'resolve_peek', { take: false })).status, 200);
  const logs = (await snapshot(request, hako)).body.log.join('\n');
  assert.equal(logs.includes('动来动去'), false);
  assert.equal(logs.includes('password_4'), false);
});

test('HTTP extinguisher windows block progression and cancel NO.5 without exposing hidden victims', async t => {
  const { request } = await startServer(t, {
    createPlayState(setup, opening, options) {
      const play = createPlay(setup, opening, options);
      const source = Object.keys(play.tokens).find(id => play.tokens[id]?.type === 'extinguisher');
      play.inventories[setup.visitorIds[0]].tokens.push(play.tokens[source]);
      play.tokens[source] = null;
      play.powers.deck.splice(play.powers.deck.indexOf(5), 1);
      play.powers.slots[0] = { id: 5, ignoreThreshold: true, faceUp: false };
      return play;
    },
  });
  const people = await createFour(request);
  await preparePlay(request, people);
  const [hako, first, second] = people;
  let state;
  for (let index = 0; index < 3; index++) {
    const person = people[index + 1];
    state = (await action(request, person, 'silent_reveal', { index })).body;
    await action(request, person, 'move', { roomId: state.round.moveTargets[0] });
    assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
  }
  state = (await action(request, first, 'silent_reveal', { index: 3 })).body;
  assert.deepEqual(state.round.interruption, { kind: 'noise', canRespond: true });
  assert.equal((await action(request, hako, 'pass_noise_reaction')).status, 409);
  assert.equal((await action(request, second, 'extinguisher_response', { use: true })).status, 409);
  assert.equal((await action(request, first, 'extinguisher_response', { use: false })).status, 200);
  await action(request, hako, 'pass_noise_reaction');
  await action(request, hako, 'begin_hako_action');
  const activation = await action(request, hako, 'activate_power', { slot: 0 });
  assert.equal(activation.status, 200);
  state = (await snapshot(request, first)).body;
  assert.deepEqual(state.round.interruption, { kind: 'power', canRespond: true });
  assert.equal(JSON.stringify(state).includes('killerCornerId'), false);
  assert.equal(JSON.stringify(state).includes('restorePowers'), false);
  assert.equal((await action(request, hako, 'inspect_hiding_room', { roomId: 'children_room' })).status, 409);
  state = (await action(request, first, 'extinguisher_response', { use: true })).body;
  assert.equal(state.round.silent.cycle, 2);
  assert.equal(state.round.phase, 'visitor_reveal');
  assert.equal(state.round.silent.turnPlayerId, first.playerId);
  assert.equal(state.round.inventory.tokens.some(token => token.type === 'extinguisher'), false);
  assert.ok(state.round.visitors.every(visitor => visitor.status === 'alive'));
  const owner = (await snapshot(request, hako)).body;
  assert.equal(owner.round.powers.slots[0].card.id, 5);
  assert.equal(owner.round.powers.slots[0].faceUp, false);
  assert.equal((await action(request, first, 'extinguisher_response', { use: true })).status, 409);
});

test('stored lobbies recover identities, roles, presence and multiple rooms; leaving stays final', async t => {
  const saved = await persistentServer(t);
  const people = await createFour(saved.request);
  const other = (await saved.request('/api/rooms', { name: '另一房间' })).body;
  await action(saved.request, people[0], 'set_hako', { targetId: people[2].playerId });
  await action(saved.request, people[1], 'ready', { ready: true });
  const live = await stream(t, saved.base, people[0]);
  assert.equal((await live.state()).players[0].connected, true);
  const disk = JSON.parse(await readFile(saved.dataFile, 'utf8'));
  assert.equal(disk.rooms.length, 2);
  assert.ok(disk.rooms.every(room => room.players.every(player => !Object.hasOwn(player, 'connections'))));
  await checkRestart(saved, [...people, other]);
  assert.equal((await snapshot(saved.request, { ...people[0], token: people[1].token })).status, 403);
  await action(saved.request, people[0], 'leave');
  await action(saved.request, other, 'leave');
  await saved.restart();
  assert.equal((await snapshot(saved.request, people[0])).status, 403);
  assert.equal((await snapshot(saved.request, other)).status, 404);
  const remaining = (await snapshot(saved.request, people[1])).body;
  assert.equal(remaining.hostId, people[1].playerId);
  assert.equal(remaining.players.length, 3);
  assert.equal((await saved.request(`/api/rooms/${people[0].roomCode}/join`, { name: '替补' })).body.state.players.length, 4);
});

test('draft, a drawn map, secret opening and original shuffled decks survive restarts', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const people = await createFour(request);
  for (const person of people) await action(request, person, 'ready', { ready: true });
  let state = (await action(request, people[0], 'start')).body;
  const first = people.find(person => person.playerId === state.draft.turnPlayerId);
  await action(request, first, 'choose_item', { itemId: 'spirit_pen' });
  await checkRestart(saved, people);
  for (let i = 0; i < 2; i++) {
    state = (await snapshot(request, people[0])).body;
    const current = people.find(person => person.playerId === state.draft.turnPlayerId);
    await action(request, current, 'choose_item', { itemId: state.draft.availableItems[0].id });
  }
  state = (await snapshot(request, people[0])).body;
  while (state.phase === 'map_setup') {
    const current = people.find(person => person.playerId === state.setup.turnPlayerId);
    state = (await action(request, current, 'draw')).body;
    if (state.setup.placements.length === 1) {
      const before = await readFile(saved.dataFile, 'utf8');
      await checkRestart(saved, people);
      assert.equal(await readFile(saved.dataFile, 'utf8'), before, 'Loading must not reshuffle the remaining maps');
    }
    state = (await action(request, current, 'place', state.setup.legalPlacements[0])).body;
  }
  await action(request, people[0], 'prepare_opening');
  await action(request, people[0], 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
  const before = await readFile(saved.dataFile, 'utf8');
  await checkRestart(saved, people);
  assert.equal(await readFile(saved.dataFile, 'utf8'), before, 'Loading must preserve randomly assigned corner tokens');
  await action(request, people[0], 'place_remains', { cornerId: 'living_sofa' });
  await action(request, people[0], 'inspect_initial_room', { roomId: 'children_room' });
  await checkRestart(saved, people);
  await action(request, people[0], 'choose_initial_hiding', { cornerId: 'children_cabinet' });
  assert.equal((await action(request, people[0], 'choose_initial_power', { powerId: 1 })).status, 200);
  await checkRestart(saved, people);
});

test('pending peeks, private results, inventory, exchanges and the final result recover without leaks', async t => {
  let created = 0;
  const saved = await persistentServer(t, { createPlayState(setup, opening, options) {
    created++;
    const play = createPlay(setup, opening, options);
    const source = Object.keys(play.tokens).find(id => play.tokens[id]?.id === 'password_4');
    [play.tokens.hall_clock, play.tokens[source]] = [play.tokens[source], play.tokens.hall_clock];
    return play;
  } });
  const { request } = saved;
  const people = await createFour(request);
  const [hako, first, second, third] = people;
  await preparePlay(request, people);
  await action(request, first, 'silent_reveal', { index: 0 });
  await action(request, first, 'peek', { cornerId: 'hall_clock' });
  await checkRestart(saved, people);
  assert.equal((await action(request, hako, 'resolve_visitor_action')).status, 200);
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, first)).body.round.resolution.token.id, 'password_4');
  for (const person of [hako, second, third]) {
    const live = await stream(t, saved.base, person);
    const view = await live.state();
    assert.deepEqual(view.round.resolution, { kind: 'waiting', playerId: first.playerId });
    assert.equal(JSON.stringify(view).includes('password_4'), false);
    await live.close();
  }
  await action(request, first, 'resolve_peek', { take: true, replacement: 'empty_box' });
  await action(request, first, 'offer_exchange', { targetId: second.playerId, giveTokenIds: ['password_4'] });
  await checkRestart(saved, people);
  const offer = (await snapshot(request, second)).body.round.exchangeOffers[0];
  assert.equal((await action(request, second, 'respond_exchange', { offerId: offer.id, accept: true })).status, 200);
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, second)).body.round.inventory.tokens[0].id, 'password_4');
  for (const person of people.slice(1)) await action(request, person, 'surrender');
  await checkRestart(saved, people);
  assert.equal((await snapshot(request, hako)).body.phase, 'game_over');
  assert.equal((await action(request, second, 'silent_reveal', { index: 1 })).status, 409);
  assert.equal(created, 1, 'Restoring must not recreate opening state or redraw decks');
  for (const path of ['/data/rooms.json', '/data/rooms.json.tmp', '/src/storage.mjs']) {
    assert.equal((await fetch(`${saved.base}${path}`)).status, 404);
  }
});

test('failed disk writes leave actions, joins, departures and SSE unchanged and allow retry', async t => {
  const saved = await persistentServer(t);
  const { request } = saved;
  const host = (await request('/api/rooms', { name: '房主' })).body;
  const live = await stream(t, saved.base, host);
  const before = await live.state();
  const bytes = await readFile(saved.dataFile, 'utf8');
  // An occupied temporary path makes replacement fail consistently on Windows and Unix.
  await mkdir(`${saved.dataFile}.tmp`);
  try {
    for (const attempt of [
      () => action(request, host, 'ready', { ready: true }),
      () => request(`/api/rooms/${host.roomCode}/join`, { name: '未入席' }),
      () => action(request, host, 'leave'),
      () => request('/api/rooms', { name: '未创建' }),
    ]) {
      const failed = await attempt();
      assert.equal(failed.status, 503);
      assert.match(failed.body.error, /本次操作未生效/);
      assert.deepEqual((await snapshot(request, host)).body, before);
      assert.equal(await readFile(saved.dataFile, 'utf8'), bytes);
    }
  } finally { await rm(`${saved.dataFile}.tmp`, { recursive: true }); }
  const retry = await action(request, host, 'ready', { ready: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.version, before.version + 1);
  assert.deepEqual(await live.state(), retry.body, 'No uncommitted state may have entered the SSE stream');
  await checkRestart(saved, [host]);
});

test('invalid actions and presence changes do not rewrite stored game state', async t => {
  const saved = await persistentServer(t);
  const people = await createFour(saved.request);
  const before = await readFile(saved.dataFile, 'utf8');
  const live = await stream(t, saved.base, people[0]);
  await live.state();
  await live.close();
  assert.equal((await action(saved.request, people[1], 'start')).status, 403);
  assert.equal((await action(saved.request, people[0], 'ready', { ready: 'yes' })).status, 400);
  await snapshot(saved.request, people[0]);
  assert.equal(await readFile(saved.dataFile, 'utf8'), before);
});

test('corrupt or unsupported storage refuses startup and preserves the original file', async t => {
  const saved = await persistentServer(t);
  const host = (await saved.request('/api/rooms', { name: '房主' })).body;
  const valid = await readFile(saved.dataFile, 'utf8');
  const invalidRoom = JSON.parse(valid);
  invalidRoom.rooms[0].players[0].seat = 8;
  const invalidGame = JSON.parse(valid);
  invalidGame.rooms[0].game = { phase: 'map_setup', placements: null };
  for (const content of ['{', JSON.stringify({ format: 2, rooms: [] }),
    JSON.stringify(invalidRoom), JSON.stringify(invalidGame)]) {
    await writeFile(saved.dataFile, content);
    assert.throws(() => createGameServer({ dataFile: saved.dataFile }), /存档/);
    assert.equal(await readFile(saved.dataFile, 'utf8'), content);
  }
  await writeFile(saved.dataFile, valid);
  await checkRestart(saved, [host]);
});

test('the real entry point saves to DATA_DIR before an abrupt process restart', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hako-process-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    let timer;
    const base = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Entry point did not start: ${output}`)), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /http:\/\/localhost:(\d+)/.exec(output);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Entry point exited: ${output}`)));
    }).finally(() => clearTimeout(timer));
    return { child, base };
  }
  const first = await boot();
  const response = await fetch(`${first.base}/api/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '重启测试' }),
  });
  assert.equal(response.status, 201);
  const person = await response.json();
  assert.equal(JSON.parse(await readFile(join(directory, 'rooms.json'), 'utf8')).rooms[0].code, person.roomCode);
  await stop(first.child);
  const second = await boot();
  const recovered = await fetch(`${second.base}/api/rooms/${person.roomCode}?${new URLSearchParams({
    playerId: person.playerId, token: person.token,
  })}`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), person.state);
});

test('HTTP boundary rejects malformed requests and only exposes intended static resources', async t => {
  const { base, request } = await startServer(t);
  assert.deepEqual((await request('/api/health')).body, { ok: true });
  const malformed = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, 'string');
  const oversized = await fetch(`${base}/api/rooms`, { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(oversized.status, 413);
  assert.equal((await request('/api/rooms', undefined, 'PUT')).status, 405);
  assert.equal((await request('/api/rooms/NOPE00/join', { name: '访客' })).status, 404);
  assert.equal((await request('/api/nothing')).status, 404);
  assert.equal((await request('/package.json')).status, 404);
  assert.equal((await request('/src/server.mjs')).status, 404);
  const maps = await fetch(`${base}/shared/maps.mjs`);
  assert.equal(maps.status, 200);
  assert.match(maps.headers.get('content-type'), /javascript/);
  assert.match(await maps.text(), /MAP_TILES/);
});
