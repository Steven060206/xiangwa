const make = (tag, text, className = '') => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const names = { password: '密码', weakness_clue: '讨伐情报', weapon: '讨伐道具', key: '钥匙', doll: '玛丽小姐的人偶',
  amulet: '古怪护符', extinguisher: '灭火器', notebook: '手记', empty_box: '空箱' };
const tools = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };
const tokenName = token => token.name || (token.type === 'weapon' ? tools[token.tool]
  : token.type === 'weakness_clue' ? `${tools[token.tool] || '该武器'}无效` : `${names[token.type] || '标志'}${token.number ?? ''}`);
let selectionKey = '', selectedIds = new Set();

/** Render only the requesting player's server-filtered walkie state. */
export function renderWalkieControls(state, sendAction, { locked = false } = {}) {
  const view = state.round?.walkie;
  if (!view) return null;
  locked ||= Boolean(state.undo?.pending || state.round.result);
  const name = id => state.players.find(player => player.id === id)?.name || '玩家';
  const section = make('section', undefined,
    `exploration-section walkie-controls${view.pairRequest || view.showRequest ? ' current-response' : ''}`);
  section.dataset.testid = 'walkie-controls';
  section.append(make('h3', '对讲机 · 固定同伴'));
  const controls = make('div', undefined, 'practice-controls');
  const error = make('p', '', 'small-note');
  error.setAttribute('role', 'status');
  let busy = false;
  const button = (text, testId, type, payload, disabled = false) => {
    const element = make('button', text, 'button secondary small');
    element.type = 'button';
    element.dataset.testid = testId;
    element.disabled = locked || disabled;
    element.addEventListener('click', async () => {
      if (busy || element.disabled) return;
      busy = true;
      element.disabled = true;
      error.textContent = '';
      try { await sendAction(type, typeof payload === 'function' ? payload() : payload); }
      catch (cause) { error.textContent = cause.message; }
      finally { busy = false; element.disabled = locked || disabled; }
    });
    return element;
  };
  if (view.state === 'inactive') {
    section.append(make('p', view.reason === 'theft' ? '设备曾被抢夺，本局永久失效；归还也不能恢复。'
      : view.reason === 'death' ? '同伴已死亡，对讲机连接结束，不能重新配对。' : '对应设备已不在双方身上，当前无法连接。', 'small-note'));
  } else if (view.partnerId) {
    section.append(make('p', `固定同伴：${name(view.partnerId)}。私聊不消耗行动；互看须双方选择并确认。`, 'small-note'));
    section.append(make('p', '互看只展示选中的标志，不转移物品；若任一方与箱娃同房，该方在查看前死亡，本次互看取消。', 'small-note'));
  } else {
    section.append(make('p', '同房自由行动邀请一名存活访问者，接受后发放唯一伴机。配对固定，双方设备不能转交。', 'small-note'));
  }
  if (view.pairRequest) {
    const request = view.pairRequest;
    const incoming = request.targetId === state.you;
    controls.append(make('p', incoming ? `${name(request.fromId)}邀请你领取配套对讲机。接受后本局不能更换同伴。`
      : `等待${name(request.targetId)}接受配对。`));
    if (incoming) {
      controls.append(button('接受并领取伴机', 'walkie-accept', 'walkie_respond', { requestId: request.id, accept: true }, !request.canAccept),
        button('拒绝配对', 'walkie-reject', 'walkie_respond', { requestId: request.id, accept: false }));
    } else controls.append(button('取消邀请', 'walkie-cancel', 'walkie_cancel', { requestId: request.id }));
  } else if (view.canPair) {
    if (view.pairTargets.length) {
      const label = make('label', '选择同房搭档');
      const select = make('select');
      select.dataset.testid = 'walkie-partner';
      label.append(select);
      select.disabled = locked;
      for (const target of view.pairTargets) {
        const option = make('option', name(target.id));
        option.value = target.id;
        select.append(option);
      }
      controls.append(label, button('邀请领取伴机', 'walkie-propose', 'walkie_propose', () => ({ targetId: select.value })));
    } else controls.append(make('p', '当前没有同房的存活搭档。', 'small-note'));
  }
  if (view.showRequest) {
    const request = view.showRequest;
    const mine = request.confirmedIds.includes(state.you);
    const key = `${state.code}:${state.you}:${request.id}`;
    if (selectionKey !== key) { selectionKey = key; selectedIds = new Set(request.ownTokenIds); }
    const tokens = state.round.inventory?.tokens || [];
    selectedIds = new Set([...selectedIds].filter(id => tokens.some(token => token.id === id)));
    controls.append(make('p', `${mine ? '你已确认，可更新选择。' : '请选择愿意向同伴展示的标志。'}双方确认前不会互相看到内容。`, 'small-note'));
    const choices = make('fieldset');
    choices.dataset.testid = 'walkie-token-choices';
    choices.append(make('legend', '本次展示（可多选，也可不展示）'));
    for (const token of tokens) {
      const label = make('label', undefined, 'inline-check');
      const input = make('input');
      input.type = 'checkbox';
      input.dataset.tokenId = token.id;
      input.checked = selectedIds.has(token.id);
      input.disabled = locked || !request.canConfirm;
      input.addEventListener('change', () => input.checked ? selectedIds.add(token.id) : selectedIds.delete(token.id));
      label.append(input, make('span', tokenName(token)));
      choices.append(label);
    }
    if (!tokens.length) choices.append(make('p', '你没有随身标志，仍可确认本次互看。', 'small-note'));
    controls.append(choices, make('p', request.confirmedIds.includes(view.partnerId) ? '同伴已确认。' : '等待同伴选择并确认。', 'small-note'),
      button(mine ? '更新并确认选择' : '确认本次选择', 'walkie-show-confirm', 'walkie_show_confirm',
        () => ({ requestId: request.id, tokenIds: [...selectedIds] }), !request.canConfirm),
      button('取消本次互看', 'walkie-show-cancel', 'walkie_show_cancel', { requestId: request.id }));
  } else if (view.canShow) {
    controls.append(button('邀请同伴互看标志', 'walkie-show-propose', 'walkie_show_propose', {}));
  }
  if (view.lastShow) {
    const result = make('details', undefined, 'reference-details');
    result.dataset.testid = 'walkie-last-show';
    result.open = true;
    result.append(make('summary', `${name(view.lastShow.fromId)}上次展示 · 仅你可见`));
    const list = make('ul', undefined, 'inventory-list');
    for (const token of view.lastShow.tokens) list.append(make('li', tokenName(token)));
    result.append(list, make('p', view.lastShow.tokens.length ? '这是互看完成时的记录，不跟随后续库存变化。' : '同伴本次没有选择展示标志。', 'small-note'));
    section.append(result);
  }
  section.append(controls, error);
  return section;
}
