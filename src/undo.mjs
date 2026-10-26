import { randomUUID } from 'node:crypto';

const fields = ['selectingHako', 'draft', 'game', 'opening', 'play', 'log'];
const personal = new Set(['ready', 'choose_secrets', 'place_remains', 'inspect_initial_room',
  'choose_initial_hiding', 'inspect_hiding_room', 'inspect_path_room', 'set_power', 'recall_power']);
export const membershipActions = new Set(['add_bots', 'remove_player', 'leave']);

export function clearUndo(room) {
  room.undoHistory = [];
  room.undoPending = null;
  room.undoPaused = false;
}

export function checkpoint(room) {
  return structuredClone({ ...Object.fromEntries(fields.map(key => [key, room[key] ?? null])),
    players: room.players.map(({ id, role, ready }) => ({ id, role, ready })) });
}

export function rememberAction(room, before, playerId, type, label) {
  room.undoHistory = [...(room.undoHistory || []), {
    before, actorId: playerId, type, label, direct: personal.has(type),
  }].slice(-40);
}

export function undoView(room, playerId) {
  const last = room.undoHistory?.at(-1);
  return {
    available: Boolean(last), steps: room.undoHistory?.length || 0,
    mode: last?.direct && last.actorId === playerId ? 'direct' : 'vote',
    label: last?.label || '', actorId: last?.actorId || null,
    pending: room.undoPending ? structuredClone(room.undoPending) : null,
    paused: Boolean(room.undoPaused), canResume: room.hostId === playerId && Boolean(room.undoPaused),
  };
}

function restore(room) {
  const last = room.undoHistory.pop();
  if (!last) throw new Error('当前没有可撤销的步骤。');
  for (const key of fields) room[key] = structuredClone(last.before[key]);
  for (const saved of last.before.players) {
    const player = room.players.find(player => player.id === saved.id);
    if (!player) throw new Error('玩家席位已变化，无法撤销。');
    player.role = saved.role;
    player.ready = saved.ready;
  }
  room.undoPending = null;
  room.undoPaused = room.players.some(player => player.isBot);
}

export function applyUndo(room, player, input, onlineIds) {
  if (input.type === 'undo_request') {
    if (room.undoPending) throw new Error('已有撤销请求，请先处理。');
    if (input.version !== room.version) throw new Error('页面进度已更新，请查看最新一步后重新撤销。');
    const last = room.undoHistory?.at(-1);
    if (!last) throw new Error('当前没有可撤销的步骤。');
    const requiredIds = room.players.filter(candidate => !candidate.isBot && onlineIds.includes(candidate.id))
      .map(candidate => candidate.id);
    if (!requiredIds.includes(player.id)) requiredIds.push(player.id);
    if (last.direct && last.actorId === player.id || requiredIds.length === 1) {
      restore(room);
      return `${player.name} 撤销了上一步。`;
    }
    room.undoPending = { id: randomUUID(), requestedBy: player.id, requiredIds,
      approvedIds: [player.id], label: last.label };
    return `${player.name} 请求撤销上一步，等待在线真人同意。`;
  }
  if (input.type === 'undo_resume') {
    if (room.hostId !== player.id) throw new Error('只有房主可以恢复人机。');
    if (room.undoPending || !room.undoPaused) throw new Error('当前不需要恢复人机。');
    room.undoPaused = false;
    return '人机继续行动。';
  }
  const pending = room.undoPending;
  if (!pending || pending.id !== input.requestId) throw new Error('撤销请求已结束或更新。');
  if (input.type === 'undo_cancel') {
    if (pending.requestedBy !== player.id && room.hostId !== player.id) throw new Error('只有发起人或房主可以取消。');
    room.undoPending = null;
    return `${player.name} 取消了撤销请求。`;
  }
  if (!pending.requiredIds.includes(player.id) || pending.approvedIds.includes(player.id)) {
    throw new Error('你无需重复回应这次撤销请求。');
  }
  if (typeof input.accept !== 'boolean') throw new Error('请选择同意或拒绝撤销。');
  if (!input.accept) {
    room.undoPending = null;
    return `${player.name} 拒绝了撤销请求，继续当前进度。`;
  }
  pending.approvedIds.push(player.id);
  if (pending.requiredIds.every(id => pending.approvedIds.includes(id))) {
    restore(room);
    return '在线真人已同意，已撤销上一步。';
  }
  return `${player.name} 同意了撤销请求。`;
}
