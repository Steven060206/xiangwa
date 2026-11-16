// Preserve local reading and form state while filtered server snapshots update.
const keyOf = element => {
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (!element.dataset.testid) return null;
  const key = `[data-testid="${CSS.escape(element.dataset.testid)}"]`;
  // Test groups are intentionally repeated and are never a field identity.
  return element.ownerDocument.querySelectorAll(key).length === 1 ? key : null;
};
let draftEpoch = 0;
export const resetDrafts = () => { draftEpoch++; };
export const draftScope = state => `${draftEpoch}:${stepKey(state)}`;

export function captureView(root) {
  const active = document.activeElement;
  return {
    scroll: root.scrollTop,
    focused: root.contains(active) ? keyOf(active) : null,
    selection: active && /^(INPUT|TEXTAREA)$/.test(active.tagName)
      ? [active.selectionStart, active.selectionEnd] : null,
    fields: [...root.querySelectorAll('input, select, textarea')].filter(element => keyOf(element) && !element.closest('#chat-panel')).map(element => ({
      key: keyOf(element), value: element.value, checked: element.checked, type: element.type,
    })),
    details: [...root.querySelectorAll('details')].map(element => ({
      key: keyOf(element), text: element.querySelector('summary')?.textContent, open: element.open,
    })),
  };
}

export function restoreView(root, saved, sameStep) {
  if (!saved) return;
  if (sameStep) for (const field of saved.fields) {
    const element = root.querySelector(field.key);
    if (!element) {
      if (field.checked || field.type === 'select-one' && field.value) document.dispatchEvent(new CustomEvent('game-selection-expired'));
      continue;
    }
    if (element.tagName === 'SELECT') {
      const valid = [...element.options].some(option => option.value === field.value && !option.disabled);
      if (!valid) {
        const option = new Option('目标已变化，请重新选择', '', true, true);
        option.disabled = true;
        element.prepend(option);
        element.value = '';
        document.dispatchEvent(new CustomEvent('game-selection-expired'));
        continue;
      }
    }
    if (['checkbox', 'radio'].includes(field.type)) element.checked = field.checked;
    else element.value = field.value;
  }
  // Restore the whole group before recalculating counters, dependent choices and
  // payload state. Change handlers use the same render's submission lock.
  if (sameStep) for (const field of saved.fields) {
    root.querySelector(field.key)?.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const detail of saved.details) {
    const element = detail.key ? root.querySelector(detail.key) : [...root.querySelectorAll('details')]
      .find(value => value.querySelector('summary')?.textContent === detail.text);
    if (element) element.open = detail.open;
  }
  root.scrollTop = saved.scroll;
  const active = saved.focused && sameStep && root.querySelector(saved.focused);
  if (active && !active.disabled && active.getClientRects().length) {
    active.focus({ preventScroll: true });
    if (saved.selection && typeof active.setSelectionRange === 'function' && saved.selection[0] !== null) {
      try { active.setSelectionRange(...saved.selection); } catch { /* Number and checkbox inputs have no text selection. */ }
    }
  }
}

export function stepKey(state) {
  const round = state?.round;
  const resolution = round?.resolution;
  const self = state?.players?.find(player => player.id === state.you);
  return JSON.stringify([state?.code, state?.you, self?.role,
    round?.visitors?.find(player => player.id === state.you)?.status,
    state?.phase, state?.draft?.turnPlayerId, state?.setup?.turnPlayerId, state?.setup?.drawnTileId,
    state?.opening?.phase, state?.opening?.inspectedRoom?.id,
    round?.phase, round?.silent?.cycle, round?.silent?.turnPlayerId,
    resolution?.kind, resolution?.playerId, resolution?.cornerId, resolution?.token?.id,
    round?.pendingAction, round?.interruption?.kind, round?.interruption?.canRespond,
    round?.exchangeOffers?.map(offer => offer.id),
    round?.powers?.step, round?.powers?.canCry, round?.powers?.canManage,
    Boolean(round?.powers?.pathRooms?.length), round?.powers?.pathInspection?.roomId, round?.powers?.rearrangement?.roomId,
    round?.powers?.rearrangement?.corners?.map(corner => corner.id),
    round?.ghost?.inspectedRoom?.id, round?.hako?.inspectedRoom?.id,
    round?.ghost?.finished, round?.hako?.finished, Boolean(round?.result)]);
}
