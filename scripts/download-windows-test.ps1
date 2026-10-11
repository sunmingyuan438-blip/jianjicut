param(
    [string]$OutputDir = (Join-Path $PSScriptRoot '..\\.test-data\\windows-download')
)
$ErrorActionPreference = 'Stop'
$repo = 'https://raw.githubusercontent.com/sunmingyuan438-blip/jianjicut/main'
$manifestUrl = "$repo/downloads/XYCut-windows-package-parts.json"
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$manifestPath = Join-Path $OutputDir 'manifest.json'
Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl -OutFile $manifestPath
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$partPaths = @()
foreach ($part in $manifest.parts) {
    $partPath = Join-Path $OutputDir $part.file
    Invoke-WebRequest -UseBasicParsing -Uri "$repo/downloads/$($part.file)" -OutFile $partPath
    if ((Get-Item -LiteralPath $partPath).Length -ne [int64]$part.bytes) { throw "分片大小不匹配：$($part.file)" }
    $partPaths += $partPath
}
$artifactPath = Join-Path $OutputDir $manifest.artifact
$stream = [IO.File]::Open($artifactPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    foreach ($partPath in $partPaths) {
        $bytes = [IO.File]::ReadAllBytes($partPath)
        $stream.Write($bytes, 0, $bytes.Length)
    }
} finally { $stream.Dispose() }
$hash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $manifest.sha256) { throw "安装包 SHA-256 不匹配：$hash" }
Write-Output (([ordered]@{artifact=$artifactPath;bytes=(Get-Item $artifactPath).Length;sha256=$hash} | ConvertTo-Json))
