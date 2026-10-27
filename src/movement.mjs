import { getTile, getLogicalRoomId, getLogicalRooms } from './maps.mjs';
import { getConnections } from './game.mjs';

const ROOMS = getLogicalRooms();

export function getRoom(roomId) {
  return ROOMS.find(room => room.id === getLogicalRoomId(roomId));
}

export function getCornerRoom(cornerId) {
  if (typeof cornerId === 'string' && cornerId.startsWith('suitcase:')) return getRoom(cornerId.slice(9));
  return ROOMS.find(room => room.corners.some(corner => corner.id === cornerId));
}

function getPlacedRooms(placements) {
  return placements.map(placement => getRoom(getTile(placement.tileId).rooms[0].id));
}

function assertPlacedRoom(placements, roomId) {
  if (!getPlacedRooms(placements).some(room => room.id === roomId)) {
    throw new Error('该房间不在已摆放的地图中。');
  }
}

export function getMoveTargets(placements, roomId, { actor = 'visitor', blockedDoors = [] } = {}) {
  roomId = getLogicalRoomId(roomId);
  assertPlacedRoom(placements, roomId);
  if (!['visitor', 'hako', 'box_person'].includes(actor)) {
    throw new Error('移动角色无效。');
  }
  const targets = new Set();
  for (const connection of getConnections(placements)) {
    const { from, to, kind } = connection;
    if (from !== roomId && to !== roomId) continue;
    if (actor === 'visitor' && kind === 'door' && blockedDoors.some(blocked => (
      (getLogicalRoomId(blocked.from) === from && getLogicalRoomId(blocked.to) === to)
      || (getLogicalRoomId(blocked.from) === to && getLogicalRoomId(blocked.to) === from)
    ))) continue;
    const target = from === roomId ? to : from;
    if (target !== roomId) targets.add(target);
  }
  return [...targets].sort();
}

export function getInitialHidingCorners(placements) {
  return getPlacedRooms(placements)
    .filter(room => room.haunted)
    .flatMap(room => room.corners.map(corner => corner.id))
    .sort();
}

export function getHidingTargets(placements, cornerId) {
  const room = getCornerRoom(cornerId);
  if (!room || !getPlacedRooms(placements).some(placed => placed.id === room.id)) {
    throw new Error('该角落不在已摆放的地图中。');
  }
  const roomIds = [room.id, ...getMoveTargets(placements, room.id, { actor: 'hako' })];
  return roomIds.flatMap(roomId => getRoom(roomId).corners.map(corner => corner.id)).sort();
}
