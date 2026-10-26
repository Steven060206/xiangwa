import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_TILES } from '../src/maps.mjs';
import {
  getRoom, getCornerRoom, getMoveTargets, getInitialHidingCorners, getHidingTargets,
} from '../src/movement.mjs';

const placed = (tileId, floor, x, y, rotation = 0) => ({ tileId, floor, x, y, rotation });
const hall = () => placed('hall', 1, 0, 0);

function connectedMap() {
  return [
    hall(),
    placed('study', 1, 0, -1, 2),
    placed('children', 1, 1, 0),
    placed('living', 1, -1, 0),
    placed('upstairs', 2, 0, 0),
    placed('storage', 2, 1, 0),
    placed('basement', -1, 0, 0),
  ];
}

test('room and corner lookups return the catalog room and reject unknown ids with undefined', () => {
  for (const tile of MAP_TILES) {
    for (const room of tile.rooms) {
      assert.equal(getRoom(room.id), room);
      for (const corner of room.corners) assert.equal(getCornerRoom(corner.id), room);
    }
  }
  assert.equal(getRoom('missing'), undefined);
  assert.equal(getCornerRoom('missing'), undefined);
  assert.equal(getRoom('hall_clock'), undefined);
  assert.equal(getCornerRoom('hall_room'), undefined);
});

test('aligned external doors work both ways and touching a one-sided doorway does not connect', () => {
  // All four boards connect through the L-shaped route; dining touches the hall's east door with a wall.
  const placements = [
    hall(), placed('living', 1, 0, -1),
    placed('study', 1, 1, -1, 2), placed('dining', 1, 1, 0, 1),
  ];
  assert.deepEqual(getMoveTargets(placements, 'hall_room'), ['living_room']);
  assert.deepEqual(getMoveTargets(placements, 'living_room'), ['dark_room', 'hall_room']);
  assert.deepEqual(getMoveTargets(placements, 'dining_room'), ['study_room']);
  assert.deepEqual(getMoveTargets(placements, 'study_room'), ['dark_room', 'dining_room']);
  assert.ok(!getMoveTargets(placements, 'hall_room').includes('dining_room'));
  assert.ok(!getMoveTargets(placements, 'dining_room').includes('hall_room'));
});

test('all four rotations connect the hall only to the room owning the rotated door', () => {
  const cases = [
    { x: -1, y: 0, rotation: 0, roomId: 'dark_room', other: 'study_room' },
    { x: 0, y: -1, rotation: 1, roomId: 'dark_room', other: 'study_room' },
    { x: 0, y: -1, rotation: 2, roomId: 'study_room', other: 'dark_room' },
    { x: 1, y: 0, rotation: 3, roomId: 'study_room', other: 'dark_room' },
  ];
  for (const { x, y, rotation, roomId, other } of cases) {
    const placements = [hall(), placed('study', 1, x, y, rotation)];
    assert.deepEqual(getMoveTargets(placements, 'hall_room'), [roomId], `rotation ${rotation}`);
    assert.deepEqual(getMoveTargets(placements, roomId), ['hall_room', other].sort());
    assert.deepEqual(getMoveTargets(placements, other), [roomId]);
  }
});

test('split boards require their internal door and do not grant movement through the whole board', () => {
  const placements = [
    hall(), placed('study', 1, 0, -1, 2), placed('bathroom', 1, -1, 0),
    placed('upstairs', 2, 0, 0, 3), placed('storage', 2, 0, -1, 3),
    placed('basement', -1, 0, 0),
  ];
  const expected = {
    hall_room: ['bathroom_room', 'study_room', 'upstairs_hall'],
    study_room: ['dark_room', 'hall_room'],
    dark_room: ['study_room'],
    bathroom_room: ['hall_room', 'toilet_stall'],
    toilet_stall: ['bathroom_room'],
    upstairs_hall: ['blue_bedroom', 'hall_room', 'kitchen'],
    blue_bedroom: ['upstairs_hall'],
    kitchen: ['storage_room', 'upstairs_hall'],
    storage_room: ['basement_room', 'kitchen'],
    basement_room: ['storage_room'],
  };
  for (const [roomId, targets] of Object.entries(expected)) {
    assert.deepEqual(getMoveTargets(placements, roomId), targets, roomId);
    assert.ok(!targets.includes(roomId));
  }
});

test('stairs exist only when both rooms are placed and connect storage on the second floor to basement', () => {
  assert.deepEqual(getMoveTargets([hall()], 'hall_room'), []);
  assert.deepEqual(getMoveTargets([placed('upstairs', 2, 0, 0)], 'upstairs_hall'), ['blue_bedroom']);
  assert.deepEqual(getMoveTargets([placed('storage', 2, 0, 0)], 'storage_room'), ['kitchen']);
  assert.deepEqual(getMoveTargets([placed('basement', -1, 0, 0)], 'basement_room'), []);

  const placements = connectedMap();
  assert.ok(getMoveTargets(placements, 'hall_room').includes('upstairs_hall'));
  assert.ok(getMoveTargets(placements, 'upstairs_hall').includes('hall_room'));
  assert.deepEqual(getMoveTargets(placements, 'storage_room'), ['basement_room', 'kitchen']);
  assert.deepEqual(getMoveTargets(placements, 'basement_room'), ['storage_room']);
});

test('external doors do not connect across floors even when coordinates and door directions align', () => {
  const placements = [hall(), placed('living', 2, 1, 0)];
  assert.deepEqual(getMoveTargets(placements, 'hall_room'), []);
  assert.deepEqual(getMoveTargets(placements, 'living_room'), []);
});

test('blocked doors work symmetrically for visitors, leave stairs open and never block hako or box people', () => {
  const placements = connectedMap();
  const blockedDoors = [
    { from: 'study_room', to: 'hall_room' },
    { from: 'dark_room', to: 'study_room' },
    { from: 'hall_room', to: 'upstairs_hall' },
    { from: 'storage_room', to: 'basement_room' },
  ];
  const options = { blockedDoors };
  assert.deepEqual(getMoveTargets(placements, 'hall_room', options), ['children_room', 'living_room', 'upstairs_hall']);
  assert.deepEqual(getMoveTargets(placements, 'study_room', options), []);
  assert.deepEqual(getMoveTargets(placements, 'dark_room', options), []);
  assert.deepEqual(getMoveTargets(placements, 'upstairs_hall', options), ['blue_bedroom', 'hall_room', 'kitchen']);
  assert.deepEqual(getMoveTargets(placements, 'storage_room', options), ['basement_room', 'kitchen']);
  assert.deepEqual(getMoveTargets(placements, 'basement_room', options), ['storage_room']);

  const reversed = blockedDoors.map(({ from, to }) => ({ from: to, to: from }));
  for (const roomId of ['hall_room', 'study_room', 'dark_room', 'upstairs_hall', 'storage_room', 'basement_room']) {
    assert.deepEqual(getMoveTargets(placements, roomId, { blockedDoors: reversed }), getMoveTargets(placements, roomId, options));
    for (const actor of ['hako', 'box_person']) {
      assert.deepEqual(getMoveTargets(placements, roomId, { actor, blockedDoors }), getMoveTargets(placements, roomId));
    }
  }
});

test('initial hiding corners include only haunted rooms actually placed on this map', () => {
  assert.deepEqual(getInitialHidingCorners([]), []);
  assert.deepEqual(getInitialHidingCorners([hall()]), []);
  assert.deepEqual(getInitialHidingCorners([hall(), placed('study', 1, 0, -1, 2)]), ['dark_bed', 'dark_wardrobe']);
  assert.deepEqual(getInitialHidingCorners(connectedMap()), [
    'children_bed', 'children_cabinet', 'children_toys', 'dark_bed', 'dark_wardrobe',
  ]);
});

test('hiding may stay or change corners in the current room and move through one door, never two rooms', () => {
  const placements = connectedMap();
  assert.deepEqual(getHidingTargets(placements, 'study_books'), [
    'dark_bed', 'dark_wardrobe', 'hall_clock', 'study_books', 'study_desk',
  ]);
  assert.deepEqual(getHidingTargets(placements, 'dark_bed'), [
    'dark_bed', 'dark_wardrobe', 'study_books', 'study_desk',
  ]);
  assert.deepEqual(getHidingTargets(placements, 'hall_clock'), [
    'children_bed', 'children_cabinet', 'children_toys', 'hall_clock',
    'living_record', 'living_sofa', 'living_vase', 'study_books', 'study_desk', 'upstairs_armor',
  ]);
});

test('hiding traverses stairs and respects the split room on either end of the route', () => {
  const placements = connectedMap();
  assert.deepEqual(getHidingTargets(placements, 'upstairs_armor'), [
    'hall_clock', 'kitchen_cabinet', 'kitchen_fridge', 'upstairs_armor', 'upstairs_bed',
  ]);
  assert.deepEqual(getHidingTargets(placements, 'storage_box'), [
    'basement_barrel', 'basement_pile', 'basement_suitcase', 'kitchen_cabinet', 'kitchen_fridge', 'storage_box',
  ]);
  assert.deepEqual(getHidingTargets(placements, 'basement_barrel'), [
    'basement_barrel', 'basement_pile', 'basement_suitcase', 'storage_box',
  ]);
});

test('unknown and unplaced source rooms or corners produce Chinese errors', () => {
  const placements = [hall()];
  for (const roomId of ['missing', 'study_room', 'dark_room', 'upstairs_hall']) {
    assert.throws(() => getMoveTargets(placements, roomId), /[\u4e00-\u9fff]/);
  }
  assert.throws(() => getMoveTargets([], 'hall_room'), /[\u4e00-\u9fff]/);
  for (const cornerId of ['missing', 'study_books', 'dark_bed', 'upstairs_armor']) {
    assert.throws(() => getHidingTargets(placements, cornerId), /[\u4e00-\u9fff]/);
  }
  assert.throws(() => getHidingTargets([], 'hall_clock'), /[\u4e00-\u9fff]/);
  assert.throws(() => getMoveTargets(placements, 'hall_room', { actor: 'unknown' }), /[\u4e00-\u9fff]/);
});

test('movement queries preserve placements and options and return independent sorted arrays', () => {
  const placements = connectedMap();
  const options = { actor: 'visitor', blockedDoors: [{ from: 'hall_room', to: 'study_room' }] };
  const before = structuredClone({ placements, options, catalog: MAP_TILES });
  for (const placement of placements) Object.freeze(placement);
  Object.freeze(placements);
  for (const blocked of options.blockedDoors) Object.freeze(blocked);
  Object.freeze(options.blockedDoors);
  Object.freeze(options);

  const queries = [
    () => getMoveTargets(placements, 'hall_room', options),
    () => getInitialHidingCorners(placements),
    () => getHidingTargets(placements, 'hall_clock'),
  ];
  for (const query of queries) {
    const first = query();
    const expected = [...first];
    assert.deepEqual(first, [...first].sort());
    assert.equal(new Set(first).size, first.length);
    const second = query();
    assert.notEqual(first, second);
    first.push('not-a-real-target');
    second.reverse();
    assert.deepEqual(query(), expected);
  }
  assert.deepEqual({ placements, options, catalog: MAP_TILES }, before);
});
