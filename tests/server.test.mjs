import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGameServer } from '../src/server.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];

async function startServer(t) {
  const server = createGameServer({ deck });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  return { base, request };
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
  assert.equal(started.body.phase, 'map_setup');
  assert.equal(started.body.setup.turnPlayerId, fourth.playerId, 'visitor after hako takes the first turn');
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
