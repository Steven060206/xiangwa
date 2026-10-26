import { getTile } from '/shared/maps.mjs';
import { createTileSvg } from './tile.js';
import { renderPractice, roundDescription, roundSeatStatus, renderDraft, renderOpening, preparationDescription } from './practice.js';

const $ = id => document.getElementById(id);
const SESSION_KEY = 'hako.room.session.v1';
const floorName = floor => ({ 1: '一楼', 2: '二楼', '-1': '地下室' })[floor];
let identity = null;
let state = null;
let stream = null;
let pollTimer = null;
let pollController = null;
let pending = false;
let online = false;
let activeFloor = 1;
let rotation = 0;
let selected = null;
let tileTurnKey = '';
let boardKey = '';

function node(tag, className, value) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
}

function showError(error) {
  $('error-text').textContent = error instanceof Error ? error.message : String(error);
  $('error-banner').hidden = false;
}

function setConnection(connected) {
  const changed = online !== connected;
  online = connected;
  $('connection-state').textContent = connected ? '已连接' : '重新连接中';
  $('connection-state').classList.toggle('offline', !connected);
  $('connection-banner').hidden = connected || !identity;
  $('connection-banner').textContent = '连接已中断，正在自动重连。恢复后即可继续操作。';
  if (state && changed) render();
}

async function api(path, body, signal) {
  let response;
  try {
    response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  } catch {
    throw new Error('暂时无法连接房间，请检查网络后重试。');
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '操作未能完成，请重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function sessionQuery() {
  return new URLSearchParams({ playerId: identity.playerId, token: identity.token });
}

function saveSession(value) {
  identity = value;
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A restricted browser can still play for the current page lifetime.
  }
}

function disconnect() {
  stream?.close();
  stream = null;
  clearTimeout(pollTimer);
  pollTimer = null;
  pollController?.abort();
  pollController = null;
}

function connect() {
  disconnect();
  setConnection(false);
  if (location.hostname.endsWith('.trycloudflare.com') || new URL(location.href).searchParams.get('sync') === 'poll') {
    const controller = new AbortController();
    pollController = controller;
    const query = sessionQuery();
    query.set('poll', '1');
    const path = `/api/rooms/${identity.roomCode}?${query}`;
    async function poll() {
      try {
        const next = await api(path, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (controller.signal.aborted) return;
        // Do not rebuild form controls when only an unchanged snapshot arrives.
        if (JSON.stringify(next) !== JSON.stringify(state)) receiveState(next);
        setConnection(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnection(false);
        if (error.status === 403 || error.status === 404) { showError(error); return; }
      }
      if (!controller.signal.aborted) pollTimer = setTimeout(poll, 1000);
    }
    poll();
    return;
  }
  stream = new EventSource(`/api/rooms/${identity.roomCode}/events?${sessionQuery()}`);
  stream.onopen = () => setConnection(true);
  stream.addEventListener('state', event => {
    try {
      receiveState(JSON.parse(event.data));
      setConnection(true);
    } catch (error) { showError(error); }
  });
  stream.onerror = () => setConnection(false);
}

function receiveState(next) {
  // A POST response can arrive after a newer SSE event.
  if (state && next.version < state.version) return;
  state = next;
  const key = next.setup ? `${next.setup.turnPlayerId}:${next.setup.drawnTileId}` : '';
  if (key !== tileTurnKey) {
    tileTurnKey = key;
    rotation = 0;
    selected = null;
    const first = next.setup?.legalPlacements?.find(p => p.rotation === rotation);
    if (first && next.setup.turnPlayerId === next.you) {
      selected = { ...first };
      activeFloor = first.floor;
    }
  }
  render();
}

async function enterRoom(join) {
  if (pending) return;
  if (!$('nickname').reportValidity()) return;
  const name = $('nickname').value.trim();
  if (!name) { showError('请先填写昵称。'); $('nickname').focus(); return; }
  const code = $('room-code').value.trim().toUpperCase();
  if (join && !code) { showError('请填写朋友发来的房间码。'); $('room-code').focus(); return; }
  pending = true;
  $('create-room').disabled = true;
  $('join-room').disabled = true;
  $('error-banner').hidden = true;
  try {
    const result = await api(join ? `/api/rooms/${encodeURIComponent(code)}/join` : '/api/rooms', { name });
    saveSession({ roomCode: result.roomCode, playerId: result.playerId, token: result.token });
    receiveState(result.state);
    const url = new URL(location.href);
    url.searchParams.set('room', result.roomCode);
    history.replaceState(null, '', url);
    connect();
  } catch (error) { showError(error); }
  finally {
    pending = false;
    $('create-room').disabled = false;
    $('join-room').disabled = false;
    if (state) render();
  }
}

async function action(type, payload = {}) {
  if (pending || !online || !identity) return;
  pending = true;
  $('error-banner').hidden = true;
  render();
  try {
    const next = await api(`/api/rooms/${identity.roomCode}/actions`, { playerId: identity.playerId, token: identity.token, type, ...payload });
    if (type === 'leave') {
      disconnect();
      state = null;
      saveSession(null);
      online = false;
      $('room-view').hidden = true;
      $('entry-view').hidden = false;
      $('connection-banner').hidden = true;
      const url = new URL(location.href);
      url.searchParams.delete('room');
      history.replaceState(null, '', url);
    } else receiveState(next.state || next);
  } catch (error) { showError(error); }
  finally { pending = false; if (state) render(); }
}

function renderSeats(container, compact = false) {
  const fragment = document.createDocumentFragment();
  for (let seat = 0; seat < 4; seat++) {
    const player = state.players.find(p => p.seat === seat);
    const visitorStatus = state.round?.visitors.find(visitor => visitor.id === player?.id)?.status;
    const isGhost = visitorStatus === 'box_person';
    const isBanished = visitorStatus === 'banished';
    const roundActive = state.round && !state.round.result && (state.round.silent?.turnPlayerId === player?.id && !isGhost && !isBanished || ['initial_hiding', 'visitor_reaction', 'hako_reaction', 'hako_phase'].includes(state.round.phase) && state.round.hako.playerId === player?.id && !state.round.hako.finished || state.round.phase === 'hako_phase' && player?.id === state.you && isGhost && !state.round.ghost?.finished);
    const active = player && (state.round ? roundActive : state.draft ? state.draft.turnPlayerId === player.id : state.opening ? state.opening.hakoId === player.id : state.setup?.turnPlayerId === player.id);
    const item = node('li', `seat${!player ? ' empty' : player.role === 'hako' || isGhost ? ' hako' : ''}${isBanished ? ' banished' : ''}${active ? ' active' : ''}`);
    const mark = node('span', 'seat-mark', !player ? '候' : player.role === 'hako' || isGhost ? '箱' : isBanished ? '离' : '访');
    mark.setAttribute('aria-hidden', 'true');
    item.append(mark);
    const info = node('div', 'seat-info');
    info.append(node('span', 'seat-name', player ? player.name : '静候来客'));
    const meta = node('div', 'seat-meta');
    if (player) {
      meta.append(node('span', '', player.role === 'hako' ? '箱娃' : isGhost ? '箱人' : isBanished ? '已被消灭' : '访问者'));
      if (player.id === state.you) meta.append(node('span', 'self-tag', '你'));
      if (player.id === state.hostId) meta.append(node('span', '', '房主'));
    } else meta.append(node('span', '', '分享房间码，邀请朋友'));
    info.append(meta);
    item.append(info);
    if (player) {
      const preparationStatus = state.draft ? state.draft.choices.some(choice => choice.playerId === player.id) ? '已领道具' : active ? '选择道具' : '等待' : state.opening ? player.role === 'hako' ? '配置中' : '正门等候' : null;
      const status = !player.connected ? '暂离' : compact ? roundSeatStatus(state, player) || preparationStatus || (active ? state.setup?.drawnTileId ? '摆放中' : '当前轮次' : player.role === 'hako' ? '观图' : '等待') : player.ready ? '已准备' : '未准备';
      item.append(node('span', `seat-status${!player.connected ? ' disconnected' : player.ready ? ' ready' : ''}`, status));
    }
    fragment.append(item);
  }
  container.replaceChildren(fragment);
}

function renderLobby() {
  const you = state.players.find(p => p.id === state.you);
  const selecting = state.phase === 'hako_selection';
  const host = state.hostId === state.you;
  const locked = pending || !online;
  renderSeats($('lobby-seats'));
  $('lobby-title').textContent = selecting ? '谁来扮演箱娃？' : '人齐，便可进宅。';
  $('lobby-count').textContent = `${state.players.length} / 4 人入席`;
  $('ready-button').textContent = you?.ready ? '取消准备' : '准备';
  $('ready-button').disabled = locked || !you;
  $('ready-button').hidden = selecting;
  $('start-setup').hidden = !host || selecting;
  $('start-setup').disabled = locked || state.players.length !== 4 || !state.players.every(p => p.ready && p.connected);
  $('start-hint').hidden = selecting;
  $('start-hint').textContent = state.players.length < 4 ? `还差 ${4 - state.players.length} 位朋友，复制上方邀请链接即可入席。` : !state.players.every(p => p.ready) ? '四人都准备后，房主即可开始游戏，一起抢箱娃。' : host ? '都已准备，开始游戏后一起抢箱娃。' : '都已准备，等待房主开始游戏后一起抢箱娃。';
  $('hako-claim-controls').hidden = !selecting;
  $('claim-hako').disabled = locked || !you;
  $('leave-room').disabled = locked;
  $('leave-room').hidden = selecting;
}

function canPlace() {
  return online && !pending && state.phase === 'map_setup' && state.setup.turnPlayerId === state.you;
}

function legalForRotation() {
  return (state.setup?.legalPlacements || []).filter(p => p.rotation === rotation);
}

function samePosition(a, b) {
  return a && b && a.floor === b.floor && a.x === b.x && a.y === b.y && a.rotation === b.rotation;
}

function renderBoard() {
  const setup = state.setup;
  const showTargets = canPlace() && Boolean(setup.drawnTileId);
  const targets = showTargets ? legalForRotation().filter(p => p.floor === activeFloor) : [];
  const placements = setup.placements.filter(p => p.floor === activeFloor);
  const extraCorners = state.round?.extraCorners || [];
  const key = JSON.stringify([activeFloor, placements, targets, selected, setup.drawnTileId, rotation, extraCorners]);
  if (key === boardKey) return;
  boardKey = key;
  const board = $('tile-board');
  const fragment = document.createDocumentFragment();
  const positions = [...placements, ...targets];
  if (!positions.length) {
    board.style.gridTemplateColumns = '1fr';
    board.style.gridTemplateRows = 'auto';
    const empty = node('div', 'empty-floor', activeFloor === 2 ? '楼梯尽头，尚未点灯。' : '地下室仍在暗处。');
    empty.append(node('p', '', activeFloor === 2 ? '抽到二楼大厅后，在此展开新的楼层。' : '抽到地下室后，将在此独立摆放。'));
    fragment.append(empty);
  } else {
    const minX = Math.min(...positions.map(p => p.x));
    const maxX = Math.max(...positions.map(p => p.x));
    const minY = Math.min(...positions.map(p => p.y));
    const maxY = Math.max(...positions.map(p => p.y));
    board.style.gridTemplateColumns = `repeat(${maxX - minX + 1}, var(--tile-size))`;
    board.style.gridTemplateRows = `repeat(${maxY - minY + 1}, var(--tile-size))`;
    for (const placement of placements) {
      const cell = node('div', 'board-cell placed-tile');
      cell.dataset.tileId = placement.tileId;
      cell.dataset.floor = placement.floor;
      cell.dataset.x = placement.x;
      cell.dataset.y = placement.y;
      cell.dataset.rotation = placement.rotation;
      cell.style.gridColumn = placement.x - minX + 1;
      cell.style.gridRow = placement.y - minY + 1;
      cell.append(createTileSvg(placement.tileId, placement.rotation, extraCorners));
      fragment.append(cell);
    }
    for (const position of targets) {
      const isSelected = samePosition(position, selected);
      const button = node('button', `board-cell legal-position${isSelected ? ' selected' : ''}`);
      button.type = 'button';
      button.dataset.testid = 'legal-position';
      for (const [attr, value] of Object.entries(position)) button.dataset[attr] = value;
      button.style.gridColumn = position.x - minX + 1;
      button.style.gridRow = position.y - minY + 1;
      button.setAttribute('aria-label', `选择位置 ${floorName(position.floor)} ${position.x} ${position.y}`);
      button.setAttribute('aria-pressed', String(Boolean(isSelected)));
      button.append(node('span', 'position-symbol', '＋'));
      if (isSelected) button.append(createTileSvg(setup.drawnTileId, rotation));
      button.addEventListener('click', () => {
        selected = { ...position };
        renderSetup();
        $('tile-board').querySelector('.selected')?.focus({ preventScroll: true });
      });
      fragment.append(button);
    }
  }
  board.replaceChildren(fragment);
}

function renderSetup() {
  const setup = state.setup;
  renderDraft({ state, pending, online, action });
  renderOpening({ state, pending, online, action });
  renderPractice({ state, pending, online, action });
  $('board-section').hidden = !setup;
  $('map-progress').hidden = !setup;
  $('setup-view').classList.toggle('has-round', Boolean(state.round || state.opening));
  $('setup-view').classList.toggle('has-draft', Boolean(state.draft));
  renderSeats($('setup-seats'), true);
  $('activity-log').replaceChildren(...state.log.slice(-8).map(message => node('li', '', typeof message === 'string' ? message : message.message || message.text || '房间状态已更新')));
  if (!setup) {
    $('setup-title').textContent = '挑选你的初始道具';
    $('turn-description').textContent = preparationDescription(state);
    $('drawn-title').closest('.turn-panel').hidden = true;
    $('map-complete').hidden = true;
    return;
  }
  const mine = setup.turnPlayerId === state.you;
  const complete = setup.phase === 'map_ready';
  const round = state.round;
  const turnPlayer = state.players.find(p => p.id === setup.turnPlayerId);
  const drawn = setup.drawnTileId ? getTile(setup.drawnTileId) : null;
  const locked = !canPlace();
  $('map-count').replaceChildren(document.createTextNode(setup.placements.length), node('span', '', '/ 9'));
  $('setup-title').textContent = round ? round.result ? '今夜已有结局' : round.mode === 'exploration' ? '探索这座旧宅' : '基础回合' : state.opening ? '入宅之前，藏好秘密' : '拼出这座旧宅';
  $('turn-description').textContent = round ? roundDescription(state) : state.opening ? preparationDescription(state) : complete ? '九块地图已就位。由房主开始配置角落标志与开局秘密。' : mine ? drawn ? '轮到你摆放地图。旋转方向，选择位置，再确认。' : '轮到你了。抽取一块地图，开启新的房间。' : `${turnPlayer?.name || '访问者'}正在${drawn ? '摆放地图' : '抽取地图'}，请稍候。`;
  $('turn-seat').textContent = complete ? '九块齐备' : mine ? '你的轮次' : '等待访问者';
  $('drawn-title').textContent = complete ? '宅邸已现' : drawn ? '本次抽到' : '轮流抽板';
  const previewKey = `${setup.drawnTileId}:${rotation}:${complete}`;
  if ($('drawn-preview').dataset.key !== previewKey) {
    const preview = $('drawn-preview');
    preview.dataset.key = previewKey;
    preview.classList.toggle('completed-preview', complete);
    if (drawn) preview.replaceChildren(createTileSvg(drawn.id, rotation));
    else if (complete) {
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('viewBox', '0 0 48 48');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 24 19 35 40 12');
      mark.append(path);
      preview.replaceChildren(mark);
    } else {
      const back = node('div', 'tile-back');
      back.setAttribute('aria-hidden', 'true');
      back.append(node('span', '', '宅'));
      preview.replaceChildren(back);
    }
  }
  $('drawn-name').textContent = complete ? '地图已拼好' : drawn ? drawn.name : `还有 ${setup.remaining} 块待抽取`;
  $('action-instruction').textContent = complete ? '下一步配置角落标志。' : mine ? drawn ? '虚线位置可摆放，预览后确认。' : '每次抽一块，由你决定摆在哪里。' : drawn ? `等待${turnPlayer?.name || '访问者'}选定位置。` : '按访问者顺序，依次抽板拼接。';
  $('draw-tile').hidden = Boolean(drawn) || complete;
  $('draw-tile').disabled = locked;
  $('rotate-tile').hidden = !drawn || !mine || complete;
  $('rotate-tile').disabled = locked;
  $('confirm-placement').hidden = !drawn || !mine || complete;
  $('confirm-placement').disabled = locked || !selected;
  $('selection-description').textContent = drawn && mine && selected ? `${floorName(selected.floor)} · 位置 ${selected.x}, ${selected.y} · ${rotation * 90}°` : '';
  $('drawn-title').closest('.turn-panel').hidden = complete;
  $('map-complete').hidden = !complete || Boolean(round || state.opening);
  $('prepare-opening').hidden = state.hostId !== state.you;
  $('prepare-opening').disabled = pending || !online;
  $('opening-start-hint').textContent = state.hostId === state.you ? '准备好后，配置角落标志并由箱娃选择开局秘密。' : '等待房主开始开局配置。';
  $('board-help').textContent = round ? '玩家所在房间见清单 · 可切换楼层' : state.opening ? '角落标志保持盖放 · 访问者在正门待入场' : complete ? '九块地图已完成配置' : mine && drawn ? '虚线位置可摆放 · 点击切换预览' : '在地图区域内滚动查看';
  for (const button of $('floor-tabs').querySelectorAll('button')) {
    const floor = Number(button.dataset.floor);
    button.setAttribute('aria-selected', String(floor === activeFloor));
    button.tabIndex = floor === activeFloor ? 0 : -1;
    $(`floor-count-${floor}`).textContent = setup.placements.filter(p => p.floor === floor).length || '';
  }
  renderBoard();
}

function render() {
  if (!state) return;
  $('entry-view').hidden = true;
  $('room-view').hidden = false;
  $('room-code-display').textContent = state.code;
  const lobby = state.phase === 'lobby' || state.phase === 'hako_selection';
  $('lobby-view').hidden = !lobby;
  $('setup-view').hidden = lobby;
  const phaseName = state.phase === 'lobby' ? '等待入席' : state.phase === 'hako_selection' ? '抢选箱娃' : state.round ? state.round.result ? '本局结束' : state.round.mode === 'exploration' ? '旧宅探索' : '基础回合' : state.opening ? '开局准备' : state.draft ? '领取初始道具' : state.phase === 'map_ready' ? '地图已拼好' : '地图拼接';
  document.title = `箱娃 · ${state.code} · ${phaseName}`;
  $('room-phase-label').textContent = `箱娃 · ${phaseName}`;
  if (lobby) renderLobby();
  else renderSetup();
}

$('entry-form').addEventListener('submit', event => { event.preventDefault(); enterRoom(false); });
$('join-room').addEventListener('click', () => enterRoom(true));
$('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); });
$('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); enterRoom(true); } });
$('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
$('ready-button').addEventListener('click', () => action('ready', { ready: !state.players.find(p => p.id === state.you)?.ready }));
$('start-setup').addEventListener('click', () => action('start'));
$('prepare-opening').addEventListener('click', () => action('prepare_opening'));
$('claim-hako').addEventListener('click', () => action('claim_hako'));
$('leave-room').addEventListener('click', () => action('leave'));
$('draw-tile').addEventListener('click', () => action('draw'));
$('rotate-tile').addEventListener('click', () => {
  if (!canPlace()) return;
  rotation = (rotation + 1) % 4;
  const legal = legalForRotation();
  selected = legal.find(p => p.floor === activeFloor && p.x === selected?.x && p.y === selected?.y) || legal.find(p => p.floor === activeFloor) || legal[0] || null;
  if (selected) activeFloor = selected.floor;
  renderSetup();
});
$('confirm-placement').addEventListener('click', () => { if (selected) action('place', { ...selected }); });
$('floor-tabs').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  activeFloor = Number(button.dataset.floor);
  if (canPlace() && state.setup.drawnTileId) selected = legalForRotation().find(p => p.floor === activeFloor) || null;
  renderSetup();
});
$('floor-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...$('floor-tabs').querySelectorAll('button')];
  let index = tabs.indexOf(document.activeElement);
  index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].click();
  tabs[index].focus();
});
$('copy-invite').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('room', state.code);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url.href);
    else {
      const area = node('textarea');
      area.value = url.href;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('请复制地址栏中的邀请链接。');
    }
    $('copy-invite').textContent = '已复制';
    $('copy-status').textContent = '邀请链接已复制';
    setTimeout(() => { $('copy-invite').textContent = '复制邀请'; }, 2000);
  } catch { showError('未能复制邀请链接，请复制浏览器地址栏中的完整地址。'); }
});

for (const tab of $('floor-tabs').querySelectorAll('button')) tab.dataset.testid = Number(tab.dataset.floor) === -1 ? 'floor-basement' : `floor-${tab.dataset.floor}`;
const requestedRoom = new URL(location.href).searchParams.get('room');
if (requestedRoom) $('room-code').value = requestedRoom.toUpperCase();

async function resume() {
  let stored;
  try { stored = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return; }
  if (!stored?.roomCode || !stored.playerId || !stored.token) return;
  identity = stored;
  pending = true;
  $('create-room').disabled = true;
  $('join-room').disabled = true;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(stored.roomCode)}?${sessionQuery()}`);
    receiveState(result.state || result);
    connect();
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      saveSession(null);
      showError(`无法恢复上次入席：${error.message} 请重新加入房间。`);
    } else {
      showError(`暂时无法恢复入席：${error.message} 原座位身份已保留，请刷新页面重试。`);
    }
  } finally {
    pending = false;
    $('create-room').disabled = false;
    $('join-room').disabled = false;
    if (state) render();
  }
}

resume();
