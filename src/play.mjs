import { INITIAL_ITEMS, getInitialRoomMemory } from './preparation.mjs';
import { createRound, applyRoundAction, getRoundView } from './round.mjs';
import { finishVisitorAction, finishHakoPhase, removeSilentVisitor } from './silent.mjs';
import { getRoom, getCornerRoom, getHidingTargets, getMoveTargets } from './movement.mjs';
import { createPowers, startPowerStage, applyPowerAction, getPowersView, powerCard,
  powerHidingTargets, restrictPowerMoves, afterPowerMove, hasActivePower, isPowerMoveForced } from './powers.mjs';
import { declareItem, resolveItem, answerItem, getItemView, itemResolutionView } from './items.mjs';
import { revealWithEffects, syncNoiseEffects, getNoiseEffectsView } from './noise-effects.mjs';
import { getLogicalRoomId } from './maps.mjs';
import { emitGameEvent } from './events.mjs';
import { applyWalkieAction, getWalkieView, isLockedWalkie, invalidateWalkieForDeath } from './walkie.mjs';

const TAKEABLE = new Set(['key', 'password', 'doll', 'weakness_clue', 'weapon', 'amulet', 'extinguisher']);
const NAMES = { hako: '箱娃', box_person: '箱人', notebook: '手记', empty_box: '空箱', safe: '转轮式保险箱',
  hidden_exit: '隐藏出口', remains: '亡骸', key: '钥匙', password: '密码', doll: '玛丽小姐的人偶',
  weakness_clue: '讨伐情况', amulet: '古怪护符', extinguisher: '灭火器' };
const TOOL_NAMES = { white_stick: '白木椿', gasoline: '汽油', rusty_chain: '锈锁链' };
const clone = value => structuredClone(value);
const tokenView = token => token ? { ...clone(token), name: token.type === 'weapon' ? TOOL_NAMES[token.tool]
  : token.type === 'weakness_clue' ? `${TOOL_NAMES[token.tool]}无效`
    : token.type === 'password' ? `密码${token.number}`
      : token.type === 'notebook' ? `手记${token.number}` : NAMES[token.type],
  ...(token.type === 'notebook' ? { power: powerCard({ id: token.number }) } : {}) } : null;

function visitor(play, id) { return play.round.visitors.find(player => player.id === id); }
function alive(play, id) { return visitor(play, id)?.status === 'alive'; }
function inventory(play, id) { return play.inventories[id]; }
function itemView(item) {
  const current = INITIAL_ITEMS.find(known => known.id === item.id);
  return { ...clone(item), description: current?.description || item.description };
}
function hasItem(play, id, itemId) { return inventory(play, id)?.items.some(item => item.id === itemId); }
function hasToken(play, id, type) { return inventory(play, id)?.tokens.some(token => token.type === type); }
function roomOf(cornerId) { return getCornerRoom(cornerId)?.id; }
function corners(play, roomId) {
  return [...getRoom(roomId).corners, ...Object.values(play.extraCorners).filter(corner => getLogicalRoomId(corner.roomId) === getLogicalRoomId(roomId))];
}
function ghostOf(play, id) { return play.ghosts.find(ghost => ghost.playerId === id); }
function actorsAt(play, cornerId) {
  return [
    ...(play.round.hidingCornerId === cornerId ? [{ playerId: play.round.hakoId, type: 'hako', cornerId }] : []),
    ...play.ghosts.filter(ghost => !ghost.banished && ghost.cornerId === cornerId)
      .map(ghost => ({ playerId: ghost.playerId, type: 'box_person', cornerId })),
  ];
}
function occupied(play, cornerId) { return !!play.tokens[cornerId] || actorsAt(play, cornerId).length > 0; }
function assertPlayer(play, id) {
  if (id !== play.round.hakoId && !visitor(play, id)) throw new Error('只有本局玩家可以查看或操作。');
}
function assertAlive(play, id) {
  if (!alive(play, id)) throw new Error('只有存活访问者可以进行此操作。');
  return visitor(play, id);
}
function assertTurn(play, id) {
  const player = assertAlive(play, id);
  if (play.round.silent.phase !== 'visitor_action' || play.round.silent.turnPlayerId !== id) {
    throw new Error('请等待自己的行动机会并先翻开无声标志。');
  }
  return player;
}
function assertFree(play, id) {
  const player = assertAlive(play, id);
  if (!['visitor_reveal', 'visitor_action'].includes(play.round.silent.phase)
      || play.round.silent.revealsRemaining > 0
      || play.round.pendingAction || play.resolution) throw new Error('请等待当前结算或箱娃阶段结束。');
  return player;
}
function assertSameRoom(play, fromId, targetId) {
  const from = assertAlive(play, fromId);
  const target = assertAlive(play, targetId);
  if (fromId === targetId || getLogicalRoomId(from.roomId) !== getLogicalRoomId(target.roomId)) throw new Error('请选择同一房间内的其他存活访问者。');
}
function assertCorner(play, id, cornerId, { mustBeOccupied = false, mustBeEmpty = false } = {}) {
  if (!Object.hasOwn(play.tokens, cornerId) || roomOf(cornerId) !== getLogicalRoomId(visitor(play, id)?.roomId)) {
    throw new Error('只能选择自己当前房间内的角落。');
  }
  if (mustBeOccupied && !occupied(play, cornerId)) throw new Error('空角落不能窥探。');
  if (mustBeEmpty && occupied(play, cornerId)) throw new Error('只能将标志丢弃在空角落。');
}
function finishAction(play, id) { finishVisitorAction(play.round.silent, id); }
function revealDiscard(play, id) {
  const held = inventory(play, id);
  if (held.tokens.length || held.items.length) {
    play.discarded.push({ playerId: id, tokens: clone(held.tokens), items: clone(held.items) });
  }
  held.tokens = [];
  held.items = [];
}
function setResult(play, winner, reason, playerId = null) {
  play.result = { winner, reason, playerId, winners: winner === 'visitors'
    ? play.round.visitors.filter(player => player.status === 'alive' || play.ringAllies.includes(player.id)).map(player => player.id)
    : [play.round.hakoId, ...play.round.visitors.filter(player => player.status !== 'alive' && !play.ringAllies.includes(player.id)).map(player => player.id)] };
}
function checkVictory(play) {
  if (play.result) return;
  if (!play.round.visitors.some(player => player.status === 'alive')) {
    setResult(play, 'hako', '所有访问者均已死亡');
    return;
  }
  // Stolen pieces cannot be recovered unless Hako chooses to return them (rulebook
  // pages 12/15). A pending inheritance still owns its pieces until decided.
  const tokens = [...Object.values(play.tokens).filter(Boolean),
    ...Object.values(play.inventories).flatMap(held => held.tokens)];
  const has = type => tokens.some(token => token.type === type);
  const escape = has('hidden_exit') && (has('key') || (has('safe') && !!play.opening.safeBoard.key));
  const exorcism = has('doll') && has('remains');
  const subjugation = tokens.some(token => token.type === 'weapon' && token.tool === play.opening.weakness);
  if (!escape && !exorcism && !subjugation) setResult(play, 'hako', '三条访问者胜利路线均已无法达成');
}
function beginHakoStage(play) {
  if (play.result || play.round.silent.phase !== 'hako_phase' || play.resolution) return;
  if (play.hakoStage?.cycle === play.round.silent.cycle) return;
  play.ringAllies = [];
  play.totalRounds = (play.totalRounds ?? Math.max(0, play.round.silent.cycle - 1)) + 1;
  play.hakoStage = { cycle: play.round.silent.cycle, done: [], inspections: {} };
  startPowerStage(play, context(play));
}
function endStandardAction(play, id) {
  play.resolution = null;
  finishAction(play, id);
}
function die(play, id, killerCornerId) {
  const player = assertAlive(play, id);
  if (!actorsAt(play, killerCornerId).length) throw new Error('死亡须由实际潜伏的箱娃或箱人结算。');
  const ring = hasItem(play, id, 'relic_ring');
  if (ring && !play.ringAllies.includes(id)) {
    play.ringAllies.push(id);
    emitGameEvent(play, { kind: 'item_used', itemId: 'relic_ring', userId: id, status: 'triggered' });
  }
  // Cards leave play permanently; only physical carried tokens can be inherited.
  play.removedItems ??= [];
  play.removedItems.push(...inventory(play, id).items);
  inventory(play, id).items = [];
  invalidateWalkieForDeath(play, id);
  // End the living turn before removing the seat so silent mode preserves its successor.
  if (play.round.silent.phase === 'visitor_action' && play.round.silent.turnPlayerId === id) finishAction(play, id);
  removeSilentVisitor(play.round.silent, id);
  player.status = 'box_person';
  delete player.roomId;
  play.ghosts.push({ playerId: id, cornerId: killerCornerId, banished: false, carriedTokens: [] });
  const death = emitGameEvent(play, { kind: 'death', userId: id, cornerId: killerCornerId, status: 'triggered' });
  play.deathEvents ??= [];
  play.deathEvents.push({ id: death.id, userId: id, cornerId: killerCornerId, cycle: death.cycle });
  play.deathLocations ??= [];
  play.deathLocations.push({ id: death.id, userId: id, cornerId: killerCornerId, cycle: death.cycle });
  play.exchangeOffers = play.exchangeOffers.filter(offer => offer.fromId !== id && offer.targetId !== id);
  play.resolution = null;
  if (inventory(play, id).tokens.length && play.round.visitors.some(candidate => candidate.status === 'alive')) {
    play.resolution = { kind: 'inheritance', playerId: id };
  } else revealDiscard(play, id);
  checkVictory(play);
}

/** The token layer contains the original piece below each hidden actor. Actors are overlaid
 * for peeking/attacking, so stacked ghosts never overwrite or duplicate a physical piece. */
export function createPlay(setup, opening, { numbers } = {}) {
  if (opening?.phase !== 'opening_ready') throw new Error('请先完成箱娃的秘密开局配置。');
  const round = createRound(setup, { hakoId: opening.hakoId, hidingCornerId: opening.hidingCornerId, numbers });
  round.visitors.forEach(player => { player.status = 'alive'; });
  const tokens = clone(opening.cornerTokens);
  tokens[opening.hidingCornerId] = clone(opening.hidingUnderToken);
  return {
    round, opening: clone(opening), tokens,
    inventories: Object.fromEntries(round.visitors.map(player => [player.id, {
      tokens: [], items: opening.itemChoices.filter(choice => choice.playerId === player.id)
        .map(choice => clone(INITIAL_ITEMS.find(item => item.id === choice.itemId)))
        .filter(Boolean),
    }])),
    availableItems: INITIAL_ITEMS.filter(item => !opening.itemChoices.some(choice => choice.itemId === item.id)).map(clone),
    notebooks: [], ghosts: [], discarded: [], removedTokens: [], publicNumbers: [],
    safeOpened: false, resolution: null, exchangeOffers: [], nextOfferId: 1, surrenderVotes: [],
    sharedTokens: {}, publicDiscoveries: [], totalRounds: 0, ringAllies: [], hakoStage: null, result: null,
    powers: createPowers(opening), extraCorners: {}, placedItems: [], itemResults: {}, itemEvents: [],
    interruption: null, inheritanceQueue: [], removedItems: [], deathEvents: [], deathLocations: [],
    lastBlockedWait: null, hidingMemories: { [opening.hakoId]: getInitialRoomMemory(opening) },
  };
}

function context(play) {
  return {
    assertTurn: id => assertTurn(play, id), hasItem: (id, itemId) => hasItem(play, id, itemId),
    inventory: id => inventory(play, id), visitor: id => visitor(play, id), roomOf,
    corners: roomId => corners(play, roomId), actorsAt: cornerId => actorsAt(play, cornerId), tokenView,
    die: (id, cornerId) => die(play, id, cornerId), finishAction: id => finishAction(play, id), powerCard,
    canLie: () => hasActivePower(play, 9), forcePeek: id => forcePeek(play, id),
    queueDeaths: deaths => queueDeaths(play, deaths), processDeaths: deaths => processDeaths(play, deaths),
    finishHakoStage: () => skipHakoStage(play),
    assertFree: id => assertFree(play, id),
  };
}

function forcePeek(play, id) {
  if (!corners(play, visitor(play, id).roomId).some(corner => occupied(play, corner.id))) throw new Error('该访问者所在房间没有可供强制窥探的标志。');
  play.round.pendingAction = null;
  play.resolution = { kind: 'forced_peek', playerId: id };
}
function chooseForcedPeek(play, id, action) {
  if (play.resolution?.kind !== 'forced_peek' || play.resolution.playerId !== id) throw new Error('当前没有等待你选择的强制窥探。');
  play.resolution = null;
  declarePeek(play, id, action);
  const pending = play.round.pendingAction;
  play.round.pendingAction = null;
  beginPeek(play, pending);
}

function processDeaths(play, deaths) {
  const heirs = [];
  for (const death of deaths) {
    if (!alive(play, death.playerId)) continue;
    die(play, death.playerId, death.killerCornerId);
    if (play.resolution?.kind === 'inheritance') {
      heirs.push(play.resolution.playerId);
      play.resolution = null;
    }
  }
  if (play.result || !play.round.visitors.some(player => player.status === 'alive')) {
    for (const id of heirs) revealDiscard(play, id);
  } else if (heirs.length) {
    play.resolution = { kind: 'inheritance', playerId: heirs.shift() };
    play.inheritanceQueue ??= [];
    play.inheritanceQueue.push(...heirs);
  }
}
function extinguisherOwners(play) {
  return play.round.visitors.filter(player => player.status === 'alive' && hasToken(play, player.id, 'extinguisher')).map(player => player.id);
}
function queueDeaths(play, deaths) {
  const responders = extinguisherOwners(play);
  if (responders.length) play.interruption = { kind: 'power', responders, passed: [], deaths: clone(deaths) };
  else processDeaths(play, deaths);
}
function syncNoiseInterruption(play) {
  if (play.result || play.interruption || play.round.silent.phase !== 'hako_reaction'
      || play.round.silent.trigger !== 'overflow' || play.powers.noiseRespondedCycle === play.round.silent.cycle) return;
  const responders = extinguisherOwners(play);
  if (responders.length) play.interruption = { kind: 'noise', responders, passed: [] };
}
function finishBlockedMove(play) {
  const id = play.round.silent.turnPlayerId;
  if (play.result || play.round.silent.phase !== 'visitor_action' || play.round.pendingAction || play.resolution
      || play.interruption || !isPowerMoveForced(play, id)) return;
  const roomId = visitor(play, id).roomId;
  const targets = getMoveTargets(play.round.placements, roomId, { blockedDoors: play.round.blockedDoors });
  if (restrictPowerMoves(play, id, targets).length) return;
  // User-confirmed resolution for NO.3 + NO.10: reveal noise normally, then wait
  // out an unreachable route rather than trapping the game before doors reopen.
  play.lastBlockedWait = { playerId: id, roomId, cycle: play.round.silent.cycle };
  finishAction(play, id);
}
function skipHakoStage(play) {
  if (play.round.silent.phase === 'hako_reaction') {
    applyRoundAction(play.round, play.round.hakoId, { type: 'pass_noise_reaction' });
    beginHakoStage(play);
  }
  play.ringAllies = [];
  finishHakoPhase(play.round.silent);
  play.hakoStage = null;
  play.powers.step = null;
  play.interruption = null;
}
function respondExtinguisher(play, id, action) {
  const window = play.interruption;
  if (!window || !window.responders.includes(id) || window.passed.includes(id) || !alive(play, id)) {
    throw new Error('当前没有等待你的灭火器响应。');
  }
  if (typeof action.use !== 'boolean') throw new Error('请选择使用灭火器或放弃。');
  if (action.use) {
    const held = inventory(play, id);
    const index = held.tokens.findIndex(token => token.type === 'extinguisher');
    if (index < 0) throw new Error('你没有携带灭火器。');
    play.removedTokens.push(held.tokens.splice(index, 1)[0]);
    emitGameEvent(play, { kind: 'item_used', itemId: 'extinguisher', userId: id, status: 'triggered' });
    if (window.restorePowers) play.powers = window.restorePowers;
    skipHakoStage(play);
    return;
  }
  window.passed.push(id);
  if (window.responders.every(responder => window.passed.includes(responder))) {
    play.interruption = null;
    if (window.kind === 'noise') play.powers.noiseRespondedCycle = play.round.silent.cycle;
    else processDeaths(play, window.deaths);
  }
}

function declarePeek(play, id, action) {
  assertTurn(play, id);
  assertCorner(play, id, action.cornerId, { mustBeOccupied: true });
  if (action.useNightVision && !hasItem(play, id, 'night_vision')) throw new Error('你没有携带夜视仪。');
  if (action.useNightVision !== undefined && typeof action.useNightVision !== 'boolean') throw new Error('请选择是否使用夜视仪。');
  play.round.pendingAction = { type: 'peek', playerId: id, cornerId: action.cornerId, useNightVision: action.useNightVision === true };
  if (action.useNightVision) emitGameEvent(play, { kind: 'item_declared', itemId: 'night_vision', userId: id, status: 'declared' });
}
function beginPeek(play, pending) {
  const { playerId: id, cornerId } = pending;
  assertTurn(play, id);
  assertCorner(play, id, cornerId, { mustBeOccupied: true });
  const actors = actorsAt(play, cornerId);
  if (pending.useNightVision) {
    const effective = !actors.length && play.tokens[cornerId]?.type === 'notebook'
      && getLogicalRoomId(roomOf(play.round.hidingCornerId)) !== getLogicalRoomId(visitor(play, id).roomId);
    emitGameEvent(play, { kind: effective ? 'item_used' : 'item_ineffective', itemId: 'night_vision', userId: id,
      status: effective ? 'triggered' : 'ineffective' });
  }
  if (actors.length) { die(play, id, cornerId); return; }
  const token = play.tokens[cornerId];
  if (token.type === 'notebook') {
    play.notebooks.push(clone(token));
    play.tokens[cornerId] = null;
    if (pending.useNightVision && roomOf(play.round.hidingCornerId) === visitor(play, id).roomId) {
      // The notebook is already public when the night-vision death takes effect.
      if (play.opening.emptyBoxTokens.length) play.tokens[cornerId] = { ...play.opening.emptyBoxTokens.shift(), faceUp: false };
      die(play, id, play.round.hidingCornerId);
      return;
    }
    play.resolution = { kind: 'notebook', playerId: id, cornerId, token: clone(token),
      useNightVision: pending.useNightVision };
    return;
  }
  if (token.type === 'hidden_exit' && hasToken(play, id, 'key')) {
    setResult(play, 'visitors', '逃脱', id); return;
  }
  if (token.type === 'remains' && hasToken(play, id, 'doll')) {
    setResult(play, 'visitors', '超度', id); return;
  }
  play.resolution = { kind: token.type === 'safe' ? 'safe' : 'peek', playerId: id, cornerId, token: clone(token) };
}
function replaceCorner(play, id, cornerId, action) {
  if (action.replacement === 'empty_box') {
    if (!play.opening.emptyBoxTokens.length) throw new Error('备用空箱已用尽，请弃置随身标志或留空。');
    if (action.faceUp && !hasItem(play, id, 'deduction')) throw new Error('携带归纳推理法才可将空箱的X面朝上。');
    play.tokens[cornerId] = { ...play.opening.emptyBoxTokens.shift(), faceUp: action.faceUp === true };
    if (action.faceUp) emitGameEvent(play, { kind: 'item_used', itemId: 'deduction', userId: id, cornerId, status: 'triggered' });
  } else if (action.replacement === 'none') {
    if (play.opening.emptyBoxTokens.length) throw new Error('仍有备用空箱，取走标志后须补位。');
    play.tokens[cornerId] = null;
  } else {
    const held = inventory(play, id);
    const index = held.tokens.findIndex(token => token.id === action.replacement);
    if (index < 0) throw new Error('请选择备用空箱或自己持有的一枚标志补位。');
    assertDollTransfer(play, id, [action.replacement]);
    play.tokens[cornerId] = held.tokens.splice(index, 1)[0];
  }
}
function resolvePeek(play, id, action) {
  const resolution = play.resolution;
  if (!resolution || resolution.playerId !== id || !['peek', 'notebook'].includes(resolution.kind)) {
    throw new Error('当前没有等待你结算的窥探。');
  }
  assertTurn(play, id);
  const { token, cornerId } = resolution;
  if (resolution.kind === 'notebook') {
    if (resolution.useNightVision && play.availableItems.length) {
      const index = play.availableItems.findIndex(item => item.id === action.itemId);
      if (index < 0) throw new Error('请选择本局开局未选的可继承访问者道具。');
      inventory(play, id).items.push(play.availableItems.splice(index, 1)[0]);
    } else if (action.itemId !== undefined) throw new Error('此次窥探不能获得访问者道具。');
    replaceCorner(play, id, cornerId, action);
  } else if (TAKEABLE.has(token.type)) {
    if (typeof action.take !== 'boolean') throw new Error('请选择获取标志或将其盖回。');
    if (action.take) {
      if (action.replacement === token.id) throw new Error('补位须使用原先持有的其他标志。');
      replaceCorner(play, id, cornerId, action);
      inventory(play, id).tokens.push(clone(token));
    }
  } else if (action.take) throw new Error('此类标志无法获取，请将其盖回。');
  endStandardAction(play, id);
}
function guessSafe(play, id, action) {
  const resolution = play.resolution;
  if (resolution?.kind !== 'safe' || resolution.playerId !== id) throw new Error('请先窥探保险箱。');
  assertTurn(play, id);
  if (action.useStethoscope !== undefined && typeof action.useStethoscope !== 'boolean') throw new Error('请选择是否使用听诊器。');
  const using = action.useStethoscope === true;
  if (!Array.isArray(action.numbers) || action.numbers.length !== (using ? 1 : 3)
      || new Set(action.numbers).size !== action.numbers.length
      || action.numbers.some(number => !Number.isInteger(number) || number < 1 || number > 6)) {
    throw new Error(using ? '听诊器需要声明一个1至6的数字。' : '请声明三个不同的1至6密码数字，顺序不限。');
  }
  if (using && !hasItem(play, id, 'stethoscope')) throw new Error('你没有携带听诊器。');
  if (using) {
    const lethal = roomOf(play.round.hidingCornerId) === visitor(play, id).roomId;
    emitGameEvent(play, { kind: lethal ? 'item_ineffective' : 'item_used', itemId: 'stethoscope', userId: id,
      status: lethal ? 'ineffective' : 'triggered' });
  }
  if (using && roomOf(play.round.hidingCornerId) === visitor(play, id).roomId) {
    die(play, id, play.round.hidingCornerId); return;
  }
  const correct = action.numbers.every(number => play.opening.password.includes(number));
  if (using && correct) play.publicNumbers = [...new Set([...play.publicNumbers, action.numbers[0]])].sort((a, b) => a - b);
  if (!using && correct && play.opening.safeBoard.key) {
    inventory(play, id).tokens.push(clone(play.opening.safeBoard.key));
    play.opening.safeBoard.key = null;
    play.safeOpened = true;
  }
  play.sharedTokens[id] = { kind: 'safe_result', correct, usedStethoscope: using };
  endStandardAction(play, id);
}
function declareWeapon(play, id, action) {
  assertTurn(play, id);
  assertCorner(play, id, action.cornerId);
  if (!inventory(play, id).tokens.some(token => token.id === action.tokenId && token.type === 'weapon')) {
    throw new Error('请选择自己持有的一枚讨伐道具。');
  }
  play.round.pendingAction = { type: 'weapon', playerId: id, cornerId: action.cornerId, tokenId: action.tokenId };
  const weapon = inventory(play, id).tokens.find(token => token.id === action.tokenId);
  emitGameEvent(play, { kind: 'item_declared', itemId: 'weapon', name: tokenView(weapon).name, userId: id, cornerId: action.cornerId, status: 'declared' });
}
function resolveWeapon(play, pending) {
  const { playerId: id, cornerId, tokenId } = pending;
  assertTurn(play, id);
  assertCorner(play, id, cornerId);
  const held = inventory(play, id);
  const index = held.tokens.findIndex(token => token.id === tokenId && token.type === 'weapon');
  if (index < 0) throw new Error('声明使用的讨伐道具已不在身上。');
  const weapon = held.tokens.splice(index, 1)[0];
  play.removedTokens.push(weapon);
  emitGameEvent(play, { kind: 'item_used', itemId: 'weapon', name: tokenView(weapon).name, userId: id, cornerId, status: 'triggered' });
  const hitHako = cornerId === play.round.hidingCornerId;
  if (hitHako && weapon.tool === play.opening.weakness) { setResult(play, 'visitors', '讨伐', id); return; }
  for (const ghost of play.ghosts.filter(candidate => !candidate.banished && candidate.cornerId === cornerId)) {
    ghost.banished = true;
    visitor(play, ghost.playerId).status = 'banished';
    play.removedTokens.push(...ghost.carriedTokens);
    ghost.carriedTokens = [];
  }
  if (play.tokens[cornerId]) play.removedTokens.push(play.tokens[cornerId]);
  play.tokens[cornerId] = null;
  if (hitHako) die(play, id, cornerId);
  else finishAction(play, id);
}
function confirmAction(play, id) {
  if (id !== play.round.hakoId) throw new Error('只有箱娃可以确认访问者的行动。');
  const pending = play.round.pendingAction;
  if (!pending) throw new Error('当前没有等待结算的访问者行动。');
  if (pending.type === 'move') {
    applyRoundAction(play.round, id, { type: 'resolve_visitor_action' });
    afterPowerMove(play, pending.playerId);
    return;
  }
  play.round.pendingAction = null;
  if (pending.type === 'peek') beginPeek(play, pending);
  else if (pending.type === 'weapon') resolveWeapon(play, pending);
  else if (pending.type === 'item') resolveItem(play, pending, context(play));
  else if (pending.type === 'free') applyFreeAction(play, pending.playerId, pending.action);
  else throw new Error('等待结算的访问者行动无效。');
}

function actorHiding(play, id) {
  if (id === play.round.hakoId) return { cornerId: play.round.hidingCornerId };
  const ghost = ghostOf(play, id);
  if (!ghost || ghost.banished) throw new Error('只有箱娃或尚未被讨伐的箱人可以潜伏。');
  return ghost;
}
function assertHiding(play, id) {
  if (play.round.silent.phase !== 'hako_phase' || !play.hakoStage) throw new Error('尚未进入箱娃阶段。');
  if (play.powers.step !== 'action' || play.powers.rearrangement) throw new Error('请先完成哭喊与能力设置，并进入箱娃行动。');
  actorHiding(play, id);
  if (play.hakoStage.done.includes(id)) throw new Error('你已经完成本次潜伏。');
  if (id !== play.round.hakoId && !play.hakoStage.inspections[play.round.hakoId]) throw new Error('请等待箱娃先结束阶段能力并开始潜伏。');
}
function inspectHidingRoom(play, id, roomId) {
  roomId = getLogicalRoomId(roomId);
  assertHiding(play, id);
  if (play.hakoStage.inspections[id]) throw new Error('请在已查看的房间选择角落，不能再次查看其他房间。');
  const targetIds = id === play.round.hakoId ? powerHidingTargets(play, actorHiding(play, id).cornerId)
    : ordinaryHidingTargets(play, actorHiding(play, id).cornerId);
  if (!targetIds.some(cornerId => roomOf(cornerId) === roomId)) throw new Error('只能查看当前或相邻房间的角落。');
  play.hakoStage.inspections[id] = roomId;
}
function hide(play, id, action) {
  assertHiding(play, id);
  if (action.type === 'hako_hide' && id !== play.round.hakoId) throw new Error('只有箱娃可以进行此操作。');
  if (action.type === 'ghost_hide' && id === play.round.hakoId) throw new Error('只有箱人可以进行此操作。');
  const inspected = getLogicalRoomId(play.hakoStage.inspections[id]);
  if (!inspected || roomOf(action.cornerId) !== inspected) throw new Error('请先查看目标房间，再选择该房间内的潜伏角落。');
  const targets = id === play.round.hakoId ? powerHidingTargets(play, actorHiding(play, id).cornerId)
    : ordinaryHidingTargets(play, actorHiding(play, id).cornerId);
  if (!targets.includes(action.cornerId)) throw new Error('只能潜伏到当前或相邻房间的角落。');
  play.hidingMemories ??= {};
  play.hidingMemories[id] = { id: inspected, cycle: play.round.silent.cycle,
    replacedCornerId: action.cornerId, corners: [{ id: action.cornerId, token: tokenView(play.tokens[action.cornerId]) }] };
  const faceDown = action.faceDownCornerIds ?? [];
  if (!Array.isArray(faceDown) || new Set(faceDown).size !== faceDown.length
      || faceDown.some(cornerId => roomOf(cornerId) !== inspected || play.tokens[cornerId]?.type !== 'empty_box')) {
    throw new Error('只能重新盖放所潜入房间中的空箱标志。');
  }
  faceDown.forEach(cornerId => { play.tokens[cornerId].faceUp = false; });
  if (id === play.round.hakoId) play.round.hidingCornerId = action.cornerId;
  else ghostOf(play, id).cornerId = action.cornerId;
  play.hakoStage.done.push(id);
  const participants = [play.round.hakoId, ...play.ghosts.filter(ghost => !ghost.banished).map(ghost => ghost.playerId)];
  if (participants.every(playerId => play.hakoStage.done.includes(playerId))) {
    finishHakoPhase(play.round.silent);
    play.hakoStage = null;
    play.powers.step = null;
  }
}

function selectedIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) {
    throw new Error('请选择不同的随身标志或道具。');
  }
  return [...value];
}
function applyFreeAction(play, id, action) {
  if (action.type.startsWith('walkie_')) return applyWalkieAction(play, id, action, context(play));
  const handlers = { show_token: showToken, offer_exchange: offerExchange,
    respond_exchange: respondExchange, drop_token: dropToken };
  handlers[action.type](play, id, action);
}
function freeAction(play, id, action) {
  // Existing free actions stay immediate unless a set theft card can interrupt.
  if (!hasActivePower(play, 7) && !hasActivePower(play, 8)) return applyFreeAction(play, id, action);
  applyFreeAction(clone(play), id, action);
  play.round.pendingAction = { type: 'free', playerId: id, actionType: action.type, action: clone(action) };
  if (action.type.startsWith('walkie_')) emitGameEvent(play, { kind: 'item_declared', itemId: 'walkie_talkie', userId: id, status: 'declared' });
}
function recheckMaryDeclaration(play) {
  const pending = play.round.pendingAction;
  if (pending?.type === 'item' && pending.itemId === 'smartphone' && pending.targetZone === 'slot'
      && !play.powers.slots[pending.index]) play.round.pendingAction = null;
  if (pending?.type !== 'free') return;
  const validation = clone(play);
  validation.round.pendingAction = null;
  // A newly cursed doll cannot complete a previously declared transfer. The
  // visitor may declare again without consuming a standard action or a reveal.
  try { applyFreeAction(validation, pending.playerId, pending.action); }
  catch { play.round.pendingAction = null; }
}
function assertDollTransfer(play, id, tokenIds) {
  if (play.noiseEffects?.mary?.playerId === id && inventory(play, id).tokens.some(token => token.type === 'doll' && tokenIds.includes(token.id))) {
    throw new Error('我的玛丽小姐生效中，人偶不能转交、交换、丢弃或用于补位。');
  }
}
function assertHeld(play, id, tokenIds, itemIds) {
  const held = inventory(play, id);
  if (tokenIds.some(tokenId => !held.tokens.some(token => token.id === tokenId))
      || itemIds.some(itemId => !held.items.some(item => item.id === itemId))) {
    throw new Error('拟交换的标志或道具已不在持有者身上。');
  }
  if (held.items.some(item => itemIds.includes(item.id) && isLockedWalkie(play, item))) {
    throw new Error('配对后的对讲机不能转交或交换。');
  }
}
function offerExchange(play, id, action) {
  assertFree(play, id);
  assertSameRoom(play, id, action.targetId);
  const offer = { id: `exchange_${play.nextOfferId++}`, fromId: id, targetId: action.targetId,
    giveTokenIds: selectedIds(action.giveTokenIds), requestTokenIds: selectedIds(action.requestTokenIds),
    giveItemIds: selectedIds(action.giveItemIds), requestItemIds: selectedIds(action.requestItemIds) };
  if (![offer.giveTokenIds, offer.requestTokenIds, offer.giveItemIds, offer.requestItemIds].some(ids => ids.length)) {
    throw new Error('请至少选择一枚标志或一张道具进行给予或交换。');
  }
  assertHeld(play, id, offer.giveTokenIds, offer.giveItemIds);
  assertDollTransfer(play, id, offer.giveTokenIds);
  // A proposal must not answer whether guessed IDs exist in somebody else's inventory.
  // The invited owner validates their own requested pieces only when accepting.
  play.exchangeOffers.push(offer);
}
function transfer(from, to, key, ids) {
  const pieces = from[key].filter(piece => ids.includes(piece.id));
  from[key] = from[key].filter(piece => !ids.includes(piece.id));
  to[key].push(...pieces);
}
function respondExchange(play, id, action) {
  assertFree(play, id);
  const offer = play.exchangeOffers.find(candidate => candidate.id === action.offerId);
  if (!offer || offer.targetId !== id) throw new Error('只有受邀访问者可以回应此交换。');
  if (typeof action.accept !== 'boolean') throw new Error('请选择接受或拒绝交换。');
  if (action.accept) {
    assertSameRoom(play, offer.fromId, offer.targetId);
    assertHeld(play, offer.fromId, offer.giveTokenIds, offer.giveItemIds);
    assertHeld(play, id, offer.requestTokenIds, offer.requestItemIds);
    assertDollTransfer(play, offer.fromId, offer.giveTokenIds);
    assertDollTransfer(play, id, offer.requestTokenIds);
    const from = inventory(play, offer.fromId), to = inventory(play, id);
    transfer(from, to, 'tokens', offer.giveTokenIds);
    transfer(to, from, 'tokens', offer.requestTokenIds);
    transfer(from, to, 'items', offer.giveItemIds);
    transfer(to, from, 'items', offer.requestItemIds);
  }
  play.exchangeOffers = play.exchangeOffers.filter(candidate => candidate.id !== offer.id);
}
function showToken(play, id, action) {
  assertFree(play, id);
  assertSameRoom(play, id, action.targetId);
  const token = inventory(play, id).tokens.find(candidate => candidate.id === action.tokenId);
  if (!token) throw new Error('请选择自己持有的标志。');
  play.sharedTokens[action.targetId] = { kind: 'shown_token', fromId: id, token: clone(token) };
}
function showPossession(play, id, action) {
  assertSameRoom(play, id, action.targetId);
  if ((typeof action.tokenId === 'string') === (typeof action.itemId === 'string')) {
    throw new Error('请选择自己持有的一枚标志或一张访问者道具。');
  }
  const held = inventory(play, id);
  const piece = action.tokenId ? held.tokens.find(token => token.id === action.tokenId)
    : held.items.find(item => item.id === action.itemId);
  if (!piece) throw new Error('只能展示自己当前持有的标志或访问者道具。');
  play.sharedTokens[action.targetId] = { kind: 'shown_possession', fromId: id,
    ...(action.tokenId ? { token: clone(piece) } : { item: clone(piece) }) };
}
function publishToken(play, id, action) {
  assertAlive(play, id);
  let token;
  const found = play.resolution;
  if (found?.playerId === id && found.token?.id === action.tokenId) {
    token = found.token;
  } else {
    assertFree(play, id);
    token = inventory(play, id).tokens.find(piece => piece.id === action.tokenId);
  }
  if (!token) throw new Error('只能公开自己持有或本次窥探发现的标志。');
  if (token.type === 'notebook') throw new Error('手记在发现时已自动公开，无需再次公开。');
  play.publicDiscoveries ??= [];
  if (play.publicDiscoveries.some(entry => entry.playerId === id && entry.token.id === token.id)) throw new Error('这条发现已经公开。');
  play.publicDiscoveries.push({ playerId: id, token: clone(token), cycle: play.round.silent.cycle });
}
function dropToken(play, id, action) {
  assertFree(play, id);
  assertCorner(play, id, action.cornerId, { mustBeEmpty: true });
  const held = inventory(play, id), index = held.tokens.findIndex(token => token.id === action.tokenId);
  if (index < 0) throw new Error('请选择自己持有的标志。');
  assertDollTransfer(play, id, [action.tokenId]);
  play.tokens[action.cornerId] = held.tokens.splice(index, 1)[0];
}
function bequeath(play, id, action) {
  if (play.resolution?.kind !== 'inheritance' || play.resolution.playerId !== id) throw new Error('当前没有等待你决定的遗物继承。');
  assertAlive(play, action.targetId);
  const held = inventory(play, id), target = inventory(play, action.targetId);
  target.tokens.push(...held.tokens);
  held.tokens = [];
  // Old saves can still be paused at an inheritance created before this ruling.
  play.removedItems ??= [];
  play.removedItems.push(...held.items);
  held.items = [];
  play.inheritanceQueue ??= [];
  play.resolution = play.inheritanceQueue.length ? { kind: 'inheritance', playerId: play.inheritanceQueue.shift() } : null;
}
function surrender(play, id, action) {
  assertAlive(play, id);
  if (action.agree !== undefined && typeof action.agree !== 'boolean') throw new Error('请选择是否同意投降。');
  play.surrenderVotes = play.surrenderVotes.filter(playerId => playerId !== id && alive(play, playerId));
  if (action.agree !== false) play.surrenderVotes.push(id);
  if (play.round.visitors.filter(player => player.status === 'alive').every(player => play.surrenderVotes.includes(player.id))) {
    setResult(play, 'hako', '访问者全体投降');
  }
}

/** All validation and mutation run on a clone. A failed action leaves every original field intact. */
export function applyPlayAction(previous, playerId, action) {
  assertPlayer(previous, playerId);
  if (previous.result) throw new Error('本局已经结束。');
  if (!action || typeof action.type !== 'string') throw new Error('请选择回合操作。');
  const play = clone(previous);
  // Saved games may still use the printed sub-area names as room IDs.
  for (const player of play.round.visitors) if (player.roomId) player.roomId = getLogicalRoomId(player.roomId);
  if (action.roomId) action = { ...action, roomId: getLogicalRoomId(action.roomId) };
  const previousPending = clone(play.round.pendingAction);
  // Sharing current possessions conveys information without advancing or
  // interrupting the current game operation, including another player's turn.
  if (action.type === 'show_possession') {
    showPossession(play, playerId, action);
    return play;
  }
  if (['walkie_cancel', 'walkie_show_cancel'].includes(action.type)
      || action.type === 'walkie_respond' && action.accept === false) {
    applyWalkieAction(play, playerId, action, context(play));
    return play;
  }
  if (play.interruption && action.type !== 'extinguisher_response') throw new Error('请先等待灭火器持有者回应。');
  if (play.resolution && !['resolve_peek', 'safe_guess', 'bequeath', 'answer_item', 'choose_forced_peek', 'publish_token'].includes(action.type)) {
    throw new Error('请先等待当前窥探或遗物继承结算完成。');
  }
  if (play.round.pendingAction && !['resolve_visitor_action', 'activate_power'].includes(action.type)) {
    throw new Error('访问者已声明行动，请先等待箱娃确认。');
  }
  if (isPowerMoveForced(play, playerId) && ['peek', 'use_weapon', 'use_item', 'silent_skip'].includes(action.type)) {
    throw new Error('鬼来电生效中，只能沿最短路径移动至客厅。');
  }
  switch (action.type) {
    case 'publish_token': publishToken(play, playerId, action); break;
    case 'peek': declarePeek(play, playerId, action); break;
    case 'resolve_peek': resolvePeek(play, playerId, action); break;
    case 'safe_guess': guessSafe(play, playerId, action); break;
    case 'use_weapon': declareWeapon(play, playerId, action); break;
    case 'resolve_visitor_action': confirmAction(play, playerId); break;
    case 'inspect_hiding_room': inspectHidingRoom(play, playerId, action.roomId); break;
    case 'hako_hide': case 'ghost_hide': hide(play, playerId, action); break;
    case 'show_token': case 'offer_exchange': case 'respond_exchange': case 'drop_token':
    case 'walkie_propose': case 'walkie_respond': case 'walkie_cancel':
    case 'walkie_show_propose': case 'walkie_show_confirm': case 'walkie_show_cancel':
      freeAction(play, playerId, action); break;
    case 'bequeath': bequeath(play, playerId, action); break;
    case 'surrender': surrender(play, playerId, action); break;
    case 'use_item': declareItem(play, playerId, action, context(play)); break;
    case 'answer_item': answerItem(play, playerId, action, context(play)); break;
    case 'choose_forced_peek': chooseForcedPeek(play, playerId, action); break;
    case 'extinguisher_response': respondExtinguisher(play, playerId, action); break;
    case 'silent_reveal':
      assertAlive(play, playerId);
      revealWithEffects(play, playerId, action); break;
    case 'silent_skip': case 'move':
      assertAlive(play, playerId);
      if (action.type === 'move') {
        const targets = getRoundView(play.round, playerId).moveTargets;
        if (!restrictPowerMoves(play, playerId, targets).includes(action.roomId)) throw new Error('鬼来电生效中，只能沿最短路径移动至客厅。');
      }
      applyRoundAction(play.round, playerId, action); break;
    case 'pass_noise_reaction': applyRoundAction(play.round, playerId, action); break;
    default: {
      const beforePowers = clone(play.powers);
      if (action.type === 'begin_hako_action' && play.hakoStage) {
        play.hakoStage.publicCorners = publicCorners(play);
        play.deathLocations = [];
      }
      if (!applyPowerAction(play, playerId, action, context(play))) throw new Error('该回合操作尚未实现。');
      if (action.type === 'activate_power' && play.powers.lastActivation?.powerId === 8) recheckMaryDeclaration(play);
      if (play.interruption?.kind === 'power') play.interruption.restorePowers = beforePowers;
    }
  }
  if (action.type === 'activate_power' && previousPending && !play.round.pendingAction) {
    const itemId = previousPending.type === 'item' ? previousPending.itemId
      : previousPending.type === 'weapon' ? 'weapon' : previousPending.useNightVision ? 'night_vision'
        : previousPending.actionType?.startsWith('walkie_') ? 'walkie_talkie' : null;
    if (itemId) emitGameEvent(play, { kind: 'item_interrupted', itemId, userId: previousPending.playerId, status: 'interrupted' });
  }
  syncNoiseEffects(play);
  finishBlockedMove(play);
  checkVictory(play);
  beginHakoStage(play);
  syncNoiseInterruption(play);
  return play;
}

function ordinaryHidingTargets(play, cornerId) {
  const base = getHidingTargets(play.round.placements, cornerId);
  const roomIds = new Set(base.map(roomOf));
  return [...base, ...Object.values(play.extraCorners).filter(corner => roomIds.has(getLogicalRoomId(corner.roomId))).map(corner => corner.id)].sort();
}
function publicCorners(play) {
  return Object.keys(play.tokens).map(id => ({ id, roomId: roomOf(id), occupied: occupied(play, id),
    ...(play.tokens[id]?.type === 'empty_box' && play.tokens[id].faceUp && !actorsAt(play, id).length
      ? { faceUp: true, token: tokenView(play.tokens[id]) } : {}) }));
}
function inspectedRoomView(play, roomId) {
  return { id: getLogicalRoomId(roomId), corners: corners(play, roomId).map(({ id }) => ({ id,
    ...(play.tokens[id]?.type === 'empty_box' && play.tokens[id].faceUp && !actorsAt(play, id).length
      ? { token: tokenView(play.tokens[id]) } : {}) })) };
}
function hidingView(play, id) {
  const actor = actorHiding(play, id);
  const canHide = play.round.silent.phase === 'hako_phase' && play.powers.step === 'action' && !play.powers.rearrangement
    && !play.result && !play.resolution && !play.interruption
    && (id === play.round.hakoId || !!play.hakoStage?.inspections[play.round.hakoId]);
  const finished = play.hakoStage?.done.includes(id) ?? false;
  const targets = canHide && !finished ? id === play.round.hakoId ? powerHidingTargets(play, actor.cornerId)
    : ordinaryHidingTargets(play, actor.cornerId) : [];
  const inspected = canHide && !finished ? getLogicalRoomId(play.hakoStage?.inspections[id]) : null;
  const memory = play.hidingMemories?.[id] ?? (id === play.round.hakoId ? getInitialRoomMemory(play.opening) : null);
  const replaced = memory?.corners.find(corner => corner.id === (memory.replacedCornerId || actor.cornerId));
  const remembered = replaced ? clone(replaced) : null;
  if (remembered?.token?.name) remembered.token = tokenView(remembered.token);
  return {
    cornerId: actor.cornerId, roomId: roomOf(actor.cornerId), finished,
    hidingRooms: [...new Set(targets.map(roomOf))].map(roomId => ({ id: roomId, name: getRoom(roomId).name })),
    hidingTargets: inspected ? targets.filter(cornerId => roomOf(cornerId) === inspected) : [],
    ...(inspected ? { inspectedRoom: inspectedRoomView(play, inspected) } : {}),
    ...(replaced ? { lastInspectedRoom: { id: getLogicalRoomId(memory.id), cycle: memory.cycle,
      corners: [remembered] } } : {}),
  };
}
function resolutionView(play, id) {
  const resolution = play.resolution;
  if (!resolution) return null;
  if (resolution.kind === 'item_answer') return itemResolutionView(play, id, context(play));
  if (resolution.playerId !== id) return { kind: 'waiting', playerId: resolution.playerId };
  if (resolution.kind === 'forced_peek') return { kind: 'forced_peek', playerId: id,
    cornerIds: corners(play, visitor(play, id).roomId).filter(corner => occupied(play, corner.id)).map(corner => corner.id) };
  if (resolution.kind === 'inheritance') return { kind: 'inheritance', playerId: id,
    targets: play.round.visitors.filter(player => player.status === 'alive').map(player => player.id) };
  const token = resolution.token;
  const needsReplacement = resolution.kind === 'notebook' || TAKEABLE.has(token.type);
  return {
    kind: resolution.kind, playerId: id, cornerId: resolution.cornerId, token: tokenView(token),
    canPublish: token.type !== 'notebook' && !(play.publicDiscoveries || [])
      .some(entry => entry.playerId === id && entry.token.id === token.id),
    canTake: TAKEABLE.has(token.type), needsReplacement,
    replacementTokens: inventory(play, id).tokens.filter(token => !(play.noiseEffects?.mary?.playerId === id && token.type === 'doll')).map(tokenView),
    canUseEmptyBox: play.opening.emptyBoxTokens.length > 0,
    canLeaveEmpty: play.opening.emptyBoxTokens.length === 0,
    canFaceUp: hasItem(play, id, 'deduction'),
    nightVisionItems: resolution.kind === 'notebook' && resolution.useNightVision ? play.availableItems.map(itemView) : [],
    canUseStethoscope: resolution.kind === 'safe' && hasItem(play, id, 'stethoscope'),
  };
}

function alliedActorsView(play) {
  return [{ playerId: play.round.hakoId, type: 'hako', status: 'hako',
    cornerId: play.round.hidingCornerId, roomId: roomOf(play.round.hidingCornerId) },
  ...play.ghosts.map(ghost => ({ playerId: ghost.playerId, type: 'box_person',
    status: ghost.banished ? 'banished' : 'box_person',
    ...(!ghost.banished ? { cornerId: ghost.cornerId, roomId: roomOf(ghost.cornerId) } : {}) }))];
}
function reviewPower(card) {
  return (typeof card === 'object' ? card?.id : card) === 'despair'
    ? { id: 'despair', name: '绝望时刻' } : powerCard(card);
}
function reviewView(play) {
  const actors = alliedActorsView(play);
  return {
    corners: Object.keys(play.tokens).map(id => {
      const occupants = actorsAt(play, id).map(actor => ({ ...actor,
        carriedTokens: (ghostOf(play, actor.playerId)?.carriedTokens || []).map(tokenView) }));
      return { id, roomId: roomOf(id), actors: occupants,
        token: occupants.length ? tokenView({ id: occupants[0].type, type: occupants[0].type }) : tokenView(play.tokens[id]),
        underToken: occupants.length ? tokenView(play.tokens[id]) : null };
    }),
    storedTokens: actors.filter(actor => actor.cornerId).map(actor => ({ playerId: actor.playerId,
      cornerId: actor.cornerId, tokens: [
        ...(actorsAt(play, actor.cornerId)[0]?.playerId === actor.playerId ? [play.tokens[actor.cornerId]] : []),
        ...(ghostOf(play, actor.playerId)?.carriedTokens || [])].filter(Boolean).map(tokenView) })),
    inventories: [play.round.hakoId, ...play.round.visitors.map(player => player.id)].map(playerId => ({ playerId,
      tokens: (inventory(play, playerId)?.tokens || []).map(tokenView),
      items: (inventory(play, playerId)?.items || []).map(itemView) })),
    discarded: play.discarded.map(entry => ({ playerId: entry.playerId,
      tokens: entry.tokens.map(tokenView), items: entry.items.map(itemView) })),
    removedTokens: play.removedTokens.map(tokenView),
    removedItems: (play.removedItems ?? []).map(itemView),
    powers: { ...clone(play.powers), hand: play.powers.hand.map(reviewPower),
      deck: play.powers.deck.map(reviewPower), slots: play.powers.slots.map(card => card ? { ...clone(card), ...reviewPower(card) } : null),
      removed: play.powers.removed.map(reviewPower), used: play.powers.used.map(reviewPower),
      stolen: play.powers.stolen ? { kind: play.powers.stolen.kind, piece: play.powers.stolen.kind === 'item'
        ? itemView(play.powers.stolen.piece) : tokenView(play.powers.stolen.piece) } : null },
    opening: { password: clone(play.opening.password), weakness: play.opening.weakness,
      remainsCornerId: play.opening.remainsCornerId, initialPowerId: play.opening.initialPowerId,
      initialPower: reviewPower(play.opening.initialPowerId), safeBoard: { key: tokenView(play.opening.safeBoard.key) },
      emptyBoxTokens: play.opening.emptyBoxTokens.map(tokenView) },
  };
}

/** A strict whitelist: living players receive their own possessions and current resolution,
 * hidden allies also share locations. Complete board contents are available only after a result. */
export function getPlayView(play, playerId) {
  assertPlayer(play, playerId);
  const view = getRoundView(play.round, playerId);
  view.totalRounds = play.totalRounds ?? Math.max(0, play.round.silent.cycle - 1) + (play.hakoStage ? 1 : 0);
  view.mode = 'exploration';
  const player = visitor(play, playerId);
  const canAct = alive(play, playerId) && play.round.silent.phase === 'visitor_action'
    && play.round.silent.turnPlayerId === playerId && !play.round.pendingAction && !play.resolution && !play.result && !play.interruption;
  const canFree = alive(play, playerId) && ['visitor_reveal', 'visitor_action'].includes(play.round.silent.phase)
    && !(play.round.silent.revealsRemaining > 0)
    && !play.round.pendingAction && !play.resolution && !play.result && !play.interruption;
  view.phase = play.result ? 'game_over' : play.resolution ? 'visitor_resolution' : view.phase;
  view.visitors = play.round.visitors.map(player => ({ id: player.id, status: player.status,
    ...(player.status === 'alive' ? { roomId: getLogicalRoomId(player.roomId) } : {}),
    ...(playerId === play.round.hakoId ? { itemCount: inventory(play, player.id).items.length,
      tokenCount: inventory(play, player.id).tokens.length } : {}) }));
  view.deathEvents = clone(play.deathEvents ?? []);
  view.deathLocations = clone(play.deathLocations ?? []);
  // getRoundView may calculate movement for a dead seat; never retain its public position.
  view.moveTargets = canAct ? restrictPowerMoves(play, playerId, view.moveTargets) : [];
  if (view.pendingAction) {
    const pending = play.round.pendingAction;
    view.pendingAction = { type: pending.type, playerId: pending.playerId,
      ...(pending.type === 'free' ? { actionType: pending.actionType }
        : pending.type === 'move' ? { fromRoomId: pending.fromRoomId, toRoomId: pending.toRoomId }
        : pending.type === 'item' ? { itemId: pending.itemId, ...(pending.roomId ? { roomId: pending.roomId } : {}) }
          : pending.type === 'peek' && pending.playerId !== playerId ? {} : { cornerId: pending.cornerId }) };
  }
  view.inventory = player ? { tokens: inventory(play, playerId).tokens.map(tokenView), items: inventory(play, playerId).items.map(itemView) }
    : { tokens: [], items: [] };
  view.canPublishTokens = canFree;
  const canChoose = canAct && !isPowerMoveForced(play, playerId);
  view.peekTargets = canChoose ? corners(play, player.roomId).filter(corner => occupied(play, corner.id)).map(corner => corner.id) : [];
  view.weapons = canChoose ? inventory(play, playerId).tokens.filter(token => token.type === 'weapon').map(tokenView) : [];
  view.weaponTargets = canChoose ? corners(play, player.roomId).map(corner => corner.id) : [];
  view.dropTargets = canFree ? corners(play, player.roomId).filter(corner => !occupied(play, corner.id)).map(corner => corner.id) : [];
  view.exchangePartners = canFree ? play.round.visitors.filter(target => target.id !== playerId && target.status === 'alive'
    && getLogicalRoomId(target.roomId) === getLogicalRoomId(player.roomId)).map(target => ({ id: target.id, roomId: getLogicalRoomId(target.roomId),
    tokenCount: inventory(play, target.id).tokens.length, itemCount: inventory(play, target.id).items.length })) : [];
  view.sharePartners = alive(play, playerId) && !play.result ? play.round.visitors
    .filter(target => target.id !== playerId && target.status === 'alive'
      && getLogicalRoomId(target.roomId) === getLogicalRoomId(player.roomId))
    .map(target => ({ id: target.id, roomId: getLogicalRoomId(target.roomId) })) : [];
  view.exchangeOffers = play.exchangeOffers.filter(offer => offer.fromId === playerId || offer.targetId === playerId).map(offer => ({
    ...clone(offer),
    giveTokens: inventory(play, offer.fromId).tokens.filter(token => offer.giveTokenIds.includes(token.id)).map(tokenView),
    giveItems: clone(inventory(play, offer.fromId).items.filter(item => offer.giveItemIds.includes(item.id))),
  }));
  view.sharedTokens = play.sharedTokens[playerId] ? clone(play.sharedTokens[playerId]) : null;
  // Legacy saved records may contain a discovery corner or source. Whitelist the
  // shared content so publishing never identifies where the piece was found.
  view.publicDiscoveries = (play.publicDiscoveries || []).map(entry => ({ playerId: entry.playerId,
    token: tokenView({ id: entry.token.id, type: entry.token.type,
      ...(entry.token.number !== undefined ? { number: entry.token.number } : {}),
      ...(entry.token.tool !== undefined ? { tool: entry.token.tool } : {}) }), cycle: entry.cycle }));
  if (view.sharedTokens?.token) view.sharedTokens.token = tokenView(view.sharedTokens.token);
  if (view.sharedTokens?.item) view.sharedTokens.item = itemView(view.sharedTokens.item);
  view.resolution = resolutionView(play, playerId);
  view.notebooks = play.notebooks.map(tokenView);
  view.cornerState = alive(play, playerId) && play.powers.step === 'action' && play.hakoStage?.publicCorners
    ? clone(play.hakoStage.publicCorners) : publicCorners(play);
  view.extraCorners = clone(Object.values(play.extraCorners));
  view.blockedDoors = play.round.blockedDoors.filter(door => playerId === play.round.hakoId || door.public === true)
    .map(({ from, to }) => ({ from: getLogicalRoomId(from), to: getLogicalRoomId(to) }));
  view.blockedWait = play.lastBlockedWait?.cycle === play.round.silent.cycle ? clone(play.lastBlockedWait) : null;
  view.powers = getPowersView(play, playerId);
  view.noiseEffects = getNoiseEffectsView(play, playerId);
  view.items = getItemView(play, playerId, context(play));
  view.walkie = getWalkieView(play, playerId, tokenView);
  if (!canChoose) view.items.usableItems = [];
  view.interruption = play.interruption ? { kind: play.interruption.kind,
    canRespond: play.interruption.responders.includes(playerId) && !play.interruption.passed.includes(playerId) } : null;
  view.safe = { opened: play.safeOpened, publicNumbers: [...play.publicNumbers], numberOptions: [1, 2, 3, 4, 5, 6] };
  view.discarded = play.discarded.map(entry => ({ playerId: entry.playerId,
    tokens: entry.tokens.map(tokenView), items: clone(entry.items) }));
  view.result = clone(play.result);
  view.ringAllies = [...play.ringAllies];
  view.surrenderVotes = play.surrenderVotes.filter(id => alive(play, id));
  if (playerId === play.round.hakoId) view.hako = { playerId, ...hidingView(play, playerId) };
  const ghost = ghostOf(play, playerId);
  if (ghost) view.ghost = { status: ghost.banished ? 'banished' : 'box_person',
    ...(!ghost.banished ? hidingView(play, playerId) : {}) };
  if (playerId === play.round.hakoId || (player && player.status !== 'alive')) view.alliedActors = alliedActorsView(play);
  if (play.result) view.review = reviewView(play);
  return view;
}
