// Directions and room geometry are measured with each printed room name upright.
// Only the foreground board in each reference photo supplies its doors.
const rectangle = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const corner = (id, name, x, y) => ({ id, name, x, y });
const room = (id, name, shape, label, corners, haunted = false) => ({ id, name, shape, label, corners, haunted });
const door = (id, rooms, x, y, orientation = 'horizontal') => ({ id, rooms, x, y, orientation });

export const MAP_TILES = [
  {
    id: 'hall', name: '1楼大厅',
    rooms: [room('hall_room', '1楼大厅', rectangle(0, 0, 100, 100), { x: 50, y: 54 }, [
      corner('hall_clock', '老旧的大钟后', 82, 28),
    ])],
    doors: { N: 'hall_room', E: 'hall_room', W: 'hall_room' },
    internalDoors: [],
    stairs: [{ roomId: 'hall_room', toRoomId: 'upstairs_hall', x: 16, y: 17 }],
    entrance: { name: '正门', x: 50, y: 100, closed: true },
  },
  {
    id: 'study', name: '书房／深色房间',
    rooms: [
      room('study_room', '书房', [[0, 0], [100, 0], [100, 33], [35, 33], [35, 64], [0, 64]], { x: 55, y: 17 }, [
        corner('study_books', '装满书的架子旁', 16, 25),
        corner('study_desk', '写字台下', 84, 19),
      ]),
      room('dark_room', '深色房间', [[35, 33], [100, 33], [100, 100], [0, 100], [0, 64], [35, 64]], { x: 67, y: 53 }, [
        corner('dark_wardrobe', '衣柜中', 15, 82),
        corner('dark_bed', '床上被子里', 83, 82),
      ], true),
    ],
    // The visible orange strip west of this board belongs to a stacked board.
    doors: { N: 'study_room', E: 'dark_room' },
    internalDoors: [door('study_dark', ['study_room', 'dark_room'], 50, 33)],
    stairs: [],
  },
  {
    id: 'bathroom', name: '浴室',
    rooms: [
      room('bathroom_room', '浴室', [[70, 0], [100, 0], [100, 100], [0, 100], [0, 35], [70, 35]], { x: 53, y: 53 }, [
        corner('bathroom_tub', '浴缸', 18, 79),
        corner('bathroom_washer', '布满灰尘的洗衣机里', 83, 79),
      ]),
      room('toilet_stall', '马桶隔间', rectangle(0, 0, 70, 35), { x: 48, y: 17 }, [
        corner('bathroom_toilet', '废旧马桶内', 16, 16),
      ]),
    ],
    doors: { E: 'bathroom_room', S: 'bathroom_room', W: 'bathroom_room' },
    internalDoors: [door('bathroom_toilet_door', ['bathroom_room', 'toilet_stall'], 50, 35)],
    stairs: [],
  },
  {
    id: 'dining', name: '餐厅',
    rooms: [room('dining_room', '餐厅', rectangle(0, 0, 100, 100), { x: 50, y: 49 }, [
      corner('dining_table', '餐厅桌下', 52, 29),
      corner('dining_fireplace', '壁炉内', 22, 82),
    ])],
    doors: { N: 'dining_room', E: 'dining_room', W: 'dining_room' },
    internalDoors: [], stairs: [],
  },
  {
    id: 'upstairs', name: '2楼大厅／深蓝寝室',
    rooms: [
      room('upstairs_hall', '2楼大厅', rectangle(0, 32, 100, 100), { x: 49, y: 53 }, [
        corner('upstairs_armor', '古老盔甲内', 80, 79),
      ]),
      room('blue_bedroom', '深蓝寝室', rectangle(0, 0, 100, 32), { x: 45, y: 14 }, [
        corner('upstairs_bed', '单人床下', 81, 17),
      ]),
    ],
    doors: { E: 'upstairs_hall', W: 'upstairs_hall' },
    internalDoors: [door('upstairs_bedroom_door', ['upstairs_hall', 'blue_bedroom'], 50, 32)],
    stairs: [{ roomId: 'upstairs_hall', toRoomId: 'hall_room', x: 39, y: 86 }],
  },
  {
    id: 'basement', name: '地下室',
    rooms: [room('basement_room', '地下室', rectangle(0, 0, 100, 100), { x: 50, y: 50 }, [
      corner('basement_barrel', '生锈的铁桶内', 18, 19),
      corner('basement_suitcase', '大行礼箱内', 81, 20),
      corner('basement_pile', '杂物堆后边', 20, 80),
    ])],
    doors: {}, internalDoors: [],
    stairs: [{ roomId: 'basement_room', toRoomId: 'storage_room', x: 84, y: 85 }],
  },
  {
    id: 'children', name: '儿童房',
    rooms: [room('children_room', '儿童房', rectangle(0, 0, 100, 100), { x: 49, y: 51 }, [
      corner('children_cabinet', '橱柜中', 18, 19),
      corner('children_toys', '玩具箱中', 79, 21),
      corner('children_bed', '儿童床底下', 20, 80),
    ], true)],
    doors: { N: 'children_room', E: 'children_room', W: 'children_room' },
    internalDoors: [], stairs: [],
  },
  {
    id: 'storage', name: '储藏室／厨房',
    rooms: [
      room('storage_room', '储藏室', [[0, 0], [100, 0], [100, 65], [68, 65], [68, 30], [0, 30]], { x: 68, y: 16 }, [
        corner('storage_box', '破旧木箱中', 84, 48),
      ]),
      room('kitchen', '厨房', [[0, 30], [68, 30], [68, 65], [100, 65], [100, 100], [0, 100]], { x: 45, y: 52 }, [
        corner('kitchen_cabinet', '脏乱的橱柜里', 25, 82),
        corner('kitchen_fridge', '废弃的冰箱里', 84, 83),
      ]),
    ],
    doors: { W: 'kitchen' },
    internalDoors: [door('storage_kitchen_door', ['storage_room', 'kitchen'], 50, 30)],
    stairs: [{ roomId: 'storage_room', toRoomId: 'basement_room', x: 16, y: 15 }],
  },
  {
    id: 'living', name: '客厅',
    rooms: [room('living_room', '客厅', rectangle(0, 0, 100, 100), { x: 50, y: 51 }, [
      corner('living_sofa', '组合沙发下', 48, 28),
      corner('living_vase', '巨大花瓶内', 19, 81),
      corner('living_record', '黑胶唱片机', 82, 81),
    ])],
    doors: { N: 'living_room', E: 'living_room', S: 'living_room', W: 'living_room' },
    internalDoors: [], stairs: [],
  },
];

export function getTile(id) {
  return MAP_TILES.find(tile => tile.id === id);
}

// Printed subdivisions keep their geometry and corner numbering, but each board
// is one game room. Accept old subdivision IDs when restoring existing games.
const LOGICAL_ROOMS = MAP_TILES.map(tile => ({
  ...tile.rooms[0], id: tile.rooms[0].id, name: tile.name, tileId: tile.id,
  corners: tile.rooms.flatMap(room => room.corners),
  haunted: tile.rooms.some(room => room.haunted),
}));

export function getLogicalRoomId(roomId) {
  return MAP_TILES.find(tile => tile.rooms.some(room => room.id === roomId))?.rooms[0].id ?? roomId;
}

export function getLogicalRooms() {
  return LOGICAL_ROOMS;
}
