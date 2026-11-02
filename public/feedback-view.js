import { createFeedbackTracker } from './feedback.js';
import { cornerName } from './tile.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const paths = {
  key: ['M15 11a5 5 0 1 0-4 4l3 3h3v3h4v-4l-6-6Z', 'M7 7h.01'],
  password: ['M8 3h8l4 4v14H4V3h4Z', 'M8 10h8M8 14h8M8 18h4'],
  notebook: ['M4 4h13a3 3 0 0 1 3 3v14H7a3 3 0 0 1-3-3V4Z', 'M7 17h13M8 8h8M8 12h5'],
  weapon: ['m5 19 8-8m-3-3 6 6M13 5l5-2 3 3-2 5-6-6Z', 'm3 17 4 4'],
  doll: ['M9 7a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z', 'M8 21v-7l-4 3m12 4v-7l4 3M8 14l4-3 4 3M12 11v10'],
  item: ['M4 8h16v13H4V8Zm4 0V4h8v4', 'M4 13h16M10 11h4v4h-4Z'],
  power: ['m13 2-9 12h7l-1 8 10-13h-7l1-7Z'],
  death: ['M6 17V8a6 6 0 0 1 12 0v9l-3-2-3 2-3-2-3 2Z', 'M9 8v2M15 8v2M9 21h6'],
  victory: ['M7 3h10v7a5 5 0 0 1-10 0V3Zm0 2H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4', 'M12 15v6M7 21h10'],
  event: ['M5 3h14v18H5V3Z', 'M9 7h6M9 11h6M9 15h3'],
};

function symbol(kind) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths[kind] || paths.event) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function createFeedbackUI() {
  const tracker = createFeedbackTracker({ locationName: cornerName });
  const dialog = $('event-dialog');
  let displayed = [];
  let identity = '';

  function history() {
    const items = tracker.items();
    const unread = items.filter(item => !item.dismissed).length;
    $('event-count').textContent = String(unread);
    $('event-history-toggle').classList.toggle('has-unread', unread > 0);
    $('event-history-toggle').setAttribute('aria-label', `查看最近事件，${unread}条未读`);
    $('event-history-empty').hidden = items.length > 0;
    $('event-history-list').replaceChildren(...items.map(event => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'event-history-entry';
      const title = document.createElement('strong');
      title.textContent = event.title;
      const detail = document.createElement('span');
      detail.textContent = event.privateLabel;
      button.append(title, detail);
      button.addEventListener('click', () => show([event]));
      row.append(button);
      return row;
    }));
  }

  function show(events) {
    displayed = events;
    const event = [...events].sort((a, b) => (b.tone === 'danger') - (a.tone === 'danger'))[0];
    if (!event) return;
    dialog.dataset.tone = event.tone;
    $('event-title').textContent = event.title;
    $('event-body').textContent = event.body;
    $('event-visibility').textContent = event.privateLabel;
    $('event-symbol').replaceChildren(symbol(event.symbol));
    $('event-locate').hidden = !event.cornerId;
    $('event-locate').onclick = () => {
      close();
      document.dispatchEvent(new CustomEvent('hako:locate-corner', { detail: { cornerId: event.cornerId } }));
    };
    const others = events.filter(item => item.id !== event.id);
    $('event-companions').hidden = others.length === 0;
    $('event-companions').replaceChildren(...others.map(item => {
      const line = document.createElement('li');
      line.textContent = `${item.title}（${item.privateLabel}） · ${item.body}`;
      return line;
    }));
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    for (const event of displayed) tracker.dismiss(event.id);
    displayed = [];
    if (dialog.open) dialog.close();
    history();
  }
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('event-close').addEventListener('click', close);

  return {
    receive(state) {
      const nextIdentity = `${state.code}:${state.you}`;
      if (identity && identity !== nextIdentity) close();
      identity = nextIdentity;
      const events = tracker.receive(state);
      history();
      const highlights = events.filter(event => event.highlight);
      if (highlights.length) show(dialog.open ? [...displayed, ...highlights] : highlights);
    },
    clear() {
      close();
      tracker.clear();
      displayed = [];
      identity = '';
      $('event-history').hidePopover();
      history();
    },
  };
}
