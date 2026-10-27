import { getTile, MAP_TILES, getLogicalRoomId } from '/shared/maps.mjs';

const rooms = MAP_TILES.flatMap(tile => tile.rooms);
const corners = rooms.flatMap(room => room.corners.map(corner => ({ ...corner, room })));

// Numbers identify public locations and stay fixed across floors and rotations.
export function cornerNumber(id) {
  const index = corners.findIndex(corner => corner.id === id);
  if (index >= 0) return String(index + 1).padStart(2, '0');
  const roomIndex = id?.startsWith('suitcase:') ? rooms.findIndex(room => room.id === id.slice(9)) : -1;
  return roomIndex >= 0 ? String(corners.length + roomIndex + 1) : '';
}

export function cornerName(id) {
  const corner = corners.find(corner => corner.id === id);
  const room = id?.startsWith('suitcase:') ? rooms.find(room => room.id === id.slice(9)) : corner?.room;
  return room ? `${cornerNumber(id)} · ${room.name} · ${corner?.name || '行李箱中'}` : '尚未选择';
}

export function mapPlayers(state) {
  const result = [];
  const add = (id, location, kind = 'visitor') => {
    const player = state.players.find(player => player.id === id);
    if (player && location.roomId) result.push({ id, name: player.name, seat: player.seat,
      self: id === state.you, kind, ...location });
  };
  if (state.round) {
    for (const visitor of state.round.visitors) {
      if ((!visitor.status || visitor.status === 'alive') && visitor.roomId) add(visitor.id, { roomId: visitor.roomId });
    }
    const actors = state.round.review
      ? state.round.review.corners.flatMap(corner => (corner.actors || []).map(actor => ({ ...actor, cornerId: corner.id, roomId: corner.roomId })))
      : state.round.alliedActors;
    if (actors) {
      for (const actor of actors) if (actor.status !== 'banished' && actor.cornerId) {
        add(actor.playerId, { roomId: actor.roomId, cornerId: actor.cornerId, revealed: Boolean(state.round.review) }, actor.type === 'hako' ? 'hako' : 'ghost');
      }
    } else {
      if (state.round.hako.playerId === state.you && state.round.hako.cornerId) {
        add(state.you, { roomId: state.round.hako.roomId, cornerId: state.round.hako.cornerId }, 'hako');
      }
      if (state.round.ghost?.status !== 'banished' && state.round.ghost?.cornerId) {
        add(state.you, { roomId: state.round.ghost.roomId, cornerId: state.round.ghost.cornerId }, 'ghost');
      }
    }
  } else if (state.opening || state.setup?.phase === 'map_ready') {
    for (const player of state.players.filter(player => player.role === 'visitor')) add(player.id, { roomId: 'entrance' });
    if (state.opening?.hakoId === state.you && state.opening.hidingCornerId) {
      const corner = corners.find(corner => corner.id === state.opening.hidingCornerId);
      if (corner) add(state.you, { roomId: corner.room.id, cornerId: corner.id }, 'hako');
    }
  }
  return result;
}

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, value) {
  const node = document.createElementNS(NS, tag);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
  if (value !== undefined) node.textContent = value;
  return node;
}

function rotatePoint([x, y], rotation) {
  return [[x, y], [100 - y, x], [100 - x, 100 - y], [y, 100 - x]][rotation];
}

function roomLabelLayout(room, rotation) {
  const shape = room.shape.map(point => rotatePoint(point, rotation));
  const [x, y] = rotatePoint([room.label.x, room.label.y], rotation);
  // Fit upright lettering inside the actual rotated room at its label anchor.
  const widths = [-6, 0, 6].map(offset => {
    const scanY = y + offset;
    const crossings = [];
    for (let i = 0; i < shape.length; i++) {
      const a = shape[i], b = shape[(i + 1) % shape.length];
      if ((a[1] <= scanY && b[1] > scanY) || (b[1] <= scanY && a[1] > scanY)) {
        crossings.push(a[0] + (scanY - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i < crossings.length; i += 2) {
      if (x >= crossings[i] && x <= crossings[i + 1]) return 2 * Math.min(x - crossings[i], crossings[i + 1] - x) - 12;
    }
    return 10;
  });
  const chars = Array.from(room.name);
  const capacity = Math.max(1, Math.floor(Math.min(...widths) / 10.3));
  const perLine = Math.ceil(chars.length / Math.ceil(chars.length / capacity));
  const lines = [];
  for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(''));
  return { x, y, lines };
}

export function createTileSvg(tileId, rotation = 0, extraCorners = [], players = [], announcement = null) {
  const tile = getTile(tileId);
  const svg = el('svg', { viewBox: '0 0 100 100', class: 'tile-svg', role: 'img', 'aria-label': `${tile.name}，旋转${rotation * 90}度` });
  svg.append(el('title', {}, tile.name));
  const angle = rotation * 90;
  const group = el('g', { transform: `rotate(${angle} 50 50)` });
  group.append(el('rect', { x: .8, y: .8, width: 98.4, height: 98.4, fill: '#e6dbc3' }));
  for (const room of tile.rooms) {
    group.append(el('polygon', { points: room.shape.map(p => p.join(',')).join(' '), class: `room-shape${room.haunted ? ' haunted-room' : ''}` }));
  }
  group.append(el('rect', { x: .8, y: .8, width: 98.4, height: 98.4, class: 'tile-outline' }));
  for (const [direction] of Object.entries(tile.doors)) {
    const rotate = { N: 0, E: 90, S: 180, W: 270 }[direction];
    const door = el('g', { transform: `rotate(${rotate} 50 50)` });
    door.append(el('path', { d: 'M44 .8H56', class: 'door-cut' }));
    door.append(el('path', { d: 'M44 1V5M56 1V5M44 3H56', class: 'door-mark' }));
    group.append(door);
  }
  for (const door of tile.internalDoors) {
    const d = door.orientation === 'vertical' ? `M${door.x} ${door.y - 5}v10` : `M${door.x - 5} ${door.y}h10`;
    group.append(el('path', { d, class: 'door-cut' }));
    group.append(el('path', { d, class: 'door-mark' }));
  }
  for (const stair of tile.stairs) {
    const g = el('g', { transform: `translate(${stair.x - 5} ${stair.y - 4})` });
    g.append(el('path', { d: 'M0 0H10V8H0ZM0 2H10M0 4H10M0 6H10', class: 'stair-mark' }));
    g.append(el('title', {}, '楼梯'));
    group.append(g);
  }
  if (tile.entrance) {
    const { x, y, name } = tile.entrance;
    const gate = el('g');
    gate.append(el('path', { d: `M${x - 7} ${y - 2}h14M${x - 7} ${y - 4}v4M${x + 7} ${y - 4}v4`, class: 'door-mark' }));
    gate.append(el('text', { x, y: y - 9, 'text-anchor': 'middle', transform: `rotate(${-angle} ${x} ${y - 9})`, class: 'haunted-mark' }, name));
    group.append(gate);
  }
  svg.append(group);
  for (const room of tile.rooms) {
    const { x, y, lines } = roomLabelLayout(room, rotation);
    const top = y - (lines.length - 1) * 5.5;
    const label = el('text', { x, y: top, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'room-label' });
    lines.forEach((line, i) => label.append(el('tspan', { x, y: top + i * 11 }, line)));
    svg.append(label);
    if (room.haunted) svg.append(el('text', { x, y: top + (lines.length - 1) * 11 + 9, 'text-anchor': 'middle', class: 'haunted-mark' }, '怨'));
  }
  for (const room of tile.rooms) {
    const extra = extraCorners.filter(corner => corner.roomId === room.id)
      .map(corner => ({ ...corner, x: room.label.x, y: Math.max(7, room.label.y - 13) }));
    for (const corner of [...room.corners, ...extra]) {
      const [x, y] = rotatePoint([corner.x, corner.y], rotation);
      const mark = el('g', { transform: `translate(${x} ${y})`, class: 'corner-location',
        'data-corner-id': corner.id, 'aria-label': cornerName(corner.id), role: 'button', tabindex: '0' });
      if (corner.id.startsWith('suitcase:')) mark.setAttribute('data-testid', 'suitcase-corner');
      mark.append(el('title', {}, cornerName(corner.id)));
      mark.append(el('rect', { x: -9, y: -9, width: 18, height: 18, fill: 'transparent', class: 'corner-hit-area' }));
      mark.append(el('rect', { x: -7, y: -7, width: 14, height: 14, rx: 1, class: 'corner-mark' }));
      mark.append(el('text', { x: 0, y: .5, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'corner-number' }, cornerNumber(corner.id)));
      if (corner.id === 'study_desk') {
        const landmark = el('g', { class: 'safe-landmark', 'data-testid': 'safe-landmark', 'aria-label': '固定地标：转轮式保险箱（写字台下）' });
        landmark.append(el('title', {}, '转轮式保险箱 · 固定在写字台下，打开后仍保留此地标'));
        landmark.append(el('rect', { x: -15, y: 9, width: 30, height: 9, rx: 1, class: 'safe-landmark-badge' }));
        landmark.append(el('text', { x: 0, y: 14, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'safe-landmark-label' }, '保险箱'));
        mark.append(landmark);
      }
      svg.append(mark);
    }
  }
  const addPlayer = (player, x, y) => {
    const label = `${player.name}${player.self ? '（你）' : ''} · ${player.kind === 'visitor' ? '访问者' : `${player.kind === 'hako' ? '箱娃' : '箱人'}，${player.revealed ? '终局公开' : '仅箱娃方可见'}`}`;
    const marker = el('g', { class: `map-player-marker seat-color-${player.seat}${player.self ? ' self-player' : ''}${player.cornerId ? ' private-position' : ''}`,
      transform: `translate(${x} ${y})`, 'data-player-id': player.id, 'data-room-id': player.roomId,
      'aria-label': label, 'data-testid': 'map-player-marker' });
    if (player.cornerId) marker.setAttribute('data-corner-id', player.cornerId);
    marker.append(el('title', {}, label));
    marker.append(el('circle', { r: 5.4 }));
    marker.append(el('text', { x: 0, y: .4, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, String(player.seat + 1)));
    svg.append(marker);
  };
  for (const room of tile.rooms) {
    const visitors = players.filter(player => player.roomId === room.id && !player.cornerId);
    const { x, y, lines } = roomLabelLayout(room, rotation);
    visitors.forEach((player, index) => addPlayer(player,
      x + (index - (visitors.length - 1) / 2) * 12, Math.min(93, y + (lines.length - 1) * 5.5 + 13)));
    for (const player of players.filter(player => player.cornerId && (room.corners.some(corner => corner.id === player.cornerId)
      || extraCorners.some(corner => corner.roomId === room.id && corner.id === player.cornerId)))) {
      const corner = room.corners.find(corner => corner.id === player.cornerId)
        || extraCorners.find(corner => corner.id === player.cornerId);
      if (!corner) continue;
      const [cx, cy] = rotatePoint([corner.x ?? room.label.x, corner.y ?? Math.max(7, room.label.y - 13)], rotation);
      const location = [...svg.querySelectorAll('.corner-location')].find(mark => mark.dataset.cornerId === player.cornerId);
      location?.classList.add('self-hiding-corner');
      addPlayer(player, Math.min(94, Math.max(6, cx + (cx > 80 ? -9 : 9))), Math.min(94, Math.max(6, cy - 9)));
    }
  }
  if (tile.entrance) {
    const entrancePlayers = players.filter(player => player.roomId === 'entrance');
    entrancePlayers.forEach((player, index) => {
      const [x, y] = rotatePoint([50 + (index - (entrancePlayers.length - 1) / 2) * 12, 106], rotation);
      addPlayer(player, x, y);
    });
  }
  if (announcement && getLogicalRoomId(announcement.roomId) === tile.rooms[0].id) {
    const cry = el('g', { class: 'cry-map-marker', 'data-testid': 'cry-map-marker',
      'data-room-id': getLogicalRoomId(announcement.roomId), 'aria-label': `哭喊指向：${tile.name}` });
    cry.append(el('title', {}, `哭喊指向：${tile.name}，保留至下一次箱娃阶段`));
    cry.append(el('rect', { x: 3, y: 3, width: 94, height: 94, rx: 2, class: 'cry-room-outline' }));
    cry.append(el('rect', { x: 37, y: 88, width: 26, height: 11, rx: 2, class: 'cry-room-badge' }));
    cry.append(el('text', { x: 50, y: 94, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'cry-room-label' }, '哭喊'));
    svg.append(cry);
  }
  return svg;
}
