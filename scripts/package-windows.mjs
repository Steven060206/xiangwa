import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let revision = 'HEAD', output = resolve(root, 'dist/xiangwa-windows.zip');
for (let index = 0; index < args.length; index += 2) {
  if (!['--revision', '--output'].includes(args[index]) || !args[index + 1]) throw new Error('用法：node scripts/package-windows.mjs [--revision COMMIT] [--output ZIP]');
  if (args[index] === '--revision') revision = args[index + 1];
  else output = resolve(args[index + 1]);
}
const tree = execFileSync('git', ['rev-parse', '--verify', `${revision}^{tree}`], { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(dirname(output), { recursive: true });
// Only committed program files enter the package, even when local saves or credentials exist.
execFileSync('git', ['archive', '--format=zip', '--prefix=xiangwa-windows/', '--output', output, tree,
  'server.mjs', 'package.json', '.env.example', 'LICENSE', 'NOTICE.md', '一键启动.cmd', '一键版说明.txt',
  'src', 'public', 'scripts/one-click.ps1', 'scripts/one-click.mjs', 'scripts/share-online.mjs', 'scripts/share-online.ps1'], { cwd: root });
console.log(`Windows 一键版已生成：${output}`);
