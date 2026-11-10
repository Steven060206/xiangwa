import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { createGameServer } from '../src/server.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2);
let server, tunnel, input, stopping = false;
const abort = new AbortController();

async function stop() {
  if (stopping) return;
  stopping = true;
  abort.abort();
  input?.close();
  process.stdin.unref?.();
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    const closed = once(tunnel, 'close');
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(tunnel.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else tunnel.kill('SIGTERM');
    await closed;
  }
  if (server) await new Promise(resolve => server.close(resolve));
}

async function openWhenReady(url, runtimeId) {
  if (args.includes('--no-browser')) return;
  for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
      if (response.ok && (await response.json()).runtimeId === runtimeId) {
        const [command, parameters] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
          : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        await execute(command, parameters, { windowsHide: true });
        return;
      }
    } catch { /* The tunnel may print its URL before it can serve the game. */ }
    await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
  }
  if (!stopping) console.log(`未能自动打开网页。连接就绪后，请手动打开：${url}`);
}

try {
  if (args.some(arg => !['--local', '--no-browser'].includes(arg))) throw new Error('用法：一键启动.cmd [-LocalOnly] [-NoBrowser]');
  const config = loadConfig();
  const runtimeId = randomUUID();
  server = createGameServer({ dataFile: join(config.dataDirectory, 'rooms.json'),
    accessDirectory: config.accessDirectory, cookieSecure: config.cookieSecure, runtimeId });
  server.listen(config.port, config.host);
  await once(server, 'listening');
  const port = server.address().port;
  const host = ['0.0.0.0', '::'].includes(config.host) ? (config.host === '::' ? '::1' : '127.0.0.1') : config.host;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const { adminKey } = JSON.parse(await readFile(join(config.accessDirectory, 'access.json'), 'utf8'));
  async function invite() {
    const response = await fetch(`${base}/api/access/admin`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` },
      body: JSON.stringify({ action: 'create', hours: 0.5, maxUses: 5 }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '发码失败');
    console.log(`\n邀请码：${result.code}\n有效30分钟，最多5个浏览器（含自己）。`);
  }
  console.log(`《箱娃》已启动\n本机地址：${base}\n自动存档：${config.dataDirectory}`);
  if (['0.0.0.0', '::'].includes(config.host)) for (const address of Object.values(networkInterfaces()).flat()) {
    if (address.family === 'IPv4' && !address.internal) console.log(`局域网地址：http://${address.address}:${port}`);
  }
  await invite();
  if (args.includes('--local')) void openWhenReady(base, runtimeId);
  else {
    console.log('\n正在建立远程联机。请等待公网网址，并让房主和朋友从同一个公网网址进入。');
    tunnel = spawn(process.execPath, [fileURLToPath(new URL('./share-online.mjs', import.meta.url))],
      { windowsHide: true, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', found = false;
    const forward = chunk => {
      process.stdout.write(chunk);
      buffer = (buffer + chunk.toString('utf8')).slice(-8192);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(buffer)?.[0];
      if (url && !found) {
        found = true;
        console.log(`\n联机网址：${url}\n把此网址和邀请码发给朋友。请保持此窗口开启。`);
        void openWhenReady(url, runtimeId);
      }
    };
    tunnel.stdout.on('data', forward);
    tunnel.stderr.on('data', forward);
    tunnel.on('error', error => console.error(`远程联机失败：${error.message}`));
    tunnel.on('close', () => {
      if (!stopping) console.log(`远程联机已停止。本机和局域网游戏仍可使用。需要远程联机时退出后重试。`);
    });
  }
  input = createInterface({ input: process.stdin });
  input.on('line', line => {
    if (line.trim().toLowerCase() === 'i' && !stopping) void invite().catch(error => console.error(error.message));
    if (line.trim().toLowerCase() === 'q') void stop();
  });
  console.log('\n输入 I 并回车：发放新邀请码。输入 Q 并回车，或按 Ctrl+C：结束联机。');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(`一键启动失败：${error.code === 'EADDRINUSE' ? '端口已占用，请关闭之前的游戏窗口，或在 .env 中修改 PORT。' : error.message}`);
  process.exitCode = 1;
  await stop();
}
