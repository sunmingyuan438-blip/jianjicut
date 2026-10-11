$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$managedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.test-data'))
$installDir = [IO.Path]::GetFullPath((Join-Path $managedRoot 'installed-app-r10'))
$reportDir = [IO.Path]::GetFullPath((Join-Path $managedRoot 'installer-r10'))
foreach ($target in @($installDir, $reportDir)) {
    if (!$target.StartsWith($managedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "安装测试路径越界：$target"
    }
}
foreach ($target in @($installDir, $reportDir)) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
$registryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
foreach ($registryRoot in $registryRoots) {
    if (Test-Path -LiteralPath $registryRoot) {
        $previous = Get-ChildItem -LiteralPath $registryRoot | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -eq 'XYCut 恢复版' }
        foreach ($item in $previous) {
            if ($item.InstallLocation -and !([IO.Path]::GetFullPath($item.InstallLocation)).StartsWith($managedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw '已有恢复版安装在测试目录以外，请使用独立 Windows 测试环境验证安装。'
            }
        }
    }
}
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = Join-Path $projectRoot ('dist/XYCut-restored-' + $package.version + '-Windows-x64-Setup.exe')
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$installed = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installDir)) -WindowStyle Hidden -PassThru
$null = $installed.Handle
if (!$installed.WaitForExit(60000)) { throw '安装程序在一分钟内没有结束。' }
if ($installed.ExitCode -ne 0) { throw ('安装程序退出码：' + $installed.ExitCode) }
$exeItem = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' -File | Where-Object { $_.Name -like '*XYCut*' -and $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
if (!$exeItem) { throw '安装后的程序不存在。' }
$exe = $exeItem.FullName
$resourcesRoot = [IO.Path]::GetFullPath((Join-Path $installDir 'resources/xycut'))
$required = @((Join-Path $resourcesRoot 'frontend/index.html'), (Join-Path $resourcesRoot 'core_worker.py'), (Join-Path $resourcesRoot 'python/python.exe'), (Join-Path $resourcesRoot 'ffmpeg/ffmpeg.exe'), (Join-Path $resourcesRoot 'ffmpeg/ffprobe.exe'), (Join-Path $resourcesRoot 'restoration-build.json'))
$missing = @($required | Where-Object { !(Test-Path -LiteralPath $_) })
if ($missing.Count) { throw "安装包 resourcesRoot 不完整：$resourcesRoot；缺少：$($missing -join '; ')" }
$env:XYCUT_DATA_DIR = $reportDir
$env:XYCUT_PORT = '17662'
$env:XYCUT_RESOURCES = $resourcesRoot
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$tested = Start-Process -FilePath $exe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $reportDir 'stdout.log') -RedirectStandardError (Join-Path $reportDir 'stderr.log')
$null = $tested.Handle
if (!$tested.WaitForExit(60000)) { $tested.Kill(); throw '安装后的验收在一分钟内没有结束。' }
if ($tested.ExitCode -ne 0) { throw ('安装后验收失败，退出码：' + $tested.ExitCode) }
$report = Get-Content -LiteralPath (Join-Path $reportDir 'desktop-smoke.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$build = Get-Content -LiteralPath (Join-Path $projectRoot 'restoration-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$report.pass -or $report.build_id -ne $build.id) { throw '安装包验收失败或构建编号不匹配。' }
$summary = @{ build_id = $report.build_id; installed_exe = $exe; resourcesRoot = $resourcesRoot; python = Join-Path $resourcesRoot 'python/python.exe'; ffmpeg = Join-Path $resourcesRoot 'ffmpeg/ffmpeg.exe'; installer_sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); pass = $report.pass; page_count = $report.pages.Count; core = $report.integration.core.ok; video = $report.integration.video.ok; preview = $report.integration.preview.ok; doubao_offline = $report.integration.doubao.ok; ai_switch = $report.integration.ai_switch.ok; runtime_paths = $report.runtime_paths }
[IO.File]::WriteAllText((Join-Path $reportDir 'installation.json'), ($summary | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$summary | ConvertTo-Json

