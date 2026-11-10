import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSetup, drawTile, placeTile } from '../src/game.mjs';
import { INITIAL_ITEMS, createOpening, chooseSecrets, placeRemains, inspectInitialRoom,
  chooseInitialHiding, chooseInitialPower } from '../src/preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from '../src/play.mjs';
import { getWalkieParticipants, isLockedWalkie } from '../src/walkie.mjs';
import { stealPossession } from '../src/theft.mjs';
import { chooseBotAction } from '../src/bots.mjs';
import { createRoomStore } from '../src/storage.mjs';
import { checkpoint, rememberAction, applyUndo } from '../src/undo.mjs';
import { createGameServer } from '../src/server.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const [first, second, third] = visitors;
const hako = 'hako';
const ids = [hako, ...visitors];
const piece = (id, type, values = {}) => ({ id, type, ...values });
function fixture() {
  const setup = createSetup(visitors, { deck: ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'] });
  for (const [floor, x, y, rotation] of [[1, 0, -1, 2], [1, -1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 0],
    [-1, 0, 0, 0], [1, -1, -1, 1], [1, -2, 0, 2], [1, 2, 0, 0]]) {
    drawTile(setup, setup.turnPlayerId);
    placeTile(setup, setup.turnPlayerId, { floor, x, y, rotation });
  }
  const opening = createOpening(setup, { hakoId: hako, itemChoices: visitors.map((playerId, index) => ({
    playerId, itemId: ['walkie_talkie', 'deduction', 'spirit_pen'][index],
  })) });
  chooseSecrets(opening, hako, { password: [1, 3, 5], weakness: 'gasoline' });
  placeRemains(opening, hako, 'hall_clock');
  inspectInitialRoom(opening, hako, 'children_room');
  chooseInitialHiding(opening, hako, 'children_bed');
  opening.initialPowerCandidates = [1, 2, 4];
  chooseInitialPower(opening, hako, 1);
  return createPlay(setup, opening, { numbers: [0, 1, 2, 3, 4, 5] });
}
function act(play, id, action) {
  const before = structuredClone(play);
  const next = applyPlayAction(play, id, action);
  assert.deepEqual(play, before, 'actions must use a detached transaction state');
  return next;
}
function reject(play, id, action) {
  const before = structuredClone(play);
  assert.throws(() => applyPlayAction(play, id, action), /[\u4e00-\u9fff]/);
  assert.deepEqual(play, before, 'invalid requests must preserve all state');
}
const view = (play, id = first) => getPlayView(play, id).walkie;
function paired(play = fixture()) {
  play = act(play, first, { type: 'walkie_propose', targetId: second });
  return act(play, second, { type: 'walkie_respond', requestId: view(play).pairRequest.id, accept: true });
}
function showing(play = paired()) {
  return act(play, first, { type: 'walkie_show_propose' });
}
function confirm(play, id, tokenIds = []) {
  return act(play, id, { type: 'walkie_show_confirm', requestId: view(play, id).showRequest.id, tokenIds });
}
function roomFor(play) {
  return { code: 'ABC234', playerCount: 4, hostId: first, version: 1, log: [], selectingHako: false, play,
    players: ids.map((id, seat) => ({ id, seat, name: `玩家${seat + 1}`, token: `example-token-${seat}`,
      role: id === hako ? 'hako' : 'visitor', ready: true, connections: new Set() })) };
}

test('pairing requires the main device and a consenting same-room survivor, issuing one companion without spending a turn', () => {
  let play = fixture();
  const beforeSilent = structuredClone(play.round.silent);
  assert.equal(INITIAL_ITEMS.some(item => item.id === 'walkie_companion'), false);
  reject(play, second, { type: 'walkie_propose', targetId: first });
  reject(play, first, { type: 'walkie_propose', targetId: first });
  play.round.visitors[2].roomId = 'study_room';
  reject(play, first, { type: 'walkie_propose', targetId: third });
  play = act(play, first, { type: 'walkie_propose', targetId: second });
  const requestId = view(play).pairRequest.id;
  assert.equal(play.inventories[second].items.length, 1);
  assert.equal(view(play, third), null);
  assert.equal(view(play, hako), null);
  reject(play, third, { type: 'walkie_respond', requestId, accept: true });
  play = act(play, second, { type: 'walkie_respond', requestId, accept: true });
  assert.equal(play.inventories[second].items.filter(item => item.id === 'walkie_companion').length, 1);
  assert.deepEqual(getWalkieParticipants(play, first), [first, second]);
  assert.deepEqual(play.round.silent, beforeSilent);
  reject(play, first, { type: 'walkie_propose', targetId: third });
  reject(play, second, { type: 'walkie_respond', requestId, accept: true });
  assert.ok(play.itemEvents.some(event => event.itemId === 'walkie_talkie' && event.operation === 'pair'));
});

test('declining or cancelling a proposal issues no card, while acceptance rechecks location and current ownership', () => {
  let play = act(fixture(), first, { type: 'walkie_propose', targetId: second });
  let requestId = view(play).pairRequest.id;
  reject(play, second, { type: 'walkie_respond', requestId, accept: 'yes' });
  play.round.visitors[1].roomId = 'study_room';
  reject(play, second, { type: 'walkie_respond', requestId, accept: true });
  play = act(play, second, { type: 'walkie_respond', requestId, accept: false });
  assert.equal(play.inventories[second].items.some(item => item.id === 'walkie_companion'), false);
  play.round.visitors[1].roomId = 'hall_room';
  play = act(play, first, { type: 'walkie_propose', targetId: second });
  requestId = view(play).pairRequest.id;
  const main = play.inventories[first].items.pop();
  reject(play, second, { type: 'walkie_respond', requestId, accept: true });
  play.inventories[first].items.push(main);
  play = act(play, first, { type: 'walkie_cancel', requestId });
  assert.equal(view(play).canPair, true);
  reject(play, first, { type: 'walkie_cancel', requestId });
});

test('pairing accepts printed subdivisions of the same board but locked devices cannot be freely transferred', () => {
  let play = fixture();
  play.round.visitors[0].roomId = 'bathroom_room';
  play.round.visitors[1].roomId = 'toilet_stall';
  play = paired(play);
  assert.equal(isLockedWalkie(play, 'walkie_talkie'), true);
  assert.equal(isLockedWalkie(play, { id: 'walkie_companion' }), true);
  reject(play, first, { type: 'offer_exchange', targetId: second, giveItemIds: ['walkie_talkie'] });
  reject(play, second, { type: 'offer_exchange', targetId: first, giveItemIds: ['walkie_companion'] });
});

test('remote multiselection reveals only selected snapshot tokens after both confirmations', () => {
  let play = paired();
  play.round.visitors[1].roomId = 'study_room';
  play.inventories[first].tokens = [piece('secret-a', 'password', { number: 2 }), piece('secret-unselected', 'doll')];
  play.inventories[second].tokens = [piece('secret-b', 'weapon', { tool: 'gasoline' })];
  play = showing(play);
  play = confirm(play, first, ['secret-a']);
  assert.equal(view(play, second).lastShow, null);
  assert.equal(JSON.stringify(view(play, second)).includes('secret-a'), false);
  assert.equal(view(play, first).showRequest.confirmedIds.includes(first), true);
  for (const id of [hako, third]) assert.equal(JSON.stringify(getPlayView(play, id)).includes('secret-a'), false);
  play = confirm(play, second, ['secret-b']);
  assert.deepEqual(view(play, second).lastShow.tokens.map(token => token.id), ['secret-a']);
  assert.deepEqual(view(play, first).lastShow.tokens.map(token => token.id), ['secret-b']);
  assert.equal(view(play, first).showRequest, null);
  for (const id of [hako, third]) assert.equal(JSON.stringify(getPlayView(play, id)).includes('secret-b'), false);
  assert.equal(JSON.stringify(play.itemEvents).includes('secret-'), false);
  assert.equal(play.inventories[first].tokens.length, 2, 'showing is not a transfer');
  play.inventories[first].tokens[0].number = 6;
  assert.equal(view(play, second).lastShow.tokens[0].number, 2, 'results preserve the shown snapshot');
});

test('mutual show rejects forged or changed selections atomically and allows revised confirmation', () => {
  let play = showing();
  play.inventories[first].tokens.push(piece('show-a', 'key'));
  const requestId = view(play).showRequest.id;
  for (const tokenIds of [['show-a', 'show-a'], ['unknown'], [null], 'show-a']) {
    reject(play, first, { type: 'walkie_show_confirm', requestId, tokenIds });
  }
  reject(play, third, { type: 'walkie_show_confirm', requestId, tokenIds: [] });
  reject(play, first, { type: 'walkie_show_confirm', requestId: 'old', tokenIds: [] });
  play = confirm(play, first, ['show-a']);
  play.inventories[first].tokens = [];
  reject(play, second, { type: 'walkie_show_confirm', requestId, tokenIds: [] });
  play = confirm(play, first, []);
  play = confirm(play, second, []);
  assert.deepEqual(view(play, first).lastShow.tokens, []);
  assert.deepEqual(view(play, second).lastShow.tokens, []);
});

test('either participant can cancel a mutual show, and cancellation remains possible outside free-action phases', () => {
  let play = showing();
  const requestId = view(play).showRequest.id;
  play.round.silent.phase = 'hako_phase';
  reject(play, third, { type: 'walkie_show_cancel', requestId });
  play = act(play, second, { type: 'walkie_show_cancel', requestId });
  assert.equal(view(play).showRequest, null);
  play = act(fixture(), first, { type: 'walkie_propose', targetId: second });
  const pairId = view(play).pairRequest.id;
  play.round.silent.phase = 'hako_phase';
  play = act(play, first, { type: 'walkie_cancel', requestId: pairId });
  assert.equal(view(play).pairRequest, null);
});

test('cancelling a walkie request also removes its pending power-interrupt declaration without cancelling unrelated actions', () => {
  let play = showing();
  const requestId = view(play).showRequest.id;
  play.powers.slots[0] = { id: 7, ignoreThreshold: true, faceUp: false };
  play = act(play, first, { type: 'walkie_show_confirm', requestId, tokenIds: [] });
  assert.equal(play.round.pendingAction.type, 'free');
  play = act(play, second, { type: 'walkie_show_cancel', requestId });
  assert.equal(play.round.pendingAction, null);
  assert.equal(view(play).showRequest, null);
  play.powers.slots[0] = null;
  play = showing(play);
  const nextId = view(play).showRequest.id;
  play = act(play, first, { type: 'silent_reveal', index: 0 });
  play = act(play, first, { type: 'move', roomId: getPlayView(play, first).moveTargets[0] });
  play = act(play, second, { type: 'walkie_show_cancel', requestId: nextId });
  assert.equal(play.round.pendingAction.type, 'move');
});

test('hako sharing either endpoint room kills before revealing any selected tokens and cancels the entire show', () => {
  for (const endangered of [[first], [second], [first, second]]) {
    let play = paired();
    play.inventories[first].tokens = [piece('never-share-a', 'password', { number: 2 })];
    play.inventories[second].tokens = [piece('never-share-b', 'weapon', { tool: 'gasoline' })];
    for (const id of endangered) play.round.visitors.find(player => player.id === id).roomId = 'children_room';
    play = showing(play);
    play = confirm(play, first, ['never-share-a']);
    play = confirm(play, second, ['never-share-b']);
    for (const id of endangered) {
      assert.equal(play.round.visitors.find(player => player.id === id).status, 'box_person');
      assert.equal(play.inventories[id].items.length, 0, 'death clears cards including both kinds of device');
    }
    assert.equal(play.walkie.showRequest, null);
    assert.equal(view(play, first).lastShow, null);
    assert.equal(view(play, second).lastShow, null);
    assert.deepEqual(getWalkieParticipants(play, first), []);
    assert.ok(play.itemEvents.some(event => event.itemId === 'walkie_talkie' && event.status === 'ineffective'));
    assert.equal(JSON.stringify(getPlayView(play, third)).includes('never-share-'), false);
    if (endangered.length === 2) {
      assert.equal(play.resolution.kind, 'inheritance');
      assert.equal(play.inheritanceQueue.length, 1, 'both victims must receive the proper inheritance turn');
    }
  }
});

test('ordinary peek death permanently closes an existing pair without waiting for another radio action', () => {
  let play = paired();
  play.round.visitors[0].roomId = 'children_room';
  play = act(play, first, { type: 'silent_reveal', index: 0 });
  play = act(play, first, { type: 'peek', cornerId: 'children_bed' });
  play = act(play, hako, { type: 'resolve_visitor_action' });
  assert.equal(view(play, second).reason, 'death');
  assert.deepEqual(getWalkieParticipants(play, second), []);
});

test('NO7 theft before pairing spends the device permanently, even if its original owner gets it back', () => {
  const play = fixture();
  stealPossession(play, first, { stealKind: 'item', itemIndex: 0 });
  play.inventories[first].tokens.push(piece('return-price', 'password', { number: 2 }));
  stealPossession(play, first, { stealKind: 'token' });
  assert.equal(play.inventories[first].items.some(item => item.id === 'walkie_talkie'), true);
  assert.equal(view(play).reason, 'theft');
  assert.equal(view(play).canPair, false);
  reject(play, first, { type: 'walkie_propose', targetId: second });
});

test('NO7 stealing either paired device cancels pending shows and returning it never restores the link', () => {
  for (const [victim, itemId] of [[first, 'walkie_talkie'], [second, 'walkie_companion']]) {
    const play = showing();
    stealPossession(play, victim, { stealKind: 'item', itemIndex: play.inventories[victim].items.findIndex(item => item.id === itemId) });
    assert.equal(play.walkie.showRequest, null);
    assert.equal(view(play, first).reason, 'theft');
    play.inventories[victim].tokens.push(piece('price', 'key'));
    stealPossession(play, victim, { stealKind: 'token' });
    assert.equal(play.inventories[victim].items.some(item => item.id === itemId), true);
    assert.deepEqual(getWalkieParticipants(play, first), []);
    assert.equal(view(play, first).canShow, false);
    reject(play, first, { type: 'walkie_propose', targetId: third });
  }
});

test('bots accept and confirm only once, then wait for the human rather than generating repeated radio actions', () => {
  let play = act(fixture(), first, { type: 'walkie_propose', targetId: second });
  const snapshot = id => ({ phase: 'practice', you: id, hostId: first,
    players: roomFor(play).players.map(player => ({ ...player, isBot: player.id === second })), round: getPlayView(play, id) });
  let action = chooseBotAction(snapshot(second));
  assert.equal(action.type, 'walkie_respond');
  play = act(play, second, action);
  assert.equal(chooseBotAction(snapshot(second)), null);
  play = showing(play);
  action = chooseBotAction(snapshot(second));
  assert.equal(action.type, 'walkie_show_confirm');
  play = act(play, second, action);
  assert.equal(chooseBotAction(snapshot(second)), null);
});

test('pending pairing and private mutual-show state survive real storage and undo does not duplicate companions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hako-walkie-'));
  try {
    const store = createRoomStore(join(dir, 'rooms.json'));
    let room = roomFor(act(fixture(), first, { type: 'walkie_propose', targetId: second }));
    store.save(new Map([[room.code, room]]));
    room = store.load().get(room.code);
    const before = checkpoint(room);
    const requestId = view(room.play).pairRequest.id;
    room.play = act(room.play, second, { type: 'walkie_respond', requestId, accept: true });
    rememberAction(room, before, second, 'walkie_respond', '接受配套对讲机');
    applyUndo(room, room.players.find(player => player.id === first), { type: 'undo_request', version: 1 }, [first]);
    assert.equal(room.play.inventories[second].items.some(item => item.id === 'walkie_companion'), false);
    assert.equal(view(room.play).pairRequest.id, requestId);
    room.play = act(room.play, second, { type: 'walkie_respond', requestId, accept: true });
    assert.equal(room.play.inventories[second].items.filter(item => item.id === 'walkie_companion').length, 1);
    room.play = confirm(showing(room.play), first, []);
    store.save(new Map([[room.code, room]]));
    room = store.load().get(room.code);
    assert.equal(view(room.play, second).showRequest.confirmedIds.includes(first), true);
    room.play = confirm(room.play, second, []);
    store.save(new Map([[room.code, room]]));
    const restored = store.load().get(room.code);
    assert.deepEqual(view(restored.play, first).lastShow.tokens, []);
    assert.equal(view(restored.play, third), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('walkie HTTP/SSE/polling preserves secrecy through restart, stale versions and failed pair/show saves', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hako-walkie-http-'));
  const dataFile = join(dir, 'rooms.json');
  const initial = fixture();
  initial.inventories[first].tokens.push(piece('http-private-radio-a', 'password', { number: 2 }));
  initial.inventories[second].tokens.push(piece('http-private-radio-b', 'weapon', { tool: 'gasoline' }));
  const stored = roomFor(initial);
  createRoomStore(dataFile).save(new Map([[stored.code, stored]]));
  let server, base;
  const streams = [];
  const stop = async () => {
    for (const stream of streams.splice(0)) await stream.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  };
  const start = async () => {
    await stop();
    server = createGameServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const credential = id => stored.players.find(player => player.id === id);
  const query = id => new URLSearchParams({ playerId: id, token: credential(id).token });
  const snapshot = async (id, poll = false) => {
    const response = await fetch(`${base}/api/rooms/${stored.code}?${query(id)}${poll ? '&poll=1' : ''}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const action = async (id, type, payload = {}, expectedStatus = 200) => {
    const current = await snapshot(id);
    const response = await fetch(`${base}/api/rooms/${stored.code}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: id, token: credential(id).token,
        expectedVersion: current.version, type, ...payload }) });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, `${type}: ${JSON.stringify(result)}`);
    return result;
  };
  const stream = async id => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/rooms/${stored.code}/events?${query(id)}`, { signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const live = {
      close: async () => { abort.abort(); await reader.cancel().catch(() => {}); },
      state: async predicate => {
        const timer = setTimeout(() => abort.abort(), 5000);
        try {
          while (true) {
            const boundary = buffered.indexOf('\n\n');
            if (boundary >= 0) {
              const event = buffered.slice(0, boundary);
              buffered = buffered.slice(boundary + 2);
              const data = event.split('\n').find(line => line.startsWith('data: '));
              if (data) {
                const value = JSON.parse(data.slice(6));
                if (predicate(value)) return value;
              }
            } else {
              const { value, done } = await reader.read();
              assert.equal(done, false);
              buffered += decoder.decode(value, { stream: true });
            }
          }
        } finally { clearTimeout(timer); }
      },
    };
    streams.push(live);
    return live;
  };
  let state = await action(first, 'walkie_propose', { targetId: second });
  const requestId = state.round.walkie.pairRequest.id;
  await start();
  const beforePair = await snapshot(second, true);
  assert.equal(beforePair.round.walkie.pairRequest.id, requestId);
  await action(second, 'walkie_respond', { requestId, accept: true, expectedVersion: beforePair.version - 1 }, 409);
  assert.deepEqual((await snapshot(second)).round.walkie, beforePair.round.walkie);
  const beforePairBytes = readFileSync(dataFile, 'utf8');
  mkdirSync(`${dataFile}.tmp`);
  try {
    await action(second, 'walkie_respond', { requestId, accept: true }, 503);
    const failedPair = await snapshot(second, true);
    assert.equal(failedPair.version, beforePair.version);
    assert.equal(failedPair.round.inventory.items.some(item => item.id === 'walkie_companion'), false);
    assert.deepEqual(failedPair.round.walkie, beforePair.round.walkie);
    assert.equal(readFileSync(dataFile, 'utf8'), beforePairBytes);
  } finally { rmSync(`${dataFile}.tmp`, { recursive: true, force: true }); }
  state = await action(second, 'walkie_respond', { requestId, accept: true });
  const privateStream = await stream(second);
  const publicStream = await stream(hako);
  state = await action(first, 'walkie_show_propose');
  const showId = state.round.walkie.showRequest.id;
  state = await action(first, 'walkie_show_confirm', { requestId: showId, tokenIds: ['http-private-radio-a'] });
  const waiting = await privateStream.state(value => value.version === state.version);
  assert.equal(waiting.round.walkie.lastShow, null);
  assert.equal(JSON.stringify(waiting).includes('http-private-radio-a'), false);
  const beforeShowVersion = state.version;
  const beforeShowBytes = readFileSync(dataFile, 'utf8');
  await action(second, 'walkie_show_confirm', { requestId: showId, tokenIds: ['http-private-radio-b'], expectedVersion: beforeShowVersion - 1 }, 409);
  assert.equal((await snapshot(first)).round.walkie.lastShow, null);
  mkdirSync(`${dataFile}.tmp`);
  try {
    await action(second, 'walkie_show_confirm', { requestId: showId, tokenIds: ['http-private-radio-b'] }, 503);
    for (const id of [first, second]) {
      const failedShow = await snapshot(id, true);
      assert.equal(failedShow.version, beforeShowVersion);
      assert.equal(failedShow.round.walkie.lastShow, null);
      assert.deepEqual(failedShow.round.walkie.showRequest.confirmedIds, [first]);
      assert.equal(JSON.stringify(failedShow).includes(id === first ? 'http-private-radio-b' : 'http-private-radio-a'), false);
    }
    assert.equal(readFileSync(dataFile, 'utf8'), beforeShowBytes);
  } finally { rmSync(`${dataFile}.tmp`, { recursive: true, force: true }); }
  state = await action(second, 'walkie_show_confirm', { requestId: showId, tokenIds: ['http-private-radio-b'] });
  const privateResult = await privateStream.state(value => value.version === state.version);
  assert.equal(privateResult.round.walkie.lastShow.tokens[0].id, 'http-private-radio-a');
  const publicResult = await publicStream.state(value => value.version === state.version);
  assert.equal(JSON.stringify(publicResult).includes('http-private-radio-'), false);
  assert.equal(JSON.stringify(await snapshot(third, true)).includes('http-private-radio-'), false);
  await action(first, 'chat_send', { channelKind: 'walkie', roomId: null, text: '仅固定同伴接收的消息' });
  assert.equal((await snapshot(second, true)).chat.messages.at(-1).text, '仅固定同伴接收的消息');
  assert.equal(JSON.stringify(await snapshot(hako)).includes('仅固定同伴接收的消息'), false);
  assert.equal(JSON.stringify(await snapshot(third, true)).includes('仅固定同伴接收的消息'), false);
  await start();
  assert.equal((await snapshot(second)).round.walkie.lastShow.tokens[0].id, 'http-private-radio-a');
  assert.equal((await snapshot(second)).chat.messages.at(-1).text, '仅固定同伴接收的消息');
  assert.equal(JSON.stringify(await snapshot(third, true)).includes('http-private-radio-'), false);
});
