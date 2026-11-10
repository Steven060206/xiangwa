import { randomUUID } from 'node:crypto';
import { getCornerRoom } from './movement.mjs';
import { getLogicalRoomId } from './maps.mjs';
import { emitGameEvent } from './events.mjs';

const MAIN = 'walkie_talkie';
const COMPANION = 'walkie_companion';
const ACTIONS = new Set(['walkie_propose', 'walkie_respond', 'walkie_cancel',
  'walkie_show_propose', 'walkie_show_confirm', 'walkie_show_cancel']);
const companion = () => ({ id: COMPANION, name: '配套对讲机',
  description: '只与固定同伴的对讲机联系；不能转交。任一台被抢夺后永久失效，任一同伴死亡后断联。' });
const visitor = (play, id) => play.round.visitors.find(player => player.id === id);
const alive = (play, id) => visitor(play, id)?.status === 'alive';
const holds = (play, id, itemId) => play.inventories[id]?.items.some(item => item.id === itemId) === true;
const device = item => [MAIN, COMPANION].includes(typeof item === 'string' ? item : item?.id);
const sameRoom = (play, a, b) => getLogicalRoomId(visitor(play, a)?.roomId) === getLogicalRoomId(visitor(play, b)?.roomId);
const participants = state => state?.pair ? [state.pair.ownerId, state.pair.partnerId] : [];

function stateFor(play) {
  return play.walkie ??= { pair: null, invalidReason: null, pairRequest: null, showRequest: null, results: {} };
}
function freeNow(play, id) {
  return alive(play, id) && !play.result && !play.resolution && !play.interruption && !play.round.pendingAction
    && ['visitor_reveal', 'visitor_action'].includes(play.round.silent.phase) && !(play.round.silent.revealsRemaining > 0);
}
function assertAlive(play, id) {
  if (!alive(play, id)) throw new Error('只有存活访问者可以使用对讲机。');
}
function assertFree(play, id, helpers) {
  helpers.assertFree(id);
  if (!freeNow(play, id)) throw new Error('请等待当前结算或箱娃阶段结束后使用对讲机。');
}
function matching(request, id) {
  if (!request || request.id !== id) throw new Error('这次对讲机请求已结束，请查看最新进度。');
  return request;
}
function cancelDeclaration(play, requestId) {
  const pending = play.round.pendingAction;
  if (pending?.type === 'free' && pending.actionType?.startsWith('walkie_') && pending.action?.requestId === requestId) {
    play.round.pendingAction = null;
  }
}
function announce(play, userId, targetId, operation, status = 'triggered') {
  emitGameEvent(play, { kind: 'item_used', itemId: MAIN, userId, targetId, operation, status });
}

/** A fixed pair, not current card ownership, determines the private audience. */
export function getWalkieParticipants(play, playerId) {
  const state = play?.walkie;
  const ids = participants(state);
  if (!ids.includes(playerId) || state.invalidReason || !ids.every(id => alive(play, id))) return [];
  return holds(play, state.pair.ownerId, MAIN) && holds(play, state.pair.partnerId, COMPANION) ? ids : [];
}

export function isLockedWalkie(play, item) {
  return Boolean(play.walkie?.pair) && device(item);
}

export function invalidateWalkieForTheft(play, item) {
  if (!device(item)) return false;
  const state = stateFor(play);
  state.invalidReason = 'theft';
  state.pairRequest = null;
  state.showRequest = null;
  return true;
}

export function invalidateWalkieForDeath(play, playerId) {
  const state = play.walkie;
  if (!state) return false;
  if (participants(state).includes(playerId)) {
    state.invalidReason ||= 'death';
    state.showRequest = null;
    state.pairRequest = null;
    return true;
  }
  if ([state.pairRequest?.fromId, state.pairRequest?.targetId].includes(playerId)) state.pairRequest = null;
  return false;
}

/** Called only on the parent action transaction clone; no game turn is consumed. */
export function applyWalkieAction(play, playerId, action, helpers) {
  if (!ACTIONS.has(action.type)) return false;
  assertAlive(play, playerId);
  if (play.result) throw new Error('本局已经结束。');
  const state = stateFor(play);
  if (action.type === 'walkie_cancel') {
    const request = matching(state.pairRequest, action.requestId);
    if (request.fromId !== playerId) throw new Error('只有发起者可以取消配对邀请。');
    state.pairRequest = null;
    cancelDeclaration(play, request.id);
    return true;
  }
  if (action.type === 'walkie_show_cancel') {
    const request = matching(state.showRequest, action.requestId);
    if (![request.fromId, request.targetId].includes(playerId)) throw new Error('只有本次互看的双方可以取消。');
    state.showRequest = null;
    cancelDeclaration(play, request.id);
    return true;
  }
  if (action.type === 'walkie_respond' && action.accept === false) {
    const request = matching(state.pairRequest, action.requestId);
    if (request.targetId !== playerId) throw new Error('只有受邀访问者可以回应。');
    state.pairRequest = null;
    cancelDeclaration(play, request.id);
    return true;
  }
  assertFree(play, playerId, helpers);
  if (state.invalidReason) throw new Error('这组对讲机已失效，不能重新配对或恢复使用。');
  if (action.type === 'walkie_propose') {
    if (state.pair) throw new Error('配套对讲机已经发放，不能更换同伴。');
    if (state.pairRequest) throw new Error('请先等待或取消现有配对邀请。');
    if (!holds(play, playerId, MAIN)) throw new Error('只有对讲机持有者可以发放伴机。');
    if (action.targetId === playerId || !alive(play, action.targetId) || !sameRoom(play, playerId, action.targetId)) {
      throw new Error('请选择同房的另一名存活访问者。');
    }
    state.pairRequest = { id: randomUUID(), fromId: playerId, targetId: action.targetId };
  } else if (action.type === 'walkie_respond') {
    const request = matching(state.pairRequest, action.requestId);
    if (request.targetId !== playerId) throw new Error('只有受邀访问者可以回应。');
    if (action.accept !== true) throw new Error('请选择接受或拒绝配对。');
    if (state.pair || !alive(play, request.fromId) || !holds(play, request.fromId, MAIN)
      || !sameRoom(play, request.fromId, playerId)) throw new Error('发起者须仍持有对讲机并与你同房。');
    state.pair = { ownerId: request.fromId, partnerId: playerId };
    play.inventories[playerId].items.push(companion());
    state.pairRequest = null;
    announce(play, request.fromId, playerId, 'pair');
  } else {
    const ids = getWalkieParticipants(play, playerId);
    if (!ids.length) throw new Error('双方须存活并各自持有对应的有效对讲机。');
    const targetId = ids.find(id => id !== playerId);
    if (action.type === 'walkie_show_propose') {
      if (state.showRequest) throw new Error('请先完成或取消现有互看请求。');
      state.showRequest = { id: randomUUID(), fromId: playerId, targetId, tokenIds: {}, confirmedIds: [] };
    } else if (action.type === 'walkie_show_confirm') {
      const request = matching(state.showRequest, action.requestId);
      if (![request.fromId, request.targetId].includes(playerId)) throw new Error('你不是本次互看的参与者。');
      if (!Array.isArray(action.tokenIds) || action.tokenIds.some(id => typeof id !== 'string')
        || new Set(action.tokenIds).size !== action.tokenIds.length) throw new Error('请选择不同的随身标志。');
      const held = play.inventories[playerId].tokens;
      if (action.tokenIds.some(id => !held.some(token => token.id === id))) throw new Error('只能展示自己当前持有的标志。');
      request.tokenIds[playerId] = [...action.tokenIds];
      if (!request.confirmedIds.includes(playerId)) request.confirmedIds.push(playerId);
      if (ids.every(id => request.confirmedIds.includes(id))) {
        for (const id of ids) if (request.tokenIds[id].some(tokenId => !play.inventories[id].tokens.some(token => token.id === tokenId))) {
          throw new Error('同伴选中的标志已变化，请重新选择确认，或取消本次互看。');
        }
        const hakoRoom = getCornerRoom(play.round.hidingCornerId)?.id;
        const deaths = ids.filter(id => getLogicalRoomId(visitor(play, id).roomId) === hakoRoom)
          .map(id => ({ playerId: id, killerCornerId: play.round.hidingCornerId }));
        state.showRequest = null;
        if (deaths.length) {
          announce(play, request.fromId, request.targetId, 'show', 'ineffective');
          helpers.processDeaths(deaths);
        } else {
          for (const id of ids) {
            const fromId = ids.find(other => other !== id);
            state.results[id] = { id: request.id, fromId,
              tokens: structuredClone(play.inventories[fromId].tokens.filter(token => request.tokenIds[fromId].includes(token.id))) };
          }
          announce(play, request.fromId, request.targetId, 'show');
        }
      }
    }
  }
  return true;
}

export function getWalkieView(play, playerId, tokenView = token => structuredClone(token)) {
  const state = play.walkie;
  const ids = participants(state);
  const proposal = state?.pairRequest;
  const involved = ids.includes(playerId) || [proposal?.fromId, proposal?.targetId].includes(playerId);
  if (!involved && !holds(play, playerId, MAIN) && !holds(play, playerId, COMPANION)) return null;
  const available = freeNow(play, playerId);
  const active = getWalkieParticipants(play, playerId).length > 0;
  const canPair = available && !state?.pair && !state?.invalidReason && !proposal && holds(play, playerId, MAIN);
  const request = state?.showRequest;
  const result = state?.results?.[playerId];
  return {
    state: state?.invalidReason ? 'inactive' : state?.pair ? active ? 'active' : 'inactive' : 'unpaired',
    reason: state?.invalidReason || (state?.pair && !active ? 'missing_device' : null),
    partnerId: ids.find(id => id !== playerId) || null,
    canPair,
    pairTargets: canPair ? play.round.visitors.filter(player => player.id !== playerId && player.status === 'alive'
      && sameRoom(play, playerId, player.id)).map(player => ({ id: player.id, roomId: getLogicalRoomId(player.roomId) })) : [],
    pairRequest: proposal && [proposal.fromId, proposal.targetId].includes(playerId) ? { ...proposal,
      canAccept: available && proposal.targetId === playerId && alive(play, proposal.fromId)
        && holds(play, proposal.fromId, MAIN) && sameRoom(play, proposal.fromId, playerId) } : null,
    canShow: available && active && !request,
    showRequest: request && ids.includes(playerId) ? { id: request.id, fromId: request.fromId, targetId: request.targetId,
      confirmedIds: [...request.confirmedIds], ownTokenIds: [...(request.tokenIds[playerId] || [])], canConfirm: available && active } : null,
    lastShow: result ? { id: result.id, fromId: result.fromId, tokens: result.tokens.map(tokenView) } : null,
  };
}
