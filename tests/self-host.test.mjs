import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xiangwa-self-host-'));
  const root = join(directory, '独立部署 有空格');
  const elsewhere = join(directory, '其他工作目录');
  await mkdir(root);
  await mkdir(elsewhere);
  for (const name of ['server.mjs', 'src', 'public', 'scripts', 'package.json', '.env.example', '启动游戏.cmd', '发放邀请码.cmd']) {
    await cp(join(source, name), join(root, name), { recursive: true });
  }
  const env = { ...process.env };
  for (const key of ['PORT', 'HOST', 'DATA_DIR', 'ACCESS_DIR', 'COOKIE_SECURE', 'XIANGWA_RUNTIME_ID']) delete env[key];
  const children = [];
  function run(args, extra = {}, command = process.execPath) {
    const child = spawn(command, args, { cwd: elsewhere, env: { ...env, ...extra }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const finished = once(child, 'close').then(([code]) => ({ code, output }));
    return { child, finished, get output() { return output; } };
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  async function boot(extra) {
    const running = run([join(root, 'server.mjs')], extra);
    let timer;
    const base = await new Promise((resolveBase, reject) => {
      timer = setTimeout(() => reject(new Error(`Standalone startup timeout: ${running.output}`)), 10000);
      running.child.stdout.on('data', () => {
        const match = /http:\/\/localhost:(\d+)/.exec(running.output);
        if (match) resolveBase(`http://127.0.0.1:${match[1]}`);
      });
      running.child.once('error', reject);
      running.child.once('exit', () => reject(new Error(running.output)));
    }).finally(() => clearTimeout(timer));
    return { ...running, base };
  }
  const config = async extra => {
    const script = `import {loadConfig} from ${JSON.stringify(pathToFileURL(join(root, 'src/config.mjs')).href)}; console.log(JSON.stringify(loadConfig()));`;
    const result = await run(['--input-type=module', '-e', script], extra).finished;
    assert.equal(result.code, 0, result.output);
    return JSON.parse(result.output.trim());
  };
  return { root, elsewhere, run, stop, boot, config };
}

async function availablePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

test('fresh download defaults need no packages, personal credentials or working-directory assumptions', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const config = await f.config();
  assert.deepEqual(config, { port: 4173, host: '0.0.0.0', dataDirectory: join(f.root, 'data'),
    accessDirectory: join(f.root, 'data'), cookieSecure: 'auto' });
  await assert.rejects(readFile(join(f.root, 'node_modules/package.json')), { code: 'ENOENT' });
  const live = await f.boot({ HOST: '127.0.0.1', PORT: '0' });
  assert.equal((await fetch(`${live.base}/api/health`)).status, 200);
  assert.match(await (await fetch(live.base)).text(), /箱娃/);
  for (const path of ['/app.js', '/shared/maps.mjs', '/style.css']) {
    assert.equal((await fetch(`${live.base}${path}`)).status, 200);
  }
  assert.equal((await fetch(`${live.base}/api/access`)).status, 200);
  assert.equal((await fetch(`${live.base}/data/access.json`)).status, 404);
  await readFile(join(f.root, 'data/access.json'));
  await assert.rejects(readFile(join(f.elsewhere, 'data/access.json')), { code: 'ENOENT' });
});

test('env file, server and invitation CLI agree on custom settings, and a saved five-player room survives restart', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const port = await availablePort();
  await writeFile(join(f.root, '.env'), `HOST=127.0.0.1\nPORT=${port}\nDATA_DIR="我的存档"\nACCESS_DIR="私有验证"\nCOOKIE_SECURE=auto\n`);
  const live = await f.boot();
  const cli = await f.run([join(f.root, 'scripts/manage-invites.mjs'), '--json']).finished;
  assert.equal(cli.code, 0, cli.output);
  const invite = JSON.parse(cli.output);
  assert.equal(invite.maxUses, 5);
  assert.ok(invite.expiresAt > Date.now() + 29 * 60 * 1000);
  assert.ok(invite.expiresAt <= Date.now() + 30 * 60 * 1000);
  const admitted = await fetch(`${live.base}/api/access/redeem`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invite.code }) });
  assert.equal(admitted.status, 200);
  const cookie = admitted.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${live.base}/api/rooms`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '自己部署', playerCount: 5 }) });
  assert.equal(response.status, 201);
  const person = await response.json();
  assert.equal(person.state.playerCount, 5);
  await readFile(join(f.root, '我的存档/rooms.json'));
  await readFile(join(f.root, '私有验证/access.json'));
  await assert.rejects(readFile(join(f.root, 'data/access.json')), { code: 'ENOENT' });
  if (process.platform === 'win32') {
    const windowsInvite = await f.run(['/d', '/c', join(f.root, '发放邀请码.cmd')], {}, 'cmd.exe').finished;
    assert.equal(windowsInvite.code, 0, windowsInvite.output);
    assert.match(windowsInvite.output, /[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}/);
  }
  await f.stop(live.child);
  const restarted = await f.boot();
  const recovered = await fetch(`${restarted.base}/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).playerCount, 5);
});

test('shell variables override env files and ACCESS_DIR follows DATA_DIR when omitted', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), 'PORT=4180\nHOST=127.0.0.1\nDATA_DIR="文件存档"\nCOOKIE_SECURE=false\n');
  const configured = await f.config({ PORT: '4181', DATA_DIR: '环境存档', COOKIE_SECURE: 'true' });
  assert.equal(configured.port, 4181);
  assert.equal(configured.dataDirectory, join(f.root, '环境存档'));
  assert.equal(configured.accessDirectory, configured.dataDirectory);
  assert.equal(configured.cookieSecure, 'true');
});

test('invalid deployment settings fail clearly before creating access records', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const setting of ['PORT=wrong', 'PORT=65536', 'PORT=', 'HOST=', 'COOKIE_SECURE=maybe']) {
    await writeFile(join(f.root, '.env'), `${setting}\n`);
    const result = await f.run([join(f.root, 'server.mjs')]).finished;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /服务启动失败/);
    await assert.rejects(readFile(join(f.root, 'data/access.json')), { code: 'ENOENT' });
  }
});

test('Windows start launcher reads its own config from a different working directory', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), 'PORT=invalid\n');
  const result = await f.run(['/d', '/c', join(f.root, '启动游戏.cmd')], {}, 'cmd.exe').finished;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /PORT 必须/);
});
