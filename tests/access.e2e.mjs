import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createAccessControl } from '../src/access.mjs';

const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sessionKey = 'hako.room.session.v1';

async function fixture(t, protectedEntry = true) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-access-browser-'));
  let clock = Date.now();
  const access = protectedEntry ? await createAccessControl({ directory, now: () => clock }) : null;
  const server = createGameServer(protectedEntry ? { accessDirectory: directory, accessNow: () => clock } : {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'Entry and recovery must not raise browser errors');
  });
  async function page(options = {}) {
    const context = await browser.newContext(options);
    const result = await context.newPage();
    result.on('pageerror', error => errors.push(error.message));
    return result;
  }
  async function admin(body) {
    const response = await fetch(`${base}/api/access/admin`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access.adminKey}` },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  return { base, browser, server, page, admin, advance: milliseconds => { clock += milliseconds; } };
}

async function redeem(page, code) {
  await page.getByTestId('access-code').fill(code);
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/access/redeem');
  await page.getByTestId('redeem-access').click();
  return received;
}

async function enter(page, name, roomCode) {
  await page.getByTestId('nickname').fill(name);
  if (roomCode) await page.getByTestId('room-code').fill(roomCode);
  const response = page.waitForResponse(response => response.request().method() === 'POST'
    && (new URL(response.url()).pathname === '/api/rooms' || new URL(response.url()).pathname.endsWith('/join')));
  await page.getByTestId(roomCode ? 'join-room' : 'create-room').click();
  const received = await response;
  assert.equal(received.status(), 201, await received.text());
  await page.getByTestId('room-code-display').waitFor();
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey);
}

test('unprotected entry stays familiar and creates rooms without an invitation', { timeout: 30000 }, async t => {
  const { base, page } = await fixture(t, false);
  const visitor = await page();
  await visitor.goto(base);
  await visitor.getByTestId('nickname').waitFor();
  assert.equal(await visitor.getByTestId('access-form').isVisible(), false);
  await enter(visitor, '无验证试玩');
});

test('a thirty-minute invitation admits four browsers, protects entry, and preserves occupied seats after expiry', { timeout: 90000 }, async t => {
  const { base, page, admin, advance } = await fixture(t);
  const invite = await admin({ action: 'create', maxUses: 4 });
  const people = [];
  for (let index = 0; index < 4; index++) {
    const visitor = await page(index === 1 ? { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true } : {});
    const room = people[0]?.identity.roomCode;
    await visitor.goto(`${base}/${room ? `?room=${room}${index === 3 ? '&sync=poll' : ''}` : ''}`);
    await visitor.getByTestId('access-form').waitFor();
    assert.equal(await visitor.getByTestId('create-room').isVisible(), false);
    assert.equal(await visitor.getByTestId('join-room').isVisible(), false);
    if (index === 1) {
      await mkdir('test-results', { recursive: true });
      await visitor.screenshot({ path: 'test-results/access-mobile.png', fullPage: true });
      assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.equal((await redeem(visitor, invite.code)).status(), 200);
    if (room) assert.equal(await visitor.getByTestId('room-code').inputValue(), room);
    assert.equal((await visitor.context().cookies()).some(cookie => cookie.httpOnly), true);
    const identity = await enter(visitor, `邀请玩家${index + 1}`, room);
    const clientStorage = await visitor.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, href: location.href, cookie: document.cookie }));
    assert.equal(clientStorage.includes(invite.code), false, 'The invitation must not persist in browser storage or the URL');
    assert.equal(clientStorage.includes('adminKey'), false);
    people.push({ page: visitor, identity });
  }
  const roomCode = people[0].identity.roomCode;
  const outsider = await page();
  await outsider.goto(`${base}/?room=${roomCode}`);
  await outsider.getByTestId('access-form').waitFor();
  const rejected = await outsider.evaluate(async room => {
    const result = [];
    for (const path of ['/api/rooms', `/api/rooms/${room}/join`]) {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '未受邀' }) });
      result.push({ status: response.status, body: await response.json() });
    }
    return result;
  }, roomCode);
  for (const result of rejected) {
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.body), ['error']);
  }
  assert.equal((await redeem(outsider, invite.code)).status(), 401, 'A fifth browser cannot use the invitation');
  const status = await outsider.request.get(`${base}/api/access`);
  assert.deepEqual(await status.json(), { required: true, authorized: false });

  for (const person of people) {
    await person.page.reload();
    await person.page.getByTestId('room-code-display').waitFor();
    assert.deepEqual(await person.page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), person.identity);
  }
  advance(30 * 60 * 1000);
  for (const person of people) {
    await person.page.context().clearCookies();
    const context = person.page.context();
    await person.page.close();
    person.page = await context.newPage();
    await person.page.goto(`${base}/?room=${roomCode}${person === people[3] ? '&sync=poll' : ''}`);
    await person.page.getByTestId('room-code-display').waitFor();
    assert.deepEqual(await person.page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), person.identity,
      'Closing the page and an expired invitation must preserve the original seat');
    assert.equal(await person.page.locator('#lobby-count').textContent(), '4 / 4 人入席');
    await person.page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
  }
  const readyResponse = people[0].page.waitForResponse(response => response.url().endsWith('/actions'));
  await people[0].page.getByTestId('ready-button').click();
  assert.equal((await readyResponse).status(), 200, 'An existing player can still act after entry permission expires');
  await outsider.reload();
  assert.equal((await redeem(outsider, invite.code)).status(), 401, 'An expired invitation cannot admit a new player');
  await people[0].page.locator('#leave-room').click();
  await people[0].page.getByTestId('access-form').waitFor();
  assert.equal(await people[0].page.getByTestId('create-room').isVisible(), false);

  const revoked = await admin({ action: 'create', hours: 4, maxUses: 4 });
  await admin({ action: 'revoke', id: revoked.id });
  assert.equal((await redeem(outsider, revoked.code)).status(), 401, 'A revoked invitation cannot admit a new player');
  const untrustedView = await outsider.evaluate(async room => {
    const response = await fetch(`/api/rooms/${room}`);
    return { status: response.status, body: await response.json() };
  }, roomCode);
  assert.equal(untrustedView.status, 403);
  assert.deepEqual(Object.keys(untrustedView.body), ['error'], 'An unauthenticated response contains no player or secret state');
});

test('expired entry permission returns to verification without clearing the nickname or room code', { timeout: 60000 }, async t => {
  const { base, page, admin, advance } = await fixture(t);
  const invite = await admin({ action: 'create', hours: 4, maxUses: 4 });
  const host = await page();
  await host.goto(base);
  assert.equal((await redeem(host, invite.code)).status(), 200);
  const identity = await enter(host, '原房主');
  const applicants = [];
  for (const joining of [false, true]) {
    const visitor = await page();
    await visitor.goto(`${base}/?room=${identity.roomCode}`);
    assert.equal((await redeem(visitor, invite.code)).status(), 200);
    await visitor.getByTestId('nickname').fill(joining ? '等待加入' : '等待创建');
    await visitor.getByTestId('room-code').fill(identity.roomCode);
    applicants.push({ page: visitor, joining });
  }
  advance(4 * 60 * 60 * 1000 + 1);
  for (const applicant of applicants) {
    const received = applicant.page.waitForResponse(response => response.request().method() === 'POST'
      && (new URL(response.url()).pathname === '/api/rooms' || new URL(response.url()).pathname.endsWith('/join')));
    await applicant.page.getByTestId(applicant.joining ? 'join-room' : 'create-room').click();
    assert.equal((await received).status(), 401);
    await applicant.page.getByTestId('access-form').waitFor();
    assert.equal(await applicant.page.getByTestId('room-code').inputValue(), identity.roomCode);
    assert.equal(await applicant.page.getByTestId('nickname').inputValue(), applicant.joining ? '等待加入' : '等待创建');
    const fresh = await admin({ action: 'create', hours: 4, maxUses: 4 });
    assert.equal((await redeem(applicant.page, fresh.code)).status(), 200);
    assert.equal(await applicant.page.getByTestId('room-code').inputValue(), identity.roomCode);
    await enter(applicant.page, applicant.joining ? '等待加入' : '等待创建', applicant.joining ? identity.roomCode : undefined);
  }
});

test('entry and saved-seat network failures offer a retry and retain the original identity', { timeout: 60000 }, async t => {
  const { base, page, admin } = await fixture(t);
  const invite = await admin({ action: 'create', hours: 4, maxUses: 4 });
  const visitor = await page();
  await visitor.route('**/api/access', route => route.abort());
  await visitor.goto(base);
  await visitor.getByTestId('entry-retry').waitFor();
  assert.equal(await visitor.getByTestId('create-room').isVisible(), false);
  await visitor.unroute('**/api/access');
  await visitor.getByTestId('entry-retry').click();
  await visitor.getByTestId('access-form').waitFor();
  await visitor.route('**/api/access/redeem', route => route.abort());
  await visitor.getByTestId('access-code').fill(invite.code);
  await visitor.getByTestId('redeem-access').click();
  await visitor.locator('#error-banner').waitFor();
  assert.equal(await visitor.getByTestId('access-code').inputValue(), invite.code);
  await visitor.unroute('**/api/access/redeem');
  assert.equal((await redeem(visitor, invite.code)).status(), 200);
  const identity = await enter(visitor, '重试玩家');
  await visitor.route('**/api/rooms/**', route => route.abort());
  await visitor.reload();
  await visitor.getByTestId('entry-retry').waitFor();
  assert.equal(await visitor.getByTestId('create-room').isVisible(), false);
  assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), identity);
  await visitor.unroute('**/api/rooms/**');
  await visitor.getByTestId('entry-retry').click();
  await visitor.getByTestId('room-code-display').waitFor();
  assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), identity);
  assert.equal(await visitor.locator('#lobby-count').textContent(), '1 / 4 人入席');
});

async function connected(page) {
  await page.waitForFunction(() => document.getElementById('connection-state').textContent === '已连接');
}

async function returnedToEntry(page, roomCode) {
  await page.locator('#entry-view').waitFor();
  await page.waitForFunction(({ key, code }) => !sessionStorage.getItem(key)
    && !JSON.parse(localStorage.getItem('hako.room.saved.v1'))?.rooms?.[code], { key: sessionKey, code: roomCode });
  assert.equal(await page.locator('#room-view').isVisible(), false);
  assert.equal(await page.locator('#connection-banner').isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.has('room'), false);
  assert.equal(await page.title(), '箱娃 · 旧宅入席');
}

for (const mode of ['sse', 'poll']) {
  test(`departed seats leave the reconnect screen across tabs and lost exit responses over ${mode}`, { timeout: 60000 }, async t => {
    const { base, page } = await fixture(t, false);
    const host = await page();
    await host.goto(`${base}/?sync=${mode}`);
    const hostIdentity = await enter(host, '房主');
    const visitor = await page();
    await visitor.goto(`${base}/?sync=${mode}&room=${hostIdentity.roomCode}`);
    await enter(visitor, '双标签玩家', hostIdentity.roomCode);
    const mirror = await visitor.context().newPage();
    await mirror.goto(visitor.url());
    await Promise.all([connected(host), connected(visitor), connected(mirror)]);

    await visitor.locator('#leave-room').click();
    await Promise.all([returnedToEntry(visitor, hostIdentity.roomCode), returnedToEntry(mirror, hostIdentity.roomCode)]);
    assert.match(await mirror.locator('#error-text').textContent(), /座位已失效/);
    await enter(mirror, '重新入席', hostIdentity.roomCode);
    await connected(mirror);
    await host.waitForFunction(() => document.getElementById('lobby-count').textContent === '2 / 4 人入席');

    // Complete each exit on the server, but discard its response in the browser.
    for (const departing of [mirror, host]) {
      await departing.route('**/actions', async route => {
        assert.equal(route.request().postDataJSON().type, 'leave');
        assert.equal((await route.fetch()).status(), 200, departing === host ? 'Host exit' : 'Visitor exit');
        await route.abort('failed');
      });
      await departing.locator('#leave-room').click();
      await returnedToEntry(departing, hostIdentity.roomCode);
      await departing.getByTestId('nickname').waitFor();
      assert.equal(await departing.getByTestId('create-room').isEnabled(), true);
      assert.equal(await departing.locator('#error-banner').isVisible(), false, 'A completed exit is not reported as a network failure');
      if (departing !== host) await host.waitForFunction(() => document.getElementById('lobby-count').textContent === '1 / 4 人入席');
    }
    assert.equal((await fetch(`${base}/api/rooms/${hostIdentity.roomCode}`)).status, 404, 'The last departure really deleted the room');
  });

  test(`temporary connection errors retain valid seats and resume over ${mode}`, { timeout: 60000 }, async t => {
    const { base, server, page } = await fixture(t, false);
    const visitor = await page();
    await visitor.goto(`${base}/?sync=${mode}`);
    const identity = await enter(visitor, '断线重连');
    await connected(visitor);
    const roomGet = url => url.pathname.startsWith(`/api/rooms/${identity.roomCode}`);
    for (const failure of ['network', 'unavailable']) {
      const failedRequest = visitor.waitForRequest(request => roomGet(new URL(request.url())));
      await visitor.route(roomGet, route => failure === 'network' ? route.abort('connectionfailed')
        : route.fulfill({ status: 503, json: { error: '服务暂时不可用' } }));
      server.closeAllConnections();
      await failedRequest;
      await visitor.waitForFunction(() => document.getElementById('connection-state').textContent === '重新连接中');
      assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), identity);
      assert.equal(await visitor.locator('#room-view').isVisible(), true);
      assert.equal(await visitor.getByTestId('ready-button').isEnabled(), false);
      await visitor.unroute(roomGet);
      await connected(visitor);
    }

    // A refused action can be a permission error while the identity remains valid.
    await visitor.route('**/actions', route => route.fulfill({ status: 403, json: { error: '操作权限不足' } }));
    const checked = visitor.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${identity.roomCode}`
      && !new URL(response.url()).searchParams.has('poll'));
    await visitor.getByTestId('ready-button').click();
    assert.equal((await checked).status(), 200);
    await visitor.locator('#error-banner').waitFor();
    assert.match(await visitor.locator('#error-text').textContent(), /操作权限不足/);
    assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), identity);
    assert.equal(await visitor.locator('#room-view').isVisible(), true);
    assert.equal(await visitor.locator('#lobby-count').textContent(), '1 / 4 人入席');
  });
}

test('SSE resumes after gateway errors permanently close the native EventSource', { timeout: 60000 }, async t => {
  const { base, server, page } = await fixture(t, false);
  const visitor = await page();
  await visitor.goto(base);
  const identity = await enter(visitor, '关服后重连');
  await connected(visitor);
  const events = url => url.pathname === `/api/rooms/${identity.roomCode}/events`;
  for (const status of [502, 503]) {
    let failures = 0, retried;
    const retryReceived = new Promise(resolve => { retried = resolve; });
    await visitor.route(events, async route => {
      await route.fulfill({ status, json: { error: '网关暂时不可用' } });
      if (++failures === 2) retried();
    });
    server.closeAllConnections();
    // The browser stops its own retries after the first HTTP error.
    await retryReceived;
    assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), identity);
    assert.equal(await visitor.locator('#room-view').isVisible(), true);
    assert.equal(await visitor.getByTestId('ready-button').isEnabled(), false);
    await visitor.unroute(events);
    await connected(visitor);
    assert.equal(await visitor.getByTestId('ready-button').isEnabled(), true);
    assert.equal(await visitor.locator('#lobby-count').textContent(), '1 / 4 人入席');
  }
});

for (const delayed of ['action', 'identity check']) test(`a delayed ${delayed} from a departed identity cannot replace a new room`, { timeout: 60000 }, async t => {
  const { base, page } = await fixture(t, false);
  const visitor = await page();
  await visitor.goto(base);
  const oldIdentity = await enter(visitor, '原座位');
  const mirror = await visitor.context().newPage();
  await mirror.goto(visitor.url());
  await Promise.all([connected(visitor), connected(mirror)]);
  let releaseAction, releaseCheck;
  const actionGate = new Promise(resolve => { releaseAction = resolve; });
  const checkGate = new Promise(resolve => { releaseCheck = resolve; });
  t.after(() => { releaseAction(); releaseCheck(); });
  await visitor.route('**/actions', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await actionGate;
    await route.fulfill({ response });
  });
  let checked;
  const checkStarted = new Promise(resolve => { checked = resolve; });
  const oldRoomGet = url => url.pathname === `/api/rooms/${oldIdentity.roomCode}`;
  await visitor.route(oldRoomGet, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 404);
    checked();
    await checkGate;
    await route.fulfill({ response });
  });
  const actionReturned = visitor.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/actions'));
  if (delayed === 'action') {
    await visitor.getByTestId('ready-button').click();
    // The other tab receives the new version before it exits with the same seat.
    await mirror.waitForFunction(() => document.getElementById('ready-button').textContent.includes('取消'));
    await mirror.locator('#leave-room').click();
  } else await visitor.locator('#leave-room').click();
  await returnedToEntry(mirror, oldIdentity.roomCode);
  await checkStarted;
  if (delayed === 'action') releaseCheck();
  else { releaseAction(); await actionReturned; }
  await returnedToEntry(visitor, oldIdentity.roomCode);
  const fresh = await enter(visitor, '新房主');
  await connected(visitor);
  const delayedReturned = delayed === 'action' ? actionReturned : visitor.waitForResponse(response => oldRoomGet(new URL(response.url())));
  if (delayed === 'action') releaseAction();
  else releaseCheck();
  await delayedReturned;
  // A round trip through the new connection lets any old response handler finish.
  await visitor.getByTestId('ready-button').click();
  await visitor.waitForFunction(() => document.getElementById('ready-button').textContent.includes('取消'));
  assert.notEqual(fresh.roomCode, oldIdentity.roomCode);
  assert.deepEqual(await visitor.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey), fresh);
  assert.equal(await visitor.getByTestId('room-code-display').textContent(), fresh.roomCode);
});
