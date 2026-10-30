param(
  [ValidateSet('Start', 'Stop', 'Status', 'Invite')][string]$Action = 'Status',
  [string]$Root = $PSScriptRoot,
  [ValidateRange(0.016666666666666666, 168)][double]$Hours = 0.5,
  [ValidateRange(1, 32)][int]$Uses = 5,
  [switch]$List,
  [string]$Revoke = '',
  [switch]$Json,
  [switch]$Dialog,
  [switch]$OpenBrowser,
  [switch]$Worker
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$settingsPath = Join-Path $Root 'config/runtime.json'
$manifestPath = Join-Path $Root 'config/processes.json'
$operationLock = $null
$isolated = $false
$workerProcesses = @()
$workerJob = $null

function Write-JsonFile($Path, $Value) {
  $temporary = $Path + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Read-Manifest {
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $saved = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($saved.runtimeId -ne $settings.runtimeId) { throw 'Process manifest belongs to another runtime.' }
    return $saved
  }
  return [pscustomobject]@{ runtimeId = $settings.runtimeId; game = $null; tunnel = $null }
}
function Get-RecordedProcess($Record, [string]$Role) {
  if (-not $Record) { return $null }
  $process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $expectedExe = if ($Role -eq 'game') { Join-Path $Root 'bin/node.exe' } else { Join-Path $Root 'bin/cloudflared.exe' }
  $expectedArgument = if ($Role -eq 'game') { Join-Path $Root 'app/server.mjs' } elseif ($isolated) { Join-Path $Root 'state/tunnel-run.json' } else { Join-Path $Root 'config/tunnel-run.json' }
  if ($Record.executable -ne $expectedExe -or $Record.argumentPath -ne $expectedArgument -or $process.Path -ne $expectedExe -or $process.StartTime.ToUniversalTime().ToString('o') -ne $Record.startedAt) {
    throw "Recorded $Role PID identity does not match; no unrelated process will be stopped."
  }
  $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
  if (-not $details.CommandLine -or $details.CommandLine.IndexOf($expectedArgument, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Recorded $Role startup path does not match; no unrelated process will be stopped."
  }
  return $process
}
function Save-Record($Process, [string]$Executable, [string]$ArgumentPath) {
  return [pscustomobject]@{ pid = $Process.Id; startedAt = $Process.StartTime.ToUniversalTime().ToString('o'); executable = $Executable; argumentPath = $ArgumentPath }
}
function Get-Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($settings.port)/api/health" -TimeoutSec 1 } catch { return $null }
}
function Assert-Health($Health) {
  if (-not $Health -or $Health.ok -ne $true -or $Health.runtimeId -ne $settings.runtimeId) { throw 'The local game identity does not match this runtime.' }
}
function Assert-FreePort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$settings.port)
  try { $listener.Start() } catch { throw "Port $($settings.port) is already in use. No other service was stopped." }
  finally { $listener.Stop() }
}
function Rotate-Log([string]$Name) {
  $path = Join-Path $Root "logs/$Name"
  if (Test-Path -LiteralPath $path -PathType Leaf) { Move-Item -LiteralPath $path -Destination ($path + '.previous') -Force }
  return $path
}
function Stop-Recorded($Record, [string]$Role) {
  $process = Get-RecordedProcess $Record $Role
  if ($process) {
    Stop-Process -Id $process.Id -Force
    if (-not $process.WaitForExit(10000)) { throw "The $Role process did not stop. The next process was left running." }
  }
}
function Show-Text([string]$Title, [string]$Text) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object Windows.Forms.Form
  $form.Text = $Title
  $form.Size = New-Object Drawing.Size(620, 350)
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $box = New-Object Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.Dock = 'Fill'
  $box.Font = New-Object Drawing.Font('Microsoft YaHei UI', 12)
  $box.Text = $Text
  $copy = New-Object Windows.Forms.Button
  $copy.Text = '复制全部'
  $copy.Dock = 'Bottom'
  $copy.Height = 40
  $copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($box.Text) }.GetNewClosure())
  $form.Controls.Add($box)
  $form.Controls.Add($copy)
  [void]$form.ShowDialog()
  $form.Dispose()
}

try {
  if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { throw 'Runtime is not deployed. Run deploy-runtime.ps1 first.' }
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($settings.format -ne 1 -or ([IO.Path]::GetFullPath($settings.root).TrimEnd('\') -ne $Root)) { throw 'Runtime directory identity does not match.' }
  [void][guid]::Parse($settings.runtimeId)
  [void][guid]::Parse($settings.tunnelId)
  if ($settings.port -lt 1 -or $settings.port -gt 65535) { throw 'Runtime port is invalid.' }
  if ($settings.hostname -notmatch '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$') { throw 'Runtime hostname is invalid.' }
  $isolationPath = Join-Path $Root 'config/isolation.json'
  if (Test-Path -LiteralPath $isolationPath -PathType Leaf) {
    $isolation = Get-Content -LiteralPath $isolationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($isolation.enabled -ne $true) { throw 'Runtime isolation setup is incomplete. Finish setup or restore it before starting.' }
    . (Join-Path $PSScriptRoot 'runtime-isolation.ps1')
    Assert-IsolationConfiguration $settings $isolation $Root
    $isolated = $true
    $manifestPath = Join-Path $Root 'state/processes.json'
    if ($Worker) {
      if ($Action -ne 'Start' -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $isolation.sid) { throw 'The background worker must run as its dedicated ordinary account.' }
      Remove-WorkerTraversePrivilege
      $workerJob = New-Object XiangWa.WorkerJob
      $readyPath = Join-Path $Root 'state/ready.json'
      if (Test-Path -LiteralPath $readyPath -PathType Leaf) { Remove-Item -LiteralPath $readyPath -Force }
    } elseif ($Action -ne 'Invite') {
      $controlLock = [IO.File]::Open((Join-Path $Root 'config/controller.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      try { $result = Invoke-IsolatedControl $Action $settings $isolation $Root } finally { $controlLock.Dispose() }
      if ($OpenBrowser -and $Action -eq 'Start') { Start-Process $result.url }
      if ($Dialog -and $Action -eq 'Stop') { Show-Text '箱娃已结束联机' '联机服务已停止，游戏存档和邀请码记录均已保留。' }
      if ($Json) { Write-Output ($result | ConvertTo-Json -Depth 8 -Compress) }
      elseif ($Action -eq 'Stop') { Write-Output 'Runtime stopped. Saved data was preserved.' }
      else { Write-Output ("Game: {0}; tunnel: {1}; entry: {2}" -f $result.game, $result.tunnel, $result.url) }
      exit 0
    }
  } elseif ($Worker) { throw 'No dedicated worker account is configured.' }
  $lockDirectory = if ($isolated) { 'state' } else { 'config' }
  try { $operationLock = [IO.File]::Open((Join-Path $Root "$lockDirectory/operation.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw 'Another runtime operation is still running. Try again after it finishes.' }
  $manifest = Read-Manifest
  # Check every live PID before changing either process.
  if ($isolated -and -not $Worker) {
    $status = Get-IsolatedStatus $settings $isolation $Root (Get-IsolatedTask $isolation $Root)
    $game = $status.game
    $tunnel = $status.tunnel
  } else {
    $game = Get-RecordedProcess $manifest.game 'game'
    $tunnel = Get-RecordedProcess $manifest.tunnel 'tunnel'
  }

  if ($Action -eq 'Start') {
    if ($settings.deploymentReady -eq $false) { throw 'Runtime deployment is incomplete. Run deploy-runtime.ps1 again before starting.' }
    foreach ($file in @('bin/node.exe', 'bin/cloudflared.exe', 'app/server.mjs', 'config/tunnel.json')) {
      if (-not (Test-Path -LiteralPath (Join-Path $Root $file) -PathType Leaf)) { throw "Runtime file is missing: $file" }
    }
    if ($game) { Assert-Health (Get-Health) }
    else {
      Assert-FreePort
      if ($tunnel) { Stop-Recorded $manifest.tunnel 'tunnel'; $manifest.tunnel = $null; $tunnel = $null; Write-JsonFile $manifestPath $manifest }
      $node = Join-Path $Root 'bin/node.exe'
      $entryPoint = Join-Path $Root 'app/server.mjs'
      $oldEnvironment = @{}
      $runtimeEnvironment = @{ HOST = '127.0.0.1'; PORT = [string]$settings.port; DATA_DIR = (Join-Path $Root 'data'); ACCESS_DIR = (Join-Path $Root 'data'); XIANGWA_RUNTIME_ID = $settings.runtimeId }
      try {
        foreach ($name in $runtimeEnvironment.Keys) { $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $runtimeEnvironment[$name], 'Process') }
        $game = Start-Process -FilePath $node -ArgumentList @('--max-old-space-size=512', ('"' + $entryPoint + '"')) -WorkingDirectory (Join-Path $Root 'app') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Rotate-Log 'game.log') -RedirectStandardError (Rotate-Log 'game-error.log')
        if ($Worker) { $workerProcesses += $game; $workerJob.Add($game.Handle) }
      } finally {
        foreach ($name in $runtimeEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
      }
      $manifest.game = Save-Record $game $node $entryPoint
      Write-JsonFile $manifestPath $manifest
      try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
          if ($game.HasExited) { throw 'Game process exited. Check logs/game-error.log.' }
          $health = Get-Health
          if ($health) { Assert-Health $health; $ready = $true; break }
          Start-Sleep -Milliseconds 200
        }
        if (-not $ready) { throw 'Game startup timed out. Check logs/game-error.log.' }
      } catch {
        Stop-Recorded $manifest.game 'game'
        $manifest.game = $null
        Write-JsonFile $manifestPath $manifest
        throw
      }
    }
    if (-not $tunnel) {
      $configPath = Join-Path $Root "$lockDirectory/tunnel-run.json"
      $config = @{ tunnel = $settings.tunnelId; 'credentials-file' = (Join-Path $Root 'config/tunnel.json'); ingress = @(@{ hostname = $settings.hostname; service = "http://127.0.0.1:$($settings.port)" }, @{ service = 'http_status:404' }) }
      Write-JsonFile $configPath $config
      $binary = Join-Path $Root 'bin/cloudflared.exe'
      $tunnel = Start-Process -FilePath $binary -ArgumentList @('tunnel', '--config', ('"' + $configPath + '"'), '--no-autoupdate', '--protocol', 'http2', 'run') -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Rotate-Log 'tunnel.log') -RedirectStandardError (Rotate-Log 'tunnel-error.log')
      if ($Worker) { $workerProcesses += $tunnel; $workerJob.Add($tunnel.Handle) }
      $manifest.tunnel = Save-Record $tunnel $binary $configPath
      Write-JsonFile $manifestPath $manifest
      Start-Sleep -Milliseconds 500
      if ($tunnel.HasExited) { throw 'Tunnel process exited. Check logs/tunnel-error.log. The local game remains running.' }
    }
    $result = @{ running = $true; game = $true; tunnel = $true; url = "https://$($settings.hostname)"; port = $settings.port }
    if ($Worker) {
      Write-JsonFile $readyPath @{ runtimeId = $settings.runtimeId; gameStartedAt = $manifest.game.startedAt; tunnelStartedAt = $manifest.tunnel.startedAt }
      $operationLock.Dispose()
      $operationLock = $null
      try {
        while (-not $game.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Milliseconds 300 }
      } finally {
        Stop-Recorded $manifest.tunnel 'tunnel'
        Stop-Recorded $manifest.game 'game'
        $manifest.tunnel = $null
        $manifest.game = $null
        Write-JsonFile $manifestPath $manifest
      }
      exit 0
    }
    if ($OpenBrowser) { Start-Process $result.url }
  } elseif ($Action -eq 'Stop') {
    Stop-Recorded $manifest.tunnel 'tunnel'
    $manifest.tunnel = $null
    Write-JsonFile $manifestPath $manifest
    Stop-Recorded $manifest.game 'game'
    $manifest.game = $null
    Write-JsonFile $manifestPath $manifest
    $result = @{ running = $false; game = $false; tunnel = $false; dataPreserved = $true }
    if ($Dialog) { Show-Text '箱娃已结束联机' '联机服务已停止，游戏存档和邀请码记录均已保留。' }
  } elseif ($Action -eq 'Invite') {
    if (-not $game) { throw 'Start this runtime before managing invitation codes.' }
    Assert-Health (Get-Health)
    $arguments = @((Join-Path $Root 'app/scripts/manage-invites.mjs'), '--port', [string]$settings.port, '--directory', (Join-Path $Root 'data'), '--json')
    if ($List) { $arguments += '--list' }
    elseif ($Revoke) { $arguments += @('--revoke', $Revoke) }
    else { $arguments += @('--hours', $Hours.ToString([Globalization.CultureInfo]::InvariantCulture), '--uses', [string]$Uses) }
    $cliOutput = & (Join-Path $Root 'bin/node.exe') @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Invitation management failed. Check the administration tool output.' }
    $cliText = $cliOutput -join "`n"
    # Preserve empty arrays on Windows PowerShell 5, which otherwise enumerates [] to null.
    if ($Json) { Write-Output $cliText; exit 0 }
    $result = $cliText | ConvertFrom-Json
    if (-not $Json) {
      if ($List -or $Revoke) { Show-Text '箱娃邀请码管理' ($result | ConvertTo-Json -Depth 6) }
      else {
        $expiresAt = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::FromUnixTimeMilliseconds([long]$result.expiresAt), [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')).ToString('yyyy-MM-dd HH:mm:ss')
        Show-Text '箱娃限时邀请码' ("网址：https://$($settings.hostname)`r`n`r`n邀请码：$($result.code)`r`n`r`n有效期至：$expiresAt（北京时间）`r`n可用浏览器数：$($result.maxUses)`r`n`r`n同一浏览器再次进入不重复占用次数。关闭联机不会删除已发放的邀请码。")
      }
      exit 0
    }
  } else {
    $healthy = $false
    if ($game) { $health = Get-Health; $healthy = $health -and $health.ok -eq $true -and $health.runtimeId -eq $settings.runtimeId }
    $result = @{ running = [bool]($game -and $tunnel -and $healthy); game = [bool]$game; tunnel = [bool]$tunnel; healthy = [bool]$healthy; port = $settings.port; url = "https://$($settings.hostname)" }
  }
  if ($Json) { Write-Output ($result | ConvertTo-Json -Depth 8 -Compress) }
  elseif ($Action -eq 'Stop') { Write-Output 'Runtime stopped. Saved data was preserved.' }
  else { Write-Output ("Game: {0}; tunnel: {1}; entry: {2}" -f $result.game, $result.tunnel, $result.url) }
} catch {
  if ($Worker -and (Test-Path -LiteralPath (Join-Path $Root 'state') -PathType Container)) {
    [IO.File]::WriteAllText((Join-Path $Root 'state/worker-error.log'), $_.Exception.Message, $utf8)
  }
  if ($Dialog) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, '箱娃联机工具', 'OK', 'Error')
  } else { [Console]::Error.WriteLine($_.Exception.Message) }
  exit 1
} finally {
  if ($workerJob) { $workerJob.Dispose() }
  # Also covers failures before the worker reaches its normal monitoring loop.
  foreach ($child in $workerProcesses) {
    try {
      if (-not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(10000) }
    } catch { [Console]::Error.WriteLine('A worker child could not be stopped: ' + $_.Exception.Message) }
  }
  if ($operationLock) { $operationLock.Dispose() }
}
