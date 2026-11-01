import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('../scripts/share-online.mjs', import.meta.url);
const script = fileURLToPath(scriptUrl);
const options = { timeout: 20000 };

async function fixture(t, { health = { ok: true }, status = 200, listenHost = '127.0.0.1' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), '箱娃 portable share '));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(health));
  });
  server.listen(0, listenHost);
  await once(server, 'listening');
  const port = server.address().port;
  const marker = join(directory, 'arguments.json');
  const runner = join(directory, 'run.mjs');
  const fake = join(directory, 'fake.cjs');
  const binary = join(directory, 'fake cloudflared.cmd');
  await writeFile(runner, `import { shareOnline } from ${JSON.stringify(scriptUrl.href)};
try { process.exitCode = await shareOnline({ platform: 'linux' }); }
catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }
`);
  await writeFile(fake, `const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.argv[1].endsWith('tunnel')) args.unshift('tunnel');
const configFile = args[args.indexOf('--config') + 1];
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, config: readFileSync(configFile, 'utf8') }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  await writeFile(join(directory, 'tunnel'), "require('./fake.cjs');\n");
  await writeFile(binary, `@echo off\r\nchcp 65001 >nul\r\n"${process.execPath}" "${fake}" %*\r\n`);
  t.after(async () => {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  });
  async function run({ env = {}, args = [], native = false } = {}) {
    const child = spawn(process.execPath, [native ? script : runner, ...args], {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', COOKIE_SECURE: 'auto',
        DATA_DIR: directory, ACCESS_DIR: directory, CLOUDFLARED_BIN: process.execPath,
        TEMP: directory, TMP: directory, TMPDIR: directory,
        FAKE_RECORD: marker, FAKE_EXIT: '0', ...env },
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
  return { run, marker, binary, directory, calls, port,
    baseUrl: `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${port}` };
}

async function assertTunnel(shared) {
  const { args, config } = JSON.parse(await readFile(shared.marker, 'utf8'));
  assert.deepEqual(args, ['tunnel', '--config', args[2], '--no-autoupdate', '--protocol', 'http2',
    '--url', shared.baseUrl]);
  assert.equal(config.trim(), '{}');
  await assert.rejects(readFile(args[2]), { code: 'ENOENT' });
}

test('portable POSIX sharing checks health and uses an empty temporary config from a foreign Chinese path', options, async t => {
  const shared = await fixture(t);
  const result = await shared.run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(shared.calls, ['/api/health']);
  await assertTunnel(shared);
  assert.match(result.output, /Ctrl\+C/);
  assert.match(result.output, /trycloudflare\.com/);
});

test('portable sharing preserves the tunnel exit code and removes its temporary config after failure', options, async t => {
  const shared = await fixture(t);
  const result = await shared.run({ env: { FAKE_EXIT: '23' } });
  assert.equal(result.code, 23, result.output);
  await assertTunnel(shared);
});

test('portable POSIX sharing respects a custom listening host', options, async t => {
  const shared = await fixture(t, { listenHost: '127.0.0.2' });
  const result = await shared.run({ env: { HOST: '127.0.0.2' } });
  assert.equal(result.code, 0, result.output);
  await assertTunnel(shared);
});

test('portable sharing refuses unhealthy JSON and HTTP errors before starting cloudflared', options, async t => {
  for (const setup of [{ health: { ok: false } }, { status: 503 }]) {
    await t.test(JSON.stringify(setup), async subtest => {
      const shared = await fixture(subtest, setup);
      const result = await shared.run();
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /请先运行 npm start/);
      assert.deepEqual(shared.calls, ['/api/health']);
      await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
    });
  }
});

test('portable sharing supports --port and historical -Port overrides of the configured port', options, async t => {
  for (const flag of ['--port', '-Port']) {
    await t.test(flag, async subtest => {
      const shared = await fixture(subtest);
      const result = await shared.run({ env: { PORT: '0' }, args: [flag, String(shared.port)] });
      assert.equal(result.code, 0, result.output);
      await assertTunnel(shared);
    });
  }
});

test('sharing rejects a zero configured port and invalid explicit ports without contacting any service', options, async t => {
  const cases = [{ env: { PORT: '0' } }, ...['0', '65536', '1.5', 'invalid'].map(port => ({ args: ['--port', port] }))];
  for (const setup of cases) {
    await t.test(JSON.stringify(setup), async subtest => {
      const shared = await fixture(subtest);
      const result = await shared.run(setup);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /1—65535/);
      assert.deepEqual(shared.calls, []);
      await assert.rejects(readFile(shared.marker), { code: 'ENOENT' });
    });
  }
});

test('a missing cloudflared binary reports installation instructions and cleans temporary files', options, async t => {
  const shared = await fixture(t);
  const result = await shared.run({ env: { CLOUDFLARED_BIN: join(shared.directory, 'missing cloudflared') } });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /找不到 cloudflared/);
  assert.match(result.output, /CLOUDFLARED_BIN/);
  assert.match(result.output, /https:\/\/developers\.cloudflare\.com\//);
  assert.deepEqual((await readdir(shared.directory)).filter(name => name.startsWith('xiangwa-share-')), []);
});

test('the portable Windows CLI delegates to the existing downloader with the configured port',
  { ...options, skip: process.platform !== 'win32' }, async t => {
    const shared = await fixture(t, { listenHost: '127.0.0.2' });
    const result = await shared.run({ native: true,
      env: { HOST: '127.0.0.2', CLOUDFLARED_BIN: shared.binary, FAKE_EXIT: '23' } });
    assert.equal(result.code, 23, result.output);
    assert.deepEqual(shared.calls, ['/api/health']);
    await assertTunnel(shared);
  });
