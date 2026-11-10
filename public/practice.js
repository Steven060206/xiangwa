import { getLogicalRooms } from '/shared/maps.mjs';
import { cornerName } from './tile.js';
import { cardName } from './abilities.js';
import { renderExploration, explorationDescription, explorationSeatStatus } from './exploration.js';

const rooms = getLogicalRooms();
const roomName = id => rooms.find(room => room.id === id)?.name || '正门';
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
let selectedCorner = '';
let chosenPassword = [];
let selectedWeakness = '';
let selectedRoom = '';
let selectedPower = '';
const itemNames = new Map();
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
    case 'hako_phase': return isHako ? round.hako.inspectedRoom ? '已查看目标房间。选择其中一个角落潜伏，结束箱娃阶段。' : '先选择当前或相邻房间，查看全部角落标志，再选择潜伏角落。' : '箱娃正在暗处行动。潜伏结束后，新一轮无声标志将重新洗混。';
    default: return '等待下一步行动。';
  }
}

function button(label, testid, disabled, onClick, secondary = false) {
  const result = node('button', `button ${secondary ? 'secondary' : 'primary'}`, label);
  result.type = 'button';
  result.dataset.testid = testid;
  result.disabled = disabled;
  result.addEventListener('click', onClick);
  return result;
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
  if (!targets.includes(selectedCorner)) selectedCorner = targets[0] || '';
  select.value = selectedCorner;
  select.addEventListener('change', () => { selectedCorner = select.value; });
  container.append(label, select, button(initial ? '确认初始潜伏' : '潜伏并结束阶段', initial ? 'confirm-initial-hiding' : 'confirm-hiding', locked || !targets.length,
    () => action(initial ? 'choose_initial_hiding' : 'hako_hide', { cornerId: select.value })));
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
  const ghostCall = round.powers?.ghostCall.active === true;
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
      face.addEventListener('click', () => action('silent_reveal', { index: card.index }));
    } else face.setAttribute('role', 'img');
    face.append(node('span', 'silent-card-value', revealed ? String(card.number) : held ? '持' : '无声'));
    face.append(node('span', 'silent-card-caption', held ? playerName(state, card.holderId) : revealed ? '已翻开' : `第 ${card.index + 1} 枚`));
    cell.append(face);
    if (mine && !revealed && !held) {
      const skip = button('持牌跳过', `skip-card-${card.index}`, locked || zeroRevealed || ghostCall, () => action('silent_skip', { index: card.index }), true);
      skip.classList.add('silent-skip');
      if (zeroRevealed) skip.title = '数字0已翻开，本轮不能跳过。';
      if (ghostCall) skip.title = '移动受限，必须翻牌并沿最短路线前往客厅。';
      cell.append(skip);
    }
    grid.append(cell);
  }
  section.append(grid, node('p', 'small-note', ghostCall ? '移动受限，不能持牌跳过。照常翻牌；无路可走时自动结束本次行动，等待解封。' : zeroRevealed ? '数字0已翻开，本轮不能持牌跳过。累计恰好10时仍可行动。' : '盖放和持有的数字保持隐藏。累计大于10，或只余一枚盖放时，触发箱娃阶段。'));
  return section;
}

export function renderPractice({ state, pending, online, action }) {
  const panel = document.getElementById('practice-panel');
  const round = state.round;
  panel.hidden = !round;
  if (!round) { panel.replaceChildren(); return; }
  if (round.mode === 'exploration') {
    renderExploration({ panel, state, pending, online, action, silentCards, inspectedRoomTokens, renderRoomMemory });
    return;
  }
  panel.dataset.phase = round.phase;
  const locked = pending || !online;
  const isHako = round.hako.playerId === state.you;
  const fragment = document.createDocumentFragment();
  fragment.append(node('h2', '', '基础回合'));
  if (state.initialPower) {
    const power = node('p', 'initial-power-public', `初始箱娃之力：${cardName(state.initialPower)}`);
    power.dataset.testid = 'initial-power';
    fragment.append(power);
  }
  const status = node('p', 'practice-status', roundDescription(state));
  status.setAttribute('role', 'status');
  fragment.append(status);
  const references = document.createDocumentFragment();

  if (state.initialItems?.length) {
    references.append(node('h3', '', '初始道具'));
    const items = node('dl', 'round-positions');
    for (const item of state.initialItems) {
      const row = node('div');
      row.dataset.testid = 'initial-item';
      row.dataset.playerId = item.playerId;
      row.dataset.itemId = item.itemId;
      row.append(node('dt', '', playerName(state, item.playerId)), node('dd', '', item.itemName));
      items.append(row);
    }
    references.append(items);
  }
  const positions = node('dl', 'round-positions');
  for (const visitor of round.visitors) {
    const row = node('div');
    row.dataset.testid = 'visitor-location';
    row.dataset.playerId = visitor.id;
    if (visitor.roomId) row.dataset.roomId = visitor.roomId;
    row.append(node('dt', '', `${playerName(state, visitor.id)}${visitor.id === state.you ? '（你）' : ''}`), node('dd', '', roomName(visitor.roomId)));
    positions.append(row);
  }
  references.append(positions);
  if (isHako && round.hako.cornerId) {
    const location = node('p', 'hako-location self-position', `你的潜伏位置：${cornerName(round.hako.cornerId)}`);
    location.dataset.testid = 'hako-location';
    fragment.append(location);
  }

  const controls = node('div', 'practice-controls');
  controls.dataset.testid = 'practice-controls';
  if (round.phase === 'visitor_action' && round.silent.turnPlayerId === state.you) {
    controls.append(node('h3', '', '移动到相邻房间'));
    for (const id of round.moveTargets) {
      const target = button(`移动到${roomName(id)}`, 'move-target', locked, () => action('move', { roomId: id }), true);
      target.dataset.roomId = id;
      controls.append(target);
    }
  }
  if (round.pendingAction) {
    const move = round.pendingAction;
    const response = node('section', 'current-response');
    response.append(node('h3', '', isHako ? '请确认访问者的移动' : '等待箱娃确认移动'), node('p', 'pending-move', `${playerName(state, move.playerId)}：${roomName(move.fromRoomId)} → ${roomName(move.toRoomId)}`));
    if (isHako) response.append(button('确认移动结算', 'resolve-action', locked, () => action('resolve_visitor_action')));
    controls.append(response);
  }
  if (round.phase === 'hako_reaction' && isHako) controls.append(button('结束反应，进入箱娃阶段', 'pass-noise-reaction', locked, () => action('pass_noise_reaction')));
  if (round.phase === 'hako_phase') {
    controls.append(node('p', 'small-note', round.silent.trigger === 'one_hidden' ? '只剩一枚盖放标志，触发箱娃阶段。' : '累计数字超过10，触发箱娃阶段。'));
    if (isHako) {
      if (round.hako.inspectedRoom) {
        inspectedRoomTokens(controls, round.hako.inspectedRoom);
        hidingControls(controls, round.hako.hidingTargets || [], false, locked, action, round.hako.inspectedRoom);
      } else {
        const select = choiceSelect(controls, {
          id: 'hiding-room-select', label: '选择潜伏房间，查看全部角落标志', options: round.hako.hidingRooms || [],
          selected: selectedRoom, locked, onChange: value => { selectedRoom = value; },
        });
        controls.append(button('查看这间房间', 'inspect-hiding-room', locked || !select.value, () => action('inspect_hiding_room', { roomId: select.value })));
      }
    }
  }
  if (round.silent && round.phase === 'visitor_reveal') fragment.append(silentCards(state, locked, action));
  fragment.append(controls);
  if (round.silent && round.phase !== 'visitor_reveal') fragment.append(silentCards(state, locked, action));
  fragment.append(references);
  panel.replaceChildren(fragment);
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
  if (state.draft) return state.draft.turnPlayerId === state.you ? '轮到你领取一张初始道具。选择后，将由下一位访问者继续。' : `等待${playerName(state, state.draft.turnPlayerId)}领取初始道具。`;
  if (state.opening) {
    const name = preparationSteps.find(([phase]) => phase === state.opening.phase)?.[1] || '开局配置';
    if (state.opening.phase === 'power') return state.opening.hakoId === state.you ? '从系统随机抽取的三张箱娃之力中秘密选择一张，可免公开手记门槛。' : '箱娃正在秘密选择初始能力。';
    return state.opening.hakoId === state.you ? `箱娃准备：${name}。选择内容仅你可见。` : `箱娃正在完成${name}。访问者在正门等待入场。`;
  }
  return '';
}

function itemChoiceName(choice) {
  return choice.itemName || choice.name || itemNames.get(choice.itemId) || '已领取道具';
}

export function renderDraft({ state, pending, online, action }) {
  const panel = document.getElementById('draft-panel');
  const draft = state.draft;
  panel.hidden = !draft;
  if (!draft) { panel.replaceChildren(); return; }
  const mine = draft.turnPlayerId === state.you;
  const locked = pending || !online;
  for (const item of draft.availableItems) itemNames.set(item.id, item.name);
  const fragment = document.createDocumentFragment();
  fragment.append(node('h2', '', '领取初始道具'), node('p', 'draft-description', preparationDescription(state)));
  const choices = node('ol', 'draft-choices');
  for (const player of state.players.filter(player => player.role === 'visitor')) {
    const choice = draft.choices.find(item => item.playerId === player.id);
    const line = node('li');
    line.append(node('span', '', `${player.name}${player.id === state.you ? '（你）' : ''}`));
    if (choice?.itemDescription) {
      const detail = node('details', 'draft-chosen-item reference-details');
      detail.dataset.itemId = choice.itemId;
      detail.append(node('summary', '', `${itemChoiceName(choice)} · 查看效果`), node('p', 'item-description', choice.itemDescription));
      line.append(detail);
    } else {
      line.append(node('span', '', choice ? itemChoiceName(choice) : draft.turnPlayerId === player.id ? '正在选择' : '等待领取'));
    }
    choices.append(line);
  }
  const items = node('ul', 'item-list');
  for (const item of draft.availableItems) {
    const line = node('li');
    line.dataset.itemId = item.id;
    const copy = node('div', 'item-copy');
    const description = node('p', 'item-description', `效果：${item.description}`);
    description.dataset.testid = 'item-choice-description';
    copy.append(node('h3', '', item.name), description);
    line.append(copy);
    if (mine) {
      const choose = button('领取', 'item-choice', locked, () => action('choose_item', { itemId: item.id }), true);
      choose.dataset.itemId = item.id;
      choose.setAttribute('aria-label', `领取${item.name}`);
      line.append(choose);
    }
    items.append(line);
  }
  if (mine) fragment.append(items, node('h3', '', '各位访问者的领取进度'), choices);
  else fragment.append(choices, node('h3', '', '待选道具与效果'), items);
  fragment.append(node('p', 'small-note', `${state.players.filter(player => player.role === 'visitor').length === 4 ? '四名' : '三名'}访问者领完道具后，开始轮流抽板拼图。`));
  panel.replaceChildren(fragment);
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
  select.value = options.some(option => !option.disabled && String(option.id) === String(selected)) ? String(selected)
    : String(options.find(option => !option.disabled)?.id ?? '');
  select.addEventListener('change', () => onChange(select.value));
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

export function renderOpening({ state, pending, online, action }) {
  const panel = document.getElementById('opening-panel');
  const opening = state.opening;
  panel.hidden = !opening;
  if (!opening) { panel.replaceChildren(); chosenPassword = []; return; }
  panel.dataset.phase = opening.phase;
  const locked = pending || !online;
  const isHako = opening.hakoId === state.you;
  const fragment = document.createDocumentFragment();
  fragment.append(node('h2', '', '开局准备'));
  if (opening.initialPowerName) fragment.append(node('p', 'initial-power-public', `初始箱娃之力：${cardName({ id: opening.initialPowerId, name: opening.initialPowerName })}`));
  const progress = node('ol', 'opening-progress');
  const current = preparationSteps.findIndex(([phase]) => phase === opening.phase);
  preparationSteps.forEach(([phase, name], index) => {
    const step = node('li', index === current ? 'current' : index < current ? 'done' : '', name);
    if (phase === opening.phase) step.setAttribute('aria-current', 'step');
    progress.append(step);
  });
  fragment.append(node('p', 'practice-status', preparationDescription(state)));
  if (isHako) {
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
        controls.append(button('确认放置亡骸', 'confirm-remains', locked || !select.value, () => action('place_remains', { cornerId: select.value })));
        break;
      }
      case 'hiding_room': {
        const select = choiceSelect(controls, {
          id: 'initial-room-select', label: '选择初始潜伏的怨房', options: opening.hidingRooms,
          selected: selectedRoom, locked, onChange: value => { selectedRoom = value; },
        });
        controls.append(button('选择这间怨房', 'inspect-initial-room', locked || !select.value, () => action('inspect_initial_room', { roomId: select.value })));
        break;
      }
      case 'hiding_corner': {
        if (opening.inspectedRoom) inspectedRoomTokens(controls, opening.inspectedRoom);
        hidingControls(controls, opening.hidingTargets, true, locked, action, opening.inspectedRoom);
        break;
      }
      case 'power': {
        const select = choiceSelect(controls, {
          id: 'initial-power-select', label: '选择初始箱娃之力', options: opening.initialPowerOptions.map(card => ({ ...card, name: cardName(card) })),
          selected: selectedPower, locked, onChange: value => { selectedPower = value; },
        });
        const description = node('p', 'item-description small-note');
        description.dataset.testid = 'initial-power-description';
        const describe = () => { description.textContent = opening.initialPowerOptions.find(card => String(card.id) === select.value)?.description || ''; };
        select.addEventListener('change', describe);
        describe();
        controls.append(description);
        controls.append(button('确认初始能力，进入宅邸', 'confirm-initial-power', locked || !select.value, () => action('choose_initial_power', { powerId: Number(select.value) })));
        controls.append(node('p', 'small-note', '初始能力可绕过手记门槛，仍须在箱娃阶段设置后才能发动。'));
        renderRoomMemory(controls, opening.lastInspectedRoom);
        break;
      }
    }
    fragment.append(controls);
  }
  fragment.append(progress);
  fragment.append(node('p', 'small-note', '访问者在正门待入场。准备完成后，一起进入一楼大厅。'));
  const occupied = opening.corners.filter(corner => corner.occupied).length;
  fragment.append(node('p', 'small-note', `已配置角落 ${occupied} / ${opening.corners.length}，标志保持盖放。`));
  panel.replaceChildren(fragment);
}
