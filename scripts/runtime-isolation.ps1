function Assert-IsolationConfiguration($Settings, $Isolation, [string]$RuntimeRoot) {
  if ($Isolation.format -ne 1 -or $Isolation.enabled -ne $true -or $Isolation.runtimeId -ne $Settings.runtimeId -or
      $Isolation.taskPath -ne '\XiangWa\' -or $Isolation.taskName -ne ('runtime-' + $Settings.runtimeId)) {
    throw 'Runtime isolation configuration does not match this installation.'
  }
  [void](New-Object Security.Principal.SecurityIdentifier($Isolation.sid))
  [void](New-Object Security.Principal.SecurityIdentifier($Isolation.ownerSid))
  $account = Get-LocalUser -SID $Isolation.sid -ErrorAction Stop
  if (-not $account.Enabled -or $account.Description -ne ('XiangWa ' + $Settings.runtimeId)) {
    throw 'Runtime isolation account identity does not match.'
  }
  $adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
  if (Get-LocalGroupMember -Group $adminGroup | Where-Object { $_.SID.Value -eq $Isolation.sid }) {
    throw 'The game account must not be an administrator.'
  }
}

function Get-IsolatedTask($Isolation, [string]$RuntimeRoot) {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $task = $service.GetFolder($Isolation.taskPath.TrimEnd('\')).GetTask($Isolation.taskName)
  $principal = New-Object Security.Principal.NTAccount($task.Definition.Principal.UserId)
  try { $principalSid = $principal.Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { $principalSid = (New-Object Security.Principal.SecurityIdentifier($task.Definition.Principal.UserId)).Value }
  $expectedExecutable = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $expectedArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $RuntimeRoot 'runtime.ps1') + '" -Action Start -Root "' + $RuntimeRoot + '" -Worker'
  if ($principalSid -ne $Isolation.sid -or $task.Definition.Principal.RunLevel -ne 0 -or $task.Definition.Principal.LogonType -ne 2 -or
      $task.Definition.Triggers.Count -ne 0 -or $task.Definition.Actions.Count -ne 1 -or
      $task.Definition.Actions.Item(1).Path -ne $expectedExecutable -or $task.Definition.Actions.Item(1).Arguments -ne $expectedArguments) {
    throw 'The background task identity or command has changed; no task was started or stopped.'
  }
  return $task
}

function Get-IsolatedStatus($Settings, $Isolation, [string]$RuntimeRoot, $Task) {
  $taskRunning = $Task.State -eq 4
  $health = $null
  if ($taskRunning) {
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Settings.port)/api/health" -TimeoutSec 1 } catch { }
  }
  $healthy = $health -and $health.ok -eq $true -and $health.runtimeId -eq $Settings.runtimeId
  $manifest = $null
  $manifestFile = Join-Path $RuntimeRoot 'state/processes.json'
  if (Test-Path -LiteralPath $manifestFile -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.runtimeId -ne $Settings.runtimeId) { throw 'Background process records belong to another runtime.' }
  }
  $ready = $null
  $readyPath = Join-Path $RuntimeRoot 'state/ready.json'
  if (Test-Path -LiteralPath $readyPath -PathType Leaf) { $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  $readyMatches = $ready -and $manifest -and $ready.runtimeId -eq $Settings.runtimeId -and
    $ready.gameStartedAt -eq $manifest.game.startedAt -and $ready.tunnelStartedAt -eq $manifest.tunnel.startedAt
  return @{ running = [bool]($taskRunning -and $healthy -and $readyMatches); game = [bool]$healthy;
    tunnel = [bool]($taskRunning -and $readyMatches); healthy = [bool]$healthy;
    isolated = $true; account = $Isolation.accountName; port = $Settings.port; url = "https://$($Settings.hostname)" }
}

function Invoke-IsolatedControl([string]$RequestedAction, $Settings, $Isolation, [string]$RuntimeRoot) {
  $task = Get-IsolatedTask $Isolation $RuntimeRoot
  if ($RequestedAction -eq 'Start') {
    if ($task.State -notin @(2, 4)) {
      $readyPath = Join-Path $RuntimeRoot 'state/ready.json'
      if (Test-Path -LiteralPath $readyPath -PathType Leaf) { Remove-Item -LiteralPath $readyPath -Force }
      [void]$task.Run($null)
    }
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      $status = Get-IsolatedStatus $Settings $Isolation $RuntimeRoot $task
      if ($status.running) { return $status }
      Start-Sleep -Milliseconds 250
    }
    throw ('The low-permission game did not start. Check state/worker-error.log and task result ' + $task.LastTaskResult + '.')
  }
  if ($RequestedAction -eq 'Stop') {
    if ($task.State -in @(2, 4)) { $task.Stop(0) }
    for ($attempt = 0; $attempt -lt 40 -and $task.State -in @(2, 4); $attempt++) { Start-Sleep -Milliseconds 250 }
    if ($task.State -in @(2, 4)) { throw 'The background task did not stop.' }
    $closed = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Settings.port)/api/health" -TimeoutSec 1 }
      catch { $health = $null }
      if (-not $health -or $health.runtimeId -ne $Settings.runtimeId) { $closed = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $closed) { throw 'The game is still responding after its task stopped.' }
    return @{ running = $false; game = $false; tunnel = $false; isolated = $true; dataPreserved = $true }
  }
  return Get-IsolatedStatus $Settings $Isolation $RuntimeRoot $task
}

function Remove-WorkerTraversePrivilege {
  if (-not ('XiangWa.WorkerToken' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace XiangWa {
  public sealed class WorkerJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
      public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
      public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public BasicLimits Basic; public IoCounters Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr handle;
    public WorkerJob() {
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) throw new Win32Exception();
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
      if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
        int error = Marshal.GetLastWin32Error(); Dispose(); throw new Win32Exception(error);
      }
    }
    public void Add(IntPtr process) {
      if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception();
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  }
  public static class WorkerToken {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref Privilege privileges, uint length, IntPtr previous, IntPtr result);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static void RemoveTraverseBypass() {
      IntPtr token;
      if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x28, out token)) throw new Win32Exception();
      try {
        Luid luid;
        if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out luid)) throw new Win32Exception();
        Privilege privilege = new Privilege { Count=1, Luid=luid, Attributes=4 };
        if (!AdjustTokenPrivileges(token, false, ref privilege, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        int error = Marshal.GetLastWin32Error();
        if (error != 0 && error != 1300) throw new Win32Exception(error);
      } finally { CloseHandle(token); }
    }
  }
}
'@
  }
  [XiangWa.WorkerToken]::RemoveTraverseBypass()
}
