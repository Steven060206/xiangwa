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
  return { base, browser, page, admin, advance: milliseconds => { clock += milliseconds; } };
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

test('one invitation admits four browsers, protects entry, and preserves occupied seats after expiry', { timeout: 90000 }, async t => {
  const { base, page, admin, advance } = await fixture(t);
  const invite = await admin({ action: 'create', hours: 4, maxUses: 4 });
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
  advance(4 * 60 * 60 * 1000 + 1);
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
