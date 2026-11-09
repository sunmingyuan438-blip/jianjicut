const fs = require('node:fs');
const path = require('node:path');

function normalizeCandidate(value, platform) {
  if (!value) return null;
  const text = String(value).trim().replace(/^['"]|['"]$/g, '');
  if (!text) return null;
  if (platform === 'win32' && process.platform !== 'win32' && path.isAbsolute(text)) return path.resolve(text);
  return platform === 'win32' ? path.win32.normalize(text) : path.resolve(text);
}

function unique(items, platform = process.platform) {
  const values = items.map(item => normalizeCandidate(item, platform)).filter(Boolean);
  return [...new Set(values)];
}

function macNames() {
  return ['剪映.app', '剪映专业版.app', 'JianyingPro.app', 'CapCut.app', 'VideoFusion-macOS.app'];
}

function jianyingCandidates({platform = process.platform, env = process.env, settings = {}} = {}) {
  if (platform === 'darwin') {
    const home = env.HOME || '';
    const userApps = home ? macNames().map(name => path.join(home, 'Applications', name)) : [];
    const systemApps = macNames().map(name => path.join('/Applications', name));
    return unique([settings.jianying_app, ...userApps, ...systemApps], platform);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    const roaming = env.APPDATA || '';
    const programFiles = env.ProgramFiles || '';
    const programFiles86 = env['ProgramFiles(x86)'] || '';
    const roots = [local, roaming, programFiles, programFiles86].filter(Boolean);
    const names = ['JianyingPro', '剪映专业版', '剪映'];
    const candidates = [settings.jianying_exe];
    for (const root of roots) for (const name of names) {
      candidates.push(path.win32.join(root, name, 'Apps', 'JianyingPro.exe'));
      candidates.push(path.win32.join(root, name, 'JianyingPro.exe'));
      candidates.push(path.win32.join(root, name, 'Apps', '剪映专业版.exe'));
    }
    candidates.push('D:\\JianyingPro\\JianyingPro.exe', 'D:\\JianyingPro\\Apps\\JianyingPro.exe');
    return unique(candidates, platform);
  }
  return unique([settings.jianying_exe], platform);
}


function draftDirectoryCandidates({platform = process.platform, env = process.env} = {}) {
  if (platform === 'darwin') {
    const home = env.HOME || '';
    if (!home) return [];
    const roots = ['JianyingPro', '剪映专业版', '剪映', 'JIanyingPro'];
    return roots.flatMap(root => [
      path.join(home, 'Movies', root, 'User Data', 'Projects', 'com.lveditor.draft'),
      path.join(home, 'Movies', root, 'User Data', 'JianyingPro Drafts'),
    ]);
  }
  if (platform === 'win32') {
    const home = env.USERPROFILE || '';
    const local = env.LOCALAPPDATA || '';
    return [home, local].filter(Boolean).flatMap(root => [
      path.win32.join(root, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'),
      path.win32.join(root, 'JianyingPro', 'User Data', 'JianyingPro Drafts'),
      path.win32.join(root, '剪映专业版', 'User Data', 'Projects', 'com.lveditor.draft'),
    ]);
  }
  return [];
}

function resolveJianyingDraftDirectory(value, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const configured = normalizeCandidate(value, platform);
  const candidates = unique([configured, ...draftDirectoryCandidates({platform, env})], platform);
  const existing = candidates.filter(candidate => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
  if (!existing.length) return configured || '';
  // Correct the historic macOS JIanyingPro typo when the canonical folder exists.
  if (configured && /[\\/]JIanyingPro[\\/]/.test(configured)) {
    const canonical = existing.find(candidate => /[\\/]JianyingPro[\\/]/.test(candidate));
    if (canonical) return canonical;
  }
  return existing[0];
}

function isValidCandidate(candidate, platform) {
  try {
    const stat = fs.statSync(candidate);
    if (platform === 'darwin') return stat.isDirectory() && /\.app$/i.test(candidate);
    if (platform === 'win32') return stat.isFile() && /\.exe$/i.test(candidate);
  } catch {}
  return false;
}

function inspectJianying(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = jianyingCandidates({...options, platform});
  const existing = candidates.filter(candidate => isValidCandidate(candidate, platform));
  return {
    platform,
    configured_path: normalizeCandidate(options.settings?.jianying_app || options.settings?.jianying_exe, platform) || '',
    candidates,
    existing,
    resolved: existing[0] || '',
    found: existing.length > 0,
  };
}

function resolveJianying(options = {}) { return inspectJianying(options).resolved || null; }

function applicationName(appPath) { return path.basename(appPath).replace(/\.app$/i, ''); }

module.exports = {jianyingCandidates, resolveJianying, inspectJianying, draftDirectoryCandidates, resolveJianyingDraftDirectory, applicationName};
