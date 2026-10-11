param(
    [string]$Executable = '',
    [string]$DataRoot = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$managedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.test-data'))
if (!$DataRoot) { $DataRoot = Join-Path $managedRoot 'windows-smoke-r10' }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (!$DataRoot.StartsWith($managedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "验收数据目录必须位于 .test-data 内：$DataRoot"
}
if (!$Executable) {
    $defaultExe = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist/win-unpacked') -Filter '*.exe' -File | Where-Object { $_.Name -like '*XYCut*' } | Select-Object -First 1
    if (!$defaultExe) { throw '找不到 dist/win-unpacked 下的 XYCut 可执行文件。' }
    $Executable = $defaultExe.FullName
}
$Executable = [IO.Path]::GetFullPath($Executable)
if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "找不到 Windows 可执行文件：$Executable" }
$resourcesRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Executable) 'resources/xycut'))
$required = @(
    (Join-Path $resourcesRoot 'frontend/index.html'),
    (Join-Path $resourcesRoot 'core_worker.py'),
    (Join-Path $resourcesRoot 'python/python.exe'),
    (Join-Path $resourcesRoot 'ffmpeg/ffmpeg.exe'),
    (Join-Path $resourcesRoot 'ffmpeg/ffprobe.exe'),
    (Join-Path $resourcesRoot 'agent-kit'),
    (Join-Path $resourcesRoot 'builtin-presets'),
    (Join-Path $resourcesRoot 'draft-shell'),
    (Join-Path $resourcesRoot 'restoration-build.json')
)
$missing = @($required | Where-Object { !(Test-Path -LiteralPath $_) })
if ($missing.Count) { throw "resourcesRoot 不完整：$resourcesRoot；缺少：$($missing -join '; ')" }
$build = Get-Content -LiteralPath (Join-Path $resourcesRoot 'restoration-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$env:XYCUT_DATA_DIR = $DataRoot
$env:XYCUT_PORT = '17662'
$env:XYCUT_RESOURCES = $resourcesRoot
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$stdout = Join-Path $DataRoot 'stdout.log'
$stderr = Join-Path $DataRoot 'stderr.log'
$runtime = [ordered]@{
    resourcesRoot = $resourcesRoot
    python = Join-Path $resourcesRoot 'python/python.exe'
    ffmpeg = Join-Path $resourcesRoot 'ffmpeg/ffmpeg.exe'
    ffprobe = Join-Path $resourcesRoot 'ffmpeg/ffprobe.exe'
    frontend = Join-Path $resourcesRoot 'frontend/index.html'
    coreWorker = Join-Path $resourcesRoot 'core_worker.py'
}
$runtime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'windows-runtime-paths.json') -Encoding UTF8
$process = Start-Process -FilePath $Executable -ArgumentList @('--smoke-test') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$null = $process.Handle
if (!$process.WaitForExit(120000)) { $process.Kill(); throw "Windows smoke 验收超时：$DataRoot" }
$reportPath = Join-Path $DataRoot 'desktop-smoke.json'
if (!(Test-Path -LiteralPath $reportPath)) { throw "验收未生成 desktop-smoke.json；请查看 $stdout 和 $stderr" }
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($process.ExitCode -ne 0 -or !$report.pass -or $report.build_id -ne $build.id) {
    throw "Windows smoke 验收失败：exit=$($process.ExitCode), pass=$($report.pass), build=$($report.build_id), expected=$($build.id)；日志=$DataRoot"
}
$summary = [ordered]@{
    build_id = $report.build_id
    executable = $Executable
    resourcesRoot = $resourcesRoot
    python = $runtime.python
    ffmpeg = $runtime.ffmpeg
    installer_sha256 = if ($Executable -like '*win-unpacked*') { $null } else { (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant() }
    pass = $report.pass
    page_count = @($report.pages | Where-Object found).Count
    screenshots = if (Test-Path (Join-Path $DataRoot 'screenshots')) { @(Get-ChildItem (Join-Path $DataRoot 'screenshots') -Filter '*.png').Count } else { 0 }
    commandErrors = @($report.commandErrors).Count
}
$summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'windows-smoke-summary.json') -Encoding UTF8
$summary | ConvertTo-Json
