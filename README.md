# XYCut 恢复桌面工程 0.2.10

当前构建编号：`20261009-functional-r8`。Windows、两种 Mac 测试包及源码包使用同一份桌面服务代码；验收报告以此编号核对，防止混用旧安装包。

本工程将原客户端取出的 React 界面、Agent Kit、工作台和恢复的 Python 草稿核心接入新的 Electron 桌面容器。Windows 安装包已生成并通过打包后启动检查；macOS Apple Silicon 与 Intel 测试包已生成，尚待 Mac 实机验收。原 Rust 后端使用 Node.js 重新实现，当前不能声明所有功能已经与原软件完全等价。

## 直接运行

Windows 使用 `dist/XYCut-restored-0.2.10-Windows-x64-Setup.exe`，或解压后的 `dist/win-unpacked/XYCut 恢复版.exe`。安装程序已在独立测试目录实际安装，并从安装目录运行验收成功。

Mac 需要 **macOS 13 或更高版本**。M 系列芯片使用 `macOS-arm64-TEST.zip`，Intel 使用 `macOS-x64-TEST.zip`。将 ZIP 复制到 Mac 本机目录并解压；先运行 `首次准备并启动.command`，它会为同目录的测试应用进行本地开发签名并打开应用。这些包尚未经过 Mac 运行验证，也没有 Developer ID 发布签名或公证。

首次准备脚本会验证本地签名，并将系统版本、芯片类型和签名检查结果写入 `验收记录/mac-preparation.log`。运行 Mac 包内的 `运行验收.command`，会在同目录的 `验收记录/` 写入：

- `desktop-smoke.json`：8 个主页面、独立模板预览、豆包连接测试的模拟响应、AI 剪辑开关、SQLite、Pillow、FFmpeg 和真实草稿核心的执行结果，包含本次构建编号。
- `screenshots/`：逐页截图。
- `generated-drafts/`：1 秒可编辑图片与文字草稿，以及删除片段并修改标题/字幕后的实际视频草稿。

验收脚本使用独立目录和端口，不读取原 XYCut 账号配置或现有剪映项目。首次准备脚本启动的应用需要先退出，再运行验收命令。若命令启动失败，可在终端运行该命令并保留错误文本；将 `desktop-smoke.json` 或终端报错提供给开发者继续修复。

## 数据与剪映配置

常规 Windows 数据目录是 `%APPDATA%/XYCut-restored/`；Mac 是 `~/Library/Application Support/XYCut-restored/`。本地服务监听 `127.0.0.1:17652`；原软件使用 17651，可同时保留原安装。

在设置中选择本机预设目录和剪映草稿保存目录。生成草稿时会检查输出目录确实存在。原云端账号、会员、在线资源和 AI 服务继续使用原 API；自己的 API Key 需在恢复版重新填写。AI 外部服务、会员和支付等流程尚未进行实账验收，分享上传仅在用户点击上传后执行。

## 验证记录

Windows 已完成以下验证：

- 74 个功能用例：素材生命周期、SQLite 原 Agent 互通与目录迁移；字幕词锚点、03 多槽、Unicode 高亮、双语时间和毫秒字段；原 Agent 字数计数；向量描述失效与请求/保存数量；预设复制/转换/打包、中文空格路径、HTTP/ZIP 边界、组件维护、手动预设筛选、字幕预设匹配、在线模板路径与审核配置保留、豆包连接契约及 Agent 开关；剪映路径发现、首页记录持久化、缓存/数据清理；豆包 TTS、声音复刻、ASR 的独立输出和失败清理；外部 Agent 图片/视频路径、B-roll 素材开头跳过设置。全部使用独立夹具，外部服务采用模拟响应。
- 开发模式与打包后的 EXE 均打开了原界面的 8 个页面，无桌面 IPC 错误；实际调用 SQLite、Pillow、FFmpeg 和恢复核心，生成图片与文字草稿、带剪辑的视频草稿，并经独立预览页改字后生成。
- 使用原工作台实际执行删词、添加图片素材、修改标题并生成；独立预览页修改标题/字幕、设置重点词、保存并生成，草稿时长和文字与修改结果一致。证据见 `verification/workbench-ui.json` 与截图。
- 使用公开口播模板 `xycut_kb_005` 与爆款模板 `xycut_news_017`，生成了实际视频、可编辑标题/字幕和音频轨道；检查时所有媒体文件存在。
- 同样的两份模板计划分别由原保护核心与恢复核心执行，排除随机 ID、输出目录、按时间生成的名称和创建/更新时间后，整个草稿 JSON 一致。
- 在原 React 的豆包设置弹窗实际点击“测试”，仅 KEY 配置会请求默认多模态向量模型；模拟返回有效向量后显示成功。空 KEY 不请求，无效向量和认证/权限/配额错误有功能测试。此项使用隔离响应，尚未调用真实豆包服务。
- 在原设置页面关闭 AI 剪辑，Agent 生成接口返回 403；重新开启后实际生成草稿。重启后保留默认素材库、预设目录和开关，Agent 上下文使用当前监听端口。
- 剪映预设目录支持选择包含 `Combination/Presets` 的中文/空格安装根目录，也支持直接选择该目录；无效目录不会覆盖已保存配置。Windows/Mac 剪映重启只解析实际存在的安装路径，不会误杀固定进程名。
- 工作台首页记录从磁盘重新读取，缓存和软件数据清理按勾选目录生效；清理后旧记录不会从内存复活。豆包语音命令分别输出 TTS 音频/时间戳、复刻音色音频/时间戳、ASR SRT/逐词 segments，失败路径会清理包含 KEY 的临时上下文。
- 删词后 03 字幕保留原文字槽，重复汉字按具体词编号归属；主/副字幕删除与时段一致，高亮按原核心 Unicode 码点索引重建。实际核心生成两槽重点和双语草稿通过；整槽删空后的自动重选尚未实现，当前提示在预览里重选预设或调整分段。
- 原素材界面两批拖入三层目录、描述编辑、待处理清空、多选重置/删除的取消与确认通过；仅删除有所有权证据的受控副本，原始文件内容保持不变。索引完成计数、重复构建排除及旧向量回写拒绝通过，真实模型仍待验收。

Mac 包检查了 ZIP 完整性、四个主要可执行文件的 CPU 架构、权限和应用最低系统版本。这些静态检查不代表 Mac 运行验证。生成草稿在剪映 Windows/Mac 中打开和编辑、全量模板、全部维护操作和付费服务仍在验收清单中。

## 从源码开发

工程源码交付包含 `resources/`，无需重新安装原 XYCut。开发工具需要 Node.js ≥22.12.0、npm 和 Python ≥3.9；业务核心使用随运行包准备的 CPython 3.9。

Windows 开发和测试：

```text
npm ci
npm run prepare:resources
npm start
npm test
```

Mac 从源码开发和测试使用对应 CPU 的原生运行库：

```text
npm ci
npm run start:mac
npm run test:mac
```

这两个命令自动同步共享资源、下载并校验本机架构的 Electron/Python/Pillow/媒体工具，放入 `.test-data/mac-stage-<arch>/`，通过 `XYCUT_RESOURCES` 启动或测试。源码 ZIP 保留的是 Windows 运行库，不应在 Mac 直接用通用 `npm start` 启动。Mac 源码启动/单测入口路径已静态核对，仍待 Mac 实际执行。

Windows 构建：

```powershell
$env:ELECTRON_BUILDER_CACHE = Join-Path (Get-Location).Path '.test-data/builder-cache'
npm run build:win
```

在 Mac 本机构建对应原生运行库的包：

```text
npm run build:mac
```

该命令分别准备 Apple Silicon/Intel 的原生 Python、Pillow、FFmpeg 与 Electron，校验上游散列后调用 electron-builder，并明确使用本地开发签名。可使用 `node scripts/build-native-mac.cjs arm64` 只构建 Apple Silicon。此原生构建流程仍需 Mac 验证；输出为未公证开发包。Windows 上的 `python scripts/package-mac.py` 使用已生成的 `app.asar` 组装 Mac 测试包。

若 npm 在安装 Electron 时网络失败，Windows 可运行 `python scripts/bootstrap-electron.py`，使用经过官方校验的 ZIP 准备 Electron。`python scripts/bootstrap-pillow.py` 用于补装 Windows 图像库。

历史实验脚本 `verify-original-core.py`、`verify-real-templates.cjs` 和 `verify-workbench-ui.cjs` 还依赖原保护核心或 `.test-data/e2e` 的模板夹具，这些不随源码 ZIP 交付；对应结果在 `verification/` 保留。`npm test` 使用完整资源包中的原脚本和自建夹具；没有原保护核心时，其 Unicode 探针仍校验恢复核心与已记录的原契约。

`backend/` 是重新实现的桌面服务；`desktop/` 是窗口与兼容接口；`scripts/` 是构建与对比工具；`resources/core/` 是恢复的普通 CPython 3.9 字节码加载包。原高层源码的部分候选仍有语义问题，因此运行版使用恢复字节码；原 Rust 源码、TSX、注释和服务器源码没有完整找回。

`recovered-ui/video-template-preview/` 是从原客户端本地 API 取回的独立预览页面，保留原页面的交互代码，嵌入数据和路径改为运行时填充；取回来源和散列记录在同目录 `provenance.json`。

原客户端的生成 API 会使用其已登录账号执行云端授权和计费。一次原客户端接口核对返回扣除 5 积分；此后停止调用该接口。恢复版的自动验收调用本地恢复核心，不读取原客户端账号配置。云端计费等行为仍需要独立验收。

验收状态见 `parity.json`，本次证据见 `verification/`。只有全部必需功能通过两个系统的验收后，才能将恢复目标标记完成。

2026-10-09 收到的开发对接资料包包含 40 项功能要求、12 个验收场景、截图及旧验证快照，没有新增原 Rust、TSX 或服务端源码。资料中的提议补丁未直接执行；工程按现有代码和原界面实现修复。当前逐项证据与未完成项见 `verification/handoff-status.md` 和 `verification/handoff-status.json`；其中的“部分验证”不表示完整等价。



