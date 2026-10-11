const fs = require('node:fs');
const path = require('node:path');

function resourceCandidates({env = process.env, resourcesPath = process.resourcesPath, desktopDir = __dirname} = {}) {
  const values = [
    env?.XYCUT_RESOURCES,
    resourcesPath && path.join(resourcesPath, 'xycut'),
    path.resolve(desktopDir, '../resources')
  ].filter(Boolean).map(value => path.resolve(String(value)));
  return [...new Set(values)];
}

function resolveDataRoot({env = process.env, appData, appName = 'XYCut-restored'} = {}) {
  const explicit = env?.XYCUT_DATA_DIR;
  if (explicit) return path.resolve(String(explicit));
  if (!appData) throw new Error('无法确定 XYCut 数据目录：缺少 appData 或 XYCUT_DATA_DIR。');
  return path.resolve(String(appData), appName);
}

function resourceLayout(root, platform = process.platform) {
  const resourcesRoot = path.resolve(root);
  const python = platform === 'win32' ? path.join(resourcesRoot, 'python', 'python.exe') : path.join(resourcesRoot, 'python', 'bin', 'python3.9');
  const suffix = platform === 'win32' ? '.exe' : '';
  return {
    resourcesRoot,
    frontend: path.join(resourcesRoot, 'frontend', 'index.html'),
    coreWorker: path.join(resourcesRoot, 'core_worker.py'),
    python,
    ffmpeg: path.join(resourcesRoot, 'ffmpeg', `ffmpeg${suffix}`),
    ffprobe: path.join(resourcesRoot, 'ffmpeg', `ffprobe${suffix}`),
    agentKit: path.join(resourcesRoot, 'agent-kit'),
    builtinPresets: path.join(resourcesRoot, 'builtin-presets'),
    draftShell: path.join(resourcesRoot, 'draft-shell'),
    buildManifest: path.join(resourcesRoot, 'restoration-build.json')
  };
}

function platformRuntime(resourcesRoot, platform = process.platform) {
  const layout = resourceLayout(resourcesRoot, platform);
  return {python: layout.python, ffmpeg: layout.ffmpeg, ffprobe: layout.ffprobe};
}

function inspectResourceRoot(root, platform = process.platform) {
  const layout = resourceLayout(root, platform);
  const checks = Object.fromEntries(Object.entries(layout).filter(([key]) => key !== 'resourcesRoot').map(([key, file]) => [key, {
    path: file,
    exists: fs.existsSync(file),
    kind: ['agentKit', 'builtinPresets', 'draftShell'].includes(key) ? 'directory' : 'file'
  }]));
  const valid = Object.values(checks).every(item => item.exists);
  return {root: layout.resourcesRoot, valid, checks, ...layout};
}

function formatResourceError(candidates, inspections) {
  const details = inspections.map(item => {
    const missing = Object.values(item.checks).filter(check => !check.exists).map(check => check.path);
    return `${item.root}: ${missing.length ? `缺少 ${missing.join(', ')}` : '可用'}`;
  });
  return `XYCut 资源根目录校验失败。resourcesRoot 候选路径：\n${details.join('\n')}\n候选列表：${candidates.join('; ')}`;
}

function resolveResourcesRoot({env = process.env, resourcesPath = process.resourcesPath, appIsPackaged = false, desktopDir = __dirname, platform = process.platform} = {}) {
  const candidates = resourceCandidates({env, resourcesPath, desktopDir});
  const inspections = candidates.map(root => inspectResourceRoot(root, platform));
  const explicit = env?.XYCUT_RESOURCES ? path.resolve(String(env.XYCUT_RESOURCES)) : null;
  if (explicit) {
    const selected = inspections.find(item => item.root === explicit);
    if (!selected?.valid) throw new Error(formatResourceError(candidates, inspections));
    return {...selected, candidates, inspections, appIsPackaged};
  }
  const selected = inspections.find(item => item.valid);
  if (!selected) throw new Error(formatResourceError(candidates, inspections));
  return {...selected, candidates, inspections, appIsPackaged};
}

module.exports = {resourceCandidates, resolveDataRoot, resourceLayout, platformRuntime, inspectResourceRoot, resolveResourcesRoot};
