import { getLogicalRooms } from '/shared/maps.mjs';
import { cornerName } from './tile.js';
import { cardName } from './abilities.js';
import { renderExploration, explorationDescription, explorationSeatStatus } from './exploration.js';
import { draftScope } from './view-state.js';

const rooms = getLogicalRooms();
const roomName = id => rooms.find(room => room.id === id)?.name || '正门';
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
let selectedCorner = '';
let holdModeScope = '';
let chosenPassword = [];
let selectedWeakness = '';
let selectedRoom = '';
let selectedPower = '';
let selectionScope = '';
const choiceSelections = new Map();
const preparationSteps = [
  ['secrets', '密码与弱点'], ['remains', '放置亡骸'], ['hiding_room', '选择怨房'],
  ['hiding_corner', '初始潜伏'], ['power', '初始能力'],
];
const tokenNames = {
  safe: '转轮式保险箱', notebook: '手记', password: '密码', weakness_clue: '讨伐情况',
  weapon: '讨伐道具', doll: '玛丽小姐的人偶', hidden_exit: '隐藏出口', amulet: '古怪护符',
  extinguisher: '灭火器', remains: '亡骸', hako: '箱娃', box_person: '箱人', empty_box: '空箱', key: '钥匙',
};
const toolNames = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };

function resetSelectionScope(state) {
  const scope = draftScope(state);
  if (scope === selectionScope) return;
  selectedCorner = selectedWeakness = selectedRoom = selectedPower = '';
  chosenPassword = [];
  choiceSelections.clear();
  selectionScope = scope;
}

function playerName(state, id) {
  return state.players.find(player => player.id === id)?.name || '访问者';
}

export function roundDescription(state) {
  const round = state.round;
  if (!round) return '';
  if (round.mode === 'exploration') return explorationDescription(state);
  const isHako = round.hako.playerId === state.you;
  const mine = round.silent?.turnPlayerId === state.you;
  const turnName = playerName(state, round.silent?.turnPlayerId);
  switch (round.phase) {
    case 'visitor_reveal': return mine ? '轮到你了。翻开一枚无声标志，或持牌跳过本回合。' : `等待${turnName}翻开无声标志或持牌跳过。`;
    case 'visitor_action': return mine ? '选择门或楼梯相连的房间，声明你的移动。' : `等待${turnName}选择要移动的房间。`;
    case 'visitor_reaction': return isHako ? '访问者已声明移动。确认后，访问者才会到达目标房间。' : '移动已经声明，等待箱娃确认结算。';
    case 'hako_reaction': return isHako ? '累计数字已超过10。确认杂音反应窗口结束，进入箱娃阶段。' : '累计数字已超过10，等待箱娃结束杂音反应窗口。';
    case 'hako_phase': return isHako
      ? round.hako.inspectedRoom ? '已查看目标房间。选择其中一个角落潜伏，结束箱娃阶段。'
        : round.hako.hidingRooms?.length ? '先选择潜伏房间，再选择相应的角落。' : '选择当前或相邻房间的合法角落潜伏。'
      : '箱娃正在暗处行动。潜伏结束后，新一轮无声标志将重新洗混。';
    default: return '等待下一步行动。';
  }
}

function button(label, testid, disabled, onClick, secondary = false) {
  const result = node('button', `button ${secondary ? 'secondary' : 'primary'}`, label);
  result.type = 'button';
  result.dataset.testid = testid;
  result.disabled = disabled;
  if (['item-choice', 'confirm-secrets', 'confirm-remains', 'inspect-initial-room', 'confirm-initial-hiding', 'confirm-initial-power', 'confirm-hiding', 'inspect-hiding-room', 'pass-noise-reaction', 'resolve-action'].includes(testid)) result.classList.add('step-submit');
  result.addEventListener('click', onClick);
  return result;
}

function requireSelections(element, locked, ...inputs) {
  const update = () => { element.disabled = locked || inputs.some(input => !input.value); };
  for (const input of inputs) input.addEventListener('change', update);
  update();
  return element;
}

function hidingControls(container, targets, initial, locked, action, inspectedRoom) {
  const selectId = initial ? 'initial-hiding-select' : 'hiding-select';
  const label = node('label', '', initial ? '初始潜伏角落' : '本次潜伏角落');
  label.htmlFor = selectId;
  const select = node('select');
  select.id = selectId;
  select.dataset.testid = selectId;
  select.disabled = locked;
  for (const id of targets) {
    const corner = inspectedRoom?.corners.find(corner => corner.id === id);
    const option = node('option', '', `${cornerName(id)}${corner?.token !== undefined ? ` — ${tokenDescription(corner.token)}` : ''}`);
    option.value = id;
    select.append(option);
  }
  const remembered = choiceSelections.get(selectId);
  const stale = remembered !== undefined && !targets.includes(remembered);
  if (stale) {
    const placeholder = node('option', '', '目标已变化，请重新选择');
    placeholder.value = '';
    placeholder.disabled = true;
    select.prepend(placeholder);
  }
  select.value = stale ? '' : remembered ?? targets[0] ?? '';
  choiceSelections.set(selectId, select.value);
  select.dataset.selectionInvalid = String(stale);
  select.addEventListener('change', () => { selectedCorner = select.value; choiceSelections.set(selectId, select.value); select.dataset.selectionInvalid = 'false'; });
  container.append(label, select, requireSelections(button(initial ? '确认初始潜伏' : '潜伏并结束阶段', initial ? 'confirm-initial-hiding' : 'confirm-hiding', locked,
    () => action(initial ? 'choose_initial_hiding' : 'hako_hide', { cornerId: select.value })), locked, select));
}

function silentCards(state, locked, action) {
  const round = state.round;
  const silent = round.silent;
  const section = node('section', 'silent-section');
  const heading = node('div', 'silent-heading');
  const total = node('p', '', `第 ${silent.cycle} 轮 · 累计 ${silent.total} / 10`);
  total.dataset.testid = 'silent-total';
  heading.append(node('h3', '', '无声标志'), total);
  section.append(heading);
  const mine = round.phase === 'visitor_reveal' && silent.turnPlayerId === state.you;
  const zeroRevealed = silent.cards.some(card => card.status === 'up' && card.number === 0);
  const ghostCall = round.powers?.ghostCall?.active === true;
  const canHold = mine && !zeroRevealed && !ghostCall && !(silent.revealsRemaining > 0);
  const scope = draftScope(state) + ':' + silent.cards.map(card => card.status).join(',');
  if (holdModeScope !== scope || !canHold) holdModeScope = '';
  const grid = node('div', 'silent-cards');
  for (const card of silent.cards) {
    const cell = node('div', `silent-card-cell ${card.status}`);
    const revealed = card.status === 'up';
    const held = card.status === 'held';
    const cardLabel = revealed ? `第${card.index + 1}枚，数字${card.number}` : held ? `第${card.index + 1}枚，${playerName(state, card.holderId)}持有` : `翻开第${card.index + 1}枚无声标志`;
    const face = node(mine && !revealed && !held ? 'button' : 'div', 'silent-card-face');
    face.dataset.testid = `silent-card-${card.index}`;
    face.setAttribute('aria-label', cardLabel);
    if (face.tagName === 'BUTTON') {
      face.type = 'button';
      face.disabled = locked;
      face.addEventListener('click', () => action(holdModeScope === scope ? 'silent_skip' : 'silent_reveal', { index: card.index }));
    } else face.setAttribute('role', 'img');
    face.append(node('span', 'silent-card-value', revealed ? String(card.number) : held ? '持' : '无声'));
    face.append(node('span', 'silent-card-caption', held ? playerName(state, card.holderId) : revealed ? '已翻开' : `第 ${card.index + 1} 枚`));
    cell.append(face);
    grid.append(cell);
  }
  section.append(grid, node('p', 'small-note', ghostCall ? '移动受限，不能持牌跳过。照常翻牌；无路可走时自动结束本次行动，等待解封。' : zeroRevealed ? '数字0已翻开，本轮不能持牌跳过。累计恰好10时仍可行动。' : '盖放和持有的数字保持隐藏。累计大于10，或只余一枚盖放时，触发箱娃阶段。'));
  if (mine) {
    const toggle = button('持牌跳过', 'silent-hold-mode', locked || !canHold, () => {
      holdModeScope = holdModeScope === scope ? '' : scope;
      paintMode();
    }, true);
    const instruction = node('p', 'small-note', '选一枚盖牌，持牌并跳过本回合。');
    instruction.setAttribute('role', 'status');
    function paintMode() {
      const holding = holdModeScope === scope;
      toggle.textContent = holding ? '取消选牌' : '持牌跳过';
      toggle.setAttribute('aria-pressed', String(holding));
      instruction.hidden = !holding;
      for (const face of grid.querySelectorAll('button')) {
        const index = Number(face.dataset.testid.split('-').at(-1)) + 1;
        face.setAttribute('aria-label', (holding ? '持有' : '翻开') + '第' + index + '枚无声标志');
        face.querySelector('.silent-card-caption').textContent = (holding ? '持有第 ' : '第 ') + index + ' 枚';
      }
    }
    section.append(toggle, instruction);
    section.addEventListener('keydown', event => {
      if (event.key === 'Escape' && holdModeScope === scope) {
        event.preventDefault();
        holdModeScope = '';
        paintMode();
        toggle.focus();
      }
    });
    paintMode();
  }
  return section;
}

function renderPractice({ personal, shared, state, pending, online, action }) {
  const panel = document.getElementById('practice-panel');
  const round = state.round;
  if (!round) { panel.replaceChildren(); panel.hidden = true; return; }
  if (round.mode === 'exploration') {
    renderExploration({ panel, personal, shared, state, pending, online, action, silentCards, inspectedRoomTokens, renderRoomMemory });
    return;
  }

  panel.dataset.phase = round.phase;
  const locked = pending || !online;
  const isHako = round.hako.playerId === state.you;
  const controls = node('div', 'practice-controls');
  controls.dataset.testid = 'practice-controls';
  if (isHako && round.hako.cornerId) {
    const location = node('p', 'hako-location self-position', `你的潜伏位置：${cornerName(round.hako.cornerId)}`);
    location.dataset.testid = 'hako-location';
    personal.append(location);
    renderRoomMemory(personal, round.hako.lastInspectedRoom);
  }
  if (round.phase === 'visitor_action' && round.silent.turnPlayerId === state.you) {
    controls.append(node('h3', '', '移动到相邻房间'));
    for (const id of round.moveTargets) {
      const target = button(`移动到${roomName(id)}`, 'move-target', locked, () => action('move', { roomId: id }), true);
      target.dataset.roomId = id;
      controls.append(target);
    }
  }
  if (round.pendingAction && isHako) {
    const move = round.pendingAction;
    const response = node('section', 'current-response');
    response.append(node('h3', '', '请确认访问者的移动'), node('p', 'pending-move', `${playerName(state, move.playerId)}：${roomName(move.fromRoomId)} → ${roomName(move.toRoomId)}`),
      button('确认移动结算', 'resolve-action', locked, () => action('resolve_visitor_action')));
    controls.append(response);
  }
  if (round.phase === 'hako_reaction' && isHako) controls.append(button('结束反应，进入箱娃阶段', 'pass-noise-reaction', locked, () => action('pass_noise_reaction')));
  if (round.phase === 'hako_phase' && isHako) {
    if (round.hako.inspectedRoom || !round.hako.hidingRooms?.length) {
      if (round.hako.inspectedRoom) inspectedRoomTokens(controls, round.hako.inspectedRoom);
      hidingControls(controls, round.hako.hidingTargets || [], false, locked, action, round.hako.inspectedRoom);
    } else {
      const select = choiceSelect(controls, {
        id: 'hiding-room-select', label: '选择潜伏房间，查看角落', options: round.hako.hidingRooms,
        selected: selectedRoom, locked, onChange: value => { selectedRoom = value; },
      });
      controls.append(requireSelections(button('查看这间房间', 'inspect-hiding-room', locked, () => action('inspect_hiding_room', { roomId: select.value })), locked, select));
    }
  }
  if (round.silent) {
    const myReveal = round.phase === 'visitor_reveal' && round.silent.turnPlayerId === state.you;
    (myReveal ? controls : shared).append(silentCards(state, locked, action));
  }
  panel.replaceChildren(controls);
  panel.hidden = !controls.childElementCount;
}

export function roundSeatStatus(state, player) {
  const round = state.round;
  if (!round) return null;
  if (round.mode === 'exploration') return explorationSeatStatus(state, player);
  if (player.id === round.hako.playerId) return round.phase === 'hako_phase' ? '潜伏中' : ['visitor_reaction', 'hako_reaction'].includes(round.phase) ? '等待确认' : '潜伏';
  if (round.silent.turnPlayerId === player.id) return round.phase === 'visitor_reveal' ? '翻牌中' : round.phase === 'visitor_reaction' ? '等待结算' : '行动中';
  return roomName(round.visitors.find(visitor => visitor.id === player.id)?.roomId);
}

export function preparationDescription(state) {
  if (state.draft) return '正在完成随机发牌，随后由访问者轮流拼图。';
  if (state.opening) {
    const name = preparationSteps.find(([phase]) => phase === state.opening.phase)?.[1] || '开局配置';
    if (state.opening.phase === 'power') return state.opening.hakoId === state.you ? '从三张候选中秘密选择初始能力；NO.4可被抽到，但不能选择。' : '箱娃正在秘密选择初始能力。';
    return state.opening.hakoId === state.you ? `箱娃准备：${name}。选择内容仅你可见。` : `箱娃正在完成${name}。访问者在正门等待入场。`;
  }
  return '';
}

function dealtSkill(choice, own) {
  const name = choice.itemName || choice.name || '技能牌背';
  if (!choice.itemDescription) return node('span', '', name);
  const details = node('details', own ? 'inventory-item reference-details' : 'draft-chosen-item reference-details');
  details.id = own ? 'own-opening-skill' : `opening-skill-${choice.playerId}`;
  details.dataset.itemId = choice.itemId;
  if (own) details.dataset.testid = 'inventory-item';
  details.append(node('summary', '', `${name} · 查看效果`), node('p', 'item-description', choice.itemDescription));
  return details;
}

function renderDeal(personal, shared, state) {
  const choices = state.initialItems?.length ? state.initialItems : state.draft?.choices || state.opening?.itemChoices || [];
  if (!choices.length) return;
  const own = choices.find(choice => choice.playerId === state.you);
  if (own && state.round?.mode !== 'exploration') {
    const inventory = node('section', 'exploration-section personal-inventory');
    inventory.id = 'personal-inventory';
    inventory.append(node('h3', '', '我的开局技能'), dealtSkill(own, true));
    personal.append(inventory);
  }

  const section = node('section', 'initial-deal-panel');
  section.id = 'draft-panel';
  const details = node('details', 'initial-items reference-details');
  details.id = 'initial-deal-record';
  details.append(node('summary', '', '开局随机技能 · 发牌记录'), node('p', 'small-note', '以下是开局发牌时的记录。当前持有的物品可在「我的」查看。'));
  const list = node('ul', 'inventory-list');
  for (const choice of choices) {
    const line = node('li');
    line.dataset.testid = state.round ? 'initial-item' : 'initial-dealt-item';
    line.dataset.playerId = choice.playerId;
    line.dataset.itemId = choice.itemId;
    line.append(node('span', '', `${playerName(state, choice.playerId)}${choice.playerId === state.you ? '（你）' : ''}`), dealtSkill(choice, false));
    list.append(line);
  }
  details.append(list);
  section.append(details);
  shared.append(section);
}

export function renderGamePanels({ state, pending, online, action }) {
  resetSelectionScope(state);
  const personal = document.createDocumentFragment();
  const shared = document.createDocumentFragment();
  const context = { personal, shared, state, pending, online, action };
  renderOpening(context);
  renderPractice(context);
  renderDeal(personal, shared, state);
  const initialPower = state.initialPower || (state.opening?.initialPowerName && state.opening.hakoId === state.you
    ? { id: state.opening.initialPowerId, name: state.opening.initialPowerName } : null);
  if (initialPower) {
    const power = node('p', 'small-note', `你的初始箱娃之力：${cardName(initialPower)}`);
    power.dataset.testid = 'initial-power';
    personal.append(power);
  }
  if (!personal.childElementCount) personal.append(node('p', 'small-note', '暂时没有个人物品或私密记录。'));
  document.getElementById('inventory-content').replaceChildren(personal);
  document.getElementById('public-content').replaceChildren(shared);
}

function choiceSelect(container, { id, label, options, selected, locked, onChange }) {
  const caption = node('label', '', label);
  caption.htmlFor = id;
  const select = node('select');
  select.id = id;
  select.dataset.testid = id;
  select.disabled = locked;
  for (const choice of options) {
    const option = node('option', '', choice.name);
    option.value = choice.id;
    option.disabled = choice.disabled === true;
    select.append(option);
  }
  const remembered = choiceSelections.has(id) ? choiceSelections.get(id) : selected || undefined;
  const stale = remembered !== undefined && !options.some(option => !option.disabled && String(option.id) === String(remembered));
  if (stale) {
    const placeholder = node('option', '', '目标已变化，请重新选择');
    placeholder.value = '';
    placeholder.disabled = true;
    select.prepend(placeholder);
  }
  select.value = stale ? '' : remembered ?? String(options.find(option => !option.disabled)?.id ?? '');
  select.dataset.selectionInvalid = String(stale);
  choiceSelections.set(id, select.value);
  select.addEventListener('change', () => { onChange(select.value); choiceSelections.set(id, select.value); select.dataset.selectionInvalid = 'false'; });
  onChange(select.value);
  container.append(caption, select);
  return select;
}

function secretControls(container, opening, locked, action) {
  const fieldset = node('fieldset', 'password-options');
  fieldset.append(node('legend', '', '保险箱密码（选择三个数字）'));
  chosenPassword = chosenPassword.filter(value => opening.passwordOptions.includes(value));
  const choices = node('div', 'password-choices');
  const checkboxes = [];
  for (const value of opening.passwordOptions) {
    const label = node('label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.id = `opening-password-${value}`;
    checkbox.value = value;
    checkbox.dataset.testid = 'password-choice';
    checkbox.checked = chosenPassword.includes(value);
    checkboxes.push(checkbox);
    label.append(checkbox, node('span', '', String(value)));
    choices.append(label);
  }
  fieldset.append(choices);
  container.append(fieldset);
  const weakness = choiceSelect(container, {
    id: 'weakness-select', label: '箱娃的弱点', options: opening.weaknessOptions,
    selected: selectedWeakness, locked, onChange: value => { selectedWeakness = value; },
  });
  const confirm = button('确认密码与弱点', 'confirm-secrets', locked || chosenPassword.length !== 3,
    () => action('choose_secrets', { password: [...chosenPassword].sort((a, b) => a - b), weakness: opening.weaknessOptions.find(option => String(option.id) === weakness.value)?.id }));
  const count = node('p', 'small-note');
  const update = () => {
    for (const input of checkboxes) input.disabled = locked || !input.checked && chosenPassword.length === 3;
    confirm.disabled = locked || chosenPassword.length !== 3 || !weakness.value;
    count.textContent = `已选择 ${chosenPassword.length} / 3 个数字。密码与弱点仅箱娃可见。`;
  };
  for (const input of checkboxes) input.addEventListener('change', () => {
    chosenPassword = checkboxes.filter(checkbox => checkbox.checked).map(checkbox => Number(checkbox.value));
    update();
  });
  weakness.addEventListener('change', update);
  update();
  container.append(count, confirm);
}

function tokenDescription(token) {
  if (!token) return '无标志';
  const parts = [tokenNames[token.type] || '角落标志'];
  if (token.number !== undefined) parts.push(`数字${token.number}`);
  if (token.tool) parts.push(`${toolNames[token.tool] || token.tool}${token.type === 'weakness_clue' ? '无效' : ''}`);
  return parts.join(' · ');
}

function inspectedRoomTokens(container, inspectedRoom) {
  container.append(node('h3', '', `${roomName(inspectedRoom.id)} · 潜伏角落`),
    node('p', 'small-note', '确认潜伏后，仅查看被替换的棋子。'));
  const tokens = node('dl', 'inspected-tokens');
  for (const corner of inspectedRoom.corners) {
    const row = node('div');
    row.dataset.cornerId = corner.id;
    row.append(node('dt', '', cornerName(corner.id)), node('dd', '', corner.token === undefined ? '盖放标志（潜伏后查看）' : tokenDescription(corner.token)));
    tokens.append(row);
  }
  container.append(tokens);
}

export function renderRoomMemory(container, memory) {
  if (!memory) return;
  const section = node('section', 'exploration-section private-memory');
  section.dataset.testid = 'hiding-room-memory';
  const when = memory.cycle === 0 ? '开局' : `第${memory.cycle}轮`;
  section.append(node('h3', '', `被替换棋子记录 · ${roomName(memory.id)}（仅你可见）`),
    node('p', 'small-note', `${when}查看时的记录，之后的取放变化不会自动更新。`));
  const list = node('dl', 'inspected-tokens');
  for (const corner of memory.corners) {
    const row = node('div');
    row.dataset.cornerId = corner.id;
    row.append(node('dt', '', cornerName(corner.id)), node('dd', '', tokenDescription(corner.token)));
    list.append(row);
  }
  section.append(list);
  container.append(section);
}

function renderOpening({ personal, shared, state, pending, online, action }) {
  const panel = document.getElementById('opening-panel');
  const opening = state.opening;
  panel.hidden = !opening;
  if (!opening) { panel.replaceChildren(); chosenPassword = []; return; }
  panel.dataset.phase = opening.phase;
  const locked = pending || !online;
  const isHako = opening.hakoId === state.you;
  const fragment = document.createDocumentFragment();
  const progress = node('ol', 'opening-progress');
  const current = preparationSteps.findIndex(([phase]) => phase === opening.phase);
  preparationSteps.forEach(([phase, name], index) => {
    const step = node('li', index === current ? 'current' : index < current ? 'done' : '', name);
    if (phase === opening.phase) step.setAttribute('aria-current', 'step');
    progress.append(step);
  });
  if (isHako) {
    const known = node('dl', 'inspected-tokens');
    for (const [title, value] of [
      ['保险箱密码', opening.password?.join('、')], ['讨伐弱点', toolNames[opening.weakness]],
      ['亡骸位置', opening.remainsCornerId && cornerName(opening.remainsCornerId)],
      ['我的潜伏位置', opening.hidingCornerId && cornerName(opening.hidingCornerId)],
    ]) {
      if (!value) continue;
      const row = node('div');
      row.append(node('dt', '', title), node('dd', '', value));
      known.append(row);
    }
    if (known.childElementCount) {
      const secrets = node('section', 'exploration-section');
      secrets.append(node('h3', '', '我已确认的开局秘密'), known);
      personal.append(secrets);
    }
    renderRoomMemory(personal, opening.lastInspectedRoom);
    const controls = node('div', 'practice-controls opening-controls');
    controls.dataset.testid = 'opening-controls';
    switch (opening.phase) {
      case 'secrets': secretControls(controls, opening, locked, action); break;
      case 'remains': {
        const select = choiceSelect(controls, {
          id: 'remains-select', label: '亡骸放置角落',
          options: opening.remainsTargets.map(id => ({ id, name: cornerName(id) })),
          selected: selectedCorner, locked, onChange: value => { selectedCorner = value; },
        });
        controls.append(requireSelections(button('确认放置亡骸', 'confirm-remains', locked, () => action('place_remains', { cornerId: select.value })), locked, select));
        break;
      }
      case 'hiding_room': {
        const select = choiceSelect(controls, {
          id: 'initial-room-select', label: '选择初始潜伏的怨房', options: opening.hidingRooms,
          selected: selectedRoom, locked, onChange: value => { selectedRoom = value; },
        });
        controls.append(requireSelections(button('选择这间怨房', 'inspect-initial-room', locked, () => action('inspect_initial_room', { roomId: select.value })), locked, select));
        break;
      }
      case 'hiding_corner': {
        if (opening.inspectedRoom) inspectedRoomTokens(controls, opening.inspectedRoom);
        hidingControls(controls, opening.hidingTargets, true, locked, action, opening.inspectedRoom);
        break;
      }
      case 'power': {
        const select = choiceSelect(controls, {
          id: 'initial-power-select', label: '选择初始箱娃之力', options: opening.initialPowerOptions.map(card => ({ ...card,
            name: `${cardName(card)}${card.canChoose === false ? '（不可选作初始能力）' : ''}`, disabled: card.canChoose === false })),
          selected: selectedPower, locked, onChange: value => { selectedPower = value; },
        });
        const description = node('p', 'item-description small-note');
        description.dataset.testid = 'initial-power-description';
        const describe = () => { description.textContent = opening.initialPowerOptions.find(card => String(card.id) === select.value)?.description || ''; };
        select.addEventListener('change', describe);
        describe();
        controls.append(description);
        controls.append(requireSelections(button('确认初始能力，进入宅邸', 'confirm-initial-power', locked, () => action('choose_initial_power', { powerId: Number(select.value) })), locked, select));
        controls.append(node('p', 'small-note', 'NO.4可抽入三张候选但不能选作初始能力，不重抽，留在普通牌库供后续取得。选中的初始能力可绕过手记门槛，仍须在箱娃阶段设置后才能发动。'));
        break;
      }
    }
    fragment.append(controls);
  }
  const occupied = opening.corners.filter(corner => corner.occupied).length;
  const reference = node('section', 'exploration-section opening-status');
  reference.append(node('h3', '', '开局配置进度'), progress,
    node('p', 'small-note', `已配置角落 ${occupied} / ${opening.corners.length}，访问者在正门待入场。`));
  shared.append(reference);
  panel.replaceChildren(fragment);
  panel.hidden = !panel.childElementCount;
}
