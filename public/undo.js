const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function renderUndo({ state, pending, online, action }) {
  const panel = document.getElementById('undo-panel');
  if (!panel) return;
  const undo = state.undo;
  const locked = pending || !online;
  const controls = node('div', 'undo-controls');
  const addButton = (label, id, type, payload = {}, disabled = false) => {
    const button = node('button', 'button secondary', label);
    button.type = 'button';
    button.dataset.testid = id;
    button.disabled = locked || disabled;
    button.addEventListener('click', () => action(type, payload));
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
  panel.hidden = false;
  for (const hint of controls.querySelectorAll('p, .undo-hint')) hint.title = hint.textContent;
  panel.replaceChildren(controls);
  for (const element of document.querySelectorAll('#lobby-view button, #setup-view button, #setup-view select, #setup-view input')) {
    if (undo?.pending && !element.closest('#floor-tabs, #map-positions') && !['map-focus', 'corner-guide-toggle'].includes(element.id)) element.disabled = true;
  }
}
