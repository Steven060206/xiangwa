param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4173,
  [string]$EntryFile = (Join-Path $env:LOCALAPPDATA 'XiangWa/fixed-entry.json')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EntryFile -PathType Leaf)) {
  throw "Fixed entry is not configured: $EntryFile. Complete the Cloudflare tunnel setup first."
}
$entry = Get-Content -LiteralPath $EntryFile -Raw | ConvertFrom-Json
$tunnelId = [guid]::Parse($entry.tunnelId).ToString()
if ($entry.hostname -notmatch '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$') {
  throw 'Fixed entry hostname is invalid.'
}
if (-not (Test-Path -LiteralPath $entry.credentialsFile -PathType Leaf)) {
  throw 'The configured tunnel credentials file is missing. Restore the local Cloudflare tunnel setup.'
}
$baseUrl = "http://127.0.0.1:$Port"
try {
  $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 5
  if ($health.ok -ne $true) { throw 'Unexpected health response.' }
} catch {
  throw "Game service is not ready at $baseUrl. Start it first, then run this script again. $($_.Exception.Message)"
}

if ($env:CLOUDFLARED_BIN) {
  $cloudflared = $env:CLOUDFLARED_BIN
} elseif ($installed = Get-Command cloudflared.exe -CommandType Application -ErrorAction SilentlyContinue) {
  $cloudflared = $installed.Source
} else {
  $cloudflared = Join-Path $env:LOCALAPPDATA 'XiangWa/cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
  throw 'cloudflared was not found. Restore its installation or set CLOUDFLARED_BIN to its path.'
}

# JSON is valid YAML, including Windows paths containing spaces and non-ASCII names.
# Only this hostname reaches the local game; unmatched hosts receive a 404.
$config = @{
  tunnel = $tunnelId
  'credentials-file' = $entry.credentialsFile
  ingress = @(
    @{ hostname = $entry.hostname; service = $baseUrl },
    @{ service = 'http_status:404' }
  )
}
$configPath = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Fixed game entry: https://$($entry.hostname)"
  Write-Host "Connecting to $baseUrl. Keep this window open; press Ctrl+C to stop sharing."
  & $cloudflared tunnel --config $configPath --no-autoupdate --protocol http2 run
  $tunnelExitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $configPath -Force
}
exit $tunnelExitCode
