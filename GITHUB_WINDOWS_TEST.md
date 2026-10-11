# Windows 验收说明

Windows 验收必须使用独立数据目录，不能把个人 `%APPDATA%`、剪映草稿、素材库、Cookie、登录令牌或 API Key 复制到测试包中。当前构建编号是 `20261009-functional-r8`。

在 Windows 开发机进入源码目录后执行：

```powershell
npm ci
npm run prepare:resources
node --check desktop/main.cjs
node --test tests/resources-root.test.cjs tests/service.test.cjs
```

先验证便携构建目录。`resourcesRoot` 必须是 `dist/win-unpacked/resources/xycut`，并包含：

```text
frontend/index.html
core_worker.py
python/python.exe
ffmpeg/ffmpeg.exe
ffmpeg/ffprobe.exe
agent-kit/
builtin-presets/
draft-shell/
restoration-build.json
```

执行离线验收：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-windows-smoke.ps1
```

脚本会自动设置：

```text
XYCUT_DATA_DIR=.test-data/windows-smoke-r10
XYCUT_PORT=17662
XYCUT_RESOURCES=dist/win-unpacked/resources/xycut
PYTHONDONTWRITEBYTECODE=1
```

验收完成后检查：

- `.test-data/windows-smoke-r10/desktop-smoke.json` 中 `pass` 为 `true`。
- `pages` 中 8 个页面的 `found` 均为 `true`。
- `runtime_paths` 显示实际 `resourcesRoot`、Python、FFmpeg 和 FFprobe 路径。
- `commandErrors` 为空，`screenshots/` 至少有 8 张 PNG。
- `windows-smoke-summary.json` 与 `windows-runtime-paths.json` 存在。

如果要验证 NSIS 安装包，先执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-installed-win.ps1
```

该脚本会安装到 `.test-data/installed-app-r10`，只对该隔离目录运行验收，并在 `.test-data/installer-r10` 写入 `installation.json`、`runtime-paths.json`、`desktop-smoke.json`、截图和标准输出/错误日志。当前安装包 SHA-256 为 `181bfb85bc4b1754fabe3c06a9e23fcc7d2d06af6f26e46eb5ce864baef354be`。首次启动或验收失败时，请把这些日志路径和实际 `resourcesRoot` 一并回传。

不要把“素材开头跳过设置”写成已通过，除非设置页存在可操作控件并且 `desktop-smoke.json` 或人工记录中有证据。当前 0.2.10 Mac 报告只确认了素材库 CRUD、8 个页面和离线核心流程。
