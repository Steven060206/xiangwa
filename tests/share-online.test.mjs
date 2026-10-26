import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/share-online.ps1', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32', timeout: 20000 };

async function fixture(t, health = { ok: true }) {
  const directory = await mkdtemp(join(tmpdir(), 'hako-share-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(health));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const marker = join(directory, 'arguments.json');
  const fake = join(directory, 'fake.mjs');
  const binary = join(directory, 'fake cloudflared.cmd');
  await writeFile(fake, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args,
  config: readFileSync(args[args.indexOf('--config') + 1], 'utf8') }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  await writeFile(binary, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function run(extraEnv = {}) {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      script, '-Port', String(server.address().port)], {
      windowsHide: true,
      env: { ...process.env, CLOUDFLARED_BIN: binary, FAKE_RECORD: marker, FAKE_EXIT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, signal] = await once(child, 'close');
      assert.equal(signal, null, output);
      return { code, output };
    } finally { clearTimeout(timer); }
  }
  return { run, marker, binary, calls, port: server.address().port };
}

test('sharing checks the running service and starts the supplied tunnel in the foreground', windowsOnly, async t => {
  const shared = await fixture(t);
  const result = await shared.run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(shared.calls, ['/api/health']);
  const { args, config } = JSON.parse(await readFile(shared.marker, 'utf8'));
  assert.deepEqual(args, ['tunnel', '--config', args[2], '--no-autoupdate', '--protocol', 'http2',
    '--url', `http://127.0.0.1:${shared.port}`]);
  assert.equal(config.trim(), '{}');
  await assert.rejects(readFile(args[2]), { code: 'ENOENT' });
  assert.match(result.output, /Polling sync is selected automatically/);
  assert.match(result.output, /Ctrl\+C/);
});

test('sharing preserves the tunnel process exit code', windowsOnly, async t => {
  const shared = await fixture(t);
  const result = await shared.run({ FAKE_EXIT: '23' });
  assert.equal(result.code, 23, result.output);
  const { args } = JSON.parse(await readFile(shared.marker, 'utf8'));
  await assert.rejects(readFile(args[2]), { code: 'ENOENT' });
});

test('an unhealthy service prevents starting the tunnel', windowsOnly, async t => {
  const shared = await fixture(t, { ok: false });
  const result = await shared.run();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Game service is not ready/);
  await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
});

test('an invalid explicit cloudflared path fails without falling back to a download', windowsOnly, async t => {
  const shared = await fixture(t);
  const result = await shared.run({ CLOUDFLARED_BIN: `${shared.binary}.missing` });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /CLOUDFLARED_BIN does not point to a file/);
  await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
});
