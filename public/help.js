const TOOL_NAMES = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function clue(token) {
  switch (token?.type) {
    case 'password': return { id: `password:${token.number}`, title: `排除数字 ${token.number}`,
      effect: '密码标志表示保险箱未使用的数字，不是正确密码。' };
    case 'weakness_clue': return { id: `weakness:${token.tool}`, title: `${TOOL_NAMES[token.tool] || '对应武器'}无效`,
      effect: '讨伐情报指出这件武器对箱娃无效。' };
    case 'notebook': return { id: `notebook:${token.number}`, title: `手记 ${token.number}`,
      effect: `${token.power?.description || '对应箱娃之力的卡面说明。'} 手记不代表能力已发动。` };
    default: return null;
  }
}

/** Summarize only explicitly allowed fields of this participant's filtered view. */
export function clueSummary(state) {
  const entries = new Map();
  const add = (entry, source) => {
    if (!entry) return;
    if (!entries.has(entry.id)) entries.set(entry.id, { ...entry, sources: [] });
    const sources = entries.get(entry.id).sources;
    if (!sources.includes(source)) sources.push(source);
  };
  for (const token of state.round?.inventory?.tokens || []) add(clue(token), '当前持有 · 仅你可见');
  for (const entry of state.round?.publicDiscoveries || []) add(clue(entry.token), '曾被公开的发现 · 全员可见');
  for (const number of state.round?.safe?.publicNumbers || []) add({ id: `correct:${number}`,
    title: `确认正确数字 ${number}`, effect: '听诊器成功确认的保险箱密码数字。' }, '听诊器已确认 · 全员可见');
  return [...entries.values()];
}

export function renderClueSummary(state) {
  const section = node('details', 'private-clue-summary');
  section.id = 'private-clue-summary';
  section.dataset.testid = 'private-clue-summary';
  section.append(node('summary', '', '线索摘要 · 仅你可见'));
  section.append(node('p', 'small-note', '公开发现记录的是当时内容，不代表物品现在的位置。'));
  const entries = clueSummary(state);
  if (!entries.length) section.append(node('p', 'small-note', '当前没有可整理的密码或讨伐线索。'));
  for (const entry of entries) {
    const row = node('div', 'clue-summary-entry');
    row.dataset.clueId = entry.id;
    row.append(node('h4', '', entry.title), node('p', 'small-note', entry.effect),
      node('p', 'clue-sources small-note', entry.sources.join('；')));
    section.append(row);
  }
  return section;
}

function roleText(state) {
  if (!state) return '';
  if (state.round?.hako?.playerId === state.you || state.players?.find(player => player.id === state.you)?.role === 'hako') {
    return '你是箱娃：在暗处潜伏，阻止访问者完成胜利路线。';
  }
  const visitor = state.round?.visitors?.find(player => player.id === state.you);
  if (visitor && visitor.status !== 'alive') return visitor.status === 'banished'
    ? '你已被讨伐，仍可查看公开进度。' : '你是箱人：按当前步骤处理遗物，随后参与潜伏。';
  if (visitor) return '你是访问者：与存活访问者寻找逃脱、讨伐或超度的机会。';
  return '全员准备后，由房主开始游戏，再一起抢选箱娃。';
}

const SECTIONS = [
  ['阵营与胜利', [
    '一名玩家扮演箱娃，其余三名或四名玩家扮演访问者。访问者死亡后转为箱人。',
    '访问者有三条胜利路线：携钥匙窥探隐藏出口以逃脱；以有效讨伐道具命中箱娃；携玛丽小姐的人偶窥探亡骸以超度。',
    '存活访问者全部死亡、存活者一致投降，或三条路线均已无法达成时，箱娃获胜。请以游戏显示的正式结局为准。',
  ]],
  ['访问者的回合', [
    '开局依次选道具、轮流抽板拼图；地图完成后由房主开启秘密配置。访问者正式进入一楼大厅后开始探索。',
    '轮到你时选择翻无声标志；数字0尚未翻开时，也可持一枚盖牌跳过本回合。数字0已翻开后不能再跳过。累计恰好10仍可行动，超过10触发箱娃阶段。',
    '移动、窥探、讨伐和主动使用道具消耗一次标准行动。同房展示、给予或交换等自由行动仍受当前合法条件限制。操作以页面提供的选项为准。',
    '声明行动后，由箱娃确认或按时机打断，再结算原行动。等待确认时不能重复声明。',
    '连续翻牌逐枚判断，超限立即停止，不跨周期补翻。铃须在首翻前选定，完成额外翻牌后还须使用标准行动摇铃；只剩最后盖牌时保持原有行动先后。',
    '仅本次自己翻牌使累计超过10、仍存活且持有灭火器的人可以使用或放弃。使用会跳过本次箱娃和箱人行动；已经到期的效果仍结算。进入箱娃阶段后不能再响应。',
  ]],
  ['窥探与线索', [
    '窥探结果仅本人可见，手记自动公开。可获取标志需选择补位方式，也可留在原处结束行动；夜视仪奖励由本人选择。保险箱保留明确猜数。',
    '密码标志是未使用的数字，用于排除；听诊器成功公开的才是确认正确的密码数字。三个密码数字顺序无关。',
    '讨伐情报表示对应武器无效。手记展示能力说明，不表示箱娃已设置或发动该能力。公开发现是历史信息，不代表物品当前位置。',
  ]],
  ['箱娃与箱人的行动', [
    '箱娃先决定是否哭喊，再设置或回收能力，然后开始行动，处理阶段能力并潜伏。哭喊须在设置或回收之前，设置与回收二选一。',
    '潜伏先确认合法房间，再确认角落。确认房间后结束阶段能力选择；箱人须等待箱娃开始潜伏后，才可选择自己的合法房间和角落。',
    'NO.2路径、NO.4重排和重新盖放X按当前操作提示完成。秘密内容只对有权限的玩家展示；能力公开说明不等于发动宣告。',
  ]],
  ['死亡与遗物', [
    '死亡者转为箱人，退出访问者无声轮转，叠在凶手的实际角落；之后在箱娃阶段参与潜伏。箱人被讨伐后不能继续潜伏。',
    '只要还有存活访问者，死亡者须选择一名存活接收人交付全部库存；即使库存为空或只剩一个接收人，仍保留本人确认。群体死亡先处理所有受害者，再依次处理继承。',
    '遗物戒指例外：持有者死亡后，到下一个箱娃阶段开始前维持访问者胜利条件；该期限结束后再按箱人阵营判定。',
  ]],
  ['撤销、暂离与结束', [
    '本人尚未公开的配置可按页面直接撤销；影响共同进度的步骤需要发起时在线真人同意，人机自动同意。投票期间暂停游戏操作，仍可阅读地图和说明。',
    '撤销恢复整个操作及其必然结算，版本继续递增；不会回退聊天、身份或连接，也不会把恢复物品视为新获得。撤销后人机暂停，等待真人继续。',
    '关页或断线不等于退出，可凭原身份恢复。全体真人离线5分钟会自动结束，任意真人重连取消倒计时。',
    '退出房间会结束当前局并释放自己的座位；房主结束本局会让大家返回大厅。正常结局可复盘，重新开局前真人须重新准备。',
  ]],
];

export function createHelpUI() {
  const dialog = node('dialog', 'event-dialog help-dialog');
  dialog.id = 'help-dialog';
  dialog.dataset.testid = 'help-dialog';
  dialog.setAttribute('aria-labelledby', 'help-title');
  const content = node('article', 'help-content');
  content.id = 'help-content';
  const closeButton = node('button', 'button secondary', '返回游戏');
  closeButton.id = 'help-close';
  closeButton.dataset.testid = 'help-close';
  closeButton.type = 'button';
  const heading = node('h2', '', '玩法说明');
  heading.id = 'help-title';
  const role = node('p', 'small-note');
  role.id = 'help-role';
  content.append(closeButton, heading, role);
  for (const [title, paragraphs] of SECTIONS) {
    const section = node('section');
    section.append(node('h3', '', title));
    for (const paragraph of paragraphs) section.append(node('p', '', paragraph));
    content.append(section);
  }
  content.append(node('p', 'small-note', '本页采用当前联机版的已确认规则。连续翻牌、九块板各算一房、继承与灭火器时机等按本项目试玩裁定结算；原图与版本差异详见项目规则资料。'));
  dialog.append(content);
  document.body.append(dialog);
  let latest = null;
  let context = '';
  let returnFocus = null;

  function close(restoreFocus = true, resumeEvents = true) {
    if (!dialog.open) return;
    dialog.close();
    if (restoreFocus) {
      const target = returnFocus?.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length
        ? returnFocus : document.getElementById('room-menu-toggle') || document.getElementById('focus-current-action');
      target?.focus({ preventScroll: true });
    }
    returnFocus = null;
    document.dispatchEvent(new CustomEvent('game-help-close', { detail: { resumeEvents } }));
  }
  closeButton.addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  document.addEventListener('game-help-interrupt', () => close(false, false));
  function open() {
    if (!latest || dialog.open) return;
    returnFocus = document.activeElement;
    document.dispatchEvent(new CustomEvent('game-help-open'));
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }
  return {
    receive(state) {
      const nextContext = `${state.code}:${state.you}:${state.phase === 'lobby' ? 'lobby' : 'game'}:${roleText(state)}`;
      if (context && context !== nextContext) {
        close(false, false);
        dialog.scrollTop = 0;
      }
      context = nextContext;
      latest = state;
      role.textContent = roleText(state);
    },
    open,
    addMenuButton(container) {
      if (!container) return;
      const button = node('button', 'button secondary', '玩法说明');
      button.id = 'show-help';
      button.type = 'button';
      button.dataset.testid = 'show-help';
      button.dataset.uiControl = '';
      button.addEventListener('click', () => {
        document.getElementById('room-menu')?.hidePopover();
        open();
      });
      container.append(button);
    },
    close,
    clear() {
      close(false, false);
      context = '';
      latest = null;
      role.textContent = '';
      dialog.scrollTop = 0;
    },
  };
}
