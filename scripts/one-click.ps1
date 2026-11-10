param([switch]$LocalOnly, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$projectRoot = Split-Path -Parent $PSScriptRoot

function Test-Node([string]$Binary) {
  if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { return $false }
  try {
    $major = & $Binary -p 'Number.parseInt(process.versions.node)' 2>$null
    return $LASTEXITCODE -eq 0 -and [int]$major -ge 22
  } catch { return $false }
}

try {
  $nodeBinary = $null
  $installed = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($installed -and (Test-Node $installed.Source)) { $nodeBinary = $installed.Source }
  $cache = Join-Path $env:LOCALAPPDATA 'XiangWa/node'
  $cachedNode = Join-Path $cache 'node.exe'
  if (-not $nodeBinary -and (Test-Node $cachedNode)) { $nodeBinary = $cachedNode }
  if (-not $nodeBinary) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $release = $releases | Where-Object { $_.lts -and $_.version -match '^v(\d+)\.\d+\.\d+$' -and [int]$Matches[1] -ge 22 -and $_.files -contains "win-$architecture-zip" } | Select-Object -First 1
    if (-not $release) { throw 'No supported Node.js LTS download was found.' }
    $name = "node-$($release.version)-win-$architecture"
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('xiangwa-node-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $temporary)
    try {
      Write-Host 'Downloading portable Node.js from nodejs.org (first launch only)...'
      $archive = Join-Path $temporary 'node.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile $archive -TimeoutSec 300
      Expand-Archive -LiteralPath $archive -DestinationPath $temporary
      $downloaded = Join-Path $temporary "$name/node.exe"
      if (-not (Test-Node $downloaded)) { throw 'Downloaded Node.js could not run on this computer.' }
      [void](New-Item -ItemType Directory -Path $cache -Force)
      Copy-Item -LiteralPath $downloaded -Destination $cachedNode -Force
      $nodeBinary = $cachedNode
    } finally {
      if ([IO.Path]::GetDirectoryName($temporary) -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unexpected temporary directory.' }
      Remove-Item -LiteralPath $temporary -Recurse -Force
    }
  }
  $arguments = @((Join-Path $PSScriptRoot 'one-click.mjs'))
  if ($LocalOnly) { $arguments += '--local' }
  if ($NoBrowser) { $arguments += '--no-browser' }
  & $nodeBinary @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host "One-click startup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Check your Internet connection and retry. You can also install Node.js 22+ from https://nodejs.org/ and retry.'
  exit 1
}
