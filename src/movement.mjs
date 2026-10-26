import { MAP_TILES, getTile } from './maps.mjs';
import { getConnections } from './game.mjs';

const ROOMS = MAP_TILES.flatMap(tile => tile.rooms);

export function getRoom(roomId) {
  return ROOMS.find(room => room.id === roomId);
}

export function getCornerRoom(cornerId) {
  return ROOMS.find(room => room.corners.some(corner => corner.id === cornerId));
}

function getPlacedRooms(placements) {
  return placements.flatMap(placement => getTile(placement.tileId).rooms);
}

function assertPlacedRoom(placements, roomId) {
  if (!getPlacedRooms(placements).some(room => room.id === roomId)) {
    throw new Error('该房间不在已摆放的地图中。');
  }
}

export function getMoveTargets(placements, roomId, { actor = 'visitor', blockedDoors = [] } = {}) {
  assertPlacedRoom(placements, roomId);
  if (!['visitor', 'hako', 'box_person'].includes(actor)) {
    throw new Error('移动角色无效。');
  }
  const targets = new Set();
  for (const connection of getConnections(placements)) {
    const { from, to, kind } = connection;
    if (from !== roomId && to !== roomId) continue;
    if (actor === 'visitor' && kind === 'door' && blockedDoors.some(blocked => (
      (blocked.from === from && blocked.to === to) || (blocked.from === to && blocked.to === from)
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
