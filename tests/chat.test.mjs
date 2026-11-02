import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatView, sendChat } from '../src/chat.mjs';
import { invalidateWalkieForTheft, invalidateWalkieForDeath } from '../src/walkie.mjs';

const fixture = () => ({ players: ['h', 'a', 'b', 'c'].map(id => ({ id })), play: {
  round: { hakoId: 'h', visitors: [
    { id: 'a', roomId: 'bathroom_room', status: 'alive' },
    { id: 'b', roomId: 'toilet', status: 'alive' },
    { id: 'c', roomId: 'study_room', status: 'alive' },
  ] }, ghosts: [],
} });

test('room chat uses current server membership and freezes message audience', () => {
  const room = fixture();
  room.play.round.visitors[1].roomId = 'bathroom_room';
  const input = { text: '<img src=x onerror=alert(1)>', channelKind: 'room', roomId: 'bathroom_room' };
  sendChat(room, 'a', { ...input, recipientIds: ['h', 'c'] }, 1000);
  assert.equal(getChatView(room, 'b').messages[0].text, input.text);
  for (const id of ['h', 'c']) assert.deepEqual(getChatView(room, id).messages, []);
  room.play.round.visitors[1].roomId = 'study_room';
  room.play.round.visitors[2].roomId = 'bathroom_room';
  sendChat(room, 'a', { ...input, text: 'second' }, 2000);
  assert.equal(getChatView(room, 'b').messages.length, 1);
  assert.equal(getChatView(room, 'c').messages.length, 1);
  assert.equal(getChatView(room, 'c').messages[0].text, 'second');
  assert.equal(JSON.stringify(getChatView(room, 'a')).includes('recipientIds'), false);
});

test('hako chat includes active ghosts without disclosing it to living visitors', () => {
  const room = fixture();
  room.play.round.visitors[1].status = 'box_person';
  room.play.ghosts.push({ playerId: 'b', cornerId: 'children_bed', banished: false });
  sendChat(room, 'h', { text: '阵营私语', channelKind: 'hako', roomId: null }, 1000);
  assert.equal(getChatView(room, 'b').messages[0].text, '阵营私语');
  assert.deepEqual(getChatView(room, 'a').messages, []);
  assert.deepEqual(getChatView(room, 'c').messages, []);
  room.play.ghosts[0].banished = true;
  assert.equal(getChatView(room, 'b').channel, null);
  assert.throws(() => sendChat(room, 'b', { text: '不能发', channelKind: 'hako' }, 2000), /没有可用/);
  sendChat(room, 'h', { text: 'later', channelKind: 'hako', roomId: null }, 2000);
  assert.equal(getChatView(room, 'b').messages.length, 1);
});

test('stale channel, bad text and rapid sends leave history unchanged', () => {
  const room = fixture();
  const input = { text: 'hello', channelKind: 'room', roomId: 'bathroom_room' };
  assert.throws(() => sendChat(room, 'a', { ...input, roomId: 'study_room' }, 1000), /对象已改变/);
  for (const text of ['', ' ', '字'.repeat(301), '\u0000', 1]) {
    assert.throws(() => sendChat(room, 'a', { ...input, text }, 1000));
  }
  assert.equal(room.chatMessages, undefined);
  sendChat(room, 'a', input, 1000);
  assert.throws(() => sendChat(room, 'a', input, 1001), /发送过快/);
  assert.equal(room.chatMessages.length, 1);
  assert.equal(room.chatRevision, 1);
});

test('chat survives JSON storage and bounds both global and participant histories', () => {
  const room = fixture();
  for (let index = 0; index < 130; index++) {
    sendChat(room, 'a', { text: `message ${index}`, channelKind: 'room', roomId: 'bathroom_room' }, index * 1000);
  }
  assert.equal(room.chatMessages.length, 120);
  const restored = JSON.parse(JSON.stringify(room));
  assert.equal(getChatView(restored, 'a').messages.length, 60);
  assert.equal(getChatView(restored, 'c').messages.length, 0);
  assert.deepEqual(getChatView(restored, 'a'), getChatView(room, 'a'));
});

function radioRoom() {
  const room = fixture();
  room.play.inventories = {
    a: { items: [{ id: 'walkie_talkie' }], tokens: [] },
    b: { items: [{ id: 'walkie_companion' }], tokens: [] },
    c: { items: [], tokens: [] },
  };
  room.play.walkie = { pair: { ownerId: 'a', partnerId: 'b' }, invalidReason: null, results: {} };
  room.play.round.visitors[1].roomId = 'study_room';
  return room;
}

test('the fixed walkie channel reaches only both device holders without merging their room channels', () => {
  const room = radioRoom();
  assert.deepEqual(getChatView(room, 'a').channels.map(channel => channel.kind), ['room', 'walkie']);
  assert.equal(getChatView(room, 'a').channel.kind, 'room');
  sendChat(room, 'a', { text: 'paired secret', channelKind: 'walkie', roomId: null, recipientIds: ['c', 'h'] }, 1000);
  assert.equal(getChatView(room, 'b').messages[0].text, 'paired secret');
  for (const id of ['c', 'h']) {
    assert.deepEqual(getChatView(room, id).messages, []);
    assert.equal(getChatView(room, id).channels.some(channel => channel.kind === 'walkie'), false);
  }
  sendChat(room, 'b', { text: 'room only', channelKind: 'room', roomId: 'study_room' }, 2000);
  assert.equal(getChatView(room, 'c').messages[0].text, 'room only');
  assert.equal(getChatView(room, 'a').messages.length, 1);
  assert.throws(() => sendChat(room, 'c', { text: 'forged', channelKind: 'walkie', roomId: null }, 3000), /对象已改变/);
  assert.throws(() => sendChat(room, 'a', { text: 'forged room', channelKind: 'walkie', roomId: 'bathroom_room' }, 3000), /对象已改变/);
});

test('theft and death remove the private send channel permanently while preserving previously received messages', () => {
  for (const cause of ['theft', 'death']) {
    const room = radioRoom();
    sendChat(room, 'a', { text: 'old private message', channelKind: 'walkie', roomId: null }, 1000);
    if (cause === 'theft') invalidateWalkieForTheft(room.play, { id: 'walkie_companion' });
    else {
      room.play.round.visitors[1].status = 'box_person';
      room.play.ghosts.push({ playerId: 'b', cornerId: 'children_bed', banished: false });
      invalidateWalkieForDeath(room.play, 'b');
    }
    for (const id of ['a', 'b']) {
      assert.equal(getChatView(room, id).channels.some(channel => channel.kind === 'walkie'), false);
      assert.equal(getChatView(room, id).messages[0].text, 'old private message');
    }
    assert.throws(() => sendChat(room, 'a', { text: 'cannot send', channelKind: 'walkie', roomId: null }, 3000), /对象已改变/);
    assert.deepEqual(getChatView(room, 'h').messages, []);
    const restored = JSON.parse(JSON.stringify(room));
    assert.equal(getChatView(restored, 'a').channels.some(channel => channel.kind === 'walkie'), false);
    assert.equal(getChatView(restored, 'b').messages[0].text, 'old private message');
  }
});

test('walkie text does not trigger same-room hako death or disclose the contents globally', () => {
  const room = radioRoom();
  room.play.round.hidingCornerId = 'study_books';
  sendChat(room, 'b', { text: 'text remains safe', channelKind: 'walkie', roomId: null }, 1000);
  assert.equal(room.play.round.visitors[1].status, 'alive');
  assert.deepEqual(room.play.ghosts, []);
  assert.equal(room.play.itemEvents, undefined);
  assert.deepEqual(getChatView(room, 'c').messages, []);
  assert.deepEqual(getChatView(room, 'h').messages, []);
});
