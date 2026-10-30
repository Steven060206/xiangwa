import { MAP_TILES, getTile, getLogicalRoomId, getLogicalRooms } from './maps.mjs';
import { powerCard } from './powers.mjs';

// These twelve supplied cards are confirmed; a selected edition may inject its own draft pool.
export const INITIAL_ITEMS = Object.freeze([
  { id: 'walkie_talkie', name: '对讲机', description: '持有对讲机的访问者可通过自由行动远距离互看标志，不能远距离交换；与箱娃同房的使用者会死亡。' },
  { id: 'spirit_pen', name: '笔仙', description: '同房有其他访问者时，消耗标准行动询问箱娃是否在指定房间；与箱娃同房的使用者会死亡。' },
  { id: 'ventriloquist_doll', name: '腹语人偶', description: '消耗标准行动指定一个房间：箱娃回答人偶是否在其中，并公开该房间的全部手记；与箱娃同房的使用者会死亡。' },
  { id: 'stethoscope', name: '听诊器', description: '窥探保险箱时可只声明一个数字，正确时翻开该数字；与箱娃同房的使用者会死亡。' },
  { id: 'nightmare_letter', name: '噩梦的来信', description: '消耗标准行动将牌库中的绝望时刻移至牌库底；与箱娃同房的使用者会死亡。' },
  { id: 'shrine_bell', name: '深菱神社之铃', description: '翻牌前可选择额外翻一张；成功后消耗标准行动，限制下一箱娃阶段设置危险度B或C能力。' },
  { id: 'relic_ring', name: '遗物戒指', description: '死亡后到下一个箱娃阶段前维持访问者胜利条件，并可将全部盖放标志和访问者道具交给一名任意存活访问者。' },
  { id: 'smartphone', name: '智能手机', description: '消耗标准行动查看一张可用能力或箱娃手牌；与箱娃同房时不生效且使用者死亡。' },
  { id: 'suitcase', name: '行李箱', description: '消耗标准行动，仅用一次：在当前房间增加一个“行李箱中”角落，并盖放一枚空箱标志。' },
  { id: 'dowsing_rod', name: '占卜棒', description: '消耗标准行动询问箱娃所在楼层；与箱娃同房的使用者会死亡。' },
  { id: 'deduction', name: '归纳推理法', description: '窥探后需放空箱时可使X面朝上；箱娃或箱人潜入房间时仍可将其重新盖放。' },
  { id: 'night_vision', name: '夜视仪', description: '窥探发现手记时可获得本局开局未选的访问者道具；与箱娃同房时会在获得道具前死亡。' },
].map(item => Object.freeze(item)));

const TOOLS = Object.freeze([
  { id: 'white_stick', name: '白木椿' },
  { id: 'gasoline', name: '汽油' },
  { id: 'rusty_chain', name: '锈锁链' },
].map(tool => Object.freeze(tool)));
const POWER_NAMES = [null, '就在你身旁', '马上就到哟', '打不开的门', '动来动去', '我在你身后',
  '好想打开它', '快把它给我', '我的玛丽小姐', '虚假的回应', '鬼来电', '虚假的哭喊'];
const INITIAL_POWER_IDS = Array.from({ length: 10 }, (_, index) => index + 1);
// Pending openings from the previous version have no draw. Keep their three
// choices stable across read-only snapshots and restarts until one is selected.
const LEGACY_INITIAL_POWER_CANDIDATES = [1, 4, 2];

function initialPowerCandidates(opening) {
  const saved = opening.initialPowerCandidates ?? LEGACY_INITIAL_POWER_CANDIDATES;
  // Preserve a pending saved draw without leaving the innate NO.11 among its choices.
  return [...new Set([...saved, ...LEGACY_INITIAL_POWER_CANDIDATES, ...INITIAL_POWER_IDS])]
    .filter(id => INITIAL_POWER_IDS.includes(id)).slice(0, 3);
}
const PASSWORD_NUMBERS = [1, 2, 3, 4, 5, 6];
const SAFE_CORNER = 'study_desk';
const HIDING_ROOM_IDS = ['children_room', 'study_room'];

function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assertVisitors(visitorIds) {
  if (!Array.isArray(visitorIds) || ![3, 4].includes(visitorIds.length)
      || new Set(visitorIds).size !== visitorIds.length
      || Array.from(visitorIds).some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('开局准备需要三名或四名不同的访问者。');
  }
}

function copyItem(item) {
  return { id: item.id, name: item.name, description: item.description };
}

function copyChoices(choices) {
  return choices.map(choice => ({ playerId: choice.playerId, itemId: choice.itemId }));
}

export function createItemDraft(visitorIds, { items = INITIAL_ITEMS } = {}) {
  assertVisitors(visitorIds);
  if (!Array.isArray(items) || items.length < visitorIds.length || new Set(items.map(item => item?.id)).size !== items.length
      || Array.from(items).some(item => !item || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.name !== 'string' || !item.name.trim() || typeof item.description !== 'string')) {
    throw new Error('访问者道具候选须足够全体访问者各选一张，且卡牌须不同、资料完整。');
  }
  return {
    phase: 'item_draft',
    visitorIds: [...visitorIds],
    turnPlayerId: visitorIds[0],
    items: items.map(copyItem),
    choices: [],
  };
}

export function chooseItem(draft, playerId, itemId) {
  if (draft.phase !== 'item_draft') throw new Error('访问者道具选择已经完成。');
  if (!draft.visitorIds.includes(playerId)) throw new Error('只有访问者可以选择初始道具。');
  if (draft.turnPlayerId !== playerId) throw new Error('还没有轮到你选择初始道具。');
  if (!draft.items.some(item => item.id === itemId)) throw new Error('请选择候选列表中的访问者道具。');
  if (draft.choices.some(choice => choice.itemId === itemId)) throw new Error('这张道具已被其他访问者选走。');
  draft.choices.push({ playerId, itemId });
  if (draft.choices.length === draft.visitorIds.length) {
    draft.phase = 'items_ready';
    draft.turnPlayerId = null;
  } else {
    draft.turnPlayerId = draft.visitorIds[draft.choices.length];
  }
  return getItemDraftView(draft);
}

export function getItemDraftView(draft) {
  return {
    phase: draft.phase,
    visitorIds: [...draft.visitorIds],
    turnPlayerId: draft.turnPlayerId,
    choices: draft.choices.map(choice => ({
      ...choice, itemName: draft.items.find(item => item.id === choice.itemId).name,
      itemDescription: draft.items.find(item => item.id === choice.itemId).description,
    })),
    availableItems: draft.items.filter(item => !draft.choices.some(choice => choice.itemId === item.id)).map(copyItem),
  };
}

function getRooms(opening) {
  const rooms = getLogicalRooms();
  return opening.placements.map(placement => rooms.find(room => room.tileId === placement.tileId));
}

function getCorners(opening) {
  return getRooms(opening).flatMap(room => room.corners.map(corner => ({ id: corner.id, roomId: room.id })));
}

function assertHakoPhase(opening, playerId, phase) {
  if (playerId !== opening.hakoId) throw new Error('只有箱娃可以进行此项开局设置。');
  if (opening.phase !== phase) throw new Error('当前开局阶段不能执行此操作。');
}

function copyToken(token) {
  return token ? { ...token } : null;
}

export function createOpening(setup, { hakoId, itemChoices } = {}) {
  if (setup?.phase !== 'map_ready' || setup.placements?.length !== MAP_TILES.length
      || new Set(setup.placements.map(placement => placement.tileId)).size !== MAP_TILES.length
      || setup.placements.some(placement => !getTile(placement.tileId))) {
    throw new Error('请先按规则完成九块地图的配置。');
  }
  assertVisitors(setup.visitorIds);
  if (typeof hakoId !== 'string' || !hakoId.trim() || setup.visitorIds.includes(hakoId)) {
    throw new Error('箱娃必须是访问者以外的玩家。');
  }
  if (!Array.isArray(itemChoices) || itemChoices.length !== setup.visitorIds.length
      || new Set(itemChoices.map(choice => choice?.playerId)).size !== setup.visitorIds.length
      || new Set(itemChoices.map(choice => choice?.itemId)).size !== setup.visitorIds.length
      || Array.from(itemChoices).some(choice => !choice || !setup.visitorIds.includes(choice.playerId)
        || typeof choice.itemId !== 'string' || !choice.itemId.trim())) {
    throw new Error('所有访问者须先各选择一张不同的初始道具。');
  }
  const opening = {
    phase: 'secrets',
    hakoId,
    visitorIds: [...setup.visitorIds],
    placements: setup.placements.map(placement => ({ ...placement })),
    itemChoices: copyChoices(itemChoices),
    cornerTokens: {},
    password: null,
    weakness: null,
    remainsCornerId: null,
    inspectedRoomId: null,
    hidingCornerId: null,
    hidingUnderToken: null,
    initialPowerId: null,
    initialPowerCandidates: shuffled(INITIAL_POWER_IDS).slice(0, 3),
    initialPowerIgnoresNotebookRequirement: false,
    powerDeck: [],
    emptyBoxTokens: Array.from({ length: 24 }, (_, index) => ({ id: `empty_box_${index + 1}`, type: 'empty_box' })),
    safeBoard: { key: { id: 'key', type: 'key' } },
  };
  opening.cornerTokens = Object.fromEntries(getCorners(opening).map(corner => [corner.id, null]));
  opening.cornerTokens[SAFE_CORNER] = { id: 'safe', type: 'safe' };
  return opening;
}

export function chooseSecrets(opening, playerId, secrets) {
  assertHakoPhase(opening, playerId, 'secrets');
  if (!secrets || !Array.isArray(secrets.password) || secrets.password.length !== 3
      || new Set(secrets.password).size !== 3
      || Array.from(secrets.password).some(number => !Number.isInteger(number) || !PASSWORD_NUMBERS.includes(number))) {
    throw new Error('保险箱密码须从1至6中选择三个不同的整数，顺序不计。');
  }
  if (!TOOLS.some(tool => tool.id === secrets.weakness)) throw new Error('请选择一种有效的讨伐弱点。');
  const password = [...secrets.password].sort((a, b) => a - b);
  // Rulebook p4: all remaining eligible tokens are mixed; exactly one corner stays empty.
  const tokens = [
    ...Array.from({ length: 10 }, (_, index) => ({ id: `notebook_${index + 1}`, type: 'notebook', number: index + 1 })),
    ...TOOLS.map(tool => ({ id: `weapon_${tool.id}`, type: 'weapon', tool: tool.id })),
    ...PASSWORD_NUMBERS.filter(number => !password.includes(number)).map(number => ({ id: `password_${number}`, type: 'password', number })),
    ...TOOLS.filter(tool => tool.id !== secrets.weakness).map(tool => ({ id: `weakness_clue_${tool.id}`, type: 'weakness_clue', tool: tool.id })),
    { id: 'doll', type: 'doll' },
    { id: 'hidden_exit', type: 'hidden_exit' },
    { id: 'amulet', type: 'amulet' },
    { id: 'extinguisher', type: 'extinguisher' },
  ];
  const targets = getCorners(opening).filter(corner => corner.id !== SAFE_CORNER);
  const distribution = shuffled([...tokens, null]);
  if (tokens.length !== 22 || targets.length !== distribution.length) throw new Error('开局角落标志数量与地图不符。');
  const cornerTokens = { [SAFE_CORNER]: { id: 'safe', type: 'safe' } };
  targets.forEach((corner, index) => { cornerTokens[corner.id] = distribution[index]; });
  opening.password = password;
  opening.weakness = secrets.weakness;
  opening.cornerTokens = cornerTokens;
  opening.phase = 'remains';
  return getOpeningView(opening, playerId);
}

export function placeRemains(opening, playerId, cornerId) {
  assertHakoPhase(opening, playerId, 'remains');
  if (cornerId === SAFE_CORNER || !getCorners(opening).some(corner => corner.id === cornerId)) {
    throw new Error('亡骸须放在书房写字台以外的地图角落。');
  }
  const emptyCorners = Object.keys(opening.cornerTokens).filter(id => opening.cornerTokens[id] === null);
  if (emptyCorners.length !== 1) throw new Error('放置亡骸前应当恰好剩余一个空角落。');
  const previous = opening.cornerTokens[cornerId];
  const cornerTokens = { ...opening.cornerTokens };
  if (previous) cornerTokens[emptyCorners[0]] = previous;
  cornerTokens[cornerId] = { id: 'remains', type: 'remains' };
  opening.cornerTokens = cornerTokens;
  opening.remainsCornerId = cornerId;
  opening.phase = 'hiding_room';
  return getOpeningView(opening, playerId);
}

export function inspectInitialRoom(opening, playerId, roomId) {
  assertHakoPhase(opening, playerId, 'hiding_room');
  roomId = getLogicalRoomId(roomId);
  if (!HIDING_ROOM_IDS.includes(roomId) || !getRooms(opening).some(room => room.id === roomId)) {
    throw new Error('初始潜伏只能选择儿童房或书房／深色房间地图板。');
  }
  opening.inspectedRoomId = roomId;
  opening.phase = 'hiding_corner';
  return getOpeningView(opening, playerId);
}

export function chooseInitialHiding(opening, playerId, cornerId) {
  assertHakoPhase(opening, playerId, 'hiding_corner');
  const room = getRooms(opening).find(candidate => candidate.id === getLogicalRoomId(opening.inspectedRoomId));
  if (!room?.corners.some(corner => corner.id === cornerId)) throw new Error('初始潜伏须选择刚才查看的怨房内的角落。');
  opening.hidingUnderToken = copyToken(opening.cornerTokens[cornerId]);
  opening.cornerTokens[cornerId] = { id: 'hako', type: 'hako' };
  opening.hidingCornerId = cornerId;
  opening.phase = 'power';
  return getOpeningView(opening, playerId);
}

// Only the piece replaced by Hako is revealed during ordinary hiding. Legacy
// opening records also return that one piece, never the other room contents.
export function getInitialRoomMemory(opening) {
  if (!opening?.hidingCornerId || !opening.inspectedRoomId) return null;
  const room = getRooms(opening).find(candidate => candidate.id === getLogicalRoomId(opening.inspectedRoomId));
  if (!room?.corners.some(corner => corner.id === opening.hidingCornerId)) return null;
  return { id: room.id, cycle: 0, corners: [{ id: opening.hidingCornerId,
    token: copyToken(opening.hidingUnderToken),
  }] };
}

export function chooseInitialPower(opening, playerId, powerId) {
  assertHakoPhase(opening, playerId, 'power');
  if (!Number.isInteger(powerId) || !initialPowerCandidates(opening).includes(powerId)) {
    throw new Error('初始能力须从系统抽出的三张候选中选择。');
  }
  // Both unchosen candidates return to the numbered deck; silent mode removes NO.12.
  // Despair must be present for its confirmed draw-and-return-to-bottom rule to apply.
  const powerDeck = shuffled([...INITIAL_POWER_IDS
    .filter(id => id !== powerId), 'despair']);
  opening.initialPowerId = powerId;
  opening.initialPowerIgnoresNotebookRequirement = true;
  opening.powerDeck = powerDeck;
  opening.phase = 'opening_ready';
  return getOpeningView(opening, playerId);
}

/** Views whitelist public fields; neither the token pool nor the deck is serialized. */
export function getOpeningView(opening, playerId) {
  if (playerId !== opening.hakoId && !opening.visitorIds.includes(playerId)) {
    throw new Error('只有本局玩家可以查看开局准备。');
  }
  const corners = getCorners(opening);
  const view = {
    phase: opening.phase,
    hakoId: opening.hakoId,
    itemChoices: copyChoices(opening.itemChoices),
    corners: corners.map(corner => ({ ...corner, occupied: opening.cornerTokens[corner.id] !== null })),
  };
  if (playerId !== opening.hakoId) return view;
  if (opening.initialPowerId !== null) {
    view.initialPowerId = opening.initialPowerId;
    view.initialPowerName = POWER_NAMES[opening.initialPowerId];
  }
  if (opening.password) view.password = [...opening.password];
  if (opening.weakness) view.weakness = opening.weakness;
  if (opening.remainsCornerId) view.remainsCornerId = opening.remainsCornerId;
  if (opening.hidingCornerId) {
    view.hidingCornerId = opening.hidingCornerId;
    view.hidingUnderToken = copyToken(opening.hidingUnderToken);
  }
  if (opening.initialPowerId !== null) view.initialPowerIgnoresNotebookRequirement = true;
  if (opening.phase === 'secrets') {
    view.passwordOptions = [...PASSWORD_NUMBERS];
    view.weaknessOptions = TOOLS.map(tool => ({ ...tool }));
  } else if (opening.phase === 'remains') {
    view.remainsTargets = corners.filter(corner => corner.id !== SAFE_CORNER).map(corner => corner.id);
  } else if (opening.phase === 'hiding_room') {
    view.hidingRooms = getRooms(opening).filter(room => HIDING_ROOM_IDS.includes(room.id))
      .map(room => ({ id: room.id, name: room.name }));
  } else if (opening.phase === 'hiding_corner') {
    const room = getRooms(opening).find(candidate => candidate.id === getLogicalRoomId(opening.inspectedRoomId));
    view.inspectedRoom = { id: room.id, corners: room.corners.map(corner => ({ id: corner.id, name: corner.name })) };
    view.hidingTargets = room.corners.map(corner => corner.id);
  } else if (opening.phase === 'power') {
    view.lastInspectedRoom = getInitialRoomMemory(opening);
    view.initialPowerOptions = initialPowerCandidates(opening).map(id => powerCard(id));
  }
  return view;
}
