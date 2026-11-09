const fs = require('node:fs');
const path = require('node:path');

// These are the files required by both the desktop server and the bundled
// local runtime. Keep the contract here so development, macOS and Windows
// launchers all validate the same resource tree.
function requiredResources(platform = process.platform) {
  const python = platform === 'win32' ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3.9');
  const suffix = platform === 'win32' ? '.exe' : '';
  return [
    ['frontend/index.html', 'file'],
    ['core_worker.py', 'file'],
    [python, 'file'],
    [path.join('ffmpeg', `ffmpeg${suffix}`), 'file'],
    [path.join('ffmpeg', `ffprobe${suffix}`), 'file'],
    ['agent-kit', 'directory'],
    ['builtin-presets', 'directory'],
    ['draft-shell', 'directory'],
    ['restoration-build.json', 'file'],
  ];
}

function addCandidate(candidates, value, pathModule = path) {
  if (!value) return;
  const resolved = pathModule.resolve(String(value));
  if (!candidates.includes(resolved)) candidates.push(resolved);
}

/**
 * Return candidate resource roots in the order in which Electron documents
 * them. `app.getAppPath()` is used for development and as a packaged fallback;
 * `process.resourcesPath` is the authoritative packaged location.
 */
function resourceCandidates({app, env = process.env, dirname = __dirname, resourcesPath, pathModule = path} = {}) {
  // pathModule defaults to the host implementation; tests pass path.win32 to
  // check Windows drive-letter paths on a Mac host.
  const candidates = [];
  const add = value => addCandidate(candidates, value, pathModule);
  add(env.XYCUT_RESOURCES);
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : null;
  const packaged = app?.isPackaged === true;
  // Electron exposes process.resourcesPath for both packaged launches and
  // direct execution of the Electron binary inside a .app. Do not gate this
  // candidate on app.isPackaged: LaunchServices/direct-binary startup can
  // report false while still pointing at the packaged Resources directory.
  const runtimeResourcesPath = resourcesPath || process.resourcesPath;
  add(runtimeResourcesPath && pathModule.join(runtimeResourcesPath, 'xycut'));
  if (appPath) {
    if (packaged) add(pathModule.join(pathModule.dirname(appPath), 'xycut'));
    add(pathModule.join(appPath, 'resources'));
    add(pathModule.join(appPath, '..', 'resources'));
    if (!packaged) add(pathModule.join(pathModule.dirname(appPath), 'xycut'));
  }
  add(pathModule.join(dirname, '..', 'resources'));
  return candidates;
}

function inspectResourceRoot(root, platform = process.platform) {
  const missing = [];
  for (const [relative, kind] of requiredResources(platform)) {
    const file = path.join(root, relative);
    let valid = false;
    try {
      const stat = fs.statSync(file);
      valid = kind === 'directory' ? stat.isDirectory() : stat.isFile();
    } catch {
      valid = false;
    }
    if (!valid) missing.push(relative);
  }
  return {root, missing, valid: missing.length === 0};
}

function resolveResources(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = resourceCandidates(options);
  const checks = candidates.map(root => inspectResourceRoot(root, platform));
  const selected = checks.find(check => check.valid);
  if (selected) return selected.root;
  const details = checks.map(check => `${check.root}: ${check.missing.length ? `缺少 ${check.missing.join(', ')}` : '可用'}`).join('\n');
  const error = new Error(`XYCut 资源根目录校验失败。候选路径：\n${details || '(无候选路径)'}`);
  error.code = 'XYCUT_RESOURCES_INVALID';
  error.candidates = checks;
  throw error;
}

module.exports = {requiredResources, resourceCandidates, inspectResourceRoot, resolveResources};
