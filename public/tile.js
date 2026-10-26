import { getTile } from '/shared/maps.mjs';

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

export function createTileSvg(tileId, rotation = 0) {
  const tile = getTile(tileId);
  const svg = el('svg', { viewBox: '0 0 100 100', class: 'tile-svg', role: 'img', 'aria-label': `${tile.name}，旋转${rotation * 90}度` });
  svg.append(el('title', {}, tile.name));
  const angle = rotation * 90;
  const group = el('g', { transform: `rotate(${angle} 50 50)` });
  group.append(el('rect', { x: .8, y: .8, width: 98.4, height: 98.4, fill: '#e6dbc3' }));
  for (const room of tile.rooms) {
    group.append(el('polygon', { points: room.shape.map(p => p.join(',')).join(' '), class: `room-shape${room.haunted ? ' haunted-room' : ''}` }));
    for (const corner of room.corners) {
      const mark = el('rect', { x: corner.x - 2.6, y: corner.y - 2.6, width: 5.2, height: 5.2, rx: .5, class: 'corner-mark' });
      mark.append(el('title', {}, corner.name));
      group.append(mark);
    }
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
  return svg;
}
