const SILENT_NUMBERS = [0, 1, 2, 3, 4, 5];

function makeCards(numbers) {
  if (numbers !== undefined && (!Array.isArray(numbers) || numbers.length !== 6
      || SILENT_NUMBERS.some(number => !numbers.includes(number)))) {
    throw new Error('无声标志必须包含0至5各一枚。');
  }
  const values = numbers === undefined ? [...SILENT_NUMBERS] : [...numbers];
  if (numbers === undefined) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
  }
  return values.map((number, index) => ({ index, number, status: 'down' }));
}

export function createSilentRound(visitorIds, { numbers } = {}) {
  if (!Array.isArray(visitorIds) || ![3, 4].includes(visitorIds.length)
      || new Set(visitorIds).size !== visitorIds.length
      || Array.from(visitorIds).some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('无声模式需要三名或四名不同的访问者。');
  }
  return {
    phase: 'visitor_reveal',
    cycle: 1,
    visitorIds: [...visitorIds],
    turnPlayerId: visitorIds[0],
    resumePlayerId: null,
    total: 0,
    trigger: null,
    revealsRemaining: 0,
    cards: makeCards(numbers),
  };
}

function assertVisitorTurn(state, playerId, phase) {
  if (state.phase !== phase) throw new Error('当前阶段不能执行此操作。');
  if (!state.visitorIds.includes(playerId)) throw new Error('只有访问者可以执行此操作。');
  if (state.turnPlayerId !== playerId) throw new Error('还没有轮到你行动。');
}

function getDownCard(state, index) {
  if (!Number.isInteger(index) || index < 0 || index > 5) {
    throw new Error('请选择0至5号位置的无声标志。');
  }
  const card = state.cards[index];
  if (card.status !== 'down') throw new Error('只能选择仍然盖放的无声标志。');
  return card;
}

function endVisitorTurn(state, playerId) {
  state.revealsRemaining = 0;
  state.turnSerial = (state.turnSerial ?? 0) + 1;
  const nextPlayerId = state.visitorIds[(state.visitorIds.indexOf(playerId) + 1) % state.visitorIds.length];
  if (state.cards.filter(card => card.status === 'down').length === 1) {
    state.phase = 'hako_phase';
    state.turnPlayerId = null;
    state.resumePlayerId = nextPlayerId;
    state.trigger = 'one_hidden';
  } else {
    state.phase = 'visitor_reveal';
    state.turnPlayerId = nextPlayerId;
  }
}

export function revealSilent(state, playerId, index, { count = 1 } = {}) {
  assertVisitorTurn(state, playerId, 'visitor_reveal');
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('本次须翻开1至5枚无声标志。');
  const card = getDownCard(state, index);
  const remaining = state.revealsRemaining > 0 ? state.revealsRemaining : count;
  card.status = 'up';
  state.total += card.number;
  state.revealsRemaining = remaining - 1;
  if (state.total > 10) {
    // 留给本次翻牌者即时使用灭火器，随后才开始箱娃阶段。
    state.phase = 'hako_reaction';
    state.turnPlayerId = null;
    state.resumePlayerId = playerId;
    state.trigger = 'overflow';
    state.revealsRemaining = 0;
  } else if (state.revealsRemaining === 0 || state.cards.filter(item => item.status === 'down').length === 1) {
    state.revealsRemaining = 0;
    state.phase = 'visitor_action';
  }
  return getSilentView(state);
}

export function skipSilent(state, playerId, index) {
  assertVisitorTurn(state, playerId, 'visitor_reveal');
  if (state.revealsRemaining > 0) throw new Error('连续翻牌已经开始，不能改为持牌跳过。');
  const card = getDownCard(state, index);
  if (state.cards.some(item => item.status === 'up' && item.number === 0)) {
    throw new Error('数字0已经翻开，不能跳过本回合。');
  }
  card.status = 'held';
  card.holderId = playerId;
  endVisitorTurn(state, playerId);
  return getSilentView(state);
}

export function finishVisitorAction(state, playerId) {
  assertVisitorTurn(state, playerId, 'visitor_action');
  endVisitorTurn(state, playerId);
  return getSilentView(state);
}

/** Keep the original circular seat order when a visitor becomes a box person. */
export function removeSilentVisitor(state, playerId) {
  const index = state.visitorIds.indexOf(playerId);
  if (index < 0) throw new Error('该玩家不在存活访问者的行动顺序中。');
  const successor = state.visitorIds.length > 1
    ? state.visitorIds[(index + 1) % state.visitorIds.length] : null;
  state.visitorIds = state.visitorIds.filter(id => id !== playerId);
  if (state.turnPlayerId === playerId) state.turnPlayerId = successor;
  if (state.resumePlayerId === playerId) state.resumePlayerId = successor;
  return getSilentView(state);
}

export function passNoiseReaction(state) {
  if (state.phase !== 'hako_reaction') throw new Error('当前没有待结算的杂音反应。');
  state.phase = 'hako_phase';
  return getSilentView(state);
}

export function finishHakoPhase(state, { numbers } = {}) {
  if (state.phase !== 'hako_phase') throw new Error('当前不是箱娃阶段。');
  // 先验证并构造新标志，确保无效的指定牌序不会改变当前状态。
  const cards = makeCards(numbers);
  state.cards = cards;
  state.cycle += 1;
  state.turnSerial = (state.turnSerial ?? 0) + 1;
  state.total = 0;
  state.phase = 'visitor_reveal';
  state.turnPlayerId = state.resumePlayerId;
  state.resumePlayerId = null;
  state.trigger = null;
  state.revealsRemaining = 0;
  return getSilentView(state);
}

export function getSilentView(state) {
  return {
    phase: state.phase,
    cycle: state.cycle,
    turnPlayerId: state.turnPlayerId,
    total: state.total,
    trigger: state.trigger,
    ...(state.revealsRemaining > 0 ? { revealsRemaining: state.revealsRemaining } : {}),
    cards: state.cards.map(card => {
      const view = { index: card.index, status: card.status };
      if (card.status === 'up') view.number = card.number;
      if (card.status === 'held') view.holderId = card.holderId;
      return view;
    }),
  };
}
