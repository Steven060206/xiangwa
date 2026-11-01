import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const windowsScript = fileURLToPath(new URL('./share-online.ps1', import.meta.url));

function run(command, args, signals = ['SIGINT', 'SIGTERM']) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    const handlers = signals.map(signal => () => child.kill(signal));
    signals.forEach((signal, index) => process.on(signal, handlers[index]));
    const cleanup = () => signals.forEach((signal, index) => process.off(signal, handlers[index]));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolveResult(code ?? (128 + (constants.signals[signal] ?? 1)));
    });
  });
}

export async function shareOnline({ platform = process.platform, args = process.argv.slice(2) } = {}) {
  const config = loadConfig();
  let port = config.port;
  if (args.length) {
    if (args.length !== 2 || !['--port', '-Port'].includes(args[0])) {
      throw new Error('用法：npm run share -- --port 4173（也可在 .env 中设置 PORT）。');
    }
    port = Number(args[1]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('联机端口必须是 1—65535 的整数。');
  const gameHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;

  if (platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsScript,
      '-Port', String(port), '-GameHost', gameHost], []);
  }

  const baseUrl = `http://${gameHost.includes(':') ? `[${gameHost}]` : gameHost}:${port}`;
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('服务未就绪');
  } catch {
    throw new Error(`无法连接 ${baseUrl} 的游戏服务。请先运行 npm start，再启动远程联机。`);
  }

  const directory = await mkdtemp(join(tmpdir(), 'xiangwa-share-'));
  try {
    const configFile = join(directory, 'config.yml');
    await writeFile(configFile, '{}\n');
    process.stdout.write(`正在分享 ${baseUrl}。保留此窗口，按 Ctrl+C 停止分享。\n打开下方的 https://…trycloudflare.com 地址；网页会自动使用轮询同步。\n`);
    const binary = process.env.CLOUDFLARED_BIN || 'cloudflared';
    try {
      return await run(binary, ['tunnel', '--config', configFile, '--no-autoupdate', '--protocol', 'http2', '--url', baseUrl]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('找不到 cloudflared。请先按 https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ 安装，或在 .env 中把 CLOUDFLARED_BIN 设为可执行文件的完整路径。');
      }
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await shareOnline(); }
  catch (error) {
    process.stderr.write(`远程联机失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
