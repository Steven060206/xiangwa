import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, access, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('../scripts/deploy-runtime.ps1', import.meta.url));
const runtimeScript = fileURLToPath(new URL('../scripts/runtime.ps1', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32', timeout: 60000 };

async function powershell(args, env = {}, timeout = 25000) {
  const encodedArgs = [...args];
  if (encodedArgs[0] === '-Command') encodedArgs[1] = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' + encodedArgs[1];
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...encodedArgs], {
    windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, output);
    return { code, output };
  } finally { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
}

async function removeTemporaryDirectory(directory) {
  const absolute = resolve(directory);
  const inside = relative(await realpath(tmpdir()), absolute);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  const removed = await powershell(['-Command', `
$target = [IO.Path]::GetFullPath($env:XIANGWA_TEST_TEMP_ROOT)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\') + '\\'
if (-not $target.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup target.' }
Remove-Item -LiteralPath $target -Recurse -Force
`], { XIANGWA_TEST_TEMP_ROOT: absolute });
  assert.equal(removed.code, 0, removed.output);
}

let fakeBinary;
async function compiledFake(t, directory) {
  if (!fakeBinary) {
    const binaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'hako-runtime-fake-')));
    const binary = join(binaryDirectory, 'fake-cloudflared.exe');
    const compiled = await powershell(['-Command', `
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class FakeTunnel {
  public static void Main(string[] args) {
    string marker = Environment.GetEnvironmentVariable("XIANGWA_TEST_TUNNEL_MARKER");
    int index = Array.IndexOf(args, "--config");
    if (marker != null) File.WriteAllText(marker, File.ReadAllText(args[index + 1]));
    Console.WriteLine("fake tunnel running");
    Thread.Sleep(Timeout.Infinite);
  }
}
'@ -OutputAssembly $env:XIANGWA_TEST_FAKE_BINARY -OutputType ConsoleApplication
`], { XIANGWA_TEST_FAKE_BINARY: binary });
    assert.equal(compiled.code, 0, compiled.output);
    fakeBinary = { binary, directory: binaryDirectory };
  }
  await copyFile(fakeBinary.binary, join(directory, 'cloudflared.exe'));
  return join(directory, 'cloudflared.exe');
}

test.after(async () => {
  if (fakeBinary) await removeTemporaryDirectory(fakeBinary.directory);
});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hako-runtime-')));
  assert.equal(dirname(resolve(directory)), await realpath(tmpdir()));
  const source = join(directory, '开发 源码');
  const root = join(directory, '箱娃 独立运行');
  for (const name of ['src', 'public', 'scripts', 'data', 'node_modules', 'references']) await mkdir(join(source, name), { recursive: true });
  const entryFile = join(directory, 'entry.json');
  const credential = join(directory, '隧道 凭证.json');
  const marker = join(directory, 'tunnel-config-record.json');
  const argsMarker = join(directory, 'invite-arguments.json');
  const tunnelBinary = await compiledFake(t, directory);
  const portServer = http.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  await writeFile(entryFile, JSON.stringify({ hostname: 'game.example.test', tunnelId: '12345678-1234-1234-1234-123456789abc', credentialsFile: credential }));
  await writeFile(credential, 'opaque credential: must never appear in tool output');
  await writeFile(join(source, 'package.json'), '{"type":"module"}');
  await writeFile(join(source, 'src', 'marker.mjs'), 'export const runtime = true;');
  await writeFile(join(source, 'public', 'index.html'), '<main>runtime</main>');
  await writeFile(join(source, 'data', 'rooms.json'), '{"originalSave":true}');
  await writeFile(join(source, 'references', 'private.txt'), 'do not copy');
  await writeFile(join(source, 'node_modules', 'private.txt'), 'do not copy');
  await writeFile(join(source, 'server.mjs'), `
import http from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.DATA_DIR + '/environment.json', JSON.stringify({host:process.env.HOST, data:process.env.DATA_DIR, access:process.env.ACCESS_DIR, runtimeId:process.env.XIANGWA_RUNTIME_ID, execArgv:process.execArgv}));
http.createServer((request,response) => {
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify({ok:true,runtimeId:process.env.XIANGWA_TEST_WRONG_HEALTH ? 'wrong-runtime' : process.env.XIANGWA_RUNTIME_ID}));
}).listen(Number(process.env.PORT),process.env.HOST);
`);
  await writeFile(join(source, 'scripts', 'manage-invites.mjs'), `
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.XIANGWA_TEST_INVITE_MARKER,JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify(process.argv.includes('--list') ? [] : process.argv.includes('--revoke') ? {revoked:true} : {id:'test-id',code:'test-secret-invite',expiresAt:1893456000000,maxUses:4}));
`);
  const env = { XIANGWA_TEST_TUNNEL_MARKER: marker, XIANGWA_TEST_INVITE_MARKER: argsMarker };
  const run = (action, extra = [], extraEnv = {}) => powershell(['-File', runtimeScript, '-Root', root, '-Action', action, '-Json', ...extra], { ...env, ...extraEnv });
  const deploy = (extra = [], { shortcuts = false, defaultBinaries = false, extraEnv = {} } = {}) => {
    const parameters = new Map([['-Root', root], ['-SourceRoot', source], ['-Port', String(port)], ['-EntryFile', entryFile]]);
    if (!defaultBinaries) { parameters.set('-NodeBinary', process.execPath); parameters.set('-TunnelBinary', tunnelBinary); }
    for (let index = 0; index < extra.length; index += 2) parameters.set(extra[index], extra[index + 1]);
    return powershell(['-File', deployScript, ...[...parameters].flat(), ...(shortcuts ? ['-NoDesktopShortcuts'] : ['-NoShortcuts'])], { ...env, ...extraEnv });
  };
  t.after(async () => {
    if (await access(join(root, 'config', 'runtime.json')).then(() => true, () => false)) {
      const stopped = await run('Stop');
      assert.equal(stopped.code, 0, stopped.output);
    }
    await removeTemporaryDirectory(directory);
  });
  return { directory, source, root, port, entryFile, marker, credential, tunnelBinary, argsMarker, run, deploy };
}

test('deployment copies a standalone program, opaque tunnel credential and initial save without development assets', windowsOnly, async t => {
  const f = await fixture(t);
  const deployed = await f.deploy();
  assert.equal(deployed.code, 0, deployed.output);
  assert.doesNotMatch(deployed.output, /opaque credential/);
  for (const name of ['app/server.mjs', 'app/package.json', 'app/src/marker.mjs', 'app/public/index.html', 'app/scripts/manage-invites.mjs', 'bin/node.exe', 'bin/cloudflared.exe', 'runtime.ps1']) await access(join(f.root, name));
  for (const name of ['app/node_modules', 'app/references', 'config/cert.pem']) await assert.rejects(access(join(f.root, name)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, 'config', 'tunnel.json'), 'utf8'), await readFile(f.credential, 'utf8'));
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"originalSave":true}');
  const initial = JSON.parse(await readFile(join(f.root, 'config', 'runtime.json')));
  await writeFile(join(f.root, 'data', 'rooms.json'), '{"progress":42}');
  await writeFile(join(f.source, 'data', 'rooms.json'), '{"developmentChanged":true}');
  const updated = await f.deploy(['-Port', '4199']);
  assert.equal(updated.code, 0, updated.output);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'config', 'runtime.json'))), initial);
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"progress":42}');
  assert.equal(await readFile(join(f.source, 'data', 'rooms.json'), 'utf8'), '{"developmentChanged":true}');
});

test('default binary discovery selects the first PATH candidate when node and cloudflared have multiple matches', windowsOnly, async t => {
  const f = await fixture(t);
  const first = join(f.directory, 'first binaries');
  const second = join(f.directory, 'second binaries');
  await mkdir(first);
  await mkdir(second);
  await copyFile(process.execPath, join(first, 'node.exe'));
  await copyFile(fakeBinary.binary, join(first, 'cloudflared.exe'));
  await writeFile(join(second, 'node.exe'), 'not the selected node');
  await writeFile(join(second, 'cloudflared.exe'), 'not the selected tunnel');
  const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'Path';
  const extraEnv = { [pathKey]: `${first};${second};${process.env[pathKey]}`, CLOUDFLARED_BIN: '' };
  const discovered = await powershell(['-Command', '(Get-Command node.exe -CommandType Application).Source | ConvertTo-Json -Compress'], extraEnv);
  assert.equal(discovered.code, 0, discovered.output);
  assert.deepEqual(JSON.parse(discovered.output).slice(0, 2), [join(first, 'node.exe'), join(second, 'node.exe')]);
  const deployed = await f.deploy([], { defaultBinaries: true, extraEnv });
  assert.equal(deployed.code, 0, deployed.output);
  assert.equal((await stat(join(f.root, 'bin', 'node.exe'))).size, (await stat(process.execPath)).size);
  assert.deepEqual(await readFile(join(f.root, 'bin', 'cloudflared.exe')), await readFile(fakeBinary.binary));
});

test('an interrupted initial binary copy leaves a managed identity and retries without replacing UUID or saved progress', windowsOnly, async t => {
  const f = await fixture(t);
  const sourceBefore = await readFile(f.tunnelBinary);
  const locker = spawn('powershell.exe', ['-NoProfile', '-Command', `
$held = [IO.File]::Open($env:XIANGWA_TEST_LOCK_BINARY, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $held.Dispose() }
`], {windowsHide:true, env:{...process.env, XIANGWA_TEST_LOCK_BINARY:f.tunnelBinary}, stdio:['pipe','pipe','pipe']});
  const [ready] = await once(locker.stdout, 'data');
  assert.match(ready.toString(), /locked/);
  let initial;
  try {
    const failed = await f.deploy();
    assert.equal(failed.code, 1, failed.output);
    const settingsPath = join(f.root, 'config', 'runtime.json');
    initial = JSON.parse(await readFile(settingsPath));
    assert.equal(initial.deploymentReady, false);
    assert.match(initial.runtimeId, /^[a-f\d-]{36}$/);
    const start = await f.run('Start');
    assert.equal(start.code, 1, start.output);
    assert.match(start.output, /deployment is incomplete/);
    await writeFile(join(f.root, 'data', 'rooms.json'), '{"preservedAfterFailure":true}');
  } finally {
    const exited = once(locker, 'exit');
    locker.stdin.end('\n');
    await exited;
    locker.stdout.destroy();
    locker.stderr.destroy();
  }
  const retried = await f.deploy();
  assert.equal(retried.code, 0, retried.output);
  const completed = JSON.parse(await readFile(join(f.root, 'config', 'runtime.json')));
  assert.equal(completed.runtimeId, initial.runtimeId);
  assert.equal(completed.deploymentReady, true);
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"preservedAfterFailure":true}');
  assert.deepEqual(await readFile(f.tunnelBinary), sourceBefore);
  assert.deepEqual(await readFile(join(f.root, 'bin', 'cloudflared.exe')), sourceBefore);
});

test('byte deployment copies encrypted source bytes without inheriting EFS metadata or changing source encryption', windowsOnly, async t => {
  const f = await fixture(t);
  const binaryBefore = await readFile(f.tunnelBinary);
  const credentialBefore = await readFile(f.credential);
  const encrypted = await powershell(['-Command', `
try {
  [IO.File]::Encrypt($env:XIANGWA_TEST_BINARY)
  [IO.File]::Encrypt($env:XIANGWA_TEST_CREDENTIAL)
} catch { [Console]::Error.WriteLine('EFS unavailable'); exit 3 }
`], {XIANGWA_TEST_BINARY:f.tunnelBinary, XIANGWA_TEST_CREDENTIAL:f.credential});
  if (encrypted.code === 3) { t.skip('EFS is unavailable on this Windows filesystem'); return; }
  assert.equal(encrypted.code, 0, encrypted.output);
  const deployed = await f.deploy();
  assert.equal(deployed.code, 0, deployed.output);
  assert.deepEqual(await readFile(f.tunnelBinary), binaryBefore);
  assert.deepEqual(await readFile(f.credential), credentialBefore);
  assert.deepEqual(await readFile(join(f.root, 'bin', 'cloudflared.exe')), binaryBefore);
  assert.deepEqual(await readFile(join(f.root, 'config', 'tunnel.json')), credentialBefore);
  const attributes = await powershell(['-Command', `
@{
  sourceBinary = [bool]([IO.File]::GetAttributes($env:XIANGWA_TEST_BINARY) -band [IO.FileAttributes]::Encrypted)
  sourceCredential = [bool]([IO.File]::GetAttributes($env:XIANGWA_TEST_CREDENTIAL) -band [IO.FileAttributes]::Encrypted)
  targetBinary = [bool]([IO.File]::GetAttributes((Join-Path $env:XIANGWA_TEST_ROOT 'bin/cloudflared.exe')) -band [IO.FileAttributes]::Encrypted)
  targetCredential = [bool]([IO.File]::GetAttributes((Join-Path $env:XIANGWA_TEST_ROOT 'config/tunnel.json')) -band [IO.FileAttributes]::Encrypted)
} | ConvertTo-Json -Compress
`], {XIANGWA_TEST_BINARY:f.tunnelBinary, XIANGWA_TEST_CREDENTIAL:f.credential, XIANGWA_TEST_ROOT:f.root});
  assert.equal(attributes.code, 0, attributes.output);
  assert.deepEqual(JSON.parse(attributes.output), {sourceBinary:true, sourceCredential:true, targetBinary:false, targetCredential:false});
});

test('deployment rejects a development subdirectory and unmanaged existing program folders', windowsOnly, async t => {
  const f = await fixture(t);
  const nested = await f.deploy(['-Root', join(f.source, 'bad-runtime')]);
  assert.equal(nested.code, 1, nested.output);
  assert.match(nested.output, /outside the development/);
  await mkdir(join(f.root, 'app'), { recursive: true });
  await writeFile(join(f.root, 'app', 'personal.txt'), 'preserve');
  const occupied = await f.deploy();
  assert.equal(occupied.code, 1, occupied.output);
  assert.match(occupied.output, /unmanaged app/);
  assert.equal(await readFile(join(f.root, 'app', 'personal.txt'), 'utf8'), 'preserve');
});

test('deployment creates Chinese one-click shortcuts without overwriting an existing user shortcut', windowsOnly, async t => {
  const f = await fixture(t);
  await mkdir(f.root, {recursive:true});
  await writeFile(join(f.root, '开始联机.lnk'), 'existing user shortcut');
  const deployed = await f.deploy([], {shortcuts:true});
  assert.equal(deployed.code, 0, deployed.output);
  assert.equal(await readFile(join(f.root, '开始联机.lnk'), 'utf8'), 'existing user shortcut');
  const checked = await powershell(['-Command', `
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $env:XIANGWA_TEST_SHORTCUT_ROOT ([string][char]0x7ED3 + [char]0x675F + [char]0x8054 + [char]0x673A + '.lnk')))
@{ target = $shortcut.TargetPath; arguments = $shortcut.Arguments; directory = $shortcut.WorkingDirectory } | ConvertTo-Json -Compress
`], {XIANGWA_TEST_SHORTCUT_ROOT:f.root});
  assert.equal(checked.code, 0, checked.output);
  const shortcut = JSON.parse(checked.output);
  assert.match(shortcut.target, /powershell\.exe$/i);
  assert.match(shortcut.arguments, /-Action Stop -Dialog/);
  assert.ok(shortcut.arguments.includes(join(f.root, 'runtime.ps1')));
  assert.equal(shortcut.directory, f.root);
  await access(join(f.root, '发放邀请码.lnk'));
});

test('runtime starts hidden owned processes, pins the tunnel host and stops idempotently while retaining data', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  const started = await f.run('Start');
  assert.equal(started.code, 0, started.output);
  assert.deepEqual(JSON.parse(started.output), { game: true, tunnel: true, port: f.port, running: true, url: 'https://game.example.test' });
  const settings = JSON.parse(await readFile(join(f.root, 'config', 'runtime.json')));
  const environment = JSON.parse(await readFile(join(f.root, 'data', 'environment.json')));
  assert.deepEqual(environment, { host: '127.0.0.1', data: join(f.root, 'data'), access: join(f.root, 'data'), runtimeId: settings.runtimeId, execArgv: ['--max-old-space-size=512'] });
  const config = JSON.parse(await readFile(f.marker));
  assert.deepEqual(config, { tunnel: settings.tunnelId, 'credentials-file': join(f.root, 'config', 'tunnel.json'), ingress: [{hostname:'game.example.test',service:`http://127.0.0.1:${f.port}`},{service:'http_status:404'}] });
  const manifestBefore = JSON.parse(await readFile(join(f.root, 'config', 'processes.json')));
  const repeated = await f.run('Start');
  assert.equal(repeated.code, 0, repeated.output);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'config', 'processes.json'))), manifestBefore);
  const status = await f.run('Status');
  assert.equal(JSON.parse(status.output).running, true);
  const update = await f.deploy();
  assert.equal(update.code, 1, update.output);
  assert.match(update.output, /Stop this runtime/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stopped = await f.run('Stop');
    assert.equal(stopped.code, 0, stopped.output);
    assert.equal(JSON.parse(stopped.output).running, false);
  }
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"originalSave":true}');
  assert.equal(await readFile(join(f.source, 'data', 'rooms.json'), 'utf8'), '{"originalSave":true}');
});

test('runtime refuses a port held by another service and leaves that service running', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  const server = http.createServer((request, response) => response.end('{"ok":true,"runtimeId":"other-service"}'));
  server.listen(f.port, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const started = await f.run('Start');
  assert.equal(started.code, 1, started.output);
  assert.match(started.output, /already in use/);
  assert.equal(server.listening, true);
  await assert.rejects(readFile(f.marker), {code:'ENOENT'});
});

test('runtime rolls back its new game when health reports a different installation identity', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  const started = await f.run('Start', [], {XIANGWA_TEST_WRONG_HEALTH:'1'});
  assert.equal(started.code, 1, started.output);
  assert.match(started.output, /identity does not match/);
  const status = await f.run('Status');
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).game, false);
  await assert.rejects(readFile(f.marker), {code:'ENOENT'});
});

test('runtime refuses to stop reused or altered PIDs before stopping either owned process', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  assert.equal((await f.run('Start')).code, 0);
  const manifestPath = join(f.root, 'config', 'processes.json');
  const original = JSON.parse(await readFile(manifestPath));
  try {
    for (const altered of [{ ...original.game, pid: process.pid }, { ...original.game, startedAt: '2000-01-01T00:00:00.0000000Z' }, { ...original.game, argumentPath: join(f.directory, 'unrelated.mjs') }]) {
      await writeFile(manifestPath, JSON.stringify({ ...original, game: altered }));
      const stopped = await f.run('Stop');
      assert.equal(stopped.code, 1, stopped.output);
      assert.match(stopped.output, /identity does not match/);
      process.kill(original.tunnel.pid, 0);
      process.kill(original.game.pid, 0);
    }
  } finally { await writeFile(manifestPath, JSON.stringify(original)); }
});

test('runtime safely clears exited PIDs and refuses manifests from another installation', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  const settings = JSON.parse(await readFile(join(f.root, 'config', 'runtime.json')));
  const path = join(f.root, 'config', 'processes.json');
  const stoppedProcess = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await once(stoppedProcess, 'exit');
  await writeFile(path, JSON.stringify({ runtimeId: settings.runtimeId, game: {pid: stoppedProcess.pid}, tunnel: null }));
  const stopped = await f.run('Stop');
  assert.equal(stopped.code, 0, stopped.output);
  await writeFile(path, JSON.stringify({runtimeId: 'other-installation', game: null, tunnel: null}));
  const rejected = await f.run('Start');
  assert.equal(rejected.code, 1, rejected.output);
  assert.match(rejected.output, /another runtime/);
  await writeFile(path, JSON.stringify({runtimeId: settings.runtimeId, game: null, tunnel: null}));
});

test('Invite delegates creation, listing and revocation to the local CLI with the correct data directory', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.deploy()).code, 0);
  const beforeStart = await f.run('Invite');
  assert.equal(beforeStart.code, 1, beforeStart.output);
  assert.match(beforeStart.output, /Start this runtime/);
  assert.equal((await f.run('Start')).code, 0);
  const defaultIssued = await f.run('Invite');
  assert.equal(defaultIssued.code, 0, defaultIssued.output);
  assert.deepEqual(JSON.parse(await readFile(f.argsMarker)), ['--port', String(f.port), '--directory', join(f.root, 'data'), '--json', '--hours', '0.5', '--uses', '5']);
  const issued = await f.run('Invite', ['-Hours', '2', '-Uses', '3']);
  assert.equal(issued.code, 0, issued.output);
  assert.equal(JSON.parse(issued.output).code, 'test-secret-invite');
  assert.deepEqual(JSON.parse(await readFile(f.argsMarker)), ['--port', String(f.port), '--directory', join(f.root, 'data'), '--json', '--hours', '2', '--uses', '3']);
  const list = await f.run('Invite', ['-List']);
  assert.equal(list.code, 0, list.output);
  assert.deepEqual(JSON.parse(list.output), []);
  assert.deepEqual(JSON.parse(await readFile(f.argsMarker)).slice(-1), ['--list']);
  const revoke = await f.run('Invite', ['-Revoke', 'test-id']);
  assert.equal(revoke.code, 0, revoke.output);
  assert.deepEqual(JSON.parse(revoke.output), {revoked:true});
  assert.deepEqual(JSON.parse(await readFile(f.argsMarker)).slice(-2), ['--revoke','test-id']);
  const status = await f.run('Status');
  assert.doesNotMatch(status.output, /test-secret-invite|adminKey|opaque credential/);
});
