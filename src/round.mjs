import { MAP_TILES, getLogicalRoomId } from './maps.mjs';
import {
  createSilentRound, revealSilent, skipSilent, finishVisitorAction,
  passNoiseReaction, finishHakoPhase, getSilentView,
} from './silent.mjs';
import { getCornerRoom, getMoveTargets, getInitialHidingCorners, getHidingTargets } from './movement.mjs';

/** Called after the remaining physical-component setup has been resolved.
 * Initial hiding is chosen by hako; component quantities and effects are not inferred here.
 */
export function createRound(setup, { hakoId, hidingCornerId, numbers } = {}) {
  if (setup?.phase !== 'map_ready' || setup.placements?.length !== MAP_TILES.length
      || new Set(setup.placements.map(p => p.tileId)).size !== MAP_TILES.length
      || setup.placements.some(p => !MAP_TILES.some(tile => tile.id === p.tileId))) {
    throw new Error('请先按规则完成九块地图的配置。');
  }
  const silent = createSilentRound(setup.visitorIds, { numbers });
  if (typeof hakoId !== 'string' || !hakoId.trim() || setup.visitorIds.includes(hakoId)) {
    throw new Error('箱娃必须是访问者以外的玩家。');
  }
  if (!getInitialHidingCorners(setup.placements).includes(hidingCornerId)) {
    throw new Error('箱娃的初始潜伏角落须位于标有“怨”的房间。');
  }
  return {
    hakoId,
    placements: setup.placements.map(p => ({ ...p })),
    visitors: setup.visitorIds.map(id => ({ id, roomId: 'hall_room' })),
    hidingCornerId,
    blockedDoors: [],
    pendingAction: null,
    silent,
  };
}

function assertPlayer(round, playerId) {
  if (playerId !== round.hakoId && !round.visitors.some(player => player.id === playerId)) {
    throw new Error('只有本局玩家可以查看或执行回合操作。');
  }
}

function assertHako(round, playerId) {
  if (round.hakoId !== playerId) throw new Error('只有箱娃可以进行此操作。');
}

function assertVisitorAction(round, playerId) {
  if (round.silent.phase !== 'visitor_action' || round.silent.turnPlayerId !== playerId) {
    throw new Error('请等待自己的行动机会并先翻开无声标志。');
  }
}

/** Apply a completed baseline action; card effects will resolve through their own handlers. */
export function applyRoundAction(round, playerId, action) {
  assertPlayer(round, playerId);
  if (!action || typeof action.type !== 'string') throw new Error('请选择回合操作。');
  if (round.pendingAction && action.type !== 'resolve_visitor_action') {
    throw new Error('访问者已声明行动，请先等待箱娃的打断窗口结束。');
  }
  switch (action.type) {
    case 'silent_reveal':
      revealSilent(round.silent, playerId, action.index);
      break;
    case 'silent_skip':
      skipSilent(round.silent, playerId, action.index);
      break;
    case 'move': {
      assertVisitorAction(round, playerId);
      const visitor = round.visitors.find(player => player.id === playerId);
      const targets = getMoveTargets(round.placements, visitor.roomId, { blockedDoors: round.blockedDoors });
      const targetRoomId = getLogicalRoomId(action.roomId);
      if (!targets.includes(targetRoomId)) throw new Error('只能移动到门或楼梯相连、且通路未被封锁的相邻房间。');
      // Declaration and resolution are separate so later powers can interrupt before movement.
      round.pendingAction = { type: 'move', playerId, fromRoomId: getLogicalRoomId(visitor.roomId), toRoomId: targetRoomId };
      break;
    }
    case 'resolve_visitor_action': {
      assertHako(round, playerId);
      if (!round.pendingAction) throw new Error('当前没有等待结算的访问者行动。');
      const pending = round.pendingAction;
      assertVisitorAction(round, pending.playerId);
      const visitor = round.visitors.find(player => player.id === pending.playerId);
      const targets = getMoveTargets(round.placements, visitor.roomId, { blockedDoors: round.blockedDoors });
      if (getLogicalRoomId(visitor.roomId) !== getLogicalRoomId(pending.fromRoomId)
          || !targets.includes(getLogicalRoomId(pending.toRoomId))) {
        throw new Error('房间通路已改变，请先处理待结算行动。');
      }
      finishVisitorAction(round.silent, pending.playerId);
      visitor.roomId = getLogicalRoomId(pending.toRoomId);
      round.pendingAction = null;
      break;
    }
    case 'pass_noise_reaction':
      assertHako(round, playerId);
      passNoiseReaction(round.silent);
      break;
    case 'hako_hide': {
      assertHako(round, playerId);
      if (round.silent.phase !== 'hako_phase') throw new Error('尚未进入箱娃阶段。');
      const targets = getHidingTargets(round.placements, round.hidingCornerId);
      if (!targets.includes(action.cornerId)) throw new Error('普通潜伏只能选择当前或相邻房间的角落。');
      // No secret destination is placed in public events or views.
      finishHakoPhase(round.silent);
      round.hidingCornerId = action.cornerId;
      break;
    }
    default:
      throw new Error('该回合操作尚未实现。');
  }
  return getRoundView(round, playerId);
}

/** Whitelist participant views; never serialize the server's round object directly. */
export function getRoundView(round, playerId) {
  assertPlayer(round, playerId);
  const isHako = playerId === round.hakoId;
  const visitor = round.visitors.find(player => player.id === playerId);
  const mayMove = visitor && round.silent.phase === 'visitor_action'
    && round.silent.turnPlayerId === playerId && !round.pendingAction;
  const view = {
    phase: round.pendingAction ? 'visitor_reaction' : round.silent.phase,
    you: playerId,
    visitors: round.visitors.map(player => ({ id: player.id, roomId: getLogicalRoomId(player.roomId) })),
    silent: getSilentView(round.silent),
    pendingAction: round.pendingAction ? { ...round.pendingAction,
      ...(round.pendingAction.fromRoomId ? { fromRoomId: getLogicalRoomId(round.pendingAction.fromRoomId) } : {}),
      ...(round.pendingAction.toRoomId ? { toRoomId: getLogicalRoomId(round.pendingAction.toRoomId) } : {}) } : null,
    moveTargets: mayMove ? getMoveTargets(round.placements, visitor.roomId, { blockedDoors: round.blockedDoors }) : [],
    hako: { playerId: round.hakoId },
  };
  if (isHako) {
    view.hako.cornerId = round.hidingCornerId;
    view.hako.roomId = getCornerRoom(round.hidingCornerId).id;
    view.hako.hidingTargets = round.silent.phase === 'hako_phase'
      ? getHidingTargets(round.placements, round.hidingCornerId) : [];
  }
  return view;
}
