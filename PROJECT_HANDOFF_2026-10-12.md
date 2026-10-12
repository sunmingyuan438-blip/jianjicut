# XYCut 恢复桌面工程：跨窗口开发对接文档

更新时间：2026-10-12（Asia/Shanghai）  
项目版本：0.2.10  
构建编号：20261009-functional-r8  
GitHub：<https://github.com/sunmingyuan438-blip/jianjicut>  
当前远端 main：06dfdfc68717ac49622bf5abff911a1dbe4f5ebdd

## 1. 继续开发前先读什么

新窗口进入项目后，先阅读本文件，再阅读：

1. README.md
2. GITHUB_WINDOWS_TEST.md
3. GITHUB_MAC_TEST.md
4. MAC_TEST_PROMPT.md
5. restoration-build.json
6. desktop/resources.cjs
7. desktop/main.cjs
8. backend/service.cjs

本项目不是从原始 Rust/TSX 源码完整恢复出来的项目，而是把已经取出的 React 前端、Agent Kit、工作台、恢复的 Python 草稿核心和新的 Electron 容器重新接起来。登录、会员、支付和真实 AI 服务暂时不做。

## 2. 本阶段已经完成的目标

双平台共用一套资源目录和数据目录契约，只有平台运行组件不同：

- Windows 使用 python/python.exe、ffmpeg/ffmpeg.exe、ffmpeg/ffprobe.exe。
- macOS 使用 python/bin/python3.9、ffmpeg/ffmpeg、ffmpeg/ffprobe。
- 前端、核心脚本、Agent Kit、内置预设、草稿壳和构建清单在两个平台使用同一目录结构。
- 所有用户数据、SQLite、缓存、运行时下载和验收截图写入独立 dataRoot，不写入安装目录。
- Electron 主进程会把实际解析出的资源路径写入 runtime-paths.json，smoke 报告也会写入 runtime_paths。

已实现或已覆盖的主要本地能力包括：8 个主页面、素材库 CRUD、SQLite、预设复制与安装、工作台编辑、字幕删字和重点词、双语字幕、草稿生成、Pillow、FFmpeg、恢复核心、视频模板预览、离线豆包协议模拟和 AI 开关。

## 3. 统一资源目录契约

desktop/resources.cjs 是路径解析的唯一入口。解析顺序为：

1. XYCUT_RESOURCES 显式路径。
2. Electron 包内 process.resourcesPath/xycut。
3. 开发目录的 resources/。

有效的 resourcesRoot 必须包含：

~~~text
frontend/index.html
core_worker.py
python/bin/python3.9       # macOS
python/python.exe          # Windows
ffmpeg/ffmpeg              # macOS
ffmpeg/ffprobe             # macOS
ffmpeg/ffmpeg.exe          # Windows
ffmpeg/ffprobe.exe         # Windows
agent-kit/
builtin-presets/
draft-shell/
restoration-build.json
~~~

desktop/main.cjs 启动时调用 resolveResourcesRoot()，验证失败会列出候选目录和缺失文件；不要在业务代码中重新拼接平台路径。

数据目录使用 resolveDataRoot()：

- 有 XYCUT_DATA_DIR 时使用该目录。
- 没有显式目录时使用 Electron 的 appData/XYCut-restored。
- Mac 原生开发测试使用 .test-data/mac-data-<arch>/。
- Windows smoke 使用 .test-data/windows-smoke-r10/。

常用环境变量：

~~~text
XYCUT_RESOURCES
XYCUT_DATA_DIR
XYCUT_PORT=17662
PYTHONDONTWRITEBYTECODE=1
PYTHONIOENCODING=utf-8
~~~

## 4. 关键代码和脚本

| 文件 | 作用 |
| --- | --- |
| desktop/resources.cjs | 统一解析 resourcesRoot、dataRoot 和平台运行组件路径 |
| desktop/main.cjs | Electron 主进程、资源诊断、窗口、服务和 smoke 启动 |
| backend/service.cjs | 本地业务服务、Python/FFmpeg 解析、SQLite、草稿和素材能力 |
| scripts/prepare-resources.cjs | 开发/打包前准备共享前端和核心资源；目标已有内容时不覆盖 |
| scripts/start-native-mac.cjs | Mac 原生运行库准备、Mac 数据目录隔离和 start:mac/test:mac 入口 |
| scripts/package-mac.py | Windows 环境组装 arm64/x64 Mac 测试包 |
| scripts/prepare-mac-test.command | Mac 包首次本地签名并启动 |
| scripts/run-windows-smoke.ps1 | Windows 便携版离线自动验收 |
| scripts/verify-installed-win.ps1 | Windows NSIS 安装目录自动验收 |
| scripts/download-mac-test-package.sh | Mac 下载、拼接和校验 6 MB 分片 |
| scripts/download-windows-test.ps1 | Windows 下载、拼接和校验 6 MB 分片 |
| tests/resources-root.test.cjs | 双平台资源根目录、运行组件和数据根目录测试 |
| tests/service.test.cjs | 服务诊断、Python 缺失错误和业务服务测试 |
| tests/desktop-smoke.cjs | 8 页面和 SQLite/Pillow/FFmpeg/核心/视频/预览 smoke |

## 5. Windows 开发、构建和验收

在 Windows 项目目录执行：

~~~powershell
cd C:\Users\Administrator\Documents\ChatGPT\工作1\xycut-desktop
npm ci
npm run prepare:resources
npm test
~~~

便携版验收：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-windows-smoke.ps1
~~~

成功标准：

- .test-data/windows-smoke-r10/desktop-smoke.json 的 pass 为 true。
- 8 个页面的 found 全部为 true。
- runtime_paths 中的 resources_root、python_path、ffmpeg_path、ffprobe_path 均指向当前包。
- commandErrors 为空。
- screenshots/ 至少有 8 张图片。

重新构建 Windows 安装包：

~~~powershell
$env:ELECTRON_BUILDER_CACHE = Join-Path (Get-Location).Path '.test-data/builder-cache'
npm run build:win
~~~

NSIS 安装版验收：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-installed-win.ps1
~~~

当前已验证的安装包 SHA-256：

~~~text
181bfb85bc4b1754fabe3c06a9e23fcc7d2d06af6f26e46eb5ce864baef354be
~~~

从 GitHub 下载 Windows 安装包分片：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-windows-test.ps1
~~~

脚本读取 downloads/XYCut-windows-package-parts.json，下载 31 个分片并生成安装包。

## 6. macOS 开发、构建和验收

Mac 必须使用本机 Node.js 22.12 或更高版本。不能在 Windows 上执行 npm run start:mac。

源码方式：

~~~bash
npm ci
npm run start:mac
npm run test:mac
~~~

脚本会按 arm64 或 x64 准备原生 Electron、CPython 3.9、Pillow、FFmpeg 和 FFprobe，并把资源放到 .test-data/mac-stage-<arch>/resources，数据放到 .test-data/mac-data-<arch>/。

预编译包方式：

~~~bash
curl -fsSL https://raw.githubusercontent.com/sunmingyuan438-blip/jianjicut/main/scripts/download-mac-test-package.sh -o download-mac-test-package.sh
chmod +x download-mac-test-package.sh
./download-mac-test-package.sh arm64   # Apple Silicon
# Intel Mac 改用：./download-mac-test-package.sh x64
~~~

解压后执行：

~~~bash
chmod +x "首次准备并启动.command" "运行验收.command"
./首次准备并启动.command
~~~

关闭窗口后执行：

~~~bash
./运行验收.command
~~~

成功标准：验收记录/desktop-smoke.json 中 pass 为 true，8 个页面存在，且验收记录/screenshots/ 至少有 8 张截图。

当前 Mac 包校验值：

~~~text
arm64  d7f4103bf3fde0e6b6a037b77c15cddff77db875f4311afb37bf2338cb4cec9d
x64    43a9b23db1cbc60d3f423f0e20145003039784067144a2d35d8c883bbae5c35f
~~~

Mac 包已经在 Windows 上完成 ZIP CRC、包内资源、Mach-O 架构、权限和启动脚本静态检查，并从 GitHub 重新拼接校验过两个架构的完整 ZIP。当前开发窗口没有 Mac 实机，因此最新重组包仍需要在 Mac 上实际运行一次。

## 7. GitHub 交付物

仓库中已经有以下交付物：

- downloads/XYCut-restored-0.2.10-mac-source-lite.zip：自包含源码包。
- downloads/XYCut-restored-0.2.10-macOS-arm64-TEST.zip.part00 至 part28。
- downloads/XYCut-restored-0.2.10-macOS-x64-TEST.zip.part00 至 part33。
- downloads/XYCut-restored-0.2.10-Windows-x64-Setup.exe.part00 至 part30。
- downloads/SHA256SUMS.txt：总包校验值。
- downloads/XYCut-mac-package-parts.json：Mac 分片清单。
- downloads/XYCut-windows-package-parts.json：Windows 分片清单。
- GITHUB_MAC_TEST.md、MAC_TEST_PROMPT.md、GITHUB_WINDOWS_TEST.md：测试说明。

source-lite 最新 SHA-256：

~~~text
338f96e1102fc4b3b7a23ec39c0b7f46a324a38672ac7f17d5ffa189a4af4c6a
~~~

## 8. 当前边界和不要误报的内容

- 不要把登录、会员、支付、真实 AI 服务、真实上传或在线积分调用写成已通过。
- 豆包、TTS、ASR 等当前主要使用隔离 HTTP 模拟响应。
- “素材开头跳过设置”在 0.2.10 中没有稳定的可操作控件；没有证据时必须写“未验证”，不能写“通过”。
- Mac 新包在当前 Windows 开发环境只完成静态检查和远端分片回拼，必须等待 Mac 实机 smoke。
- Windows/Mac 剪映实际打开、编辑、保存、重新打开草稿仍属于后续实机验收。
- 不要把 resources/复制到安装目录之外，也不要让 Python 在安装目录写 __pycache__。
- 不要把个人 Cookie、API Key、登录令牌、素材库或剪映草稿上传到 GitHub。

## 9. 下一窗口建议顺序

### P0：先完成 Mac 实机闭环

1. 下载 arm64 或 x64 包。
2. 解压并运行 首次准备并启动.command。
3. 关闭应用后运行 运行验收.command。
4. 检查 desktop-smoke.json、8 张截图、runtime_paths 和错误日志。
5. 如果失败，保留完整终端输出、验收记录/mac-preparation.log 和验收记录/desktop-smoke.json。

### P1：补齐双端实机差异

1. Windows/Mac 实际打开剪映并打开生成的 draft_content.json。
2. 修改标题、字幕、素材后保存并重新打开。
3. 验证 Mac 素材库拖入、目录迁移、预设安装、剪映重启。
4. 检查 Mac 的 Python、FFmpeg、数据目录是否都落在约定路径。

### P2：产品功能扩展

1. 补充真实 AI 服务配置和权限场景，但不要在测试中自动消耗积分。
2. 如果要实现“素材开头跳过设置”，先补前端控件、IPC 契约和端到端证据，再更新验收文档。
3. 再处理登录、会员、支付、在线资源和自动更新。

## 10. 给下一个 Codex 窗口的启动提示词

复制下面这段作为新窗口的第一条消息：

~~~text
请继续开发 XYCut 恢复桌面工程。先阅读项目根目录的 PROJECT_HANDOFF_2026-10-12.md，再阅读 README.md、GITHUB_WINDOWS_TEST.md、GITHUB_MAC_TEST.md、MAC_TEST_PROMPT.md。不要重新设计资源目录契约；必须继续使用 desktop/resources.cjs 的 resourcesRoot/dataRoot 解析、XYCUT_RESOURCES、XYCUT_DATA_DIR、XYCUT_PORT=17662 和 PYTHONDONTWRITEBYTECODE=1。

当前 GitHub 仓库是 https://github.com/sunmingyuan438-blip/jianjicut，main 最新提交是 06dfdfc68717ac49622bf5abff911a1dbe4f5ebdd，构建编号是 20261009-functional-r8。先检查当前远端和本地文件是否一致，再执行 npm test。下一优先级是 Mac 实机运行最新 arm64/x64 包的首次启动和运行验收；不要把素材开头跳过设置、登录、支付、真实 AI 服务或剪映实机编辑写成已通过。完成每一步都保留日志、desktop-smoke.json 和 runtime_paths。
~~~
