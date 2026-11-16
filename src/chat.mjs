import { randomUUID } from 'node:crypto';
import { getLogicalRoomId } from './maps.mjs';
import { getWalkieParticipants } from './walkie.mjs';

const HISTORY_LIMIT = 120;

function channelFor(room, playerId) {
  const play = room.play;
  if (!play) return null;
  const visitor = play.round.visitors.find(player => player.id === playerId);
  if (visitor?.status === 'alive') {
    return { kind: 'room', roomId: getLogicalRoomId(visitor.roomId),
      recipientIds: play.round.visitors.filter(player => player.status === 'alive'
        && getLogicalRoomId(player.roomId) === getLogicalRoomId(visitor.roomId)).map(player => player.id) };
  }
  const ghost = play.ghosts?.find(actor => actor.playerId === playerId && !actor.banished);
  if (playerId === play.round.hakoId || ghost) {
    return { kind: 'hako', roomId: null,
      recipientIds: [play.round.hakoId, ...(play.ghosts || []).filter(actor => !actor.banished).map(actor => actor.playerId)] };
  }
  return null;
}

function channelsFor(room, playerId) {
  const normal = channelFor(room, playerId);
  const pair = getWalkieParticipants(room.play, playerId);
  return [...(normal ? [normal] : []), ...(pair.length ? [{ kind: 'walkie', roomId: null, recipientIds: pair }] : [])];
}

export function sendChat(room, playerId, input, now = Date.now()) {
  const channels = channelsFor(room, playerId);
  const channel = channels.find(candidate => candidate.kind === input.channelKind);
  if (!channels.length) throw new Error('当前没有可用的聊天频道。');
  if (!channel || (input.roomId ?? null) !== channel.roomId) {
    throw new Error('聊天对象已改变，请查看当前频道后重新发送。');
  }
  if (typeof input.text !== 'string') throw new Error('请输入聊天内容。');
  const value = input.text.trim();
  if (!value || Array.from(value).length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('聊天内容须为1至300个字符。');
  }
  const last = (room.chatMessages || []).findLast(message => message.senderId === playerId);
  if (last && now - last.sentAt < 800) throw new Error('发送过快，请稍候再发。');
  const message = { id: randomUUID(), senderId: playerId, text: value, sentAt: now,
    kind: channel.kind, roomId: channel.roomId, recipientIds: channel.recipientIds };
  room.chatMessages = [...(room.chatMessages || []), message].slice(-HISTORY_LIMIT);
  room.chatRevision = (room.chatRevision || 0) + 1;
}

export function getChatView(room, playerId) {
  const channels = channelsFor(room, playerId).map(channel => ({ kind: channel.kind, roomId: channel.roomId,
    participantIds: channel.recipientIds.filter(id => room.players.some(player => player.id === id)) }));
  return { revision: room.chatRevision || 0,
    channel: channels[0] || null, channels,
    messages: (room.chatMessages || []).filter(message => message.recipientIds.includes(playerId))
      .slice(-60).map(({ id, senderId, text, sentAt, kind, roomId }) => ({ id, senderId, text, sentAt, kind, roomId })) };
}
