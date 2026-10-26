import { MAP_TILES } from '/shared/maps.mjs';
import { cornerName } from './tile.js';
import { renderAbilities, renderActiveItems } from './abilities.js';

const rooms = MAP_TILES.flatMap(tile => tile.rooms);
const roomName = id => rooms.find(room => room.id === id)?.name || '正门';
const playerName = (state, id) => state.players.find(player => player.id === id)?.name || '访问者';
const selections = new Map();
const selectedGifts = new Set();
let safeKey = '';
let safeNumbers = [];
let bellChoiceTurn = '';
const tokenNames = {
  safe: '转轮式保险箱', notebook: '手记', password: '密码', weakness_clue: '讨伐情况',
  weapon: '讨伐道具', doll: '玛丽小姐的人偶', hidden_exit: '隐藏出口', amulet: '古怪护符',
  extinguisher: '灭火器', remains: '亡骸', hako: '箱娃', box_person: '箱人', empty_box: '空箱', key: '钥匙',
};
const toolNames = { white_stick: '白木棒', gasoline: '汽油', rusty_chain: '锈锁链' };
const resultReasons = {
  escape: '访问者已找到出口并成功逃脱。', escaped: '访问者已找到出口并成功逃脱。',
  exorcism: '访问者已携带玛丽小姐的人偶超度亡骸。', banishment: '访问者已携带玛丽小姐的人偶超度亡骸。',
  defeat: '访问者已用有效的讨伐道具击中箱娃。', subjugation: '访问者已用有效的讨伐道具击中箱娃。',
  all_dead: '所有访问者均已死亡。', all_visitors_dead: '所有访问者均已死亡。',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, testid, locked, onClick, secondary = false) {
  const element = node('button', `button ${secondary ? 'secondary' : 'primary'}`, label);
  element.type = 'button';
  element.dataset.testid = testid;
  element.disabled = locked;
  element.addEventListener('click', onClick);
  return element;
}

function tokenName(token) {
  if (!token) return '无标志';
  const parts = [token.name || tokenNames[token.type] || '角落标志'];
  if (token.number !== undefined) parts.push(`数字${token.number}`);
  if (token.tool) parts.push(`${toolNames[token.tool] || token.tool}${token.type === 'weakness_clue' ? '无效' : ''}`);
  return parts.join(' · ');
}

function select(container, id, caption, choices, locked) {
  const label = node('label', '', caption);
  label.htmlFor = id;
  const element = node('select');
  element.id = id;
  element.dataset.testid = id;
  element.disabled = locked || !choices.length;
  for (const choice of choices) {
    const option = node('option', '', choice.name);
    option.value = choice.id;
    element.append(option);
  }
  element.value = choices.some(choice => String(choice.id) === selections.get(id)) ? selections.get(id) : String(choices[0]?.id ?? '');
  selections.set(id, element.value);
  element.addEventListener('change', () => selections.set(id, element.value));
  container.append(label, element);
  return element;
}

function checkbox(container, id, caption, locked, checked = false) {
  const label = node('label', 'inline-check');
  const input = node('input');
  input.type = 'checkbox';
  input.id = id;
  input.dataset.testid = id;
  input.checked = selections.has(id) ? selections.get(id) === 'true' : checked;
  input.disabled = locked;
  input.addEventListener('change', () => selections.set(id, String(input.checked)));
  label.append(input, node('span', '', caption));
  container.append(label);
  return input;
}

export function explorationDescription(state) {
  const round = state.round;
  if (round.result) return `${round.result.winner === 'visitors' ? '访问者' : '箱娃'}胜利，本局已结束。`;
  if (round.interruption) return round.interruption.canRespond ? '你可以使用灭火器打断，或选择放弃。' : '等待灭火器持有者选择是否打断。';
  const resolution = round.resolution;
  if (resolution) {
    if (resolution.kind === 'waiting') return `等待${playerName(state, resolution.playerId)}完成结算。`;
    if (resolution.kind === 'inheritance') return '遗物戒指生效。选择将随身物品留给谁，然后成为箱人。';
    if (resolution.kind === 'safe') return '你窥探到了保险箱。选择数字并尝试开锁。';
    if (resolution.kind === 'item_answer') return '选择对道具询问的回答。';
    if (resolution.kind === 'forced_peek') return '行动被能力打断。请选择本房间的一个角落窥探。';
    return resolution.kind === 'notebook' ? '你发现了手记。公开手记，并选择补位方式。' : '你已看到角落内容。决定是否获取标志。';
  }
  const mine = round.silent?.turnPlayerId === state.you;
  const isHako = round.hako.playerId === state.you;
  const ghost = round.ghost;
  switch (round.phase) {
    case 'visitor_reveal': {
      const remaining = round.silent?.revealsRemaining || 0;
      if (remaining > 0) return mine ? `继续翻开无声标志，还需翻${remaining}张；连续翻牌完成前不能持牌跳过。` : `等待${playerName(state, round.silent?.turnPlayerId)}继续翻开${remaining}张无声标志。`;
      return mine ? '轮到你了。翻开无声标志，或持牌跳过本回合。' : `等待${playerName(state, round.silent?.turnPlayerId)}翻牌或持牌跳过。`;
    }
    case 'visitor_action': return mine ? '选择移动、窥探或使用道具。' : `等待${playerName(state, round.silent?.turnPlayerId)}行动。`;
    case 'visitor_reaction': return isHako ? '访问者已声明行动。确认后结算。' : '行动已经声明，等待箱娃确认结算。';
    case 'hako_reaction': return isHako ? '累计数字已超过10。结束反应窗口，进入箱娃阶段。' : '累计数字已超过10，等待箱娃结束反应窗口。';
    case 'hako_phase': {
      if (round.powers?.step === 'preparation') return isHako ? '可以先哭喊，再设置或回收能力；准备好后开始箱娃行动。' : '等待箱娃决定是否哭喊并设置能力。';
      const actor = isHako ? round.hako : ghost;
      if (actor?.finished) return '你已完成潜伏，等待其他箱人或箱娃行动。';
      if (actor && actor.status !== 'banished') return actor.inspectedRoom ? '已查看房间。选择一个角落潜伏。' : '先选择合法房间查看角落，再选择潜伏位置。';
      return '箱娃与箱人正在暗处行动。全部潜伏完毕后继续翻牌。';
    }
    default: return '等待下一步行动。';
  }
}

export function explorationSeatStatus(state, player) {
  const round = state.round;
  if (round.result) return round.result.winners?.includes(player.id) ? '获胜' : '本局结束';
  if (player.id === round.hako.playerId) return round.phase === 'hako_phase' ? round.hako.finished ? '已潜伏' : '潜伏中' : ['visitor_reaction', 'hako_reaction'].includes(round.phase) ? '等待确认' : '潜伏';
  const visitor = round.visitors.find(candidate => candidate.id === player.id);
  if (visitor?.status === 'box_person') return '箱人';
  if (visitor?.status === 'banished') return '已被消灭';
  if (round.resolution?.playerId === player.id) return '结算中';
  if (round.silent?.turnPlayerId === player.id) return round.phase === 'visitor_reveal' ? '翻牌中' : round.phase === 'visitor_reaction' ? '等待结算' : '行动中';
  return roomName(visitor?.roomId);
}

function publicProgress(container, state) {
  const round = state.round;
  const section = node('section', 'exploration-section');
  const notebooks = round.notebooks || [];
  section.append(node('h3', '', `公开手记 · ${notebooks.length} 片`));
  if (round.blockedWait) section.append(node('p', 'small-note', `${playerName(state, round.blockedWait.playerId)}因没有通往客厅的路线，已结束本次行动，等待通路恢复。`));
  const text = notebooks.length ? notebooks.map(value => typeof value === 'object' ? tokenName(value) : `手记${value}`).join('、') : '尚未公开手记。';
  const notebookText = node('p', 'small-note', text);
  notebookText.dataset.testid = 'public-notebooks';
  section.append(notebookText);
  if (round.safe) {
    const safe = node('p', 'small-note', round.safe.opened ? '保险箱已打开。' : `保险箱已知数字：${round.safe.publicNumbers?.length ? round.safe.publicNumbers.join('、') : '暂无'}`);
    safe.dataset.testid = 'safe-public-status';
    section.append(safe);
  }
  container.append(section);
}

function gameResult(container, state) {
  const result = state.round.result;
  const section = node('section', `game-result ${result.winner === 'visitors' ? 'visitors-win' : 'hako-win'}`);
  section.dataset.testid = 'game-result';
  section.setAttribute('role', 'status');
  section.append(node('h2', '', `${result.winner === 'visitors' ? '访问者' : '箱娃'}胜利`));
  section.append(node('p', '', resultReasons[result.reason] || result.reason || '本局已结束。'));
  if (result.winners?.length) section.append(node('p', 'small-note', `获胜玩家：${result.winners.map(id => playerName(state, id)).join('、')}`));
  section.append(node('p', 'small-note', '本局已结束，可展开宅邸记事回看行动。'));
  container.append(section);
}

function visitorControls(container, state, locked, action) {
  const round = state.round;
  if (round.phase !== 'visitor_action' || round.silent?.turnPlayerId !== state.you || round.resolution || round.interruption) return;
  const moves = node('div', 'action-group');
  moves.append(node('h3', '', '移动'));
  for (const id of round.moveTargets || []) {
    const target = button(`移动到${roomName(id)}`, 'move-target', locked, () => action('move', { roomId: id }), true);
    target.dataset.roomId = id;
    moves.append(target);
  }
  container.append(moves);
  if (round.peekTargets?.length) {
    const peek = node('div', 'action-group');
    peek.append(node('h3', '', '窥探当前房间'));
    const useNightVision = round.inventory?.items?.some(item => item.id === 'night_vision')
      ? checkbox(peek, 'peek-use-night-vision', '使用夜视仪：发现手记时领取未选道具', locked, true) : null;
    for (const id of round.peekTargets) {
      const target = button(`窥探${cornerName(id)}`, 'peek-target', locked, () => action('peek', { cornerId: id, useNightVision: Boolean(useNightVision?.checked) }), true);
      target.dataset.cornerId = id;
      peek.append(target);
    }
    container.append(peek);
  }
  if (round.weapons?.length) {
    const weapons = node('div', 'action-group');
    weapons.append(node('h3', '', '使用讨伐道具'));
    const weapon = select(weapons, 'weapon-select', '选择随身讨伐道具', round.weapons.map(token => ({ id: token.id, name: tokenName(token) })), locked);
    const myRoom = round.visitors.find(visitor => visitor.id === state.you)?.roomId;
    const corners = round.weaponTargets?.length ? round.weaponTargets.map(id => ({ id })) : rooms.find(room => room.id === myRoom)?.corners || [];
    const target = select(weapons, 'weapon-corner-select', '选择当前房间的角落', corners.map(corner => ({ id: corner.id, name: cornerName(corner.id) })), locked);
    weapons.append(button('声明使用讨伐道具', 'use-weapon', locked || !weapon.value || !target.value, () => action('use_weapon', { tokenId: weapon.value, cornerId: target.value })));
    container.append(weapons);
  }
}

function pendingControls(container, state, locked, action) {
  const round = state.round;
  const pending = round.pendingAction;
  if (!pending) return;
  const kind = pending.kind || pending.type;
  const freeActionNames = { show_token: '展示标志', offer_exchange: '提出交换或赠送', respond_exchange: '接受交换或赠送', drop_token: '丢弃标志' };
  const text = kind === 'move' || pending.toRoomId
    ? `${playerName(state, pending.playerId)}：${roomName(pending.fromRoomId)} → ${roomName(pending.toRoomId)}`
    : kind === 'item' ? `${playerName(state, pending.playerId)}声明使用道具。`
      : kind === 'free' ? `${playerName(state, pending.playerId)}声明${freeActionNames[pending.actionType] || '自由行动'}。`
      : `${playerName(state, pending.playerId)}声明${kind === 'weapon' || kind === 'use_weapon' ? '使用讨伐道具' : '窥探'}：${cornerName(pending.cornerId)}`;
  container.append(node('p', 'pending-move', text));
  if (round.hako.playerId === state.you) container.append(button('确认行动结算', 'resolve-action', locked, () => action('resolve_visitor_action')));
}

function safeControls(container, resolution, locked, action) {
  const key = `${resolution.playerId}:${resolution.cornerId}`;
  if (safeKey !== key) { safeKey = key; safeNumbers = []; }
  const stethoscope = resolution.canUseStethoscope ? checkbox(container, 'safe-use-stethoscope', '使用听诊器，只猜一个数字', locked) : null;
  const fieldset = node('fieldset', 'password-options');
  const legend = node('legend');
  fieldset.append(legend);
  const choices = node('div', 'password-choices');
  const inputs = [];
  for (const value of resolution.numberOptions || [1, 2, 3, 4, 5, 6]) {
    const label = node('label');
    const input = node('input');
    input.type = 'checkbox';
    input.value = value;
    input.checked = safeNumbers.includes(value);
    input.dataset.testid = 'guess-number-checkbox';
    label.append(input, node('span', '', String(value)));
    choices.append(label);
    inputs.push(input);
  }
  fieldset.append(choices);
  const submit = button('尝试打开保险箱', 'safe-guess-submit', true, () => action('safe_guess', { numbers: safeNumbers, useStethoscope: Boolean(stethoscope?.checked) }));
  const update = () => {
    const count = stethoscope?.checked ? 1 : 3;
    if (safeNumbers.length > count) safeNumbers = safeNumbers.slice(0, count);
    legend.textContent = `选择 ${count} 个不同数字`;
    for (const input of inputs) { input.checked = safeNumbers.includes(Number(input.value)); input.disabled = locked || !input.checked && safeNumbers.length >= count; }
    submit.disabled = locked || safeNumbers.length !== count;
    submit.textContent = stethoscope?.checked ? '用听诊器确认数字' : '尝试打开保险箱';
  };
  for (const input of inputs) input.addEventListener('change', () => { safeNumbers = inputs.filter(candidate => candidate.checked).map(candidate => Number(candidate.value)); update(); });
  stethoscope?.addEventListener('change', update);
  update();
  container.append(fieldset, submit);
}

function resolutionControls(container, state, locked, action) {
  const resolution = state.round.resolution;
  if (!resolution || ['waiting', 'item_answer', 'forced_peek'].includes(resolution.kind)) return;
  const section = node('section', 'private-resolution practice-controls');
  section.dataset.testid = 'private-resolution';
  section.dataset.kind = resolution.kind;
  section.append(node('h3', '', resolution.kind === 'inheritance' ? '遗物戒指' : '本次窥探 · 仅你可见'));
  if (resolution.kind === 'inheritance') {
    const targets = (resolution.targets || state.round.visitors.filter(visitor => visitor.status === 'alive').map(visitor => visitor.id)).map(value => ({ id: typeof value === 'string' ? value : value.id, name: playerName(state, typeof value === 'string' ? value : value.id) }));
    section.append(node('p', 'small-note', '将全部盖放标志和道具交给一名存活访问者，或放弃继承。'));
    const target = select(section, 'inheritance-target', '接收遗物的访问者', targets, locked);
    section.append(button('交付全部遗物', 'bequeath', locked || !target.value, () => action('bequeath', { targetId: target.value })));
    section.append(button('放弃继承，成为箱人', 'bequeath-none', locked, () => action('bequeath', { targetId: null }), true));
  } else if (resolution.kind === 'safe') {
    section.append(node('p', 'private-token', '转轮式保险箱'));
    safeControls(section, resolution, locked, action);
  } else {
    section.append(node('p', 'small-note', cornerName(resolution.cornerId)));
    const found = node('p', 'private-token', tokenName(resolution.token));
    found.dataset.testid = 'peek-result';
    section.append(found);
    let take = resolution.kind === 'notebook' || resolution.canTake !== false;
    const decision = node('div', 'decision-actions');
    const takeButton = button(resolution.kind === 'notebook' ? '公开这片手记' : '获取标志', 'resolve-peek-take', locked || resolution.canTake === false, () => { take = true; update(); }, true);
    const leaveButton = button('留在原处', 'resolve-peek-leave', locked || resolution.kind === 'notebook', () => { take = false; update(); }, true);
    if (resolution.canTake !== false || resolution.kind === 'notebook') decision.append(takeButton);
    if (resolution.kind !== 'notebook') decision.append(leaveButton);
    section.append(decision);
    const replacementGroup = node('div', 'replacement-controls practice-controls');
    const options = (resolution.replacementTokens || []).map(token => ({ id: token.id, name: `盖放随身${tokenName(token)}` }));
    if (resolution.canUseEmptyBox) options.unshift({ id: 'empty_box', name: '盖放空箱' });
    if (resolution.canLeaveEmpty) options.push({ id: 'none', name: '不补位，保留空角落' });
    const replacement = select(replacementGroup, 'replacement-select', '角落补位', options, locked);
    const faceUp = resolution.canFaceUp ? checkbox(replacementGroup, 'replacement-face-up', '使用归纳推理法，将空箱X面朝上', locked) : null;
    section.append(replacementGroup);
    const nightVision = resolution.nightVisionItems?.length ? select(section, 'night-vision-item', '夜视仪：领取一张未选道具', resolution.nightVisionItems, locked) : null;
    const confirm = button('确认窥探结算', 'resolve-peek', locked, () => action('resolve_peek', { take, replacement: take && resolution.needsReplacement ? replacement.value : 'none', faceUp: Boolean(faceUp?.checked && replacement.value === 'empty_box'), ...(nightVision ? { itemId: nightVision.value } : {}) }));
    function update() {
      takeButton.setAttribute('aria-pressed', String(take));
      leaveButton.setAttribute('aria-pressed', String(!take));
      replacementGroup.hidden = !take || !resolution.needsReplacement;
      if (faceUp) { faceUp.disabled = locked || replacement.value !== 'empty_box'; }
      confirm.disabled = locked || take && resolution.needsReplacement && !replacement.value;
    }
    replacement.addEventListener('change', update);
    update();
    section.append(confirm);
  }
  container.append(section);
}

function hidingControls(container, state, locked, action, inspectedRoomTokens) {
  const round = state.round;
  if (round.phase !== 'hako_phase' || round.powers?.step !== 'action' || round.powers?.rearrangement || round.interruption || round.resolution) return;
  const isHako = round.hako.playerId === state.you;
  const actor = isHako ? round.hako : round.ghost;
  if (!actor || actor.status === 'banished') return;
  if (actor.finished) { container.append(node('p', 'small-note', '已完成本次潜伏，等待其他行动者。')); return; }
  if (!isHako && !actor.inspectedRoom && !actor.hidingRooms?.length) {
    container.append(node('p', 'small-note', '等待箱娃完成阶段能力并开始潜伏。'));
    return;
  }
  const prefix = isHako ? '' : 'ghost-';
  if (actor.inspectedRoom) {
    inspectedRoomTokens(container, actor.inspectedRoom);
    const tokenRows = container.lastElementChild.children;
    const faceDownChoices = [];
    actor.inspectedRoom.corners.forEach((corner, index) => {
      if (corner.token?.type !== 'empty_box' || !corner.token.faceUp) return;
      const input = checkbox(tokenRows[index].querySelector('dd'), `hide-face-down-${state.you}-${corner.id}`, '重新盖放X', locked);
      input.dataset.testid = 'hide-face-down';
      input.dataset.cornerId = corner.id;
      faceDownChoices.push(input);
    });
    const choice = select(container, `${prefix}hiding-select`, isHako ? '本次潜伏角落' : '箱人潜伏角落', (actor.hidingTargets || []).map(id => {
      const corner = actor.inspectedRoom.corners.find(corner => corner.id === id);
      return { id, name: `${cornerName(id)} — ${tokenName(corner?.token)}` };
    }), locked);
    container.append(button('确认潜伏', isHako ? 'confirm-hiding' : 'confirm-ghost-hiding', locked || !choice.value, () => action(isHako ? 'hako_hide' : 'ghost_hide', { cornerId: choice.value, faceDownCornerIds: faceDownChoices.filter(input => input.checked).map(input => input.dataset.cornerId) })));
  } else {
    const choice = select(container, `${prefix}hiding-room-select`, '选择房间，查看全部角落标志', (actor.hidingRooms || []).map(value => typeof value === 'string' ? { id: value, name: roomName(value) } : value), locked);
    container.append(button('查看这间房间', isHako ? 'inspect-hiding-room' : 'ghost-inspect-hiding-room', locked || !choice.value, () => action('inspect_hiding_room', { roomId: choice.value })));
  }
}

function inventory(container, state, locked, action) {
  const round = state.round;
  const belongings = round.inventory;
  if (!belongings || !round.visitors.some(visitor => visitor.id === state.you)) return;
  const section = node('section', 'exploration-section inventory');
  section.dataset.testid = 'inventory';
  section.append(node('h3', '', '你的随身物品'));
  const tokens = node('ul', 'inventory-list');
  for (const token of belongings.tokens || []) {
    const line = node('li');
    line.dataset.testid = 'inventory-token';
    line.dataset.tokenId = token.id;
    line.append(node('span', '', tokenName(token)));
    tokens.append(line);
  }
  if (!belongings.tokens?.length) tokens.append(node('li', 'small-note', '尚未持有盖放标志。'));
  section.append(tokens);
  for (const item of belongings.items || []) {
    const details = node('details', 'inventory-item');
    details.dataset.testid = 'inventory-item';
    details.dataset.itemId = item.id;
    details.append(node('summary', '', item.name), node('p', 'small-note', item.description));
    section.append(details);
  }
  const alive = round.visitors.find(visitor => visitor.id === state.you)?.status === 'alive';
  const transferableTokens = (belongings.tokens || []).filter(token => token.type !== 'doll' || round.noiseEffects?.maryPlayerId !== state.you);
  if (alive && ['visitor_reveal', 'visitor_action'].includes(round.phase) && !round.result && !round.resolution && !round.pendingAction && !round.interruption) {
    const free = node('details', 'free-actions');
    free.append(node('summary', '', '展示、赠送与放置（自由行动）'));
    const controls = node('div', 'practice-controls free-action-controls');
    const partners = (round.exchangePartners || []).map(partner => ({ id: partner.id, name: playerName(state, partner.id) }));
    if (partners.length) {
      const target = select(controls, 'exchange-target', '同房访问者', partners, locked);
      if (belongings.tokens?.length) {
        const tokenChoice = select(controls, 'show-token-select', '选择只向对方展示的标志', belongings.tokens.map(token => ({ id: token.id, name: tokenName(token) })), locked);
        controls.append(button('向对方展示标志', 'show-token', locked, () => action('show_token', { tokenId: tokenChoice.value, targetId: target.value }), true));
      }
      const giftItems = [...transferableTokens.map(token => ({ ...token, giftKind: 'token', label: tokenName(token) })), ...(belongings.items || []).map(item => ({ ...item, giftKind: 'item', label: item.name }))];
      if (giftItems.length) {
        const fieldset = node('fieldset', 'gift-options');
        fieldset.append(node('legend', '', '选择要赠送的物品，可多选'));
        const inputs = [];
        for (const item of giftItems) {
          const label = node('label', 'inline-check');
          const input = node('input');
          input.type = 'checkbox';
          input.dataset.testid = 'gift-item';
          input.dataset.itemId = item.id;
          input.value = `${item.giftKind}:${item.id}`;
          input.checked = selectedGifts.has(input.value);
          input.disabled = locked;
          label.append(input, node('span', '', item.label));
          fieldset.append(label);
          inputs.push(input);
        }
        const gift = button('提出赠送，请对方确认', 'offer-gift', true, () => action('offer_exchange', { targetId: target.value, giveTokenIds: inputs.filter(input => input.checked && input.value.startsWith('token:')).map(input => input.value.slice(6)), giveItemIds: inputs.filter(input => input.checked && input.value.startsWith('item:')).map(input => input.value.slice(5)), requestTokenIds: [], requestItemIds: [] }), true);
        const update = () => { for (const input of inputs) input.checked ? selectedGifts.add(input.value) : selectedGifts.delete(input.value); gift.disabled = locked || !inputs.some(input => input.checked); };
        for (const input of inputs) input.addEventListener('change', update);
        update();
        controls.append(fieldset, gift, node('p', 'small-note', '赠送需对方接受。对方的其他物品保持私密；可再由对方另行回赠。'));
      }
    } else controls.append(node('p', 'small-note', '当前没有同房访问者可以展示或赠送。'));
    if (transferableTokens.length && round.dropTargets?.length) {
      const token = select(controls, 'drop-token-select', '选择要放置的随身标志', transferableTokens.map(value => ({ id: value.id, name: tokenName(value) })), locked);
      const corner = select(controls, 'drop-corner-select', '当前房间的空角落', round.dropTargets.map(id => ({ id, name: cornerName(id) })), locked);
      controls.append(button('盖放到空角落', 'drop-token', locked, () => action('drop_token', { tokenId: token.value, cornerId: corner.value }), true));
    }
    free.append(controls);
    section.append(free);
  }
  container.append(section);
}

function exchanges(container, state, locked, action) {
  const round = state.round;
  const sharedTokens = Array.isArray(round.sharedTokens) ? round.sharedTokens : round.sharedTokens ? [round.sharedTokens] : [];
  if (sharedTokens.length) {
    const section = node('section', 'exploration-section');
    section.append(node('h3', '', '你的私密消息'));
    const list = node('ul', 'inventory-list');
    for (const shared of sharedTokens) {
      const text = shared.kind === 'safe_result'
        ? shared.usedStethoscope ? `听诊器：${shared.correct ? '数字正确，已公开该数字。' : '数字不正确。'}` : shared.correct ? '保险箱密码正确。' : '保险箱密码不正确。'
        : `${playerName(state, shared.fromId)}向你展示：${tokenName(shared.token)}`;
      const item = node('li', '', text);
      item.dataset.testid = shared.kind === 'safe_result' ? 'safe-result' : 'shared-token';
      list.append(item);
    }
    section.append(list);
    container.append(section);
  }
  for (const offer of round.exchangeOffers || []) {
    const section = node('section', 'exchange-offer exploration-section');
    section.dataset.testid = 'exchange-offer';
    section.dataset.offerId = offer.id;
    const fromId = offer.fromId || offer.playerId;
    const mine = fromId === state.you;
    section.append(node('h3', '', mine ? '等待对方确认赠送' : `${playerName(state, fromId)}提出交换`));
    const offered = offer.giveTokens || offer.tokens || [];
    const items = offer.giveItems || offer.items || [];
    const names = [...offered.map(tokenName), ...items.map(item => item.name)];
    section.append(node('p', 'small-note', names.length ? names.join('、') : `盖放标志 ${(offer.giveTokenIds || []).length} 枚 · 道具 ${(offer.giveItemIds || []).length} 张`));
    const requestedNames = [
      ...(offer.requestTokenIds || []).map(id => !mine ? tokenName(round.inventory?.tokens?.find(token => token.id === id)) : `标志 ${id}`),
      ...(offer.requestItemIds || []).map(id => !mine ? round.inventory?.items?.find(item => item.id === id)?.name || '请求的道具' : `道具 ${id}`),
    ];
    if (requestedNames.length) section.append(node('p', 'small-note', `${mine ? '希望对方交出' : '需要交出'}：${requestedNames.join('、')}`));
    if (!mine && !round.result) {
      const actions = node('div', 'decision-actions');
      const blocked = locked || Boolean(round.resolution || round.pendingAction || round.interruption) || !['visitor_reveal', 'visitor_action'].includes(round.phase);
      actions.append(button('接受', 'exchange-accept', blocked, () => action('respond_exchange', { offerId: offer.id, accept: true })), button('拒绝', 'exchange-reject', blocked, () => action('respond_exchange', { offerId: offer.id, accept: false }), true));
      section.append(actions);
    }
    container.append(section);
  }
}

function surrenderControls(container, state, locked, action) {
  const round = state.round;
  if (round.result || !round.visitors.some(visitor => visitor.id === state.you && visitor.status === 'alive')) return;
  const votes = round.surrenderVotes || [];
  const mine = votes.includes(state.you);
  const details = node('details', 'free-actions');
  details.append(node('summary', '', '访问者投降'));
  details.append(node('p', 'small-note', `全部存活访问者同意后，箱娃获胜。已同意 ${votes.length} / ${round.visitors.filter(visitor => visitor.status === 'alive').length} 人。`));
  if (votes.length) details.append(node('p', 'small-note', votes.map(id => playerName(state, id)).join('、')));
  const controls = node('div', 'practice-controls free-action-controls');
  controls.append(button(mine ? '撤回投降' : '同意投降', mine ? 'withdraw-surrender' : 'surrender', locked || Boolean(round.resolution || round.pendingAction || round.interruption), () => action('surrender', { agree: !mine }), true));
  details.append(controls);
  container.append(details);
}

function noiseControls(container, state, locked, action, silentCards) {
  const round = state.round;
  const silent = round.silent;
  const effects = round.noiseEffects || {};
  const mine = round.phase === 'visitor_reveal' && silent.turnPlayerId === state.you;
  const turnKey = `${state.code || ''}:${silent.cycle}:${silent.turnPlayerId}:${round.phase}:${silent.cards.map(card => card.status).join(',')}`;
  if (turnKey !== bellChoiceTurn) selections.delete('silent-use-bell');
  bellChoiceTurn = turnKey;
  let useBell;
  const section = silentCards(state, locked, (type, payload) => action(type, type === 'silent_reveal' && useBell?.checked ? { ...payload, useBell: true } : payload));
  if (mine && effects.canChooseBell && !(silent.revealsRemaining > 0)) {
    const choice = node('div', 'practice-controls');
    useBell = checkbox(choice, 'silent-use-bell', '额外翻一张，随后可用标准行动摇铃', locked);
    section.insertBefore(choice, section.querySelector('.silent-cards'));
  }
  if (silent.revealsRemaining > 0) {
    for (const skip of section.querySelectorAll('.silent-skip')) {
      skip.disabled = true;
      skip.title = '连续翻牌尚未完成，不能持牌跳过。';
    }
  }
  if (effects.maryPlayerId) section.append(node('p', 'small-note', `玛丽小姐：${playerName(state, effects.maryPlayerId)}受诅咒，行动前需翻两张无声标志（保留最后一张盖牌），不能交换或丢弃人偶。`));
  if (effects.canUseBell) section.append(node('p', 'small-note', '额外翻牌已完成，可以消耗标准行动摇铃，也可选择其他行动。'));
  if (effects.bellUserId) section.append(node('p', 'small-note', `${playerName(state, effects.bellUserId)}已摇铃：${round.phase === 'hako_phase' ? '本次' : '下一次'}箱娃阶段禁止设置危险度B或C的能力。`));
  container.append(section);
}

export function renderExploration({ panel, state, pending, online, action, silentCards, inspectedRoomTokens, renderRoomMemory }) {
  const round = state.round;
  const locked = pending || !online || Boolean(round.result);
  panel.dataset.phase = round.phase;
  panel.setAttribute('aria-label', '探索回合操作');
  const fragment = document.createDocumentFragment();
  if (round.result) gameResult(fragment, state);
  else fragment.append(node('h2', '', '旧宅探索'));
  fragment.append(node('p', 'practice-scope small-note', '已接入目前所有确认规则。NO.12按无声模式规则移出游戏。'));
  if (state.initialPower) {
    const power = node('p', 'initial-power-public', `初始箱娃之力：${state.initialPower.name}`);
    power.dataset.testid = 'initial-power';
    fragment.append(power);
  }
  const status = node('p', 'practice-status', explorationDescription(state));
  status.setAttribute('role', 'status');
  fragment.append(status);
  if (state.initialItems?.length) {
    const initial = node('details', 'initial-items');
    initial.append(node('summary', '', '开局领取的道具'));
    const list = node('dl', 'round-positions');
    for (const item of state.initialItems) {
      const row = node('div');
      row.dataset.testid = 'initial-item';
      row.dataset.playerId = item.playerId;
      row.dataset.itemId = item.itemId;
      row.append(node('dt', '', playerName(state, item.playerId)), node('dd', '', item.itemName));
      list.append(row);
    }
    initial.append(list, node('p', 'small-note', '这是开局领取记录；你当前持有的物品见下方随身物品。'));
    fragment.append(initial);
  }
  const positions = node('dl', 'round-positions');
  for (const visitor of round.visitors) {
    const line = node('div');
    line.dataset.testid = 'visitor-location';
    line.dataset.playerId = visitor.id;
    if (visitor.status === 'alive' && visitor.roomId) line.dataset.roomId = visitor.roomId;
    line.append(node('dt', '', `${playerName(state, visitor.id)}${visitor.id === state.you ? '（你）' : ''}`), node('dd', '', visitor.status === 'box_person' ? '箱人' : visitor.status === 'banished' ? '已被消灭' : roomName(visitor.roomId)));
    positions.append(line);
  }
  fragment.append(positions);
  if (round.hako.playerId === state.you && round.hako.cornerId) {
    const location = node('p', 'hako-location', `你的潜伏位置：${cornerName(round.hako.cornerId)}`);
    location.dataset.testid = 'hako-location';
    fragment.append(location);
  }
  if (round.ghost?.cornerId && round.ghost.status !== 'banished') {
    const location = node('p', 'hako-location', `你的箱人潜伏位置：${cornerName(round.ghost.cornerId)}`);
    location.dataset.testid = 'ghost-location';
    fragment.append(location);
  }
  const controls = node('div', 'practice-controls');
  controls.dataset.testid = 'practice-controls';
  if (!round.result) {
    resolutionControls(controls, state, locked, action);
    visitorControls(controls, state, locked, action);
    pendingControls(controls, state, locked, action);
    if (round.phase === 'hako_reaction' && round.hako.playerId === state.you) controls.append(button('结束反应，进入箱娃阶段', 'pass-noise-reaction', locked || Boolean(round.interruption), () => action('pass_noise_reaction')));
    hidingControls(controls, state, locked, action, inspectedRoomTokens);
    renderAbilities({ container: controls, state, locked, action });
    renderActiveItems({ container: controls, state, locked, action });
  }
  fragment.append(controls);
  const actor = round.hako.playerId === state.you ? round.hako : round.ghost;
  if (actor && (!actor.inspectedRoom || actor.finished || round.interruption || round.resolution || round.powers?.rearrangement)) {
    renderRoomMemory(fragment, actor.lastInspectedRoom);
  }
  if (round.silent) noiseControls(fragment, state, locked, action, silentCards);
  inventory(fragment, state, locked, action);
  exchanges(fragment, state, locked, action);
  publicProgress(fragment, state);
  surrenderControls(fragment, state, locked, action);
  panel.replaceChildren(fragment);
}
