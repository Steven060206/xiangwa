import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSetup, drawTile, placeTile, getSetupView } from './game.mjs';
import {
  createItemDraft, chooseItem, getItemDraftView, createOpening, getOpeningView,
  chooseSecrets, placeRemains, inspectInitialRoom, chooseInitialHiding, chooseInitialPower,
} from './preparation.mjs';
import { createPlay, applyPlayAction, getPlayView } from './play.mjs';
import { copyRoom, createRoomStore } from './storage.mjs';
import { chooseBotAction } from './bots.mjs';
import { checkpoint, clearUndo, rememberAction, undoView, applyUndo, membershipActions } from './undo.mjs';
import { createAccessControl, createTrafficControl } from './access.mjs';
import { sendChat, getChatView } from './chat.mjs';

const BODY_LIMIT = 64 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const staticFiles = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['../public/style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
  ['/tile.js', ['../public/tile.js', 'text/javascript; charset=utf-8']],
  ['/practice.js', ['../public/practice.js', 'text/javascript; charset=utf-8']],
  ['/exploration.js', ['../public/exploration.js', 'text/javascript; charset=utf-8']],
  ['/abilities.js', ['../public/abilities.js', 'text/javascript; charset=utf-8']],
  ['/undo.js', ['../public/undo.js', 'text/javascript; charset=utf-8']],
  ['/feedback.js', ['../public/feedback.js', 'text/javascript; charset=utf-8']],
  ['/feedback-view.js', ['../public/feedback-view.js', 'text/javascript; charset=utf-8']],
  ['/chat.js', ['../public/chat.js', 'text/javascript; charset=utf-8']],
  ['/chat.css', ['../public/chat.css', 'text/css; charset=utf-8']],
  ['/shared/maps.mjs', ['./maps.mjs', 'text/javascript; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!rejected) reject(new HttpError(413, '请求内容过大。'));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new HttpError(400, '请发送有效的 JSON 对象。'));
      }
    });
    request.on('error', () => reject(new HttpError(400, '请求中断，请重试。')));
  });
}

function nickname(value) {
  if (typeof value !== 'string') fail(400, '请输入昵称。');
  const name = value.trim();
  if (!name || Array.from(name).length > 16) fail(400, '昵称须为 1 至 16 个字符。');
  return name;
}

function sameToken(candidate, token) {
  if (typeof candidate !== 'string') return false;
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Each action saves its detached state before publishing it to HTTP/SSE clients. */
export function createGameServer({ deck, silentNumbers, createPlayState = createPlay, dataFile, botDelayMs = 700,
  accessDirectory, accessNow = Date.now, limits, runtimeId } = {}) {
  const access = accessDirectory ? createAccessControl({ directory: accessDirectory, now: accessNow }) : null;
  const traffic = accessDirectory || limits ? createTrafficControl({ limits, now: accessNow }) : null;
  const store = createRoomStore(dataFile);
  const rooms = store.load();
  const streams = new Set();
  const polling = new Map();
  const botTimers = new Map();
  const botFailures = new Map();
  const mapPreviews = new Map();
  let closing = false;
  try {
    for (const room of rooms.values()) {
      for (const player of room.players) snapshot(room, player.id);
    }
  } catch (error) {
    throw new Error(`房间存档无法恢复，已停止启动以保留原文件 ${dataFile}：${error.message}`, { cause: error });
  }

  function roomFor(code) {
    const room = rooms.get(code.toUpperCase());
    if (!room) fail(404, '房间不存在，请检查房间码。');
    return room;
  }

  function authorize(room, credentials) {
    const player = room.players.find(player => player.id === credentials.playerId);
    if (!player || player.isBot || !sameToken(credentials.token, player.token)) fail(403, '身份验证失败，请重新加入房间。');
    return player;
  }

  function snapshot(room, playerId) {
    const round = room.play ? { mode: 'exploration', ...getPlayView(room.play, playerId) } : null;
    const setup = room.game ? getSetupView(room.game) : null;
    const preview = mapPreviews.get(room.code);
    if (setup) setup.preview = preview?.key === previewKey(room) ? preview.value : null;
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.play ? round.result ? 'game_over' : 'practice' : room.opening ? 'opening_setup'
        : room.game?.phase ?? (room.draft ? 'item_draft' : room.selectingHako ? 'hako_selection' : 'lobby'),
      players: room.players.map(({ id, name, role, ready, connections, seat, isBot }) => ({
        id, name, role, ready, connected: !!isBot || connections.size > 0 || polling.has(id), seat,
        ...(isBot ? { isBot: true } : {}),
      })),
      you: playerId,
      setup,
      draft: room.draft?.phase === 'item_draft' ? getItemDraftView(room.draft) : null,
      initialItems: room.draft ? getItemDraftView(room.draft).choices : [],
      opening: room.opening && !room.play ? getOpeningView(room.opening, playerId) : null,
      round,
      initialPower: room.opening?.hakoId === playerId && room.opening?.initialPowerId ? {
        id: room.opening.initialPowerId,
        name: getOpeningView(room.opening, playerId).initialPowerName,
      } : null,
      log: [...room.log],
      version: room.version,
      undo: undoView(room, playerId),
      chat: getChatView(room, playerId),
    };
  }

  function previewKey(room) {
    const game = room.game;
    return game?.phase === 'map_setup' && game.drawnTileId
      ? `${game.turnPlayerId}:${game.drawnTileId}:${game.placements.length}` : null;
  }

  function scheduleBots(room, delay = botDelayMs) {
    const canRun = candidate => candidate && candidate.players.some(player => player.isBot)
      && !candidate.undoPending && !candidate.undoPaused
      && candidate.players.some(player => !player.isBot && (player.connections.size || polling.has(player.id)))
      && !candidate.play?.result && botFailures.get(candidate.code) !== candidate.version;
    if (closing || botTimers.has(room.code) || !canRun(room)) return;
    const timer = setTimeout(() => {
      botTimers.delete(room.code);
      const current = rooms.get(room.code);
      if (closing || !canRun(current)) return;
      try {
        for (const bot of current.players.filter(player => player.isBot)) {
          const input = chooseBotAction(snapshot(current, bot.id));
          if (!input) continue;
          const next = copyRoom(current);
          runAction(next, next.players.find(player => player.id === bot.id), input);
          break;
        }
      } catch (error) {
        console.error(`人机行动失败（房间 ${room.code}）：${error.message}`);
        if (error.status === 503) scheduleBots(current, 2500);
        else botFailures.set(room.code, current.version);
      }
    }, delay);
    timer.unref();
    botTimers.set(room.code, timer);
  }

  function publish(room, message, persist = true, advanceVersion = true) {
    if (persist) {
      if (message) {
        room.log.push(message);
        if (room.log.length > 64) room.log.shift();
      }
      if (advanceVersion) room.version += 1;
      const next = new Map(rooms);
      if (room.players.length) next.set(room.code, room);
      else next.delete(room.code);
      try { store.save(next); }
      catch (error) {
        console.error(error.message);
        fail(503, '房间保存失败，本次操作未生效。请检查服务端存档目录后重试。');
      }
      if (room.players.length) rooms.set(room.code, room);
      else {
        rooms.delete(room.code);
        clearTimeout(botTimers.get(room.code));
        botTimers.delete(room.code);
        botFailures.delete(room.code);
        mapPreviews.delete(room.code);
      }
    }
    for (const player of room.players) {
      const event = `event: state\ndata: ${JSON.stringify(snapshot(room, player.id))}\n\n`;
      for (const response of player.connections) response.write(event);
    }
    scheduleBots(room);
  }

  function createPlayer(room, name, isBot = false) {
    const occupied = new Set(room.players.map(player => player.seat));
    const player = {
      id: randomUUID(), name,
      token: randomBytes(32).toString('base64url'),
      role: 'visitor',
      ready: isBot,
      seat: [0, 1, 2, 3].find(seat => !occupied.has(seat)),
      connections: new Set(),
      ...(isBot ? { isBot: true } : {}),
    };
    room.players.push(player);
    room.players.sort((a, b) => a.seat - b.seat);
    if (!room.hostId) room.hostId = player.id;
    return player;
  }

  function addPlayer(room, name) {
    clearUndo(room);
    const player = createPlayer(room, name);
    publish(room, `${name} 加入了房间。`);
    return { roomCode: room.code, playerId: player.id, token: player.token, state: snapshot(room, player.id) };
  }

  function newRoomCode() {
    let code;
    do {
      code = [...randomBytes(6)].map(value => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
    } while (rooms.has(code));
    return code;
  }

  function runAction(room, player, input) {
    if (input.type === 'chat_send') {
      try { sendChat(room, player.id, input); }
      catch (error) { fail(409, error.message); }
      publish(room, undefined, true, false);
      return snapshot(room, player.id);
    }
    if (input.type === 'preview_map') {
      if (room.undoPending) fail(409, '请先完成撤销确认。');
      if (input.expectedVersion !== room.version || !previewKey(room)
          || room.game.turnPlayerId !== player.id || input.tileId !== room.game.drawnTileId) {
        fail(409, '地图轮次已更新，或当前未轮到你摆放。');
      }
      const legal = getSetupView(room.game).legalPlacements;
      if (!Number.isInteger(input.rotation) || input.rotation < 0 || input.rotation > 3) fail(400, '旋转角度无效。');
      const placement = input.placement;
      if (placement != null && !legal.some(target => target.rotation === input.rotation
          && target.floor === placement.floor && target.x === placement.x && target.y === placement.y)) {
        fail(409, '请选择合法的预览位置。');
      }
      const previous = mapPreviews.get(room.code);
      const value = { playerId: player.id, tileId: room.game.drawnTileId, rotation: input.rotation,
        placement: placement == null ? null : { floor: placement.floor, x: placement.x, y: placement.y, rotation: input.rotation },
        revision: (previous?.value.revision || 0) + 1 };
      mapPreviews.set(room.code, { key: previewKey(room), value });
      publish(room, undefined, false);
      return snapshot(room, player.id);
    }
    if (['undo_request', 'undo_respond', 'undo_cancel', 'undo_resume'].includes(input.type)) {
      let message;
      try {
        const onlineIds = room.players.filter(candidate => candidate.connections.size || polling.has(candidate.id)).map(candidate => candidate.id);
        message = applyUndo(room, player, input, onlineIds);
      } catch (error) { fail(409, error.message); }
      mapPreviews.delete(room.code);
      publish(room, message);
      return snapshot(room, player.id);
    }
    if (room.undoPending) fail(409, '正在等待撤销确认，请先同意、拒绝或取消撤销。');
    if (input.expectedVersion !== undefined && input.expectedVersion !== room.version) {
      fail(409, '页面进度已更新，请查看最新进度后重新操作。');
    }
    const before = checkpoint(room);
    const inLobby = () => {
      if (room.selectingHako || room.draft) fail(409, '游戏已经开始，无法进行此房间操作。');
    };
    const hostOnly = () => {
      if (room.hostId !== player.id) fail(403, '只有房主可以进行此操作。');
    };
    let message;
    switch (input.type) {
      case 'add_bots': {
        hostOnly();
        inLobby();
        if (room.players.length >= 4) fail(409, '房间已经满员。');
        while (room.players.length < 4) {
          const occupied = new Set(room.players.map(candidate => candidate.seat));
          const seat = [0, 1, 2, 3].find(index => !occupied.has(index));
          createPlayer(room, `人机${seat + 1}号`, true);
        }
        message = `${player.name} 补齐了人机，人机已准备。`;
        break;
      }
      case 'ready':
        inLobby();
        if (typeof input.ready !== 'boolean') fail(400, '准备状态必须为 true 或 false。');
        player.ready = input.ready;
        message = `${player.name}${player.ready ? ' 已准备。' : ' 取消了准备。'}`;
        break;
      case 'claim_hako':
      case 'bot_claim_hako': {
        let claimant = player;
        if (input.type === 'bot_claim_hako') {
          hostOnly();
          claimant = room.players.find(candidate => candidate.isBot);
          if (!claimant) fail(409, '房间中没有人机。');
        }
        if (room.draft) fail(409, '箱娃角色已确定，无法再次抢选。');
        if (!room.selectingHako) fail(409, '只有四人准备并开始游戏后，才可以抢当箱娃。');
        claimant.role = 'hako';
        const hakoSeat = room.players.findIndex(candidate => candidate.id === claimant.id);
        const ordered = [...room.players.slice(hakoSeat + 1), ...room.players.slice(0, hakoSeat)];
        room.draft = createItemDraft(ordered.map(candidate => candidate.id));
        room.selectingHako = false;
        message = `${claimant.name} 抢到了箱娃，访问者开始依次选择初始道具。`;
        break;
      }
      case 'start': {
        hostOnly();
        inLobby();
        if (room.players.length !== 4 || !room.players.every(candidate => candidate.ready)) {
          fail(409, '需要四名玩家全部准备后才能开始。');
        }
        for (const candidate of room.players) candidate.role = 'visitor';
        room.selectingHako = true;
        message = '四人已准备，游戏开始，大家一起抢当箱娃。';
        break;
      }
      case 'choose_item': {
        if (!room.draft) fail(409, '请先完成箱娃抢选，再选择初始道具。');
        try {
          chooseItem(room.draft, player.id, input.itemId);
          if (room.draft.phase === 'items_ready') {
            room.game = createSetup(room.draft.visitorIds, { deck });
          }
        } catch (error) { fail(409, error.message); }
        message = room.game ? '初始道具已选好，访问者开始轮流配置地图。'
          : `${player.name} 选择了初始道具。`;
        break;
      }
      case 'draw':
      case 'place':
        if (!room.game) fail(409, '请先由房主开始地图准备。');
        try {
          if (input.type === 'draw') {
            drawTile(room.game, player.id);
            message = `${player.name} 抽取了一块地图板。`;
          } else {
            placeTile(room.game, player.id, {
              floor: input.floor, x: input.x, y: input.y, rotation: input.rotation,
            });
            message = room.game.phase === 'map_ready' ? '九块地图已配置完毕。' : `${player.name} 放置了地图板。`;
          }
        } catch (error) {
          fail(409, error.message);
        }
        break;
      case 'prepare_opening': {
        hostOnly();
        if (room.game?.phase !== 'map_ready' || room.opening || room.play) {
          fail(409, '请先完成地图；开局配置只能开始一次。');
        }
        try {
          room.opening = createOpening(room.game, {
            hakoId: room.players.find(candidate => candidate.role === 'hako').id,
            itemChoices: room.draft.choices,
          });
        } catch (error) { fail(409, error.message); }
        message = '访问者在正门等待，箱娃开始秘密配置。';
        break;
      }
      case 'choose_secrets':
      case 'place_remains':
      case 'inspect_initial_room':
      case 'choose_initial_hiding':
      case 'choose_initial_power': {
        if (!room.opening || room.play) fail(409, '当前不在开局配置阶段。');
        try {
          if (input.type === 'choose_secrets') {
            chooseSecrets(room.opening, player.id, { password: input.password, weakness: input.weakness });
          } else if (input.type === 'place_remains') {
            placeRemains(room.opening, player.id, input.cornerId);
          } else if (input.type === 'inspect_initial_room') {
            inspectInitialRoom(room.opening, player.id, input.roomId);
          } else if (input.type === 'choose_initial_hiding') {
            chooseInitialHiding(room.opening, player.id, input.cornerId);
          } else {
            chooseInitialPower(room.opening, player.id, input.powerId);
            room.play = createPlayState(room.game, room.opening, { numbers: silentNumbers });
          }
        } catch (error) { fail(409, error.message); }
        message = {
          choose_secrets: '箱娃已配置密码与弱点。',
          place_remains: '箱娃已配置亡骸。',
          inspect_initial_room: '箱娃正在查看初始潜伏房间。',
          choose_initial_hiding: '箱娃已完成初始潜伏。',
          choose_initial_power: '开局配置完成，访问者进入一楼大厅，开始探索。',
        }[input.type];
        break;
      }
      case 'silent_reveal':
      case 'silent_skip':
      case 'move':
      case 'resolve_visitor_action':
      case 'pass_noise_reaction':
      case 'inspect_hiding_room':
      case 'hako_hide':
      case 'peek':
      case 'resolve_peek':
      case 'safe_guess':
      case 'use_weapon':
      case 'show_token':
      case 'show_possession':
      case 'publish_token':
      case 'offer_exchange':
      case 'respond_exchange':
      case 'drop_token':
      case 'ghost_hide':
      case 'bequeath':
      case 'use_item':
      case 'answer_item':
      case 'choose_forced_peek':
      case 'hako_cry':
      case 'set_power':
      case 'recall_power':
      case 'begin_hako_action':
      case 'activate_power':
      case 'power_rearrange':
      case 'inspect_path_room':
      case 'extinguisher_response':
      case 'surrender': {
        if (!room.play) fail(409, '请先完成开局配置。');
        try {
          room.play = applyPlayAction(room.play, player.id, input);
        }
        catch (error) { fail(409, error.message); }
        message = {
          silent_reveal: `${player.name} 翻开了一枚无声标志。`,
          silent_skip: `${player.name} 暂持一枚无声标志并跳过本回合。`,
          move: `${player.name} 声明了移动，等待箱娃确认。`,
          resolve_visitor_action: '箱娃确认，访问者的声明开始结算。',
          pass_noise_reaction: '进入箱娃阶段。',
          inspect_hiding_room: '箱娃正在查看潜伏目标房间。',
          hako_hide: '箱娃完成了本次潜伏。',
          peek: `${player.name} 声明了窥探，等待箱娃确认。`,
          resolve_peek: `${player.name} 完成了窥探处理。`,
          safe_guess: `${player.name} 完成了保险箱尝试。`,
          use_weapon: `${player.name} 声明了使用讨伐道具，等待箱娃确认。`,
          show_token: `${player.name} 向另一名访问者展示了标志。`,
          show_possession: `${player.name} 向同房访问者展示了物品。`,
          publish_token: `${player.name} 向所有玩家公开了一条发现。`,
          offer_exchange: `${player.name} 提出了物品交换。`,
          respond_exchange: `${player.name} 处理了交换请求。`,
          drop_token: `${player.name} 在空角落留下了一枚标志。`,
          ghost_hide: '一名箱人完成了潜伏。',
          bequeath: `${player.name} 完成了遗物处理。`,
          use_item: `${player.name} 声明了使用道具，等待箱娃确认。`,
          answer_item: '箱娃完成了道具询问的回答。',
          choose_forced_peek: `${player.name} 选择了强制窥探的角落。`,
          hako_cry: '箱娃声明了哭喊。',
          set_power: '箱娃盖放了一张可用能力。',
          recall_power: '箱娃回收了可用能力。',
          begin_hako_action: '访问者闭眼，箱娃开始行动。',
          activate_power: '箱娃发动了能力。',
          power_rearrange: '箱娃完成了能力处理。',
          inspect_path_room: '箱娃正在行动。',
          extinguisher_response: input.use ? `${player.name} 使用灭火器，跳过本次箱娃行动。` : '灭火器响应已完成。',
          surrender: `${player.name}${input.agree === false ? ' 撤回了投降提议。' : ' 提出了投降。'}`,
        }[input.type];
        if (room.play.round.pendingAction?.type === 'free') message = `${player.name} 声明了自由行动，等待箱娃确认。`;
        break;
      }
      case 'remove_player': {
        hostOnly();
        inLobby();
        const target = room.players.find(candidate => candidate.id === input.targetId);
        if (!target) fail(404, '该玩家已不在房间。');
        if (target.id === player.id) fail(409, '请使用离开房间退出自己的座位。');
        if (!target.isBot && (target.connections.size || polling.has(target.id))) fail(409, '该玩家已经在线，不能移除。');
        room.players = room.players.filter(candidate => candidate.id !== target.id);
        for (const candidate of room.players) candidate.ready = !!candidate.isBot;
        message = `${player.name} 移除了${target.isBot ? '人机' : '暂离玩家'} ${target.name} 的座位。`;
        break;
      }
      case 'leave': {
        inLobby();
        room.players = room.players.filter(candidate => candidate.id !== player.id);
        if (!room.players.some(candidate => !candidate.isBot)) room.players = [];
        if (room.hostId === player.id) room.hostId = room.players.find(candidate => !candidate.isBot)?.id ?? null;
        for (const candidate of room.players) candidate.ready = !!candidate.isBot;
        message = `${player.name} 离开了房间。`;
        break;
      }
      default:
        fail(400, '未知操作。');
    }
    if (membershipActions.has(input.type)) clearUndo(room);
    else rememberAction(room, before, player.id, input.type, message);
    if (!player.isBot) room.undoPaused = false;
    mapPreviews.delete(room.code);
    publish(room, message);
    if (input.type === 'leave') {
      for (const response of player.connections) response.end();
      player.connections.clear();
    }
    return snapshot(room, player.id);
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (closing) fail(503, '服务正在关闭。');
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;
      const isGet = request.method === 'GET';
      traffic?.request();
      if (traffic && request.method === 'POST' && request.headers.origin
          && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) {
        fail(403, '请从箱娃页面提交操作。');
      }
      if (pathname === '/api/health') {
        if (!isGet) fail(405, '此接口仅支持 GET。');
        sendJson(response, 200, { ok: true, ...(runtimeId ? { runtimeId } : {}) });
        return;
      }
      if (pathname === '/api/access') {
        if (!isGet) fail(405, '此接口仅支持 GET。');
        sendJson(response, 200, access?.status(request) || { required: false, authorized: true });
        return;
      }
      if (pathname === '/api/access/redeem' || pathname === '/api/access/admin') {
        if (request.method !== 'POST') fail(405, '此接口仅支持 POST。');
        if (!access) fail(404, '未启用邀请码入口。');
        traffic?.invite();
        const input = await readJson(request);
        sendJson(response, 200, pathname.endsWith('/admin') ? access.admin(request, input) : access.redeem(request, response, input.code));
        return;
      }
      if (pathname === '/api/rooms') {
        if (request.method !== 'POST') fail(405, '此接口仅支持 POST。');
        access?.require(request);
        const input = await readJson(request);
        access?.require(request);
        if (traffic && rooms.size >= traffic.limits.maxRooms) fail(503, '当前房间数已达上限，请使用已有房间或稍后重试。');
        const name = nickname(input.name);
        const code = newRoomCode();
        const room = { code, hostId: null, players: [], selectingHako: false, draft: null, game: null,
          opening: null, play: null, log: [], version: 0 };
        sendJson(response, 201, addPlayer(room, name));
        return;
      }
      const match = /^\/api\/rooms\/([a-z0-9]{6})(?:\/(join|actions|events))?$/i.exec(pathname);
      if (match) {
        const [, code, endpoint] = match;
        const expectedMethod = endpoint === 'join' || endpoint === 'actions' ? 'POST' : 'GET';
        if (request.method !== expectedMethod) fail(405, `此接口仅支持 ${expectedMethod}。`);
        if (endpoint === 'join') {
          access?.require(request);
          const input = await readJson(request);
          access?.require(request);
          const room = roomFor(code);
          if (room.undoPending) fail(409, '正在等待撤销确认，请稍后加入。');
          const name = nickname(input.name);
          if (room.selectingHako || room.draft) fail(409, '游戏已开始，无法加入新玩家。');
          if (room.players.length >= 4) fail(409, '房间已满，最多四名玩家。');
          sendJson(response, 201, addPlayer(copyRoom(room), name));
          return;
        }
        if (endpoint === 'actions') {
          const input = await readJson(request);
          const room = roomFor(code);
          const next = copyRoom(room);
          const player = authorize(next, input);
          sendJson(response, 200, runAction(next, player, input));
          return;
        }
        const room = roomFor(code);
        const player = authorize(room, Object.fromEntries(url.searchParams));
        if (endpoint !== 'events') {
          if (url.searchParams.get('poll') === '1') {
            const wasConnected = player.connections.size > 0 || polling.has(player.id);
            clearTimeout(polling.get(player.id));
            const timeout = setTimeout(() => {
              polling.delete(player.id);
              const current = rooms.get(room.code);
              const present = current?.players.find(candidate => candidate.id === player.id);
              if (!closing && present && !present.connections.size) publish(current, undefined, false);
            }, 15000);
            timeout.unref();
            polling.set(player.id, timeout);
            if (!wasConnected) publish(room, undefined, false);
          }
          sendJson(response, 200, snapshot(room, player.id));
          return;
        }
        if (traffic && (streams.size >= traffic.limits.maxStreams || player.connections.size >= traffic.limits.streamsPerPlayer)) {
          fail(429, '同步连接过多，请关闭重复页面后重试，或使用轮询同步。');
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        });
        const wasConnected = player.connections.size > 0;
        player.connections.add(response);
        streams.add(response);
        if (!wasConnected) publish(room, undefined, false);
        else response.write(`event: state\ndata: ${JSON.stringify(snapshot(room, player.id))}\n\n`);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
        heartbeat.unref();
        response.on('close', () => {
          clearInterval(heartbeat);
          streams.delete(response);
          player.connections.delete(response);
          const current = rooms.get(room.code);
          if (!closing && !player.connections.size && current?.players.some(candidate => candidate.id === player.id)) {
            publish(current, undefined, false);
          }
        });
        return;
      }
      if (pathname.startsWith('/api/')) fail(404, '接口不存在。');
      const resource = staticFiles.get(pathname);
      if (!resource) fail(404, '页面不存在。');
      if (!isGet && request.method !== 'HEAD') fail(405, '此资源仅支持 GET 或 HEAD。');
      let data;
      try {
        data = await readFile(new URL(resource[0], import.meta.url));
      } catch (error) {
        if (error.code === 'ENOENT') fail(404, '页面不存在。');
        throw error;
      }
      response.writeHead(200, {
        'content-type': resource[1], 'content-length': data.length,
        'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      request.resume();
      if (error.status === 429) response.setHeader('retry-after', '5');
      if (!response.headersSent) sendJson(response, error.status ?? 500, {
        error: error.status ? error.message : '服务器暂时无法处理请求，请重试。',
      });
      else response.end();
    }
  });
  if (traffic) {
    server.maxConnections = traffic.limits.maxConnections;
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
  }

  // SSE responses must end before Node can finish closing the HTTP server.
  const close = server.close.bind(server);
  server.close = callback => {
    closing = true;
    for (const timeout of botTimers.values()) clearTimeout(timeout);
    botTimers.clear();
    botFailures.clear();
    for (const timeout of polling.values()) clearTimeout(timeout);
    polling.clear();
    for (const response of streams) response.end();
    return close(callback);
  };
  return server;
}
