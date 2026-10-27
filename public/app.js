import { getTile, getLogicalRoomId, getLogicalRooms } from '/shared/maps.mjs';
import { createFeedbackUI } from './feedback-view.js';
import { applyUndoLock, renderUndo } from './undo.js';
import { createTileSvg, cornerNumber, cornerName, mapPlayers } from './tile.js';
import { renderPractice, roundDescription, roundSeatStatus, renderDraft, renderOpening, preparationDescription } from './practice.js';

const $ = id => document.getElementById(id);
const feedback = createFeedbackUI();
const SESSION_KEY = 'hako.room.session.v1';
const SAVED_SESSIONS_KEY = 'hako.room.saved.v1';
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
let selectedMapCorner = '';
const compactScreen = matchMedia('(max-width:720px)');
let guideExpanded = !compactScreen.matches;

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

function savedSessions() {
  try { return JSON.parse(localStorage.getItem(SAVED_SESSIONS_KEY)) || {}; }
  catch { return {}; }
}

function storedSession(roomCode) {
  let tabSession;
  try { tabSession = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { /* Try persistent storage. */ }
  const saved = savedSessions();
  return [tabSession, saved.rooms?.[roomCode || saved.lastRoomCode]].find(value =>
    value?.roomCode && value.playerId && value.token && (!roomCode || value.roomCode === roomCode));
}

function saveSession(value) {
  const previous = identity;
  identity = value;
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A restricted browser can still play for the current page lifetime.
  }
  try {
    const saved = savedSessions();
    saved.rooms ??= {};
    if (value) {
      saved.rooms[value.roomCode] = value;
      saved.lastRoomCode = value.roomCode;
    } else if (previous) {
      if (saved.rooms[previous.roomCode]?.playerId === previous.playerId) delete saved.rooms[previous.roomCode];
      if (saved.lastRoomCode === previous.roomCode) delete saved.lastRoomCode;
    }
    localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(saved));
  } catch { /* Tab recovery still works when persistent storage is unavailable. */ }
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
  feedback.receive(next);
}

async function enterRoom(join) {
  if (pending) return;
  if (!$('nickname').reportValidity()) return;
  const name = $('nickname').value.trim();
  if (!name) { showError('请先填写昵称。'); $('nickname').focus(); return; }
  const code = $('room-code').value.trim().toUpperCase();
  if (join && !code) { showError('请填写朋友发来的房间码。'); $('room-code').focus(); return; }
  const existing = join && storedSession(code);
  if (existing) { await resume(existing); return; }
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
    const next = await api(`/api/rooms/${identity.roomCode}/actions`, {
      playerId: identity.playerId, token: identity.token, type, expectedVersion: state.version, ...payload,
    });
    if (type === 'leave') {
      feedback.clear();
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
      if (player.isBot) {
        const label = node('span', 'bot-tag', '人机');
        label.dataset.testid = 'bot-label';
        meta.append(label);
      }
      if (player.id === state.you) meta.append(node('span', 'self-tag', '你'));
      if (player.id === state.hostId) meta.append(node('span', '', '房主'));
    } else meta.append(node('span', '', '等待朋友或人机'));
    info.append(meta);
    item.append(info);
    if (player) {
      const preparationStatus = state.draft ? state.draft.choices.some(choice => choice.playerId === player.id) ? '已领道具' : active ? '选择道具' : '等待' : state.opening ? player.role === 'hako' ? '配置中' : '正门等候' : null;
      const status = !player.connected ? '暂离' : compact ? roundSeatStatus(state, player) || preparationStatus || (active ? state.setup?.drawnTileId ? '摆放中' : '当前轮次' : player.role === 'hako' ? '观图' : '等待') : player.ready ? '已准备' : '未准备';
      item.append(node('span', `seat-status${!player.connected ? ' disconnected' : player.ready ? ' ready' : ''}`, status));
      if (!compact && state.phase === 'lobby' && state.hostId === state.you && player.id !== state.you && (player.isBot || !player.connected)) {
        const remove = node('button', 'text-button', '移除');
        remove.type = 'button';
        remove.dataset.testid = player.isBot ? 'remove-bot-player' : 'remove-offline-player';
        remove.dataset.playerId = player.id;
        remove.setAttribute('aria-label', `移除${player.isBot ? '人机' : '暂离玩家'} ${player.name}`);
        remove.disabled = pending || !online;
        remove.addEventListener('click', () => action('remove_player', { targetId: player.id }));
        item.append(remove);
      }
    }
    fragment.append(item);
  }
  container.replaceChildren(fragment);
}

function renderLobby() {
  const you = state.players.find(p => p.id === state.you);
  const selecting = state.phase === 'hako_selection';
  const host = state.hostId === state.you;
  const hasBots = state.players.some(player => player.isBot);
  const locked = pending || !online;
  renderSeats($('lobby-seats'));
  $('lobby-title').textContent = selecting ? '谁来扮演箱娃？' : '人齐，便可进宅。';
  $('lobby-count').textContent = `${state.players.length} / 4 人入席`;
  $('ready-button').textContent = you?.ready ? '取消准备' : '准备';
  $('ready-button').disabled = locked || !you;
  $('ready-button').hidden = selecting;
  $('start-setup').hidden = !host || selecting;
  $('start-setup').disabled = locked || state.players.length !== 4 || !state.players.every(p => p.ready && p.connected);
  $('add-bots').hidden = !host || selecting || state.players.length === 4;
  $('add-bots').disabled = locked || !host || selecting || state.players.length === 4;
  $('start-hint').hidden = selecting;
  $('start-hint').textContent = state.players.length < 4 ? `还差 ${4 - state.players.length} 席，可邀请朋友${host ? '，或点击补齐人机一起试玩' : '，也可由房主补齐人机'}。` : !state.players.every(p => p.ready) ? hasBots ? '人机已自动准备，其他玩家准备后，房主即可开始游戏。' : '四人都准备后，房主即可开始游戏，一起抢箱娃。' : host ? '都已准备，开始游戏后一起抢箱娃。' : '都已准备，等待房主开始游戏后一起抢箱娃。';
  $('hako-claim-controls').hidden = !selecting;
  $('claim-hako').disabled = locked || !you || !selecting;
  $('bot-claim-hako').hidden = !selecting || !host || !hasBots;
  $('bot-claim-hako').disabled = locked || !you || !selecting || !host || !hasBots;
  $('hako-claim-status').textContent = hasBots ? '四人已准备，可抢当箱娃，也可由房主让人机扮演箱娃。' : '四人已准备，点击按钮抢当箱娃，先抢先得。';
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

function renderCornerGuide(placements, extraCorners) {
  let guide = $('corner-guide');
  if (!guide) {
    guide = node('section', 'corner-guide');
    guide.id = 'corner-guide';
    guide.setAttribute('aria-labelledby', 'corner-guide-title');
    const heading = node('h2');
    heading.id = 'corner-guide-title';
    const toggle = node('button', 'corner-guide-toggle');
    toggle.id = 'corner-guide-toggle';
    toggle.dataset.testid = 'corner-guide-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'corner-guide-body');
    toggle.addEventListener('click', () => { guideExpanded = !guideExpanded; updateCornerGuide(); });
    heading.append(toggle);
    const body = node('div');
    body.id = 'corner-guide-body';
    const list = node('div', 'corner-guide-rooms');
    list.id = 'corner-guide-rooms';
    body.append(node('p', '', '地图上的编号与右侧选项一致；每个编号代表一个可放标志的位置。'), list);
    guide.append(heading, body);
    $('board-section').append(guide);
  }
  guide.hidden = !placements.length;
  updateCornerGuide();
  const fragment = document.createDocumentFragment();
  for (const placement of placements) {
    for (const room of getTile(placement.tileId).rooms) {
      const section = node('section', 'corner-guide-room');
      section.dataset.roomId = room.id;
      section.append(node('h3', '', room.name));
      const list = node('ul');
      for (const corner of [...room.corners, ...extraCorners.filter(corner => corner.roomId === room.id)]) {
        const entry = node('li', 'corner-guide-entry');
        entry.dataset.cornerId = corner.id;
        entry.append(node('span', 'corner-guide-number', cornerNumber(corner.id)),
          node('span', 'corner-guide-name', corner.id.startsWith('suitcase:') ? '行李箱中' : corner.name));
        list.append(entry);
      }
      section.append(list);
      fragment.append(section);
    }
  }
  $('corner-guide-rooms').replaceChildren(fragment);
}

function updateCornerGuide() {
  if (!$('corner-guide')) return;
  $('corner-guide').classList.toggle('expanded', guideExpanded);
  $('corner-guide-toggle').textContent = `${guideExpanded ? '收起' : '展开'}角落位置对照`;
  $('corner-guide-toggle').setAttribute('aria-expanded', String(guideExpanded));
  $('corner-guide-body').hidden = !guideExpanded;
}

compactScreen.addEventListener('change', () => { guideExpanded = !compactScreen.matches; updateCornerGuide(); });

function renderBoard() {
  const setup = state.setup;
  const showTargets = canPlace() && Boolean(setup.drawnTileId);
  const targets = showTargets ? legalForRotation().filter(p => p.floor === activeFloor) : [];
  const placements = setup.placements.filter(p => p.floor === activeFloor);
  const extraCorners = state.round?.extraCorners || [];
  const players = mapPlayers(state);
  const announcement = state.round?.powers?.announcement;
  renderMapPositions(players);
  const key = JSON.stringify([activeFloor, placements, targets, selected, setup.drawnTileId, rotation, extraCorners, players, announcement]);
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
      cell.append(createTileSvg(placement.tileId, placement.rotation, extraCorners, players, announcement));
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
  if (selectedMapCorner) board.querySelector(`[data-corner-id="${CSS.escape(selectedMapCorner)}"].corner-location`)?.classList.add('selected-corner');
  renderCornerGuide(placements, extraCorners);
}

function selectMapCorner(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  const corner = event.target.closest('.corner-location');
  if (!corner) return;
  event.preventDefault();
  event.stopPropagation();
  selectedMapCorner = corner.dataset.cornerId;
  for (const mark of $('tile-board').querySelectorAll('.corner-location')) mark.classList.toggle('selected-corner', mark === corner);
  let name = $('selected-corner-name');
  if (!name) {
    name = node('span', 'selected-corner-name');
    name.id = 'selected-corner-name';
    name.dataset.testid = 'selected-corner-name';
    name.setAttribute('role', 'status');
    $('board-help').parentElement.append(name);
  }
  name.textContent = cornerName(selectedMapCorner);
}
$('tile-board').addEventListener('click', selectMapCorner);
$('tile-board').addEventListener('keydown', selectMapCorner);

function renderMapPositions(players) {
  const strip = $('map-positions');
  const fragment = document.createDocumentFragment();
  for (const player of players) {
    const room = player.roomId === 'entrance' ? { name: '正门', tileId: 'hall' }
      : state.setup.placements.map(placement => getTile(placement.tileId))
        .flatMap(tile => tile.rooms.map(room => ({ ...room, tileId: tile.id }))).find(room => room.id === player.roomId);
    const floor = state.setup.placements.find(placement => placement.tileId === room?.tileId)?.floor;
    const entry = node('button', `map-position seat-color-${player.seat}${player.self ? ' self-player' : ''}`);
    entry.type = 'button';
    entry.dataset.playerId = player.id;
    entry.dataset.roomId = player.roomId;
    entry.setAttribute('aria-label', `查看${player.name}${player.self ? '（你）' : ''}所在位置：${room?.name || '正门'}${player.cornerId ? `，角落${cornerNumber(player.cornerId)}，仅自己可见` : ''}`);
    entry.append(node('span', 'player-number', String(player.seat + 1)),
      node('span', '', `${player.name}${player.self ? '（你）' : ''} · ${room?.name || '正门'}${player.cornerId ? ` ${cornerNumber(player.cornerId)}（仅自己可见）` : ''}`));
    entry.addEventListener('click', () => {
      if (floor === undefined) return;
      activeFloor = floor;
      renderSetup();
      const marker = [...$('tile-board').querySelectorAll('.map-player-marker')].find(marker => marker.dataset.playerId === player.id);
      const tile = marker?.closest('.placed-tile');
      if (!tile) return;
      const viewport = $('board-viewport');
      const view = viewport.getBoundingClientRect();
      const target = tile.getBoundingClientRect();
      // Centre its board tile, leaving room context around the player's token.
      viewport.scrollTo({ left: viewport.scrollLeft + target.left - view.left - (viewport.clientWidth - target.width) / 2,
        top: viewport.scrollTop + target.top - view.top - (viewport.clientHeight - target.height) / 2 });
    });
    fragment.append(entry);
  }
  strip.replaceChildren(fragment);
  strip.hidden = !players.length;
}

function renderSetup() {
  const setup = state.setup;
  renderDraft({ state, pending, online, action });
  renderOpening({ state, pending, online, action });
  renderPractice({ state, pending, online, action });
  $('board-section').hidden = !setup;
  $('map-progress').hidden = !setup || Boolean(state.round || state.opening);
  $('setup-view').classList.toggle('has-round', Boolean(state.round || state.opening));
  $('setup-view').classList.toggle('has-draft', Boolean(state.draft));
  renderSeats($('setup-seats'), true);
  $('activity-log').replaceChildren(...state.log.slice(-8).map(message => node('li', '', typeof message === 'string' ? message : message.message || message.text || '房间状态已更新')));
  if (!setup) {
    $('drawn-title').closest('.turn-panel').hidden = true;
    $('map-complete').hidden = true;
    applyUndoLock(state);
    return;
  }
  const mine = setup.turnPlayerId === state.you;
  const complete = setup.phase === 'map_ready';
  const round = state.round;
  const turnPlayer = state.players.find(p => p.id === setup.turnPlayerId);
  const drawn = setup.drawnTileId ? getTile(setup.drawnTileId) : null;
  const locked = !canPlace();
  $('map-count').replaceChildren(document.createTextNode(setup.placements.length), node('span', '', '/ 9'));
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
  $('board-help').textContent = round ? '圆标为玩家座位号 · 潜伏位置仅本人可见' : state.opening ? '访问者在正门待入场 · 标志保持盖放' : complete ? '访问者在正门等待入场' : mine && drawn ? '虚线位置可摆放 · 点击切换预览' : '在地图区域内滚动查看';
  for (const button of $('floor-tabs').querySelectorAll('button')) {
    const floor = Number(button.dataset.floor);
    button.setAttribute('aria-selected', String(floor === activeFloor));
    button.tabIndex = floor === activeFloor ? 0 : -1;
    $(`floor-count-${floor}`).textContent = setup.placements.filter(p => p.floor === floor).length || '';
  }
  renderBoard();
  applyUndoLock(state);
}

function currentTask() {
  const round = state.round;
  const name = id => id === state.you ? '你' : state.players.find(player => player.id === id)?.name || '玩家';
  const task = (title, description, actor, target) => ({ title, description, actor, target, mine: actor === state.you });
  if (state.undo?.pending) {
    const request = state.undo.pending;
    const mine = request.requiredIds.includes(state.you) && !request.approvedIds.includes(state.you);
    return { ...task(mine ? '请决定是否撤销' : '等待撤销决定', '当前进度已暂停。查看撤销请求，再继续游戏。', mine ? state.you : request.requestedBy, '#undo-panel'), mine };
  }
  if (!online) return task('正在恢复连接', '连接恢复后即可继续；你的座位与游戏进度已保留。', null, null);
  if (round) {
    const description = roundDescription(state);
    if (round.result) return task('今夜已有结局', description, null, '.game-result');
    if (round.interruption) return task(round.interruption.canRespond ? '请选择是否打断' : '等待灭火器回应', description, round.interruption.canRespond ? state.you : null, '[data-testid="extinguisher-response"]');
    if (round.resolution) {
      const resolution = round.resolution;
      const titles = { inheritance: '请决定遗物去向', safe: '请尝试打开保险箱', item_answer: '请回答访问者', forced_peek: '请选择强制窥探角落', notebook: '你发现了手记', peek: '请决定是否获取标志' };
      return task(resolution.kind === 'waiting' ? `等待${name(resolution.playerId)}完成结算` : titles[resolution.kind] || '请完成当前结算', description, resolution.playerId, '.current-response');
    }
    if (['visitor_reaction', 'hako_reaction'].includes(round.phase)) return task(round.hako.playerId === state.you ? round.phase === 'visitor_reaction' ? '请确认访问者行动' : '请结束反应窗口' : '等待箱娃确认', description, round.hako.playerId, '.practice-controls');
    if (round.phase === 'hako_phase') {
      const actor = round.hako.playerId === state.you ? round.hako : round.ghost;
      const ghostWaiting = round.ghost && actor === round.ghost && actor.status !== 'banished' && !actor.finished && !actor.inspectedRoom && !actor.hidingRooms?.length;
      if (ghostWaiting && round.hako.playerId !== state.you) return task('等待箱娃开始潜伏', '箱娃完成阶段能力并选择潜伏房间后，才轮到你选择潜伏位置。', round.hako.playerId, '.practice-controls');
      const mine = actor && actor.status !== 'banished' && !actor.finished && (round.powers?.step !== 'preparation' || round.hako.playerId === state.you);
      return task(mine ? round.powers?.step === 'preparation' ? '轮到你准备能力' : '轮到你行动与潜伏' : '等待箱娃与箱人行动', description, mine ? state.you : round.hako.finished ? null : round.hako.playerId, '.hako-sequence');
    }
    const actor = round.silent?.turnPlayerId;
    return task(actor === state.you ? round.phase === 'visitor_reveal' ? '轮到你翻牌' : '轮到你行动' : `等待${name(actor)}${round.phase === 'visitor_reveal' ? '翻牌' : '行动'}`, description, actor, round.phase === 'visitor_reveal' ? '.silent-section' : '.standard-actions, .practice-controls');
  }
  if (state.opening) return task(state.opening.hakoId === state.you ? '请配置开局秘密' : '等待箱娃配置开局', preparationDescription(state), state.opening.hakoId, '#opening-panel');
  if (state.draft) return task(state.draft.turnPlayerId === state.you ? '请领取初始道具' : `等待${name(state.draft.turnPlayerId)}领取道具`, preparationDescription(state), state.draft.turnPlayerId, '#draft-panel');
  if (state.setup?.phase === 'map_ready') return task(state.hostId === state.you ? '地图齐备，可以入宅' : '等待房主开始配置', '九块地图已就位，下一步配置角落标志与开局秘密。', state.hostId, '#map-complete');
  const actor = state.setup?.turnPlayerId;
  const drawn = state.setup?.drawnTileId;
  return task(actor === state.you ? drawn ? '请摆放这块地图' : '轮到你抽取地图' : `等待${name(actor)}${drawn ? '摆放' : '抽取'}地图`, actor === state.you ? drawn ? '选择旋转方向和虚线位置，预览后确认摆放。' : '先抽取一块地图，再决定放在哪里。' : '可先浏览地图，轮到你时会在这里提示。', actor, '.turn-panel');
}

function renderGameStatus() {
  const task = currentTask();
  $('setup-title').textContent = task.title;
  $('turn-description').textContent = task.description;
  $('turn-owner').textContent = task.actor === state.you ? '现在轮到你' : task.actor ? `当前：${state.players.find(player => player.id === task.actor)?.name || '玩家'}` : state.round?.result ? '本局结束' : '请稍候';
  $('game-status').classList.toggle('needs-attention', Boolean(task.mine && online));
  $('focus-current-action').hidden = !task.target;
  $('focus-current-action').textContent = task.mine ? '前往操作' : '查看进度';
  const round = state.round;
  $('personal-status').hidden = !round;
  if (!round) return;
  const you = state.players.find(player => player.id === state.you);
  const visitor = round.visitors.find(player => player.id === state.you);
  const isHako = round.hako.playerId === state.you;
  $('personal-role').textContent = `${you?.name || '你'} · ${isHako ? '箱娃' : visitor?.status === 'box_person' ? '箱人' : visitor?.status === 'banished' ? '已被消灭' : '访问者'}`;
  const location = mapPlayers(state).find(player => player.id === state.you);
  const room = location && getLogicalRooms().find(room => room.id === getLogicalRoomId(location.roomId));
  $('personal-location').textContent = location ? `${room?.name || '正门'}${location.cornerId ? ` · ${cornerNumber(location.cornerId)}（仅你可见）` : ''}` : '';
  $('round-context').textContent = `总回合 ${round.totalRounds ?? 0}`;
  $('focus-inventory').textContent = isHako ? `我的能力 · ${round.powers?.hand?.length ?? 0}` : `我的物品 · ${(round.inventory?.items?.length || 0) + (round.inventory?.tokens?.length || 0)}`;
}

function focusGameSection(selector) {
  $('setup-view').classList.remove('map-focused');
  $('map-focus').textContent = '专看地图';
  $('map-focus').setAttribute('aria-pressed', 'false');
  const target = [...document.querySelectorAll(selector)].find(element => element.getClientRects().length);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', inline: 'nearest' });
}

function render() {
  if (!state) return;
  $('entry-view').hidden = true;
  $('room-view').hidden = false;
  $('room-code-display').textContent = state.code;
  const lobby = state.phase === 'lobby' || state.phase === 'hako_selection';
  $('room-view').classList.toggle('in-game', !lobby);
  $('lobby-view').hidden = !lobby;
  $('setup-view').hidden = lobby;
  const phaseName = state.phase === 'lobby' ? '等待入席' : state.phase === 'hako_selection' ? '抢选箱娃' : state.round ? state.round.result ? '本局结束' : state.round.mode === 'exploration' ? '旧宅探索' : '基础回合' : state.opening ? '开局准备' : state.draft ? '领取初始道具' : state.phase === 'map_ready' ? '地图已拼好' : '地图拼接';
  document.title = `箱娃 · ${state.code} · ${phaseName}`;
  $('room-phase-label').textContent = `箱娃 · ${phaseName}`;
  if (lobby) renderLobby();
  else renderSetup();
  renderUndo({ state, pending, online, action });
  if (!lobby) renderGameStatus();
}

$('focus-current-action').addEventListener('click', () => focusGameSection(currentTask().target || '#practice-panel'));
$('focus-inventory').addEventListener('click', () => focusGameSection('#personal-inventory, [data-testid="power-preparation"], .hako-sequence, .power-overview'));
$('entry-form').addEventListener('submit', event => { event.preventDefault(); enterRoom(false); });
$('map-focus').addEventListener('click', () => {
  const focused = $('setup-view').classList.toggle('map-focused');
  $('map-focus').textContent = focused ? '返回操作' : '专看地图';
  $('map-focus').setAttribute('aria-pressed', String(focused));
});
$('join-room').addEventListener('click', () => enterRoom(true));
$('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); });
$('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); enterRoom(true); } });
$('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
$('ready-button').addEventListener('click', () => action('ready', { ready: !state.players.find(p => p.id === state.you)?.ready }));
$('start-setup').addEventListener('click', () => action('start'));
$('prepare-opening').addEventListener('click', () => action('prepare_opening'));
$('claim-hako').addEventListener('click', () => action('claim_hako'));
$('add-bots').addEventListener('click', () => action('add_bots'));
$('bot-claim-hako').addEventListener('click', () => action('bot_claim_hako'));
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

async function resume(stored = storedSession(requestedRoom?.toUpperCase())) {
  if (!stored?.roomCode || !stored.playerId || !stored.token) return;
  identity = stored;
  pending = true;
  $('create-room').disabled = true;
  $('join-room').disabled = true;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(stored.roomCode)}?${sessionQuery()}`);
    saveSession(stored);
    receiveState(result.state || result);
    const url = new URL(location.href);
    url.searchParams.set('room', stored.roomCode);
    history.replaceState(null, '', url);
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
