const TOOL_NAMES = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };
const TOKEN_NAMES = { key: '钥匙', password: '密码', notebook: '手记', doll: '玛丽小姐的人偶',
  weakness_clue: '讨伐情报', weapon: '讨伐道具', amulet: '古怪护符', extinguisher: '灭火器',
  safe: '转轮式保险箱', hidden_exit: '隐藏出口', remains: '亡骸', empty_box: '空箱' };
const POWER_NAMES = ['', '就在你身旁', '马上就到哟', '打不开的门', '动来动去', '我在你身后',
  '好想打开它', '快把它给我', '我的玛丽小姐', '虚假的回应', '鬼来电', '虚假的哭喊'];
const ROOM_NAMES = { hall_room: '一楼大厅', study_room: '书房／深色房间', bathroom_room: '浴室',
  dining_room: '餐厅', upstairs_hall: '二楼大厅／深蓝寝室', basement_room: '地下室',
  children_room: '儿童房', storage_room: '储藏室／厨房', living_room: '客厅' };
const TOKEN_EFFECTS = {
  key: '携带钥匙窥探隐藏出口，即可逃脱。',
  password: '这是一枚密码数字；保险箱的密码由三个数字组成，顺序无关。',
  doll: '携带玛丽小姐的人偶窥探亡骸，即可超度。',
  weapon: '消耗标准行动指定角落进行讨伐；使用后该道具移出游戏。先核对已知讨伐情报。',
  amulet: '消耗标准行动和护符，移除箱娃可用能力栏中的一张能力。',
  extinguisher: '无声累计超过10，或“NO.5 我在你身后”发动的响应窗口中，可消耗灭火器跳过本次箱娃行动。',
  safe: '不能获取；窥探后猜测三个密码数字，全部正确即可取得钥匙。',
  hidden_exit: '不能获取；携带钥匙窥探这里即可逃脱。',
  remains: '不能获取；携带玛丽小姐的人偶窥探这里即可超度。',
  empty_box: '这是空箱，不能获取。',
};
const PUBLIC = '全员可见';
const PRIVATE = '仅你可见';
const changed = (before, after) => JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
const added = (before = [], after = []) => after.filter(value => !before.some(old => old.id === value.id));
const playerName = (state, id) => state.players?.find(player => player.id === id)?.name || '玩家';
const powerName = card => {
  const id = Number(typeof card === 'object' ? card?.id ?? card?.powerId : card);
  return `${Number.isInteger(id) && id > 0 ? `NO.${id} ` : ''}${card?.name || POWER_NAMES[id] || '箱娃之力'}`;
};
function tokenName(token) {
  if (token.name) return token.name;
  if (token.type === 'weapon') return TOOL_NAMES[token.tool] || TOKEN_NAMES.weapon;
  if (token.type === 'weakness_clue') return `${TOOL_NAMES[token.tool] || '讨伐道具'}无效`;
  return `${TOKEN_NAMES[token.type] || '标志'}${token.number ?? ''}`;
}
function tokenDescription(token) {
  if (token.description) return token.description;
  if (token.power) return `${powerName(token.power)}：${token.power.description}`;
  if (token.type === 'weakness_clue') return `讨伐情报：${TOOL_NAMES[token.tool] || '该讨伐道具'}对箱娃无效。`;
  return TOKEN_EFFECTS[token.type] || '可在当前操作中查看详情。';
}
const tokenSymbol = token => ['key', 'password', 'weapon', 'notebook', 'doll'].includes(token.type) ? token.type : 'item';
function roomName(state, id) {
  return state.round?.items?.roomOptions?.find(room => room.id === id)?.name || ROOM_NAMES[id] || '宣告的房间';
}
function appendedLogs(before = [], after = []) {
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
    if (before.slice(-overlap).every((entry, index) => entry === after[index])) return after.slice(overlap);
  }
  return after;
}

/** Compare only the current participant's already-filtered server snapshots.
 * History is local to this page; refreshing establishes a quiet new baseline. */
export function createFeedbackTracker({ limit = 20 } = {}) {
  let previous = null;
  let history = [];
  let sequence = 0;
  const clear = () => { previous = null; history = []; sequence = 0; };
  return {
    clear,
    items: () => structuredClone(history),
    active: () => structuredClone(history.find(entry => !entry.dismissed) || null),
    dismiss(id) {
      const entry = history.find(entry => entry.id === id);
      if (entry) entry.dismissed = true;
    },
    receive(next) {
      if (!next) return [];
      if (previous && (previous.code !== next.code || previous.you !== next.you)) clear();
      if (!previous) { previous = structuredClone(next); return []; }
      if (next.version <= previous.version) return [];
      const before = previous;
      previous = structuredClone(next);
      const events = [];
      const push = (title, body, tone = 'info', privateLabel = PUBLIC, highlight = false, symbol = 'event') => {
        events.push({ id: `${next.code}:${next.you}:${next.version}:${++sequence}`, version: next.version,
          title, body, tone, privateLabel, highlight, symbol, dismissed: false });
      };
      const finish = () => {
        history = [...events].reverse().concat(history).slice(0, limit);
        return structuredClone(events);
      };
      const logs = appendedLogs(before.log, next.log);
      const undo = logs.some(log => /(?:撤销了上一步|已撤销上一步)/.test(log))
        || next.undo?.steps < before.undo?.steps && /撤销/.test(next.log?.at(-1) || '');
      if (undo) {
        push('已撤销上一步', '盘面和随身物品已恢复到上一步；请按当前提示继续。', 'attention');
        return finish();
      }

      const ownChoice = next.initialItems?.find(choice => choice.playerId === next.you);
      if (ownChoice && !before.initialItems?.some(choice => choice.playerId === next.you && choice.itemId === ownChoice.itemId)) {
        push(`获得了${ownChoice.itemName || ownChoice.name || '初始道具'}`, ownChoice.itemDescription || '道具已放入你的随身物品，可随时查看效果。', 'success', PRIVATE, true, 'item');
      }
      if (next.initialPower && changed(before.initialPower, next.initialPower)) {
        push(`初始能力：${powerName(next.initialPower)}`, next.initialPower.description || '只有你能看到这张初始能力，仍需按时机设置和发动。', 'success', PRIVATE, true, 'power');
      }
      const round = next.round;
      const oldRound = before.round;
      if (!round || !oldRound) return finish();
      const ownStatus = round.visitors?.find(player => player.id === next.you)?.status;
      const oldStatus = oldRound.visitors?.find(player => player.id === next.you)?.status;
      const died = oldStatus === 'alive' && ownStatus !== 'alive';

      for (const notebook of added(oldRound.notebooks, round.notebooks)) {
        push(`手记${notebook.number ?? ''}已公开`, notebook.power
          ? `${powerName(notebook.power)}：${notebook.power.description}` : '所有玩家都能在公开手记中查看这条信息。', 'info', PUBLIC, true, 'notebook');
      }
      for (const discovery of (round.publicDiscoveries || []).slice(oldRound.publicDiscoveries?.length || 0)) {
        push(`${playerName(next, discovery.playerId)}公开了${tokenName(discovery.token)}`,
          `${tokenDescription(discovery.token)} 这是玩家主动公开的当时信息。`, 'info', PUBLIC, true, tokenSymbol(discovery.token));
      }
      if (round.powers?.announcement && changed(oldRound.powers?.announcement, round.powers.announcement)) {
        push(`哭喊指向${roomName(next, round.powers.announcement.roomId)}`, '地图已标记宣告房间，保留至下一次箱娃阶段开始。', 'attention', PUBLIC, true);
      }
      const activation = round.powers?.lastActivation;
      const activated = activation && (changed(oldRound.powers?.lastActivation, activation)
        || logs.includes('箱娃发动了能力。'));
      if (activated) {
        const privateCard = round.hako?.playerId === next.you && activation.powerId <= 4 && !activation.public;
        push(activation.name ? `箱娃发动了${powerName(activation)}` : '箱娃发动了能力',
          activation.name ? '请查看当前操作提示，按能力效果继续结算。' : '本次能力的名称未公开，请查看当前操作提示。',
          'attention', privateCard ? PRIVATE : PUBLIC, activation.powerId >= 5 || Boolean(round.resolution?.kind === 'forced_peek'), 'power');
      }
      if (!oldRound.safe?.opened && round.safe?.opened) push('保险箱已打开', '钥匙已取出，携带钥匙找到隐藏出口即可逃脱。', 'success', PUBLIC, true, 'key');

      const incoming = added(oldRound.exchangeOffers, round.exchangeOffers).filter(offer => offer.targetId === next.you);
      for (const offer of incoming) {
        const pieces = [...(offer.giveTokens || []).map(tokenName), ...(offer.giveItems || []).map(item => item.name)];
        push(`${playerName(next, offer.fromId)}向你提出交换`, pieces.length ? `对方提出交出：${pieces.join('、')}。接受前请检查需要付出的物品。` : '查看交换内容，再决定接受或拒绝。', 'attention', PRIVATE, true);
      }
      if ((oldRound.exchangeOffers || []).some(offer => !round.exchangeOffers?.some(current => current.id === offer.id))) {
        push('交换请求已处理', '请查看当前随身物品，已完成的交换会立即更新库存。', 'info', PRIVATE);
      }
      const canRespond = round.interruption?.canRespond;
      if (canRespond && !oldRound.interruption?.canRespond) push('请回应灭火器窗口', '你可以使用灭火器打断，或选择放弃；其他玩家正在等待你的回应。', 'attention', PRIVATE, true);
      if (round.silent?.turnPlayerId === next.you && round.phase === 'visitor_reveal'
          && (oldRound.silent?.turnPlayerId !== next.you || oldRound.phase !== 'visitor_reveal')) {
        push('轮到你了', '先翻开无声标志，或按规则持牌跳过。', 'attention', PRIVATE, false, 'turn');
      }
      if (round.phase === 'hako_phase' && oldRound.phase !== 'hako_phase') {
        push(round.hako?.playerId === next.you ? '轮到箱娃行动' : '进入箱娃阶段',
          round.hako?.playerId === next.you ? '先决定是否哭喊，再设置或回收能力，最后移动潜伏。' : '等待箱娃完成哭喊、能力及潜伏；你可以查看地图和已知信息。', 'info', PUBLIC, false, 'turn');
      }

      const resolution = round.resolution;
      if (resolution?.token && changed(oldRound.resolution, resolution)
          && !(oldRound.resolution?.token?.id === resolution.token.id && oldRound.resolution?.cornerId === resolution.cornerId)) {
        push(`你发现了${tokenName(resolution.token)}`, `${tokenDescription(resolution.token)} 这是你的私密窥探结果；返回游戏后按提示决定如何处理。`, 'success', PRIVATE, true, tokenSymbol(resolution.token));
      }
      if (resolution?.kind === 'forced_peek' && oldRound.resolution?.kind !== 'forced_peek') {
        push('你的行动被改为强制窥探', '请选择当前房间内的一个角落，随后按窥探结果结算。', 'attention', PRIVATE, true);
      }
      if (round.items?.result && changed(oldRound.items?.result, round.items.result)) {
        const card = round.items.result.card;
        push(card ? `手机查看：${powerName(card)}` : '道具结果已更新', card?.description || '查看你的道具结果，具体内容仅你可见。', 'info', PRIVATE, true, card ? 'power' : 'item');
      }
      const sharedEntries = value => Array.isArray(value) ? value : value ? [value] : [];
      const oldShared = sharedEntries(oldRound.sharedTokens);
      for (const shared of sharedEntries(round.sharedTokens)) {
        const completedSafeAttempt = shared.kind === 'safe_result' && oldRound.resolution?.kind === 'safe' && !round.resolution;
        if (!completedSafeAttempt && oldShared.some(old => !changed(old, shared))) continue;
        if (['shown_token', 'shown_possession'].includes(shared.kind)) {
          push(`${playerName(next, shared.fromId)}向你展示了${shared.item ? shared.item.name : tokenName(shared.token)}`,
            `${shared.item ? shared.item.description || '对方持有这张道具。' : tokenDescription(shared.token)} 仅你收到这次展示。`,
            'info', PRIVATE, true, shared.item ? 'item' : tokenSymbol(shared.token));
        } else if (shared.kind === 'safe_result') push(shared.correct ? '保险箱尝试正确' : '保险箱尝试未成功', shared.usedStethoscope ? shared.correct ? '听诊器确认的正确数字已公开，可在保险箱信息中查看。' : '听诊器已完成本次尝试，未公开新的正确数字。' : '请按当前保险箱状态继续探索。', shared.correct ? 'success' : 'attention', PRIVATE, true, 'password');
      }

      const lastDraw = round.powers?.lastDraw;
      if (lastDraw && changed(oldRound.powers?.lastDraw, lastDraw)) {
        const names = (lastDraw.cards || []).map(id => powerName(round.powers.hand?.find(card => card.id === id) || id)).join('、');
        if (lastDraw.kind === 'returned') push('哭喊未获得新能力', `抽到${names}，对应手记尚未公开，已放回牌库底。`, 'attention', PRIVATE, true, 'power');
        else if (lastDraw.kind === 'empty_deck') push('能力牌库已空', '这次哭喊没有抽到能力牌。', 'info', PRIVATE, true, 'power');
        else push(lastDraw.kind === 'despair' ? '绝望时刻：获得新能力' : `获得了${names}`, lastDraw.kind === 'despair'
          ? `${names}已加入手牌，可绕过手记数量门槛。` : '能力已加入你的手牌，可在能力栏中查看和设置。', 'success', PRIVATE, true, 'power');
      } else {
        const ownedPowers = [...(oldRound.powers?.hand || []), ...(oldRound.powers?.slots || []).flatMap(slot => slot.card ? [slot.card] : [])];
        for (const card of added(ownedPowers, round.powers?.hand)) push(`获得了${powerName(card)}`, card.description || '能力已加入你的手牌。', 'success', PRIVATE, true, 'power');
      }
      for (const key of ['tokens', 'items']) {
        for (const piece of added(oldRound.inventory?.[key], round.inventory?.[key])) {
          push(`获得了${key === 'tokens' ? tokenName(piece) : piece.name || '道具'}`, `${key === 'tokens' ? tokenDescription(piece) : piece.description || '道具已加入你的随身物品。'} 可在“我的物品”中回看。`, 'success', PRIVATE, true, key === 'tokens' ? tokenSymbol(piece) : 'item');
        }
        if (!died) for (const piece of added(round.inventory?.[key], oldRound.inventory?.[key])) {
          const stolen = activated && activation.powerId === 7;
          push(`${stolen ? '被抢走了' : '随身物品移出：'}${key === 'tokens' ? tokenName(piece) : piece.name || '道具'}`,
            stolen ? '这件物品已不在你的库存中，你可以重新声明行动。' : '物品已按本次操作移出库存，请以当前随身物品为准。', stolen ? 'danger' : 'info', PRIVATE, stolen, key === 'tokens' ? tokenSymbol(piece) : 'item');
        }
      }
      for (const visitor of round.visitors || []) {
        const old = oldRound.visitors?.find(player => player.id === visitor.id);
        if (!old || old.status === visitor.status || visitor.status === 'alive') continue;
        const me = visitor.id === next.you;
        const banished = visitor.status === 'banished';
        push(me ? banished ? '你已被讨伐' : '你已死亡，转为箱人' : `${playerName(next, visitor.id)}${banished ? '已被讨伐' : '已死亡，转为箱人'}`,
          me ? banished ? '你已无法继续潜伏，仍可查看公开进度。' : '你仍可在箱娃阶段作为箱人移动和潜伏，请查看新的操作提示。' : '玩家状态已更新，具体潜伏位置继续保密。', 'danger', PUBLIC, true, 'death');
      }
      if (round.result && changed(oldRound.result, round.result)) push(`${round.result.winner === 'visitors' ? '访问者' : '箱娃'}获胜`,
        /[\u4e00-\u9fff]/.test(round.result.reason || '') ? round.result.reason : '本局已结束，可回看地图、物品和事件。', 'success', PUBLIC, true, 'victory');
      return finish();
    },
  };
}
