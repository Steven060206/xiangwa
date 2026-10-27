import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatView, sendChat } from '../src/chat.mjs';

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
