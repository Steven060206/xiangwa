param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4173,
  [string]$GameHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$urlHost = if ($GameHost.Contains(':')) { "[$GameHost]" } else { $GameHost }
$baseUrl = "http://${urlHost}:$Port"
try {
  $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 5
  if ($health.ok -ne $true) { throw 'Unexpected health response.' }
} catch {
  throw "Game service is not ready at $baseUrl. Start it first, then run this script again. $($_.Exception.Message)"
}

if ($env:CLOUDFLARED_BIN) {
  $cloudflared = $env:CLOUDFLARED_BIN
  if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
    throw "CLOUDFLARED_BIN does not point to a file: $cloudflared"
  }
} elseif ($installed = Get-Command cloudflared.exe -CommandType Application -ErrorAction SilentlyContinue) {
  $cloudflared = $installed.Source
} else {
  $directory = Join-Path $env:LOCALAPPDATA 'XiangWa'
  $cloudflared = Join-Path $directory 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $download = "$cloudflared.download"
    try {
      Write-Host 'Downloading cloudflared from the official Cloudflare GitHub release...'
      Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $download
      Move-Item -LiteralPath $download -Destination $cloudflared -Force
    } finally {
      if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    }
  }
}

Write-Host "Sharing the running game at $baseUrl. Keep this window open; press Ctrl+C to stop sharing."
Write-Host 'Open the https://...trycloudflare.com URL printed below. Polling sync is selected automatically.'
$quickConfig = [System.IO.Path]::GetTempFileName()
try {
  Set-Content -LiteralPath $quickConfig -Value '{}' -Encoding ASCII
  & $cloudflared tunnel --config $quickConfig --no-autoupdate --protocol http2 --url $baseUrl
  $tunnelExitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $quickConfig -Force
}
exit $tunnelExitCode
