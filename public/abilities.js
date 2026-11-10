import { getLogicalRooms } from '/shared/maps.mjs';
import { cornerName } from './tile.js';

const rooms = getLogicalRooms();
const selections = new Map();
const roomName = id => rooms.find(room => room.id === id)?.name || '未知房间';
const playerName = (state, id) => state.players.find(player => player.id === id)?.name || '访问者';
const itemNames = {
  walkie_talkie: '对讲机', spirit_pen: '笔仙', ventriloquist_doll: '腹语人偶', stethoscope: '听诊器',
  nightmare_letter: '噩梦的来信', shrine_bell: '深菱神社之铃', relic_ring: '遗物戒指',
  smartphone: '智能手机', suitcase: '行李箱', dowsing_rod: '占卜棒', deduction: '归纳推理法',
  night_vision: '夜视仪', amulet: '古怪护符',
};
const tokenNames = {
  safe: '转轮式保险箱', notebook: '手记', password: '密码', weakness_clue: '讨伐情况', weapon: '讨伐道具',
  doll: '玛丽小姐的人偶', hidden_exit: '隐藏出口', amulet: '古怪护符', extinguisher: '灭火器',
  remains: '亡骸', hako: '箱娃', box_person: '箱人', empty_box: '空箱', key: '钥匙',
};
const toolNames = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };
const floorName = floor => ({ '-1': '地下室', 1: '一楼', 2: '二楼' })[floor] || String(floor);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function cardName(card) {
  if (!card) return '未公开的能力';
  const id = Number(card.id ?? card.powerId);
  return `${Number.isInteger(id) && id > 0 ? `NO.${id} ` : ''}${card.name || '箱娃之力'}`;
}

function tokenName(token) {
  if (!token) return '无标志';
  const parts = [token.name || tokenNames[token.type] || '角落标志'];
  if (token.number !== undefined) parts.push(`数字${token.number}`);
  if (token.tool) parts.push(`${toolNames[token.tool] || token.tool}${token.type === 'weakness_clue' ? '无效' : ''}`);
  return parts.join(' · ');
}

function button(label, testid, locked, onClick, secondary = false) {
  const element = node('button', `button ${secondary ? 'secondary' : 'primary'}`, label);
  element.type = 'button';
  element.dataset.testid = testid;
  element.disabled = locked;
  element.addEventListener('click', onClick);
  return element;
}

function select(container, id, labelText, options, locked) {
  const label = node('label', '', labelText);
  label.htmlFor = id;
  const input = node('select');
  input.id = id;
  input.dataset.testid = id;
  input.disabled = locked || !options.length;
  for (const choice of options) {
    const option = node('option', '', choice.name);
    option.value = choice.id;
    option.disabled = Boolean(choice.disabled);
    input.append(option);
  }
  const remembered = selections.get(id);
  const selected = options.find(choice => String(choice.id) === remembered && !choice.disabled) || options.find(choice => !choice.disabled) || options[0];
  input.value = String(selected?.id ?? '');
  selections.set(id, input.value);
  input.addEventListener('change', () => selections.set(id, input.value));
  container.append(label, input);
  return input;
}

function checkbox(container, id, caption, locked) {
  const label = node('label', 'inline-check');
  const input = node('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = selections.get(id) === 'true';
  input.disabled = locked;
  input.addEventListener('change', () => selections.set(id, String(input.checked)));
  label.append(input, node('span', '', caption));
  container.append(label);
  return input;
}

function forcedPeek(container, state, locked, action) {
  const resolution = state.round.resolution;
  if (resolution?.kind !== 'forced_peek' || resolution.playerId !== state.you) return;
  const controls = node('section', 'exploration-section practice-controls current-response');
  controls.dataset.testid = 'forced-peek';
  controls.append(node('h3', '', '强制窥探'), node('p', 'small-note', '你的原行动被打断。选择当前房间中一个有标志的角落进行窥探。'));
  const target = select(controls, 'forced-peek-target', '选择窥探角落', (resolution.cornerIds || []).map(id => ({ id, name: cornerName(id) })), locked);
  const nightVision = state.round.inventory?.items?.some(item => item.id === 'night_vision')
    ? checkbox(controls, 'forced-peek-use-night-vision', '使用夜视仪：发现手记时领取未选道具', locked) : null;
  if (nightVision) nightVision.dataset.testid = 'forced-peek-use-night-vision';
  controls.append(button('确认强制窥探', 'choose-forced-peek', locked || !target.value, () => action('choose_forced_peek', { cornerId: target.value, useNightVision: Boolean(nightVision?.checked) })));
  container.append(controls);
}

function answerItem(container, state, locked, action) {
  const resolution = state.round.resolution;
  if (resolution?.kind !== 'item_answer' || resolution.playerId !== state.you || state.round.hako.playerId !== state.you) return;
  const controls = node('section', 'exploration-section practice-controls current-response');
  controls.dataset.testid = 'item-answer';
  controls.append(node('h3', '', `回答${itemNames[resolution.itemId] || '访问者道具'}`));
  const question = resolution.itemId === 'spirit_pen'
    ? `${playerName(state, resolution.userId)}询问：箱娃在${roomName(resolution.roomId)}吗？`
    : resolution.itemId === 'ventriloquist_doll'
      ? `${playerName(state, resolution.userId)}调查${roomName(resolution.roomId)}：若人偶在其中，喊“我是玛丽小姐”。`
      : `${playerName(state, resolution.userId)}询问箱娃所在楼层。`;
  controls.append(node('p', 'small-note', question));
  const truth = typeof resolution.truth === 'boolean' ? resolution.truth ? '是' : '否' : floorName(resolution.truth);
  controls.append(node('p', 'small-note', `真实答案（仅你可见）：${truth}。${resolution.canLie ? 'NO.9 虚假的回应已设置，你可以选择其他答案。' : '请按真实答案回答。'}`));
  const answer = select(controls, 'item-answer-select', '向访问者公开的答案', resolution.answerOptions || [], locked);
  controls.append(button('公开回答', 'answer-item', locked || !answer.value, () => action('answer_item', { answer: JSON.parse(answer.value) })));
  container.append(controls);
}

function itemResult(container, items) {
  if (items.result?.kind !== 'phone') return;
  const result = node('section', 'exploration-section personal-result');
  result.dataset.testid = 'item-private-result';
  result.append(node('h3', '', '手机照片 · 仅你可见'), node('p', 'private-token', cardName(items.result.card)));
  if (items.result.card?.description) result.append(node('p', 'small-note', items.result.card.description));
  container.append(result);
}

function itemEvents(container, state, events) {
  if (!events?.length) return;
  const details = node('details', 'activity-details reference-details');
  details.dataset.testid = 'item-events';
  details.append(node('summary', '', '道具记录'));
  const list = node('ol');
  for (const event of events.slice(-8)) {
    const item = itemNames[event.itemId] || '访问者道具';
    let text = `${playerName(state, event.userId)}使用${item}`;
    if (event.roomId) text += `，指定${roomName(event.roomId)}`;
    if (event.kind === 'item_answer') text += `；箱娃${event.itemId === 'ventriloquist_doll' ? event.answer ? '大喊：我是玛丽小姐' : '没有叫喊' : `回答：${typeof event.answer === 'boolean' ? event.answer ? '是' : '否' : floorName(event.answer)}`}`;
    if (event.notebooks?.length) text += `；公开手记${event.notebooks.map(token => token.number).join('、')}`;
    list.append(node('li', '', `${text}。`));
  }
  details.append(list);
  container.append(details);
}

export function renderActiveItems({ container, resultContainer = container, referenceContainer = container, state, locked, action }) {
  const round = state.round;
  if (!round) return;
  locked ||= Boolean(round.result);
  forcedPeek(container, state, locked, action);
  answerItem(container, state, locked, action);
  const items = round.items;
  if (!items) return;
  if (items.usableItems?.length && !round.result && !round.resolution && !round.pendingAction && !round.interruption) {
    const controls = node('section', 'exploration-section practice-controls standard-actions');
    controls.dataset.testid = 'active-items';
    controls.append(node('h3', 'action-group-heading', '使用随身道具'));
    const choice = select(controls, 'active-item-select', '选择可用道具', items.usableItems, locked);
    const description = node('p', 'item-description small-note');
    description.dataset.testid = 'active-item-description';
    description.setAttribute('aria-live', 'polite');
    controls.append(description);
    const targets = node('div', 'practice-controls');
    const use = button('声明使用道具', 'use-item', true, () => {
      const payload = { itemId: choice.value };
      if (['spirit_pen', 'ventriloquist_doll'].includes(choice.value)) payload.roomId = targets.querySelector('select')?.value;
      if (choice.value === 'smartphone' || choice.value === 'amulet') {
        const [targetZone, index] = targets.querySelector('select').value.split(':');
        payload.targetZone = targetZone;
        payload.index = Number(index);
      }
      if (choice.value === 'amulet') payload.tokenId = round.inventory?.tokens?.find(token => token.type === 'amulet')?.id;
      action('use_item', payload);
    });
    const renderTargets = () => {
      const item = items.usableItems.find(item => item.id === choice.value);
      description.textContent = item?.description || round.inventory?.items?.find(item => item.id === choice.value)?.description || '';
      description.hidden = !description.textContent;
      targets.replaceChildren();
      let valid = Boolean(choice.value);
      if (['spirit_pen', 'ventriloquist_doll'].includes(choice.value)) {
        const room = select(targets, 'active-item-room', '指定房间', items.roomOptions || [], locked);
        valid = Boolean(room.value);
      }
      if (choice.value === 'smartphone' || choice.value === 'amulet') {
        const options = (items.phoneTargets || []).filter(target => choice.value !== 'amulet' || target.id.startsWith('slot:'));
        const target = select(targets, 'active-item-target', choice.value === 'amulet' ? '选择要移除的可用能力栏' : '选择要拍摄的能力牌', options, locked);
        valid = Boolean(target.value) && (choice.value !== 'amulet' || round.inventory?.tokens?.some(token => token.type === 'amulet'));
      }
      if (choice.value === 'amulet') targets.append(node('p', 'small-note', '消耗一枚古怪护符，将该栏能力牌直接移出游戏。'));
      use.disabled = locked || !valid;
    };
    choice.addEventListener('change', renderTargets);
    renderTargets();
    controls.append(targets, use);
    container.append(controls);
  }
  itemResult(resultContainer, items);
  itemEvents(referenceContainer, state, items.events);
}

function publicPowers(container, state, powers) {
  const section = node('section', 'exploration-section power-overview');
  section.dataset.testid = 'power-slots';
  section.append(node('h3', '', '能力与持续效果'));
  const slots = node('dl', 'round-positions');
  const isHako = state.round.hako.playerId === state.you;
  for (const slot of powers.slots || []) {
    const row = node('div');
    row.dataset.testid = 'power-slot';
    row.dataset.slot = slot.slot;
    row.append(node('dt', '', slot.slot === 0 ? '左侧能力栏' : '右侧能力栏'), node('dd', '', !slot.occupied ? '空栏' : isHako && slot.card ? cardName(slot.card) : '背面能力'));
    slots.append(row);
  }
  section.append(slots, node('p', 'small-note', `箱娃手牌 ${powers.handCount ?? 0} 张 · 牌库 ${powers.deckCount ?? 0} 张`));
  const cryCount = node('p', 'small-note', `累计哭喊 ${powers.cryCount ?? 0} 次 · 第10次哭喊保底「绝望时刻」。`);
  cryCount.dataset.testid = 'power-cry-count';
  section.append(cryCount);
  if (isHako && powers.pendingBehindYou) {
    const effect = node('p', 'small-note', 'NO.5 我在你身后已发动：下一箱娃阶段开始时、移动前，结算与箱娃同房的访问者死亡；届时公开八片手记也结算与箱人同房的访问者。');
    effect.dataset.testid = 'power-delayed-death';
    section.append(effect);
  }
  if (powers.announcement) {
    const cry = node('p', 'small-note', `哭喊指向：${roomName(powers.announcement.roomId)}`);
    cry.dataset.testid = 'cry-announcement';
    section.append(cry);
  }
  const ownActivation = isHako && powers.lastActivation;
  if (ownActivation || powers.activationNotice) {
    const activation = node('p', 'small-note', ownActivation ? `箱娃发动了${cardName(ownActivation)}。` : '箱娃发动了能力。');
    activation.dataset.testid = 'power-last-activation';
    section.append(activation);
  }
  if (state.round.blockedDoors?.length) {
    const doors = node('p', 'small-note', `封锁的门：${state.round.blockedDoors.map(door => `${roomName(door.from)} — ${roomName(door.to)}`).join('；')}。`);
    doors.dataset.testid = 'blocked-doors';
    section.append(doors);
  }
  if (powers.ghostCall?.active) section.append(node('p', 'small-note', '移动受限：访问者只能沿最短路径前往客厅，首位到达后全体解除。'));
  if (isHako && powers.stolen) {
    const stolen = node('div');
    stolen.dataset.testid = 'power-stolen';
    const { kind, piece } = powers.stolen;
    stolen.append(node('h3', '', '抢来的东西 · 仅你可见'), node('p', 'private-token', kind === 'item' ? piece.name || itemNames[piece.id] || '访问者道具' : tokenName(piece)));
    if (kind === 'item' && piece.description) stolen.append(node('p', 'small-note', piece.description));
    section.append(stolen);
  }
  container.append(section);
}

function managePowers(container, state, powers, locked, action) {
  const controls = node('section', 'exploration-section practice-controls hako-sequence');
  controls.dataset.testid = 'power-preparation';
  controls.append(node('h3', '', powers.step === 'preparation' ? '箱娃阶段 · 准备' : '你的能力手牌'));
  let hand;
  if (powers.hand?.length) {
    hand = node('details', 'free-actions reference-details');
    hand.append(node('summary', '', `查看手牌（${powers.hand.length}张）`));
    const list = node('dl', 'inspected-tokens');
    for (const card of powers.hand) {
      const row = node('div');
      row.dataset.testid = 'power-hand-card';
      row.dataset.powerId = card.id;
      const description = [card.description, card.ignoreThreshold ? '此牌可绕过手记数量门槛。' : card.threshold ? `公开手记门槛：${card.threshold}片。` : '', card.supported === false ? card.reason || '规则待确认，暂不可设置或发动。' : '', card.setReason].filter(Boolean).join(' ');
      row.append(node('dt', '', cardName(card)), node('dd', '', description));
      list.append(row);
    }
    hand.append(list);
  }
  if (powers.canCry) {
    controls.append(node('h4', '', '哭喊抽牌（可选）'));
    if (powers.cryRooms?.length) {
      const room = select(controls, 'hako-cry-room', 'NO.11 虚假的哭喊：选择宣告房间', powers.cryRooms, locked);
      controls.append(button('哭喊并宣告房间', 'hako-cry', locked || !room.value, () => action('hako_cry', { roomId: room.value })));
    } else controls.append(button('哭喊，公开当前房间', 'hako-cry', locked, () => action('hako_cry')));
  }
  if (powers.canManage) {
    const emptySlots = (powers.slots || []).filter(slot => !slot.occupied);
    const settable = (powers.hand || []).filter(card => card.settable && card.supported !== false);
    const recallable = (powers.slots || []).filter(slot => slot.occupied && slot.canRecall);
    if ((emptySlots.length && settable.length) || recallable.length) controls.append(node('h4', '', '设置或回收能力（本阶段二选一）'));
    if (emptySlots.length && settable.length) {
      const power = select(controls, 'set-power-select', '设置一张手牌', settable.map(card => ({ id: card.id, name: cardName(card) })), locked);
      const slot = select(controls, 'set-power-slot', '放入可用能力栏', emptySlots.map(value => ({ id: value.slot, name: value.slot === 0 ? '左侧能力栏' : '右侧能力栏' })), locked);
      controls.append(button('设置能力', 'set-power', locked || !power.value || !slot.value, () => action('set_power', { powerId: Number(power.value), slot: Number(slot.value) }), true));
    }
    if (recallable.length) {
      const slot = select(controls, 'recall-power-slot', '选择回收的能力', recallable.map(value => ({ id: value.slot, name: `${value.slot === 0 ? '左栏' : '右栏'} · ${cardName(value.card)}` })), locked);
      controls.append(button('回收至手牌', 'recall-power', locked || !slot.value, () => action('recall_power', { slot: Number(slot.value) }), true));
    }
  }
  if (powers.canBegin) controls.append(node('p', 'small-note', '准备完成后，如需使用能力，请先发动，再选择潜伏位置。'), button('准备完毕，开始箱娃行动', 'begin-hako-action', locked, () => action('begin_hako_action')));
  if (hand) controls.append(hand);
  if (controls.children.length > 1) container.append(controls);
}

function activatePowers(container, state, powers, locked, action) {
  if (!powers.activationOptions?.length || powers.rearrangement || state.round.resolution || state.round.interruption) return;
  const controls = node('section', 'exploration-section practice-controls hako-sequence');
  controls.dataset.testid = 'power-activation';
  controls.append(node('h3', '', '发动已设置的能力'));
  for (const option of powers.activationOptions) {
    const card = option.card;
    const group = node('div', 'action-group');
    group.append(node('h4', '', cardName(card)));
    if (card.description) group.append(node('p', 'small-note', card.description));
    if ([9, 11].includes(card.id)) {
      group.append(node('p', 'small-note', card.id === 9 ? '设置后持续生效，回答道具问题时可选择虚假答案。' : '在哭喊时选择宣告房间，无需单独发动。'));
    } else {
      if (option.reason) group.append(node('p', 'small-note', option.reason));
      let room;
      let door;
      let steal;
      if (option.rooms?.length) room = select(group, `power-room-${option.slot}`, '选择作用房间', option.rooms, locked || !option.canActivate);
      if (option.doors?.length) door = select(group, `power-door-${option.slot}`, '选择要封锁的门', option.doors.map((value, index) => ({ id: index, name: value.name || `${roomName(value.fromRoomId)} — ${roomName(value.toRoomId)}` })), locked || !option.canActivate);
      if (card.id === 7) {
        const choices = (option.stealOptions?.items || []).map(item => ({ id: `item:${item.id}`, name: `抢走道具：${item.name || itemNames[item.id] || '访问者道具'}` }));
        if (option.stealOptions?.canStealToken) choices.push({ id: 'token', name: '随机抢走1枚盖放标志' });
        steal = select(group, `power-steal-${option.slot}`, '选择抢夺方式', choices, locked || !option.canActivate);
        group.append(node('p', 'small-note', '抢夺后，访问者可重新选择行动，不消耗标准行动。'));
      }
      if (card.id === 8) group.append(node('p', 'small-note', '诅咒从人偶持有者的下次翻牌回合起生效，本次不补翻。'));
      const activate = button(`发动${cardName(card)}`, 'activate-power', locked || !option.canActivate || Boolean(steal && !steal.value), () => {
        const payload = { slot: option.slot };
        if (room) payload.roomId = room.value;
        if (door) {
          const target = option.doors[Number(door.value)];
          payload.fromRoomId = target.fromRoomId;
          payload.toRoomId = target.toRoomId;
        }
        if (steal) {
          payload.stealKind = steal.value === 'token' ? 'token' : 'item';
          if (payload.stealKind === 'item') payload.itemId = steal.value.slice(5);
        }
        action('activate_power', payload);
      });
      activate.dataset.slot = option.slot;
      activate.dataset.powerId = card.id;
      group.append(activate);
    }
    controls.append(group);
  }
  container.append(controls);
}

function rearrangePowers(container, state, powers, locked, action) {
  const rearrangement = powers.rearrangement;
  if (!rearrangement) return;
  const controls = node('section', 'exploration-section practice-controls current-response');
  controls.dataset.testid = 'power-rearrangement';
  controls.append(node('h3', '', `NO.4 动来动去 · ${roomName(rearrangement.roomId)}`), node('p', 'small-note', '为每个目标角落选择一份原角落内容，每份内容恰好使用一次。'));
  const corners = rearrangement.corners;
  const sourceNames = corners.map(corner => {
    const actors = (corner.actors || []).map(actor => actor.type === 'hako' ? '箱娃' : `${playerName(state, actor.playerId)}（箱人）`);
    return { id: corner.id, name: `${cornerName(corner.id)}：${[tokenName(corner.token), ...actors].join('、')}` };
  });
  const choices = [];
  const faceDownChoices = [];
  corners.forEach(corner => {
    const id = `power-rearrange-${corner.id}`;
    if (!selections.has(id)) selections.set(id, corner.id);
    const target = select(controls, id, `放入${cornerName(corner.id)}`, sourceNames, locked);
    target.dataset.testid = 'power-rearrange-source';
    target.dataset.cornerId = corner.id;
    choices.push(target);
    const faceDown = checkbox(controls, `power-rearrange-face-down-${corner.id}`, '将放入此处的标志重新盖放', locked);
    faceDown.dataset.testid = 'power-rearrange-face-down';
    faceDown.dataset.cornerId = corner.id;
    faceDownChoices.push(faceDown);
  });
  const hint = node('p', 'small-note');
  const confirm = button('确认全部角落的新位置', 'power-rearrange-submit', locked, () => action('power_rearrange', { order: choices.map(choice => choice.value), faceDownCornerIds: faceDownChoices.filter(input => input.checked).map(input => input.dataset.cornerId) }));
  const update = () => {
    const unique = new Set(choices.map(choice => choice.value)).size === corners.length;
    confirm.disabled = locked || !unique;
    hint.textContent = unique ? '每份原内容均已分配，可确认。' : '同一份原内容被重复选择，请为每个角落分配不同内容。';
  };
  for (const choice of choices) choice.addEventListener('change', update);
  update();
  controls.append(hint, confirm);
  container.append(controls);
}

function inspectPath(container, state, powers, locked, action) {
  if (!powers.pathRooms?.length && !powers.pathInspection) return;
  const controls = node('section', 'exploration-section practice-controls hako-sequence');
  controls.append(node('h3', '', '选择移动路线'));
  if (powers.pathRooms?.length) {
    const room = select(controls, 'path-room-select', '选择本次路径上的房间', powers.pathRooms, locked);
    controls.append(button('确认途经房间', 'inspect-path-room', locked || !room.value, () => action('inspect_path_room', { roomId: room.value }), true));
  }
  if (powers.pathInspection) {
    const inspection = powers.pathInspection;
    controls.append(node('p', 'small-note', `${roomName(inspection.roomId)} · 仅你可见`));
    const list = node('p', 'small-note', '再选择终点潜伏角落；确认后仅查看被替换的棋子。');
    list.dataset.testid = 'path-inspection';
    controls.append(list);
  }
  container.append(controls);
}

function extinguisherControls(container, state, locked, action) {
  const interruption = state.round.interruption;
  if (!interruption?.canRespond || state.round.result) return;
  const controls = node('section', 'exploration-section practice-controls current-response');
  controls.dataset.testid = 'extinguisher-response';
  controls.append(node('h3', '', '灭火器 · 打断响应'), node('p', 'small-note', '你翻出的无声数字使累计超过10。是否消耗灭火器，跳过本次箱娃行动阶段？'));
  controls.append(button('使用灭火器', 'extinguisher-use', locked, () => action('extinguisher_response', { use: true })), button('放弃本次响应', 'extinguisher-pass', locked, () => action('extinguisher_response', { use: false }), true));
  container.append(controls);
}

export function renderAbilities({ container, referenceContainer = container, state, locked, action }) {
  const round = state.round;
  if (!round) return;
  locked ||= Boolean(round.result);
  extinguisherControls(container, state, locked, action);
  const powers = round.powers;
  if (powers) {
    if (round.hako.playerId === state.you && !round.result) {
      if (!round.resolution && !round.interruption) managePowers(container, state, powers, locked, action);
      activatePowers(container, state, powers, locked, action);
      rearrangePowers(container, state, powers, locked, action);
      if (!round.resolution && !round.interruption) inspectPath(container, state, powers, locked, action);
    }
    publicPowers(referenceContainer, state, powers);
  }
}
