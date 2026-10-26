import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_TILES, getTile } from '../src/maps.mjs';
import {
  createSetup, drawTile, placeTile, getLegalPlacements, getConnections, getSetupView,
} from '../src/game.mjs';

const visitors = ['visitor-a', 'visitor-b', 'visitor-c'];
const deck = ['study', 'bathroom', 'dining', 'upstairs', 'basement', 'children', 'storage', 'living'];
const setup = (order = deck) => createSetup(visitors, { deck: order });
const position = (floor, x, y, rotation = 0) => ({ floor, x, y, rotation });

function rejectsWithoutMutation(game, action) {
  const before = structuredClone(game);
  assert.throws(action, /[\u4e00-\u9fff]/);
  assert.deepEqual(game, before);
}

test('catalog preserves nine boards, thirteen distinct rooms and all twenty-four corners', () => {
  assert.equal(MAP_TILES.length, 9);
  const rooms = MAP_TILES.flatMap(tile => tile.rooms);
  assert.equal(rooms.length, 13);
  assert.equal(new Set(rooms.map(room => room.id)).size, 13);
  const corners = rooms.flatMap(room => room.corners);
  assert.equal(corners.length, 24);
  assert.equal(new Set(corners.map(corner => corner.id)).size, 24);
  assert.equal(rooms.find(room => room.id === 'toilet_stall').corners.length, 1);
  assert.deepEqual(rooms.filter(room => room.haunted).map(room => room.id).sort(), ['children_room', 'dark_room']);
  assert.equal(getTile('missing'), undefined);
  for (const tile of MAP_TILES) {
    for (const room of tile.rooms) {
      assert.ok(room.shape.length >= 4);
      for (const point of [...room.shape, [room.label.x, room.label.y], ...room.corners.map(c => [c.x, c.y])]) {
        assert.ok(point.every(value => Number.isFinite(value) && value >= 0 && value <= 100));
      }
    }
    for (const roomId of Object.values(tile.doors)) assert.ok(tile.rooms.some(room => room.id === roomId));
    for (const door of tile.internalDoors) {
      assert.equal(door.rooms.length, 2);
      assert.ok(door.rooms.every(id => tile.rooms.some(room => room.id === id)));
    }
  }
});

test('foreground study has no west door from the board underneath it', () => {
  assert.deepEqual(getTile('study').doors, { N: 'study_room', E: 'dark_room' });
  assert.deepEqual(getTile('basement').doors, {});
  assert.equal(getTile('hall').doors.S, undefined);
});

test('setup starts with only the hall and keeps the undrawn deck private', () => {
  const originalDeck = [...deck];
  const game = createSetup(visitors, { deck: originalDeck });
  assert.deepEqual(game.placements, [{ tileId: 'hall', floor: 1, x: 0, y: 0, rotation: 0 }]);
  assert.equal(game.phase, 'map_setup');
  assert.equal(game.turnPlayerId, visitors[0]);
  let view = getSetupView(game);
  assert.equal(view.remaining, 8);
  assert.equal(view.drawnTileId, null);
  assert.deepEqual(view.legalPlacements, []);
  assert.equal('deck' in view, false);
  drawTile(game, visitors[0]);
  assert.equal(game.drawnTileId, 'study');
  assert.equal(game.placements.length, 1);
  assert.equal(game.turnPlayerId, visitors[0]);
  assert.equal(getSetupView(game).remaining, 7);
  assert.deepEqual(originalDeck, deck);
  assert.deepEqual(visitors, ['visitor-a', 'visitor-b', 'visitor-c']);
  view = getSetupView(game);
  view.placements[0].x = 99;
  assert.equal(game.placements[0].x, 0);
});

test('invalid visitor lists and injected decks are rejected', () => {
  assert.throws(() => createSetup(['a', 'b']), /访问者/);
  assert.throws(() => createSetup(['a', 'a', 'b']), /访问者/);
  assert.throws(() => createSetup(['a', 'b', '']), /访问者/);
  assert.throws(() => setup(['hall', ...deck.slice(1)]), /地图/);
  assert.throws(() => setup(deck.slice(1)), /地图/);
  assert.throws(() => setup(['study', ...deck.slice(0, 7)]), /地图/);
});

test('only the current visitor may draw once and then place', () => {
  const game = setup();
  rejectsWithoutMutation(game, () => drawTile(game, 'hako'));
  rejectsWithoutMutation(game, () => drawTile(game, visitors[1]));
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 0, -1, 2)));
  drawTile(game, visitors[0]);
  rejectsWithoutMutation(game, () => drawTile(game, visitors[0]));
  rejectsWithoutMutation(game, () => placeTile(game, visitors[1], position(1, 0, -1, 2)));
  placeTile(game, visitors[0], position(1, 0, -1, 2));
  assert.equal(game.drawnTileId, null);
  assert.equal(game.turnPlayerId, visitors[1]);
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 0, -2, 2)));
});

test('door alignment follows all four clockwise rotations and rejects a one-sided doorway', () => {
  const game = setup();
  drawTile(game, visitors[0]);
  // Study N/E become N/E, E/S, S/W, W/N after clockwise quarter-turns.
  const expected = [
    [position(1, -1, 0)],
    [position(1, 0, -1, 1), position(1, -1, 0, 1)],
    [position(1, 0, -1, 2), position(1, 1, 0, 2)],
    [position(1, 1, 0, 3)],
  ];
  for (let rotation = 0; rotation < 4; rotation++) {
    const actual = getLegalPlacements(game, rotation).sort((a, b) => a.x - b.x || a.y - b.y);
    const want = expected[rotation].sort((a, b) => a.x - b.x || a.y - b.y);
    assert.deepEqual(actual, want);
  }
  assert.equal(getSetupView(game).legalPlacements.length, 6);
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 1, 0)));
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 0, 1)));
});

test('overlap, noninteger coordinates, bad rotations and illegal floors cannot mutate setup', () => {
  const game = setup();
  drawTile(game, visitors[0]);
  for (const target of [
    position(1, 0, 0), position(1, 8, 8), position(1, 0.5, -1, 2),
    position(1, 0, -1, 4), position(1, 0, -1, -1), position(1, 0, -1, 0.5),
    position(2, 0, 0), position(-1, 0, 0), position(3, 0, 0),
    position(1, '0', -1, 2), position(1, Infinity, -1, 2),
  ]) rejectsWithoutMutation(game, () => placeTile(game, visitors[0], target));
});

test('a valid doorway allows another touching edge to remain a wall', () => {
  const game = setup();
  // Existing L: hall at origin, living north, study northeast facing west/south.
  game.placements.push(
    { tileId: 'living', ...position(1, 0, -1) },
    { tileId: 'study', ...position(1, 1, -1, 2) },
  );
  game.deck = ['dining', ...deck.filter(id => !['study', 'living', 'dining'].includes(id))];
  drawTile(game, visitors[0]);
  // Dining N has a door to study S, dining W is a wall after rotation 1.
  placeTile(game, visitors[0], position(1, 1, 0, 1));
  const edges = getConnections(game.placements);
  assert.ok(edges.some(edge => [edge.from, edge.to].includes('dining_room') && [edge.from, edge.to].includes('study_room')));
  assert.ok(!edges.some(edge => [edge.from, edge.to].includes('dining_room') && [edge.from, edge.to].includes('hall_room')));
});

test('upstairs and basement must each be drawn and explicitly placed on their own floor', () => {
  const game = setup(['upstairs', 'basement', 'study', 'bathroom', 'dining', 'children', 'storage', 'living']);
  assert.ok(!game.placements.some(p => p.floor === 2 || p.floor === -1));
  drawTile(game, visitors[0]);
  assert.equal(game.placements.length, 1);
  assert.deepEqual(getLegalPlacements(game, 3), [position(2, 0, 0, 3)]);
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 1, 0)));
  placeTile(game, visitors[0], position(2, 0, 0, 3));
  drawTile(game, visitors[1]);
  assert.deepEqual(getLegalPlacements(game, 1), [position(-1, 0, 0, 1)]);
  rejectsWithoutMutation(game, () => placeTile(game, visitors[1], position(2, 1, 0)));
  placeTile(game, visitors[1], position(-1, 0, 0, 1));
  drawTile(game, visitors[2]);
  assert.ok(getSetupView(game).legalPlacements.some(p => p.floor === 2));
  assert.ok(!getSetupView(game).legalPlacements.some(p => p.floor === -1));
});

test('connections include split rooms, rotated external doors and stairs only when both ends exist', () => {
  const placements = [
    { tileId: 'hall', ...position(1, 0, 0) },
    { tileId: 'study', ...position(1, 0, -1, 2) },
    { tileId: 'upstairs', ...position(2, 0, 0, 3) },
    { tileId: 'storage', ...position(2, 0, -1, 3) },
    { tileId: 'basement', ...position(-1, 0, 0) },
    { tileId: 'bathroom', ...position(1, -1, 0) },
  ];
  const edges = getConnections(placements);
  const keys = edges.map(({ from, to, kind }) => `${[from, to].sort().join(':')}:${kind}`).sort();
  assert.deepEqual(keys, [
    'bathroom_room:hall_room:door', 'bathroom_room:toilet_stall:door',
    'basement_room:storage_room:stairs', 'blue_bedroom:upstairs_hall:door',
    'dark_room:study_room:door', 'hall_room:study_room:door',
    'hall_room:upstairs_hall:stairs', 'kitchen:storage_room:door',
    'kitchen:upstairs_hall:door',
  ].sort());
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(getConnections([{ tileId: 'hall', ...position(1, 0, 0) }]), []);
});

test('eight visitor placements finish setup, stop actions and expose no future deck', () => {
  const game = setup();
  for (let index = 0; index < 8; index++) {
    const playerId = visitors[index % 3];
    assert.equal(game.turnPlayerId, playerId);
    drawTile(game, playerId);
    assert.equal(game.drawnTileId, deck[index]);
    const targets = getSetupView(game).legalPlacements;
    assert.ok(targets.length > 0);
    placeTile(game, playerId, targets[(index * 3) % targets.length]);
    assert.equal(game.placements.length, index + 2);
    assert.equal(game.phase, index === 7 ? 'map_ready' : 'map_setup');
  }
  const view = getSetupView(game);
  assert.equal(view.phase, 'map_ready');
  assert.equal(view.remaining, 0);
  assert.equal(view.drawnTileId, null);
  assert.equal(view.turnPlayerId, null);
  assert.deepEqual(view.legalPlacements, []);
  assert.equal(view.connections.filter(edge => edge.kind === 'stairs').length, 2);
  rejectsWithoutMutation(game, () => drawTile(game, visitors[0]));
  rejectsWithoutMutation(game, () => placeTile(game, visitors[0], position(1, 0, 1)));
});

test('different deck orders and selected rotations can all finish a complete layout', () => {
  for (let iteration = 0; iteration < 24; iteration++) {
    const order = [...deck.slice(iteration % 8), ...deck.slice(0, iteration % 8)];
    if (iteration % 2) order.reverse();
    const game = setup(order);
    for (let index = 0; index < 8; index++) {
      drawTile(game, game.turnPlayerId);
      const all = getSetupView(game).legalPlacements;
      assert.ok(all.length > 0, `${iteration}: ${game.drawnTileId} must have a legal placement`);
      placeTile(game, game.turnPlayerId, all[(iteration + index * 7) % all.length]);
    }
    assert.equal(game.phase, 'map_ready');
    assert.equal(new Set(game.placements.map(p => p.tileId)).size, 9);
  }
});
