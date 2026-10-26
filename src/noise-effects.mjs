import { revealSilent } from './silent.mjs';

function visitor(play, id) { return play.round.visitors.find(player => player.id === id); }
function hasItem(play, id, itemId) { return play.inventories[id]?.items.some(item => item.id === itemId) === true; }
function hasDoll(play, id) { return play.inventories[id]?.tokens.some(token => token.type === 'doll') === true; }
function activeMary(play) {
  const mary = play.noiseEffects?.mary;
  return mary && visitor(play, mary.playerId)?.status === 'alive' && hasDoll(play, mary.playerId) ? mary : null;
}
function isOwnTurn(play, id, phase) {
  const silent = play.round.silent;
  return visitor(play, id)?.status === 'alive' && silent.phase === phase && silent.turnPlayerId === id
    && !play.round.pendingAction && !play.resolution && !play.result && !play.interruption;
}
function forcedMove(play) { return play.powers?.ghostCall?.active === true; }
function baseCount(play, id) {
  const mary = activeMary(play);
  const silent = play.round.silent;
  const deferred = mary?.deferredCycle === silent.cycle && mary?.deferredTurn === (silent.turnSerial ?? 0);
  return mary?.playerId === id && !deferred ? 2 : 1;
}
function sameTurn(play, effect) {
  const silent = play.round.silent;
  return effect && effect.cycle === silent.cycle && effect.playerId === silent.turnPlayerId
    && visitor(play, effect.playerId)?.status === 'alive';
}

/** Extra reveals are chosen once, before the first number; every following click reveals one number. */
export function revealWithEffects(play, id, action) {
  if (!isOwnTurn(play, id, 'visitor_reveal')) throw new Error('请等待自己的回合并选择盖放的无声标志。');
  if (action.useBell !== undefined && typeof action.useBell !== 'boolean') throw new Error('请选择是否使用深菱神社之铃额外翻牌。');
  const silent = play.round.silent;
  const effects = play.noiseEffects ??= {};
  let intent;
  if (silent.revealsRemaining > 0) {
    intent = effects.bellIntent;
    if (!sameTurn(play, intent)) throw new Error('当前连续翻牌计划无效。');
    if (action.useBell !== undefined && action.useBell !== intent.useBell) throw new Error('连续翻牌已经开始，不能改变摇铃计划。');
  } else {
    const useBell = action.useBell === true;
    const count = baseCount(play, id) + (useBell ? 1 : 0);
    if (useBell && (!hasItem(play, id, 'shrine_bell') || forcedMove(play))) {
      throw new Error('只有携带深菱神社之铃且本回合可以使用道具时，才能选择额外翻牌。');
    }
    if (useBell && silent.cards.filter(card => card.status === 'down').length - 1 < count) {
      throw new Error('须保留最后一枚盖牌，剩余无声标志不足以完成本次摇铃翻牌。');
    }
    intent = { playerId: id, cycle: silent.cycle, useBell, count, revealed: 0 };
  }
  const view = revealSilent(silent, id, action.index, { count: intent.count });
  intent.revealed += 1;
  if (silent.phase === 'visitor_reveal') effects.bellIntent = intent;
  else {
    effects.bellIntent = null;
    effects.bellReady = silent.phase === 'visitor_action' && intent.useBell && intent.revealed === intent.count
      ? { playerId: id, cycle: silent.cycle } : null;
  }
  return view;
}

/** Optional fields keep saves from earlier releases valid. Call after each successful action. */
export function syncNoiseEffects(play) {
  const effects = play.noiseEffects;
  if (!effects) return;
  const silent = play.round.silent;
  if (effects.mary && !activeMary(play)) {
    const card = effects.mary.card;
    if (card) play.powers.hand.push({ id: card.id, ignoreThreshold: card.ignoreThreshold === true });
    effects.mary = null;
  }
  if (effects.bell && effects.bell.cycle !== silent.cycle) effects.bell = null;
  if (effects.bellReady && (!sameTurn(play, effects.bellReady) || silent.phase !== 'visitor_action' || play.result)) {
    effects.bellReady = null;
  }
  if (effects.bellIntent && (!sameTurn(play, effects.bellIntent) || silent.phase !== 'visitor_reveal'
      || !(silent.revealsRemaining > 0) || play.result)) effects.bellIntent = null;
}

/** Public effect identities are intentional; possession details remain private. */
export function getNoiseEffectsView(play, id) {
  const effects = play.noiseEffects ?? {};
  const silent = play.round.silent;
  const intent = sameTurn(play, effects.bellIntent) ? effects.bellIntent : null;
  const ownReveal = isOwnTurn(play, id, 'visitor_reveal');
  const canChooseBell = ownReveal && !(silent.revealsRemaining > 0) && hasItem(play, id, 'shrine_bell')
    && !forcedMove(play) && silent.cards.filter(card => card.status === 'down').length - 1 >= baseCount(play, id) + 1;
  const canUseBell = isOwnTurn(play, id, 'visitor_action') && !forcedMove(play) && hasItem(play, id, 'shrine_bell')
    && sameTurn(play, effects.bellReady) && effects.bellReady.playerId === id;
  return {
    maryPlayerId: activeMary(play)?.playerId ?? null,
    bellUserId: effects.bell?.cycle === silent.cycle ? effects.bell.userId : null,
    canChooseBell: !!canChooseBell, canUseBell: !!canUseBell,
    bellChosen: intent?.playerId === id && intent.useBell === true,
    requiredReveals: intent?.playerId === id ? intent.count : baseCount(play, id),
  };
}
