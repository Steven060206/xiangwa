$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Assert-Check {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

$agentsPath = Join-Path $projectRoot 'AGENTS.md'
$docsPath = Join-Path $projectRoot 'docs'
Assert-Check (Test-Path -LiteralPath $agentsPath -PathType Leaf) 'Missing AGENTS.md.'
Assert-Check (Test-Path -LiteralPath $docsPath -PathType Container) 'Missing docs directory.'

$documentFiles = @(Get-Item -LiteralPath $agentsPath)
$ruleDocuments = @(Get-ChildItem -LiteralPath $docsPath -Filter '*.md' -File -Recurse)
Assert-Check ($ruleDocuments.Count -ge 2) 'Expected the rules and map documents.'
$documentFiles += $ruleDocuments

foreach ($document in $documentFiles) {
    $documentText = Get-Content -LiteralPath $document.FullName -Encoding UTF8 -Raw
    Assert-Check (-not [string]::IsNullOrWhiteSpace($documentText)) ('Empty document: ' + $document.Name)
    foreach ($link in [regex]::Matches($documentText, '\[[^\]]*\]\(([^)]+)\)')) {
        $linkTarget = $link.Groups[1].Value.Trim([char[]]'<>').Split('#')[0]
        if ([string]::IsNullOrWhiteSpace($linkTarget) -or $linkTarget -match '^[a-z][a-z0-9+.-]*:') {
            continue
        }
        $resolvedTarget = Join-Path $document.DirectoryName ([Uri]::UnescapeDataString($linkTarget))
        Assert-Check (Test-Path -LiteralPath $resolvedTarget) ('Broken link in ' + $document.Name + ': ' + $linkTarget)
    }
}

$mapPhotos = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'references/maps') -Filter '*.jpg' -File)
$boardPhotos = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'references/components') -Filter '*.jpg' -File)
Assert-Check ($mapPhotos.Count -eq 9) 'Expected exactly nine map reference photos.'
Assert-Check ($boardPhotos.Count -eq 2) 'Expected exactly two auxiliary board photos; update this check when adding references.'

Add-Type -AssemblyName System.Drawing
$referencePhotos = $mapPhotos + $boardPhotos
foreach ($photo in $referencePhotos) {
    $referenceImage = [System.Drawing.Image]::FromFile($photo.FullName)
    try {
        Assert-Check (($referenceImage.Width -gt 0) -and ($referenceImage.Height -gt 0)) ('Invalid image: ' + $photo.Name)
        $referenceImage.GetThumbnailImage(1, 1, $null, [IntPtr]::Zero).Dispose()
    } finally {
        $referenceImage.Dispose()
    }
}

Write-Output ('PASS: {0} Markdown documents, local links, and {1} reference photos verified.' -f $documentFiles.Count, $referencePhotos.Count)
