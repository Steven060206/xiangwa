import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFeedbackTracker, describeItemEvent } from '../public/feedback.js';

// Node resolves the browser's /shared route as a disk root; keep the real map module in this harness.
const tileSource = (await readFile(new URL('../public/tile.js', import.meta.url), 'utf8'))
  .replace("'/shared/maps.mjs'", JSON.stringify(new URL('../src/maps.mjs', import.meta.url).href));
const feedbackSource = (await readFile(new URL('../public/feedback-view.js', import.meta.url), 'utf8'))
  .replace("'./tile.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(tileSource).toString('base64')}`))
  .replace("'./feedback.js'", JSON.stringify(new URL('../public/feedback.js', import.meta.url).href));
const { createFeedbackUI } = await import(`data:text/javascript;base64,${Buffer.from(feedbackSource).toString('base64')}`);

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
      powers: { slots: [], announcement: null, lastActivation: null, activationNotice: null },
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

test('public skill events distinguish declaration, completion and interruption without private results', () => {
  let current = state();
  const tracker = trackerWith(current);
  for (const [index, status] of ['declared', 'triggered', 'interrupted', 'ineffective'].entries()) {
    current = nextState(current, value => {
      value.round.items.events ||= [];
      value.round.items.events.push({ id: `item-${index}`, kind: `item_${status}`, itemId: 'smartphone', userId: value.you, status });
    });
    const [event] = tracker.receive(current);
    assert.equal(event.privateLabel, '全员可见');
    assert.equal(event.highlight, true);
    assert.match(event.title, /智能手机/);
    assert.doesNotMatch(event.body, /NO\.|动来动去/);
    assert.match(event.title + event.body, { declared: /声明.*尚未/, triggered: /已触发/, interrupted: /被打断/, ineffective: /未生效/ }[status]);
  }
  assert.deepEqual(tracker.receive(structuredClone(current)), []);
});

test('death emits one public fixed-corner highlight and does not replay after hiding or refresh', () => {
  const initial = state();
  const tracker = trackerWith(initial, { locationName: id => id === 'children_cabinet' ? '19 · 儿童房 · 壁橱' : id });
  const dead = nextState(initial, value => {
    value.round.visitors[0].status = 'box_person';
    value.round.deathEvents = [{ id: 'death-1', userId: value.you, cornerId: 'children_cabinet' }];
    value.round.items.events = [{ id: 'death-1', kind: 'death', userId: value.you, cornerId: 'children_cabinet' }];
  });
  const [event, ...rest] = tracker.receive(dead);
  assert.deepEqual(rest, []);
  assert.equal(event.cornerId, 'children_cabinet');
  assert.equal(event.privateLabel, '全员可见');
  assert.match(event.body, /19 · 儿童房 · 壁橱.*技能牌已消失/);
  assert.deepEqual(tracker.receive(nextState(dead, value => { value.round.deathLocations = []; })), []);
  trackerWith(dead);
});

test('walkie requests and selected-token results highlight only their private filtered snapshots', () => {
  let current = state();
  const tracker = trackerWith(current);
  current = nextState(current, value => { value.round.walkie = { pairRequest: { id: 'pair1', fromId: 'visitor-b', targetId: value.you } }; });
  let [event] = tracker.receive(current);
  assert.match(event.title, /访问者乙邀请你配对/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.highlight, true);
  assert.equal(event.requiresResponse, true);
  assert.equal(event.view, 'action');
  current = nextState(current, value => { value.round.walkie = { showRequest: { id: 'show1', fromId: value.you, targetId: 'visitor-b' } }; });
  [event] = tracker.receive(current);
  assert.match(event.title, /访问者乙互看标志/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.requiresResponse, true);
  current = nextState(current, value => { value.round.walkie = { lastShow: { id: 'show1', fromId: 'visitor-b', tokens: [{ id: 'password_4', type: 'password', number: 4 }] } }; });
  [event] = tracker.receive(current);
  assert.match(event.body, /密码4/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.requiresResponse, false);
  assert.deepEqual(tracker.receive(nextState(current)), []);
  const publicEvent = describeItemEvent({ itemId: 'walkie_talkie', userId: 'visitor-a', targetId: 'visitor-b', operation: 'show' }, current);
  assert.match(publicEvent.body, /访问者甲与访问者乙进行标志互看/);
  assert.doesNotMatch(JSON.stringify(publicEvent), /密码4/);
  const outsider = state(1, 'hako');
  assert.deepEqual(trackerWith(outsider).receive(nextState(outsider)), []);
});

test('an early despair draw is a private failed acquisition instead of a success', () => {
  const initial = state(1, 'hako');
  const tracker = trackerWith(initial);
  const [event] = tracker.receive(nextState(initial, value => { value.round.powers.lastDraw = { kind: 'despair_locked', cards: [] }; }));
  assert.match(event.title, /绝望时刻尚未到来/);
  assert.match(event.body, /没有获得新能力/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.tone, 'attention');
});

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
  assert.equal(event.highlight, false);
  assert.equal(event.view, 'inventory');
  assert.equal(event.symbol, 'weapon');
  assert.equal(event.tone, 'success');
  const [extinguisher] = tracker.receive(nextState(next, value => value.round.inventory.tokens.push({
    id: 'extinguisher', type: 'extinguisher',
  })));
  assert.match(extinguisher.body, /无声累计超过10/);
  assert.match(extinguisher.body, /持有者在自己的回合/);
  assert.match(extinguisher.body, /进入箱娃阶段后，使用时机结束/);
  assert.doesNotMatch(extinguisher.body, /NO\.5|发动响应窗口/);
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
  assert.equal(event.title, '发现手记2 · 已自动公开');
  assert.equal(event.symbol, 'notebook');
  assert.match(event.body, /马上就到哟：先发动/);
  assert.equal(event.privateLabel, '手记内容全员可见；发现位置不公开');
  assert.equal(event.highlight, true);
  const other = structuredClone(peek);
  other.round.resolution = { kind: 'waiting', playerId: 'visitor-a' };
  assert.deepEqual(waiting.receive(other), []);
  assert.deepEqual(owner.receive(nextState(peek, value => {
    value.round.resolution.replacementTokens = [{ id: 'key', type: 'key' }];
  })), []);
});

test('private non-notebook discoveries retain their filtered corner for map review', () => {
  const initial = state();
  const tracker = trackerWith(initial, { locationName: () => '07 · 浴室 · 废旧马桶' });
  const peek = nextState(initial, value => {
    value.round.resolution = { kind: 'peek', playerId: value.you, cornerId: 'bathroom_toilet',
      token: { id: 'password_4', type: 'password', number: 4 } };
  });
  const [event] = tracker.receive(peek);
  assert.equal(event.cornerId, 'bathroom_toilet');
  assert.match(event.body, /07 · 浴室 · 废旧马桶/);
  assert.equal(event.privateLabel, '仅你可见');
  assert.equal(event.requiresResponse, true);
  const observer = trackerWith(state(1, 'visitor-b'));
  peek.you = 'visitor-b';
  peek.round.resolution = { kind: 'waiting', playerId: 'visitor-a' };
  assert.deepEqual(observer.receive(peek), []);
});

test('anonymous abilities use their notice serial, including repeat answers in the same cycle', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const activated = nextState(initial, value => {
    value.round.powers.activationNotice = { serial: 1, cycle: 3 };
  });
  const [first] = tracker.receive(activated);
  assert.equal(first.title, '箱娃发动了能力');
  assert.match(first.body, /名称未公开/);
  assert.doesNotMatch(JSON.stringify(first), /NO\.|动来动去|打不开的门|powerId/);
  assert.equal(first.highlight, true);
  assert.equal(first.symbol, 'power');
  assert.deepEqual(tracker.receive(nextState(activated, value => value.log.push('箱娃发动了能力。'))), [],
    'A matching old log does not represent another activation');
  const repeat = nextState(activated, value => { value.round.powers.activationNotice.serial = 2; });
  repeat.version++;
  assert.equal(tracker.receive(repeat)[0].title, '箱娃发动了能力');
  assert.deepEqual(tracker.receive(structuredClone(repeat)), []);
  assert.deepEqual(tracker.receive(nextState(repeat)), []);
});

test('a silently emptied ability slot creates no visitor activation event', () => {
  const initial = state();
  initial.round.powers.activationNotice = { serial: 2, cycle: 1 };
  initial.round.powers.slots = [{ slot: 0, occupied: true, faceUp: false }];
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => {
    value.round.powers.slots = [{ slot: 0, occupied: false }];
  });
  assert.deepEqual(tracker.receive(next), []);
});

test('hako private power names stay private while anonymous notices have their own serial', () => {
  const initial = state(1, 'hako');
  const tracker = trackerWith(initial);
  const activated = nextState(initial, value => {
    value.round.powers.lastActivation = { powerId: 2, name: '马上就到哟', cycle: 1 };
  });
  const [own] = tracker.receive(activated);
  assert.equal(own.privateLabel, '仅你可见');
  assert.match(own.title, /马上就到哟/);
  const publicAbility = nextState(activated, value => {
    value.round.powers.lastActivation = { powerId: 7, name: '快把它给我', cycle: 1 };
    value.round.powers.activationNotice = { serial: 1, cycle: 1 };
  });
  const [publicEvent] = tracker.receive(publicAbility);
  assert.equal(publicEvent.privateLabel, '仅你可见');
  assert.equal(publicEvent.highlight, true);
});

test('refresh, reconnect and undo establish quiet notice baselines without erasing history', () => {
  const initial = state();
  initial.round.powers.activationNotice = { serial: 4, cycle: 2 };
  const tracker = trackerWith(initial);
  assert.deepEqual(tracker.receive(structuredClone(initial)), []);
  const activated = nextState(initial, value => { value.round.powers.activationNotice.serial = 5; });
  assert.equal(tracker.receive(activated)[0].title, '箱娃发动了能力');
  tracker.resetBaseline();
  const reconnected = nextState(activated, value => { value.round.powers.activationNotice.serial = 8; });
  assert.deepEqual(tracker.receive(reconnected), []);
  assert.equal(tracker.items().length, 1);
  const undone = nextState(reconnected, value => {
    value.log.push('访问者甲 撤销了上一步。');
    value.round.powers.activationNotice.serial = 7;
  });
  assert.deepEqual(tracker.receive(undone).map(event => event.title), ['已撤销上一步']);
  assert.deepEqual(tracker.receive(nextState(undone)), []);
  const later = nextState(undone, value => { value.round.powers.activationNotice.serial = 8; });
  later.version++;
  assert.equal(tracker.receive(later)[0].title, '箱娃发动了能力');
});

test('a skipped anonymous notice is not identified as hako\'s later silent ability', () => {
  const initial = state(1, 'hako');
  const tracker = trackerWith(initial);
  const combined = nextState(initial, value => {
    value.round.powers.activationNotice = { serial: 1, cycle: 1 };
    value.round.powers.lastActivation = { powerId: 4, name: '动来动去', cycle: 1 };
  });
  const events = tracker.receive(combined);
  assert.deepEqual(events.map(event => event.title), ['箱娃发动了能力', '箱娃发动了NO.4 动来动去']);
  assert.equal(events[0].privateLabel, '全员可见');
  assert.equal(events[1].privateLabel, '仅你可见');
  const more = nextState(combined, value => { value.round.powers.activationNotice.serial = 3; });
  const [notice, duplicate] = tracker.receive(more);
  assert.equal(notice.title, '箱娃发动了能力');
  assert.match(notice.body, /共发动了2次/);
  assert.equal(duplicate, undefined);
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
    value.round.powers.lastDraw = { kind: 'acquired', cards: [3] };
    value.round.powers.hand.push({ id: 3, name: '打不开的门', description: '封锁一扇实际相连的门。' });
  });
  const events = tracker.receive(cry);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, '哭喊指向客厅');
  assert.equal(events[0].privateLabel, '全员可见');
  assert.equal(events[1].title, '获得了NO.3 打不开的门');
  assert.equal(events[1].privateLabel, '仅你可见');
  assert.equal(events[0].highlight, true);
  assert.equal(events[1].highlight, false);
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
  assert.equal(phoneEvent.title, '手机查看：NO.4 动来动去');
  assert.match(phoneEvent.body, /重排一个房间的标志/);
  assert.match(phoneEvent.body, /不表示能力已设置或生效/);
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

test('one notebook discovery merges its automatic publication without publishing the corner', () => {
  const initial = state();
  const tracker = trackerWith(initial);
  const next = nextState(initial, value => {
    const notebook = { id: 'notebook_10', type: 'notebook', number: 10,
      power: { id: 10, name: '鬼来电', description: '第一名访问者进入客厅后全体解除。' } };
    value.round.notebooks.push(notebook);
    value.round.resolution = { kind: 'notebook', playerId: value.you, cornerId: 'bathroom_toilet', token: notebook };
  });
  const [event, duplicate] = tracker.receive(next);
  assert.equal(duplicate, undefined);
  assert.equal(event.title, '发现手记10 · 已自动公开');
  assert.match(event.body, /对应能力：NO.10 鬼来电/);
  assert.match(event.body, /卡面说明/);
  assert.match(event.body, /选择补位方式/);
  assert.equal(event.requiresResponse, true);
  assert.doesNotMatch(JSON.stringify(event), /bathroom_toilet|废旧马桶/);
  const observer = trackerWith(state(1, 'visitor-b'));
  const filtered = structuredClone(next);
  filtered.you = 'visitor-b';
  filtered.round.resolution = { kind: 'waiting', playerId: 'visitor-a' };
  const [publicEvent] = observer.receive(filtered);
  assert.equal(publicEvent.title, '手记10已公开');
  assert.equal(publicEvent.privateLabel, '全员可见');
  assert.doesNotMatch(JSON.stringify(publicEvent), /bathroom_toilet|发现位置|补位/);
});

test('response events describe current controls and victory routes to review', () => {
  const initial = state(1, 'hako');
  const tracker = trackerWith(initial);
  const declared = nextState(initial, value => {
    value.round.pendingAction = { type: 'peek', playerId: 'visitor-a', cornerId: 'bathroom_toilet' };
    value.undo.pending = { id: 'vote-1', requiredIds: ['hako'], approvedIds: [] };
  });
  const responses = tracker.receive(declared);
  assert.deepEqual(responses.map(event => event.title), ['请回应撤销请求', '请确认访问者行动']);
  assert.ok(responses.every(event => event.requiresResponse && event.view === 'action'));
  assert.doesNotMatch(JSON.stringify(responses), /bathroom_toilet/);
  const question = nextState(declared, value => {
    value.round.resolution = { kind: 'item_answer', playerId: 'hako', userId: 'visitor-a' };
  });
  assert.equal(tracker.receive(question)[0].title, '请回答道具询问');
  const ending = nextState(question, value => { value.round.result = { winner: 'hako', reason: '访问者投降。' }; });
  assert.equal(tracker.receive(ending)[0].view, 'review');
});

function feedbackDocument(t) {
  const oldDocument = globalThis.document;
  const nodes = new Map();
  const navigations = [];
  const locations = [];
  const documentListeners = new Map();
  class Element {
    children = [];
    listeners = new Map();
    dataset = {};
    attributes = {};
    textContent = '';
    hidden = false;
    open = false;
    isConnected = true;
    classList = { toggle() {} };
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(type, listener) {
      this.listeners.set(type, [...this.listeners.get(type) || [], listener]);
    }
    emit(type, data = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, ...data });
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    hidePopover() {}
    getClientRects() { return this.hidden ? [] : [{}]; }
    getBoundingClientRect() { return { left: 10, right: 100, top: 10, bottom: 100 }; }
  }
  globalThis.document = {
    activeElement: new Element(),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Element(); },
    createElementNS() { return new Element(); },
    addEventListener(type, listener) {
      documentListeners.set(type, [...documentListeners.get(type) || [], listener]);
    },
    dispatchEvent(event) {
      if (event.type === 'game-navigate') navigations.push(event.detail.view);
      if (event.type === 'hako:locate-corner') locations.push(event.detail.cornerId);
      for (const listener of documentListeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  const ui = createFeedbackUI();
  t.after(() => { ui.clear(); globalThis.document = oldDocument; });
  return { ui, nodes, navigations, locations, node: id => document.getElementById(id) };
}

test('important events queue without rewriting a card, mark reads, and retain unread history after close', t => {
  const { ui, node, navigations } = feedbackDocument(t);
  const initial = state();
  ui.receive(initial);
  assert.equal(node('event-dialog').open, false);
  assert.equal(node('event-count').hidden, true);
  const next = nextState(initial, value => {
    value.round.sharedTokens = { kind: 'shown_token', fromId: 'visitor-b', token: { id: 'password_6', type: 'password', number: 6 } };
    value.round.powers.announcement = { roomId: 'living_room', cycle: 1 };
  });
  node('event-primary-action').hidden = true;
  ui.receive(next);
  const firstTitle = node('event-title').textContent;
  const firstBody = node('event-body').textContent;
  assert.equal(node('event-dialog').open, true);
  assert.equal(node('event-primary-action').hidden, false);
  assert.equal(node('event-count').textContent, '1');
  const response = nextState(next, value => { value.round.interruption = { canRespond: true }; });
  ui.receive(response);
  assert.equal(node('event-title').textContent, firstTitle);
  assert.equal(node('event-body').textContent, firstBody);
  assert.equal(node('event-companions').children.length, 0);
  assert.match(node('event-next').textContent, /待回应/);
  assert.equal(node('event-primary-action').textContent, '查看当前步骤');
  node('event-next').emit('click');
  assert.equal(node('event-title').textContent, '请回应灭火器窗口');
  assert.equal(node('event-count').textContent, '1');
  node('event-close').emit('click');
  assert.equal(node('event-dialog').open, false);
  assert.deepEqual(navigations, []);
  assert.equal(node('event-count').hidden, false);
  const unread = node('event-history-list').children.find(row => row.children[0].children[1].textContent.startsWith('未读'));
  unread.children[0].emit('click');
  assert.match(node('event-position').textContent, /历史事件/);
  assert.equal(node('event-count').hidden, true);
  node('event-primary-action').emit('click');
  assert.deepEqual(navigations, ['action']);
  assert.equal(node('event-history-list').children.length, 3);
  ui.receive(response);
  assert.equal(node('event-dialog').open, false);
  assert.equal(node('event-count').hidden, true);
});

test('ordinary gains use a toast, and escape or outside close restores focus without a game action', t => {
  const { ui, node, navigations } = feedbackDocument(t);
  const initial = state();
  ui.receive(initial);
  const ordinary = nextState(initial, value => value.round.inventory.items.push({ id: 'night_vision', name: '夜视仪' }));
  ui.receive(ordinary);
  assert.equal(node('event-dialog').open, false);
  assert.equal(node('event-toast').hidden, false);
  assert.match(node('event-toast').textContent, /获得了夜视仪/);
  const origin = node('some-input');
  origin.focus();
  const important = nextState(ordinary, value => value.round.inventory.tokens.push({ id: 'password_3', type: 'password', number: 3 }));
  ui.receive(important);
  assert.equal(node('event-primary-action').textContent, '查看物品');
  node('event-dialog').emit('cancel');
  assert.equal(document.activeElement, origin);
  assert.equal(node('event-dialog').open, false);
  assert.deepEqual(navigations, []);
  const next = nextState(important, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' }));
  ui.receive(next);
  origin.isConnected = false;
  node('event-dialog').emit('click', { clientX: 0, clientY: 0 });
  assert.equal(document.activeElement, node('focus-current-action'));
  assert.deepEqual(navigations, []);
  ui.clear();
  assert.equal(node('event-toast').hidden, true);
  assert.equal(node('event-history-list').children.length, 0);
});

test('a finished game offers review while an old task remains readable and old snapshots cannot regress it', t => {
  const { ui, node, navigations } = feedbackDocument(t);
  const initial = state();
  ui.receive(initial);
  const response = nextState(initial, value => { value.round.interruption = { canRespond: true }; });
  ui.receive(response);
  const ending = nextState(response, value => { value.round.result = { winner: 'hako', reason: '访问者投降。' }; });
  ui.receive(ending);
  ui.receive(response);
  assert.equal(node('event-title').textContent, '请回应灭火器窗口');
  assert.match(node('event-next').textContent, /重大变化/);
  assert.match(node('event-position').textContent, /历史事件/);
  assert.equal(node('event-primary-action').textContent, '查看复盘');
  node('event-primary-action').emit('click');
  assert.deepEqual(navigations, ['review']);
});

test('event map locations remain tied to the displayed card and never submit a game action', t => {
  const { ui, node, navigations, locations } = feedbackDocument(t);
  const initial = state();
  ui.receive(initial);
  const death = nextState(initial, value => {
    value.round.visitors[1].status = 'box_person';
    value.round.deathEvents = [{ id: 'death-1', userId: 'visitor-b', cornerId: 'children_cabinet' }];
  });
  ui.receive(death);
  assert.equal(node('event-locate').hidden, false);
  node('event-locate').onclick();
  assert.equal(node('event-dialog').open, false);
  assert.deepEqual(locations, ['children_cabinet']);
  assert.deepEqual(navigations, []);
  const peek = nextState(death, value => {
    value.round.resolution = { kind: 'peek', playerId: value.you, cornerId: 'bathroom_toilet',
      token: { id: 'password_4', type: 'password', number: 4 } };
  });
  ui.receive(peek);
  const shared = nextState(peek, value => {
    value.round.sharedTokens = { kind: 'shown_token', fromId: 'visitor-b', token: { id: 'key', type: 'key' } };
  });
  ui.receive(shared);
  assert.equal(node('event-locate').hidden, false);
  assert.match(node('event-title').textContent, /密码4/);
  node('event-next').emit('click');
  assert.match(node('event-title').textContent, /展示了钥匙/);
  assert.equal(node('event-locate').hidden, true);
  assert.deepEqual(navigations, []);
});

test('an outstanding walkie response routes an older inventory card to the current controls', t => {
  const { ui, node, navigations } = feedbackDocument(t);
  const initial = state();
  ui.receive(initial);
  const acquired = nextState(initial, value => value.round.inventory.tokens.push({ id: 'key', type: 'key' }));
  ui.receive(acquired);
  assert.equal(node('event-primary-action').textContent, '查看物品');
  const request = nextState(acquired, value => {
    value.round.walkie = { pairRequest: { id: 'pair-1', fromId: 'visitor-b', targetId: value.you } };
  });
  ui.receive(request);
  assert.equal(node('event-title').textContent, '获得了钥匙');
  assert.match(node('event-next').textContent, /待回应/);
  assert.equal(node('event-primary-action').textContent, '查看当前步骤');
  node('event-primary-action').emit('click');
  assert.deepEqual(navigations, ['action']);
});
