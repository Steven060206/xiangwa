import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const setupScript = fileURLToPath(new URL('../scripts/setup-isolation.ps1', import.meta.url));
const runtimeScript = fileURLToPath(new URL('../scripts/runtime.ps1', import.meta.url));
const administrator = process.platform === 'win32' && await powershell(['-Command', `
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress
`]).then(result => result.code === 0 && JSON.parse(result.output));
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows account and task isolation' : !administrator ? 'Requires an administrator to test temporary local accounts and scheduled tasks' : false, timeout: 120000 };

test('Stop cancels a queued background task before it can start later', { skip: process.platform !== 'win32' }, async () => {
  const result = await powershell(['-Command', `
. $env:XW_TEST_HELPER
$task = [pscustomobject]@{ State = 2; StopCalls = 0 }
$task | Add-Member -MemberType ScriptMethod -Name Stop -Value { param($flags) $this.StopCalls++; $this.State = 3 }
function Get-IsolatedTask { return $task }
function Invoke-RestMethod { throw 'No game is listening.' }
$result = Invoke-IsolatedControl 'Stop' ([pscustomobject]@{port=4175;runtimeId='test'}) $null 'C:\\unused'
@{running=$result.running;state=$task.State;stopCalls=$task.StopCalls} | ConvertTo-Json -Compress
`], { XW_TEST_HELPER: fileURLToPath(new URL('../scripts/runtime-isolation.ps1', import.meta.url)) });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), { running: false, state: 3, stopCalls: 1 });
});

for (const scenario of [
  { name: 'new queued task', initial: 3, afterRun: 2, runs: 1, stops: 1, final: 3 },
  { name: 'new running task without readiness', initial: 3, afterRun: 4, runs: 1, stops: 1, final: 3 },
  { name: 'previously queued task', initial: 2, afterRun: 2, runs: 0, stops: 1, final: 3 },
  { name: 'existing running service', initial: 4, afterRun: 4, runs: 0, stops: 0, final: 4 },
]) test(`startup timeout cleans a ${scenario.name} according to task ownership`, { skip: process.platform !== 'win32' }, async () => {
  const result = await powershell(['-Command', `
. $env:XW_TEST_HELPER
$task = [pscustomobject]@{ State = [int]$env:XW_TEST_INITIAL; LastTaskResult = 0; StopCalls = 0; RunCalls = 0 }
$task | Add-Member -MemberType ScriptMethod -Name Run -Value { param($argument) $this.RunCalls++; $this.State = [int]$env:XW_TEST_AFTER_RUN }
$task | Add-Member -MemberType ScriptMethod -Name Stop -Value { param($flags) $this.StopCalls++; $this.State = 3 }
function Get-IsolatedTask { return $task }
function Get-IsolatedStatus { return @{running=$false} }
function Invoke-RestMethod { throw 'The test game is not listening.' }
function Start-Sleep { }
$failure = ''
try { Invoke-IsolatedControl 'Start' ([pscustomobject]@{port=4175;runtimeId='test'}) $null 'C:\\unused' | Out-Null }
catch { $failure = $_.Exception.Message }
@{state=$task.State;runCalls=$task.RunCalls;stopCalls=$task.StopCalls;failure=$failure} | ConvertTo-Json -Compress
`], { XW_TEST_HELPER: fileURLToPath(new URL('../scripts/runtime-isolation.ps1', import.meta.url)),
    XW_TEST_INITIAL: String(scenario.initial), XW_TEST_AFTER_RUN: String(scenario.afterRun) });
  assert.equal(result.code, 0, result.output);
  const report = JSON.parse(result.output);
  assert.match(report.failure, /did not start/);
  assert.equal(report.state, scenario.final);
  assert.equal(report.runCalls, scenario.runs);
  assert.equal(report.stopCalls, scenario.stops);
});

async function powershell(args, env = {}, timeout = 35000) {
  const parameters = [...args];
  if (parameters[0] === '-Command') parameters[1] = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); ' + parameters[1];
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...parameters], {
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

async function assertRecordedStopped(records) {
  const checked = await powershell(['-Command', `
foreach ($record in ($env:XW_TEST_RECORDS | ConvertFrom-Json)) {
  if (-not $record) { continue }
  $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if ($process -and $process.Path -eq $record.executable -and $process.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt) { throw 'A recorded test process is still running.' }
}
Write-Output 'Recorded processes are stopped.'
`], { XW_TEST_RECORDS: JSON.stringify(records) });
  assert.equal(checked.code, 0, checked.output);
}

async function fixture(t) {
  // Public is traversable by an ordinary account after the worker removes traverse privilege.
  // Every modified directory is newly created here; no real profile or drive-root ACL is changed.
  const parent = await realpath(process.env.PUBLIC || 'C:\\Users\\Public');
  const directory = await realpath(await mkdtemp(join(parent, '箱娃隔离 tests ')));
  const root = join(directory, '独立运行 目录');
  const protectedPath = join(directory, '私人资料');
  const runtimeId = randomUUID();
  const accountName = 'XWtest' + randomUUID().replaceAll('-', '').slice(0, 12);
  for (const name of ['app', 'bin', 'config', 'data', 'logs']) await mkdir(join(root, name), { recursive: true });
  await mkdir(join(protectedPath, '例外目录'), { recursive: true });
  await writeFile(join(protectedPath, 'secret.txt'), 'private original');
  await writeFile(join(protectedPath, '例外目录', 'secret.txt'), 'explicit allow must not bypass protected ancestor');
  await writeFile(join(root, 'data', 'rooms.json'), '{"preservedGame":42}');
  await writeFile(join(root, 'config', 'tunnel.json'), '{"opaque":"test credential"}');
  await copyFile(runtimeScript, join(root, 'runtime.ps1'));
  await copyFile(fileURLToPath(new URL('../scripts/runtime-isolation.ps1', import.meta.url)), join(root, 'runtime-isolation.ps1'));
  await copyFile(process.execPath, join(root, 'bin', 'node.exe'));
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(root, 'config', 'runtime.json'), JSON.stringify({ format: 1, root, runtimeId, deploymentReady: true, port, hostname: 'isolation.example.test', tunnelId: randomUUID() }));
  await writeFile(join(root, 'app', 'server.mjs'), `
import http from 'node:http';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const root = ${JSON.stringify(root)};
const checks = { account:execFileSync('whoami.exe', [], {encoding:'utf8'}).trim() };
const taskTest = \`
$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\\\')
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.Description = 'XiangWa worker permission test ${runtimeId}'
$definition.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 2
$definition.Principal.RunLevel = 0
$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action.Arguments = '-NoProfile -NonInteractive -Command exit'
$taskName = 'XiangWa-worker-test-${runtimeId}'
$created = $false
try {
  $errors = @()
  foreach ($testPassword in @($null, '', 'deliberately-wrong-test-password')) {
    try {
      [void]$folder.RegisterTaskDefinition($taskName, $definition, 2, $definition.Principal.UserId, $testPassword, 2, $null)
      $created = $true
      break
    } catch { $errors += $_.Exception.GetBaseException().HResult }
  }
  @{ allowed = $created; errors = $errors } | ConvertTo-Json -Compress
} finally {
  if ($created) {
    $task = $folder.GetTask($taskName)
    if ($task.Definition.RegistrationInfo.Description -ne $definition.RegistrationInfo.Description) { throw 'Test task identity changed.' }
    $folder.DeleteTask($taskName, 0)
  }
}
\`;
checks.schedulerCreate = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',taskTest], {encoding:'utf8'}));
for(const [key,path,write] of [
  ['protectedRead',${JSON.stringify(join(protectedPath, 'secret.txt'))},false],
  ['explicitChildRead',${JSON.stringify(join(protectedPath, '例外目录', 'secret.txt'))},false],
  ['programWrite',root+'/app/server.mjs',true],
  ['configWrite',root+'/config/tunnel.json',true],
  ['backupRead',root+'/config/admin/isolation-backup.json',false],
  ['dataWrite',root+'/data/worker-write.txt',true],
  ['logsWrite',root+'/logs/worker-write.txt',true],
  ['stateWrite',root+'/state/worker-write.txt',true]
]) {
  try { if(write)fs.appendFileSync(path,'test');else fs.readFileSync(path); checks[key]=true; }
  catch(error) { checks[key]=false; checks[key+'Error']=error.code; }
}
fs.writeFileSync(root+'/data/permission-checks.json',JSON.stringify(checks));
http.createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,runtimeId:process.env.XIANGWA_RUNTIME_ID}));}).listen(Number(process.env.PORT),process.env.HOST);
`);
  const compiled = await powershell(['-Command', `
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class FakeTunnel {
  public static void Main(string[] args) {
    int index = Array.IndexOf(args, "--config");
    File.WriteAllText(Path.Combine(Path.GetDirectoryName(args[index + 1]), "fake-tunnel-started.txt"), "started");
    if (File.Exists(Path.Combine(Path.GetDirectoryName(args[index + 1]), "fake-tunnel-exit"))) return;
    while (true) Thread.Sleep(1000);
  }
}
'@ -OutputAssembly $env:XW_TEST_BINARY -OutputType ConsoleApplication
$acl = Get-Acl -LiteralPath $env:XW_TEST_CHILD
$rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-11')), 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:XW_TEST_CHILD -AclObject $acl
@{ runtime = (Get-Acl -LiteralPath $env:XW_TEST_ROOT).Sddl; protected = (Get-Acl -LiteralPath $env:XW_TEST_PROTECTED).Sddl; child = (Get-Acl -LiteralPath $env:XW_TEST_CHILD).Sddl } | ConvertTo-Json -Compress
`], { XW_TEST_BINARY: join(root, 'bin', 'cloudflared.exe'), XW_TEST_ROOT: root, XW_TEST_PROTECTED: protectedPath, XW_TEST_CHILD: join(protectedPath, '例外目录') });
  const setup = (action, extra = []) => {
    const parameters = new Map([['-Root', root], ['-Action', action], ['-AccountName', accountName], ['-ProtectedPaths', protectedPath]]);
    for (let index = 0; index < extra.length; index += 2) parameters.set(extra[index], extra[index + 1]);
    return powershell(['-File', setupScript, ...[...parameters].flat(), '-Json']);
  };
  const run = action => powershell(['-File', runtimeScript, '-Root', root, '-Action', action, '-Json']);
  t.after(async () => {
    // Restore validates both SID and description before touching its test account.
    if (await access(join(root, 'config', 'admin', 'isolation-backup.json')).then(() => true, () => false)) {
      const restored = await setup('Restore');
      assert.equal(restored.code, 0, restored.output);
    } else {
      const stopped = await run('Stop');
      assert.equal(stopped.code, 0, stopped.output);
    }
    const inside = relative(parent, resolve(directory));
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && inside.startsWith('箱娃隔离 tests '));
    const removed = await powershell(['-Command', `
$target = [IO.Path]::GetFullPath($env:XW_TEST_DIRECTORY)
$parent = [IO.Path]::GetFullPath($env:PUBLIC).TrimEnd('\\') + '\\'
if (-not $target.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $target) -notlike ([string][char]0x7BB1 + [char]0x5A03 + [char]0x9694 + [char]0x79BB + ' tests *')) { throw 'Unsafe test cleanup path.' }
Remove-Item -LiteralPath $target -Recurse -Force
`], { XW_TEST_DIRECTORY: directory });
    assert.equal(removed.code, 0, removed.output);
  });
  assert.equal(compiled.code, 0, compiled.output);
  const originalAcls = JSON.parse(compiled.output);
  return { directory, root, protectedPath, runtimeId, accountName, port, setup, run, originalAcls };
}

test('isolation installs a dedicated ordinary account and demand-only limited S4U task with protected configuration', windowsOnly, async t => {
  const f = await fixture(t);
  const result = await f.setup('Install');
  assert.equal(result.code, 0, result.output);
  const installed = JSON.parse(result.output);
  assert.equal(installed.enabled, true);
  assert.equal(installed.taskName, 'runtime-' + f.runtimeId);
  const configuration = JSON.parse(await readFile(join(f.root, 'config', 'isolation.json')));
  assert.deepEqual(Object.keys(configuration).sort(), ['accountName', 'enabled', 'format', 'ownerSid', 'runtimeId', 'sid', 'taskName', 'taskPath'].sort());
  const checked = await powershell(['-Command', `
$account = Get-LocalUser -Name $env:XW_TEST_ACCOUNT
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\XiangWa')
$task = $folder.GetTask($env:XW_TEST_TASK)
$definition = $task.Definition
$groups = @(Get-LocalGroup | Where-Object { @(Get-LocalGroupMember -Group $_ | Where-Object { $_.SID -eq $account.SID }).Count -gt 0 } | ForEach-Object { $_.SID.Value })
@{ description = $account.Description; groups = $groups; triggers = $definition.Triggers.Count; logonType = $definition.Principal.LogonType; runLevel = $definition.Principal.RunLevel; timeLimit = $definition.Settings.ExecutionTimeLimit; instances = $definition.Settings.MultipleInstances; demand = $definition.Settings.AllowDemandStart; battery = $definition.Settings.DisallowStartIfOnBatteries; stopBattery = $definition.Settings.StopIfGoingOnBatteries; arguments = $definition.Actions.Item(1).Arguments; taskSddl = $task.GetSecurityDescriptor(4); folderSddl = $folder.GetSecurityDescriptor(4); backupSddl = (Get-Acl -LiteralPath (Join-Path $env:XW_TEST_ROOT 'config/admin')).Sddl } | ConvertTo-Json -Compress
`], { XW_TEST_ROOT: f.root, XW_TEST_ACCOUNT: f.accountName, XW_TEST_TASK: installed.taskName });
  assert.equal(checked.code, 0, checked.output);
  const properties = JSON.parse(checked.output);
  assert.equal(properties.description, 'XiangWa ' + f.runtimeId);
  assert.deepEqual(properties.groups, ['S-1-5-32-545']);
  assert.equal(properties.triggers, 0);
  assert.equal(properties.logonType, 2);
  assert.equal(properties.runLevel, 0);
  assert.equal(properties.timeLimit, 'PT0S');
  assert.equal(properties.instances, 2);
  assert.equal(properties.demand, true);
  assert.equal(properties.battery, false);
  assert.equal(properties.stopBattery, false);
  assert.match(properties.arguments, /-NonInteractive .* -WindowStyle Hidden .* -Worker$/);
  for (const key of ['taskSddl', 'folderSddl', 'backupSddl']) assert.ok(!properties[key].includes(installed.sid), properties[key]);
  assert.doesNotMatch(result.output + JSON.stringify(configuration), /password|aA1!/i);
  assert.equal(JSON.parse((await f.setup('Status')).output).enabled, true);
});

test('one-click isolated Start and Stop enforce permissions, hide private files, and preserve saved progress through Restore', windowsOnly, async t => {
  const f = await fixture(t);
  assert.equal((await f.setup('Install')).code, 0);
  const started = await f.run('Start');
  assert.equal(started.code, 0, started.output);
  assert.equal(JSON.parse(started.output).running, true);
  const checks = JSON.parse(await readFile(join(f.root, 'data', 'permission-checks.json')));
  assert.equal(checks.schedulerCreate.allowed, false, JSON.stringify(checks.schedulerCreate));
  assert.ok(checks.schedulerCreate.errors.length > 0 && checks.schedulerCreate.errors.every(value => value === -2147024891), JSON.stringify(checks.schedulerCreate));
  assert.ok(checks.account.toLowerCase().endsWith('\\' + f.accountName.toLowerCase()), checks.account);
  for (const key of ['protectedRead', 'explicitChildRead', 'programWrite', 'configWrite', 'backupRead']) assert.equal(checks[key], false, key);
  for (const key of ['dataWrite', 'logsWrite', 'stateWrite']) assert.equal(checks[key], true, key);
  const records = JSON.parse(await readFile(join(f.root, 'state', 'processes.json')));
  assert.ok(records.game.pid > 0 && records.tunnel.pid > 0);
  assert.equal(JSON.parse((await f.run('Start')).output).running, true);
  const stopped = await f.run('Stop');
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(JSON.parse(stopped.output).running, false);
  await assertRecordedStopped([records.game, records.tunnel]);
  const restarted = await f.run('Start');
  assert.equal(restarted.code, 0, restarted.output);
  const restartedRecords = JSON.parse(await readFile(join(f.root, 'state', 'processes.json')));
  assert.notDeepEqual([restartedRecords.game.pid, restartedRecords.game.startedAt], [records.game.pid, records.game.startedAt]);
  assert.notDeepEqual([restartedRecords.tunnel.pid, restartedRecords.tunnel.startedAt], [records.tunnel.pid, records.tunnel.startedAt]);
  assert.equal((await f.run('Stop')).code, 0);
  await assertRecordedStopped([restartedRecords.game, restartedRecords.tunnel]);
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"preservedGame":42}');
  const beforeRestore = await f.run('Start');
  const startupDetails = beforeRestore.code === 0 ? beforeRestore.output
    : beforeRestore.output + await readFile(join(f.root, 'state', 'worker-error.log'), 'utf8').catch(() => '');
  assert.equal(beforeRestore.code, 0, startupDetails);
  const runningAtRestore = JSON.parse(await readFile(join(f.root, 'state', 'processes.json')));
  const restored = await f.setup('Restore');
  assert.equal(restored.code, 0, restored.output);
  assert.equal(JSON.parse(restored.output).dataPreserved, true);
  await assertRecordedStopped([runningAtRestore.game, runningAtRestore.tunnel]);
  const checked = await powershell(['-Command', `
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$taskExists = $false
try { [void]$scheduler.GetFolder('\\XiangWa').GetTask($env:XW_TEST_TASK); $taskExists = $true } catch {}
@{ accountExists = [bool](Get-LocalUser -Name $env:XW_TEST_ACCOUNT -ErrorAction SilentlyContinue); taskExists = $taskExists; runtime = (Get-Acl -LiteralPath $env:XW_TEST_ROOT).Sddl; protected = (Get-Acl -LiteralPath $env:XW_TEST_PROTECTED).Sddl; child = (Get-Acl -LiteralPath (Join-Path $env:XW_TEST_PROTECTED ([string][char]0x4F8B + [char]0x5916 + [char]0x76EE + [char]0x5F55))).Sddl } | ConvertTo-Json -Compress
`], { XW_TEST_ROOT: f.root, XW_TEST_PROTECTED: f.protectedPath, XW_TEST_ACCOUNT: f.accountName, XW_TEST_TASK: 'runtime-' + f.runtimeId });
  assert.equal(checked.code, 0, checked.output);
  const after = JSON.parse(checked.output);
  assert.equal(after.accountExists, false);
  assert.equal(after.taskExists, false);
  for (const key of ['runtime', 'protected', 'child']) assert.equal(after[key], f.originalAcls[key]);
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"preservedGame":42}');
  assert.equal(await readFile(join(f.protectedPath, 'secret.txt'), 'utf8'), 'private original');
  await assert.rejects(access(join(f.root, 'config', 'isolation.json')), { code: 'ENOENT' });
});

test('isolation refuses an existing account without changing it or the game save', windowsOnly, async t => {
  const f = await fixture(t);
  const identity = await powershell(['-Command', '([Security.Principal.WindowsIdentity]::GetCurrent().Name -split "\\\\")[-1] | ConvertTo-Json -Compress']);
  assert.equal(identity.code, 0, identity.output);
  const occupied = JSON.parse(identity.output);
  const installed = await f.setup('Install', ['-AccountName', occupied]);
  assert.equal(installed.code, 1, installed.output);
  assert.match(installed.output, /account already exists/);
  await assert.rejects(access(join(f.root, 'config', 'isolation.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"preservedGame":42}');
});

test('Restore rejects a changed account identity before stopping its scheduled task or restoring ACLs', windowsOnly, async t => {
  const f = await fixture(t);
  const installed = await f.setup('Install');
  assert.equal(installed.code, 0, installed.output);
  const description = 'XiangWa ' + f.runtimeId;
  const changed = await powershell(['-Command', 'Set-LocalUser -Name $env:XW_TEST_ACCOUNT -Description "unrelated account description"'], { XW_TEST_ACCOUNT: f.accountName });
  assert.equal(changed.code, 0, changed.output);
  try {
    const restore = await f.setup('Restore');
    assert.equal(restore.code, 1, restore.output);
    assert.match(restore.output, /account identity does not match/);
    assert.equal(JSON.parse(await readFile(join(f.root, 'config', 'isolation.json'))).enabled, true);
  } finally {
    const reset = await powershell(['-Command', 'Set-LocalUser -Name $env:XW_TEST_ACCOUNT -Description $env:XW_TEST_DESCRIPTION'], { XW_TEST_ACCOUNT: f.accountName, XW_TEST_DESCRIPTION: description });
    assert.equal(reset.code, 0, reset.output);
  }
});

test('Install refuses live games and protected directories inside the runtime', windowsOnly, async t => {
  const f = await fixture(t);
  const invalid = await f.setup('Install', ['-ProtectedPaths', join(f.root, 'data')]);
  assert.equal(invalid.code, 1, invalid.output);
  assert.match(invalid.output, /may not be inside the runtime/);
  await writeFile(join(f.root, 'config', 'processes.json'), JSON.stringify({ runtimeId: f.runtimeId, game: { pid: process.pid }, tunnel: null }));
  try {
    const running = await f.setup('Install');
    assert.equal(running.code, 1, running.output);
    assert.match(running.output, /Stop this runtime/);
  } finally { await writeFile(join(f.root, 'config', 'processes.json'), JSON.stringify({ runtimeId: f.runtimeId, game: null, tunnel: null })); }
});

test('an immediately exiting tunnel leaves no game or worker child process and can retry without losing progress', windowsOnly, async t => {
  const f = await fixture(t);
  const installed = await f.setup('Install');
  assert.equal(installed.code, 0, installed.output);
  await writeFile(join(f.root, 'state', 'fake-tunnel-exit'), 'exit immediately');
  const failed = await f.run('Start');
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /did not start/);
  const records = JSON.parse(await readFile(join(f.root, 'state', 'processes.json')));
  await assertRecordedStopped([records.game, records.tunnel]);
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/api/health`, { signal: AbortSignal.timeout(2000) }));
  const cleanupMarker = await powershell(['-Command', 'Remove-Item -LiteralPath (Join-Path $env:XW_TEST_ROOT "state/fake-tunnel-exit")'], { XW_TEST_ROOT: f.root });
  assert.equal(cleanupMarker.code, 0, cleanupMarker.output);
  const retried = await f.run('Start');
  assert.equal(retried.code, 0, retried.output);
  const stopped = await f.run('Stop');
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(await readFile(join(f.root, 'data', 'rooms.json'), 'utf8'), '{"preservedGame":42}');
});
