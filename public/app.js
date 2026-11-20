import { getTile, getLogicalRoomId, getLogicalRooms } from '/shared/maps.mjs';
import { createFeedbackUI } from './feedback-view.js';
import { createChatUI } from './chat.js';
import { applyUndoLock, renderUndo } from './undo.js';
import { createTileSvg, cornerNumber, cornerName, cornerRoomId, mapTokenName, mapPlayers } from './tile.js';
import { renderGamePanels, roundDescription, roundSeatStatus, preparationDescription } from './practice.js';
import { freeActionWindow } from './exploration.js';
import { captureView, restoreView, stepKey, resetDrafts } from './view-state.js';
import { createHelpUI } from './help.js';

const $ = id => document.getElementById(id);
const feedback = createFeedbackUI();
const help = createHelpUI();
const chat = createChatUI(async payload => {
  if (!identity || !online) throw new Error('请等待连接恢复。');
  const session = identity;
  const next = await api(`/api/rooms/${identity.roomCode}/actions`, {
    playerId: identity.playerId, token: identity.token, type: 'chat_send', ...payload,
  });
  if (identity === session) receiveState(next);
});
const SESSION_KEY = 'hako.room.session.v1';
const SAVED_SESSIONS_KEY = 'hako.room.saved.v1';
const floorName = floor => ({ 1: '一楼', 2: '二楼', '-1': '地下室' })[floor];
let identity = null;
let state = null;
let stream = null;
let reconnectTimer = null;
let pollTimer = null;
let pollController = null;
let identityCheck = null;
let leavingIdentity = null;
let pending = false;
let accessPending = false;
let entryRetry = null;
let online = false;
let activeFloor = 1;
let rotation = 0;
let selected = null;
let tileTurnKey = '';
let boardKey = '';
let previewTimer = null;
let previewSending = false;
let lastPreviewSent = '';
let selectedMapCorner = '';
let selectedMapRoom = '';
let mapContext = null;
let mapVisit = null;
const compactScreen = matchMedia('(max-width:720px)');
let guideExpanded = false;
let currentView = 'action';
const viewScroll = new Map();
let actionCategory = '';
let renderedStep = '';
let restoringView = false;
let actionMessage = '';
let actionTone = 'info';
let submittedStep = '';
let pendingLabel = '';
let uncertainAction = false;
let entryMode = 'create';
let hadConnection = false;

function node(tag, className, value) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
}

function showError(error) {
  $('error-text').textContent = error instanceof Error ? error.message : String(error);
  $('error-banner').hidden = false;
  actionMessage = $('error-text').textContent;
  actionTone = 'error';
  renderActionFeedback();
}

function renderActionFeedback() {
  const panel = $('action-feedback');
  panel.hidden = !actionMessage && !pendingLabel;
  panel.dataset.tone = actionTone;
  panel.textContent = pendingLabel || actionMessage;
}

function setConnection(connected) {
  const changed = online !== connected;
  if (changed && !connected) feedback.resetBaseline();
  online = connected;
  $('connection-state').textContent = connected ? '已连接' : '重新连接中';
  $('connection-state').classList.toggle('offline', !connected);
  $('connection-banner').hidden = connected || !identity;
  $('connection-banner').textContent = '连接已中断，正在自动重连。恢复后即可继续操作。';
  if (state && changed) render();
  if (connected && changed && hadConnection && !uncertainAction && state) {
    actionMessage = '已连接，按当前任务继续。';
    actionTone = 'info';
    renderActionFeedback();
  }
  hadConnection ||= connected;
}

async function api(path, body, signal) {
  let response;
  try {
    response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  } catch {
    const error = new Error('暂时无法连接房间，请检查网络后重试。');
    error.network = true;
    throw error;
  }
  let result;
  try { result = await response.json(); }
  catch {
    const error = new Error(response.ok ? '响应尚未完整收到，正在确认进度。' : `操作未被接受（${response.status}），请检查当前进度。`);
    error.network = response.ok;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(result.error || '操作未能完成，请重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function showEntryPanel(panel) {
  for (const id of ['entry-status', 'access-form', 'entry-form']) $(id).hidden = id !== panel;
}

function showEntryRetry(message, retry) {
  showEntryPanel('entry-status');
  $('entry-status-text').textContent = message;
  $('entry-retry').hidden = false;
  entryRetry = retry;
}

async function checkEntryAccess() {
  showEntryPanel('entry-status');
  $('entry-status-text').textContent = '请稍候，正在检查入席许可。';
  $('entry-retry').hidden = true;
  try {
    const access = await api('/api/access');
    showEntryPanel(access.required && !access.authorized ? 'access-form' : 'entry-form');
  } catch (error) {
    showEntryRetry(`${error.message} 请重试。`, checkEntryAccess);
  }
}

async function redeemAccess() {
  if (accessPending || !$('access-code').reportValidity()) return;
  accessPending = true;
  $('redeem-access').disabled = true;
  $('error-banner').hidden = true;
  try {
    await api('/api/access/redeem', { code: $('access-code').value.trim() });
    $('access-code').value = '';
    showEntryPanel('entry-form');
    $('nickname').focus();
  } catch (error) { showError(error); }
  finally { accessPending = false; $('redeem-access').disabled = false; }
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
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(pollTimer);
  pollTimer = null;
  pollController?.abort();
  pollController = null;
}

async function returnToEntry(message = '') {
  help.clear();
  resetDrafts();
  feedback.clear();
  resetMapVisit();
  mapContext?.hidePopover();
  selectedMapCorner = selectedMapRoom = '';
  $('room-menu').hidePopover();
  $('table-seats').hidePopover();
  $('setup-seats').replaceChildren();
  chat.reset?.();
  currentView = 'action';
  actionCategory = '';
  viewScroll.clear();
  renderedStep = '';
  actionMessage = '';
  pendingLabel = '';
  uncertainAction = false;
  hadConnection = false;
  disconnect();
  state = null;
  saveSession(null);
  leavingIdentity = null;
  online = false;
  pending = false;
  $('create-room').disabled = false;
  $('join-room').disabled = false;
  $('room-view').hidden = true;
  $('entry-view').hidden = false;
  $('connection-banner').hidden = true;
  $('error-banner').hidden = !message;
  if (message) showError(message);
  document.title = '箱娃 · 旧宅入席';
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  await checkEntryAccess();
}

function verifyIdentity(session) {
  if (!session || identity !== session) return Promise.resolve(false);
  if (identityCheck?.session === session) return identityCheck.promise;
  const check = { session };
  check.promise = (async () => {
    try {
      const query = new URLSearchParams({ playerId: session.playerId, token: session.token });
      await api(`/api/rooms/${session.roomCode}?${query}`, undefined, AbortSignal.timeout(10000));
    } catch (error) {
      if (identity === session && (error.status === 403 || error.status === 404)) {
        await returnToEntry(leavingIdentity === session ? '' : '当前座位已失效，请重新加入房间。');
        return true;
      }
    }
    return false;
  })().finally(() => { if (identityCheck === check) identityCheck = null; });
  identityCheck = check;
  return check.promise;
}

function connect() {
  disconnect();
  setConnection(false);
  const session = identity;
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
        if (!online || uncertainAction || JSON.stringify(next) !== JSON.stringify(state)) receiveState(next);
        setConnection(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnection(false);
        if (error.status === 403 || error.status === 404) {
          if (identity === session) await returnToEntry(leavingIdentity === session ? '' : '当前座位已失效，请重新加入房间。');
          return;
        }
      }
      if (!controller.signal.aborted) pollTimer = setTimeout(poll, 1000);
    }
    poll();
    return;
  }
  const connection = new EventSource(`/api/rooms/${identity.roomCode}/events?${sessionQuery()}`);
  stream = connection;
  connection.onopen = () => { if (stream === connection && identity === session) setConnection(true); };
  connection.addEventListener('state', event => {
    if (stream !== connection || identity !== session) return;
    try {
      receiveState(JSON.parse(event.data));
      setConnection(true);
    } catch (error) { showError(error); }
  });
  connection.onerror = () => {
    if (stream !== connection || identity !== session) return;
    setConnection(false);
    verifyIdentity(session);
    // HTTP errors can close EventSource permanently instead of retrying it.
    if (connection.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (stream === connection && identity === session) connect();
      }, 1000);
    }
  };
}

function receiveState(next) {
  // A POST response can arrive after a newer SSE event.
  if (state && next.version < state.version) return;
  const restored = state && next.version > state.version && (next.undo?.steps < state.undo?.steps
    || next.log?.at(-1) !== state.log?.at(-1) && /(?:撤销了上一步|已撤销上一步)/.test(next.log?.at(-1) || ''));
  const switched = state && (state.code !== next.code || state.you !== next.you
    || state.phase !== 'lobby' && next.phase === 'lobby');
  if (restored || switched) {
    resetDrafts();
    resetMapVisit();
    renderedStep = '';
    viewScroll.clear();
    mapContext?.hidePopover();
    selectedMapCorner = selectedMapRoom = '';
  }
  if (uncertainAction) {
    uncertainAction = false;
    actionMessage = '已取得最新进度，请检查当前任务和物品后继续。';
    actionTone = 'info';
  }
  if (state && state.phase !== 'lobby' && next.phase === 'lobby') {
    feedback.clear();
    activeFloor = 1;
    selectedMapCorner = '';
    selectedMapRoom = '';
    mapContext?.hidePopover();
  }
  if (next.phase === 'map_setup' && next.setup.turnPlayerId !== next.you && next.setup.preview?.placement
      && next.setup.preview.revision !== state?.setup?.preview?.revision) activeFloor = next.setup.preview.placement.floor;
  if (state && next.version === state.version) {
    if ((next.chat?.revision || 0) < (state.chat?.revision || 0)) next.chat = state.chat;
    if (next.setup?.drawnTileId === state.setup?.drawnTileId
        && next.setup?.turnPlayerId === state.setup?.turnPlayerId
        && (next.setup?.preview?.revision || 0) < (state.setup?.preview?.revision || 0)) {
      next.setup.preview = state.setup.preview;
    }
  }
  const enteredRound = !state?.round && next.round;
  const changedStep = state && stepKey(state) !== stepKey(next);
  const gameEnded = !state?.round?.result && next.round?.result;
  if (mapVisit && (gameEnded || state?.round?.visitors.find(player => player.id === state.you)?.status
      !== next.round?.visitors.find(player => player.id === next.you)?.status)) leaveMapVisit();
  if (changedStep) actionCategory = '';
  state = next;
  if (enteredRound) {
    const self = mapPlayers(next).find(player => player.id === next.you);
    const placement = self && placementForRoom(self.roomId);
    if (placement) activeFloor = placement.floor;
  }
  if (changedStep && submittedStep && submittedStep !== stepKey(next)) {
    currentView = 'action';
    submittedStep = '';
    requestAnimationFrame(() => navigateGame('action'));
  }
  if (next.phase === 'lobby' || next.phase === 'hako_selection' || enteredRound || gameEnded) currentView = 'action';
  const key = next.setup ? `${next.setup.turnPlayerId}:${next.setup.drawnTileId}` : '';
  if (key !== tileTurnKey) {
    tileTurnKey = key;
    rotation = 0;
    selected = null;
    lastPreviewSent = '';
    const first = next.setup?.legalPlacements?.[0];
    if (first && next.setup.turnPlayerId === next.you) {
      selected = { ...first };
      rotation = first.rotation;
      activeFloor = first.floor;
    }
  }
  render();
  help.receive(next);
  feedback.receive(next);
  if (enteredRound) requestAnimationFrame(() => {
    const marker = [...$('tile-board').querySelectorAll('.map-player-marker')].find(marker => marker.dataset.playerId === state.you);
    centerMapTarget(compactScreen.matches && currentView !== 'map' ? marker : marker?.closest('.placed-tile'));
  });
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
    const result = await api(join ? `/api/rooms/${encodeURIComponent(code)}/join` : '/api/rooms', {
      name, ...(!join ? { playerCount: Number($('player-count').value) } : {}),
    });
    saveSession({ roomCode: result.roomCode, playerId: result.playerId, token: result.token });
    receiveState(result.state);
    const url = new URL(location.href);
    url.searchParams.set('room', result.roomCode);
    history.replaceState(null, '', url);
    connect();
  } catch (error) {
    if (error.status === 401) showEntryPanel('access-form');
    showError(error);
  }
  finally {
    pending = false;
    $('create-room').disabled = false;
    $('join-room').disabled = false;
    if (state) render();
  }
}

async function action(type, payload = {}) {
  if (pending || !online || !identity || uncertainAction) return;
  const session = identity;
  const request = structuredClone({ playerId: session.playerId, token: session.token,
    type, ...payload, expectedVersion: state.version });
  $('room-menu').hidePopover();
  if (type === 'leave') leavingIdentity = session;
  pending = true;
  submittedStep = stepKey(state);
  pendingLabel = `${document.activeElement?.textContent?.trim().slice(0, 35) || '操作'}：正在提交…`;
  actionMessage = '';
  uncertainAction = false;
  $('error-banner').hidden = true;
  render();
  try {
    const next = await api(`/api/rooms/${session.roomCode}/actions`, request);
    if (identity !== session) return;
    if (type === 'leave') await returnToEntry();
    else receiveState(next.state || next);
  } catch (error) {
    if (identity !== session) return;
    if ((type === 'leave' || error.status === 403 || error.status === 404) && await verifyIdentity(session)) return;
    if (identity === session && error.network) {
      uncertainAction = true;
      actionMessage = '正在确认最新进度，请勿重复提交刚才的操作。';
      actionTone = 'attention';
      setConnection(false);
      try {
        const latest = await api(`/api/rooms/${session.roomCode}?${sessionQuery()}`);
        if (identity === session) {
          receiveState(latest.state || latest);
          uncertainAction = false;
          actionMessage = '已取得最新进度，请检查当前任务和物品后继续。';
          setConnection(true);
        }
      } catch { /* The normal stream/poll recovery will retrieve the latest state. */ }
    } else if (identity === session) showError(error);
  } finally {
    if (leavingIdentity === session) leavingIdentity = null;
    if (identity === session) { pending = false; pendingLabel = ''; submittedStep = ''; if (state) render(); }
  }
}

function renderSeats(container, compact = false) {
  const fragment = document.createDocumentFragment();
  const locations = compact ? mapPlayers(state) : [];
  const focusedPlayer = compact && container.contains(document.activeElement) && document.activeElement.dataset.playerId;
  for (let seat = 0; seat < (state.playerCount || 4); seat++) {
    const player = state.players.find(p => p.seat === seat);
    const visitor = state.round?.visitors.find(visitor => visitor.id === player?.id);
    const visitorStatus = visitor?.status;
    const isGhost = visitorStatus === 'box_person';
    const isBanished = visitorStatus === 'banished';
    const roundActive = state.round && !state.round.result && (state.round.silent?.turnPlayerId === player?.id && !isGhost && !isBanished || ['initial_hiding', 'visitor_reaction', 'hako_reaction', 'hako_phase'].includes(state.round.phase) && state.round.hako.playerId === player?.id && !state.round.hako.finished || state.round.phase === 'hako_phase' && player?.id === state.you && isGhost && !state.round.ghost?.finished);
    const active = player && (state.round ? roundActive : state.draft ? state.draft.turnPlayerId === player.id : state.opening ? state.opening.hakoId === player.id : state.setup?.turnPlayerId === player.id);
    const item = node('li', `seat${!player ? ' empty' : player.role === 'hako' || isGhost ? ' hako' : ''}${isBanished ? ' banished' : ''}${active ? ' active' : ''}`);
    const mark = node('span', 'seat-mark', compact ? String(seat + 1) : !player ? '候' : player.role === 'hako' || isGhost ? '箱' : isBanished ? '离' : '访');
    mark.setAttribute('aria-hidden', 'true');
    if (compact) item.classList.add(`seat-color-${seat}`);
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
      if (compact && Number.isInteger(visitor?.itemCount) && Number.isInteger(visitor?.tokenCount)) {
        meta.append(node('span', '', `技能 ${visitor.itemCount} · 标志 ${visitor.tokenCount}`));
      }
    } else meta.append(node('span', '', '等待朋友或人机'));
    info.append(meta);
    item.append(info);
    if (player) {
      const preparationStatus = state.draft ? '随机发牌' : state.opening ? player.role === 'hako' ? '配置中' : '正门等候' : null;
      const status = !player.connected ? '暂离' : compact ? roundSeatStatus(state, player) || preparationStatus || (active ? state.setup?.drawnTileId ? '摆放中' : '当前轮次' : player.role === 'hako' ? '观图' : '等待') : player.ready ? '已准备' : '未准备';
      const position = locations.find(value => value.id === player.id);
      const statusCell = node('div', 'seat-state');
      const location = position && rosterLocation(position);
      if (status !== location?.textContent) statusCell.append(node('span', `seat-status${!player.connected ? ' disconnected' : player.ready ? ' ready' : ''}`, status));
      if (location) statusCell.append(location);
      if (compact) item.append(statusCell);
      else item.append(...statusCell.childNodes);
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
  if (focusedPlayer) container.querySelector(`button[data-player-id="${CSS.escape(focusedPlayer)}"]`)?.focus({ preventScroll: true });
}

function renderLobby() {
  const playerCount = state.playerCount || 4;
  const countName = playerCount === 5 ? '五人' : '四人';
  const you = state.players.find(p => p.id === state.you);
  const selecting = state.phase === 'hako_selection';
  const host = state.hostId === state.you;
  const hasBots = state.players.some(player => player.isBot);
  const locked = pending || !online;
  renderSeats($('lobby-seats'));
  $('lobby-title').textContent = selecting ? '谁来扮演箱娃？' : '人齐，便可进宅。';
  $('game-end-notice').textContent = state.endNotice || '';
  $('game-end-notice').hidden = selecting || !state.endNotice;
  $('lobby-count').textContent = `${state.players.length} / ${playerCount} 人入席`;
  $('visitor-role-count').textContent = playerCount === 5 ? '四名访问者' : '三名访问者';
  $('hako-role-guide').textContent = `${countName}准备并开始游戏后一起抢选，先抢先得。地图完成后，配置开局秘密与初始潜伏。`;
  $('ready-button').textContent = you?.ready ? '取消准备' : '准备';
  $('ready-button').disabled = locked || !you;
  $('ready-button').hidden = selecting;
  $('start-setup').hidden = !host || selecting;
  $('start-setup').disabled = locked || state.players.length !== playerCount || !state.players.every(p => p.ready && p.connected);
  $('add-bots').hidden = !host || selecting || state.players.length === playerCount;
  $('add-bots').disabled = locked || !host || selecting || state.players.length === playerCount;
  $('start-hint').hidden = selecting;
  $('start-hint').textContent = state.players.length < playerCount ? `还差 ${playerCount - state.players.length} 席，可邀请朋友${host ? '，或点击补齐人机一起试玩' : '，也可由房主补齐人机'}。` : !state.players.every(p => p.ready) ? hasBots ? '人机已自动准备，其他玩家准备后，房主即可开始游戏。' : `${countName}都准备后，房主即可开始游戏，一起抢箱娃。` : host ? '都已准备，开始游戏后一起抢箱娃。' : '都已准备，等待房主开始游戏后一起抢箱娃。';
  $('hako-claim-controls').hidden = !selecting;
  $('claim-hako').disabled = locked || !you || !selecting;
  $('bot-claim-hako').hidden = !selecting || !host || !hasBots;
  $('bot-claim-hako').disabled = locked || !you || !selecting || !host || !hasBots;
  $('hako-claim-status').textContent = hasBots ? `${countName}已准备，可抢当箱娃，也可由房主让人机扮演箱娃。` : `${countName}已准备，点击按钮抢当箱娃，先抢先得。`;
  $('leave-room').disabled = locked;
  $('leave-room').hidden = selecting;
}

function canPlace() {
  return online && !pending && !state.undo?.pending && state.phase === 'map_setup' && state.setup.turnPlayerId === state.you;
}

function queueMapPreview() {
  if (!canPlace() || !state.setup.drawnTileId || previewSending) return;
  const value = { tileId: state.setup.drawnTileId, rotation, placement: selected };
  const signature = JSON.stringify([state.version, value]);
  if (signature === lastPreviewSent) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!canPlace() || !state.setup.drawnTileId) return;
    previewSending = true;
    const payload = { tileId: state.setup.drawnTileId, rotation, placement: selected };
    lastPreviewSent = JSON.stringify([state.version, payload]);
    try {
      await api(`/api/rooms/${identity.roomCode}/actions`, { playerId: identity.playerId,
        token: identity.token, type: 'preview_map', expectedVersion: state.version, ...payload });
    } catch (error) { if (error.status !== 409) showError(error); }
    finally { previewSending = false; queueMapPreview(); }
  }, 100);
}

function legalForRotation() {
  return (state.setup?.legalPlacements || []).filter(p => p.rotation === rotation);
}

function samePosition(a, b) {
  return a && b && a.floor === b.floor && a.x === b.x && a.y === b.y && a.rotation === b.rotation;
}

function chooseLegalPlacement({ floor = activeFloor, rotate = false } = {}) {
  const all = state.setup?.legalPlacements || [];
  const choices = all.filter(position => position.floor === floor);
  const pool = choices.length ? choices : all;
  for (let step = rotate ? 1 : 0; step < (rotate ? 5 : 4); step++) {
    const angle = (rotation + step) % 4;
    const legal = pool.filter(position => position.rotation === angle);
    const match = legal.find(position => position.x === selected?.x && position.y === selected?.y) || legal[0];
    if (match) {
      selected = { ...match };
      rotation = match.rotation;
      activeFloor = match.floor;
      return;
    }
  }
  selected = null;
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
    body.append(list);
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
        const choice = node('button', 'corner-guide-choice');
        choice.type = 'button';
        choice.dataset.localControl = 'true';
        choice.setAttribute('aria-label', cornerName(corner.id));
        choice.append(node('span', 'corner-guide-number', cornerNumber(corner.id)),
          node('span', 'corner-guide-name', corner.id.startsWith('suitcase:') ? '行李箱中' : corner.name));
        choice.addEventListener('click', () => {
          guideExpanded = false;
          updateCornerGuide();
          const marker = mapAnchor(corner.id, null);
          centerMapTarget(marker);
          selectMapLocation(corner.id, cornerRoomId(corner.id));
          (mapVisit ? $('map-context-title') : mapContext?.querySelector('button'))?.focus({ preventScroll: true });
        });
        entry.append(choice);
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

compactScreen.addEventListener('change', () => { guideExpanded = false; updateCornerGuide(); });

function placementForRoom(roomId) {
  return state?.setup?.placements.find(placement => getTile(placement.tileId).rooms
    .some(room => getLogicalRoomId(room.id) === getLogicalRoomId(roomId)) || roomId === 'entrance' && placement.tileId === 'hall');
}

function centerMapTarget(target) {
  if (!target) return;
  const viewport = $('board-viewport');
  const view = viewport.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  viewport.scrollTo({ left: viewport.scrollLeft + rect.left - view.left - (viewport.clientWidth - rect.width) / 2,
    top: viewport.scrollTop + rect.top - view.top - (viewport.clientHeight - rect.height) / 2 });
}

function locateSelf() {
  const player = mapPlayers(state).find(player => player.id === state.you);
  const placement = player && placementForRoom(player.roomId);
  if (!placement) return;
  activeFloor = placement.floor;
  $('tile-board').style.removeProperty('--tile-size');
  renderMapFloor();
  const marker = [...$('tile-board').querySelectorAll('.map-player-marker')].find(marker => marker.dataset.playerId === state.you);
  centerMapTarget(compactScreen.matches && currentView !== 'map' ? marker : marker?.closest('.placed-tile'));
}

function fitMap() {
  const cells = [...$('tile-board').querySelectorAll('.board-cell')];
  if (!cells.length) return;
  const positions = cells.map(cell => ({ x: Number(cell.dataset.x), y: Number(cell.dataset.y) }));
  const cols = Math.max(...positions.map(p => p.x)) - Math.min(...positions.map(p => p.x)) + 1;
  const rows = Math.max(...positions.map(p => p.y)) - Math.min(...positions.map(p => p.y)) + 1;
  const viewport = $('board-viewport');
  const size = Math.max(64, Math.min(180, (viewport.clientWidth - 32) / cols, (viewport.clientHeight - 32) / rows));
  $('tile-board').style.setProperty('--tile-size', `${size}px`);
  centerMapTarget($('tile-board'));
}

function renderBoard() {
  const setup = state.setup;
  const showTargets = canPlace() && Boolean(setup.drawnTileId);
  const targets = showTargets ? legalForRotation().filter(p => p.floor === activeFloor) : [];
  const placements = setup.placements.filter(p => p.floor === activeFloor);
  const extraCorners = state.round?.extraCorners || [];
  const players = mapPlayers(state);
  const announcement = state.round?.powers?.announcement;
  const contents = { cornerState: state.round?.cornerState, review: state.round?.review?.corners };
  const remotePreview = setup.turnPlayerId !== state.you && setup.preview?.placement?.floor === activeFloor
    ? setup.preview : null;
  const key = JSON.stringify([activeFloor, placements, targets, selected, setup.drawnTileId, rotation, extraCorners, players, announcement, remotePreview, contents]);
  if (key === boardKey) return;
  boardKey = key;
  const board = $('tile-board');
  const fragment = document.createDocumentFragment();
  const positions = [...placements, ...targets, ...(remotePreview ? [remotePreview.placement] : [])];
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
      cell.append(createTileSvg(placement.tileId, placement.rotation, extraCorners, players, announcement, contents));
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
    if (remotePreview) {
      const cell = node('div', 'board-cell shared-map-preview');
      cell.dataset.testid = 'shared-map-preview';
      cell.dataset.rotation = remotePreview.rotation;
      cell.dataset.tileId = remotePreview.tileId;
      cell.style.gridColumn = remotePreview.placement.x - minX + 1;
      cell.style.gridRow = remotePreview.placement.y - minY + 1;
      cell.setAttribute('aria-label', '其他玩家正在预览，尚未确认摆放');
      cell.append(createTileSvg(remotePreview.tileId, remotePreview.rotation));
      fragment.append(cell);
    }
  }
  board.replaceChildren(fragment);
  renderCornerGuide(placements, extraCorners);
  paintMapSelection();
}

function mapAnchor(cornerId, roomId) {
  if (cornerId) return $('tile-board').querySelector(`.corner-location[data-corner-id="${CSS.escape(cornerId)}"]`);
  return roomId && [...$('tile-board').querySelectorAll('.room-shape')].find(room => getLogicalRoomId(room.dataset.roomId) === roomId);
}

function selectMapCorner(event, openContext = true) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  const corner = event.target.closest('.corner-location');
  const marker = event.target.closest('.map-player-marker');
  const room = event.target.closest('[data-room-id]');
  if (!corner && !room) return;
  if (!event.target.closest('.placed-tile')) return;
  event.preventDefault();
  event.stopPropagation();
  const cornerId = corner?.dataset.cornerId || marker?.dataset.cornerId || '';
  selectMapLocation(cornerId, cornerId ? cornerRoomId(cornerId) : getLogicalRoomId(room.dataset.roomId), openContext);
}

function selectMapLocation(cornerId, roomId, open = true) {
  if (mapVisit) Object.assign(mapVisit, { cornerId, roomId });
  else {
    selectedMapCorner = cornerId;
    selectedMapRoom = roomId;
  }
  paintMapSelection();
  renderMapContext(open);
}

function paintMapSelection() {
  const cornerId = mapVisit ? mapVisit.cornerId : selectedMapCorner;
  const roomId = mapVisit ? mapVisit.roomId : selectedMapRoom;
  for (const mark of $('tile-board').querySelectorAll('.corner-location')) mark.classList.toggle('selected-corner', mark.dataset.cornerId === cornerId);
  for (const room of $('tile-board').querySelectorAll('.room-shape')) room.classList.toggle('selected-room', !cornerId && getLogicalRoomId(room.dataset.roomId) === roomId);
  let name = $('selected-corner-name');
  if (!name && roomId) {
    name = node('span', 'selected-corner-name');
    name.id = 'selected-corner-name';
    name.dataset.testid = 'selected-corner-name';
    name.setAttribute('role', 'status');
    $('board-help').parentElement.append(name);
  }
  if (name) name.textContent = cornerId ? cornerName(cornerId) : getLogicalRooms().find(value => value.id === roomId)?.name || '';
  for (const entry of document.querySelectorAll('.corner-guide-entry')) {
    entry.querySelector('button').setAttribute('aria-pressed', String(entry.dataset.cornerId === cornerId));
  }
  if (!mapVisit) for (const target of document.querySelectorAll('#practice-panel [data-corner-id], #opening-panel [data-corner-id]')) {
    target.classList.toggle('map-target-selected', target.dataset.cornerId === selectedMapCorner);
  }
}
$('tile-board').addEventListener('click', selectMapCorner);
$('tile-board').addEventListener('keydown', selectMapCorner);

function ensureMapContext() {
  if (!mapContext) {
    mapContext = node('section', 'map-context');
    mapContext.id = 'map-context';
    mapContext.dataset.testid = 'map-context';
    mapContext.setAttribute('popover', 'auto');
    mapContext.setAttribute('aria-labelledby', 'map-context-title');
    document.body.append(mapContext);
  }
}

function renderMapContext(open = false) {
  if (mapVisit) { renderMapVisit(); return; }
  if (!selectedMapRoom || !open && !mapContext?.matches(':popover-open')) return;
  ensureMapContext();
  const fragment = document.createDocumentFragment();
  const header = node('div', 'map-context-heading');
  const title = node('h3', '', selectedMapCorner ? cornerName(selectedMapCorner) : getLogicalRooms().find(value => value.id === selectedMapRoom)?.name || '地图位置');
  title.id = 'map-context-title';
  const close = node('button', 'text-button', '收起');
  close.type = 'button';
  close.addEventListener('click', () => mapContext.hidePopover());
  header.append(title, close);
  fragment.append(header);
  const round = state.round;
  const review = round?.review?.corners.find(corner => corner.id === selectedMapCorner);
  const publicCorner = round?.cornerState?.find(corner => corner.id === selectedMapCorner);
  const resolution = round?.resolution;
  if (review) {
    fragment.append(node('p', 'map-context-content', mapTokenName(review.token)));
    for (const actor of review.actors || []) fragment.append(node('p', 'small-note', `${state.players.find(player => player.id === actor.playerId)?.name || '玩家'} · ${actor.type === 'hako' ? '箱娃' : '箱人'}${actor.carriedTokens?.length ? `；暂存：${actor.carriedTokens.map(token => mapTokenName(token)).join('、')}` : ''}`));
    if (review.underToken) fragment.append(node('p', 'small-note', `被替换棋子：${mapTokenName(review.underToken)}`));
    fragment.append(node('p', 'section-meta', '终局盘面 · 全员可见'));
  } else if (resolution?.playerId === state.you && resolution.cornerId === selectedMapCorner && resolution.token) {
    fragment.append(node('p', 'map-context-content', mapTokenName(resolution.token)), node('p', 'section-meta', '你的本次窥探结果'));
  } else if (publicCorner?.faceUp && publicCorner.token?.type === 'empty_box') {
    fragment.append(node('p', 'map-context-content', '空箱 · X面朝上'), node('p', 'small-note', '全员可见；仍可窥探。箱娃或箱人潜入后可以重新盖放。'));
  }
  for (const entry of round?.publicDiscoveries || []) {
    if (entry.cornerId && entry.cornerId === selectedMapCorner) {
      fragment.append(node('p', 'small-note', `曾在此发现${mapTokenName(entry.token)}（第${entry.cycle}轮公开）`));
    }
  }
  for (const death of (round?.deathLocations || []).filter(value => value.cornerId === selectedMapCorner)) {
    fragment.append(node('p', 'small-note', `${state.players.find(player => player.id === death.userId)?.name || '玩家'}死亡于此，已转为箱人。这是死亡时位置，后续潜伏仍保密。`));
  }
  const controls = node('div', 'map-context-actions');
  const locked = pending || !online || Boolean(state.undo?.pending || round?.result);
  const find = testid => document.querySelector(`[data-testid="${testid}"]`);
  const options = [];
  const add = (label, testid, selections = {}, extras = []) => {
    const target = find(testid);
    if (target) options.push({ label, target, selections, extras });
  };
  const selectedCorner = selectedMapCorner;
  if (selectedCorner) {
    if (round?.peekTargets?.includes(selectedCorner)) add('确认窥探此角落', 'peek-target', {}, ['peek-use-night-vision']);
    if (round?.weaponTargets?.includes(selectedCorner) && round.weapons?.length) add('确认讨伐此角落', 'use-weapon', { 'weapon-corner-select': selectedCorner }, ['weapon-select']);
    if (resolution?.kind === 'forced_peek' && resolution.cornerIds?.includes(selectedCorner)) add('确认强制窥探', 'choose-forced-peek', { 'forced-peek-target': selectedCorner }, ['forced-peek-use-night-vision']);
    const isHako = round?.hako.playerId === state.you;
    const actor = isHako ? round?.hako : round?.ghost;
    if (actor?.hidingTargets?.includes(selectedCorner)) add('确认潜伏于此', isHako ? 'confirm-hiding' : 'confirm-ghost-hiding', { [isHako ? 'hiding-select' : 'ghost-hiding-select']: selectedCorner },
      [...document.querySelectorAll('[data-testid="hide-face-down"]')].map(input => input.id));
    if (state.opening?.hidingTargets?.includes(selectedCorner)) add('确认初始潜伏', 'confirm-initial-hiding', { 'initial-hiding-select': selectedCorner });
    if (state.opening?.remainsTargets?.includes(selectedCorner)) add('确认放置亡骸', 'confirm-remains', { 'remains-select': selectedCorner });
  }
  if (!selectedCorner) {
    if (round?.moveTargets?.includes(selectedMapRoom)) add('确认移动至此房间', 'move-target');
    for (const [selectId, testid] of [['hiding-room-select', 'inspect-hiding-room'], ['ghost-hiding-room-select', 'ghost-inspect-hiding-room'], ['initial-room-select', 'inspect-initial-room']]) {
      const select = $(selectId);
      if (select && [...select.options].some(option => option.value === selectedMapRoom)) add('选择此房间潜伏', testid, { [selectId]: selectedMapRoom });
    }
  }
  for (const option of options) {
    const group = node('div', 'map-context-choice');
    for (const id of option.extras) {
      const original = $(id);
      if (!original) continue;
      const label = node('label', original.type === 'checkbox' ? 'inline-check' : '');
      const input = original.cloneNode(true);
      input.id = `map-${id}`;
      input.removeAttribute('data-testid');
      input.value = original.value;
      input.checked = original.checked;
      input.disabled = locked || original.disabled;
      input.addEventListener('change', () => { original.value = input.value; original.checked = input.checked; original.dispatchEvent(new Event('change')); });
      label.append(input, document.createTextNode(original.dataset.testid === 'hide-face-down' ? `重新盖放${cornerNumber(original.dataset.cornerId)}的X` : original.type === 'checkbox' ? '使用夜视仪' : '选择讨伐道具'));
      group.append(label);
    }
    const confirm = node('button', 'button primary small', option.label);
    confirm.type = 'button';
    confirm.dataset.testid = 'map-confirm-action';
    confirm.disabled = locked || option.target.disabled;
    confirm.addEventListener('click', () => {
      if (pending || !online || state.undo?.pending || state.round?.result) return;
      for (const [id, value] of Object.entries(option.selections)) {
        const select = $(id);
        if (!select || ![...select.options].some(option => option.value === value)) return;
        select.value = value;
        select.dispatchEvent(new Event('change'));
      }
      const target = option.target.dataset.testid === 'peek-target' ? [...document.querySelectorAll('[data-testid="peek-target"]')].find(button => button.dataset.cornerId === selectedCorner)
        : option.target.dataset.testid === 'move-target' ? [...document.querySelectorAll('[data-testid="move-target"]')].find(button => button.dataset.roomId === selectedMapRoom) : option.target;
      mapContext.hidePopover();
      if (target && !target.disabled) target.click();
    });
    group.append(confirm);
    controls.append(group);
  }
  if (!options.length && !review) controls.append(node('p', 'small-note', locked ? '当前无法执行游戏操作，可继续查看地图。' : selectedCorner ? '此处暂无可执行操作。可在右侧查看当前回应与结算。' : '点击房内角落可查看位置及可用操作。'));
  fragment.append(controls);
  mapContext.replaceChildren(fragment);
  if (open && !mapContext.matches(':popover-open')) mapContext.showPopover();
  positionMapContext();
}

function positionMapContext() {
  if (!mapContext?.matches(':popover-open')) return;
  const viewport = $('board-viewport').getBoundingClientRect();
  const anchor = selectedMapCorner ? document.querySelector(`#tile-board .corner-location[data-corner-id="${CSS.escape(selectedMapCorner)}"]`) : document.querySelector(`#tile-board .room-shape[data-room-id="${CSS.escape(selectedMapRoom)}"]`);
  if (!anchor && mapContext.matches(':popover-open')) { mapContext.hidePopover(); return; }
  const point = anchor?.getBoundingClientRect() || viewport;
  const bounds = mapContext.getBoundingClientRect();
  mapContext.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, point.right + 8))}px`;
  mapContext.style.top = `${Math.max(8, Math.min(innerHeight - bounds.height - 8, point.top))}px`;
}
window.addEventListener('resize', positionMapContext);
window.addEventListener('scroll', positionMapContext, { passive: true });
$('board-viewport').addEventListener('scroll', positionMapContext, { passive: true });

function openMapVisit(detail, review = false) {
  const { cornerId = '', roomId = cornerRoomId(cornerId) } = detail;
  const placement = placementForRoom(roomId);
  if (!placement) return;
  const viewport = $('board-viewport');
  const origin = {
    view: currentView, source: detail.source || document.activeElement, previous: mapVisit,
    sidebarScroll: document.querySelector('.setup-sidebar').scrollTop,
    pageScroll: window.scrollY, floor: activeFloor, left: viewport.scrollLeft, top: viewport.scrollTop,
    zoom: $('tile-board').style.getPropertyValue('--tile-size'), guideExpanded, guideScroll: $('corner-guide')?.scrollTop || 0,
  };
  mapVisit = { detail, origin, review, cornerId, roomId, originalCorner: cornerId, originalRoom: roomId };
  if (mapContext?.matches(':popover-open')) mapContext.hidePopover();
  guideExpanded = false;
  activeFloor = placement.floor;
  navigateGame('map');
  renderMapFloor();
  updateCornerGuide();
  paintMapSelection();
  centerMapTarget(mapAnchor(cornerId, roomId) || mapAnchor('', roomId));
  $('map-context-title').focus({ preventScroll: true });
}

function renderMapVisit() {
  ensureMapContext();
  if (mapContext.hasAttribute('popover')) {
    mapContext.removeAttribute('popover');
    mapContext.classList.add('map-history-context');
    $('board-viewport').after(mapContext);
  }
  const { detail, originalCorner, originalRoom, cornerId, roomId, review } = mapVisit;
  $('map-focus').textContent = detail.returnLabel || '返回记录';
  const title = cornerId ? cornerName(cornerId) : getLogicalRooms().find(room => room.id === roomId)?.name || '房间位置';
  const original = originalCorner === cornerId && originalRoom === roomId;
  const lines = [];
  if (original && detail.record) {
    lines.push(detail.record);
    if (detail.description) lines.push(detail.description);
  } else if (review) {
    const corner = state.round?.review?.corners?.find(entry => entry.id === cornerId);
    if (corner) {
      lines.push(mapTokenName(corner.token));
      for (const actor of corner.actors || []) {
        const name = state.players.find(player => player.id === actor.playerId)?.name || '玩家';
        lines.push(`${name} · ${actor.type === 'hako' ? '箱娃' : '箱人'}${actor.carriedTokens?.length ? `，暂存${actor.carriedTokens.map(token => mapTokenName(token)).join('、')}` : ''}`);
      }
      if (corner.underToken) lines.push(`被替换棋子 · ${mapTokenName(corner.underToken)}`);
    }
  } else if (cornerId) {
    for (const entry of state.round?.publicDiscoveries || []) {
      if (entry.cornerId === cornerId) lines.push(`曾在此发现${mapTokenName(entry.token)}（第${entry.cycle}轮公开）`);
    }
    if (!lines.length) lines.push('此处尚无公开发现记录。');
  }
  const scope = review ? '复盘地图' : '历史位置';
  const key = JSON.stringify([scope, title, lines]);
  if (mapVisit.rendered === key) return;
  mapVisit.rendered = key;
  const heading = node('h3', '', title);
  heading.id = 'map-context-title';
  heading.tabIndex = -1;
  mapContext.replaceChildren(node('span', 'section-meta', scope), heading,
    ...lines.map(line => node('p', 'map-history-text', line)));
}

function resetMapVisit() {
  if (!mapVisit) return;
  mapVisit = null;
  mapContext.classList.remove('map-history-context');
  mapContext.replaceChildren();
  mapContext.setAttribute('popover', 'auto');
  document.body.append(mapContext);
  $('map-focus').textContent = currentView === 'map' ? '返回操作' : '专看地图';
}

function restoreMapPosition(origin) {
  activeFloor = origin.floor;
  guideExpanded = origin.guideExpanded;
  $('tile-board').style.setProperty('--tile-size', origin.zoom);
  renderMapFloor();
  updateCornerGuide();
  paintMapSelection();
  if ($('corner-guide')) $('corner-guide').scrollTop = origin.guideScroll;
  $('board-viewport').scrollTo(origin.left, origin.top);
}

function leaveMapVisit() {
  if (!mapVisit) return;
  let { origin } = mapVisit;
  while (origin.previous) origin = origin.previous.origin;
  resetMapVisit();
  restoreMapPosition(origin);
}

function returnFromMapVisit() {
  const { detail, origin } = mapVisit;
  resetMapVisit();
  mapVisit = origin.previous;
  if (mapVisit) mapVisit.rendered = '';
  navigateGame(origin.view);
  restoreMapPosition(origin);
  if (detail.restore) detail.restore();
  else {
    const source = origin.source;
    const target = source?.isConnected ? source : source?.id && $(source.id);
    if (target?.getClientRects().length) target.focus({ preventScroll: true });
  }
  document.querySelector('.setup-sidebar').scrollTop = origin.sidebarScroll;
  window.scrollTo(window.scrollX, origin.pageScroll);
}

document.addEventListener('hako:locate-corner', event => { if (event.detail?.cornerId) openMapVisit(event.detail); });
document.addEventListener('game-view-change', () => {
  if (mapVisit && currentView === 'map') $('map-focus').textContent = mapVisit.detail.returnLabel || '返回记录';
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mapVisit && !document.querySelector('dialog[open], :popover-open')) {
    event.preventDefault();
    returnFromMapVisit();
  }
});

function rosterLocation(player) {
  const room = getLogicalRooms().find(room => room.id === getLogicalRoomId(player.roomId));
  const where = room?.name || '正门';
  const visibility = player.death ? '死亡时公开' : player.revealed ? '终局公开' : player.peeking ? '本次窥探，仅你可见' : '箱娃方可见';
  const label = player.cornerId ? `${where} · ${cornerNumber(player.cornerId)}（${visibility}）` : where;
  const button = node('button', 'text-button map-position', label);
  button.type = 'button';
  button.dataset.uiControl = '';
  button.dataset.playerId = player.id;
  button.dataset.roomId = player.roomId;
  if (player.kind === 'visitor') button.dataset.testid = 'visitor-location';
  button.setAttribute('aria-label', `在地图上查看${player.name}的位置，${label}`);
  button.addEventListener('click', () => {
    const placement = placementForRoom(player.roomId);
    if (!placement) return;
    $('table-seats').hidePopover();
    if (currentView !== 'map') navigateGame('map');
    activeFloor = placement.floor;
    renderMapFloor();
    const marker = [...$('tile-board').querySelectorAll('.map-player-marker')].find(mark => mark.dataset.playerId === player.id);
    centerMapTarget(marker?.closest('.placed-tile'));
  });
  return button;
}

function renderSetup() {
  const setup = state.setup;
  $('board-section').hidden = !setup;
  $('map-progress').hidden = !setup || Boolean(state.round || state.opening);
  $('setup-view').classList.toggle('has-round', Boolean(state.round || state.opening));
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
  const shownRotation = mine ? rotation : setup.preview?.rotation ?? 0;
  $('map-count').replaceChildren(document.createTextNode(setup.placements.length), node('span', '', '/ 9'));
  $('turn-seat').textContent = complete ? '九块齐备' : mine ? '你的轮次' : '等待访问者';
  $('drawn-title').textContent = complete ? '宅邸已现' : drawn ? '本次抽到' : '轮流抽板';
  const previewKey = `${setup.drawnTileId}:${shownRotation}:${complete}`;
  if ($('drawn-preview').dataset.key !== previewKey) {
    const preview = $('drawn-preview');
    preview.dataset.key = previewKey;
    preview.classList.toggle('completed-preview', complete);
    if (drawn) preview.replaceChildren(createTileSvg(drawn.id, shownRotation));
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
  const shownPosition = mine ? selected : setup.preview?.placement;
  $('selection-description').textContent = drawn && shownPosition ? `${mine ? '' : '实时预览 · '}${floorName(shownPosition.floor)} · 位置 ${shownPosition.x}, ${shownPosition.y} · ${shownRotation * 90}°` : '';
  $('drawn-title').closest('.turn-panel').hidden = complete;
  $('map-complete').hidden = !complete || Boolean(round || state.opening);
  $('prepare-opening').hidden = state.hostId !== state.you;
  $('prepare-opening').disabled = pending || !online;
  $('opening-start-hint').textContent = state.hostId === state.you ? '准备好后，配置角落标志并由箱娃选择开局秘密。' : '等待房主开始开局配置。';
  $('board-help').textContent = round ? round.result ? '本局结束 · 可查看完整盘面复盘' : '圆标为玩家座位号 · 潜伏位置仅箱娃方可见' : state.opening ? '访问者在正门待入场 · 标志保持盖放' : complete ? '访问者在正门等待入场' : mine && drawn ? '虚线位置可摆放 · 点击切换预览' : '在地图区域内滚动查看';
  renderMapFloor();
  applyUndoLock(state);
  queueMapPreview();
}

function renderMapFloor() {
  const setup = state.setup;
  for (const button of $('floor-tabs').querySelectorAll('button')) {
    const floor = Number(button.dataset.floor);
    button.setAttribute('aria-selected', String(floor === activeFloor));
    button.tabIndex = floor === activeFloor ? 0 : -1;
    $(`floor-count-${floor}`).textContent = setup.placements.filter(p => p.floor === floor).length || '';
    button.disabled = canPlace() && Boolean(setup.drawnTileId) && !setup.legalPlacements.some(position => position.floor === floor);
  }
  renderBoard();
  renderMapContext();
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
    if (round.walkie?.pairRequest) {
      const request = round.walkie.pairRequest;
      return task(request.targetId === state.you ? '请回应对讲机邀请' : '等待同伴接受配对', description, request.targetId, '[data-testid="walkie-controls"]');
    }
    if (round.walkie?.showRequest) {
      const confirmed = round.walkie.showRequest.confirmedIds.includes(state.you);
      return task(confirmed ? '等待同伴确认展示' : '请确认对讲机展示', description, confirmed ? round.walkie.partnerId : state.you, '[data-testid="walkie-controls"]');
    }
    const incoming = round.exchangeOffers?.find(offer => offer.targetId === state.you);
    if (incoming && freeActionWindow(round)) {
      const kind = incoming.requestTokenIds?.length || incoming.requestItemIds?.length ? '交换' : '赠送';
      return task(`请回应${name(incoming.fromId)}的${kind}`, '', state.you, `[data-offer-id="${CSS.escape(String(incoming.id))}"]`);
    }
    if (['visitor_reaction', 'hako_reaction'].includes(round.phase)) return task(round.hako.playerId === state.you ? round.phase === 'visitor_reaction' ? '请确认访问者行动' : '请结束反应窗口' : '等待箱娃确认', description, round.hako.playerId, '.current-response, [data-testid="pass-noise-reaction"]');
    if (round.phase === 'hako_phase') {
      const actor = round.hako.playerId === state.you ? round.hako : round.ghost;
      if (round.hako.playerId === state.you && round.powers?.rearrangement) return task('请完成房间标志重排', description, state.you, '[data-testid="power-rearrangement"]');
      if (round.hako.playerId === state.you && round.powers?.pathRooms?.length) return task('请选择NO.2移动路线', description, state.you, '.hako-sequence');
      const ghostWaiting = round.ghost && actor === round.ghost && actor.status !== 'banished' && !actor.finished && !actor.inspectedRoom && !actor.hidingRooms?.length;
      if (ghostWaiting && round.hako.playerId !== state.you) return task('等待箱娃开始潜伏', '箱娃完成阶段能力并选择潜伏房间后，才轮到你选择潜伏位置。', round.hako.playerId, '.practice-controls');
      const mine = actor && actor.status !== 'banished' && !actor.finished && (round.powers?.step !== 'preparation' || round.hako.playerId === state.you);
      return task(mine ? round.powers?.step === 'preparation' ? '轮到你准备能力' : actor.inspectedRoom ? '请选择潜伏角落' : '轮到你行动与潜伏' : '等待箱娃与箱人行动', description, mine ? state.you : round.hako.finished ? null : round.hako.playerId, '.hako-sequence');
    }
    const actor = round.silent?.turnPlayerId;
    return task(actor === state.you ? round.phase === 'visitor_reveal' ? '轮到你翻牌' : '轮到你行动' : `等待${name(actor)}${round.phase === 'visitor_reveal' ? '翻牌' : '行动'}`, description, actor, round.phase === 'visitor_reveal' ? '.silent-section' : '.standard-actions, .practice-controls');
  }
  if (state.opening) {
    const titles = { secrets: '请设置密码与弱点', remains: '请放置亡骸', hiding_room: '请选择开局潜伏房间', hiding_corner: '请选择初始潜伏角落', power: '请选择初始能力' };
    return task(state.opening.hakoId === state.you ? titles[state.opening.phase] || '请配置开局秘密' : '等待箱娃配置开局', preparationDescription(state), state.opening.hakoId, '#opening-panel');
  }
  if (state.draft) return task('正在随机分发技能', preparationDescription(state), null, '#draft-panel');
  if (state.setup?.phase === 'map_ready') return task(state.hostId === state.you ? '地图齐备，可以入宅' : '等待房主开始配置', '九块地图已就位，下一步配置角落标志与开局秘密。', state.hostId, '#map-complete');
  const actor = state.setup?.turnPlayerId;
  const drawn = state.setup?.drawnTileId;
  return task(actor === state.you ? drawn ? '请摆放这块地图' : '轮到你抽取地图' : `等待${name(actor)}${drawn ? '摆放' : '抽取'}地图`, actor === state.you ? drawn ? '选择旋转方向和虚线位置，预览后确认摆放。' : '先抽取一块地图，再决定放在哪里。' : '可先浏览地图，轮到你时会在这里提示。', actor, '.turn-panel');
}

function renderGameStatus() {
  const task = currentTask();
  const round = state.round;
  $('setup-title').textContent = task.title;
  $('turn-description').textContent = task.description;
  $('turn-description').hidden = !task.mine || !task.description || Boolean(round?.result);
  const visitorTurn = round && ['visitor_action', 'visitor_reveal'].includes(round.phase) ? round.silent?.turnPlayerId : null;
  const actor = visitorTurn || task.actor;
  const name = state.players.find(player => player.id === actor)?.name;
  $('turn-owner').textContent = actor === state.you ? '你的回合' : name ? `${name}的回合` : '';
  $('turn-owner').hidden = !visitorTurn || visitorTurn === task.actor || !name;
  $('stage-name').textContent = round ? round.result ? '终局' : round.phase === 'hako_phase' ? '箱娃阶段' : '探索' : state.opening ? '开局配置' : state.draft ? '发牌' : '拼图';
  $('noise-count').hidden = !round?.silent || Boolean(round.result);
  if (round?.silent) $('noise-count').textContent = `无声累计 ${round.silent.total} / 10`;
  $('game-status').classList.toggle('needs-attention', Boolean(task.mine && online));
  $('focus-current-action').hidden = !task.target || currentView === 'action';
  $('focus-current-action').textContent = round?.result ? '查看复盘' : task.mine ? '前往处理' : '返回对局';
  $('seats-toggle').textContent = `座次 · ${state.playerCount || 4}`;
  const you = state.players.find(player => player.id === state.you);
  $('personal-status').hidden = !you;
  const visitor = round?.visitors.find(player => player.id === state.you);
  const isHako = you?.role === 'hako';
  $('personal-role').textContent = `${(you?.seat ?? 0) + 1}号 · ${isHako ? '箱娃' : visitor?.status === 'box_person' ? '箱人' : visitor?.status === 'banished' ? '已被消灭' : '访问者'}`;
  $('focus-inventory').setAttribute('aria-label', isHako ? '查看我的能力' : '查看我的物品');
  const location = mapPlayers(state).find(player => player.id === state.you);
  const room = location && getLogicalRooms().find(room => room.id === getLogicalRoomId(location.roomId));
  $('personal-location').textContent = location ? `${room?.name || '正门'}${location.cornerId ? ` · ${cornerNumber(location.cornerId)}（${round?.result ? '复盘公开' : location.death ? '死亡时公开' : location.peeking ? '本次窥探，仅你可见' : '箱娃方可见'}）` : ''}` : '';
  $('round-context').textContent = round ? `总回合 ${round.totalRounds ?? 0}` : '';
  const layout = taskLayout(task);
  $('setup-view').dataset.layout = layout;
  $('waiting-activity').hidden = layout !== 'waiting' || !state.log?.length;
  $('latest-activity').textContent = $('activity-log').lastElementChild?.textContent || '';
}

function taskLayout(task) {
  const round = state.round;
  if (round?.result) return 'review';
  if (!task.mine) return 'waiting';
  if (state.undo?.pending || round?.interruption) return 'form';
  if (state.opening) return ['remains', 'hiding_room', 'hiding_corner'].includes(state.opening.phase) ? 'map' : 'form';
  if (!round) return state.setup?.phase === 'map_ready' ? 'form' : 'map';
  if (round.resolution) return round.resolution.kind === 'forced_peek' ? 'map' : 'form';
  if (round.walkie?.pairRequest || round.walkie?.showRequest || task.target?.startsWith('[data-offer-id')) return 'form';
  if (round.phase === 'visitor_action') return actionCategory === 'item' ? 'form' : 'map';
  if (round.phase === 'hako_phase') return round.powers?.step === 'preparation' ? 'form' : 'map';
  return 'form';
}

const paneIds = { action: 'action-pane', inventory: 'inventory-pane', public: 'public-pane', chat: 'messages-pane' };

function showPane() {
  const map = currentView === 'map';
  $('setup-view').dataset.panel = currentView;
  $('setup-view').classList.toggle('map-focused', map);
  for (const [view, id] of Object.entries(paneIds)) $(id).hidden = view !== currentView;
  for (const button of $('game-navigation').querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === currentView));
  }
  $('map-focus').setAttribute('aria-pressed', String(map));
  if (!map) $('map-focus').textContent = '专看地图';
}

function focusGameSection(selector) {
  const target = [...document.querySelectorAll(selector)].find(element => !element.closest('[hidden]'));
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', inline: 'nearest' });
}

function navigateGame(view, target) {
  if (!state || !(Object.hasOwn(paneIds, view) || ['map', 'review'].includes(view))) return;
  if (view !== 'map') leaveMapVisit();
  const sidebar = document.querySelector('.setup-sidebar');
  if (currentView !== 'map') viewScroll.set(currentView, sidebar.scrollTop);
  currentView = view === 'review' ? 'action' : view;
  if (currentView === 'action' && target?.startsWith('#action-')) actionCategory = target.slice(8);
  showPane();
  if (currentView === 'map') $('map-focus').textContent = '返回操作';
  renderGameStatus();
  document.dispatchEvent(new CustomEvent('game-view-change', { detail: { view: currentView } }));
  if (currentView === 'map') return;
  if (view === 'review') target ||= '.game-result';
  if (target) focusGameSection(target);
  else sidebar.scrollTop = viewScroll.get(currentView) || 0;
}

function setEntryMode(mode) {
  entryMode = mode;
  $('entry-form').dataset.mode = mode;
  $('entry-create').setAttribute('aria-pressed', String(mode === 'create'));
  $('entry-join').setAttribute('aria-pressed', String(mode === 'join'));
  $('entry-form-title').textContent = mode === 'join' ? '加入朋友的房间' : '创建一间旧宅';
  $('entry-form-description').textContent = mode === 'join'
    ? requestedRoom ? `朋友邀请你加入房间 ${requestedRoom.toUpperCase()}。请填写昵称入席。` : '填写昵称和朋友发来的房间码，即可入席。'
    : '选择四人或五人，邀请朋友，也可补齐人机试玩。';
}

function render() {
  if (!state) return;
  const sidebar = document.querySelector('.setup-sidebar');
  const saved = captureView(sidebar);
  const nextStep = stepKey(state);
  $('entry-view').hidden = true;
  $('room-view').hidden = false;
  $('room-code-display').textContent = state.code;
  $('room-mode-label').textContent = `${state.playerCount === 5 ? '五人' : '四人'}联机 · 无声模式`;
  const lobby = state.phase === 'lobby' || state.phase === 'hako_selection';
  $('room-view').classList.toggle('in-game', !lobby);
  $('lobby-view').hidden = !lobby;
  $('setup-view').hidden = lobby;
  const phaseName = state.phase === 'lobby' ? '等待入席' : state.phase === 'hako_selection' ? '抢选箱娃' : state.round ? state.round.result ? '本局结束' : state.round.mode === 'exploration' ? '旧宅探索' : '基础回合' : state.opening ? '开局准备' : state.draft ? '随机分发技能' : state.phase === 'map_ready' ? '地图已拼好' : '地图拼接';
  document.title = `箱娃 · ${state.code} · ${phaseName}`;
  $('room-phase-label').textContent = `箱娃 · ${phaseName}`;
  if (lobby) {
    $('table-seats').hidePopover();
    $('setup-seats').replaceChildren();
    renderLobby();
  }
  else {
    renderGamePanels({ state, pending, online, action });
    renderSetup();
    renderSeats($('setup-seats'), true);
    $('activity-log').replaceChildren(...state.log.slice(-8).map(message => node('li', '', typeof message === 'string' ? message : message.message || message.text || '房间状态已更新')));
  }
  renderUndo({ state, pending, online, action });
  if (!lobby) renderGameStatus();
  chat.render(state, online);
  $('game-navigation').hidden = lobby;
  showPane();
  restoringView = true;
  try {
    restoreView(sidebar, saved, renderedStep === nextStep);
  } finally {
    restoringView = false;
  }
  if (renderedStep !== nextStep) {
    viewScroll.delete('action');
    if (currentView === 'action') sidebar.scrollTop = 0;
  }
  applyUndoLock(state);
  renderMapContext();
  help.addMenuButton($('room-menu-content'));
  renderedStep = nextStep;
  renderActionFeedback();
  if (state.undo?.pending) $('room-menu').hidePopover();
}

$('focus-current-action').addEventListener('click', () => navigateGame(state.round?.result ? 'review' : 'action', currentTask().target));
$('focus-inventory').addEventListener('click', () => navigateGame('inventory'));
$('open-table-log').addEventListener('click', () => {
  $('table-log').open = true;
  navigateGame('public', '#table-log');
});
$('entry-form').addEventListener('submit', event => { event.preventDefault(); enterRoom(entryMode === 'join'); });
$('access-form').addEventListener('submit', event => { event.preventDefault(); redeemAccess(); });
$('entry-retry').addEventListener('click', () => { if (entryRetry) entryRetry(); });
$('map-focus').addEventListener('click', () => {
  if (mapVisit) returnFromMapVisit();
  else navigateGame(currentView === 'map' ? 'action' : 'map');
});
$('game-navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) navigateGame(button.dataset.view);
});
document.addEventListener('game-navigate', event => navigateGame(event.detail.view, event.detail.target));
document.addEventListener('game-selection-expired', () => {
  actionMessage = '可选目标已变化，请重新选择后再提交。';
  actionTone = 'attention';
  renderActionFeedback();
});
document.addEventListener('map-target', event => {
  if (state?.round?.result) openMapVisit({ returnLabel: '返回复盘', ...event.detail }, true);
});
function previewActionTarget(event) {
  if (mapVisit) return;
  const control = event.target;
  if (restoringView || !control.closest?.('#practice-panel, #opening-panel') || control.closest('.game-review') || currentView !== 'action') return;
  const cornerId = control.dataset.cornerId || (control.tagName === 'SELECT' && cornerName(control.value) !== '尚未选择' ? control.value : null);
  const roomId = control.dataset.roomId || (control.tagName === 'SELECT' && getLogicalRooms().some(room => room.id === control.value) ? control.value : null);
  if (!cornerId && !roomId) return;
  const room = roomId || getLogicalRooms().find(room => room.corners.some(corner => corner.id === cornerId))?.id
    || (cornerId?.startsWith('suitcase:') ? cornerId.slice(9) : null);
  const placement = room && placementForRoom(room);
  if (!placement) return;
  activeFloor = placement.floor;
  renderBoard();
  for (const tab of $('floor-tabs').querySelectorAll('button')) {
    tab.setAttribute('aria-selected', String(Number(tab.dataset.floor) === activeFloor));
    tab.tabIndex = Number(tab.dataset.floor) === activeFloor ? 0 : -1;
  }
  const mark = cornerId && $('tile-board').querySelector(`.corner-location[data-corner-id="${CSS.escape(cornerId)}"]`);
  if (mark) selectMapCorner({ type: 'click', target: mark, preventDefault() {}, stopPropagation() {} }, false);
  centerMapTarget(mark || [...$('tile-board').querySelectorAll('.placed-tile')].find(tile => tile.dataset.tileId === placement.tileId));
}
document.addEventListener('focusin', previewActionTarget);
document.addEventListener('change', previewActionTarget);
$('entry-create').addEventListener('click', () => setEntryMode('create'));
$('entry-join').addEventListener('click', () => setEntryMode('join'));
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
$('leave-room').addEventListener('click', () => action('leave', { endGame: true }));
$('draw-tile').addEventListener('click', () => action('draw'));
$('rotate-tile').addEventListener('click', () => {
  if (!canPlace()) return;
  chooseLegalPlacement({ rotate: true });
  renderSetup();
});
$('confirm-placement').addEventListener('click', () => { if (selected) action('place', { ...selected }); });
$('floor-tabs').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  activeFloor = Number(button.dataset.floor);
  if (canPlace() && state.setup.drawnTileId) {
    chooseLegalPlacement();
    renderSetup();
  } else renderMapFloor();
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
setEntryMode(requestedRoom ? 'join' : 'create');

const menuButton = node('button', 'event-history-toggle', '房间操作');
menuButton.type = 'button';
menuButton.id = 'room-menu-toggle';
menuButton.dataset.testid = 'room-menu-toggle';
menuButton.setAttribute('popovertarget', 'room-menu');
document.querySelector('.room-tools').append(menuButton);
for (const [id, label, handler] of [['locate-self', '定位自己', locateSelf], ['fit-map', '查看全图', fitMap]]) {
  const button = node('button', 'text-button', label);
  button.type = 'button';
  button.id = id;
  button.dataset.uiControl = '';
  button.addEventListener('click', handler);
  document.querySelector('.map-toolbar-actions').prepend(button);
}
for (const element of document.querySelectorAll('#floor-tabs button, #focus-current-action, #focus-inventory, #map-focus')) element.dataset.uiControl = '';
$('event-history-toggle').firstChild.textContent = '事件 ';

function updateKeyboardViewport() {
  const viewport = window.visualViewport;
  const keyboard = viewport && document.activeElement?.matches('input, textarea') && innerHeight - viewport.height > 150;
  document.documentElement.classList.toggle('keyboard-open', Boolean(keyboard));
  document.documentElement.style.setProperty('--visible-height', `${viewport?.height || innerHeight}px`);
  if (keyboard && document.activeElement?.matches('input, textarea')) {
    document.activeElement.scrollIntoView({ block: 'nearest' });
  }
}
window.visualViewport?.addEventListener('resize', updateKeyboardViewport);
window.addEventListener('resize', updateKeyboardViewport);
updateKeyboardViewport();

async function resume(stored = storedSession(requestedRoom?.toUpperCase())) {
  if (!stored?.roomCode || !stored.playerId || !stored.token) { await checkEntryAccess(); return; }
  showEntryPanel('entry-status');
  $('entry-status-text').textContent = '请稍候，正在恢复已保存的座位。';
  $('entry-retry').hidden = true;
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
      await checkEntryAccess();
    } else {
      showEntryRetry(`暂时无法恢复入席：${error.message} 原座位身份已保留。`, () => resume(stored));
    }
  } finally {
    pending = false;
    $('create-room').disabled = false;
    $('join-room').disabled = false;
    if (state) render();
  }
}

resume();
