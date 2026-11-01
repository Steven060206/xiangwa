import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Shared by the server and local tools, regardless of the caller's working directory. */
export function loadConfig() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更新版本：https://nodejs.org/');
  try { process.loadEnvFile(resolve(projectRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取 .env：${error.message}`); }
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || process.env.PORT?.trim() === '') {
    throw new Error('PORT 必须为 0 至 65535 的整数；日常运行请使用 1 至 65535。');
  }
  const host = process.env.HOST?.trim() ?? '0.0.0.0';
  if (!host) throw new Error('HOST 不能为空。');
  const cookieSecure = process.env.COOKIE_SECURE ?? 'auto';
  if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('COOKIE_SECURE 必须为 auto、true 或 false。');
  const dataDirectory = resolve(projectRoot, process.env.DATA_DIR || 'data');
  const accessDirectory = resolve(projectRoot, process.env.ACCESS_DIR || dataDirectory);
  return { port, host, dataDirectory, accessDirectory, cookieSecure };
}
