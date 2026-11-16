const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function applyUndoLock(state) {
  if (!state.undo?.pending) return;
  for (const element of document.querySelectorAll('#lobby-view button, #setup-view button, #setup-view select, #setup-view input, #setup-view textarea')) {
    if (!element.closest('[data-ui-control], [data-local-control], #floor-tabs, #map-positions, #chat-panel') && !['map-focus', 'corner-guide-toggle', 'focus-current-action', 'focus-inventory', 'leave-room'].includes(element.id)) element.disabled = true;
  }
}

export function renderUndo({ state, pending, online, action }) {
  const panel = document.getElementById('undo-panel');
  if (!panel) return;
  const menu = document.getElementById('room-menu-content');
  const undo = state.undo;
  const locked = pending || !online;
  const controls = node('div', 'undo-controls');
  const menuControls = node('div', 'room-operation-controls');
  const addButton = (target, label, id, type, payload = {}, disabled = false, confirmation = '') => {
    const button = node('button', 'button secondary', label);
    button.type = 'button';
    button.id = id;
    button.dataset.testid = id;
    button.disabled = locked || disabled;
    button.addEventListener('click', () => {
      if (!confirmation || window.confirm(confirmation)) action(type, payload);
    });
    target.append(button);
  };
  if (undo?.pending) {
    const request = undo.pending;
    const name = state.players.find(player => player.id === request.requestedBy)?.name || '玩家';
    const names = ids => ids.map(id => `${state.players.find(player => player.id === id)?.name || '玩家'}${id === state.you ? '（你）' : ''}`).join('、');
    const waiting = request.requiredIds.filter(id => !request.approvedIds.includes(id));
    const status = node('div', 'undo-vote-status');
    status.dataset.testid = 'undo-vote-status';
    status.setAttribute('role', 'status');
    status.append(node('p', '', `已同意 ${request.approvedIds.length}/${request.requiredIds.length}：${names(request.approvedIds)}`),
      node('p', '', `待回应：${names(waiting) || '正在恢复进度'}`));
    controls.classList.add('undo-vote');
    controls.append(node('h2', '', '撤销投票'), node('p', '', `${name}请求撤销上一步${request.label ? `：${request.label}` : ''}`), status);
    const actions = node('div', 'undo-vote-actions');
    if (request.requiredIds.includes(state.you) && !request.approvedIds.includes(state.you)) {
      addButton(actions, '同意撤销', 'undo-accept', 'undo_respond', { requestId: request.id, accept: true });
      addButton(actions, '拒绝并继续当前进度', 'undo-reject', 'undo_respond', { requestId: request.id, accept: false });
    }
    if (request.requestedBy === state.you || state.hostId === state.you) {
      addButton(actions, '取消撤销请求', 'undo-cancel', 'undo_cancel', { requestId: request.id });
    }
    controls.append(actions, node('p', 'undo-hint', !online ? '连接中断，恢复后可回应本次投票。'
      : pending ? '正在提交，请稍候。' : request.approvedIds.includes(state.you) ? '你已同意，等待其余玩家回应。'
        : request.requiredIds.includes(state.you) ? '请选择是否撤销。拒绝或取消均保留当前进度。' : '本次无需你表决，请等待上述玩家回应。'),
    node('p', 'undo-hint', '当前进度已暂停；地图、物品、事件与消息仍可查看。'));
  } else {
    addButton(menuControls, '撤销上一步', 'undo-request', 'undo_request', { version: state.version }, !undo?.available);
    menuControls.append(node('p', 'undo-hint', undo?.available
      ? `${undo.label} ${undo.mode === 'direct' ? '自己的步骤，可直接撤回。' : '需其他在线真人同意；人机自动同意。'}`
      : '当前没有可撤销的步骤，最多保留40步。'));
    if (undo?.paused) {
      controls.append(node('p', 'undo-hint', '撤销后人机已暂停，可先检查盘面。房主可继续人机，真人成功操作后也会继续。'));
      if (undo.canResume) addButton(controls, '继续人机', 'undo-resume', 'undo_resume');
    }
  }
  if (state.phase !== 'lobby') {
    if (state.hostId === state.you && !state.round?.result) {
      addButton(menuControls, '结束本局', 'restart-current-game', 'restart_game', { abandon: true }, false,
        '确定结束本局并让所有玩家返回大厅？本局进度、复盘、聊天和撤销记录将清空；房间和所有玩家的座位保留，重新准备后可开始新局。');
    }
    const you = state.players.find(player => player.id === state.you);
    if (you && !you.isBot) {
      addButton(menuControls, '退出房间', 'leave-current-room', 'leave', { endGame: true }, false,
        '退出将释放你的座位，并结束当前对局，其他玩家返回大厅；确定退出？');
    }
  }
  panel.hidden = !undo?.pending && !undo?.paused;
  panel.replaceChildren(controls);
  menu?.replaceChildren(menuControls);
  applyUndoLock(state);
}
