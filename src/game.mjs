import { MAP_TILES, getTile, getLogicalRoomId } from './maps.mjs';

const SIDES = ['N', 'E', 'S', 'W'];
const STEPS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DRAWABLE_IDS = MAP_TILES.filter(tile => tile.id !== 'hall').map(tile => tile.id);
const SPECIAL_FLOORS = { upstairs: 2, basement: -1 };

function shuffled(ids) {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createSetup(visitorIds, { deck } = {}) {
  if (!Array.isArray(visitorIds) || ![3, 4].includes(visitorIds.length)
      || new Set(visitorIds).size !== visitorIds.length
      || Array.from(visitorIds).some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('地图准备需要三名或四名不同的访问者。');
  }
  if (deck !== undefined && (!Array.isArray(deck) || deck.length !== 8 || new Set(deck).size !== 8
      || deck.some(id => !DRAWABLE_IDS.includes(id)))) {
    throw new Error('地图牌堆必须包含大厅以外的八块地图各一块。');
  }
  return {
    phase: 'map_setup',
    visitorIds: [...visitorIds],
    turnPlayerId: visitorIds[0],
    deck: deck === undefined ? shuffled(DRAWABLE_IDS) : [...deck],
    drawnTileId: null,
    placements: [{ tileId: 'hall', floor: 1, x: 0, y: 0, rotation: 0 }],
  };
}

function assertTurn(game, playerId) {
  if (game.phase !== 'map_setup') throw new Error('地图准备已经完成。');
  if (!game.visitorIds.includes(playerId)) throw new Error('只有访问者可以配置地图。');
  if (game.turnPlayerId !== playerId) throw new Error('还没有轮到你配置地图。');
}

export function drawTile(game, playerId) {
  assertTurn(game, playerId);
  if (game.drawnTileId !== null) throw new Error('请先摆放已抽到的地图。');
  if (!game.deck.length) throw new Error('没有尚未抽取的地图。');
  game.drawnTileId = game.deck.shift();
  return getSetupView(game);
}

function assertRotation(rotation) {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) {
    throw new Error('地图旋转必须是0至3的整数。');
  }
}

function rotatedDoors(tileId, rotation) {
  return Object.fromEntries(Object.entries(getTile(tileId).doors).map(([side, roomId]) => [
    SIDES[(SIDES.indexOf(side) + rotation) % 4], roomId,
  ]));
}

export function getLegalPlacements(game, rotation = 0) {
  assertRotation(rotation);
  if (game.phase !== 'map_setup' || game.drawnTileId === null) return [];
  const specialFloor = SPECIAL_FLOORS[game.drawnTileId];
  if (specialFloor !== undefined) return [{ floor: specialFloor, x: 0, y: 0, rotation }];

  const doors = rotatedDoors(game.drawnTileId, rotation);
  const upstairsExists = game.placements.some(p => p.tileId === 'upstairs');
  const candidates = new Map();
  for (const placed of game.placements) {
    if (placed.floor !== 1 && !(placed.floor === 2 && upstairsExists)) continue;
    const existingDoors = rotatedDoors(placed.tileId, placed.rotation);
    for (let side = 0; side < 4; side++) {
      if (!existingDoors[SIDES[side]] || !doors[SIDES[(side + 2) % 4]]) continue;
      const [dx, dy] = STEPS[side];
      const x = placed.x + dx;
      const y = placed.y + dy;
      if (game.placements.some(p => p.floor === placed.floor && p.x === x && p.y === y)) continue;
      const target = { floor: placed.floor, x, y, rotation };
      candidates.set(`${target.floor}:${x}:${y}`, target);
    }
  }
  return [...candidates.values()].sort((a, b) => a.floor - b.floor || a.y - b.y || a.x - b.x);
}

export function placeTile(game, playerId, placement) {
  assertTurn(game, playerId);
  if (game.drawnTileId === null) throw new Error('请先抽取一块地图。');
  if (!placement || typeof placement !== 'object') throw new Error('请选择地图摆放位置。');
  const { floor, x, y, rotation } = placement;
  assertRotation(rotation);
  if (![1, 2, -1].includes(floor) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error('楼层和地图坐标无效。');
  }
  const legal = getLegalPlacements(game, rotation).some(p => p.floor === floor && p.x === x && p.y === y);
  if (!legal) throw new Error('此处无法摆放：地图不可重叠，并须至少有一扇门对接；特殊地图须放在指定楼层。');

  game.placements.push({ tileId: game.drawnTileId, floor, x, y, rotation });
  game.drawnTileId = null;
  if (game.placements.length === MAP_TILES.length) {
    game.phase = 'map_ready';
    game.turnPlayerId = null;
  } else {
    game.turnPlayerId = game.visitorIds[(game.visitorIds.indexOf(playerId) + 1) % game.visitorIds.length];
  }
  return getSetupView(game);
}

export function getConnections(placements) {
  const edges = new Map();
  const roomIds = new Set(placements.flatMap(p => getTile(p.tileId).rooms.map(room => room.id)));
  function add(from, to, kind) {
    from = getLogicalRoomId(from);
    to = getLogicalRoomId(to);
    if (from === to) return;
    const key = `${[from, to].sort().join(':')}:${kind}`;
    if (!edges.has(key)) edges.set(key, { from, to, kind });
  }
  for (const placed of placements) {
    const tile = getTile(placed.tileId);
    for (const door of tile.internalDoors) add(...door.rooms, 'door');
    for (const stairs of tile.stairs) {
      if (roomIds.has(stairs.toRoomId)) add(stairs.roomId, stairs.toRoomId, 'stairs');
    }
    const doors = rotatedDoors(placed.tileId, placed.rotation);
    for (let side = 0; side < 4; side++) {
      const from = doors[SIDES[side]];
      if (!from) continue;
      const [dx, dy] = STEPS[side];
      const neighbor = placements.find(p => p.floor === placed.floor && p.x === placed.x + dx && p.y === placed.y + dy);
      if (!neighbor) continue;
      const to = rotatedDoors(neighbor.tileId, neighbor.rotation)[SIDES[(side + 2) % 4]];
      if (to) add(from, to, 'door');
    }
  }
  return [...edges.values()];
}

export function getSetupView(game) {
  return {
    phase: game.phase,
    placements: game.placements.map(p => ({ ...p })),
    drawnTileId: game.drawnTileId,
    remaining: game.deck.length,
    turnPlayerId: game.turnPlayerId,
    legalPlacements: [0, 1, 2, 3].flatMap(rotation => getLegalPlacements(game, rotation)),
    connections: getConnections(game.placements),
  };
}
