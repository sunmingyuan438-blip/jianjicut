# XYCut Mac 版验收提示词

你是 XYCut Mac 版验收测试员。请在 macOS 13 或更高版本上完成以下测试，不要登录，不要购买积分，不要调用真实 AI 生成服务；只验证本地功能和离线 smoke 流程。

## 一、获取安装包

优先使用仓库脚本获取预编译包。脚本会下载分片、自动拼接并校验 SHA-256：

```bash
curl -fsSL https://raw.githubusercontent.com/sunmingyuan438-blip/jianjicut/main/scripts/download-mac-test-package.sh -o download-mac-test-package.sh
chmod +x download-mac-test-package.sh
./download-mac-test-package.sh arm64   # Apple Silicon M1/M2/M3/M4
# Intel Mac 使用：./download-mac-test-package.sh x64
```

脚本完成后解压生成的 ZIP。Apple Silicon 使用 `XYCut-restored-0.2.10-macOS-arm64-TEST.zip`，Intel 使用 `XYCut-restored-0.2.10-macOS-x64-TEST.zip`。

## 二、启动

1. 解压 ZIP 到本地目录，不要从压缩包内直接运行。
2. 打开“终端”，进入解压目录。
3. 执行：

   ```bash
   chmod +x "首次准备并启动.command" "运行验收.command"
   ```

4. 执行：

   ```bash
   ./首次准备并启动.command
   ```

   等待“XYCut 恢复版”窗口打开，确认首页能显示：首页、AI 剪辑、爆款模板、素材库、在线预设、本地预设、收藏、设置。

5. 关闭无关终端进程，回到同一目录执行：

   ```bash
   ./运行验收.command
   ```

   该脚本会先退出已打开的 XYCut，再执行自动验收。

## 三、必须检查

- 首页和上述 8 个导航页可以打开。
- 设置页可以看到剪映草稿目录、预设目录、AI 剪辑开关、素材开头跳过设置。
- 爆款模板和视频模板页面可以打开；不要点击真实付费或真实生成。
- 素材库页面可以创建、进入、删除测试素材库。
- 托盘菜单可以打开 XYCut、退出 XYCut；Mac 菜单栏和退出行为正常。
- Finder 中可以打开应用；如果 macOS 第一次提示安全确认，按系统提示选择“打开”。
- `./运行验收.command` 结束后检查 `验收记录/desktop-smoke.json`，确认其中 `"pass": true`。
- 检查 `验收记录/screenshots/` 是否生成 8 个页面截图。

## 四、结果回传

请返回：

1. Mac 型号和芯片（例如 MacBook Pro M2）。
2. macOS 版本。
3. 使用的是 arm64 还是 x64 包。
4. `验收记录/desktop-smoke.json` 的完整内容。
5. 如果失败，附上 `验收记录/mac-preparation.log` 和终端完整错误文本。
6. 可选：说明是否能打开剪映，以及是否能在剪映中打开生成的 `draft_content.json` 对应草稿。

不要删除验收记录目录，不要把任何 API Key、Cookie、登录令牌或个人文件上传到 GitHub。

