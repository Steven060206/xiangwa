import test from 'node:test';
import assert from 'node:assert/strict';
import { stepKey, draftScope, resetDrafts } from '../public/view-state.js';

const fixture = () => ({ code: 'ABCDEF', you: 'hako', phase: 'exploration', version: 10,
  players: [{ id: 'hako', role: 'hako', connected: true }],
  round: { phase: 'hako_phase', silent: { cycle: 2, turnPlayerId: 'visitor' },
    hako: { playerId: 'hako', finished: false }, powers: { step: 'action' } } });

test('operation identity ignores chat, presence, versions and legal-option changes', () => {
  const before = fixture();
  const after = structuredClone(before);
  after.version++;
  after.chat = { revision: 4 };
  after.players[0].connected = false;
  after.round.inventory = { tokens: [{ id: 'password_4', type: 'password', number: 4 }] };
  after.round.hako.hidingRooms = [{ id: 'bathroom_room' }];
  assert.equal(stepKey(after), stepKey(before), 'valid drafts are reconciled rather than replaced when choices change');
});

test('hiding commitment, NO.2 path and NO.4 rearrangement have distinct operation boundaries', () => {
  const states = [fixture()];
  const change = update => { const next = structuredClone(states.at(-1)); update(next); states.push(next); };
  change(state => { state.round.powers.pathInspection = { roomId: 'hall_room' }; });
  change(state => { state.round.powers.rearrangement = { roomId: 'bathroom_room', corners: [{ id: 'bathroom_toilet' }] }; });
  change(state => { delete state.round.powers.rearrangement; });
  change(state => { state.round.hako.inspectedRoom = { id: 'bathroom_room' }; });
  change(state => { state.round.hako.finished = true; });
  for (let index = 1; index < states.length; index++) assert.notEqual(stepKey(states[index]), stepKey(states[index - 1]));
});

test('resolution objects and role changes discard drafts at their true boundaries', () => {
  const before = fixture();
  const variants = [
    state => { state.round.resolution = { kind: 'peek', playerId: 'hako', cornerId: 'hall_clock', token: { id: 'password_4' } }; },
    state => { state.round.ghost = { inspectedRoom: { id: 'living_room' }, finished: false }; },
    state => { state.players[0].role = 'visitor'; },
    state => { state.round.powers.step = 'preparation'; },
    state => { state.round.result = { winner: 'hako' }; },
    state => { state.you = 'visitor'; },
    state => { state.code = 'UVWXYZ'; },
  ];
  for (const mutate of variants) {
    const next = structuredClone(before);
    mutate(next);
    assert.notEqual(stepKey(next), stepKey(before));
  }
});

test('undo invalidates same-step local drafts without relying on a saved schema change', () => {
  const state = fixture();
  const before = draftScope(state);
  resetDrafts();
  assert.notEqual(draftScope(state), before);
  assert.equal(stepKey(state), stepKey(structuredClone(state)));
});

test('walkie requests and fixed partner changes delimit private selection drafts', () => {
  const state = fixture();
  state.round.walkie = { state: 'active', partnerId: 'visitor', showRequest: { id: 'show-a' } };
  const next = structuredClone(state);
  next.round.walkie.showRequest.id = 'show-b';
  assert.notEqual(stepKey(state), stepKey(next));
  next.round.walkie = { state: 'inactive', partnerId: 'visitor' };
  assert.notEqual(stepKey(state), stepKey(next));
});
