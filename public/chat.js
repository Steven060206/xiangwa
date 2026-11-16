import { getLogicalRooms } from '/shared/maps.mjs';

const make = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
};

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
  input.placeholder = '最多300字';
  input.setAttribute('aria-describedby', scope.id);
  const button = make('button', '发送', 'button secondary small');
  button.type = 'submit';
  button.dataset.testid = 'chat-send';
  const status = make('p', '', 'small-note');
  status.setAttribute('role', 'status');
  form.append(scope, label, input, button, status);
  panel.append(header, list, form);
  let current, previousChannel, identityKey, sending, messagesKey = '', viewingChat = false, initialized = false;
  const seenIds = new Set();
  const unreadIds = new Set();
  function updateUnread() {
    const badge = document.getElementById('chat-unread');
    if (badge) {
      badge.textContent = unreadIds.size ? String(unreadIds.size) : '';
      badge.hidden = !unreadIds.size;
    }
    const navigation = document.querySelector('#game-navigation [data-view="chat"]');
    navigation?.setAttribute('aria-label', unreadIds.size ? `消息，${unreadIds.size}条未读` : '消息');
  }
  function markRead() {
    unreadIds.clear();
    updateUnread();
  }
  function reset() {
    current = undefined;
    previousChannel = identityKey = sending = undefined;
    messagesKey = '';
    initialized = viewingChat = false;
    seenIds.clear();
    markRead();
    input.value = status.textContent = '';
    list.replaceChildren();
    panel.hidden = true;
  }
  document.addEventListener('game-view-change', event => {
    viewingChat = event.detail?.view === 'chat';
    if (viewingChat) {
      markRead();
      list.scrollTop = list.scrollHeight;
    }
  });
  panel.addEventListener('focusin', markRead);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !current?.chat.channel || !input.value.trim()) return;
    const text = input.value;
    const channel = current.chat.channel;
    const request = { identityKey, channelKey: previousChannel };
    sending = request;
    button.disabled = true;
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
        button.disabled = !current?.online || !current?.chat.channel;
      }
    }
  });
  return {
    markRead,
    reset,
    render(state, online) {
      if (!panel.isConnected) document.querySelector('.setup-sidebar').append(panel);
      const nextIdentity = `${state.code}:${state.you}`;
      if (identityKey !== nextIdentity) { reset(); identityKey = nextIdentity; }
      const chat = state.chat || { messages: [], channel: null };
      current = { chat, online };
      panel.hidden = !state.round;
      if (!state.round) { markRead(); return; }
      const channel = chat?.channel;
      const key = channel ? `${channel.kind}:${channel.roomId}` : '';
      if (previousChannel !== undefined && previousChannel !== key) {
        input.value = '';
        status.textContent = '频道已改变，请确认当前接收范围后发送。';
      }
      previousChannel = key;
      const names = (channel?.participantIds || []).filter(id => id !== state.you)
        .map(id => state.players.find(player => player.id === id)?.name || '玩家');
      const room = getLogicalRooms().find(room => room.id === channel?.roomId);
      heading.textContent = channel?.kind === 'hako' ? '箱娃与箱人频道' : '同房访问者频道';
      scope.textContent = !channel ? '当前没有可用的交流对象。'
        : `${channel.kind === 'hako' ? '箱娃阵营' : room?.name || '当前房间'} · ${names.length ? `接收者：${names.join('、')}` : '目前只有你'}。`;
      input.disabled = !online || !channel;
      button.disabled = sending || !online || !channel;
      const messages = chat.messages || [];
      const messageIds = new Set(messages.map(message => message.id));
      for (const id of unreadIds) if (!messageIds.has(id)) unreadIds.delete(id);
      for (const message of messages) {
        if (initialized && !seenIds.has(message.id) && message.senderId !== state.you && !viewingChat) unreadIds.add(message.id);
        seenIds.add(message.id);
      }
      initialized = true;
      if (viewingChat) markRead();
      else updateUnread();
      const nextKey = JSON.stringify(messages);
      if (messagesKey !== nextKey) {
        messagesKey = nextKey;
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
        list.replaceChildren(...messages.map(message => {
          const entry = make('li');
          const sender = state.players.find(player => player.id === message.senderId)?.name || '玩家';
          const roomName = getLogicalRooms().find(room => room.id === message.roomId)?.name;
          entry.append(make('strong', sender), make('span', message.kind === 'hako' ? '箱娃阵营' : roomName || '同房', 'chat-message-scope'),
            make('p', message.text));
          return entry;
        }));
        if (!messages.length) list.append(make('li', '还没有收到消息。消息只会送达上方列出的接收者。', 'chat-empty'));
        if (nearBottom) list.scrollTop = list.scrollHeight;
      }
    },
  };
}
