// Keep the supplied requirement snapshot separate from current verification.
const fs=require('node:fs');
const path=require('node:path');
const {read,write}=require('../backend/util.cjs');
exports.writeStatus=({root,dest,build})=>{
  const source=path.join(root,'reference/handoff-20261009-v1/docs/research/xycut/feishu-reference/development-requirements.json');
  const snapshot=path.join(dest,'handoff-requirements.json');
  if(fs.existsSync(source))fs.copyFileSync(source,snapshot);
  const supplied=read(snapshot);if(supplied.requirements?.length!==40)throw new Error('对接资料要求应为 40 项');
  const evidence={
    'F-01':['中文/空格剪映预设目录和草稿目录分别保存，重启 Service 后真实生成草稿。','preset-paths.test.cjs; service-tests.xml','Windows/Mac 剪映实开编辑保存。'],
    'F-02':['选择安装根目录可自动定位 Combination/Presets，直接目录、非默认路径和无效路径保护均通过。','preset-paths.test.cjs','Windows/Mac 实机全量预设回归。'],
    'F-03':['Windows 原设置界面关闭/开启，关闭时生成接口返回 403；重启配置及真实端口测试通过。','windows-installed-desktop.json; service-tests.xml','Mac 实机、复制提示词的完整流程。'],
    'F-04':['Windows Python 清空/重装、实际 SQLite 与 Pillow 调用通过。','service-tests.xml; windows-installed-desktop.json','首次在线安装和完整维护界面、Mac 实机。'],
    'F-05':['离线 Electron UI 夹具覆盖线上爆款模板列表、安装、复制提示词、失败反馈；配置路径和上下文文件真实存在。','template-ui.json; preset-installation.test.cjs','公开线上目录全量筛选与真实下载、Mac。'],
    'F-06':['Agent 上下文保留默认素材库和预设路径，更新监听端口；不同 KEY 写法识别通过。','service-tests.xml','复制提示词后外部 Agent 的完整交互及 Mac。'],
    'F-07':['内置预设转视频/爆款模板并调用草稿核心通过。','service-tests.xml; windows-installed-desktop.json','全部嵌套模板及两端剪映使用。'],
    'F-08':['两个公开真实模板生成且全部媒体路径存在，原保护核心与恢复核心规范化 JSON 一致。','real-template-drafts.json; original-core-comparison.json','其余模板全部槽位及剪映实开。'],
    'F-09':['转换字数匹配四份原 Agent 原脚本，覆盖 Unicode/空白/ASCII/emoji/多段及边界；原 UI 和核心的独立规则保持原样。','template-chars-contract.json; service-tests.xml','原 native 自动转换 suggest_chars 区间取整规则、完整双端交互。'],
    'F-10':['有实际草稿 JSON、媒体路径和原核心对比证据。','real-template-drafts.json; original-core-comparison.json','两端剪映打开、编辑、保存并重新打开。'],
    'F-11':['离线 Electron UI 夹具覆盖视频模板列表、安装、复制 Agent 提示词和失败反馈，并保留审核配置。','template-ui.json; preset-installation.test.cjs','公开线上目录全量筛选与真实下载、剪映和 Mac。'],
    'F-12':['本地字幕预设匹配命令按普通/重点 style_level、槽位字数和收藏组返回匹配及候选原因。','service-tests.xml; local-preset-and-subtitle.test.cjs','真实剪映字体、样式、时间线和全量预设回归。'],
    'F-13':['本地 HTTP 夹具验证 TTS 2.0 参数数组、资源 ID、音频及时间戳输出；缺 KEY、无音频和 HTTP 错误有清理/失败契约。','speech-contract.test.cjs','用户配置的真实 TTS 服务和剪映音频对齐。'],
    'F-14':['本地 HTTP 夹具验证复刻命令必须显式音色 ID并输出同一音频/时间戳契约；权限错误保留。','speech-contract.test.cjs','用户已开通复刻音色的真实权限/配额。'],
    'F-15':['原工作台删词、保护区和实际波形通过；词范围全删不复活，毫秒/秒目标时刻同步，多父行和文本坐标投影通过。','workbench-ui.json; service-tests.xml','真实 ASR 完整流程、全部组合及两端剪映。'],
    'F-16':['实际核心两槽03、重复汉字按词编号保留槽位、Unicode强调移位及主副字幕删除/时段一致通过。','workbench-ui.json; service-tests.xml','03整槽删空后的自动重选、部分删词后译文语义更新、全部预设组合及两端剪映各层编辑。'],
    'F-17':['同模型向量检索保留高质量素材，按质量阈值排除低质量素材，文件失效后不再返回。','service-tests.xml; material-search-quality.test.cjs','真实模型构建/语义检索、原 Agent 直接重新分析的旧向量失效语义、Mac。'],
    'F-18':['本地 Pexels HTTP 夹具验证搜索、下载和素材路径回填；没有旧 app 目录时仍可完成。','service-tests.xml; network-materials.test.cjs','真实 Pexels API Key、搜索、下载及草稿素材可读取。'],
    'F-19':['外部 Agent 提供的本地图片/视频路径进入真实剪映草稿 JSON，媒体槽通过 material_id 保持可编辑引用。','service-tests.xml; material-generation.test.cjs','真实 Agent 交付流程和剪映实开编辑保存。'],
    'F-20':['视频模板设置保存素材开头跳过毫秒值并同步 Agent context；默认 500、自定义、关闭 0 均验证只影响 B-roll 视频。','service-tests.xml; material-generation.test.cjs; ai-settings-ui.json','Mac 实机设置交互及更多外部素材服务组合。'],
    'F-21':['AI 剪辑推荐预设入口离线夹具完成一键安装，下载数量、磁盘预设和 AI 收藏组数量一致且路径存在。','ai-settings-ui.json','公开推荐目录和真实下载服务。'],
    'F-24':['分析批次只提交未完成来源，保存第一批后下一批自动从剩余来源继续，不重复处理已完成来源。','service-tests.xml; network-materials.test.cjs','Mac 实机和真实模型中断后继续处理。'],
    'F-22':['创建/删除库及 SQLite 状态验证通过。','service-tests.xml; windows-installed-desktop.json','默认库选择和全部界面计数。'],
    'F-23':['原界面两批拖入三层目录、跨批去重通过，原始文件内容保持。','material-ui.json; service-tests.xml','Mac 实机、多文件格式及更大批次交互。'],
    'F-25':['编辑描述/标签/质量及重启后素材访问测试通过。','service-tests.xml','真实分析产生的预览和全部状态。'],
    'F-26':['原 Agent 互通completed计数，编辑失效、异步旧向量拒绝/整批回滚及重复索引排除通过；模型参数与用户KEY模式验证通过。','material-ui.json; service-tests.xml','真实模型构建/语义检索、原 Agent 直接重新分析的旧向量失效语义、Mac。'],
    'F-27':['分类目录索引有功能测试。','service-tests.xml','完整界面及真实模型检索。'],
    'F-28':['导入复制、删除库及目录迁移保留原文件测试通过。','service-tests.xml','全部批量维护组合及 Mac。'],
    'F-29':['目录迁移更新数据库路径并保留原目录测试通过。','service-tests.xml','片段/向量的全部关联及两端重启后完整界面。'],
    'F-30':['Windows 实际 FFmpeg/FFprobe 及清空/重装通过；两种 Mac 二进制架构检查通过。','service-tests.xml; windows-installed-desktop.json; mac-bundle-inspection.json','Mac 执行和首次在线安装完整流程。'],
    'F-31':['原界面待处理清空取消保留，确认只移除pending；已完成素材和原始文件保留。','material-ui.json; service-tests.xml','Mac 实机、异常/并发处理组合。'],
    'F-32':['原界面多选重置/删除取消无写入，确认逐项生效；清空片段与索引，删除受控副本且原始来源保持。','material-ui.json; service-tests.xml','Mac 实机、更多分页/部分失败组合。'],
    'F-33':['本地预设支持专题标签、字体风格、字幕字数、比例、时长筛选和稳定排序，并规范剪映微秒时长。','service-tests.xml; local-preset-and-subtitle.test.cjs','Mac 实机完整筛选/搜索/排序交互及全部预设数据。'],
    'F-34':['在线模板安装返回原界面所需路径，模板配置写入并保留审核槽位；预设缓存和个人剪映目录结构均通过。','template-ui.json; preset-installation.test.cjs','两个目录都出现正确结构与素材；重开剪映后在个人预设和草稿中可使用。'],
    'F-35':['Windows/Mac 剪映路径发现只返回存在的配置或常见安装路径；重启使用解析后的实际路径。','lifecycle-cleanup.test.cjs','Windows/Mac 实机关闭、重启并确认新预设可见。'],
    'F-36':['首页工作台记录磁盘持久化，重启后 URL 使用当前监听端口；清理后旧记录不会从内存复活。','lifecycle-cleanup.test.cjs','打包应用重启后完整 UI 回归。'],
    'F-37':['缓存按勾选分类删除，草稿、素材库和用户原始文件保留。','lifecycle-cleanup.test.cjs','Windows/Mac UI 全量取消/确认组合。'],
    'F-38':['软件数据按勾选目录重置并同步 Python/FFmpeg disabled 状态，取消/未选目录保持。','lifecycle-cleanup.test.cjs','Windows/Mac UI 全量取消/确认组合。'],
    'F-39':['原界面仅 KEY 测试通过；默认模型/向量接口、空 KEY 不请求、无效向量拒绝及服务错误保留通过。全部使用隔离模拟响应。','windows-installed-desktop.json; service-tests.xml','真实账号有效/失效/无权限场景和 Mac 实机。'],
    'F-40':['本地 HTTP 夹具分别验证 TTS、复刻音色、ASR 2.0 的独立 Key/资源 ID/输出；缺 KEY、权限、无结果均可解释且临时凭据清理。','speech-contract.test.cjs','真实语音服务三项权限和 Mac 实机。']
  };
  const requirements=supplied.requirements.map(item=>({id:item.id,name:item.name,acceptance:item.acceptance,source_document:item.source_document,source_block_ids:item.source_block_ids,windows_status:evidence[item.id]?'partially_verified':'pending_full_validation',current_evidence:evidence[item.id]?.[0]||'保留原界面或已有实现；尚未取得足以覆盖该项验收条件的完整执行证据。',evidence_files:evidence[item.id]?.[1]?.split('; ')||[],remaining:evidence[item.id]?.[2]||item.acceptance,macos_status:'pending_device_test',fully_verified:false}));
  const report={build_id:build.id,updated_at:new Date().toISOString(),scope:'Windows 和 macOS 全部功能等价；实现存在或静态打包检查不视为完整验收通过。',source:{name:'XYCut开发对接资料包_v1.0_2026-10-09.zip',sha256:'bf78b4957a383d8c046c3766014faad5b2533a5d2066cf2e8989c17a9551659d',requirement_count:40,acceptance_case_count:12,contents:'说明、截图、要求、既有验证快照和提议补丁；没有新增原 Rust/TSX/服务器源码。',embedded_patch_executed:false},goal_complete:false,requirements,acceptance_cases:Array.from({length:12},(_,i)=>({id:'AT-'+String(i+1).padStart(2,'0'),status:'pending_complete_dual_platform_validation'}))};
  write(path.join(dest,'handoff-status.json'),report);
  const rows=requirements.map(item=>`| ${item.id} | ${item.name} | ${item.current_evidence} | ${item.remaining} |`);
  fs.writeFileSync(path.join(dest,'handoff-status.md'),`# 对接资料当前验收状态\n\n构建：${build.id}。资料包的 40 项功能与 12 个验收场景继续纳入原目标。以下是当前证据；所有项目仍需完整双端验收，Mac 实机结果尚未回传。\n\n资料包 SHA256：${report.source.sha256}。原资料中提议补丁未直接执行；修复在本工程中实现并验证。\n\n| 编号 | 功能 | 当前 Windows 证据 | 仍待验证 |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n逐项证据文件和原文块标识见 handoff-status.json。豆包测试采用隔离响应，尚未调用真实服务；AT-01 至 AT-12 均未标记完整通过。\n`,'utf8');
};
