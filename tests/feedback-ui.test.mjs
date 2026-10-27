import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackTracker } from '../public/feedback.js';

function state(version = 1, you = 'visitor-a') {
  return {
    code: 'ROOM01', version, you, log: [], initialItems: [], initialPower: null,
    players: [{ id: 'hako', name: '箱娃甲' }, { id: 'visitor-a', name: '访问者甲' },
      { id: 'visitor-b', name: '访问者乙' }],
    undo: { steps: 1 },
    round: {
      phase: 'visitor_action', visitors: [{ id: 'visitor-a', status: 'alive' },
        { id: 'visitor-b', status: 'alive' }],
      hako: { playerId: 'hako' }, silent: { turnPlayerId: 'visitor-b' },
      inventory: { tokens: [], items: [] }, notebooks: [], publicDiscoveries: [],
      exchangeOffers: [], sharedTokens: null, resolution: null, interruption: null,
      powers: { slots: [], announcement: null, lastActivation: null },
      items: { result: null, roomOptions: [{ id: 'living_room', name: '客厅' }] },
      safe: { opened: false }, result: null,
    },
  };
}

function nextState(before, edit) {
  const next = structuredClone(before);
  next.version++;
  edit?.(next);
  return next;
}

function trackerWith(initial = state(), options) {
  const tracker = createFeedbackTracker(options);
  assert.deepEqual(tracker.receive(initial), []);
  return tracker;
}

test('first snapshot and refresh establish a quiet baseline with existing belongings', () => {
  const initial = state();
  initial.round.inventory.tokens.push({ id: 'weapon-gasoline', type: 'weapon', tool: 'gasoline' });
  initial.initialItems.push({ playerId: initial.you, itemId: 'stethoscope', itemName: '听诊器' });
  initial.initialPower = { id: 4, name: '动来动去' };
  const tracker = trackerWith(initial);
  assert.equal(tracker.active(), null);
  assert.deepEqual(tracker.items(), []);
  const refresh = createFeedbackTracker();
  assert.deepEqual(refresh.receive(initial), []);
});

test('acquired token has its concrete name, rule explanation, privacy and symbol', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => value.round.inventory.tokens.push({
    id: 'weapon-gasoline', type: 'weapon', tool: 'gasoline',
  }));
  const [event] = tracker.receive(next);
  assert.equal(event.title, '获得了汽油');
  assert.match(event.body, /讨伐/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.highlight, true);
  assert.equal(event.symbol, 'weapon');
  assert.equal(event.tone, 'success');
  const [extinguisher] = tracker.receive(nextState(next, value => value.round.inventory.tokens.push({
    id: 'extinguisher', type: 'extinguisher',
  })));
  assert.match(extinguisher.body, /无声累计超过10/);
  assert.match(extinguisher.body, /“我在你身后”发动的响应窗口/);
});

test('initial and later visitor items include the actual card description', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const drafted = nextState(initial, value => value.initialItems.push({
    playerId: value.you, itemId: 'night_vision', itemName: '夜视仪', itemDescription: '发现手记时选择未领取道具。',
  }));
  const [event] = tracker.receive(drafted);
  assert.equal(event.title, '获得了夜视仪');
  assert.equal(event.body, '发现手记时选择未领取道具。');
  assert.equal(event.symbol, 'item');
  const acquired = nextState(drafted, value => value.round.inventory.items.push({
    id: 'stethoscope', name: '听诊器', description: '猜测正确时公开一个密码数字。',
  }));
  const [later] = tracker.receive(acquired);
  assert.equal(later.title, '获得了听诊器');
  assert.match(later.body, /猜测正确时公开一个密码数字/);
});

test('duplicate HTTP/SSE snapshots, older versions and online changes do not replay events', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' }));
  assert.equal(tracker.receive(next).length, 1);
  assert.deepEqual(tracker.receive(structuredClone(next)), []);
  assert.deepEqual(tracker.receive(initial), []);
  const online = structuredClone(next);
  online.players[1].online = false;
  assert.deepEqual(tracker.receive(online), []);
  assert.equal(tracker.items().length, 1);
});

test('switching room or participant clears private history even at a lower version', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  tracker.receive(nextState(initial, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' })));
  assert.equal(tracker.items().length, 1);
  const otherRoom = state();
  otherRoom.code = 'ROOM02';
  assert.deepEqual(tracker.receive(otherRoom), []);
  assert.deepEqual(tracker.items(), []);
  const found = nextState(otherRoom, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' }));
  tracker.receive(found);
  const otherPlayer = { ...state(1, 'visitor-b'), code: 'ROOM02' };
  assert.deepEqual(tracker.receive(otherPlayer), []);
  assert.deepEqual(tracker.items(), []);
});

test('undo reports restoration without claiming restored items were newly acquired', () => {
  const initial = state();
  initial.undo.steps = 3;
  const tracker = trackerWith(initial);
  const undone = nextState(initial, value => {
    value.log.push('访问者甲 撤销了上一步。');
    value.undo.steps = 2;
    value.round.inventory.tokens.push({ id: 'key', type: 'key' });
  });
  const events = tracker.receive(undone);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, '已撤销上一步');
  assert.equal(events[0].highlight, false);
  assert.deepEqual(tracker.receive(nextState(undone)), []);
});

test('private peek discoveries come only from the filtered resolution, including notebook effects', () => {
  const initial = state();
  const owner = trackerWith(initial);
  const waiting = trackerWith(initial);
  const peek = nextState(initial, value => {
    value.round.resolution = { kind: 'notebook', playerId: value.you, cornerId: 'bathroom_toilet',
      token: { id: 'notebook_2', type: 'notebook', number: 2,
        power: { name: '马上就到哟', description: '先发动，再移动两块地图板。' } } };
  });
  const [event] = owner.receive(peek);
  assert.equal(event.title, '你发现了手记2');
  assert.equal(event.symbol, 'notebook');
  assert.match(event.body, /马上就到哟：先发动/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.highlight, true);
  const other = structuredClone(peek);
  other.round.resolution = { kind: 'waiting', playerId: 'visitor-a' };
  assert.deepEqual(waiting.receive(other), []);
  assert.deepEqual(owner.receive(nextState(peek, value => {
    value.round.resolution.replacementTokens = [{ id: 'key', type: 'key' }];
  })), []);
});

test('anonymous abilities remain unnamed and repeated anonymous activations are recognised from new logs', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const activated = nextState(initial, value => {
    value.round.powers.lastActivation = { cycle: 3 };
    value.log.push('箱娃发动了能力。');
  });
  const [first] = tracker.receive(activated);
  assert.equal(first.title, '箱娃发动了能力');
  assert.match(first.body, /名称未公开/);
  assert.doesNotMatch(JSON.stringify(first), /NO\.|动来动去|打不开的门|powerId/);
  assert.equal(first.highlight, false);
  assert.equal(first.symbol, 'power');
  const repeat = nextState(activated, value => value.log.push('箱娃发动了能力。'));
  assert.equal(tracker.receive(repeat)[0].title, '箱娃发动了能力');
});

test('public and private power names follow the already filtered activation metadata', () => {
  const initial = state(1, 'hako');
  const tracker = trackerWith(initial);
  const activated = nextState(initial, value => {
    value.round.powers.lastActivation = { powerId: 2, name: '马上就到哟', public: false, cycle: 1 };
  });
  const [own] = tracker.receive(activated);
  assert.equal(own.privateLabel, '仅你可见');
  assert.match(own.title, /马上就到哟/);
  const publicAbility = nextState(activated, value => {
    value.round.powers.lastActivation = { powerId: 7, name: '快把它给我', public: true, cycle: 1 };
  });
  const [publicEvent] = tracker.receive(publicAbility);
  assert.equal(publicEvent.privateLabel, '全员可见');
  assert.equal(publicEvent.highlight, true);
});

test('ordinary turn and hako stage changes stay in history without opening a highlight', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const turn = nextState(initial, value => {
    value.round.phase = 'visitor_reveal';
    value.round.silent.turnPlayerId = value.you;
  });
  const [event] = tracker.receive(turn);
  assert.equal(event.title, '轮到你了');
  assert.equal(event.symbol, 'turn');
  assert.equal(event.highlight, false);
  const phase = nextState(turn, value => { value.round.phase = 'hako_phase'; });
  const [stage] = tracker.receive(phase);
  assert.equal(stage.title, '进入箱娃阶段');
  assert.equal(stage.highlight, false);
});

test('cry room, phone card and drawn powers use only fields present in the participant view', () => {
  const initial = state(1, 'hako');
  initial.round.powers.hand = [];
  const tracker = trackerWith(initial);
  const cry = nextState(initial, value => {
    value.round.powers.announcement = { roomId: 'living_room', cycle: 1 };
    value.round.powers.lastDraw = { kind: 'acquired', cards: [11] };
    value.round.powers.hand.push({ id: 11, name: '虚假的哭喊', description: '可宣告另一房间。' });
  });
  const events = tracker.receive(cry);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, '哭喊指向客厅');
  assert.equal(events[0].privateLabel, '全员可见');
  assert.equal(events[1].title, '获得了虚假的哭喊');
  assert.equal(events[1].privateLabel, '仅你可见');
  assert.ok(events.every(event => event.highlight));
  const visitor = state();
  const visitorTracker = trackerWith(visitor);
  const publicCry = nextState(visitor, value => {
    value.round.powers.announcement = cry.round.powers.announcement;
  });
  assert.equal(visitorTracker.receive(publicCry).length, 1);
  const phone = nextState(publicCry, value => {
    value.round.items.result = { kind: 'phone', card: { id: 4, name: '动来动去', description: '重排一个房间的标志。' } };
  });
  const [phoneEvent] = visitorTracker.receive(phone);
  assert.equal(phoneEvent.title, '手机查看：动来动去');
  assert.equal(phoneEvent.body, '重排一个房间的标志。');
  assert.equal(phoneEvent.privateLabel, '仅你可见');
});

test('recalling an existing power does not announce a new ability', () => {
  const initial = state(1, 'hako');
  initial.round.powers.hand = [];
  initial.round.powers.slots = [{ card: { id: 4, name: '动来动去' } }];
  const tracker = trackerWith(initial);
  const recalled = nextState(initial, value => {
    value.round.powers.hand.push({ id: 4, name: '动来动去' });
    value.round.powers.slots = [{ occupied: false }];
  });
  assert.deepEqual(tracker.receive(recalled), []);
});

test('death, banishment and victory have strong events and suppress misleading death inventory loss', () => {
  const initial = state();
  initial.round.inventory.tokens.push({ id: 'key', type: 'key' });
  const tracker = trackerWith(initial);
  const death = nextState(initial, value => {
    value.round.visitors[0].status = 'box_person';
    value.round.inventory.tokens = [];
  });
  const [dead] = tracker.receive(death);
  assert.equal(dead.title, '你已死亡，转为箱人');
  assert.equal(dead.tone, 'danger');
  assert.equal(dead.highlight, true);
  assert.equal(dead.symbol, 'death');
  const ending = nextState(death, value => {
    value.round.visitors[0].status = 'banished';
    value.round.result = { winner: 'visitors', reason: '访问者携带人偶超度亡骸。' };
  });
  const [banished, victory] = tracker.receive(ending);
  assert.equal(banished.title, '你已被讨伐');
  assert.equal(victory.title, '访问者获胜');
  assert.equal(victory.symbol, 'victory');
  assert.equal(victory.highlight, true);
  assert.equal(tracker.active().title, victory.title);
});

test('exchange requests, private display and extinguisher responses clearly identify the next decision', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => {
    value.round.exchangeOffers.push({ id: 1, fromId: 'visitor-b', targetId: value.you,
      giveTokens: [{ id: 'password_6', type: 'password', number: 6 }], giveItems: [] });
    value.round.sharedTokens = { kind: 'shown_token', fromId: 'visitor-b', token: { id: 'key', type: 'key' } };
    value.round.interruption = { canRespond: true };
  });
  const events = tracker.receive(next);
  assert.match(events[0].title, /访问者乙向你提出交换/);
  assert.match(events[0].body, /密码6/);
  assert.match(events[1].body, /其他玩家正在等待/);
  assert.equal(events[2].symbol, 'key');
  assert.ok(events.every(event => event.highlight && event.privateLabel === '仅你可见'));
});

test('public notebooks and published finds carry concrete effects and the public visibility label', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => {
    value.round.notebooks.push({ id: 'notebook_2', type: 'notebook', number: 2,
      power: { name: '马上就到哟', description: '先发动再移动。' } });
    value.round.publicDiscoveries.push({ playerId: 'visitor-b',
      token: { id: 'weapon_gasoline', type: 'weapon', name: '汽油', tool: 'gasoline' } });
  });
  const [notebook, find] = tracker.receive(next);
  assert.equal(notebook.title, '手记2已公开');
  assert.match(notebook.body, /马上就到哟：先发动再移动/);
  assert.equal(find.title, '访问者乙公开了汽油');
  assert.match(find.body, /讨伐/);
  assert.ok([notebook, find].every(event => event.privateLabel === '全员可见'));
});

test('each completed safe attempt reports its result even if two attempts have the same outcome', () => {
  const initial = state();
  initial.round.sharedTokens = { kind: 'safe_result', correct: false, usedStethoscope: true };
  initial.round.resolution = { kind: 'safe', playerId: initial.you, cornerId: 'study_desk',
    token: { id: 'safe', type: 'safe' } };
  const tracker = trackerWith(initial);
  const completed = nextState(initial, value => { value.round.resolution = null; });
  const [result] = tracker.receive(completed);
  assert.equal(result.title, '保险箱尝试未成功');
  assert.match(result.body, /未公开新的正确数字/);
  assert.equal(result.symbol, 'password');
  assert.equal(result.highlight, true);
  assert.deepEqual(tracker.receive(nextState(completed)), []);
});

test('dismiss retains history, clones prevent mutation leaks, history is bounded and clear resets baseline', () => {
  const initial = state();
  const tracker = trackerWith(initial, { limit: 2 });
  const next = nextState(initial, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' }));
  const returned = tracker.receive(next);
  returned[0].title = 'modified';
  next.round.inventory.tokens[0].name = 'modified snapshot';
  assert.equal(tracker.active().title, '获得了钥匙');
  const copy = tracker.items();
  copy[0].title = 'modified history';
  assert.equal(tracker.items()[0].title, '获得了钥匙');
  tracker.dismiss(tracker.active().id);
  assert.equal(tracker.active(), null);
  assert.equal(tracker.items()[0].dismissed, true);
  let current = structuredClone(next);
  delete current.round.inventory.tokens[0].name;
  for (let number = 1; number <= 2; number++) {
    current = nextState(current, value => value.round.inventory.tokens.push({ id: `password_${number}`, type: 'password', number }));
    tracker.receive(current);
  }
  assert.equal(tracker.items().length, 2);
  assert.equal(tracker.items()[0].title, '获得了密码2');
  assert.equal(tracker.items()[1].title, '获得了密码1');
  assert.equal(initial.round.inventory.tokens.length, 0);
  tracker.clear();
  assert.deepEqual(tracker.items(), []);
  assert.deepEqual(tracker.receive(current), []);
});
