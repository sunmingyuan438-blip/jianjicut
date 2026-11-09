# 从 GitHub 在 Mac 上测试

GitHub 仓库：<https://github.com/sunmingyuan438-blip/jianjicut>

## 推荐方式：下载 Mac 源码测试包

仓库中的 `downloads/XYCut-restored-0.2.10-mac-source-lite.zip` 是可在 Mac 上继续构建的源码包。它保留了桌面代码、前端、恢复核心、模板和测试脚本；Mac 专用的 Python、Pillow、FFmpeg 和 Electron 会由脚本按 Apple Silicon 或 Intel 架构自动准备。

1. 在 Mac 下载并解压 `XYCut-restored-0.2.10-mac-source-lite.zip`。
2. 打开“终端”，进入解压后的 `xycut-desktop` 目录。
3. 安装 Node.js 22.12 或更高版本、Python 3.9 或更高版本。
4. 执行：

   ```bash
   npm ci
   npm run start:mac
   ```

   这个命令会准备当前 Mac 架构的运行组件并启动应用。

5. 自动验收执行：

   ```bash
   npm run test:mac
   ```

6. 如果需要生成可分发的本地测试包：

   ```bash
   npm run build:mac
   ```

   输出的 ZIP 会在 `dist/` 目录。首次打开时 macOS 可能提示开发者签名确认，请按系统提示选择“打开”。

## 直接使用预编译 Mac 包

Windows 工作区仍保留以下预编译测试包，可通过其他文件传输方式复制到 Mac；它们没有 Developer ID 签名或公证：

- Apple Silicon：`XYCut-restored-0.2.10-macOS-arm64-TEST.zip`
- Intel：`XYCut-restored-0.2.10-macOS-x64-TEST.zip`

解压后先执行：

```bash
chmod +x "首次准备并启动.command" "运行验收.command"
./首次准备并启动.command
./运行验收.command
```

验收规则和结果回传格式见 `MAC_TEST_PROMPT.md`。请把 `验收记录/desktop-smoke.json`、`验收记录/mac-preparation.log` 和终端错误文本保留给开发者，不要上传 API Key、Cookie、登录令牌或个人文件。

## 校验

源码测试包 SHA-256：

```text
f20303d26559b0f8e033c55d4f58340d472b79e9b460505cdb8f4c476d110f05  XYCut-restored-0.2.10-mac-source-lite.zip
```
