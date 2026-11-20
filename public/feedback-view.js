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
  let displayed = null;
  let queue = [];
  let historical = false;
  let position = 0;
  let returnFocus = null;
  let returnToHistory = null;
  let latestVersion = 0;
  let canReview = false;
  let hasCurrentResponse = false;
  let helpOpen = false;
  let identity = '';
  let toastTimer;
  let bannerId = '';
  let bannerClose = null;

  function locate(event, source, returnLabel, restore) {
    document.dispatchEvent(new CustomEvent('hako:locate-corner', { detail: {
      cornerId: event.cornerId, record: event.record || event.title,
      description: event.record ? '' : event.body, source, returnLabel, restore,
    } }));
  }

  function rememberHistory(source) {
    const panel = $('event-history');
    const scroll = panel.scrollTop;
    return () => {
      panel.showPopover();
      ($(source.id) || $('event-history-toggle')).focus({ preventScroll: true });
      panel.scrollTop = scroll;
    };
  }

  function history() {
    const items = tracker.items();
    const active = document.activeElement;
    const focusId = active?.dataset.eventId && active.id;
    const unread = items.filter(item => !item.dismissed).length;
    $('event-count').textContent = String(unread);
    $('event-count').hidden = unread === 0;
    $('event-history-toggle').classList.toggle('has-unread', unread > 0);
    $('event-history-toggle').setAttribute('aria-label', unread ? `查看事件，${unread}条未读` : '查看事件历史');
    $('event-history-empty').hidden = items.length > 0;
    $('event-history-list').replaceChildren(...items.map(event => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'event-history-entry';
      button.id = `history-card-${event.id}`;
      button.dataset.eventId = event.id;
      const title = document.createElement('strong');
      title.textContent = event.title;
      const detail = document.createElement('span');
      detail.textContent = `${event.dismissed ? '已读' : '未读'} · ${event.privateLabel}`;
      button.append(title, detail);
      button.addEventListener('click', () => {
        queue = [];
        returnToHistory = rememberHistory(button);
        $('event-history').hidePopover();
        show(event, true);
      });
      row.append(button);
      if (event.cornerId) {
        const position = document.createElement('button');
        position.type = 'button';
        position.className = 'text-button event-history-locate';
        position.textContent = '查看位置';
        position.id = `history-location-${event.id}`;
        position.dataset.eventId = event.id;
        position.dataset.testid = 'history-locate';
        position.setAttribute('aria-label', `${event.title}，查看当时的位置`);
        position.addEventListener('click', () => {
          const restore = rememberHistory(position);
          $('event-history').hidePopover();
          tracker.dismiss(event.id);
          history();
          locate(event, position, '返回事件记录', restore);
        });
        row.append(position);
      }
      return row;
    }));
    if (focusId) $(focusId)?.focus({ preventScroll: true });
    if (bannerClose) updateBannerClose(items);
  }

  function queueControls() {
    if (!displayed) return;
    const responses = queue.filter(event => event.requiresResponse).length;
    const majorChanges = queue.filter(event => ['death', 'victory'].includes(event.symbol)).length;
    const oldEvent = historical || displayed.version < latestVersion;
    $('event-position').textContent = `${oldEvent ? '历史事件 · 当时记录 · ' : '事件 '}${position} / ${position + queue.length}`;
    $('event-next').hidden = queue.length === 0;
    $('event-next').textContent = majorChanges ? `查看重大变化（${majorChanges}）`
      : responses ? `查看待回应（${responses}）` : `下一条（${queue.length}）`;
    $('event-next').classList.toggle('has-response', responses > 0 || majorChanges > 0);
    const view = canReview ? 'review' : hasCurrentResponse || responses || displayed.view === 'review' ? 'action' : displayed.view;
    $('event-primary-action').hidden = false;
    $('event-primary-action').dataset.view = view;
    $('event-primary-action').textContent = view === 'review' ? '查看复盘' : view === 'inventory' ? '查看物品'
      : oldEvent || hasCurrentResponse || responses ? '查看当前步骤' : '前往处理';
  }

  function show(event, fromHistory = false) {
    if (!event) return;
    if (helpOpen) document.dispatchEvent(new CustomEvent('game-help-interrupt'));
    if (!dialog.open) returnFocus = fromHistory ? $('event-history-toggle') : document.activeElement;
    displayed = event;
    historical = fromHistory;
    position = fromHistory ? 1 : position + 1;
    dialog.dataset.tone = event.tone;
    dialog.dataset.history = String(historical);
    $('event-title').textContent = event.title;
    $('event-body').textContent = event.body;
    $('event-visibility').textContent = event.privateLabel;
    $('event-symbol').replaceChildren(symbol(event.symbol));
    $('event-locate').hidden = !event.cornerId;
    $('event-locate').onclick = () => {
      if (!event.cornerId) return;
      const restoreHistory = returnToHistory;
      const previousFocus = returnFocus;
      const remaining = [...queue];
      const index = position;
      close(false);
      locate(event, $('event-locate'), '返回事件详情', () => {
        if (dialog.open) return;
        queue = remaining;
        show(event, fromHistory);
        position = index;
        returnFocus = previousFocus;
        returnToHistory = restoreHistory;
        queueControls();
        $('event-locate').focus({ preventScroll: true });
      });
    };
    $('event-companions').hidden = true;
    $('event-companions').replaceChildren();
    tracker.dismiss(event.id);
    queueControls();
    history();
    if (!dialog.open) dialog.showModal();
    $('event-primary-action').focus({ preventScroll: true });
  }

  function close(restoreFocus = true) {
    displayed = null;
    queue = [];
    position = 0;
    if (dialog.open) dialog.close();
    history();
    if (restoreFocus && historical && returnToHistory) returnToHistory();
    else if (restoreFocus) {
      const target = returnFocus?.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length ? returnFocus
        : $('focus-current-action') || $('event-history-toggle');
      target?.focus({ preventScroll: true });
    }
    returnFocus = null;
    returnToHistory = null;
    historical = false;
  }

  function newerDiscoveries(items = tracker.items()) {
    const index = items.findIndex(item => item.id === bannerId);
    return (index < 0 ? items : items.slice(0, index)).filter(item => item.banner && !item.dismissed).reverse();
  }

  function updateBannerClose(items) {
    const count = newerDiscoveries(items).length;
    bannerClose.textContent = count ? `下一条（${count}）` : '收起';
    bannerClose.setAttribute('aria-label', count ? `查看下一条公开发现，还有${count}条` : '收起公开发现提示');
  }

  function hideDiscovery() {
    bannerId = '';
    bannerClose = null;
    $('discovery-banner').hidden = true;
    $('discovery-banner').replaceChildren();
  }

  function showDiscovery(event) {
    bannerId = event.id;
    const banner = $('discovery-banner');
    const copy = document.createElement('div');
    copy.setAttribute('role', 'status');
    const title = document.createElement('strong');
    title.textContent = event.title;
    copy.append(title);
    if (event.cornerId) {
      const location = document.createElement('span');
      location.textContent = `发现时的位置 · ${cornerName(event.cornerId)}`;
      copy.append(location);
    }
    banner.replaceChildren(copy);
    if (event.cornerId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = '地图定位';
      button.id = `discovery-location-${event.id}`;
      button.dataset.testid = 'discovery-banner-locate';
      button.dataset.uiControl = '';
      button.addEventListener('click', () => {
        tracker.dismiss(event.id);
        history();
        locate(event, button, '返回公开提示', () => {
          if (!banner.hidden && $(button.id)) button.focus({ preventScroll: true });
          else $('event-history-toggle').focus({ preventScroll: true });
        });
      });
      banner.append(button);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'text-button';
    dismiss.dataset.uiControl = '';
    dismiss.addEventListener('click', () => {
      tracker.dismiss(event.id);
      history();
      const next = newerDiscoveries()[0];
      if (next) {
        showDiscovery(next);
        bannerClose.focus({ preventScroll: true });
      } else {
        hideDiscovery();
        $('event-history-toggle').focus({ preventScroll: true });
      }
    });
    banner.append(dismiss);
    bannerClose = dismiss;
    updateBannerClose();
    banner.hidden = false;
  }

  function toast(events) {
    clearTimeout(toastTimer);
    const element = $('event-toast');
    const summary = events.slice(0, 2).map(event => `${event.title}（${event.privateLabel}）`).join('；');
    element.textContent = `${summary}${events.length > 2 ? `，另有${events.length - 2}条` : ''}。可在事件中回看。`;
    element.hidden = false;
    toastTimer = setTimeout(() => { element.hidden = true; }, 5500);
  }
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('event-close').addEventListener('click', () => close());
  $('event-next').addEventListener('click', () => show(queue.shift()));
  $('event-primary-action').addEventListener('click', () => {
    const view = $('event-primary-action').dataset.view;
    close(false);
    document.dispatchEvent(new CustomEvent('game-navigate', { detail: { view } }));
  });
  document.addEventListener('game-help-open', () => {
    helpOpen = true;
    if (dialog.open) close(false);
  });
  document.addEventListener('game-help-close', event => {
    helpOpen = false;
    if (event.detail?.resumeEvents !== false && !dialog.open && queue.length) show(queue.shift());
  });

  return {
    resetBaseline() { tracker.resetBaseline(); },
    receive(state) {
      const nextIdentity = `${state.code}:${state.you}`;
      if (identity && identity !== nextIdentity) {
        close(false);
        clearTimeout(toastTimer);
        $('event-toast').hidden = true;
        hideDiscovery();
        $('event-history').hidePopover();
        latestVersion = 0;
      }
      identity = nextIdentity;
      if (state.version >= latestVersion) {
        latestVersion = state.version;
        canReview = Boolean(state.round?.result);
        const resolution = state.round?.resolution;
        const vote = state.undo?.pending;
        const walkie = state.round?.walkie;
        hasCurrentResponse = !canReview && Boolean(state.round?.interruption?.canRespond
          || resolution && resolution.kind !== 'waiting' && resolution.playerId === state.you
          || state.round?.pendingAction && state.round?.hako?.playerId === state.you
          || walkie?.pairRequest?.targetId === state.you || walkie?.showRequest
          || vote?.requiredIds?.includes(state.you) && !vote.approvedIds?.includes(state.you));
      }
      const events = tracker.receive(state);
      if (events.some(event => event.title === '已撤销上一步')) {
        queue = [];
        hideDiscovery();
      }
      const recentIds = new Set(tracker.items().map(event => event.id));
      queue = queue.filter(event => recentIds.has(event.id));
      history();
      const discovery = events.find(event => event.banner);
      if (discovery && !bannerId) showDiscovery(discovery);
      const highlights = events.filter(event => event.highlight);
      queue.push(...highlights);
      // Keep the event being read stable; major changes and responses come next.
      const priority = event => event.symbol === 'victory' ? 4 : event.symbol === 'death' ? 3 : event.requiresResponse ? 2 : 1;
      queue.sort((a, b) => priority(b) - priority(a));
      if (helpOpen && highlights.some(event => ['death', 'victory'].includes(event.symbol) || event.requiresResponse)) {
        document.dispatchEvent(new CustomEvent('game-help-interrupt'));
      }
      if (highlights.length && !helpOpen && !dialog.open) show(queue.shift());
      else queueControls();
      const ordinary = events.filter(event => !event.highlight && !event.banner);
      if (ordinary.length) toast(ordinary);
    },
    clear() {
      close(false);
      tracker.clear();
      identity = '';
      latestVersion = 0;
      canReview = false;
      hasCurrentResponse = false;
      clearTimeout(toastTimer);
      $('event-toast').hidden = true;
      $('event-toast').textContent = '';
      hideDiscovery();
      $('event-history').hidePopover();
      history();
    },
  };
}
