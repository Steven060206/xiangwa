import { getLogicalRoomId, getLogicalRooms } from '/shared/maps.mjs';
import { cardName } from './abilities.js';
import { cornerName, mapTokenName } from './tile.js';
import { draftScope } from './view-state.js';

const floors = [[1, '一楼'], [2, '二楼'], [-1, '地下室']];
const tabs = [['board', '盘面'], ['items', '玩家物品'], ['powers', '箱娃能力'], ['log', '行动记录']];
let selection;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function playerName(state, id) {
  return state.players.find(player => player.id === id)?.name || '玩家';
}

function field(id, label) {
  const wrapper = element('label', 'review-field');
  const select = element('select');
  select.id = id;
  select.dataset.testid = id;
  select.dataset.localControl = 'true';
  wrapper.append(element('span', '', label), select);
  return { wrapper, select };
}

function mapLink(label, id, testId, location, returnLabel, record) {
  const button = element('button', 'text-button review-map-link', label);
  button.type = 'button';
  button.id = id;
  button.dataset.testid = testId;
  button.dataset.localControl = 'true';
  Object.assign(button.dataset, location);
  button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('map-target', {
    detail: { ...location, source: button, returnLabel, record },
  })));
  return button;
}

function definition(list, label, value) {
  const row = element('div');
  row.append(element('dt', '', label), element('dd', '', value));
  list.append(row);
}

const tokenNames = tokens => (tokens || []).map(token => mapTokenName(token));
const itemNames = items => (items || []).map(item => item.name);

function boardPanel(panel, state) {
  const review = state.round.review;
  const placements = state.setup?.placements || [];
  const floorOf = room => placements.find(placed => placed.tileId === room.tileId)?.floor;
  const rooms = getLogicalRooms().filter(room => floorOf(room) !== undefined);
  const controls = element('div', 'review-board-filters');
  const floor = field('review-floor', '楼层');
  const room = field('review-room', '房间');
  for (const [value, name] of floors) {
    if (rooms.some(room => floorOf(room) === value)) floor.select.add(new Option(name, value));
  }
  if (rooms.some(room => floorOf(room) === selection.floor)) floor.select.value = String(selection.floor);
  controls.append(floor.wrapper, room.wrapper);
  const contents = element('div', 'review-room-contents');

  function showCorners() {
    selection.roomId = room.select.value;
    const roomCorners = (review.corners || []).filter(corner => getLogicalRoomId(corner.roomId) === selection.roomId);
    const list = element('dl', 'review-corners');
    for (const corner of roomCorners) {
      const row = element('div');
      row.dataset.testid = 'review-corner';
      row.dataset.cornerId = corner.id;
      const location = element('dt');
      location.append(mapLink(cornerName(corner.id), `review-corner-${corner.id}`, 'review-map-target',
        { cornerId: corner.id }, '返回终局盘面'));
      const value = element('dd', '', mapTokenName(corner.token));
      for (const actor of corner.actors || []) {
        const name = playerName(state, actor.playerId);
        value.append(element('p', 'small-note', `${name}（${actor.type === 'hako' ? '箱娃' : '箱人'}）`));
        if (actor.carriedTokens?.length) value.append(element('p', 'small-note', `${name}暂存了${tokenNames(actor.carriedTokens).join('、')}`));
      }
      if (corner.underToken) value.append(element('p', 'small-note', `被替换棋子 · ${mapTokenName(corner.underToken)}`));
      row.append(location, value);
      list.append(row);
    }
    contents.replaceChildren();
    if (selection.roomId) contents.append(mapLink('在地图查看此房间', 'review-locate-room', 'review-locate-room',
      { roomId: selection.roomId }, '返回终局盘面'));
    contents.append(list);
  }

  function showRooms() {
    selection.floor = Number(floor.select.value);
    const visibleRooms = rooms.filter(room => floorOf(room) === selection.floor);
    room.select.replaceChildren(...visibleRooms.map(room => new Option(room.name, room.id)));
    if (visibleRooms.some(room => room.id === selection.roomId)) room.select.value = selection.roomId;
    showCorners();
  }
  floor.select.addEventListener('change', () => {
    if (selection.floor !== Number(floor.select.value)) showRooms();
  });
  room.select.addEventListener('change', () => {
    if (selection.roomId !== room.select.value) showCorners();
  });
  showRooms();
  panel.append(controls, contents);
}

function itemsPanel(panel, state) {
  const review = state.round.review;
  const players = [...state.players].sort((left, right) => left.seat - right.seat);
  const picker = field('review-player', '玩家座位');
  for (const player of players) picker.select.add(new Option(
    `${player.seat + 1}号座 · ${player.name}${player.id === state.you ? '（你）' : ''}`, player.id));
  if (players.some(player => player.id === selection.playerId)) picker.select.value = selection.playerId;
  const inventory = element('section', 'review-player');
  inventory.dataset.testid = 'review-inventory';

  function showPlayer() {
    selection.playerId = picker.select.value;
    const id = selection.playerId;
    const held = review.inventories?.find(player => player.playerId === id);
    const visitor = state.round.visitors.find(player => player.id === id);
    const role = id === state.round.hako.playerId ? '箱娃' : visitor?.status === 'banished' ? '已被消灭的箱人'
      : visitor?.status === 'box_person' ? '箱人' : '访问者';
    inventory.dataset.playerId = id;
    const list = element('dl', 'review-facts');
    definition(list, '随身标志', tokenNames(held?.tokens).join('、') || '无');
    definition(list, '技能牌', itemNames(held?.items).join('、') || '无');
    for (const stored of review.storedTokens || []) if (stored.playerId === id) {
      definition(list, `暂存于${cornerName(stored.cornerId)}`, tokenNames(stored.tokens).join('、') || '无');
    }
    for (const entry of review.discarded || []) if (entry.playerId === id) {
      definition(list, '公开弃置', [...tokenNames(entry.tokens), ...itemNames(entry.items)].join('、') || '无');
    }
    inventory.replaceChildren(element('h4', '', `${playerName(state, id)} · ${role}`), list);
  }
  picker.select.addEventListener('change', () => {
    if (selection.playerId !== picker.select.value) showPlayer();
  });
  showPlayer();
  panel.append(picker.wrapper, inventory);
  if (review.removedTokens?.length || review.removedItems?.length) {
    const list = element('dl', 'review-facts');
    if (review.removedTokens?.length) definition(list, '已消耗或移出的标志', tokenNames(review.removedTokens).join('、'));
    if (review.removedItems?.length) definition(list, '死亡后移出的技能牌', itemNames(review.removedItems).join('、'));
    panel.append(element('h4', '', '全局移出记录'), list);
  }
}

function powersPanel(panel, state) {
  const { powers, opening } = state.round.review;
  const list = element('dl', 'review-facts review-power-facts');
  const cards = group => group?.map(cardName).join('、') || '无';
  definition(list, '手牌', cards(powers?.hand));
  for (const [index, slot] of (powers?.slots || []).entries()) {
    definition(list, index === 0 ? '左侧能力栏' : '右侧能力栏', slot ? cardName(slot.card || slot) : '空栏');
  }
  definition(list, '已移出游戏', cards(powers?.removed));
  definition(list, '已使用的能力记录', cards(powers?.used));
  if (powers?.stolen?.piece) {
    const { kind, piece } = powers.stolen;
    definition(list, '抢来的物品', kind === 'item' ? piece.name : mapTokenName(piece));
  }
  if (opening?.password) definition(list, '保险箱密码', opening.password.join('、'));
  if (opening?.weakness) definition(list, '箱娃弱点', mapTokenName({ type: 'weapon', tool: opening.weakness }));
  if (opening?.initialPower) definition(list, '初始能力', cardName(opening.initialPower));
  if (opening?.safeBoard) definition(list, '保险箱内', opening.safeBoard.key ? mapTokenName(opening.safeBoard.key) : '钥匙已被取出');
  if (opening?.remainsCornerId) definition(list, '开局亡骸位置', cornerName(opening.remainsCornerId));
  const deck = element('ol', 'review-deck');
  for (const card of powers?.deck || []) deck.append(element('li', '', cardName(card)));
  panel.append(list, element('h4', '', '牌库 · 从顶到底'), deck.children.length ? deck : element('p', 'small-note', '牌库已空。'));
}

function milestones(state) {
  const { round } = state;
  const events = [];
  for (const [index, entry] of (round.publicDiscoveries || []).entries()) {
    events.push({ cycle: entry.cycle, key: `discovery-${index}`, cornerId: entry.cornerId,
      text: `${playerName(state, entry.playerId)}公开了${mapTokenName(entry.token)}` });
  }
  for (const [index, event] of (round.deathEvents || []).entries()) {
    events.push({ cycle: event.cycle, key: `death-${index}`, cornerId: event.cornerId,
      text: `${playerName(state, event.userId)}在此死亡` });
  }
  events.sort((a, b) => (a.cycle ?? Infinity) - (b.cycle ?? Infinity));
  return events;
}

const cycleText = event => Number.isInteger(event.cycle) ? `第${event.cycle}轮` : '轮次未记录';
const openingDeals = state => (state.initialItems || []).map(deal => `${playerName(state, deal.playerId)}领取${deal.itemName}`).join('、');

export function publicReport(state) {
  const round = state.round;
  if (!round?.result || !round.review) return '';
  const { result, review } = round;
  const lines = ['《箱娃》本局公开复盘', `${result.winner === 'hako' ? '箱娃方' : '访问者方'}获胜 · ${result.reason}`];
  if (result.winners?.length) lines.push('获胜玩家 · ' + result.winners.map(id => playerName(state, id)).join('、'));
  lines.push(`总回合 ${round.totalRounds ?? 0}`, '', '关键记录', `开局 · ${openingDeals(state) || '无发牌记录'}`);
  for (const entry of milestones(state)) {
    lines.push(`${cycleText(entry)} · ${entry.text}${entry.cornerId ? ' · ' + cornerName(entry.cornerId) : ''}`);
  }
  if (round.notebooks?.length) lines.push('公开手记 · ' + tokenNames(round.notebooks).join('、'));
  lines.push('结局 · ' + result.reason, '', '终局盘面');
  const rooms = getLogicalRooms();
  for (const [floor, floorName] of floors) {
    const placed = (state.setup?.placements || []).filter(tile => tile.floor === floor);
    if (!placed.length) continue;
    lines.push(floorName);
    const roomIds = new Set(rooms.filter(room => placed.some(tile => tile.tileId === room.tileId)).map(room => room.id));
    for (const corner of review.corners) {
      if (!roomIds.has(getLogicalRoomId(corner.roomId))) continue;
      const contents = (corner.actors || []).map(actor => `${playerName(state, actor.playerId)}（${actor.type === 'hako' ? '箱娃' : '箱人'}）`);
      if (!contents.length) contents.push(mapTokenName(corner.token));
      if (corner.underToken) contents.push('暂存 ' + mapTokenName(corner.underToken));
      lines.push(`  ${cornerName(corner.id)} · ${contents.join('、')}`);
    }
  }
  lines.push('', '玩家物品');
  for (const player of [...state.players].sort((a, b) => a.seat - b.seat)) {
    const inventory = review.inventories.find(entry => entry.playerId === player.id);
    const possessions = [...itemNames(inventory?.items), ...tokenNames(inventory?.tokens)];
    const visitor = round.visitors.find(seat => seat.id === player.id);
    const room = rooms.find(room => room.id === visitor?.roomId);
    lines.push(`${player.seat + 1}号 ${player.name}${room ? '（' + room.name + '）' : ''} · ${possessions.join('、') || '无随身物品'}`);
    for (const entry of review.storedTokens || []) if (entry.playerId === player.id && entry.tokens.length) {
      lines.push(`  ${cornerName(entry.cornerId)}暂存 · ${tokenNames(entry.tokens).join('、')}`);
    }
  }
  const { powers, opening } = review;
  const cards = group => (group || []).map(cardName).join('、') || '无';
  lines.push('', '箱娃能力', `手牌 · ${cards(powers.hand)}`);
  for (const [index, slot] of powers.slots.entries()) lines.push(`${index ? '右' : '左'}栏 · ${slot ? cardName(slot.card || slot) : '空栏'}`);
  lines.push('牌库（从顶到底） · ' + cards(powers.deck), '已使用 · ' + cards(powers.used), '已移出 · ' + cards(powers.removed));
  if (powers.stolen?.piece) lines.push('抢来的物品 · ' + (powers.stolen.kind === 'item' ? powers.stolen.piece.name : mapTokenName(powers.stolen.piece)));
  if (opening?.initialPower) lines.push('初始能力 · ' + cardName(opening.initialPower));
  if (opening?.password) lines.push('保险箱密码 · ' + opening.password.join('、'));
  if (opening?.safeBoard) lines.push('保险箱内 · ' + (opening.safeBoard.key ? mapTokenName(opening.safeBoard.key) : '钥匙已被取出'));
  if (opening?.weakness) lines.push('箱娃弱点 · ' + mapTokenName({ type: 'weapon', tool: opening.weakness }));
  lines.push('', '最近 64 条房间行动', ...(state.log || []).slice(-64).filter(entry => typeof entry === 'string'));
  return lines.join('\n');
}

export function downloadReport(text) {
  if (!text) return;
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '箱娃-本局公开复盘.txt';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function logPanel(panel, state) {
  const locations = element('ul', 'review-location-log');
  locations.append(element('li', '', '开局 · ' + (openingDeals(state) || '无发牌记录')));
  for (const entry of milestones(state)) {
    const record = cycleText(entry) + ' · ' + entry.text;
    const row = element('li', '', record);
    if (entry.cornerId) row.append(mapLink(cornerName(entry.cornerId), 'review-location-' + entry.key, 'review-log-target',
      { cornerId: entry.cornerId }, '返回行动记录', record));
    locations.append(row);
  }
  if (state.round.notebooks?.length) locations.append(element('li', '', '公开手记 · ' + tokenNames(state.round.notebooks).join('、')));
  locations.append(element('li', '', '结局 · ' + state.round.result.reason));
  panel.append(element('h4', '', '按回合的关键记录'), locations);
  const entries = element('ol', 'review-log-list');
  for (const [index, entry] of (state.log || []).entries()) {
    const record = typeof entry === 'string' ? entry : entry.message || entry.text || '房间状态已更新';
    const row = element('li', '', record);
    if (entry.cornerId || entry.roomId) row.append(mapLink('在地图上查看', `review-log-entry-${index}`,
      'review-log-target', entry.cornerId ? { cornerId: entry.cornerId } : { roomId: entry.roomId }, '返回行动记录', record));
    entries.append(row);
  }
  panel.append(element('h4', '', '最近 64 条房间行动'));
  panel.append(entries.children.length ? entries : element('p', 'small-note', '暂无可回看的行动记录。'));
}

const renderTab = { board: boardPanel, items: itemsPanel, powers: powersPanel, log: logPanel };

export function gameReview(container, state) {
  if (!state.round.result || !state.round.review) return;
  // Keep reading choices across ordinary room updates. Undo, a rematch or a different seat starts a fresh review.
  const scope = draftScope(state);
  if (selection?.scope !== scope) selection = { scope, tab: 'board', floor: 1, roomId: '', playerId: state.you };
  const section = element('section', 'game-review');
  section.dataset.testid = 'game-review';
  section.id = 'game-review';
  const heading = element('h3', '', '本局复盘');
  heading.append(element('small', '', '全员可见'));
  const save = element('button', 'text-button', '保存本局公开复盘');
  save.type = 'button';
  save.dataset.testid = 'save-review';
  save.dataset.localControl = 'true';
  save.onclick = () => downloadReport(publicReport(state));
  heading.append(' ', save);
  heading.id = 'review-heading';
  section.setAttribute('aria-labelledby', heading.id);
  const nav = element('div', 'review-tabs');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-labelledby', heading.id);
  const panels = element('div');
  const show = key => {
    selection.tab = key;
    for (const tab of nav.children) {
      const active = tab.dataset.tab === key;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels.children) {
      panel.hidden = panel.id !== `review-${key}`;
      panel.replaceChildren();
      if (!panel.hidden) renderTab[key](panel, state);
    }
  };
  for (const [key, label] of tabs) {
    const tab = element('button', 'review-tab', label);
    tab.type = 'button';
    tab.id = `review-tab-${key}`;
    tab.dataset.localControl = 'true';
    tab.dataset.tab = key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `review-${key}`);
    tab.addEventListener('click', () => { if (selection.tab !== key) show(key); });
    const panel = element('section', 'review-panel');
    panel.id = `review-${key}`;
    panel.dataset.testid = panel.id;
    panel.tabIndex = 0;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    nav.append(tab);
    panels.append(panel);
  }
  nav.addEventListener('keydown', event => {
    const buttons = [...nav.children];
    const index = buttons.indexOf(event.target);
    const next = { ArrowRight: (index + 1) % buttons.length, ArrowLeft: (index + buttons.length - 1) % buttons.length,
      Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[next].click();
    buttons[next].focus();
  });
  show(selection.tab);
  section.append(heading, nav, panels);
  container.append(section);
}
