// Bots receive exactly the same filtered snapshot as a browser player. Keep their
// decisions stateless so neither another seat's hand nor hidden board can leak in.
const ITEM_ORDER = ['deduction', 'night_vision', 'stethoscope', 'ventriloquist_doll',
  'relic_ring', 'dowsing_rod', 'smartphone', 'spirit_pen', 'suitcase', 'nightmare_letter', 'walkie_talkie'];
const POWER_ORDER = [5, 6, 1, 2, 3, 10, 9, 11];

function pick(values, random) {
  return values?.length ? values[Math.min(values.length - 1, Math.floor(random() * values.length))] : null;
}

function sample(values, count, random) {
  const remaining = [...values];
  const chosen = [];
  while (remaining.length && chosen.length < count) {
    const value = pick(remaining, random);
    chosen.push(value);
    remaining.splice(remaining.indexOf(value), 1);
  }
  return chosen;
}

function preferredItem(items, random) {
  return ITEM_ORDER.map(id => items.find(item => item.id === id)).find(Boolean) ?? pick(items, random);
}

function openingAction(opening, you, random) {
  if (!opening || opening.hakoId !== you) return null;
  switch (opening.phase) {
    case 'secrets':
      return { type: 'choose_secrets', password: sample(opening.passwordOptions, 3, random),
        weakness: pick(opening.weaknessOptions, random)?.id };
    case 'remains': return { type: 'place_remains', cornerId: pick(opening.remainsTargets, random) };
    case 'hiding_room': return { type: 'inspect_initial_room', roomId: pick(opening.hidingRooms, random)?.id };
    case 'hiding_corner': return { type: 'choose_initial_hiding', cornerId: pick(opening.hidingTargets, random) };
    case 'power': {
      const power = opening.initialPowerOptions.find(card => card.id === 1)
        ?? opening.initialPowerOptions.find(card => POWER_ORDER.includes(card.id));
      return power ? { type: 'choose_initial_power', powerId: power.id } : null;
    }
    default: return null;
  }
}

function hasItem(round, itemId) {
  return round.inventory?.items.some(item => item.id === itemId);
}

function knownTokens(round) {
  return [...(round.inventory?.tokens ?? []), ...(round.discarded ?? []).flatMap(entry => entry.tokens),
    ...(round.sharedTokens?.token ? [round.sharedTokens.token] : [])];
}

function safeAction(round, resolution, random) {
  // Password tokens are the three excluded numbers, while successful stethoscope
  // attempts publish actual password numbers. No partial match is assumed.
  const excluded = new Set(knownTokens(round).filter(token => token.type === 'password').map(token => token.number));
  const correct = [...(round.safe?.publicNumbers ?? [])];
  const unknown = (round.safe?.numberOptions ?? [1, 2, 3, 4, 5, 6])
    .filter(number => !excluded.has(number) && !correct.includes(number));
  if (resolution.canUseStethoscope && correct.length < 3 && unknown.length > 3 - correct.length) {
    return { type: 'safe_guess', numbers: [pick(unknown, random)], useStethoscope: true };
  }
  return { type: 'safe_guess', numbers: [...correct, ...sample(unknown, 3 - correct.length, random)], useStethoscope: false };
}

function resolutionAction(view, random) {
  const round = view.round;
  const resolution = round.resolution;
  if (resolution.playerId !== view.you || resolution.kind === 'waiting') return null;
  if (resolution.kind === 'item_answer') {
    const choices = resolution.answerOptions ?? [];
    const falseAnswers = choices.filter(answer => answer.id !== JSON.stringify(resolution.truth));
    const answer = pick(resolution.canLie && falseAnswers.length ? falseAnswers : choices, random);
    return answer ? { type: 'answer_item', answer: JSON.parse(answer.id) } : null;
  }
  if (resolution.kind === 'inheritance') {
    const humans = resolution.targets.filter(id => !view.players.find(player => player.id === id)?.isBot);
    return { type: 'bequeath', targetId: pick(humans.length ? humans : resolution.targets, random) };
  }
  if (resolution.kind === 'forced_peek') {
    const cornerId = pick(resolution.cornerIds, random);
    return cornerId ? { type: 'choose_forced_peek', cornerId, useNightVision: hasItem(round, 'night_vision') } : null;
  }
  if (resolution.kind === 'safe') return safeAction(round, resolution, random);
  if (!['peek', 'notebook'].includes(resolution.kind)) return null;
  const action = { type: 'resolve_peek', take: resolution.canTake === true };
  if (resolution.kind === 'notebook' || resolution.canTake) {
    action.replacement = resolution.canUseEmptyBox ? 'empty_box'
      : resolution.canLeaveEmpty ? 'none' : pick(resolution.replacementTokens, random)?.id;
    if (!action.replacement) return resolution.canTake ? { type: 'resolve_peek', take: false } : null;
    if (action.replacement === 'empty_box') action.faceUp = resolution.canFaceUp === true;
  }
  if (resolution.nightVisionItems?.length) action.itemId = preferredItem(resolution.nightVisionItems, random).id;
  return action;
}

function activateSimplePower(round, random, interrupt = false) {
  const eligible = (round.powers?.activationOptions ?? []).filter(option => option.canActivate
    && (interrupt ? [6, 10].includes(option.card.id) : [1, 2, 3, 5].includes(option.card.id)));
  const useful = eligible.filter(option => option.card.id !== 5
    || round.visitors.some(visitor => visitor.status === 'alive' && visitor.roomId === round.hako.roomId)
    || round.notebooks.length >= 8);
  const option = pick(useful, random);
  if (!option) return null;
  const action = { type: 'activate_power', slot: option.slot };
  if (option.card.id === 3) {
    const door = pick(option.doors, random);
    if (!door) return null;
    action.fromRoomId = door.fromRoomId;
    action.toRoomId = door.toRoomId;
  }
  return action;
}

function hidingAction(round, actor, isHako, random) {
  if (!actor || actor.finished || actor.status === 'banished') return null;
  if (actor.hidingTargets?.length) {
    const inspected = actor.inspectedRoom?.corners ?? [];
    const covered = actor.hidingTargets.filter(id => inspected.some(corner => corner.id === id && corner.token
      && !(corner.token.type === 'empty_box' && corner.token.faceUp)));
    return { type: isHako ? 'hako_hide' : 'ghost_hide',
      cornerId: pick(covered.length ? covered : actor.hidingTargets, random),
      faceDownCornerIds: inspected.filter(corner => corner.token?.type === 'empty_box').map(corner => corner.id) };
  }
  if (actor.hidingRooms?.length) {
    const occupied = actor.hidingRooms.filter(room => round.visitors.some(visitor => visitor.status === 'alive' && visitor.roomId === room.id));
    const room = pick(occupied.length && random() < 0.65 ? occupied : actor.hidingRooms, random);
    return { type: 'inspect_hiding_room', roomId: room.id };
  }
  return null;
}

function hakoAction(round, random) {
  const powers = round.powers;
  if (round.pendingAction) return activateSimplePower(round, random, true) ?? { type: 'resolve_visitor_action' };
  if (round.phase === 'hako_reaction') return { type: 'pass_noise_reaction' };
  if (round.phase !== 'hako_phase') return null;
  if (powers?.rearrangement) {
    const corners = powers.rearrangement.corners;
    return { type: 'power_rearrange', order: sample(corners.map(corner => corner.id), corners.length, random),
      faceDownCornerIds: corners.map(corner => corner.id) };
  }
  if (powers?.canCry) {
    const room = pick(powers.cryRooms, random);
    return { type: 'hako_cry', ...(room ? { roomId: room.id } : {}) };
  }
  if (powers?.canManage) {
    const cards = (powers.hand ?? []).filter(card => card.settable && POWER_ORDER.includes(card.id));
    const best = POWER_ORDER.map(id => cards.find(card => card.id === id)).find(Boolean);
    const empty = powers.slots.find(slot => !slot.occupied);
    if (empty && best) return { type: 'set_power', powerId: best.id, slot: empty.slot };
    const recall = powers.slots.find(slot => slot.canRecall && (!POWER_ORDER.includes(slot.card?.id)
      || best && POWER_ORDER.indexOf(best.id) < POWER_ORDER.indexOf(slot.card?.id)));
    if (recall) return { type: 'recall_power', slot: recall.slot };
  }
  if (powers?.canBegin) return { type: 'begin_hako_action' };
  const activation = activateSimplePower(round, random);
  if (activation) return activation;
  if (powers?.pathRooms?.length) return { type: 'inspect_path_room', roomId: pick(powers.pathRooms, random).id };
  return hidingAction(round, round.hako, true, random);
}

function exchangeAction(view) {
  const round = view.round;
  const offer = round.exchangeOffers?.find(candidate => candidate.targetId === view.you);
  if (!offer) return null;
  const inventory = round.inventory;
  const held = offer.requestTokenIds.every(id => inventory.tokens.some(token => token.id === id))
    && offer.requestItemIds.every(id => inventory.items.some(item => item.id === id));
  const current = round.exchangePartners.some(player => player.id === offer.fromId)
    && offer.giveTokens.length === offer.giveTokenIds.length && offer.giveItems.length === offer.giveItemIds.length;
  const incoming = offer.giveTokenIds.length + offer.giveItemIds.length;
  const outgoing = offer.requestTokenIds.length + offer.requestItemIds.length;
  return { type: 'respond_exchange', offerId: offer.id, accept: held && current && incoming >= outgoing };
}

function activeItemAction(round, random) {
  const item = pick(round.items?.usableItems, random);
  if (!item) return null;
  const action = { type: 'use_item', itemId: item.id };
  if (['spirit_pen', 'ventriloquist_doll'].includes(item.id)) {
    const room = pick(round.items.roomOptions, random);
    if (!room) return null;
    action.roomId = room.id;
  }
  if (['smartphone', 'amulet'].includes(item.id)) {
    const targets = round.items.phoneTargets.filter(target => item.id !== 'amulet' || target.id.startsWith('slot:'));
    const target = pick(targets, random);
    if (!target) return null;
    const [zone, index] = target.id.split(':');
    action.index = Number(index);
    if (item.id === 'smartphone') action.targetZone = zone;
    else action.tokenId = round.inventory.tokens.find(token => token.type === 'amulet')?.id;
  }
  return action;
}

function visitorAction(view, random) {
  const round = view.round;
  const player = round.visitors.find(visitor => visitor.id === view.you);
  if (player?.status !== 'alive') return hidingAction(round, round.ghost, false, random);
  const free = ['visitor_reveal', 'visitor_action'].includes(round.phase);
  if (free) {
    const exchange = exchangeAction(view);
    if (exchange) return exchange;
    const humans = view.players.filter(seat => !seat.isBot && round.visitors.some(visitor => visitor.id === seat.id && visitor.status === 'alive'));
    const shouldSurrender = humans.some(seat => round.surrenderVotes.includes(seat.id));
    if (shouldSurrender !== round.surrenderVotes.includes(view.you)) return { type: 'surrender', agree: shouldSurrender };
  }
  if (round.silent.turnPlayerId !== view.you) return null;
  if (round.phase === 'visitor_reveal') {
    const card = pick(round.silent.cards.filter(candidate => candidate.status === 'down'), random);
    return card ? { type: 'silent_reveal', index: card.index } : null;
  }
  if (round.phase !== 'visitor_action') return null;
  const peekTargets = round.peekTargets.filter(id => !round.cornerState.some(corner => corner.id === id && corner.faceUp));
  const activeItem = round.items?.usableItems?.length && random() < 0.16 ? activeItemAction(round, random) : null;
  if (activeItem) return activeItem;
  // A confirmed pair of ineffective tools identifies the remaining weakness.
  // Attacking is still a risk: the hidden actor's location is never available.
  const ineffective = new Set(knownTokens(round).filter(token => token.type === 'weakness_clue').map(token => token.tool));
  const weapon = ineffective.size === 2 ? round.weapons.find(token => !ineffective.has(token.tool)) : null;
  if (weapon && peekTargets.length && random() < 0.12) {
    return { type: 'use_weapon', tokenId: weapon.id, cornerId: pick(peekTargets, random) };
  }
  if (peekTargets.length && (!round.moveTargets.length || random() < 0.62)) {
    return { type: 'peek', cornerId: pick(peekTargets, random), useNightVision: hasItem(round, 'night_vision') };
  }
  if (round.moveTargets.length) return { type: 'move', roomId: pick(round.moveTargets, random) };
  if (round.peekTargets.length) return { type: 'peek', cornerId: pick(round.peekTargets, random) };
  return activeItemAction(round, random);
}

/** Return one ordinary game action, or null while another player must decide. */
export function chooseBotAction(view, { random = Math.random } = {}) {
  if (!view || !view.players?.some(player => player.id === view.you && player.isBot === true)) return null;
  switch (view.phase) {
    case 'lobby': return view.players.find(player => player.id === view.you).ready ? null : { type: 'ready', ready: true };
    // The person chooses whether to play hako or invite a bot to claim the role.
    case 'hako_selection': case 'game_over': return null;
    case 'item_draft': {
      if (view.draft?.turnPlayerId !== view.you) return null;
      const item = preferredItem(view.draft.availableItems, random);
      return item ? { type: 'choose_item', itemId: item.id } : null;
    }
    case 'map_setup': {
      if (view.setup?.turnPlayerId !== view.you) return null;
      if (!view.setup.drawnTileId) return { type: 'draw' };
      const placement = pick(view.setup.legalPlacements, random);
      return placement ? { type: 'place', ...placement } : null;
    }
    case 'map_ready': return view.hostId === view.you ? { type: 'prepare_opening' } : null;
    case 'opening_setup': return openingAction(view.opening, view.you, random);
    case 'practice': {
      const round = view.round;
      if (!round || round.result) return null;
      if (round.interruption) return round.interruption.canRespond ? { type: 'extinguisher_response', use: true } : null;
      if (round.resolution) return resolutionAction(view, random);
      if (round.hako.playerId === view.you) return hakoAction(round, random);
      if (round.pendingAction) return null;
      return visitorAction(view, random);
    }
    default: return null;
  }
}
