# 掌门cut：完整网页界面与本机助手

本包现在包含完整剪辑前端、网页连接桥，以及账户、会员、钱包与模型后端。Mac/Windows 本机助手处理视频、素材、预览和剪映草稿。用户已选择「完整界面＋本机助手」：商店入口访问同域网页，允许连接助手后在浏览器操作；不把 Mac .app 放入 Linux 容器执行，不上传原片到托管端。

网页首次连接需要浏览器本地网络许可及助手的原生确认。仅精确许可的托管 Origin 可请求连接，每个标签页使用内存中的短期会话，关闭助手或断开即失效。OAuth Token 留在既有后端，浏览器桥不接收它。本机媒体使用短期单文件票据；拖入的文件直接写本机助手的独立导入目录。

打包：`node scripts/package-aigzm-cloud.cjs 新输出目录 完整资源目录`。第二个参数目录需含真实 `frontend/index.html`；缺前端或入口模块就拒绝打包。包内包含 `web/frontend/assets/`、`web/app-manifest.json`、网页桥与账户界面，不包含本地数据、凭据、Electron/Python/FFmpeg。Mac助手可用 `node scripts/build-companion-mac.cjs 已验签原应用.app 新助手.app` 生成独立副本并重新签名；Windows的 `build:win` 同样包含本机连接模块和协议注册，需在Windows实机另验。

## 桌面软件下载入口（2026-10-16）

平台入口现采用“下载桌面软件 → 安装 → AI超市账户登录”，网页联动保留在“已安装”展开区。下载目录为 `web/downloads.json`：仅包含已发布版本的 HTTPS URL、字节数、SHA-256、平台与架构；没有实际发布包时不显示可点击的下载按钮。安装包不包含用户数据或登录会话。

完整桌面包超过托管代码 ZIP 的20MB上限，不能与网页后端一起上传。应用所有者已明确允许仅将安装包和校验文件发布到 `sunmingyuan438-blip/jianjicut` 的 GitHub Releases；不提交或推送源码。网页与OAuth后端仍托管于AI超市，安装包由独立下载地址提供。平台页面只能启用与已验证文件一致的下载条目。

Mac 打包脚本：`node scripts/package-desktop-release-mac.cjs 已验证平台应用.app 新输出目录`。脚本复制应用、使用公开平台配置、重新签名、验证ZIP和SHA；发布前另做解压后的资源及签名检查。当前Mac包使用临时签名，未完成Apple公证，应在下载页明示。Windows x64 使用 `scripts/package-desktop-release-win.cjs` 从已校验原生Windows组件与当前源代码生成独立NSIS安装器，公开平台配置且不含凭据。Windows包尚无Authenticode签名，尚未Windows实机安装/启动/登录/草稿验收，下载页明确标示；不得将静态检查视作实机通过。Intel Mac尚未发布。

## 已确认的计费规则

AI 调用经当前用户 OAuth 的 `points.spend`，只扣当前用户平台积分；不使用 Developer API Key，不自行 reserve/confirm/release 积分。本地套模板、素材变更、草稿导出检查会员权限，不发起模型消费。平台套餐托管费是另一项费用。

AI 操作分为 `analyze`、`embedding`、`asr_short`、`asr_long`、`image`。模型映射来自服务端配置，并按实时公开目录校验；不要将多模态模型的“视频”分类理解为支持视频生成。TTS/视频生成尚未接入，不会回退旧供应商收费。语音暂用句段时间戳，未宣称逐字对齐。

## 平台部署约定

选择 `nodejs` 模板。ZIP 第一层直接有 package.json/package-lock.json；平台执行 `npm ci --ignore-scripts`，无需 build，使用 `npm start`。服务监听 `0.0.0.0:$PORT`，默认 8080；`PORT` 和 `DATABASE_URL` 由平台注入，不手动覆盖。应用目录只读，无本地持久文件写入。

`GET /` 返回网页连接入口，连接助手后加载完整剪辑UI；`GET /health` 继续提供JSON就绪状态。应用监听后只在专属 MySQL 库建立自己的 `zhangmen_state` 表；不访问中台用户表。数据库不可用时业务返回503，不放行会员操作或伪造模型成功。更新代码沿用现有首页URL、Client与Secret，不修改会触发重新审核的homepage_url。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `AIGZM_PUBLIC_URL` | 本后端公开 HTTPS 根地址，无路径/查询参数 |
| `AIGZM_API_ORIGIN` | 平台提供的 API Origin |
| `AIGZM_AUTHORIZATION_UI_ORIGIN` | 平台授权页 Origin |
| `AIGZM_ENVIRONMENT` | sandbox 或 production；必须与 Client ID 一致 |
| `AIGZM_CLIENT_ID` | 对应环境的应用 Client ID |
| `AIGZM_CLIENT_SECRET` | 对应环境的 Secret；设置为平台密钥变量 |
| `AIGZM_EXPECTED_ISSUER` | 平台提供的精确 issuer，不能从未验证 Token 推断 |
| `ZHANGMEN_SESSION_KEY` | 固定 32 字节密钥的标准 Base64，设置为平台密钥变量 |
| `ZHANGMEN_MEMBER_POLICY` | 各功能的最低 L0–L4 等级 JSON；缺失项拒绝使用 |
| `ZHANGMEN_MODELS` | AI 操作到实时 model_key 的映射 JSON；缺失项拒绝调用 |
| `ZHANGMEN_DESKTOP_RETURN_URIS` | 精确许可的桌面回环地址 JSON 数组，默认 127.0.0.1:17652/account/sso/callback |
| `AIGZM_BILLING_RETURN_URI` | 平台已登记的充值/会员回跳地址；不配置则不开启充值入口 |

会员策略键：`local_edit`、`template_apply`、`draft_export`、`ai_invoke`。**用户已确认默认规则：local_edit、template_apply、draft_export 均为 L1；ai_invoke 为 L0。**不设置该变量时使用上述规则；显式配置中缺失的功能拒绝使用。应用注册的 min_member_level 应为 0，以允许 L0 用户登录调用 AI。登录检查实时会员和应用使用权益；会员数据不从桌面缓存或 Token 等级快照放行。

模型映射键：`analyze`、`embedding`、`asr_short`、`asr_long`、`image`。先从官方实时模型目录选择，再填入配置；不要使用显示标题作为 model_key。

在生成安全环境中用 `crypto.randomBytes(32).toString('base64')` 创建一次 `ZHANGMEN_SESSION_KEY`，直接存入秘密管理。密钥必须稳定保存；容器重启不能随机重建，否则原会话、任务结果无法解密。修改或轮换前先制定迁移流程。本包没有真实密钥。

## OAuth 与上线顺序

登记 OAuth 回调为本服务 `https://你的域名/auth/callback`，不是桌面回环地址。申请范围：`openid identity membership.read points.read points.spend billing.initiate`。OIDC 校验 RS256/JWKS、issuer、audience、nonce、到期时间和 token_use；身份绑定 `issuer + sub`。

先创建 Sandbox 并完成真实 OAuth 兑换，再申请正式应用。应用与托管分别审核，Sandbox 凭据不能导入正式实例。**Sandbox OAuth 不允许模型调用**；本轮模拟积分测试不能当作真实平台扣费验收。正式扣费验证需正式 active Client、用户授权及明确测试额度。

平台导入 Client Secret 会轮换旧值，不能当作读取现有密钥的无影响操作。需要为后端出站到平台 API/JWKS 配置实际可达网络；涉及外部生图结果域名也需按平台规则核实。

## 请求、重试和恢复

- 桌面只拿独立随机会话。OAuth access/refresh token、PKCE 和任务结果在 MySQL 中 AES-256-GCM 加密；密钥不在数据库。数据库以散列作为索引。
- `/account/status` 读取会员详情和当前钱包；`/account/authorize` 校验本地功能权限，不扣积分。
- `/ai/invoke` 接收 operation/input/task_id/step_id。后端按 issuer/client/sub/task/step 派生稳定幂等键，输入仅保存散列，不记录提示词或音频。任务结果加密保留 30 天，幂等保护不应理解为永久缓存。
- 成功结果可重复读取，不重新调用。余额不足、权限不足、限流或明确 in_progress，可由用户操作后沿用同一任务及输入重试；不生成新扣费键。
- `provider_unknown` 或网络中断的结果封存待核对，不自动换模型或新建任务。超过 20 分钟的未完成任务查询或再次提交时转为待核对。进程被强杀时，平台是否完成消费仍需按原任务/平台记录核对，不能宣称全部自动退款。
- 同一用户可通过 `/ai/task` 查询自己的任务，其他用户不可读取。刷新 Token 使用数据库键锁，多个连接不重复旋转。
- 语音在桌面先提取单声道 MP3，并按最多 10 分钟分段及大小限制提交；服务器不持久化原视频。模型结果不等于完整剪辑任务已交付，后续本机装配可能另有错误。

账户客户端、平台后端和模型 API 均要区分 HTTP 成功与业务 status=success。不要把 HTTP 200 的 failed/provider_unknown 当成成功。

## 当前发布状态与未验证项

截至2026-10-16，原实例7已正式部署，OAuth、L3身份、本人积分扣费及同任务缓存不重扣已实测；完整网页到本机剪映的合成草稿闭环见前轮报告。本轮下载入口已部署，Mac Apple Silicon测试包已发布到GitHub Releases，并经正式网页按钮完整下载、SHA/ZIP/解压验签通过。当前发布tag：`v0.2.10-aigzm-mac-arm64-20261016`。证据见 `.test-data/download-release-20261016/下载发布验收报告.md`。

Windows x64测试包已发布：`v0.2.10-aigzm-windows-x64-20261016`，189127894字节，SHA-256 `5c10c28007ae6819b65fe6229458bf2706cab956166fcfa40ef5c21341ed3636`；安装器重新解包605文件逐SHA检查通过，Windows实机未验。证据见 `.test-data/windows-release-20261016/Windows发布验收报告.md`。

真实会员升降级、模型异常退款、休眠唤醒、Windows实机、Intel新版安装包及Apple公证仍需单独验证或完成。ASR/向量/生图已接平台路由，但本轮未新增付费品质实测；不能把分析扣分成功当作所有功能验收。
