const {app, BrowserWindow, ipcMain, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Zip = require('adm-zip');

// This is an offline UI acceptance test.  The renderer still executes the
// production code, but every https request is answered by a deterministic
// fixture below.  Download archives are served from a local HTTP fixture
// server so Service.installOnline exercises its real extraction/install path.
const appRoot = process.env.XYCUT_TEST_APP_ROOT
  ? path.resolve(process.env.XYCUT_TEST_APP_ROOT)
  : path.resolve(__dirname, '..');
const root = path.resolve(__dirname, '../.test-data/ai-settings-ui');
const runRoot = path.join(root, crypto.randomUUID());
const dataDir = path.join(runRoot, 'data');
const resources = process.env.XYCUT_TEST_APP_ROOT
  ? path.join(path.dirname(appRoot), 'xycut')
  : path.join(appRoot, 'resources');
const {Service} = require(path.join(appRoot, 'backend/service.cjs'));
const {startServer} = require(path.join(appRoot, 'backend/server.cjs'));
const {read, write} = require(path.join(appRoot, 'backend/util.cjs'));

app.setPath('userData', path.join(runRoot, 'electron'));
app.disableHardwareAcceleration();

let window;
let local;
let files;
const commands = [];
const commandErrors = [];
const httpsRequests = [];
const fixtureDownloads = [];
const consoleErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const service = new Service({resources, dataDir});

async function evaluate(code) {
  try {
    return await window.webContents.executeJavaScript(code);
  } catch (error) {
    let body = '';
    try { body = await window.webContents.executeJavaScript('document.body.innerText'); } catch {}
    throw new Error(`${error.message}\nExpression: ${code}\nPage: ${body}`);
  }
}

async function waitFor(code, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(code)) return;
    await delay(100);
  }
  throw new Error(`等待失败：${label}\n${await evaluate('document.body.innerText')}`);
}

async function clickExact(label, scope = 'document') {
  const compact = String(label).replace(/\s/g, '');
  const scopeExpression = scope === 'document' ? 'document' : `document.querySelector(${JSON.stringify(scope)})`;
  await evaluate(`(()=>{
    const button=[...${scopeExpression}.querySelectorAll('button')]
      .find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(compact)}&&e.getClientRects().length);
    if(!button||button.disabled)throw new Error('按钮不可用：'+${JSON.stringify(label)});
    button.click();
  })()`);
  await delay(120);
}

async function clickContaining(text, scope = 'document') {
  const scopeExpression = scope === 'document' ? 'document' : `document.querySelector(${JSON.stringify(scope)})`;
  await evaluate(`(()=>{
    const button=[...${scopeExpression}.querySelectorAll('button')]
      .find(e=>e.textContent.includes(${JSON.stringify(text)} )&&e.getClientRects().length);
    if(!button||button.disabled)throw new Error('按钮不可用：'+${JSON.stringify(text)});
    button.click();
  })()`);
  await delay(120);
}

function makePackage(source, slug) {
  const zip = new Zip();
  zip.addLocalFolder(source, 'fixture');
  return {slug, bytes: zip.toBuffer(), sha256: crypto.createHash('sha256').update(zip.toBuffer()).digest('hex')};
}

async function main() {
  fs.mkdirSync(root, {recursive: true});
  const sourceA = path.join(resources, 'builtin-presets', 'xycut_001');
  const sourceB = path.join(resources, 'builtin-presets', 'xycut_002');
  assert.ok(fs.existsSync(sourceA), `缺少离线预设夹具：${sourceA}`);
  assert.ok(fs.existsSync(sourceB), `缺少离线预设夹具：${sourceB}`);
  const records = [
    {id: 'fixture-ai-standard-hei-01', slug: 'fixture-ai-standard-hei-01', name: 'AI 黑体重点字幕 01', source: sourceA},
    {id: 'fixture-ai-standard-hei-02', slug: 'fixture-ai-standard-hei-02', name: 'AI 黑体重点字幕 02', source: sourceB},
  ].map(item => ({...item, package: makePackage(item.source, item.slug)}));
  const bySlug = new Map(records.map(item => [item.slug, item]));

  files = http.createServer((request, response) => {
    const slug = decodeURIComponent(request.url.replace(/^\//, ''));
    const item = bySlug.get(slug);
    if (!item) {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('fixture download not found');
      return;
    }
    fixtureDownloads.push({slug, method: request.method});
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': item.package.bytes.length,
      'Cache-Control': 'no-store',
    });
    response.end(item.package.bytes);
  });
  await new Promise(resolve => files.listen(0, '127.0.0.1', resolve));
  const downloadBase = `http://127.0.0.1:${files.address().port}`;

  // The renderer has a hard-coded https://yushe.neirongpai.com base.  Handle
  // the https protocol before loading the page and refuse any unknown route,
  // making accidental live-provider calls fail the test immediately.
  await session.defaultSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    httpsRequests.push({host: url.host, path: url.pathname, method: request.method});
    if (url.host !== 'yushe.neirongpai.com') {
      throw new Error(`离线验收拒绝未知 HTTPS 主机：${url.host}`);
    }
    if (url.pathname === '/api/app-config') {
      return new Response(JSON.stringify({features: {membership_enabled: true}, membership_enabled: true}), {
        headers: {'Content-Type': 'application/json'},
      });
    }
    if (url.pathname === '/api/presets') {
      return new Response(JSON.stringify({
        presets: records.map(item => ({
          id: item.id,
          slug: item.slug,
          name: item.name,
          tags: ['AI适配标准黑', 'AI剪辑', 'fixture'],
          category_ids: ['free'],
          member_only: false,
          ai_editing_ready: true,
          size_bytes: item.package.bytes.length,
          sha256: item.package.sha256,
        })),
        pagination: {page: 1, page_size: 100, total: records.length},
        category_options: [],
      }), {headers: {'Content-Type': 'application/json'}});
    }
    if (url.pathname === '/api/templates/download') {
      let input = {};
      try { input = await request.json(); } catch {}
      const item = bySlug.get(String(input.slug || ''));
      if (!item) return new Response(JSON.stringify({message: 'fixture slug not found'}), {status: 404, headers: {'Content-Type': 'application/json'}});
      return new Response(JSON.stringify({
        download_url: `${downloadBase}/${encodeURIComponent(item.slug)}`,
        sha256: item.package.sha256,
        allowed: true,
        credit_cost: 0,
      }), {headers: {'Content-Type': 'application/json'}});
    }
    if (url.pathname === '/api/pay/products') {
      return new Response(JSON.stringify({products: [], channels: {}}), {headers: {'Content-Type': 'application/json'}});
    }
    // No login, billing, update, upload, or AI provider is needed.  Returning
    // an explicit fixture response keeps those calls offline and observable.
    if (url.pathname === '/api/auth/me') {
      return new Response(JSON.stringify({message: 'fixture is logged out'}), {status: 401, headers: {'Content-Type': 'application/json'}});
    }
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ok: true, presets: [], pagination: {page: 1, page_size: 100, total: 0}}), {headers: {'Content-Type': 'application/json'}});
    }
    return new Response(JSON.stringify({ok: true}), {headers: {'Content-Type': 'application/json'}});
  });

  local = await startServer(service, {port: 0});
  await service.context();
  service.desktop = {
    invokePlugin: async (name, args = {}) => {
      if (name === 'plugin:app|version') return '0.2.10';
      if (name === 'plugin:app|name') return 'XYCut';
      if (name === 'plugin:resources|close') return;
      if (name.startsWith('plugin:window|')) {
        const command = name.split('|')[1];
        const bounds = window?.getBounds?.() || {width: 1100, height: 900};
        const size = args.value?.Logical || args.value?.Physical || args.value || args.size || {};
        const handlers = {
          is_maximized: () => !!window?.isMaximized(),
          is_minimized: () => !!window?.isMinimized(),
          is_visible: () => !!window?.isVisible(),
          is_focused: () => !!window?.isFocused(),
          scale_factor: () => 1,
          inner_size: () => ({width: bounds.width, height: bounds.height}),
          outer_size: () => ({width: bounds.width, height: bounds.height}),
          current_monitor: () => ({name: 'Fixture', size: {width: 1920, height: 1080}, position: {x: 0, y: 0}, scaleFactor: 1}),
          set_size: () => window?.setSize(Math.round(size.width || 1100), Math.round(size.height || 900)),
          set_min_size: () => window?.setMinimumSize(Math.round(size.width || 500), Math.round(size.height || 400)),
          set_resizable: () => window?.setResizable(Boolean(args.value)),
          set_decorations: () => {},
          set_title: () => {},
          show: () => window?.show(),
          hide: () => window?.hide(),
          set_focus: () => window?.focus(),
          center: () => window?.center(),
          minimize: () => window?.minimize(),
          maximize: () => window?.maximize(),
          unmaximize: () => window?.unmaximize(),
          toggle_maximize: () => window?.isMaximized() ? window.unmaximize() : window?.maximize(),
        };
        if (handlers[command]) return handlers[command]();
        throw new Error(`界面测试没有授权此桌面调用：${name}`);
      }
      throw new Error(`界面测试没有授权此插件调用：${name}`);
    },
    openPath: async file => file,
    restartJianying: async () => '离线验收未启动剪映',
  };

  window = new BrowserWindow({
    width: 1100,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(appRoot, 'desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', details => {
    if (details.level === 'error') consoleErrors.push(details.message);
  });
  ipcMain.handle('xycut:invoke', async (event, name, args = {}) => {
    assert.equal(event.sender, window.webContents);
    commands.push({name, args});
    try {
      return await service.invoke(name, args);
    } catch (error) {
      commandErrors.push({name, message: error.message});
      throw error;
    }
  });

  await window.loadURL(local.url);
  await waitFor('document.body.innerText.length > 100', '首页加载');
  // Keep AI editing enabled so the settings page exposes the production flow.
  await evaluate(`localStorage.setItem('xiaoyuan.aiEditingEnabled','true')`);
  await window.loadURL(local.url);
  await waitFor('document.body.innerText.length > 100', '首页重新加载');

  // F-21: choose one AI text theme and install all fixture records returned
  // by the recommendation endpoint.  This goes through the real renderer ->
  // IPC -> Service.installOnline path and records every resulting artifact.
  await clickExact('AI 剪辑');
  await waitFor('!!document.querySelector(".ai-editing-settings-tab")', 'AI 剪辑页面');
  await clickExact('剪辑设置');
  await waitFor('!![...document.querySelectorAll("button")].find(e=>e.textContent.includes("AI 剪辑推荐预设"))', '推荐预设设置卡');
  await clickContaining('AI 剪辑推荐预设');
  await waitFor('!!document.querySelector(".ai-recommended-theme-modal")', '推荐预设主题弹窗');
  await clickContaining('标准黑', '.ai-theme-grid');
  assert.equal(await evaluate('document.querySelector(".ai-theme-card.active")?.textContent.trim()'), '标准黑');
  await clickExact('开始安装', '.ai-recommended-theme-modal');
  await waitFor('!document.querySelector(".ai-recommended-theme-modal")', '推荐预设安装完成', 30000);

  const installCommands = commands.filter(item => item.name === 'install_online_preset');
  assert.equal(installCommands.length, records.length, '每个推荐文字预设都应经过真实安装命令');
  assert.deepEqual(new Set(fixtureDownloads.map(item => item.slug)), new Set(records.map(item => item.slug)));
  assert.equal(fixtureDownloads.length, records.length, '下载次数应与推荐预设数量一致');
  const cache = await service.invoke('scan_online_preset_cache');
  const cachePaths = records.map(item => cache[item.slug]);
  assert.equal(cachePaths.filter(Boolean).length, records.length, '扫描缓存应返回全部安装项');
  assert.ok(cachePaths.every(file => fs.existsSync(file)), '每个安装项都应真实落盘');
  const diskPresets = service.presets(path.join(dataDir, 'presets'));
  assert.equal(diskPresets.length, records.length, '磁盘预设数量应与推荐下载数量一致');
  assert.deepEqual(new Set(diskPresets.map(item => item.folder_name)), new Set(records.map(item => item.slug)));
  await waitFor(`document.querySelectorAll('.settings-overview-card').length>0&&[...document.querySelectorAll('.settings-overview-card')].some(e=>e.textContent.includes('已下载 ${records.length} 个'))`, '推荐预设已下载数量');

  // Gh/Ph persist this group through the existing favorite-index flow.  Wait
  // for the renderer effect that calls update_agent_api_context to finish.
  const favoriteFile = path.join(dataDir, 'favorite-index.json');
  const favoriteDeadline = Date.now() + 12000;
  let favoriteIndex = {};
  while (Date.now() < favoriteDeadline) {
    favoriteIndex = read(favoriteFile, {});
    const group = (favoriteIndex.groups || []).find(item => item.id === 'ai-editing-presets');
    if (group && records.every(item => (group.preset_ids || []).includes(`online:${item.id}`))) break;
    await delay(120);
  }
  const favoriteGroup = (favoriteIndex.groups || []).find(item => item.id === 'ai-editing-presets');
  assert.ok(favoriteGroup, '应建立 AI 剪辑预设收藏组');
  assert.deepEqual(new Set(favoriteGroup.preset_ids || []), new Set(records.map(item => `online:${item.id}`)));
  const favoriteState = await service.invoke('load_local_favorite_preset_index');
  assert.deepEqual(new Set((favoriteState.groups.find(item => item.id === 'ai-editing-presets') || {}).preset_ids || []), new Set(records.map(item => `online:${item.id}`)));

  // F-20: set a non-default value in the real nested settings dialog.  The
  // state is persisted in localStorage and the same setting is forwarded to
  // the Agent context as source_trim.video_head_ms.
  await clickContaining('素材开头跳过');
  await waitFor('!!document.querySelector(".video-head-trim-options")', '素材开头跳过设置弹窗');
  await clickExact('1 秒', '.video-head-trim-options');
  assert.equal(await evaluate('document.querySelector(".video-head-trim-options button.active")?.textContent.trim()'), '1 秒');
  await clickExact('完成', '.video-editing-setting-modal');
  await waitFor(`(()=>{try{return JSON.parse(localStorage.getItem('xiaoyuan.videoEditingSettings')||'{}').materialVideoHeadTrimMs===1000}catch{return false}})()`, '素材开头跳过 localStorage 保存');
  const contextDeadline = Date.now() + 12000;
  while (Date.now() < contextDeadline && read(path.join(dataDir, 'agent-context.json'), {}).video_editing_settings?.source_trim?.video_head_ms !== 1000) await delay(120);
  const localSettings = await evaluate('JSON.parse(localStorage.getItem("xiaoyuan.videoEditingSettings"))');
  const agentContext = read(path.join(dataDir, 'agent-context.json'), {});
  assert.equal(localSettings.materialVideoHeadTrimMs, 1000);
  assert.equal(agentContext.video_editing_settings?.source_trim?.video_head_ms, 1000);
  assert.equal(agentContext.video_editing_settings?.source_trim?.apply_to, 'matched_broll_video');

  const report = {
    build_id: read(path.join(resources, 'restoration-build.json')).id,
    app_root: appRoot,
    resources,
    ok: true,
    requirements: ['F-21', 'F-20'],
    ai_recommended_install: {
      theme: 'standard-hei',
      fixture_catalog_count: records.length,
      downloaded_count: fixtureDownloads.length,
      installed_command_count: installCommands.length,
      disk_preset_count: diskPresets.length,
      favorite_count: favoriteGroup.preset_ids.length,
      downloaded_count_matches_disk: fixtureDownloads.length === diskPresets.length,
      downloaded_count_matches_favorites: fixtureDownloads.length === favoriteGroup.preset_ids.length,
      paths_exist: cachePaths.every(file => fs.existsSync(file)),
    },
    material_head_trim: {
      selected_ms: 1000,
      local_storage_saved: localSettings.materialVideoHeadTrimMs === 1000,
      agent_context_saved: agentContext.video_editing_settings?.source_trim?.video_head_ms === 1000,
      apply_to: agentContext.video_editing_settings?.source_trim?.apply_to,
    },
    paid_or_live_provider_calls: false,
    https_fixture_only: true,
    https_requests: httpsRequests,
    fixture_downloads: fixtureDownloads,
    commands,
    command_errors: commandErrors,
    console_errors: consoleErrors,
  };
  write(path.join(root, 'ai-settings-ui-report.json'), report);
  console.log(JSON.stringify(report));
}

function finish(code) {
  try { files?.close(); } catch {}
  try { local?.server.close(); } catch {}
  try { window?.destroy(); } catch {}
  app.exit(code);
}

app.whenReady().then(main).then(() => finish(0)).catch(error => {
  const report = {ok: false, message: error.message, stack: error.stack, https_requests: httpsRequests, fixture_downloads: fixtureDownloads, commands, command_errors: commandErrors, console_errors: consoleErrors};
  try { write(path.join(root, 'ai-settings-ui-report.json'), report); } catch {}
  console.error(error);
  finish(1);
});
