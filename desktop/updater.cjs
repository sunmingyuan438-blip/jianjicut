'use strict';
// 掌门cut 桌面端自动更新。
// 更新源只有一个：AI 超市托管站点上的 /downloads.json（与官网下载按钮同一份清单）。
// 安全规则：仅 HTTPS、仅白名单主机、必须有大小与 SHA-256，下载后逐字节校验；
// 渲染进程传来的下载地址一律不信任，只使用主进程自己读取到的清单内容。
// Electron 会把 .asar 文件当成目录处理，复制/删除整个 .app 时必须用 original-fs。
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');

const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_BYTES = 1024 * 1024 * 1024;
const VERSION = /^\d+(?:\.\d+){1,3}$/;

function compareVersions(a, b) {
  const left = String(a).replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const right = String(b).replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function allowedHosts(manifestUrl, allowLocalHttp = false) {
  const hosts = new Set(DOWNLOAD_HOSTS);
  try { hosts.add(new URL(manifestUrl).hostname); } catch {}
  hosts.allowLocalHttp = allowLocalHttp;
  return hosts;
}

// 仅开发模式联调可放行 http://127.0.0.1；打包后的正式版只接受 HTTPS 白名单。
function trustedUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (hosts.allowLocalHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1') return url;
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)) return null;
  return url;
}

// 从清单中挑出当前平台/架构、且比当前版本新的发布；没有则返回 null。
function selectRelease(manifest, {platform, arch, currentVersion, manifestUrl, allowLocalHttp = false}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.releases)) throw new Error('更新清单格式无效');
  const version = String(manifest.version || '');
  if (!VERSION.test(version)) throw new Error('更新清单缺少有效版本号');
  if (compareVersions(version, currentVersion) <= 0) return null;
  const item = manifest.releases.find(r => r && r.platform === platform && r.arch === arch && r.status === 'ready');
  if (!item) return null;
  if (item.version !== undefined && item.version !== version) return null;
  const url = trustedUrl(item.url, allowedHosts(manifestUrl, allowLocalHttp));
  if (!url || !/^[a-f0-9]{64}$/i.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_BYTES) return null;
  const fileName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  const expected = platform === 'win32' ? /\.exe$/i : /\.zip$/i;
  if (!/^[\w.\-]+$/.test(fileName) || !expected.test(fileName)) return null;
  const notes = Array.isArray(manifest.notes) ? manifest.notes.filter(n => typeof n === 'string' && n.trim()).slice(0, 20) : [];
  const minimum = String(manifest.min_supported_version || '');
  const mandatory = manifest.mandatory === true || (VERSION.test(minimum) && compareVersions(currentVersion, minimum) < 0);
  return {version, url: url.href, fileName, bytes: item.bytes, sha256: item.sha256.toLowerCase(), notes, mandatory};
}

// 转成原版前端（恢复的 React 界面）认识的 /api/update 响应格式。
function legacyResponse(release, currentVersion) {
  if (!release) return {enabled: false, latest_version: currentVersion, current_version: currentVersion, notes: []};
  return {enabled: true, latest_version: release.version, current_version: currentVersion, mandatory: release.mandatory, notes: release.notes, download_url: release.url, file_name: release.fileName, sha256: release.sha256};
}

async function fetchManifest(manifestUrl, fetcher = fetch, allowLocalHttp = false) {
  const url = trustedUrl(manifestUrl, allowedHosts(manifestUrl, allowLocalHttp));
  if (!url) throw new Error('更新地址无效');
  const response = await fetcher(url.href + (url.search ? '&' : '?') + 't=' + Date.now(), {cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error('暂时无法获取更新信息（HTTP ' + response.status + '）');
  let manifest;
  try { manifest = await response.json(); } catch { throw new Error('更新信息格式无效'); }
  return manifest;
}

// 流式下载：边写边算哈希，超出声明大小立即中止；最终大小与 SHA-256 都必须一致。
async function downloadVerified(release, destination, {fetcher = fetch, manifestUrl, onProgress, allowLocalHttp = false} = {}) {
  const hosts = allowedHosts(manifestUrl, allowLocalHttp);
  if (!trustedUrl(release.url, hosts)) throw new Error('更新下载地址不在许可范围');
  if (fs.existsSync(destination) && fs.statSync(destination).size === release.bytes && await hashFile(destination) === release.sha256) return destination;
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  const partial = destination + '.part';
  fs.rmSync(partial, {force: true});
  const response = await fetcher(release.url, {redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000)});
  if (!response.ok || !response.body) throw new Error('更新包下载失败（HTTP ' + response.status + '）');
  if (response.url && !trustedUrl(response.url, hosts)) throw new Error('更新包被重定向到不受信任的地址');
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > release.bytes) throw new Error('更新包大小超出预期，已停止下载');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      onProgress?.(received, release.bytes);
    }
    await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
  } catch (error) {
    out.destroy(); fs.rmSync(partial, {force: true}); throw error;
  }
  if (received !== release.bytes) { fs.rmSync(partial, {force: true}); throw new Error('更新包不完整，请重试'); }
  if (hash.digest('hex') !== release.sha256) { fs.rmSync(partial, {force: true}); throw new Error('更新包 SHA-256 校验失败，已删除'); }
  fs.renameSync(partial, destination);
  return destination;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', c => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

function command(binary, args) {
  const result = spawnSync(binary, args, {encoding: 'utf8'});
  if (result.error || result.status !== 0) throw new Error(binary + ' 执行失败：' + (result.stderr || result.error?.message || '').trim());
  return result.stdout.trim();
}

// 当前运行中的 .app 路径；开发模式（没有 app.asar）或 macOS 应用随机化时返回 null。
// 注意：本项目 Mac 包的可执行文件名是 Electron，app.isPackaged 恒为 false，不能拿它判断。
function currentMacApp(execPath, exists = fs.existsSync) {
  const app = path.resolve(execPath, '../../..');
  if (!app.endsWith('.app') || app.includes('/AppTranslocation/') || !exists(path.join(app, 'Contents/Resources/app.asar'))) return null;
  return app;
}

function canReplace(appPath) {
  try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); fs.accessSync(appPath, fs.constants.W_OK); return true; } catch { return false; }
}

// 解压并验证 Mac 新版：签名完整、Bundle ID 一致、包内版本号与清单一致。
function prepareMacUpdate(zipFile, release, {stagingDir, currentApp, run = command, readVersion}) {
  fs.rmSync(stagingDir, {recursive: true, force: true});
  fs.mkdirSync(stagingDir, {recursive: true});
  run('/usr/bin/ditto', ['-x', '-k', zipFile, stagingDir]);
  const found = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) found.push(file);
      else if (entry.isDirectory() && depth < 2) walk(file, depth + 1);
    }
  };
  walk(stagingDir, 0);
  if (found.length !== 1) throw new Error('更新包中未找到唯一的应用程序');
  const nextApp = found[0];
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', nextApp]);
  if (currentApp) {
    const id = file => run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(file, 'Contents/Info.plist')]);
    if (id(nextApp) !== id(currentApp)) throw new Error('更新包的应用标识与当前应用不一致，已拒绝安装');
  }
  const packaged = readVersion(nextApp);
  if (packaged !== release.version) throw new Error(`更新包内版本 ${packaged || '未知'} 与清单版本 ${release.version} 不一致`);
  return nextApp;
}

// 替换脚本在应用退出后运行：等待进程结束 → 旧版移入备份 → 复制新版 → 失败则还原 → 重新打开。
const MAC_SWAP_SCRIPT = `#!/bin/bash
set -u
pid="$1"; target="$2"; next="$3"; backup="$4"; log="$5"
echo "$(date '+%F %T') 等待进程 $pid 退出" >>"$log"
for _ in $(seq 1 240); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$pid" 2>/dev/null; then echo "进程未退出，放弃替换" >>"$log"; exit 1; fi
rm -rf "$backup"
if ! mv "$target" "$backup"; then echo "无法移动旧版本" >>"$log"; exit 1; fi
if /usr/bin/ditto "$next" "$target" && /usr/bin/codesign --verify --deep --strict "$target" 2>>"$log"; then
  echo "替换完成" >>"$log"; rm -rf "$next"
else
  echo "替换失败，正在还原旧版本" >>"$log"; rm -rf "$target"; mv "$backup" "$target"
fi
[ "\${ZHANGMEN_UPDATE_NO_RELAUNCH:-}" = "1" ] || /usr/bin/open "$target"
`;

function scheduleMacSwap({pid, target, next, backup, log, scriptFile, env = process.env}) {
  fs.writeFileSync(scriptFile, MAC_SWAP_SCRIPT, {mode: 0o700});
  const child = spawn('/bin/bash', [scriptFile, String(pid), target, next, backup, log], {detached: true, stdio: 'ignore', env});
  child.unref();
  return child;
}

function isWindowsExecutable(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); return b.toString('ascii') === 'MZ'; } finally { fs.closeSync(fd); }
}

function createUpdater({app, shell, manifestUrl, allowLocalHttp = false, cacheDir, currentVersion, platform = process.platform, arch = process.arch, execPath = process.execPath, fetcher = fetch, run = command, readVersion, quit = () => app.quit()}) {
  let latest = null;
  const updatesDir = path.join(cacheDir, 'updates');
  return {
    currentVersion,
    async check() {
      const manifest = await fetchManifest(manifestUrl, fetcher, allowLocalHttp);
      latest = selectRelease(manifest, {platform, arch, currentVersion, manifestUrl, allowLocalHttp});
      return legacyResponse(latest, currentVersion);
    },
    // args 来自渲染进程，只用来确认用户点的是同一个版本，不用于决定下载地址。
    async install(args = {}) {
      if (!latest || (args.url && args.url !== latest.url)) await this.check();
      if (!latest) throw new Error('当前已是最新版本');
      if (args.url && args.url !== latest.url) throw new Error('更新信息已变化，请重新检查更新');
      const release = latest;
      const file = await downloadVerified(release, path.join(updatesDir, release.version, release.fileName), {fetcher, manifestUrl, allowLocalHttp});
      if (platform === 'win32') {
        if (!isWindowsExecutable(file)) throw new Error('更新包不是有效的 Windows 安装程序');
        spawn(file, [], {detached: true, stdio: 'ignore', windowsHide: false}).unref();
        setTimeout(quit, 1500);
        return {status: 'installer_started', version: release.version, message: '安装向导已打开，掌门cut 将退出以便完成更新。'};
      }
      if (platform === 'darwin') {
        const target = currentMacApp(execPath);
        const next = prepareMacUpdate(file, release, {stagingDir: path.join(updatesDir, release.version, 'staging'), currentApp: target, run, readVersion});
        if (!target || !canReplace(target)) {
          shell?.showItemInFolder(next);
          return {status: 'manual', version: release.version, app_path: next, message: '新版已下载并校验通过。请退出掌门cut，把访达中选中的“掌门cut.app”拖到“应用程序”替换旧版本。'};
        }
        scheduleMacSwap({pid: process.pid, target, next, backup: path.join(updatesDir, 'previous.app'), log: path.join(updatesDir, 'install.log'), scriptFile: path.join(updatesDir, 'swap.sh')});
        setTimeout(quit, 800);
        return {status: 'restarting', version: release.version, message: '新版已校验通过，掌门cut 将自动重启完成更新。'};
      }
      throw new Error('当前系统暂不支持自动更新');
    },
  };
}

module.exports = {compareVersions, selectRelease, legacyResponse, fetchManifest, downloadVerified, prepareMacUpdate, currentMacApp, canReplace, scheduleMacSwap, createUpdater, MAC_SWAP_SCRIPT, DOWNLOAD_HOSTS};
