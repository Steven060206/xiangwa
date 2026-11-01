param(
  [ValidateSet('Install', 'Restore', 'Status')][string]$Action = 'Status',
  [string]$Root = $env:XIANGWA_RUNTIME_ROOT,
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{0,19}$')][string]$AccountName = 'XiangWaService',
  [string[]]$ProtectedPaths = @($env:USERPROFILE),
  [string[]]$ProtectedVolumeRoots = @(),
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { throw 'Specify your own runtime directory with -Root or XIANGWA_RUNTIME_ROOT.' }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
# Hosts launched from PowerShell 7 may inherit its module search path. Load the
# Windows PowerShell security cmdlets that match the scheduled task's engine.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$settingsPath = Join-Path $Root 'config/runtime.json'
$isolationPath = Join-Path $Root 'config/isolation.json'
$adminPath = Join-Path $Root 'config/admin'
$backupPath = Join-Path $adminPath 'isolation-backup.json'
$taskPath = '\XiangWa\'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$setupLock = $null
$backup = $null
$taskService = $null

function Read-Json([string]$Path) { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json([string]$Path, $Value) {
  $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 15), $utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force } }
}
function Normalize-Path([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $normalized = $full.TrimEnd('\')
  if ($full -eq [IO.Path]::GetPathRoot($full)) { $normalized += '\' }
  if ($normalized -notmatch '^[A-Za-z]:') { throw 'Isolation requires a local Windows drive path.' }
  if ($normalized -match '["\r\n]') { throw 'Runtime paths may not contain quotes or line breaks.' }
  return $normalized
}
function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installation tool as administrator.' }
}
function Get-LocalAccount([string]$Name) { return Get-LocalUser -Name $Name -ErrorAction SilentlyContinue }
function Get-TaskFolder {
  try { return $taskService.GetFolder($taskPath.TrimEnd('\')) } catch { if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null }; throw }
}
function Get-Task([string]$Name) {
  $folder = Get-TaskFolder
  if (-not $folder) { return $null }
  try { return $folder.GetTask($Name) } catch { if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null }; throw }
}
function Resolve-Sid([string]$Identity) {
  if ($Identity -match '^S-1-') { return $Identity }
  return (New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Assert-TaskIdentity($Task, $Identity) {
  $definition = $Task.Definition
  if ($definition.RegistrationInfo.Description -ne $Identity.description -or
      (Resolve-Sid $definition.Principal.UserId) -ne $Identity.sid -or
      $definition.Principal.LogonType -ne 2 -or $definition.Principal.RunLevel -ne 0 -or
      $definition.Actions.Count -ne 1 -or
      $definition.Actions.Item(1).Path -ne $Identity.executable -or
      $definition.Actions.Item(1).Arguments -ne $Identity.arguments) {
    throw 'The scheduled task identity does not match this installation; it was left untouched.'
  }
}
function Assert-AccountIdentity($Account, $Identity) {
  if ($Account -and ($Account.SID.Value -ne $Identity.sid -or $Account.Description -ne $Identity.description)) {
    throw 'The local account identity does not match this installation; it was left untouched.'
  }
}
function Set-BatchLogonRight([string]$Sid, [bool]$Add) {
  if (-not ('XiangWa.IsolationLogonRight' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
namespace XiangWa {
  public static class IsolationLogonRight {
    [StructLayout(LayoutKind.Sequential)] struct Attributes {
      public int Length; public IntPtr Root; public IntPtr Name; public uint Flags; public IntPtr Descriptor; public IntPtr Quality;
    }
    [StructLayout(LayoutKind.Sequential)] struct Text {
      public ushort Length; public ushort MaximumLength; public IntPtr Buffer;
    }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, Text[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.Bool)] bool all, Text[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
    public static void Set(string sidValue, bool add) {
      IntPtr policy;
      Attributes attributes = new Attributes { Length = Marshal.SizeOf(typeof(Attributes)) };
      uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x810, out policy);
      if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
      Text text = new Text();
      try {
        SecurityIdentifier sid = new SecurityIdentifier(sidValue);
        byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        string right = "SeBatchLogonRight";
        text.Buffer = Marshal.StringToHGlobalUni(right); text.Length = (ushort)(right.Length * 2); text.MaximumLength = (ushort)(text.Length + 2);
        status = add ? LsaAddAccountRights(policy, bytes, new Text[] { text }, 1) : LsaRemoveAccountRights(policy, bytes, false, new Text[] { text }, 1);
        if (status != 0 && !(status == 0xC0000034 && !add)) throw new Win32Exception((int)LsaNtStatusToWinError(status));
      } finally { if (text.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(text.Buffer); LsaClose(policy); }
    }
  }
}
'@
  }
  [XiangWa.IsolationLogonRight]::Set($Sid, $Add)
}
function Assert-Stopped {
  foreach ($relative in @('config/processes.json', 'state/processes.json')) {
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $manifest = Read-Json $path
    if ($manifest.runtimeId -ne $settings.runtimeId) { throw 'Process manifest belongs to another runtime.' }
    foreach ($role in @('game', 'tunnel', 'worker')) {
      $record = $manifest.$role
      if ($record -and (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { throw 'Stop this runtime before changing isolation.' }
    }
  }
  if ($settings.port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$settings.port)
    try { $listener.Start() } catch { throw 'The runtime port is in use. Stop the game before changing isolation.' }
    finally { $listener.Stop() }
  }
}
function Get-AclRecord([string]$Path) {
  return [pscustomobject]@{ path = $Path; sddl = (Get-Acl -LiteralPath $Path).Sddl }
}
function New-Rule([string]$Sid, [Security.AccessControl.FileSystemRights]$Rights, [Security.AccessControl.InheritanceFlags]$Inheritance, [Security.AccessControl.AccessControlType]$Type = 'Allow') {
  return New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($Sid)), $Rights, $Inheritance, [Security.AccessControl.PropagationFlags]::None, $Type)
}
function Set-PrivateAcl([string]$Path, [bool]$ServiceRead = $false) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $ownerSid) | Select-Object -Unique) {
    $acl.AddAccessRule((New-Rule $sid 'FullControl' 'ContainerInherit, ObjectInherit'))
  }
  if ($ServiceRead) { $acl.AddAccessRule((New-Rule $backup.account.sid 'ReadAndExecute' 'ContainerInherit, ObjectInherit')) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Set-InheritedAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($false, $false)
  foreach ($rule in @($acl.Access | Where-Object { -not $_.IsInherited })) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Save-Backup { Write-Json $backupPath $backup }
function Restore-Installation {
  $recordedAccount = Get-LocalAccount $backup.account.name
  Assert-AccountIdentity $recordedAccount $backup.account
  $task = Get-Task $backup.task.name
  if ($task) { Assert-TaskIdentity $task $backup.task }
  # Validate every identity and path before stopping or changing anything.
  foreach ($record in @($backup.runtimeAcls)) {
    $path = Normalize-Path $record.path
    if ($path -ne $Root -and -not $path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup contains an ACL outside the recorded runtime.' }
  }
  foreach ($path in @($backup.createdDirectories)) {
    if ($path -ne $Root -and -not $path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup contains an unrecorded created directory.' }
  }
  foreach ($record in @($backup.protectedAcls)) {
    if ((Normalize-Path $record.path) -notin @($backup.protectedPaths)) { throw 'Backup contains an unrecorded protected path.' }
  }
  $ownedProcesses = @()
  $processManifest = Join-Path $Root 'state/processes.json'
  if (Test-Path -LiteralPath $processManifest -PathType Leaf) {
    $manifest = Read-Json $processManifest
    if ($manifest.runtimeId -ne $backup.runtimeId) { throw 'Process manifest belongs to another runtime.' }
    foreach ($role in @('game', 'tunnel')) {
      $record = $manifest.$role
      if (-not $record) { continue }
      $expectedExecutable = Join-Path $Root $(if ($role -eq 'game') { 'bin/node.exe' } else { 'bin/cloudflared.exe' })
      if ($record.executable -ne $expectedExecutable) { throw 'Recorded runtime executable identity does not match this installation.' }
      $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
      if ($process -and $process.Path -eq $expectedExecutable -and $process.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt) { [void]$process.Handle; $ownedProcesses += $process }
    }
  }
  if ($ownedProcesses.Count -gt 0 -and -not $task) { throw 'A recorded runtime process is still running without its task. Isolation was left installed.' }
  if ($task) {
    if ($task.State -in @(2, 4)) { $task.Stop(0) }
    for ($attempt = 0; $attempt -lt 50 -and $task.State -in @(2, 4); $attempt++) { Start-Sleep -Milliseconds 100 }
    if ($task.State -in @(2, 4)) { throw 'The isolated task did not stop; isolation was left installed.' }
    foreach ($process in $ownedProcesses) { if (-not $process.WaitForExit(10000)) { throw 'A recorded runtime process did not stop; isolation was left installed.' } }
    (Get-TaskFolder).DeleteTask($backup.task.name, 0)
  }
  # Parent ACLs propagate first; the saved child descriptors then restore exact exceptions.
  foreach ($record in @($backup.protectedAcls) + @($backup.runtimeAcls | Sort-Object { $_.path.Length })) {
    if (Test-Path -LiteralPath $record.path) {
      $acl = Get-Acl -LiteralPath $record.path
      $acl.SetSecurityDescriptorSddlForm($record.sddl)
      Set-Acl -LiteralPath $record.path -AclObject $acl
    }
  }
  foreach ($path in @($backup.createdDirectories | Sort-Object Length)) {
    if (Test-Path -LiteralPath $path -PathType Container) { Set-InheritedAcl $path }
  }
  if ($backup.isolationOriginal.existed) {
    [IO.File]::WriteAllBytes($isolationPath, [Convert]::FromBase64String($backup.isolationOriginal.bytes))
  } elseif (Test-Path -LiteralPath $isolationPath -PathType Leaf) { Remove-Item -LiteralPath $isolationPath -Force }
  if ($recordedAccount) {
    Set-BatchLogonRight $recordedAccount.SID.Value $false
    Remove-LocalUser -SID $recordedAccount.SID
  }
  $folder = Get-TaskFolder
  if ($folder) {
    if ($backup.taskFolder.existed) { $folder.SetSecurityDescriptor($backup.taskFolder.sddl, 0) }
    elseif ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) { $taskService.GetFolder('\').DeleteFolder('XiangWa', 0) }
  }
  # The rollback record remains for audit, marked so another Restore cannot remove replacements.
  $backup.restored = $true
  Save-Backup
}

try {
  $Root = Normalize-Path $Root
  if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { throw 'Runtime is not deployed. Run deploy-runtime.ps1 first.' }
  $settings = Read-Json $settingsPath
  if ($settings.format -ne 1 -or (Normalize-Path $settings.root) -ne $Root) { throw 'Runtime directory identity does not match.' }
  [void][guid]::Parse($settings.runtimeId)
  $taskName = 'runtime-' + $settings.runtimeId
  $description = 'XiangWa ' + $settings.runtimeId
  $taskService = New-Object -ComObject 'Schedule.Service'
  $taskService.Connect()
  if ($Action -eq 'Status') {
    $configuration = if (Test-Path -LiteralPath $isolationPath -PathType Leaf) { Read-Json $isolationPath } else { $null }
    $enabled = [bool]($configuration -and $configuration.enabled)
    if ($enabled) {
      if ($configuration.runtimeId -ne $settings.runtimeId -or $configuration.taskName -ne $taskName -or $configuration.taskPath -ne $taskPath) { throw 'Isolation configuration belongs to another runtime.' }
      $account = Get-LocalAccount (($configuration.accountName -split '\\')[-1])
      Assert-AccountIdentity $account ([pscustomobject]@{ sid = $configuration.sid; description = $description })
      if (-not $account) { throw 'The isolated local account is missing.' }
      $task = Get-Task $taskName
      if (-not $task) { throw 'The isolated scheduled task is missing.' }
      $result = @{ enabled = $true; accountName = $configuration.accountName; sid = $configuration.sid; runtimeId = $settings.runtimeId; taskPath = $taskPath; taskName = $taskName; running = $task.State -eq 4 }
    } else { $result = @{ enabled = $false; runtimeId = $settings.runtimeId; running = $false } }
  } else {
    Assert-Administrator
    $setupLock = [IO.File]::Open((Join-Path $Root 'config/isolation-setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if ($Action -eq 'Restore') {
      if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { throw 'No isolation backup exists; no permissions or accounts were changed.' }
      $backup = Read-Json $backupPath
      if ($backup.format -ne 1 -or $backup.runtimeId -ne $settings.runtimeId -or (Normalize-Path $backup.root) -ne $Root -or $backup.ownerSid -ne $ownerSid) { throw 'Isolation backup identity does not match this runtime and owner.' }
      if (-not $backup.restored) { Restore-Installation }
      $result = @{ enabled = $false; restored = $true; dataPreserved = $true; runtimeId = $settings.runtimeId }
    } else {
      Assert-Stopped
      if (Test-Path -LiteralPath $isolationPath -PathType Leaf) { throw 'An isolation configuration already exists. Restore it before installing again.' }
      if (Get-LocalAccount $AccountName) { throw 'The requested local account already exists; choose a new account name.' }
      if (Get-Task $taskName) { throw 'The requested scheduled task already exists; it was left untouched.' }
      if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        $previous = Read-Json $backupPath
        if (-not $previous.restored) { throw 'An unfinished isolation installation has a backup. Run Restore first.' }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $Root 'runtime.ps1') -PathType Leaf)) { throw 'The runtime controller script is missing.' }
      $runtimeItems = @((Get-Item -LiteralPath $Root)) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
      if ($runtimeItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'The runtime contains a reparse point. Remove it before isolating.' }
      $normalizedProtected = @()
      $volumeRoots = @()
      foreach ($candidate in $ProtectedVolumeRoots) {
        $volumeRoot = Normalize-Path $candidate
        if ($volumeRoot -ne [IO.Path]::GetPathRoot($volumeRoot) -or $volumeRoot -eq [IO.Path]::GetPathRoot($env:WINDIR)) { throw 'Only explicitly selected non-system drive roots may be protected.' }
        $drive = New-Object IO.DriveInfo($volumeRoot)
        if ($drive.DriveFormat -ne 'NTFS') { throw 'Protected drive roots must use NTFS.' }
        if ($Root.StartsWith($volumeRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Parent $Root).TrimEnd('\') -ne $volumeRoot.TrimEnd('\')) { throw 'A runtime on a protected drive must be directly inside that drive root.' }
        if ($volumeRoot -notin $volumeRoots) { $volumeRoots += $volumeRoot; $normalizedProtected += $volumeRoot }
        foreach ($item in Get-ChildItem -LiteralPath $volumeRoot -Force) {
          if ($item.FullName -eq $Root -or $item.Name -in @('System Volume Information', '$RECYCLE.BIN', 'Recovery', 'Config.Msi') -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
          if ($item.FullName -notin $normalizedProtected) { $normalizedProtected += $item.FullName }
        }
      }
      foreach ($candidate in $ProtectedPaths) {
        if (-not $candidate) { continue }
        $path = Normalize-Path $candidate
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Protected directory does not exist: $path" }
        if ($path -eq $Root -or $path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A protected directory may not be inside the runtime.' }
        if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A protected directory may not be a reparse point.' }
        if ($path -notin $normalizedProtected) { $normalizedProtected += $path }
      }
      $folder = Get-TaskFolder
      $taskIdentity = [pscustomobject]@{ name = $taskName; sid = $null; description = $description; executable = (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'); arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'runtime.ps1') + '" -Action Start -Root "' + $Root + '" -Worker') }
      $backup = [pscustomobject][ordered]@{
        format = 1; runtimeId = $settings.runtimeId; root = $Root; ownerSid = $ownerSid; restored = $false
        runtimeIdentity = $settings; account = [pscustomobject]@{ name = $AccountName; sid = $null; description = $description }
        task = $taskIdentity; taskFolder = [pscustomobject]@{ existed = [bool]$folder; sddl = $(if ($folder) { $folder.GetSecurityDescriptor(7) } else { $null }) }
        protectedPaths = @($normalizedProtected); protectedAcls = @($normalizedProtected | ForEach-Object { Get-AclRecord $_ })
        volumeRoots = @($volumeRoots)
        runtimeAcls = @($runtimeItems | ForEach-Object { Get-AclRecord $_.FullName })
        createdDirectories = @(@('data', 'logs', 'state', 'config/admin') | ForEach-Object { Join-Path $Root $_ } | Where-Object { -not (Test-Path -LiteralPath $_) })
        isolationOriginal = [pscustomobject]@{ existed = $false; bytes = $null }
      }
      [void](New-Item -ItemType Directory -Path $adminPath -Force)
      Save-Backup
      Set-PrivateAcl $adminPath
      try {
        Write-Json $isolationPath ([ordered]@{ format = 1; enabled = $false; runtimeId = $settings.runtimeId })
        $random = New-Object byte[] 48
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        $accountPassword = 'aA1!' + [Convert]::ToBase64String($random)
        $password = ConvertTo-SecureString $accountPassword -AsPlainText -Force
        try { $account = New-LocalUser -Name $AccountName -Password $password -Description $description -PasswordNeverExpires -UserMayNotChangePassword }
        finally { $password = $null; [Array]::Clear($random, 0, $random.Length) }
        $backup.account.sid = $account.SID.Value
        $backup.task.sid = $account.SID.Value
        Save-Backup
        $users = Get-LocalGroup -SID 'S-1-5-32-545'
        Add-LocalGroupMember -Group $users -Member $account
        Set-BatchLogonRight $account.SID.Value $true
        foreach ($group in Get-LocalGroup) {
          if ($group.SID.Value -ne 'S-1-5-32-545' -and (Get-LocalGroupMember -Group $group -ErrorAction Stop | Where-Object { $_.SID.Value -eq $account.SID.Value })) { throw 'The dedicated account unexpectedly belongs to a privileged or custom group.' }
        }
        foreach ($path in $normalizedProtected) {
          $acl = Get-Acl -LiteralPath $path
          if ($path -in $volumeRoots) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($account.SID, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Deny)
          } else {
            $inheritance = if (Test-Path -LiteralPath $path -PathType Container) { 'ContainerInherit, ObjectInherit' } else { 'None' }
            $rule = New-Rule $account.SID.Value 'FullControl' $inheritance 'Deny'
          }
          $acl.AddAccessRule($rule)
          Set-Acl -LiteralPath $path -AclObject $acl
        }
        Set-PrivateAcl $Root $true
        foreach ($item in @($runtimeItems | Where-Object { $_.FullName -ne $Root } | Sort-Object { $_.FullName.Length })) { Set-InheritedAcl $item.FullName }
        foreach ($relative in @('data', 'logs', 'state')) {
          $path = Join-Path $Root $relative
          [void](New-Item -ItemType Directory -Path $path -Force)
          $acl = Get-Acl -LiteralPath $path
          $acl.AddAccessRule((New-Rule $account.SID.Value 'Modify' 'ContainerInherit, ObjectInherit'))
          Set-Acl -LiteralPath $path -AclObject $acl
        }
        Set-PrivateAcl $adminPath
        $security = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;' + $ownerSid + ')'
        if (-not $folder) { $folder = $taskService.GetFolder('\').CreateFolder('XiangWa', $security) }
        else { $folder.SetSecurityDescriptor($security, 0) }
        $definition = $taskService.NewTask(0)
        $definition.RegistrationInfo.Description = $description
        $taskAccount = $env:COMPUTERNAME + '\' + $AccountName
        $definition.Principal.UserId = $taskAccount
        $definition.Principal.LogonType = 2
        $definition.Principal.RunLevel = 0
        $definition.Settings.Enabled = $true
        $definition.Settings.AllowDemandStart = $true
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.MultipleInstances = 2
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.AllowHardTerminate = $true
        $definition.Settings.Hidden = $true
        $taskAction = $definition.Actions.Create(0)
        $taskAction.Path = $taskIdentity.executable
        $taskAction.Arguments = $taskIdentity.arguments
        $taskAction.WorkingDirectory = $Root
        # CREATE + DONT_ADD_PRINCIPAL_ACE: only the owner and administrators control this task.
        # S4U stores no password. Windows still requires the new user's password
        # in memory to authorize registering another user's S4U task.
        try { [void]$folder.RegisterTaskDefinition($taskName, $definition, 18, $taskAccount, $accountPassword, 2, $security) }
        finally { $accountPassword = $null }
        $registered = Get-Task $taskName
        Assert-TaskIdentity $registered $backup.task
        if ($registered.Definition.Triggers.Count -ne 0 -or $registered.Definition.Settings.ExecutionTimeLimit -ne 'PT0S' -or -not $registered.Definition.Settings.AllowDemandStart) { throw 'The registered task settings could not be verified.' }
        $configuration = [ordered]@{ format = 1; enabled = $true; accountName = ($env:COMPUTERNAME + '\' + $AccountName); sid = $account.SID.Value; ownerSid = $ownerSid; taskPath = $taskPath; taskName = $taskName; runtimeId = $settings.runtimeId }
        Write-Json $isolationPath $configuration
        $result = @{ enabled = $true; accountName = $configuration.accountName; sid = $configuration.sid; taskPath = $taskPath; taskName = $taskName; runtimeId = $settings.runtimeId; dataPreserved = $true }
      } catch {
        $installError = $_.Exception.Message + ' (setup line ' + $_.InvocationInfo.ScriptLineNumber + ')'
        try { Restore-Installation } catch { throw ($installError + ' Automatic restore could not finish: ' + $_.Exception.Message + '. The protected backup was preserved for Restore.') }
        throw ($installError + ' Installation changes were restored; saved data was preserved.')
      }
    }
  }
  if ($Json) { Write-Output ($result | ConvertTo-Json -Depth 8 -Compress) }
  else { Write-Output ($result | ConvertTo-Json -Depth 8) }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { $accountPassword = $null; if ($setupLock) { $setupLock.Dispose() } }
