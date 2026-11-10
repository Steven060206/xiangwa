import { getConnections } from './game.mjs';
import { getTile, getLogicalRoomId, getLogicalRooms } from './maps.mjs';
import { getRoom, getCornerRoom, getMoveTargets, getHidingTargets } from './movement.mjs';
import { getStealOptions, stealPossession } from './theft.mjs';

const clone = value => structuredClone(value);
const CARDS = {
  1: ['就在你身旁', 5, 'stage', '本次潜伏可选择当前楼层任意房间。'],
  2: ['马上就到哟', 3, 'stage', '须先发动再移动；本次最多移动两块地图板，先选择途经房间，再选择最终潜伏角落。'],
  3: ['打不开的门', 0, 'stage', '封锁一扇实际相连的门至下一箱娃阶段；下一阶段不能再次发动。'],
  4: ['动来动去', 0, 'stage', '秘密查看一个房间，再重排未被潜伏者盖住的角落标志。'],
  5: ['我在你身后', 6, 'stage', '发动后在下一次箱娃阶段开始前杀死箱娃同房访问者；届时公开八枚手记时也杀死箱人同房访问者。'],
  6: ['好想打开它', 5, 'interrupt', '取消已声明的访问者行动，由该访问者自己选择同房角落强制窥探。'],
  7: ['快把它给我', 0, 'interrupt', '抢夺访问者的指定道具或随机一枚随身标志，旧赃物交给这次受害者。'],
  8: ['我的玛丽小姐', 0, 'interrupt', '人偶持有者从下次回合起须连翻两枚，不能转交或丢弃人偶；与铃合计三枚。'],
  9: ['虚假的回应', 0, 'passive', '设置后可在回答访问者道具的问题时说谎，无需翻开。'],
  10: ['鬼来电', 0, 'interrupt', '所有访问者只能沿最短路线向客厅移动，首人进入后全体解除；每局一次。'],
  11: ['虚假的哭喊', 0, 'cry', '开局固有能力，无需抽取。设置后哭喊可指向其他房间；本次开始行动时回手，本局不能再次设置。'],
  12: ['天旋地转', 0, 'excluded', '无声模式明确移出游戏。'],
};
const DISABLED = new Set([12]);
const DANGER = { 1: 'A', 2: 'A', 3: 'B', 4: 'C', 5: 'A', 6: 'A', 7: 'B', 8: 'B', 9: 'C', 10: 'C' };
const ACTIONS = new Set(['hako_cry', 'set_power', 'recall_power', 'begin_hako_action',
  'activate_power', 'power_rearrange', 'inspect_path_room']);

export function powerCard(cardOrId) {
  const card = typeof cardOrId === 'object' && cardOrId !== null ? cardOrId : { id: cardOrId };
  const entry = CARDS[card.id];
  if (!entry) throw new Error('未知的箱娃之力。');
  const [name, threshold, timing, description] = entry;
  return { id: Number(card.id), name, threshold, timing, description, danger: DANGER[card.id] ?? null,
    supported: !DISABLED.has(Number(card.id)),
    ...('ignoreThreshold' in card ? { ignoreThreshold: card.ignoreThreshold === true } : {}),
    ...(DISABLED.has(Number(card.id)) ? { reason: description } : {}) };
}

function normalizePowers(powers) {
  // Old saves dealt NO.11 through the deck. Migrate it into the hand while retaining
  // a card already set in a slot and its once-per-game use restriction.
  let foundEleven = false;
  powers.slots = powers.slots.map(card => {
    if (card?.id !== 11) return card;
    if (foundEleven) return null;
    foundEleven = true;
    return card;
  });
  powers.hand = powers.hand.filter(card => {
    if (card.id !== 11) return true;
    if (foundEleven) return false;
    foundEleven = true;
    return true;
  });
  if (!foundEleven) powers.hand.push({ id: 11, ignoreThreshold: false });
  powers.deck = powers.deck.filter(id => id !== 11 && id !== 12);
  // Previous saves did not record historical cries. Recover only the one cry
  // evidenced by the saved stage, never substitute total rounds for cry count.
  if (!Number.isSafeInteger(powers.cryCount) || powers.cryCount < 0) {
    powers.cryCount = powers.cryUsed || powers.announcement ? 1 : 0;
  }
  return powers;
}

export function createPowers(opening) {
  if (!opening || !CARDS[opening.initialPowerId] || opening.initialPowerId === 12) {
    throw new Error('请先确定本局初始箱娃之力。');
  }
  return normalizePowers({
    hand: [{ id: opening.initialPowerId, ignoreThreshold: true }],
    deck: [...opening.powerDeck].filter(id => id !== 12), slots: [null, null],
    removed: [12], used: [], cooldowns: {}, stageCycle: null,
    cryUsed: false, cryCount: 0, manageUsed: false, step: 'preparation', announcement: null,
    lastDraw: null, lastActivation: null, activationNotice: null, movement: {}, rearrangement: null, falseCryPending: false,
    ghostCall: { active: false, mode: 'first_arrival' }, stolen: null, pendingBehindYou: null,
  });
}

function roomOf(cornerId) {
  return getCornerRoom(cornerId)?.id;
}
function rooms(play) {
  const tileIds = new Set(play.round.placements.map(placement => placement.tileId));
  return getLogicalRooms().filter(room => tileIds.has(room.tileId));
}
function roomCorners(play, roomId, ctx = {}) {
  roomId = getLogicalRoomId(roomId);
  const base = ctx.corners ? ctx.corners(roomId).map(corner => typeof corner === 'string' ? corner : corner.id)
    : getRoom(roomId)?.corners.map(corner => corner.id) ?? [];
  return [...new Set([...base, ...Object.values(play.extraCorners ?? {}).filter(corner => getLogicalRoomId(corner.roomId) === roomId).map(corner => corner.id)])];
}
function allCornerIds(play) { return Object.keys(play.tokens); }
function atRoom(ctx, cornerId) { return getLogicalRoomId(ctx.roomOf ? ctx.roomOf(cornerId) : roomOf(cornerId)); }
function phase(play) { return play.round.silent.phase; }
function cycle(play) { return play.round.silent.cycle; }
export function recordPowerActivation(play, powerId) {
  const powers = play.powers;
  powers.lastActivation = { powerId, name: powerCard(powerId).name, cycle: cycle(play) };
  if (powerId >= 5 && powerId <= 10) {
    powers.activationNotice = { serial: (powers.activationNotice?.serial ?? 0) + 1, cycle: cycle(play) };
  }
}
function assertHako(play, id) {
  if (id !== play.round.hakoId) throw new Error('只有箱娃玩家可以管理或发动箱娃之力。');
}
function assertPreparation(play) {
  if (phase(play) !== 'hako_phase' || play.powers.step !== 'preparation') throw new Error('请在箱娃阶段开始行动前进行此操作。');
}
function assertStageAction(play) {
  if (phase(play) !== 'hako_phase' || play.powers.step !== 'action') throw new Error('请先开始本次箱娃行动。');
  if (play.hakoStage?.done.includes(play.round.hakoId) || play.hakoStage?.inspections[play.round.hakoId]) {
    throw new Error('箱娃已经开始潜伏，不能再发动阶段能力或查看其他路径。');
  }
  if (play.powers.rearrangement) throw new Error('请先完成房间标志重排。');
}
function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 1) throw new Error('请选择左侧或右侧能力栏。');
}
function releaseSlot(play, slot) {
  const card = play.powers.slots[slot];
  if (card) play.powers.hand.push({ id: card.id, ignoreThreshold: card.ignoreThreshold === true });
  play.powers.slots[slot] = null;
}
export function normalizeLegacyPowerRearrangement(play) {
  const pending = play.powers.rearrangement;
  if (!pending || !Object.hasOwn(pending, 'slot')) return;
  if (play.powers.slots[pending.slot]?.id === 4) releaseSlot(play, pending.slot);
  delete pending.slot;
}
function recordUsed(play, id) {
  if (!play.powers.used.includes(id)) play.powers.used.push(id);
}
function hasThreshold(play, card) {
  return card.ignoreThreshold || play.notebooks.length >= powerCard(card).threshold;
}
export function hasActivePower(play, powerId) {
  return !!play.powers?.slots.some(card => card?.id === powerId);
}

export function startPowerStage(play, ctx) {
  const powers = play.powers;
  if (!powers || powers.stageCycle === cycle(play)) return;
  normalizePowers(powers);
  powers.stageCycle = cycle(play);
  powers.cryUsed = false;
  powers.manageUsed = false;
  powers.step = 'preparation';
  powers.lastDraw = null;
  powers.announcement = null;
  powers.movement = {};
  powers.rearrangement = null;
  powers.falseCryPending = false;
  play.round.blockedDoors = [];
  if (powers.pendingBehindYou && powers.pendingBehindYou.cycle <= cycle(play)) {
    const killers = [{ playerId: play.round.hakoId, cornerId: play.round.hidingCornerId }];
    if (play.notebooks.length >= 8) killers.push(...play.ghosts.filter(ghost => !ghost.banished));
    const deaths = play.round.visitors.filter(player => player.status === 'alive').flatMap(player => {
      const killer = killers.find(actor => atRoom(ctx, actor.cornerId) === getLogicalRoomId(player.roomId));
      return killer ? [{ playerId: player.id, killerCornerId: killer.cornerId }] : [];
    });
    powers.pendingBehindYou = null;
    // An already activated effect settles before this stage's actions, even
    // when the current visitor uses an extinguisher to skip those actions.
    ctx.processDeaths(deaths);
  }
}

function cry(play, action, ctx) {
  assertPreparation(play);
  const powers = play.powers;
  if (powers.cryUsed || powers.manageUsed) throw new Error('每阶段只能在设置或回收前哭喊一次。');
  const actualRoomId = atRoom(ctx, play.round.hidingCornerId);
  const announcedRoomId = getLogicalRoomId(action.roomId ?? actualRoomId);
  if (!rooms(play).some(room => room.id === announcedRoomId)) throw new Error('请选择本局地图内的房间。');
  if (announcedRoomId !== actualRoomId && !hasActivePower(play, 11)) throw new Error('只有设置虚假的哭喊时才能指向其他房间。');
  powers.cryUsed = true;
  powers.cryCount++;
  powers.announcement = { roomId: announcedRoomId, cycle: cycle(play) };
  if (announcedRoomId !== actualRoomId) {
    powers.falseCryPending = true;
    recordUsed(play, 11);
  }
  const guaranteed = powers.cryCount === 10 ? powers.deck.indexOf('despair') : -1;
  const drawn = guaranteed >= 0 ? powers.deck.splice(guaranteed, 1)[0] : powers.deck.shift();
  if (drawn === undefined) { powers.lastDraw = { kind: 'empty_deck', cards: [] }; return; }
  if (drawn === 'despair') {
    powers.deck.push(drawn);
    const gained = [];
    // The liberation card remains in the deck and cannot recursively draw itself.
    for (let count = 0; count < 2; count++) {
      const next = powers.deck.findIndex(id => id !== 'despair');
      if (next < 0) break;
      const id = powers.deck.splice(next, 1)[0];
      powers.hand.push({ id, ignoreThreshold: true });
      gained.push(id);
    }
    powers.lastDraw = { kind: 'despair', cards: gained };
  } else if (play.notebooks.some(note => note.number === drawn)) {
    powers.hand.push({ id: drawn, ignoreThreshold: false });
    powers.lastDraw = { kind: 'acquired', cards: [drawn] };
  } else {
    powers.deck.push(drawn);
    powers.lastDraw = { kind: 'returned', cards: [drawn] };
  }
}

function setPower(play, action) {
  assertPreparation(play);
  const powers = play.powers;
  if (powers.manageUsed) throw new Error('本阶段已经设置或回收过一张能力。');
  assertSlot(action.slot);
  if (powers.slots[action.slot]) throw new Error('该能力栏已有卡牌，请选择空栏。');
  const index = powers.hand.findIndex(card => card.id === action.powerId);
  if (index < 0) throw new Error('请选择自己手中的箱娃之力。');
  const card = powers.hand[index];
  if (!powerCard(card).supported) throw new Error(powerCard(card).reason);
  const reason = bellSetError(play, card);
  if (reason) throw new Error(reason);
  if (card.id === 11 && powers.used.includes(11)) throw new Error('虚假的哭喊已经使用，本局不能再次设置。');
  powers.slots[action.slot] = { ...powers.hand.splice(index, 1)[0], faceUp: false };
  powers.manageUsed = true;
}
function bellSetError(play, card) {
  return play.noiseEffects?.bell?.cycle === cycle(play) && ['B', 'C'].includes(DANGER[card.id])
    ? '深菱神社之铃生效中，本次箱娃阶段不能设置危险度B或C的能力。' : null;
}
function recallPower(play, action) {
  assertPreparation(play);
  const powers = play.powers;
  if (powers.manageUsed) throw new Error('本阶段只能设置或回收一次。');
  assertSlot(action.slot);
  if (!powers.slots[action.slot]) throw new Error('该栏没有可回收的能力。');
  if (powers.slots[action.slot].id === 10 && powers.ghostCall.active) throw new Error('鬼来电生效期间必须留在能力栏。');
  releaseSlot(play, action.slot);
  powers.manageUsed = true;
}
function beginAction(play) {
  assertPreparation(play);
  if (play.powers.falseCryPending) {
    const slot = play.powers.slots.findIndex(card => card?.id === 11);
    if (slot >= 0) releaseSlot(play, slot);
    play.powers.falseCryPending = false;
  }
  play.powers.step = 'action';
}

function interruptPlayer(play) {
  const pending = play.round.pendingAction;
  if (!pending || pending.playerId === play.round.hakoId
      || !play.round.visitors.some(player => player.id === pending.playerId && player.status === 'alive')) {
    throw new Error('请等待访问者声明行动后、实际结算前发动。');
  }
  return pending.playerId;
}
function actualDoors(play) {
  return getConnections(play.round.placements).filter(edge => edge.kind === 'door').map(edge => ({
    fromRoomId: edge.from, toRoomId: edge.to,
    name: `${getRoom(edge.from).name} — ${getRoom(edge.to).name}`,
  }));
}
function activationError(play, card) {
  const details = powerCard(card);
  if (!details.supported) return details.reason;
  if (!hasThreshold(play, card)) return `需要公开至少${details.threshold}枚手记。`;
  if (details.timing === 'passive') return '此能力设置后持续生效，无需主动发动。';
  if (details.timing === 'cry') return '此能力在哭喊时使用。';
  if (details.timing === 'stage' && (phase(play) !== 'hako_phase' || play.powers.step !== 'action')) return '请先进入箱娃行动步骤。';
  if (details.timing === 'stage' && (play.hakoStage?.done.includes(play.round.hakoId)
      || play.hakoStage?.inspections[play.round.hakoId])) return '箱娃已经开始本次潜伏。';
  if (details.timing === 'interrupt' && !play.round.pendingAction) return '请等待访问者声明行动。';
  if (play.round.pendingAction?.type === 'free' && ![7, 8].includes(card.id)) return '此窗口用于抢夺或玛丽小姐的自由行动打断。';
  if (play.round.pendingAction?.type === 'item' && play.round.pendingAction.itemId === 'amulet'
      && details.timing === 'interrupt') return '箱娃之力不能打断古怪护符。';
  if (card.id === 7 && play.round.pendingAction) {
    const options = getStealOptions(play, play.round.pendingAction.playerId);
    if (!options.items.length && !options.canStealToken) return '该访问者没有可抢夺的物品。';
  }
  if (card.id === 8 && play.noiseEffects?.mary) return '我的玛丽小姐已经生效。';
  if (card.id === 6 && play.round.pendingAction) {
    const player = play.round.visitors.find(candidate => candidate.id === play.round.pendingAction.playerId);
    const available = player && roomCorners(play, player.roomId).some(cornerId => play.tokens[cornerId]
      || play.round.hidingCornerId === cornerId || play.ghosts.some(ghost => !ghost.banished && ghost.cornerId === cornerId));
    if (!available) return '该访问者所在房间没有可窥探角落。';
  }
  if (card.id === 3 && (play.powers.cooldowns[3] ?? -1) >= cycle(play)) return '上次使用后的下一箱娃阶段不能再次发动。';
  if (card.id === 10 && play.powers.used.includes(10)) return '鬼来电每局只能使用一次。';
  if (play.powers.rearrangement) return '请先完成正在处理的房间重排。';
  return null;
}

function activate(play, action, ctx) {
  assertSlot(action.slot);
  const card = play.powers.slots[action.slot];
  if (!card) throw new Error('该栏没有可发动的能力。');
  const error = activationError(play, card);
  if (error) throw new Error(error);
  if (powerCard(card).timing === 'stage') assertStageAction(play);
  const interruptedId = powerCard(card).timing === 'interrupt' ? interruptPlayer(play) : null;
  recordPowerActivation(play, card.id);
  if (card.id === 1 || card.id === 2) {
    play.powers.movement[card.id === 1 ? 'sameFloor' : 'twoRooms'] = true;
  } else if (card.id === 3) {
    const fromRoomId = getLogicalRoomId(action.fromRoomId);
    const toRoomId = getLogicalRoomId(action.toRoomId);
    const door = actualDoors(play).find(candidate => (
      candidate.fromRoomId === fromRoomId && candidate.toRoomId === toRoomId
    ) || (candidate.fromRoomId === toRoomId && candidate.toRoomId === fromRoomId));
    if (!door) throw new Error('只能封锁实际相连的门，不能封锁楼梯或墙壁。');
    play.round.blockedDoors.push({ from: door.fromRoomId, to: door.toRoomId });
    play.powers.cooldowns[3] = cycle(play) + 1;
  } else if (card.id === 4) {
    const roomId = getLogicalRoomId(action.roomId);
    if (!rooms(play).some(room => room.id === roomId)) throw new Error('请选择本局地图内的房间。');
    const cornerIds = roomCorners(play, roomId, ctx).filter(cornerId => !ctx.actorsAt(cornerId).length);
    play.powers.rearrangement = { roomId, cornerIds };
    releaseSlot(play, action.slot);
    return;
  } else if (card.id === 5) {
    play.powers.pendingBehindYou = { cycle: cycle(play) + 1 };
    releaseSlot(play, action.slot);
    return;
  } else if (card.id === 6) {
    releaseSlot(play, action.slot);
    ctx.forcePeek(interruptedId);
    return;
  } else if (card.id === 7) {
    stealPossession(play, interruptedId, action);
  } else if (card.id === 8) {
    const holder = play.round.visitors.find(player => player.status === 'alive'
      && play.inventories[player.id].tokens.some(token => token.type === 'doll'));
    if (holder) {
      play.noiseEffects ??= {};
      play.noiseEffects.mary = { playerId: holder.id,
        deferredCycle: cycle(play), deferredTurn: play.round.silent.turnSerial ?? 0,
        card: { id: card.id, ignoreThreshold: card.ignoreThreshold === true } };
      play.powers.slots[action.slot] = null;
      return;
    }
  } else if (card.id === 10) {
    recordUsed(play, 10);
    card.faceUp = true;
    play.round.pendingAction = null;
    play.powers.ghostCall = { active: true, mode: 'first_arrival' };
    if (play.round.visitors.some(player => player.status === 'alive' && player.roomId === 'living_room')) {
      play.powers.ghostCall.active = false;
      releaseSlot(play, action.slot);
    }
    return;
  }
  releaseSlot(play, action.slot);
}

function rearrange(play, action, ctx) {
  assertStageActionForRearrangement(play);
  const pending = play.powers.rearrangement;
  const eligible = roomCorners(play, pending.roomId, ctx).filter(cornerId => !ctx.actorsAt(cornerId).length);
  const order = action.order;
  if (!Array.isArray(order) || order.length !== eligible.length || new Set(order).size !== order.length
      || order.some(id => !eligible.includes(id)) || pending.cornerIds.some(id => !eligible.includes(id))) {
    throw new Error('请完整排列该房间中未被潜伏者盖住的角落，不得移动暂存原物。');
  }
  const faceDown = action.faceDownCornerIds ?? [];
  if (!Array.isArray(faceDown) || new Set(faceDown).size !== faceDown.length
      || faceDown.some(id => !eligible.includes(id))) throw new Error('只能盖放本次重排房间的标志。');
  const pieces = order.map(id => play.tokens[id]);
  pending.cornerIds.forEach((id, index) => { play.tokens[id] = pieces[index]; });
  faceDown.forEach(id => { if (play.tokens[id]) play.tokens[id].faceUp = false; });
  play.powers.rearrangement = null;
}
function assertStageActionForRearrangement(play) {
  if (phase(play) !== 'hako_phase' || play.powers.step !== 'action' || !play.powers.rearrangement) {
    throw new Error('请先发动动来动去并查看一个房间。');
  }
}
function inspectPath(play, action, ctx) {
  assertStageAction(play);
  if (!play.powers.movement.twoRooms) throw new Error('请先发动马上就到哟。');
  if (play.powers.movement.pathRoomId) throw new Error('本次途经房间已经选择，不能反复选择其他路径。');
  const origin = atRoom(ctx, play.round.hidingCornerId);
  const roomId = getLogicalRoomId(action.roomId);
  if (!getMoveTargets(play.round.placements, origin, { actor: 'hako' }).includes(roomId)) {
    throw new Error('只能选择从当前位置经过的相邻房间。');
  }
  play.powers.movement.pathRoomId = roomId;
}

export function applyPowerAction(play, id, action, ctx) {
  if (!ACTIONS.has(action?.type)) return false;
  assertHako(play, id);
  if (!play.powers) throw new Error('箱娃之力尚未初始化。');
  normalizePowers(play.powers);
  switch (action.type) {
    case 'hako_cry': cry(play, action, ctx); break;
    case 'set_power': setPower(play, action); break;
    case 'recall_power': recallPower(play, action); break;
    case 'begin_hako_action': beginAction(play); break;
    case 'activate_power': activate(play, action, ctx); break;
    case 'power_rearrange': rearrange(play, action, ctx); break;
    case 'inspect_path_room': inspectPath(play, action, ctx); break;
  }
  return true;
}

function roomFloor(play, roomId) {
  roomId = getLogicalRoomId(roomId);
  return play.round.placements.find(placement => getTile(placement.tileId).rooms.some(room => room.id === roomId))?.floor;
}
export function powerHidingTargets(play, cornerId, actorId = play.round.hakoId) {
  const origin = roomOf(cornerId);
  const anchor = getRoom(origin)?.corners[0]?.id;
  if (!anchor) throw new Error('潜伏起点不在本局房间中。');
  const standardRooms = new Set(getHidingTargets(play.round.placements, anchor).map(roomOf));
  const targetRooms = new Set(standardRooms);
  const movement = actorId === play.round.hakoId ? play.powers?.movement ?? {} : {};
  if (movement.twoRooms && movement.pathRoomId) {
    const pathRoomId = getLogicalRoomId(movement.pathRoomId);
    targetRooms.clear();
    targetRooms.add(origin);
    targetRooms.add(pathRoomId);
    for (const id of getMoveTargets(play.round.placements, pathRoomId, { actor: 'hako' })) targetRooms.add(id);
  }
  if (movement.sameFloor) {
    const floor = roomFloor(play, origin);
    for (const room of rooms(play)) if (roomFloor(play, room.id) === floor) targetRooms.add(room.id);
  }
  return allCornerIds(play).filter(id => targetRooms.has(roomOf(id))).sort();
}

export function isPowerMoveForced(play, visitorId) {
  return play.powers?.ghostCall.active === true
    && play.round.visitors.some(player => player.id === visitorId && player.status === 'alive');
}
export function restrictPowerMoves(play, visitorId, targets) {
  if (!isPowerMoveForced(play, visitorId)) return [...targets];
  const distances = new Map([['living_room', 0]]), queue = ['living_room'];
  for (let index = 0; index < queue.length; index++) {
    for (const next of getMoveTargets(play.round.placements, queue[index], { blockedDoors: play.round.blockedDoors })) {
      if (!distances.has(next)) { distances.set(next, distances.get(queue[index]) + 1); queue.push(next); }
    }
  }
  const roomId = getLogicalRoomId(play.round.visitors.find(player => player.id === visitorId)?.roomId);
  const current = distances.get(roomId);
  if (current === undefined) return [];
  return targets.filter(target => distances.has(target) && distances.get(target) === current - 1);
}
export function afterPowerMove(play, visitorId) {
  if (!isPowerMoveForced(play, visitorId)) return;
  if (play.round.visitors.find(player => player.id === visitorId)?.roomId !== 'living_room') return;
  play.powers.ghostCall.active = false;
  const slot = play.powers.slots.findIndex(card => card?.id === 10);
  if (slot >= 0) releaseSlot(play, slot);
}

function viewCorner(play, id) {
  const actors = [
    ...(play.round.hidingCornerId === id ? [{ playerId: play.round.hakoId, type: 'hako' }] : []),
    ...play.ghosts.filter(ghost => !ghost.banished && ghost.cornerId === id)
      .map(ghost => ({ playerId: ghost.playerId, type: 'box_person' })),
  ];
  return { id, token: actors.length ? null : clone(play.tokens[id]), actors };
}
export function getPowersView(play, id) {
  if (!play.powers) return null;
  const powers = normalizePowers(clone(play.powers));
  play = { ...play, powers };
  normalizeLegacyPowerRearrangement(play);
  const hako = id === play.round.hakoId;
  const preparation = hako && phase(play) === 'hako_phase' && powers.step === 'preparation' && !play.result && !play.resolution;
  const canManage = preparation && !powers.manageUsed;
  const view = {
    slots: powers.slots.map((card, slot) => {
      const faceUp = hako && card?.faceUp === true;
      return { slot, occupied: !!card,
        ...(card ? { faceUp, ...(hako ? { card: powerCard(card) } : {}) } : {}),
        ...(hako ? { canRecall: !!card && canManage && !(card.id === 10 && powers.ghostCall.active) } : {}) };
    }),
    handCount: powers.hand.length, deckCount: powers.deck.length,
    announcement: powers.announcement ? { ...clone(powers.announcement), roomId: getLogicalRoomId(powers.announcement.roomId) } : null, step: powers.step,
    lastActivation: hako ? clone(powers.lastActivation) : null,
    activationNotice: powers.activationNotice ? { serial: powers.activationNotice.serial, cycle: powers.activationNotice.cycle } : null,
    canCry: preparation && !powers.cryUsed && !powers.manageUsed,
    cryCount: powers.cryCount,
    pendingBehindYou: hako ? clone(powers.pendingBehindYou ?? null) : null,
    canManage, canBegin: preparation,
    ghostCall: { active: powers.ghostCall.active, mode: 'first_arrival' },
  };
  if (!hako) return view;
  view.stolen = clone(powers.stolen ?? null);
  view.hand = powers.hand.map(card => ({ ...powerCard(card),
    settable: canManage && powerCard(card).supported && !(card.id === 11 && powers.used.includes(11)) && !bellSetError(play, card),
    ...(bellSetError(play, card) ? { setReason: bellSetError(play, card) } : {}) }));
  view.lastDraw = clone(powers.lastDraw);
  view.cryRooms = hasActivePower(play, 11) ? rooms(play).map(room => ({ id: room.id, name: room.name })) : [];
  view.activationOptions = powers.slots.flatMap((card, slot) => {
    if (!card) return [];
    const error = activationError(play, card);
    return [{ slot, card: powerCard(card), canActivate: !error && !play.result && !play.resolution,
      ...(error ? { reason: error } : {}),
      ...(card.id === 3 ? { doors: actualDoors(play) } : {}),
      ...(card.id === 4 ? { rooms: rooms(play).map(room => ({ id: room.id, name: room.name })) } : {}),
      ...(card.id === 7 && play.round.pendingAction ? { stealOptions: getStealOptions(play, play.round.pendingAction.playerId) } : {}),
    }];
  });
  if (powers.rearrangement) view.rearrangement = { roomId: powers.rearrangement.roomId,
    corners: powers.rearrangement.cornerIds.map(cornerId => viewCorner(play, cornerId)) };
  view.pathRooms = powers.movement.twoRooms && !powers.movement.pathRoomId
    && phase(play) === 'hako_phase' && powers.step === 'action'
    && !play.hakoStage?.inspections[play.round.hakoId] && !play.hakoStage?.done.includes(play.round.hakoId)
    ? getMoveTargets(play.round.placements, roomOf(play.round.hidingCornerId), { actor: 'hako' }).map(roomId => ({ id: roomId, name: getRoom(roomId).name })) : [];
  if (powers.movement.pathRoomId) view.pathInspection = { roomId: getLogicalRoomId(powers.movement.pathRoomId) };
  return view;
}
