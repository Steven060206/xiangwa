const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function applyUndoLock(state) {
  if (!state.undo?.pending) return;
  for (const element of document.querySelectorAll('#lobby-view button, #setup-view button, #setup-view select, #setup-view input')) {
    if (!element.closest('#floor-tabs, #map-positions, #chat-panel') && !['map-focus', 'corner-guide-toggle', 'focus-current-action', 'focus-inventory', 'leave-room'].includes(element.id)) element.disabled = true;
  }
}

export function renderUndo({ state, pending, online, action }) {
  const panel = document.getElementById('undo-panel');
  if (!panel) return;
  const undo = state.undo;
  const locked = pending || !online;
  const controls = node('div', 'undo-controls');
  const addButton = (label, id, type, payload = {}, disabled = false, confirmation = '') => {
    const button = node('button', 'button secondary', label);
    button.type = 'button';
    button.dataset.testid = id;
    button.disabled = locked || disabled;
    button.addEventListener('click', () => {
      if (!confirmation || window.confirm(confirmation)) action(type, payload);
    });
    controls.append(button);
  };
  if (undo?.pending) {
    const request = undo.pending;
    const name = state.players.find(player => player.id === request.requestedBy)?.name || '玩家';
    controls.append(node('p', '', `${name}请求撤销上一步 · 已同意 ${request.approvedIds.length}/${request.requiredIds.length}`));
    if (request.requiredIds.includes(state.you) && !request.approvedIds.includes(state.you)) {
      addButton('同意撤销', 'undo-accept', 'undo_respond', { requestId: request.id, accept: true });
      addButton('继续当前进度', 'undo-reject', 'undo_respond', { requestId: request.id, accept: false });
    }
    if (request.requestedBy === state.you || state.hostId === state.you) {
      addButton('取消撤销请求', 'undo-cancel', 'undo_cancel', { requestId: request.id });
    }
  } else {
    addButton('撤销上一步', 'undo-request', 'undo_request', { version: state.version }, !undo?.available);
    controls.append(node('p', 'undo-hint', undo?.available
      ? `${undo.label} ${undo.mode === 'direct' ? '自己的步骤，可直接撤回。' : '需其他在线真人同意；人机自动同意。'}`
      : '从现在起记录操作，最多可逐步撤销40步。'));
    if (undo?.paused) {
      controls.append(node('span', 'undo-hint', '人机已暂停，可先检查盘面。'));
      if (undo.canResume) addButton('继续人机', 'undo-resume', 'undo_resume');
    }
  }
  if (state.phase !== 'lobby') {
    if (state.hostId === state.you && !state.round?.result) {
      addButton('结束本局', 'restart-current-game', 'restart_game', { abandon: true }, false,
        '确定结束本局并让所有玩家返回大厅？本局进度、复盘、聊天和撤销记录将清空；房间和所有玩家的座位保留，重新准备后可开始新局。');
    }
    const you = state.players.find(player => player.id === state.you);
    if (you && !you.isBot) {
      addButton('退出房间', 'leave-current-room', 'leave', { endGame: true }, false,
        '退出将释放你的座位，并结束当前对局，其他玩家返回大厅；确定退出？');
    }
  }
  panel.hidden = false;
  for (const hint of controls.querySelectorAll('p, .undo-hint')) hint.title = hint.textContent;
  panel.replaceChildren(controls);
  applyUndoLock(state);
}
