import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameServer } from '../src/server.mjs';
import { createPlay } from '../src/play.mjs';

const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const positions = [[1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
  [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0]];

async function game(t, createPlayState = createPlay) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-second-playtest-http-'));
  const dataFile = join(directory, 'rooms.json');
  let server, base;
  const streams = new Set();
  async function restart() {
    for (const stream of streams) await stream.close();
    streams.clear();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    server = createGameServer({ deck, silentNumbers: [0, 1, 2, 3, 4, 5], createPlayState, dataFile,
      initialItemOrder: ['walkie_talkie', 'spirit_pen', 'ventriloquist_doll'] });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await restart();
  t.after(async () => {
    for (const stream of streams) await stream.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, data) {
    const response = await fetch(`${base}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  const created = await request('/api/rooms', { name: '箱娃' });
  assert.equal(created.status, 201);
  const people = [created.body];
  for (const name of ['访问者甲', '访问者乙', '访问者丙']) {
    const joined = await request(`/api/rooms/${people[0].roomCode}/join`, { name });
    assert.equal(joined.status, 201);
    people.push(joined.body);
  }
  async function action(person, type, values = {}) {
    return request(`/api/rooms/${person.roomCode}/actions`, {
      playerId: person.playerId, token: person.token, type, ...values,
    });
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
  async function stream(person) {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/rooms/${person.roomCode}/events?${new URLSearchParams({
      playerId: person.playerId, token: person.token,
    })}`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', closed = false;
    const live = {
      async close() {
        if (closed) return;
        closed = true;
        abort.abort();
        await reader.cancel().catch(() => {});
      },
      async state(predicate = () => true) {
        let timer;
        const consume = async () => {
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary >= 0) {
              const event = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!event.startsWith('event: state\n')) continue;
              const state = JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6));
              assert.equal(JSON.stringify(state).includes('recipientIds'), false, 'SSE must strip server-only chat recipients');
              if (predicate(state)) return state;
            } else {
              const { value, done } = await reader.read();
              assert.equal(done, false, 'SSE ended before the required state');
              buffer += decoder.decode(value, { stream: true });
            }
          }
        };
        try {
          return await Promise.race([consume(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('SSE state timed out')), 3000);
          })]);
        } finally { clearTimeout(timer); }
      },
    };
    streams.add(live);
    return live;
  }
  async function mapSetup() {
    for (const person of people) await act(person, 'ready', { ready: true });
    await act(people[0], 'start');
    let state = await act(people[0], 'claim_hako');
    assert.equal(state.initialItems.length, 3);
    return state;
  }
  async function play() {
    let state = await mapSetup();
    for (const [floor, x, y, rotation] of positions) {
      const person = people.find(candidate => candidate.playerId === state.setup.turnPlayerId);
      await act(person, 'draw');
      state = await act(person, 'place', { floor, x, y, rotation });
    }
    const hako = people[0];
    await act(hako, 'prepare_opening');
    await act(hako, 'choose_secrets', { password: [1, 2, 3], weakness: 'gasoline' });
    await act(hako, 'place_remains', { cornerId: 'living_sofa' });
    await act(hako, 'inspect_initial_room', { roomId: 'children_room' });
    state = await act(hako, 'choose_initial_hiding', { cornerId: 'children_cabinet' });
    return act(hako, 'choose_initial_power', { powerId: state.opening.initialPowerOptions[0].id });
  }
  return { people, action, act, snapshot, stream, mapSetup, play, restart, dataFile };
}

function roomFixture(setup, opening, options) {
  const play = createPlay(setup, opening, options);
  play.round.visitors[0].roomId = 'hall_room';
  play.round.visitors[1].roomId = 'hall_room';
  play.round.visitors[2].roomId = 'study_room';
  return play;
}

function factionFixture(setup, opening, options) {
  const play = roomFixture(setup, opening, options);
  for (const [index, banished] of [[1, false], [2, true]]) {
    const player = play.round.visitors[index];
    player.status = 'box_person';
    delete player.roomId;
    play.ghosts.push({ playerId: player.id, cornerId: index === 1 ? 'hall_clock' : 'study_books',
      banished, carriedTokens: [] });
  }
  play.round.silent.visitorIds = [setup.visitorIds[0]];
  return play;
}

function texts(state) { return state.chat.messages.map(message => message.text); }
function assertPrivate(state, allowed, forbidden = []) {
  assert.deepEqual(texts(state), allowed);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('recipientIds'), false);
  for (const text of forbidden) assert.equal(serialized.includes(text), false, `private text leaked: ${text}`);
}

test('map previews require the current drawn tile and synchronize without changing placements, version, undo, or disk', async t => {
  const g = await game(t);
  let state = await g.mapSetup();
  const actor = g.people.find(person => person.playerId === state.setup.turnPlayerId);
  const other = g.people.find(person => person !== actor);
  assert.equal((await g.action(actor, 'preview_map', { tileId: 'study', rotation: 0,
    placement: null, expectedVersion: state.version })).status, 409);
  state = await g.act(actor, 'draw');
  const before = structuredClone(state), savedBytes = await readFile(g.dataFile, 'utf8');
  const live = await g.stream(other);
  await live.state(current => current.version === before.version);
  const first = state.setup.legalPlacements[0];
  const values = { tileId: state.setup.drawnTileId, rotation: first.rotation,
    placement: { floor: first.floor, x: first.x, y: first.y }, expectedVersion: state.version };
  for (const [person, input, expected] of [
    [other, values, 409],
    [actor, { ...values, expectedVersion: state.version - 1 }, 409],
    [actor, { ...values, expectedVersion: undefined }, 409],
    [actor, { ...values, tileId: 'bathroom' }, 409],
    [actor, { ...values, rotation: 4 }, 400],
    [actor, { ...values, placement: { floor: 1, x: 0, y: 0 } }, 409],
    [actor, { ...values, placement: { floor: 1, x: 999, y: 999 } }, 409],
  ]) assert.equal((await g.action(person, 'preview_map', input)).status, expected);
  state = await g.act(actor, 'preview_map', values);
  assert.deepEqual(state.setup.preview, { playerId: actor.playerId, tileId: values.tileId,
    rotation: first.rotation, placement: first, revision: 1 });
  let streamed = await live.state(current => current.setup?.preview?.revision === 1);
  assert.deepEqual(streamed.setup.preview, state.setup.preview);
  assert.deepEqual((await g.snapshot(g.people[2], true)).setup.preview, state.setup.preview);
  const rotated = before.setup.legalPlacements.find(target => target.rotation !== first.rotation);
  assert.ok(rotated, 'Fixture offers a second legal orientation');
  state = await g.act(actor, 'preview_map', { ...values, rotation: rotated.rotation,
    placement: { floor: rotated.floor, x: rotated.x, y: rotated.y } });
  streamed = await live.state(current => current.setup?.preview?.revision === 2);
  assert.deepEqual(streamed.setup.preview.placement, rotated);
  for (const current of [state, streamed, await g.snapshot(g.people[3], true)]) {
    assert.equal(current.version, before.version);
    assert.deepEqual(current.setup.placements, before.setup.placements);
    assert.deepEqual(current.undo, before.undo);
  }
  assert.equal(await readFile(g.dataFile, 'utf8'), savedBytes, 'Transient previews do not persist game state');
  state = await g.act(actor, 'place', { ...rotated, expectedVersion: before.version });
  assert.equal(state.setup.preview, null);
  assert.equal(state.setup.placements.length, before.setup.placements.length + 1);
  assert.equal(state.version, before.version + 1);
  assert.equal((await live.state(current => current.version === state.version)).setup.preview, null);
  assert.equal((await g.snapshot(g.people[2], true)).setup.preview, null);
  assert.equal((await g.action(actor, 'preview_map', values)).status, 409);
});

test('room chat fixes recipients at send time across HTTP, SSE, polling, movement, undo voting, and restart', async t => {
  const g = await game(t, roomFixture);
  await g.play();
  const [hako, first, second, third] = g.people;
  const lives = await Promise.all(g.people.map(person => g.stream(person)));
  for (const live of lives) await live.state();
  const before = await g.snapshot(first);
  const firstMessage = '<img src=x onerror="window.chatExecuted=true">同房秘密';
  const outsideMessage = '进入书房前的秘密';
  const leftMessage = '离房后留在大厅的秘密';
  const arrivedMessage = '进入书房后收到的秘密';
  const sent = await g.act(first, 'chat_send', { text: firstMessage, channelKind: 'room', roomId: 'hall_room' });
  assert.equal(sent.version, before.version);
  assert.deepEqual(sent.undo, before.undo);
  assert.equal(sent.chat.messages[0].text, firstMessage, 'HTML-like chat remains unchanged plain text in the API');
  for (let index = 0; index < g.people.length; index++) {
    const allowed = index === 1 || index === 2 ? [firstMessage] : [];
    const forbidden = allowed.length ? [] : [firstMessage];
    const streamed = await lives[index].state(current => current.chat.revision === sent.chat.revision);
    assertPrivate(streamed, allowed, forbidden);
    assertPrivate(await g.snapshot(g.people[index]), allowed, forbidden);
    assertPrivate(await g.snapshot(g.people[index], true), allowed, forbidden);
  }
  await g.act(third, 'chat_send', { text: outsideMessage, channelKind: 'room', roomId: 'study_room' });
  await g.act(first, 'silent_reveal', { index: 0 });
  await g.act(first, 'move', { roomId: 'study_room' });
  await g.act(hako, 'resolve_visitor_action');
  assert.equal((await g.snapshot(first)).chat.channel.roomId, 'study_room');
  assert.equal((await g.action(first, 'chat_send', { text: 'stale channel', channelKind: 'room', roomId: 'hall_room' })).status, 409);
  const left = await g.act(second, 'chat_send', { text: leftMessage, channelKind: 'room', roomId: 'hall_room' });
  assertPrivate(await lives[1].state(current => current.chat.revision === left.chat.revision), [firstMessage], [outsideMessage, leftMessage]);
  await delay(820);
  const arrived = await g.act(third, 'chat_send', { text: arrivedMessage, channelKind: 'room', roomId: 'study_room' });
  const allowed = [[], [firstMessage, arrivedMessage], [firstMessage, leftMessage], [outsideMessage, arrivedMessage]];
  const everyMessage = [firstMessage, outsideMessage, leftMessage, arrivedMessage];
  for (let index = 0; index < g.people.length; index++) {
    const forbidden = everyMessage.filter(message => !allowed[index].includes(message));
    assertPrivate(await lives[index].state(current => current.chat.revision === arrived.chat.revision), allowed[index], forbidden);
    assertPrivate(await g.snapshot(g.people[index], true), allowed[index], forbidden);
  }
  await g.restart();
  for (let index = 0; index < g.people.length; index++) {
    assertPrivate(await g.snapshot(g.people[index], true), allowed[index], everyMessage.filter(message => !allowed[index].includes(message)));
  }
  const current = await g.snapshot(hako);
  const voting = await g.act(hako, 'undo_request', { version: current.version });
  assert.ok(voting.undo.pending, 'All four polling identities participate in undo voting');
  const duringVote = await g.act(second, 'chat_send', { text: '撤销投票中也能沟通',
    channelKind: 'room', roomId: 'hall_room', expectedVersion: voting.version - 1 });
  assert.equal(duringVote.version, voting.version);
  assert.deepEqual(duringVote.undo, voting.undo);
  for (const person of [first, second, third]) {
    await g.act(person, 'undo_respond', { requestId: voting.undo.pending.id, accept: true });
  }
  const restored = await g.snapshot(first);
  assert.equal(restored.chat.channel.roomId, 'hall_room');
  assertPrivate(restored, [firstMessage, arrivedMessage], [outsideMessage, leftMessage, '撤销投票中也能沟通']);
  assert.ok(texts(await g.snapshot(second)).includes('撤销投票中也能沟通'), 'Undo does not erase chat history');
});

test('faction chat reaches hako and active box people and excludes living visitors and banished ghosts on every transport', async t => {
  const g = await game(t, factionFixture);
  await g.play();
  const [hako, living, ghost, banished] = g.people;
  const lives = await Promise.all(g.people.map(person => g.stream(person)));
  for (const live of lives) await live.state();
  const text = '箱娃阵营潜伏计划';
  const sent = await g.act(hako, 'chat_send', { text, channelKind: 'hako', roomId: null });
  for (let index = 0; index < g.people.length; index++) {
    const included = index === 0 || index === 2;
    const streamed = await lives[index].state(current => current.chat.revision === sent.chat.revision);
    for (const view of [streamed, await g.snapshot(g.people[index]), await g.snapshot(g.people[index], true)]) {
      assertPrivate(view, included ? [text] : [], included ? [] : [text]);
      assert.equal(view.chat.channel?.kind ?? null, index === 3 ? null : included ? 'hako' : 'room');
    }
  }
  const reply = '箱人收到';
  await g.act(ghost, 'chat_send', { text: reply, channelKind: 'hako', roomId: null });
  assertPrivate(await g.snapshot(hako), [text, reply]);
  assert.equal((await g.action(living, 'chat_send', { text: 'forge faction', channelKind: 'hako', roomId: null })).status, 409);
  assert.equal((await g.action(banished, 'chat_send', { text: 'banished message', channelKind: 'hako', roomId: null })).status, 409);
  assert.equal((await g.action(hako, 'chat_send', { text: 'forge room', channelKind: 'room', roomId: 'hall_room' })).status, 409);
  await g.restart();
  assertPrivate(await g.snapshot(ghost, true), [text, reply]);
  assertPrivate(await g.snapshot(living, true), [], [text, reply]);
  assertPrivate(await g.snapshot(banished, true), [], [text, reply]);
});

test('chat rejects unavailable or stale channels and invalid text, enforces 300 Unicode characters and an 800ms send interval', async t => {
  const g = await game(t, roomFixture);
  const [hako, first] = g.people;
  const lobby = await g.snapshot(hako);
  assert.equal((await g.action(hako, 'chat_send', { text: 'too early', channelKind: 'hako', roomId: null })).status, 409);
  assert.equal((await g.snapshot(hako)).version, lobby.version);
  await g.play();
  const before = await g.snapshot(first);
  const channel = { channelKind: 'room', roomId: 'hall_room' };
  for (const text of ['', '   ', null, 4, '字'.repeat(301), '🙂'.repeat(301), 'bad\u0001control']) {
    assert.equal((await g.action(first, 'chat_send', { ...channel, text })).status, 409);
  }
  for (const wrong of [{ channelKind: 'hako', roomId: null }, { channelKind: 'room', roomId: 'study_room' },
    { channelKind: 'room', roomId: null }]) {
    assert.equal((await g.action(first, 'chat_send', { ...wrong, text: 'wrong channel' })).status, 409);
  }
  const accepted = await g.act(first, 'chat_send', { ...channel, text: `  ${'🙂'.repeat(300)}  ` });
  assert.equal(accepted.chat.messages[0].text, '🙂'.repeat(300));
  const tooFast = await g.action(first, 'chat_send', { ...channel, text: 'too fast' });
  assert.equal(tooFast.status, 409);
  assert.match(tooFast.body.error, /发送过快/);
  await delay(820);
  const later = await g.act(first, 'chat_send', { ...channel, text: '字'.repeat(300) });
  assert.equal(later.chat.messages.length, 2);
  assert.equal(later.version, before.version);
  assert.deepEqual(later.undo, before.undo);
  assert.equal(later.chat.revision, before.chat.revision + 2, 'Rejected chat must not advance its revision');
});
