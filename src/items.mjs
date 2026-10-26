import { getTile } from './maps.mjs';
import { getNoiseEffectsView } from './noise-effects.mjs';
import { INITIAL_ITEMS } from './preparation.mjs';

const ITEM_NAMES = {
  spirit_pen: '笔仙', ventriloquist_doll: '腹语人偶', nightmare_letter: '噩梦的来信',
  smartphone: '智能手机', suitcase: '行李箱', dowsing_rod: '占卜棒', amulet: '古怪护符',
  shrine_bell: '深菱神社之铃',
};
const ACTIVE_ITEMS = new Set(Object.keys(ITEM_NAMES).filter(id => id !== 'amulet'));
const SAME_ROOM_LETHAL = new Set(['spirit_pen', 'ventriloquist_doll', 'nightmare_letter', 'smartphone', 'dowsing_rod']);
const clone = value => structuredClone(value);

function rooms(play) {
  return play.round.placements.flatMap(placement => getTile(placement.tileId).rooms);
}
function floorOf(play, roomId) {
  return play.round.placements.find(placement => getTile(placement.tileId).rooms.some(room => room.id === roomId))?.floor;
}
function floorName(floor) { return floor === -1 ? '地下室' : `${floor}楼`; }
function assertRoom(play, roomId) {
  if (!rooms(play).some(room => room.id === roomId)) throw new Error('请选择本局地图中的房间。');
}
function assertPhoneTarget(play, action) {
  if (!['hand', 'slot'].includes(action.targetZone) || !Number.isInteger(action.index) || action.index < 0) {
    throw new Error('请选择一张箱娃手牌或一个已设置的可用能力栏。');
  }
  const cards = action.targetZone === 'hand' ? play.powers.hand : play.powers.slots;
  if (!cards[action.index]) throw new Error('所选位置没有可供查看的箱娃之力。');
}
function assertAmulet(play, id, action, ctx) {
  if (!ctx.inventory(id).tokens.some(token => token.id === action.tokenId && token.type === 'amulet')) {
    throw new Error('请选择自己持有的古怪护符标志。');
  }
  if (!Number.isInteger(action.index) || action.index < 0 || !play.powers.slots[action.index]) {
    throw new Error('请选择一张已经设置在可用能力栏中的箱娃之力。');
  }
}
function assertItem(play, id, action, ctx) {
  ctx.assertTurn(id);
  if (action.itemId === 'amulet') { assertAmulet(play, id, action, ctx); return; }
  if (!ACTIVE_ITEMS.has(action.itemId)) throw new Error('该道具的主动使用尚未开放。');
  if (!ctx.hasItem(id, action.itemId)) throw new Error('你没有携带所选择的访问者道具。');
  switch (action.itemId) {
    case 'shrine_bell':
      if (!getNoiseEffectsView(play, id).canUseBell) throw new Error('本回合须先选择摇铃并完成额外翻牌，才能消耗行动使用铃。');
      break;
    case 'spirit_pen': {
      assertRoom(play, action.roomId);
      const roomId = ctx.visitor(id).roomId;
      if (!play.round.visitors.some(player => player.id !== id && player.status === 'alive' && player.roomId === roomId)) {
        throw new Error('使用笔仙时，同一房间内须有其他存活访问者。');
      }
      break;
    }
    case 'ventriloquist_doll': assertRoom(play, action.roomId); break;
    case 'smartphone': assertPhoneTarget(play, action); break;
    case 'nightmare_letter':
      if (!play.powers.deck.includes('despair')) throw new Error('箱娃之力牌库中没有绝望时刻。');
      break;
    case 'suitcase': {
      const cornerId = `suitcase:${ctx.visitor(id).roomId}`;
      if (play.extraCorners[cornerId]) throw new Error('当前房间已经设置了行李箱位置。');
      if (!play.opening.emptyBoxTokens.length) throw new Error('备用空箱已用尽，无法放置行李箱。');
      break;
    }
  }
}

/** Standard items share the existing declaration/confirmation interruption window. */
export function declareItem(play, id, action, ctx) {
  assertItem(play, id, action, ctx);
  const pending = { type: 'item', playerId: id, itemId: action.itemId };
  if (['spirit_pen', 'ventriloquist_doll'].includes(action.itemId)) pending.roomId = action.roomId;
  if (action.itemId === 'smartphone') { pending.targetZone = action.targetZone; pending.index = action.index; }
  if (action.itemId === 'amulet') { pending.tokenId = action.tokenId; pending.index = action.index; }
  play.round.pendingAction = pending;
}

function finish(play, id, ctx) {
  play.resolution = null;
  ctx.finishAction(id);
}
function publicEvent(play, pending, extra = {}) {
  play.itemEvents.push({ kind: 'item_used', itemId: pending.itemId, userId: pending.playerId, ...extra });
}
function revealRoomNotebooks(play, roomId, ctx) {
  const revealed = [];
  for (const corner of ctx.corners(roomId)) {
    // The base under an actor models the piece temporarily stored in its direction
    // area. It is unavailable on the map until that actor leaves the corner.
    if (ctx.actorsAt(corner.id).length) continue;
    const token = play.tokens[corner.id];
    if (token?.type !== 'notebook') continue;
    play.notebooks.push(clone(token));
    revealed.push(ctx.tokenView(token));
    play.tokens[corner.id] = play.opening.emptyBoxTokens.length
      ? { ...play.opening.emptyBoxTokens.shift(), faceUp: false } : null;
  }
  return revealed;
}

/** The parent applies this on its transaction clone after the hako confirms. */
export function resolveItem(play, pending, ctx) {
  assertItem(play, pending.playerId, pending, ctx);
  const id = pending.playerId;
  play.itemResults[id] = null;
  const roomId = ctx.visitor(id).roomId;
  // The phone explicitly suppresses its effect on death. The other lethal active
  // cards do not state timing; this implementation resolves that death first too.
  if (SAME_ROOM_LETHAL.has(pending.itemId) && ctx.roomOf(play.round.hidingCornerId) === roomId) {
    ctx.die(id, play.round.hidingCornerId);
    return;
  }
  switch (pending.itemId) {
    case 'shrine_bell':
      play.noiseEffects.bell = { userId: id, cycle: play.round.silent.cycle };
      play.noiseEffects.bellReady = null;
      publicEvent(play, pending);
      finish(play, id, ctx);
      break;
    case 'amulet': {
      const held = ctx.inventory(id);
      const tokenIndex = held.tokens.findIndex(token => token.id === pending.tokenId);
      play.removedTokens.push(held.tokens.splice(tokenIndex, 1)[0]);
      if (play.powers.slots[pending.index].id === 10) play.powers.ghostCall.active = false;
      play.powers.removed.push(play.powers.slots[pending.index]);
      play.powers.slots[pending.index] = null;
      publicEvent(play, pending, { index: pending.index });
      finish(play, id, ctx);
      break;
    }
    case 'nightmare_letter': {
      const index = play.powers.deck.indexOf('despair');
      play.powers.deck.splice(index, 1);
      play.powers.deck.push('despair');
      publicEvent(play, pending);
      finish(play, id, ctx);
      break;
    }
    case 'suitcase': {
      const cornerId = `suitcase:${roomId}`;
      const held = ctx.inventory(id);
      const itemIndex = held.items.findIndex(item => item.id === 'suitcase');
      const item = held.items.splice(itemIndex, 1)[0];
      play.extraCorners[cornerId] = { id: cornerId, roomId, name: '行李箱中' };
      play.tokens[cornerId] = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
      play.placedItems.push({ ...item, playerId: id, roomId, cornerId });
      publicEvent(play, pending, { roomId, cornerId });
      finish(play, id, ctx);
      break;
    }
    case 'smartphone': {
      const cards = pending.targetZone === 'hand' ? play.powers.hand : play.powers.slots;
      play.itemResults[id] = { kind: 'phone', itemId: pending.itemId, targetZone: pending.targetZone,
        index: pending.index, card: ctx.powerCard(cards[pending.index]) };
      publicEvent(play, pending);
      finish(play, id, ctx);
      break;
    }
    case 'spirit_pen':
      play.resolution = { kind: 'item_answer', playerId: play.round.hakoId, userId: id,
        itemId: pending.itemId, roomId: pending.roomId, truth: ctx.roomOf(play.round.hidingCornerId) === pending.roomId };
      break;
    case 'dowsing_rod':
      play.resolution = { kind: 'item_answer', playerId: play.round.hakoId, userId: id,
        itemId: pending.itemId, truth: floorOf(play, ctx.roomOf(play.round.hidingCornerId)) };
      break;
    case 'ventriloquist_doll': {
      const corners = ctx.corners(pending.roomId);
      const truth = corners.some(corner => !ctx.actorsAt(corner.id).length && play.tokens[corner.id]?.type === 'doll');
      const notebooks = revealRoomNotebooks(play, pending.roomId, ctx);
      play.resolution = { kind: 'item_answer', playerId: play.round.hakoId, userId: id,
        itemId: pending.itemId, roomId: pending.roomId, truth, notebooks };
      break;
    }
  }
}

function answers(play, resolution, ctx) {
  if (resolution.itemId === 'dowsing_rod') {
    const floors = [...new Set(play.round.placements.map(placement => placement.floor))].sort((a, b) => a - b);
    return (ctx.canLie() ? floors : floors.filter(floor => floor === resolution.truth))
      .map(floor => ({ id: JSON.stringify(floor), name: floorName(floor) }));
  }
  return (ctx.canLie() ? [true, false] : [resolution.truth]).map(answer => ({
    id: JSON.stringify(answer), name: resolution.itemId === 'ventriloquist_doll'
      ? answer ? '大喊：我是玛丽小姐' : '不叫喊' : answer ? '是' : '否',
  }));
}

/** Only hako answers. A lie can change the spoken reply, never the real notebooks. */
export function answerItem(play, id, action, ctx) {
  const resolution = play.resolution;
  if (id !== play.round.hakoId || resolution?.kind !== 'item_answer' || resolution.playerId !== id) {
    throw new Error('只有箱娃可以回答当前的道具询问。');
  }
  ctx.assertTurn(resolution.userId);
  const options = answers(play, resolution, ctx);
  if (!options.some(option => option.id === JSON.stringify(action.answer))) {
    throw new Error(ctx.canLie() ? '请选择合法的道具回答。' : '虚假的回应未生效，须如实回答。');
  }
  const event = { kind: 'item_answer', itemId: resolution.itemId, userId: resolution.userId, answer: action.answer,
    ...(resolution.roomId ? { roomId: resolution.roomId } : {}),
    ...(resolution.itemId === 'ventriloquist_doll' ? { notebooks: clone(resolution.notebooks) } : {}) };
  play.itemEvents.push(event);
  finish(play, resolution.userId, ctx);
}

/** Item selectors reveal locations/counts of cards, never their unexposed identities. */
export function getItemView(play, id, ctx) {
  const player = ctx.visitor(id);
  const canUse = player?.status === 'alive' && play.round.silent.phase === 'visitor_action'
    && play.round.silent.turnPlayerId === id && !play.round.pendingAction && !play.resolution && !play.result;
  const usableItems = canUse ? ctx.inventory(id).items.filter(item => ACTIVE_ITEMS.has(item.id)).filter(item => {
    if (item.id === 'shrine_bell') return getNoiseEffectsView(play, id).canUseBell;
    if (item.id === 'spirit_pen') return play.round.visitors.some(other => other.id !== id && other.status === 'alive' && other.roomId === player.roomId);
    if (item.id === 'nightmare_letter') return play.powers.deck.includes('despair');
    if (item.id === 'smartphone') return play.powers.hand.length > 0 || play.powers.slots.some(Boolean);
    if (item.id === 'suitcase') return play.opening.emptyBoxTokens.length > 0 && !play.extraCorners[`suitcase:${player.roomId}`];
    return true;
  }).map(item => ({ id: item.id, name: ITEM_NAMES[item.id],
    description: INITIAL_ITEMS.find(known => known.id === item.id)?.description || item.description })) : [];
  if (canUse && ctx.inventory(id).tokens.some(token => token.type === 'amulet') && play.powers.slots.some(Boolean)) {
    usableItems.push({ id: 'amulet', name: ITEM_NAMES.amulet,
      description: '消耗标准行动和一枚古怪护符，将所选可用能力栏中的能力移出游戏。' });
  }
  const phoneTargets = [
    ...play.powers.hand.map((card, index) => ({ id: `hand:${index}`, name: `箱娃手牌第${index + 1}张` })),
    ...play.powers.slots.flatMap((card, index) => card ? [{ id: `slot:${index}`, name: `可用能力栏${index + 1}` }] : []),
  ];
  return { usableItems, roomOptions: rooms(play).map(room => ({ id: room.id, name: room.name })),
    phoneTargets, result: clone(play.itemResults[id] ?? null), events: clone(play.itemEvents) };
}

export function itemResolutionView(play, id, ctx) {
  const resolution = play.resolution;
  if (resolution?.kind !== 'item_answer') return null;
  if (id !== play.round.hakoId) return { kind: 'waiting', playerId: resolution.playerId };
  return { kind: 'item_answer', playerId: resolution.playerId, userId: resolution.userId,
    itemId: resolution.itemId, ...(resolution.roomId ? { roomId: resolution.roomId } : {}),
    truth: resolution.truth, canLie: ctx.canLie(), answerOptions: answers(play, resolution, ctx) };
}
