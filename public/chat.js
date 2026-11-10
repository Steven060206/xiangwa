import { getLogicalRooms } from '/shared/maps.mjs';

const make = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
};
const channelTitle = kind => kind === 'hako' ? '箱娃与箱人频道' : kind === 'walkie' ? '对讲机私聊' : '同房访问者频道';

export function createChatUI(send) {
  const panel = make('section', undefined, 'chat-panel');
  panel.id = 'chat-panel';
  panel.dataset.testid = 'chat-panel';
  panel.setAttribute('aria-label', '私密文字交流');
  const heading = make('h2', '文字交流');
  const channelLabel = make('label', '选择交流频道');
  channelLabel.htmlFor = 'chat-channel';
  const channelSelect = make('select');
  channelSelect.id = 'chat-channel';
  channelSelect.dataset.testid = 'chat-channel';
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
  input.placeholder = '最多300字；Enter发送，Shift+Enter换行';
  const button = make('button', '发送', 'button secondary small');
  button.type = 'submit';
  button.dataset.testid = 'chat-send';
  const status = make('p', '', 'small-note');
  status.setAttribute('role', 'status');
  form.append(label, input, button, status);
  panel.append(heading, channelLabel, channelSelect, scope, list, form);
  let current, previousChannel, sending = false, messagesKey = '', selectedKind = '';
  let composing = false, compositionEndedAt = -Infinity;
  const selectedChannel = () => current?.channels.find(channel => channel.kind === selectedKind) || current?.channels[0];
  const updateScope = () => {
    const channel = selectedChannel();
    const state = current.state;
    const key = channel ? `${channel.kind}:${channel.roomId}:${channel.participantIds.join(',')}` : '';
    if (previousChannel !== undefined && previousChannel !== key) input.value = '';
    previousChannel = key;
    const names = (channel?.participantIds || []).filter(id => id !== state.you)
      .map(id => state.players.find(player => player.id === id)?.name || '玩家');
    const room = getLogicalRooms().find(room => room.id === channel?.roomId);
    heading.textContent = channelTitle(channel?.kind);
    scope.textContent = !channel ? '当前没有可用的交流对象。'
      : `${channel.kind === 'hako' ? '箱娃阵营' : channel.kind === 'walkie' ? '固定对讲机同伴 · 不公开聊天内容' : room?.name || '当前房间'} · ${names.length ? `接收者：${names.join('、')}` : '目前只有你'}。`;
    input.disabled = !current.online || !channel;
    channelSelect.disabled = sending || !current.online;
    button.disabled = sending || !current.online || !channel;
  };
  channelSelect.addEventListener('change', () => { selectedKind = channelSelect.value; updateScope(); });
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
    sending = true;
    updateScope();
    status.textContent = '';
    try {
      await send({ text, channelKind: channel.kind, roomId: channel.roomId });
      if (input.value === text) input.value = '';
    } catch (error) { status.textContent = error.message; }
    finally { sending = false; updateScope(); }
  });
  return {
    render(state, online) {
      if (!panel.isConnected) document.querySelector('.setup-sidebar').append(panel);
      const chat = state.chat;
      const channels = chat?.channels || (chat?.channel ? [chat.channel] : []);
      current = { chat, online, state, channels };
      panel.hidden = !state.round;
      if (!state.round) return;
      if (!channels.some(channel => channel.kind === selectedKind)) selectedKind = channels[0]?.kind || '';
      channelSelect.replaceChildren(...channels.map(channel => {
        const option = make('option', channelTitle(channel.kind));
        option.value = channel.kind;
        return option;
      }));
      channelSelect.value = selectedKind;
      channelLabel.hidden = channelSelect.hidden = channels.length < 2;
      updateScope();
      const nextKey = JSON.stringify(chat?.messages || []);
      if (messagesKey !== nextKey) {
        messagesKey = nextKey;
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
        list.replaceChildren(...(chat?.messages || []).map(message => {
          const entry = make('li');
          const sender = state.players.find(player => player.id === message.senderId)?.name || '玩家';
          const roomName = getLogicalRooms().find(room => room.id === message.roomId)?.name;
          entry.append(make('strong', sender), make('span', message.kind === 'hako' ? '箱娃阵营' : message.kind === 'walkie' ? '对讲机私聊' : roomName || '同房', 'chat-message-scope'),
            make('p', message.text));
          return entry;
        }));
        if (nearBottom) list.scrollTop = list.scrollHeight;
      }
    },
  };
}
