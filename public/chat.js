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
  const heading = make('h2', '文字交流');
  const scope = make('p', '', 'small-note');
  scope.dataset.testid = 'chat-scope';
  const list = make('ol', undefined, 'chat-messages');
  list.dataset.testid = 'chat-messages';
  list.setAttribute('aria-live', 'polite');
  const form = make('form', undefined, 'chat-form');
  const label = make('label', '聊天内容');
  label.htmlFor = 'chat-text';
  const input = make('textarea');
  input.id = 'chat-text';
  input.dataset.testid = 'chat-text';
  input.maxLength = 600;
  input.rows = 2;
  input.placeholder = '最多300字';
  const button = make('button', '发送', 'button secondary small');
  button.type = 'submit';
  button.dataset.testid = 'chat-send';
  const status = make('p', '', 'small-note');
  status.setAttribute('role', 'status');
  form.append(label, input, button, status);
  panel.append(heading, scope, list, form);
  let current, previousChannel, sending = false, messagesKey = '';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !current?.chat.channel || !input.value.trim()) return;
    const text = input.value;
    const channel = current.chat.channel;
    sending = true;
    button.disabled = true;
    status.textContent = '';
    try {
      await send({ text, channelKind: channel.kind, roomId: channel.roomId });
      if (input.value === text) input.value = '';
    } catch (error) { status.textContent = error.message; }
    finally { sending = false; button.disabled = !current?.online || !current?.chat.channel; }
  });
  return {
    render(state, online) {
      if (!panel.isConnected) document.querySelector('.setup-sidebar').append(panel);
      const chat = state.chat;
      current = { chat, online };
      panel.hidden = !state.round;
      if (!state.round) return;
      const channel = chat?.channel;
      const key = channel ? `${channel.kind}:${channel.roomId}` : '';
      if (previousChannel !== undefined && previousChannel !== key) input.value = '';
      previousChannel = key;
      const names = (channel?.participantIds || []).filter(id => id !== state.you)
        .map(id => state.players.find(player => player.id === id)?.name || '玩家');
      const room = getLogicalRooms().find(room => room.id === channel?.roomId);
      heading.textContent = channel?.kind === 'hako' ? '箱娃与箱人频道' : '同房访问者频道';
      scope.textContent = !channel ? '当前没有可用的交流对象。'
        : `${channel.kind === 'hako' ? '箱娃阵营' : room?.name || '当前房间'} · ${names.length ? `接收者：${names.join('、')}` : '目前只有你'}。`;
      input.disabled = !online || !channel;
      button.disabled = sending || !online || !channel;
      const nextKey = JSON.stringify(chat.messages);
      if (messagesKey !== nextKey) {
        messagesKey = nextKey;
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
        list.replaceChildren(...chat.messages.map(message => {
          const entry = make('li');
          const sender = state.players.find(player => player.id === message.senderId)?.name || '玩家';
          const roomName = getLogicalRooms().find(room => room.id === message.roomId)?.name;
          entry.append(make('strong', sender), make('span', message.kind === 'hako' ? '箱娃阵营' : roomName || '同房', 'chat-message-scope'),
            make('p', message.text));
          return entry;
        }));
        if (nearBottom) list.scrollTop = list.scrollHeight;
      }
    },
  };
}
