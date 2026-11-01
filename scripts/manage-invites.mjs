import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../src/config.mjs';

try {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数。`);
    return args[index + 1];
  };
  const port = Number(option('--port', config.port));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效。');
  const directory = resolve(option('--directory', config.accessDirectory));
  const { adminKey } = JSON.parse(readFileSync(join(directory, 'access.json'), 'utf8'));
  if (typeof adminKey !== 'string' || adminKey.length < 40) throw new Error('管理密钥无效。');
  const id = option('--revoke');
  const input = args.includes('--list') ? { action: 'list' } : id ? { action: 'revoke', id }
    : { action: 'create', hours: Number(option('--hours', '0.5')), maxUses: Number(option('--uses', '5')) };
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/api/access/admin`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '邀请码管理失败。');
  if (args.includes('--json') || !result.code) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`邀请码：${result.code}\n有效期至：${new Date(result.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n最多验证 ${result.maxUses} 个浏览器（含你自己）。\n`);
} catch (error) {
  process.stderr.write(`邀请码操作失败：${error.code === 'ENOENT' ? '请先启动游戏（npm start 或双击“启动游戏.cmd”），再发放邀请码。' : error.message}\n`);
  process.exitCode = 1;
}
