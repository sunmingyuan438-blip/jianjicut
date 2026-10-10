# 从 GitHub 在 Mac 上测试

GitHub 仓库：<https://github.com/sunmingyuan438-blip/jianjicut>

## 推荐方式：下载预编译包直接验收

仓库提供了 Apple Silicon 和 Intel 两个预编译测试包。由于 GitHub 普通文件有大小限制，每个 ZIP 被拆成 6 MB 分片。Mac 上运行下面的下载脚本即可自动下载、拼接并校验对应架构：

```bash
curl -fsSL https://raw.githubusercontent.com/sunmingyuan438-blip/jianjicut/main/scripts/download-mac-test-package.sh -o download-mac-test-package.sh
chmod +x download-mac-test-package.sh
./download-mac-test-package.sh arm64   # M1/M2/M3/M4
# Intel Mac 使用：./download-mac-test-package.sh x64
```

脚本完成后，解压生成的 ZIP，进入解压目录并执行：

```bash
chmod +x "首次准备并启动.command" "运行验收.command"
./首次准备并启动.command
./运行验收.command
```

## 备用方式：下载 Mac 源码测试包

仓库中的 `downloads/XYCut-restored-0.2.10-mac-source-lite.zip` 是完整源码 ZIP；源码包保留了桌面代码、前端、恢复核心、模板和测试脚本。Mac 专用的 Python、Pillow、FFmpeg 和 Electron 会由脚本按 Apple Silicon 或 Intel 架构自动准备。

1. 下载并解压 `XYCut-restored-0.2.10-mac-source-lite.zip`。
2. 进入解压后的 `xycut-desktop` 目录。

   ```bash
   npm ci
   npm run start:mac
   ```

   这个命令会准备当前 Mac 架构的运行组件并启动应用。需要 Node.js 22.12 或更高版本；系统 Python 版本不影响脚本使用的暂存 CPython 3.9。

3. 自动验收执行：

   ```bash
   npm run test:mac
   ```

4. 如果需要生成可分发的本地测试包：

   ```bash
   npm run build:mac
   ```

   输出的 ZIP 会在 `dist/` 目录。首次打开时 macOS 可能提示开发者签名确认，请按系统提示选择“打开”。

验收规则和结果回传格式见 `MAC_TEST_PROMPT.md`。请把 `验收记录/desktop-smoke.json`、`验收记录/mac-preparation.log` 和终端错误文本保留给开发者，不要上传 API Key、Cookie、登录令牌或个人文件。

## 校验

源码测试包 SHA-256 以仓库中的 `downloads/SHA256SUMS.txt` 为准。

