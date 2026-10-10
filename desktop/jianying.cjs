const fs = require('node:fs');
const path = require('node:path');

function unique(items) { return [...new Set(items.filter(Boolean).map(item => path.resolve(String(item))))]; }

function jianyingCandidates({platform = process.platform, env = process.env, settings = {}} = {}) {
  if (platform === 'darwin') {
    const home = env.HOME || '';
    return unique([settings.jianying_app, ...(home ? [path.join(home, 'Applications', '剪映.app'), path.join(home, 'Applications', 'JianyingPro.app')] : []), '/Applications/剪映.app', '/Applications/JianyingPro.app', '/Applications/CapCut.app']);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '', programFiles = env.ProgramFiles || '', programFiles86 = env['ProgramFiles(x86)'] || '';
    return unique([settings.jianying_exe, ...(local ? [path.win32.join(local, 'JianyingPro', 'Apps', 'JianyingPro.exe'), path.win32.join(local, 'JianyingPro', 'JianyingPro.exe')] : []), ...(programFiles ? [path.win32.join(programFiles, 'JianyingPro', 'Apps', 'JianyingPro.exe')] : []), ...(programFiles86 ? [path.win32.join(programFiles86, 'JianyingPro', 'Apps', 'JianyingPro.exe')] : []), 'D:\\JianyingPro\\JianyingPro.exe', 'D:\\JianyingPro\\Apps\\JianyingPro.exe']);
  }
  return unique([settings.jianying_exe]);
}

function resolveJianying(options = {}) {
  const platform = options.platform || process.platform;
  for (const candidate of jianyingCandidates(options)) {
    try {
      const stat = fs.statSync(candidate);
      if ((platform === 'darwin' && stat.isDirectory() && candidate.toLowerCase().endsWith('.app')) || (platform === 'win32' && stat.isFile())) return candidate;
    } catch {}
  }
  return null;
}

function applicationName(appPath) { return path.basename(appPath).replace(/\.app$/i, ''); }

module.exports = {jianyingCandidates, resolveJianying, applicationName};
