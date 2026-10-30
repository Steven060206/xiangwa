import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Socket responses are process-local; all game state is plain JSON data.
export function copyRoom(room) {
  const copy = structuredClone({ ...room, players: room.players.map(({ connections, ...player }) => player) });
  copy.players = copy.players.map(player => ({ ...player,
    connections: room.players.find(original => original.id === player.id).connections,
  }));
  return copy;
}

export function createRoomStore(filePath) {
  if (filePath === undefined) return { load: () => new Map(), save() {} };
  const file = resolve(filePath);

  return {
    load() {
      let source;
      try { source = readFileSync(file, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') return new Map();
        throw new Error(`无法读取房间存档 ${file}：${error.message}`, { cause: error });
      }
      try {
        const data = JSON.parse(source);
        if (data.format !== 1 || !Array.isArray(data.rooms)) throw new Error('不支持的存档格式');
        const rooms = new Map();
        for (const room of data.rooms) {
          if (room.playerCount === undefined) room.playerCount = 4;
          if (!/^[A-Z2-9]{6}$/.test(room.code) || rooms.has(room.code)
              || ![4, 5].includes(room.playerCount)
              || !Number.isSafeInteger(room.version) || room.version < 0 || !Array.isArray(room.log)
              || room.log.some(entry => typeof entry !== 'string')
              || !Array.isArray(room.players) || !room.players.length || room.players.length > room.playerCount
              || !room.players.some(player => player.id === room.hostId && !player.isBot)
              || new Set(room.players.map(player => player.id)).size !== room.players.length
              || new Set(room.players.map(player => player.seat)).size !== room.players.length
              || (room.selectingHako !== undefined && typeof room.selectingHako !== 'boolean')
              || room.players.filter(player => player.role === 'hako').length > 1
              || (room.selectingHako && (room.draft || room.game || room.opening || room.play
                || room.players.length !== room.playerCount || room.players.some(player => !player.ready || player.role === 'hako')))
              || (room.draft && !room.players.some(player => player.role === 'hako'))) {
            throw new Error('房间数据无效');
          }
          if ((room.undoHistory !== undefined && (!Array.isArray(room.undoHistory) || room.undoHistory.length > 40
              || room.undoHistory.some(entry => !entry?.before || !Array.isArray(entry.before.players)
                || !Array.isArray(entry.before.log) || typeof entry.actorId !== 'string'
                || typeof entry.type !== 'string' || typeof entry.label !== 'string'
                || typeof entry.direct !== 'boolean'
                || entry.before.players.length !== room.players.length
                || entry.before.players.some(saved => !room.players.some(player => player.id === saved.id)
                  || !['visitor', 'hako'].includes(saved.role) || typeof saved.ready !== 'boolean'))))
              || (room.undoPaused !== undefined && typeof room.undoPaused !== 'boolean')
              || (room.undoPending != null && (typeof room.undoPending.id !== 'string'
                || typeof room.undoPending.label !== 'string' || !room.undoHistory?.length
                || !Array.isArray(room.undoPending.requiredIds) || !Array.isArray(room.undoPending.approvedIds)
                || !room.players.some(player => player.id === room.undoPending.requestedBy && !player.isBot)
                || room.undoPending.requiredIds.some(id => !room.players.some(player => player.id === id && !player.isBot))
                || room.undoPending.approvedIds.some(id => !room.undoPending.requiredIds.includes(id))))) {
            throw new Error('撤销记录无效');
          }
          for (const player of room.players) {
            if (typeof player.id !== 'string' || !player.id || typeof player.name !== 'string'
                || !player.name.trim() || typeof player.token !== 'string' || !player.token
                || !['hako', 'visitor'].includes(player.role) || typeof player.ready !== 'boolean'
                || (player.isBot !== undefined && typeof player.isBot !== 'boolean')
                || !Number.isInteger(player.seat) || player.seat < 0 || player.seat >= room.playerCount) {
              throw new Error('玩家数据无效');
            }
            player.connections = new Set();
          }
          rooms.set(room.code, room);
        }
        return rooms;
      } catch (error) {
        throw new Error(`房间存档无效，已停止启动以保留原文件 ${file}：${error.message}`, { cause: error });
      }
    },
    save(rooms) {
      const data = { format: 1, rooms: [...rooms.values()].map(room => ({ ...room,
        players: room.players.map(({ connections, ...player }) => player),
      })) };
      const temporary = `${file}.tmp`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flush: true });
        renameSync(temporary, file);
      } catch (error) {
        try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
        throw new Error(`无法保存房间存档 ${file}：${error.message}`, { cause: error });
      }
    },
  };
}
