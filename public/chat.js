import { getLogicalRooms } from '/shared/maps.mjs';

const make = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
};
const conversation = entry => entry.kind === 'room' ? 'room:' + entry.roomId : entry.kind;
const channelTitle = kind => kind === 'hako' ? '箱娃与箱人频道' : kind === 'walkie' ? '对讲机私聊' : '同房访问者频道';

export function createChatUI(send) {
  const panel = make('section', undefined, 'chat-panel');
  panel.id = 'chat-panel';
  panel.dataset.testid = 'chat-panel';
  panel.setAttribute('aria-label', '私密文字交流');
  const header = make('div', undefined, 'chat-heading');
  const heading = make('h2', '文字交流');
  const back = make('button', '返回行动', 'text-button');
  back.type = 'button';
  back.dataset.uiControl = '';
  back.dataset.testid = 'chat-return';
  back.addEventListener('click', () => document.dispatchEvent(new CustomEvent('game-navigate', { detail: { view: 'action' } })));
  header.append(heading, back);
  const channelLabel = make('label', '选择交流频道');
  channelLabel.htmlFor = 'chat-channel';
  const channelSelect = make('select');
  channelSelect.id = 'chat-channel';
  channelSelect.dataset.testid = 'chat-channel';
  const scope = make('p', '', 'small-note');
  scope.id = 'chat-scope';
  scope.dataset.testid = 'chat-scope';
  const list = make('ol', undefined, 'chat-messages');
  list.dataset.testid = 'chat-messages';
  list.setAttribute('aria-live', 'polite');
  list.setAttribute('aria-relevant', 'additions');
  list.setAttribute('aria-label', '已收到的消息');
  const form = make('form', undefined, 'chat-form');
  const label = make('label', '聊天内容');
  label.htmlFor = 'chat-text';
  const input = make('textarea');
  input.id = 'chat-text';
  input.dataset.testid = 'chat-text';
  input.maxLength = 600;
  input.rows = 2;
  input.placeholder = '最多300字；Enter发送，Shift+Enter换行';
  input.setAttribute('aria-describedby', scope.id);
  const button = make('button', '发送', 'button secondary small');
  button.type = 'submit';
  button.dataset.testid = 'chat-send';
  const status = make('p', '', 'small-note');
  status.setAttribute('role', 'status');
  form.append(scope, label, input, button, status);
  panel.append(header, channelLabel, channelSelect, list, form);
  let current, previousChannel, identityKey, sending, messagesKey = '', viewingChat = false, initialized = false, selectedKey = '', choosing = false;
  let composing = false, compositionEndedAt = -Infinity;
  const seenIds = new Set();
  const unreadIds = new Map();
  function updateUnread() {
    const badge = document.getElementById('chat-unread');
    if (badge) {
      badge.textContent = unreadIds.size ? String(unreadIds.size) : '';
      badge.hidden = !unreadIds.size;
    }
    const navigation = document.querySelector('#game-navigation [data-view="chat"]');
    navigation?.setAttribute('aria-label', unreadIds.size ? `消息，${unreadIds.size}条未读` : '消息');
  }
  function reset() {
    current = undefined;
    previousChannel = identityKey = sending = undefined;
    messagesKey = selectedKey = '';
    choosing = false;
    composing = false;
    compositionEndedAt = -Infinity;
    initialized = viewingChat = false;
    seenIds.clear();
    unreadIds.clear();
    updateUnread();
    input.value = status.textContent = '';
    list.replaceChildren();
    panel.hidden = true;
  }
  document.addEventListener('game-view-change', event => {
    const entering = !viewingChat && event.detail?.view === 'chat';
    viewingChat = event.detail?.view === 'chat';
    if (entering) {
      const keys = [...new Set(unreadIds.values())];
      choosing = keys.length > 1;
      if (keys.length === 1) selectedKey = keys[0];
      paint();
      list.scrollTop = list.scrollHeight;
    }
  });
  const selectedChannel = () => !choosing && current?.channels.find(channel => conversation(channel) === selectedKey);
  const updateScope = () => {
    const channel = selectedChannel();
    const state = current.state;
    const key = channel ? `${selectedKey}:${channel.participantIds.join(',')}` : `history:${selectedKey}`;
    if (previousChannel !== undefined && previousChannel !== key) {
      input.value = '';
      status.textContent = '频道已改变，请确认当前接收范围后发送。';
    }
    previousChannel = key;
    const names = (channel?.participantIds || []).filter(id => id !== state.you)
      .map(id => state.players.find(player => player.id === id)?.name || '玩家');
    const room = getLogicalRooms().find(room => room.id === channel?.roomId);
    heading.textContent = choosing ? '未读消息' : channelTitle(channel?.kind || selectedKey.split(':')[0]);
    scope.textContent = !channel ? choosing ? '选择要阅读的频道。' : '仅供回看，当前无法向此频道发送。'
      : `${channel.kind === 'hako' ? '箱娃阵营' : channel.kind === 'walkie' ? '固定对讲机同伴 · 不公开聊天内容' : room?.name || '当前房间'} · ${names.length ? `接收者：${names.join('、')}` : '目前只有你'}。`;
    input.disabled = !current.online || !channel;
    channelSelect.disabled = Boolean(sending);
    button.textContent = channel?.kind === 'walkie' ? '发给搭档' : channel?.kind === 'room' ? '发给同房玩家' : channel?.kind === 'hako' ? '发给箱娃阵营' : '发送';
    button.disabled = sending || !current.online || !channel;
  };
  channelSelect.addEventListener('change', () => { if (channelSelect.value) { choosing = false; selectedKey = channelSelect.value; paint(); } });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; compositionEndedAt = performance.now(); });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229
      || performance.now() - compositionEndedAt < 50) return;
    event.preventDefault();
    if (!event.repeat && !sending && current?.online && selectedChannel()) form.requestSubmit();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !current?.online || !selectedChannel() || !input.value.trim()) return;
    const text = input.value;
    const channel = selectedChannel();
    const request = { identityKey, channelKey: previousChannel };
    sending = request;
    updateScope();
    status.textContent = '正在发送…';
    try {
      await send({ text, channelKind: channel.kind, roomId: channel.roomId });
      if (sending === request) {
        if (identityKey === request.identityKey && previousChannel === request.channelKey && input.value === text) input.value = '';
        status.textContent = '已发送。';
      }
    } catch (error) { if (sending === request) status.textContent = error.message; }
    finally {
      if (sending === request) {
        sending = undefined;
        updateScope();
      }
    }
  });
  function paint() {
    if (!current) return;
    const { messages, channels, state } = current;
    const options = new Map(channels.map(channel => [conversation(channel), channel]));
    for (const message of messages) {
      const key = conversation(message);
      if (!options.has(key)) options.set(key, message);
    }
    if (!choosing && !options.has(selectedKey)) selectedKey = channels[0] ? conversation(channels[0]) : options.keys().next().value || '';
    if (viewingChat && !choosing) {
      for (const [id, key] of unreadIds) if (key === selectedKey) unreadIds.delete(id);
    }
    updateUnread();
    const counts = new Map();
    for (const key of unreadIds.values()) counts.set(key, (counts.get(key) || 0) + 1);
    channelSelect.replaceChildren();
    if (choosing) channelSelect.add(new Option('选择要阅读的未读频道', ''));
    for (const [key, entry] of options) {
      const live = channels.some(c => conversation(c) === key);
      const roomName = entry.kind === 'room' && getLogicalRooms().find(r => r.id === entry.roomId)?.name;
      const title = (roomName || channelTitle(entry.kind)) + (live ? '' : ' · 历史') + (counts.has(key) ? ` · ${counts.get(key)} 条未读` : '');
      channelSelect.add(new Option(title, key));
    }
    channelSelect.value = choosing ? '' : selectedKey;
    channelLabel.hidden = channelSelect.hidden = options.size < 2 && !choosing;
    updateScope();
    const shown = choosing ? [] : messages.filter(message => conversation(message) === selectedKey);
    const key = JSON.stringify([choosing, selectedKey, shown]);
    if (messagesKey === key) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
    messagesKey = key;
    list.replaceChildren(...shown.map(message => {
      const entry = make('li');
      entry.append(make('strong', state.players.find(p => p.id === message.senderId)?.name || '玩家'),
        make('span', channelTitle(message.kind), 'chat-message-scope'), make('p', message.text));
      return entry;
    }));
    if (!shown.length) list.append(make('li', choosing ? '请选择一个频道查看消息。' : '本频道暂无消息。', 'chat-empty'));
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  return {
    reset,
    render(state, online, view) {
      if (!panel.isConnected) document.getElementById('messages-pane').append(panel);
      document.getElementById('chat-before-round').hidden = Boolean(state.round);
      const nextIdentity = `${state.code}:${state.you}`;
      if (identityKey !== nextIdentity) { reset(); identityKey = nextIdentity; }
      const chat = state.chat;
      const channels = chat?.channels || (chat?.channel ? [chat.channel] : []);
      const messages = chat?.messages || [];
      const previousLive = current?.channels.find(c => conversation(c) === selectedKey);
      if (previousLive && !channels.some(c => conversation(c) === selectedKey)) {
        const replacement = channels.find(c => c.kind === previousLive.kind) || channels[0];
        if (replacement) selectedKey = conversation(replacement);
      }
      current = { online, state, channels, messages };
      if (view !== 'chat') viewingChat = false;
      panel.hidden = !state.round;
      if (!state.round) { reset(); return; }
      const nextIds = new Set(messages.map(message => message.id));
      for (const id of unreadIds.keys()) if (!nextIds.has(id)) unreadIds.delete(id);
      for (const id of seenIds) if (!nextIds.has(id)) seenIds.delete(id);
      for (const message of messages) {
        if (initialized && !seenIds.has(message.id) && message.senderId !== state.you) unreadIds.set(message.id, conversation(message));
        seenIds.add(message.id);
      }
      initialized = true;
      paint();
    },
  };
}
