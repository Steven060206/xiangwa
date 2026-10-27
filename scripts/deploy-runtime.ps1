param(
  [string]$Root = 'C:\Games\XiangWa',
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 65535)][int]$Port = 4175,
  [string]$EntryFile = (Join-Path $env:LOCALAPPDATA 'XiangWa/fixed-entry.json'),
  [string]$NodeBinary = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source,
  [string]$TunnelBinary = '',
  [switch]$NoShortcuts,
  [switch]$NoDesktopShortcuts
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
if ($Root -eq [IO.Path]::GetPathRoot($Root).TrimEnd('\') -or $Root -eq $SourceRoot -or $Root.StartsWith($SourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Choose a separate runtime directory outside the development project.'
}
function Copy-FileBytes([string]$Source, [string]$Destination) {
  # Fresh output files receive the runtime directory's attributes, not source EFS metadata.
  # The byte stream also keeps credentials opaque; never parse or print their contents.
  $temporary = $Destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $inputStream = $null
  $outputStream = $null
  try {
    $inputStream = [IO.File]::OpenRead($Source)
    $outputStream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $inputStream.CopyTo($outputStream)
    $outputStream.Flush($true)
    $outputStream.Dispose()
    $outputStream = $null
    $inputStream.Dispose()
    $inputStream = $null
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
  } finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
  }
}
function Save-Settings {
  $temporary = $settingsPath + '.tmp'
  [IO.File]::WriteAllText($temporary, ($settings | ConvertTo-Json -Depth 5), $utf8)
  Move-Item -LiteralPath $temporary -Destination $settingsPath -Force
}
if (-not $TunnelBinary) {
  if ($env:CLOUDFLARED_BIN) { $TunnelBinary = $env:CLOUDFLARED_BIN }
  elseif ($installed = Get-Command cloudflared.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1) { $TunnelBinary = $installed.Source }
  else { $TunnelBinary = Join-Path $env:LOCALAPPDATA 'XiangWa/cloudflared.exe' }
}
foreach ($required in @($EntryFile, $NodeBinary, $TunnelBinary, (Join-Path $SourceRoot 'server.mjs'), (Join-Path $SourceRoot 'package.json'), (Join-Path $SourceRoot 'scripts/manage-invites.mjs'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}
$entry = Get-Content -LiteralPath $EntryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tunnelId = [guid]::Parse($entry.tunnelId).ToString()
if ($entry.hostname -notmatch '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$') { throw 'Fixed entry hostname is invalid.' }
if (-not (Test-Path -LiteralPath $entry.credentialsFile -PathType Leaf)) { throw 'The configured tunnel credentials file is missing.' }
foreach ($name in @('src', 'public')) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $name) -PathType Container)) { throw "Required directory is missing: $name" }
}
$settingsPath = Join-Path $Root 'config/runtime.json'
$settings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($settings.format -ne 1 -or ([IO.Path]::GetFullPath($settings.root).TrimEnd('\') -ne $Root)) { throw 'Runtime directory identity does not match.' }
  [void][guid]::Parse($settings.runtimeId)
  $isolationPath = Join-Path $Root 'config/isolation.json'
  if (Test-Path -LiteralPath $isolationPath -PathType Leaf) {
    . (Join-Path $PSScriptRoot 'runtime-isolation.ps1')
    $isolation = Get-Content -LiteralPath $isolationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-IsolationConfiguration $settings $isolation $Root
    if ((Get-IsolatedTask $isolation $Root).State -in @(2, 4)) { throw 'Stop this runtime before updating its program files.' }
  }
  $manifestPath = if (Test-Path -LiteralPath (Join-Path $Root 'config/isolation.json')) { Join-Path $Root 'state/processes.json' } else { Join-Path $Root 'config/processes.json' }
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($role in @('game', 'tunnel')) {
      $record = $manifest.$role
      if ($record) {
        $running = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if ($running -and $running.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt -and $running.Path -eq $record.executable) {
          throw 'Stop this runtime before updating its program files.'
        }
      }
    }
  }
} else {
  foreach ($name in @('app', 'bin', 'config')) {
    if (Test-Path -LiteralPath (Join-Path $Root $name)) { throw "Runtime directory contains an unmanaged $name folder. Choose an empty directory." }
  }
}
if (-not $settings) {
  $settings = [pscustomobject][ordered]@{ format = 1; root = $Root; runtimeId = [guid]::NewGuid().ToString(); port = $Port; hostname = $entry.hostname; tunnelId = $tunnelId }
} else {
  $settings.hostname = $entry.hostname
  $settings.tunnelId = $tunnelId
}
# Identify an interrupted initial deployment before copying anything. Retrying keeps its UUID.
[void](New-Item -ItemType Directory -Path (Join-Path $Root 'config') -Force)
$settings | Add-Member -MemberType NoteProperty -Name deploymentReady -Value $false -Force
Save-Settings
foreach ($name in @('app', 'app/scripts', 'bin', 'data', 'logs')) { [void](New-Item -ItemType Directory -Path (Join-Path $Root $name) -Force) }
foreach ($name in @('src', 'public')) {
  Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $Root 'app') -Recurse -Force
}
foreach ($name in @('server.mjs', 'package.json', 'scripts/manage-invites.mjs')) { Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $Root "app/$name") -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime.ps1') -Destination (Join-Path $Root 'runtime.ps1') -Force
foreach ($helper in @('runtime-isolation.ps1', 'setup-isolation.ps1')) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $helper) -PathType Leaf) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $helper) -Destination (Join-Path $Root $helper) -Force }
}
Copy-FileBytes $NodeBinary (Join-Path $Root 'bin/node.exe')
Copy-FileBytes $TunnelBinary (Join-Path $Root 'bin/cloudflared.exe')
$credentialPath = Join-Path $Root 'config/tunnel.json'
Copy-FileBytes $entry.credentialsFile $credentialPath
$sourceSave = Join-Path $SourceRoot 'data/rooms.json'
$targetSave = Join-Path $Root 'data/rooms.json'
if ((Test-Path -LiteralPath $sourceSave -PathType Leaf) -and -not (Test-Path -LiteralPath $targetSave)) { Copy-Item -LiteralPath $sourceSave -Destination $targetSave }
$settings.deploymentReady = $true
Save-Settings

if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  $destinations = @($Root)
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $NoDesktopShortcuts -and $desktop) { $destinations += $desktop }
  foreach ($destination in $destinations) {
    foreach ($item in @(@{ name = '开始联机'; action = 'Start'; extra = ' -OpenBrowser' }, @{ name = '结束联机'; action = 'Stop'; extra = '' }, @{ name = '发放邀请码'; action = 'Invite'; extra = '' })) {
      $shortcutPath = Join-Path $destination ($item.name + '.lnk')
      # Never replace a shortcut that may belong to the user.
      if (-not (Test-Path -LiteralPath $shortcutPath)) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'runtime.ps1') + '" -Root "' + $Root + '" -Action ' + $item.action + ' -Dialog' + $item.extra
        $shortcut.WorkingDirectory = $Root
        $shortcut.WindowStyle = 7
        $shortcut.Description = '箱娃独立运行目录'
        $shortcut.Save()
      }
    }
  }
}
Write-Output "Runtime deployed: $Root"
Write-Output "Fixed entry: https://$($settings.hostname)"
Write-Output "Local port: $($settings.port). Existing runtime data was preserved."
