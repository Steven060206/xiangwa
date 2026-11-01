import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createGameServer } from '../src/server.mjs';
import { createAccessControl } from '../src/access.mjs';

const lanAddress = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4'
  && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))?.address;

test('a phone browser on a real LAN HTTP address can redeem, create a five-player room and recover it',
  { skip: !lanAddress, timeout: 45000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'xiangwa-self-host-browser-'));
    const access = createAccessControl({ directory });
    const server = createGameServer({ accessDirectory: directory });
    server.listen(0, '0.0.0.0');
    await once(server, 'listening');
    const base = `http://${lanAddress}:${server.address().port}`;
    const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'],
      ...(existsSync(chromePath) ? { executablePath: chromePath } : {}) });
    t.after(async () => {
      await browser.close();
      await new Promise(resolveClose => server.close(resolveClose));
      await rm(directory, { recursive: true, force: true });
    });
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const issue = await fetch(`${base}/api/access/admin`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access.adminKey}` },
      body: JSON.stringify({ action: 'create' }) });
    assert.equal(issue.status, 200);
    const invite = await issue.json();
    await page.goto(base);
    await page.getByTestId('access-code').fill(invite.code);
    await page.getByTestId('redeem-access').click();
    await page.getByTestId('nickname').waitFor();
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie => cookie.name === 'xiangwa_access' && !cookie.secure && cookie.httpOnly));
    await page.getByTestId('nickname').fill('局域网手机');
    await page.getByTestId('player-count').selectOption('5');
    await page.getByTestId('create-room').click();
    await page.getByTestId('room-code-display').waitFor();
    const roomCode = await page.getByTestId('room-code-display').textContent();
    await page.reload();
    await page.getByTestId('room-code-display').waitFor();
    assert.equal(await page.getByTestId('room-code-display').textContent(), roomCode);
    assert.equal(await page.getByTestId('access-form').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  });
