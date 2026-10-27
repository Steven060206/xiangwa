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
const fixedScript = fileURLToPath(new URL('../scripts/share-fixed.ps1', import.meta.url));
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
  const entryFile = join(directory, 'fixed entry.json');
  const credentialsFile = join(directory, 'tunnel credentials.json');
  const entry = { hostname: 'game.example.com', tunnelId: '12345678-1234-1234-1234-123456789abc', credentialsFile };
  await writeFile(credentialsFile, '{}');
  await writeFile(entryFile, JSON.stringify(entry));
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
  async function run(extraEnv = {}, fixed = false) {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fixed ? fixedScript : script, '-Port', String(server.address().port), ...(fixed ? ['-EntryFile', entryFile] : [])], {
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
  return { run, marker, binary, calls, entryFile, entry, port: server.address().port };
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

test('fixed sharing uses a named tunnel and maps only the fixed hostname to the checked service', windowsOnly, async t => {
  const shared = await fixture(t);
  const result = await shared.run({}, true);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(shared.calls, ['/api/health']);
  const { args, config } = JSON.parse(await readFile(shared.marker, 'utf8'));
  assert.deepEqual(args, ['tunnel', '--config', args[2], '--no-autoupdate', '--protocol', 'http2', 'run']);
  assert.deepEqual(JSON.parse(config), {
    tunnel: shared.entry.tunnelId,
    'credentials-file': shared.entry.credentialsFile,
    ingress: [{ hostname: shared.entry.hostname, service: `http://127.0.0.1:${shared.port}` }, { service: 'http_status:404' }],
  });
  assert.deepEqual(JSON.parse(await readFile(shared.entryFile, 'utf8')), shared.entry);
  assert.equal(await readFile(shared.entry.credentialsFile, 'utf8'), '{}');
  await assert.rejects(readFile(args[2]), { code: 'ENOENT' });
  assert.match(result.output, /https:\/\/game\.example\.com/);
});

test('fixed sharing preserves the exit code and removes only its temporary configuration', windowsOnly, async t => {
  const shared = await fixture(t);
  const result = await shared.run({ FAKE_EXIT: '23' }, true);
  assert.equal(result.code, 23, result.output);
  const { args } = JSON.parse(await readFile(shared.marker, 'utf8'));
  await assert.rejects(readFile(args[2]), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(shared.entryFile, 'utf8')), shared.entry);
});

test('fixed sharing rejects an unhealthy game service', windowsOnly, async t => {
  const shared = await fixture(t, { ok: false });
  const result = await shared.run({}, true);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Game service is not ready/);
  await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
});

test('fixed sharing rejects missing setup or missing tunnel credentials', windowsOnly, async t => {
  const shared = await fixture(t);
  await rm(shared.entryFile);
  let result = await shared.run({}, true);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Fixed entry is not configured/);
  await writeFile(shared.entryFile, JSON.stringify(shared.entry));
  await rm(shared.entry.credentialsFile);
  result = await shared.run({}, true);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /credentials file is missing/);
  await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
});

test('fixed sharing rejects invalid hostname and invalid explicit binary paths', windowsOnly, async t => {
  const shared = await fixture(t);
  await writeFile(shared.entryFile, JSON.stringify({ ...shared.entry, hostname: '*.example.com' }));
  let result = await shared.run({}, true);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /hostname is invalid/);
  await writeFile(shared.entryFile, JSON.stringify(shared.entry));
  result = await shared.run({ CLOUDFLARED_BIN: `${shared.binary}.missing` }, true);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /cloudflared was not found/);
  await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
});
