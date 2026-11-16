import { invalidateWalkieForTheft } from './walkie.mjs';

function alive(play, playerId) {
  return play.round.visitors.some(player => player.id === playerId && player.status === 'alive');
}

/** Expose anonymous card backs and counts, never current possession identities. */
export function getStealOptions(play, playerId) {
  if (!alive(play, playerId)) return { items: [], itemCount: 0, tokenCount: 0, canStealToken: false };
  const held = play.inventories[playerId];
  return {
    items: held.items.map((item, index) => ({ index, name: `技能牌背 ${index + 1}` })),
    itemCount: held.items.length, tokenCount: held.tokens.length,
    canStealToken: held.tokens.length > 0,
  };
}

/** Called on the parent's transaction clone after its power/window checks. */
export function stealPossession(play, playerId, action) {
  if (!alive(play, playerId)) throw new Error('只能抢夺存活访问者携带的物品。');
  const held = play.inventories[playerId];
  let pieces, index;
  if (action.stealKind === 'item') {
    pieces = held.items;
    index = action.itemIndex;
    if (Object.hasOwn(action, 'itemId') || Object.hasOwn(action, 'tokenId')
        || !Number.isInteger(index) || index < 0 || index >= pieces.length) throw new Error('请选择该访问者的一张匿名技能牌背。');
  } else if (action.stealKind === 'token') {
    if (Object.hasOwn(action, 'tokenId')) throw new Error('随身标志须随机抢夺，不能指定标志。');
    pieces = held.tokens;
    if (!pieces.length) throw new Error('该访问者没有可供抢夺的随身标志。');
    index = Math.floor(Math.random() * pieces.length);
  } else {
    throw new Error('请选择抢夺访问者道具或随机一枚随身标志。');
  }

  const stolen = { kind: action.stealKind, piece: structuredClone(pieces[index]) };
  const previous = play.powers.stolen ?? null;
  pieces.splice(index, 1);
  if (stolen.kind === 'item') invalidateWalkieForTheft(play, stolen.piece);
  // Select the new possession before returning the previous one to this victim.
  if (previous) held[previous.kind === 'item' ? 'items' : 'tokens'].push(structuredClone(previous.piece));
  play.powers.stolen = stolen;
  // The interrupted visitor keeps the same silent turn and declares an action again.
  play.round.pendingAction = null;
}
