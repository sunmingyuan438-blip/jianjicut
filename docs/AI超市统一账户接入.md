# 掌门cut统一账户接入

当前实现与部署说明以 [AI超市托管部署](AI超市托管部署.md) 为准。此前仅登录、内存会话、本地无需登录的第一阶段方案已废弃，不适用于平台版。

## 已确认规则

- 应用登录门槛 L0；AI 调用 L0 起，扣当前用户自己的 AI 超市积分。
- 本地素材变更、套模板和导出草稿 L1 起。每次操作查询平台会员与应用权益；本地操作本身不扣模型积分。
- 使用 AI 超市 OAuth/OIDC，不另建手机号密码库。身份以 issuer + sub 绑定，不复制中台用户数据库。
- Developer API Key 不用于用户计费；不回退旧供应商 Key。

## 桌面与云端

桌面使用双层 PKCE，通过浏览器登录；OAuth Secret 与 OAuth Token 只在托管服务端。桌面独立会话由 Electron safeStorage 加密保存，系统加密不可用则仅保留内存。

平台版资源配置 account-sso.json：

```json
{"platform_required":true,"broker_url":"https://你的独立托管域名"}
```

桌面仅配置公开地址。当前默认公开地址为 `https://zhangmencut.app.aigzm.com`，显式资源配置可覆盖；资源配置无效、网络故障或会员不足时拒绝受控操作，不会退回个人 Key 或免费通道。历史旧本地版本仍可能保留兼容模式，它不能作为正式平台发行版。

托管入口为 sso/cloud.cjs，使用平台注入环境变量与专属 MySQL。数据库加密保存会话与任务，服务重启后可恢复。sso/broker.cjs 的独立内存启动方式仅用于旧阶段离线测试，不用于生产。

## 2026-10-15 实际接入进度

正式应用与专属Node.js托管实例7 `zhangmencut`均已审核通过。用户确认进阶版1200积分/月，已亲自导入正式Secret，已上传账户/API后端并部署运行。HTTPS `https://zhangmencut.app.aigzm.com/health`返回200且MySQL/ready正常。

独立Mac副本正式OAuth/OIDC登录成功（L3），四项实时功能授权通过。一次合成文字分析实际扣6积分，原任务重放回传缓存且未重复扣分，证据 `.test-data/aigzm-live-20261015_152929/tools/evidence/live-billing.json`。Developer API Key未使用。

## 2026-10-16 当前结果：完整界面＋本机助手、平台统一 API

用户已选定完整网页界面＋本机助手。公网页面已包含实际 React 剪辑界面，素材与剪映留在本机；前轮已实际完成网页到剪映新建合成草稿的闭环，见 `.test-data/aigzm-companion-20261016_095811/网页与本机助手验收报告.md`。旧的“仅账户后端、等待架构选择”状态已废弃。

本轮已部署平台服务设置界面，不再要求个人 API Key；实际读取平台模型目录、会员及积分。Mac 新助手和公网页面均已实际点击验证，当前用户合成分析请求扣 6 积分，原任务重放不再扣分。平台提供分析、ASR、向量及生图路由；配音、声音克隆和素材搜索尚未接通，明确不可用，不回退私人 Key。每次成功模型调用后刷新钱包。

本轮权威产物与证据位于 `.test-data/platform-api-unified-20261016/`：`平台API接入验收报告.md`、`status.json`、`logs/live-billing-result.json`、`logs/public-deployment-verification.json`。新版助手为 `掌门cut本机助手-平台API.app`，同目录 `.command` 可启动；日常旧版 App 未覆盖。

相关测试 39 项中 36 通过、0 失败、3 跳过。Windows 实机、真实 L0 拒绝本地功能、ASR/向量/生图的本轮真实付费输出仍待单独验证；文字扣分成功不代表各类模型质量验收完成。私密备份目录不得打包上传。
