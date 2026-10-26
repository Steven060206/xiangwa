import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSetup, drawTile, placeTile, getSetupView } from './game.mjs';

const BODY_LIMIT = 64 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const staticFiles = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['../public/style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
  ['/tile.js', ['../public/tile.js', 'text/javascript; charset=utf-8']],
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

/** In-memory rooms. Each successful action is synchronous after its JSON body arrives. */
export function createGameServer({ deck } = {}) {
  const rooms = new Map();
  const streams = new Set();
  let closing = false;

  function roomFor(code) {
    const room = rooms.get(code.toUpperCase());
    if (!room) fail(404, '房间不存在，请检查房间码。');
    return room;
  }

  function authorize(room, credentials) {
    const player = room.players.find(player => player.id === credentials.playerId);
    if (!player || !sameToken(credentials.token, player.token)) fail(403, '身份验证失败，请重新加入房间。');
    return player;
  }

  function snapshot(room, playerId) {
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.game?.phase ?? 'lobby',
      players: room.players.map(({ id, name, role, ready, connections, seat }) => ({
        id, name, role, ready, connected: connections.size > 0, seat,
      })),
      you: playerId,
      setup: room.game ? getSetupView(room.game) : null,
      log: [...room.log],
      version: room.version,
    };
  }

  function publish(room, message) {
    if (message) {
      room.log.push(message);
      if (room.log.length > 64) room.log.shift();
    }
    room.version += 1;
    for (const player of room.players) {
      const event = `event: state\ndata: ${JSON.stringify(snapshot(room, player.id))}\n\n`;
      for (const response of player.connections) response.write(event);
    }
  }

  function addPlayer(room, name) {
    const occupied = new Set(room.players.map(player => player.seat));
    const player = {
      id: randomUUID(), name,
      token: randomBytes(32).toString('base64url'),
      role: room.players.length ? 'visitor' : 'hako',
      ready: false,
      seat: [0, 1, 2, 3].find(seat => !occupied.has(seat)),
      connections: new Set(),
    };
    room.players.push(player);
    room.players.sort((a, b) => a.seat - b.seat);
    if (!room.hostId) room.hostId = player.id;
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
    const inLobby = () => {
      if (room.game) fail(409, '地图准备已经开始，无法进行此房间操作。');
    };
    const hostOnly = () => {
      if (room.hostId !== player.id) fail(403, '只有房主可以进行此操作。');
    };
    let message;
    switch (input.type) {
      case 'ready':
        inLobby();
        if (typeof input.ready !== 'boolean') fail(400, '准备状态必须为 true 或 false。');
        player.ready = input.ready;
        message = `${player.name}${player.ready ? ' 已准备。' : ' 取消了准备。'}`;
        break;
      case 'set_hako': {
        hostOnly();
        inLobby();
        const target = room.players.find(candidate => candidate.id === input.targetId);
        if (!target) fail(400, '请选择房间内的玩家。');
        if (target.role === 'hako') return snapshot(room, player.id);
        for (const candidate of room.players) {
          candidate.role = candidate.id === target.id ? 'hako' : 'visitor';
          candidate.ready = false;
        }
        message = `${target.name} 将扮演箱娃，请重新准备。`;
        break;
      }
      case 'start': {
        hostOnly();
        inLobby();
        if (room.players.length !== 4 || !room.players.every(candidate => candidate.ready)) {
          fail(409, '需要四名玩家全部准备后才能开始。');
        }
        const hakoSeat = room.players.findIndex(candidate => candidate.role === 'hako');
        const ordered = [...room.players.slice(hakoSeat + 1), ...room.players.slice(0, hakoSeat)];
        room.game = createSetup(ordered.map(candidate => candidate.id), { deck });
        message = '四人已就座，访问者开始轮流配置地图。';
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
      case 'leave': {
        inLobby();
        const wasHako = player.role === 'hako';
        room.players = room.players.filter(candidate => candidate.id !== player.id);
        for (const response of player.connections) response.end();
        player.connections.clear();
        if (room.hostId === player.id) room.hostId = room.players[0]?.id ?? null;
        if (wasHako && room.players.length) room.players[0].role = 'hako';
        for (const candidate of room.players) candidate.ready = false;
        if (!room.players.length) rooms.delete(room.code);
        message = `${player.name} 离开了房间。`;
        break;
      }
      default:
        fail(400, '未知操作。');
    }
    publish(room, message);
    return snapshot(room, player.id);
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (closing) fail(503, '服务正在关闭。');
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;
      const isGet = request.method === 'GET';
      if (pathname === '/api/health') {
        if (!isGet) fail(405, '此接口仅支持 GET。');
        sendJson(response, 200, { ok: true });
        return;
      }
      if (pathname === '/api/rooms') {
        if (request.method !== 'POST') fail(405, '此接口仅支持 POST。');
        const input = await readJson(request);
        const name = nickname(input.name);
        const code = newRoomCode();
        const room = { code, hostId: null, players: [], game: null, log: [], version: 0 };
        rooms.set(code, room);
        sendJson(response, 201, addPlayer(room, name));
        return;
      }
      const match = /^\/api\/rooms\/([a-z0-9]{6})(?:\/(join|actions|events))?$/i.exec(pathname);
      if (match) {
        const [, code, endpoint] = match;
        const expectedMethod = endpoint === 'join' || endpoint === 'actions' ? 'POST' : 'GET';
        if (request.method !== expectedMethod) fail(405, `此接口仅支持 ${expectedMethod}。`);
        const room = roomFor(code);
        if (endpoint === 'join') {
          const input = await readJson(request);
          const name = nickname(input.name);
          if (room.game) fail(409, '地图准备已开始，无法加入新玩家。');
          if (room.players.length >= 4) fail(409, '房间已满，最多四名玩家。');
          sendJson(response, 201, addPlayer(room, name));
          return;
        }
        if (endpoint === 'actions') {
          const input = await readJson(request);
          const player = authorize(room, input);
          sendJson(response, 200, runAction(room, player, input));
          return;
        }
        const player = authorize(room, Object.fromEntries(url.searchParams));
        if (endpoint !== 'events') {
          sendJson(response, 200, snapshot(room, player.id));
          return;
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
        if (!wasConnected) publish(room);
        else response.write(`event: state\ndata: ${JSON.stringify(snapshot(room, player.id))}\n\n`);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
        heartbeat.unref();
        response.on('close', () => {
          clearInterval(heartbeat);
          streams.delete(response);
          player.connections.delete(response);
          if (!closing && !player.connections.size && room.players.includes(player)) publish(room);
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
      if (!response.headersSent) sendJson(response, error.status ?? 500, {
        error: error.status ? error.message : '服务器暂时无法处理请求，请重试。',
      });
      else response.end();
    }
  });

  // SSE responses must end before Node can finish closing the HTTP server.
  const close = server.close.bind(server);
  server.close = callback => {
    closing = true;
    for (const response of streams) response.end();
    return close(callback);
  };
  return server;
}
