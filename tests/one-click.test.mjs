import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const options = { timeout: 30000 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xiangwa-one-click-'));
  const root = join(directory, '中文 解压目录');
  await mkdir(root);
  for (const name of ['src', 'public', 'server.mjs', 'package.json', '.env.example', '一键启动.cmd']) {
    await cp(join(source, name), join(root, name), { recursive: true });
  }
  await mkdir(join(root, 'scripts'));
  for (const name of ['one-click.mjs', 'one-click.ps1', 'share-online.mjs', 'share-online.ps1']) {
    await cp(join(source, 'scripts', name), join(root, 'scripts', name));
  }
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.stdin.write('q\n');
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, 8000);
    try { await closed; } finally { clearTimeout(timer); }
    assert.equal(forced, false, 'Q must stop the launcher without forced termination');
  }
  function run({ args = ['--local', '--no-browser'], env = {}, command = process.execPath, commandArgs } = {}) {
    const clean = { ...process.env };
    for (const key of ['PORT', 'HOST', 'DATA_DIR', 'ACCESS_DIR', 'COOKIE_SECURE', 'CLOUDFLARED_BIN']) delete clean[key];
    const child = spawn(command, commandArgs ?? [join(root, 'scripts/one-click.mjs'), ...args], {
      cwd: directory, windowsHide: true, env: { ...clean, PORT: '0', HOST: '127.0.0.1', DATA_DIR: join(root, '自己的存档'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', data => { output += data.toString('utf8'); });
    child.stderr.on('data', data => { output += data.toString('utf8'); });
    const finished = once(child, 'close').then(([code]) => ({ code, output }));
    async function waitFor(pattern) {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (pattern.test(output)) return output;
        if (child.exitCode !== null) break;
        await delay(100);
      }
      assert.fail(`Launcher did not reach ${pattern}: ${output}`);
    }
    return { child, finished, waitFor, get output() { return output; } };
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { root, directory, run, stop };
}

test('one click issues a usable thirty-minute five-browser invite and preserves a five-player save across restart', options, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), 'PORT=0\nHOST=127.0.0.1\nDATA_DIR="自己的存档"\nACCESS_DIR="自己的许可"\n');
  const live = f.run();
  await live.waitFor(/输入 I/);
  const base = /本机地址：(http:\/\/[^\s]+)/.exec(live.output)[1];
  const code = /邀请码：([^\s]+)/.exec(live.output)[1];
  const access = JSON.parse(await readFile(join(f.root, '自己的许可/access.json'), 'utf8'));
  assert.equal(access.invites[0].maxUses, 5);
  assert.ok(access.invites[0].expiresAt > Date.now() + 29 * 60 * 1000);
  assert.ok(access.invites[0].expiresAt <= Date.now() + 30 * 60 * 1000);
  assert.ok(!live.output.includes(access.adminKey));
  const admitted = await fetch(`${base}/api/access/redeem`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(admitted.status, 200);
  const cookie = admitted.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '一键房主', playerCount: 5 }) });
  assert.equal(created.status, 201);
  const person = await created.json();
  live.child.stdin.write('i\n');
  await live.waitFor(new RegExp(`邀请码：${code}[\\s\\S]*邀请码：`));
  await f.stop(live.child);
  assert.equal((await live.finished).code, 0);
  await assert.rejects(fetch(`${base}/api/health`));
  const again = f.run();
  await again.waitFor(/输入 I/);
  const restarted = /本机地址：(http:\/\/[^\s]+)/.exec(again.output)[1];
  const recovered = await fetch(`${restarted}/api/rooms/${person.roomCode}?${new URLSearchParams({ playerId: person.playerId, token: person.token })}`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).playerCount, 5);
  await assert.rejects(readFile(join(f.directory, 'data/access.json')), { code: 'ENOENT' });
});

test('one click rejects invalid settings and an occupied port without stopping the existing listener', options, async t => {
  const f = await fixture(t);
  const server = http.createServer((request, response) => response.end('another service'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const port = server.address().port;
  const busy = await f.run({ env: { PORT: String(port) } }).finished;
  assert.equal(busy.code, 1, busy.output);
  assert.match(busy.output, /端口已占用/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'another service');
  const invalid = await f.run({ env: { PORT: 'invalid' } }).finished;
  assert.equal(invalid.code, 1, invalid.output);
  assert.match(invalid.output, /PORT 必须/);
});

test('Windows double click reuses cached portable Node without Node on PATH or admin installation',
  { ...options, skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const cache = join(f.directory, '应用缓存');
    await mkdir(join(cache, 'XiangWa/node'), { recursive: true });
    await cp(process.execPath, join(cache, 'XiangWa/node/node.exe'));
    const windows = process.env.SystemRoot;
    const live = f.run({ command: join(windows, 'System32/cmd.exe'),
      commandArgs: ['/d', '/c', join(f.root, '一键启动.cmd'), '-LocalOnly', '-NoBrowser'],
      env: { PATH: `${windows}\\System32;${windows}\\System32\\WindowsPowerShell\\v1.0`, LOCALAPPDATA: cache } });
    await live.waitFor(/输入 I/);
    assert.doesNotMatch(live.output, /Downloading/);
    await f.stop(live.child);
    assert.equal((await live.finished).code, 0, live.output);
  });

test('Windows one click shares the actual chosen port and Q stops its entire tunnel process tree',
  { ...options, skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const fake = join(f.directory, 'fake cloudflared.cjs');
    const binary = join(f.directory, 'fake cloudflared.cmd');
    const record = join(f.directory, 'tunnel.json');
    await writeFile(fake, `require('node:fs').writeFileSync(process.env.FAKE_RECORD, JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
console.log('https://example.trycloudflare.com');setInterval(()=>{},1000);`);
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    const live = f.run({ args: ['--no-browser'], env: { CLOUDFLARED_BIN: binary, FAKE_RECORD: record } });
    await live.waitFor(/联机网址：https:\/\/example\.trycloudflare\.com/);
    const data = JSON.parse(await readFile(record, 'utf8'));
    const base = /本机地址：(http:\/\/[^\s]+)/.exec(live.output)[1];
    assert.equal(data.args[data.args.indexOf('--url') + 1], base);
    assert.equal(await readFile(data.args[data.args.indexOf('--config') + 1], 'utf8').then(s => s.trim()), '{}');
    await f.stop(live.child);
    assert.equal((await live.finished).code, 0, live.output);
    assert.throws(() => process.kill(data.pid, 0), { code: 'ESRCH' });
  });

test('failed remote sharing keeps the local game running and still permits a clean Q exit', options, async t => {
  const f = await fixture(t);
  const live = f.run({ args: ['--no-browser'], env: { CLOUDFLARED_BIN: join(f.directory, 'missing-tunnel.exe') } });
  await live.waitFor(/远程联机已停止/);
  const base = /本机地址：(http:\/\/[^\s]+)/.exec(live.output)[1];
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  await f.stop(live.child);
  assert.equal((await live.finished).code, 0, live.output);
});

test('Windows package includes the launchers and runtime but excludes photos, saves, secrets and developer files',
  { ...options, skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'xiangwa-package-'));
    t.after(async () => {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    });
    const tree = execFileSync('git', ['write-tree'], { cwd: source, encoding: 'utf8' }).trim();
    const output = join(directory, '一键版.zip');
    execFileSync(process.execPath, [join(source, 'scripts/package-windows.mjs'), '--revision', tree, '--output', output], { cwd: directory });
    const command = `[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:XIANGWA_TEST_ZIP); try { ConvertTo-Json -Compress -InputObject @($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() }`;
    const files = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', command],
      { encoding: 'utf8', env: { ...process.env, XIANGWA_TEST_ZIP: output } }));
    for (const name of ['一键启动.cmd', '一键版说明.txt', 'server.mjs', 'scripts/one-click.ps1', 'scripts/one-click.mjs', 'src/server.mjs', 'public/index.html', 'LICENSE', 'NOTICE.md']) {
      assert.ok(files.includes(`xiangwa-windows/${name}`), name);
    }
    for (const file of files) assert.doesNotMatch(file, /\/(data|references|tests|node_modules|test-results|private|config|\.git)\/|\/\.env$|\.(key|pem|log)$/i, file);
  });
