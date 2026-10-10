const fs = require('node:fs');
const path = require('node:path');
const {spawnSync}=require('node:child_process');
const root = path.resolve(__dirname, '..');
const recovery = path.resolve(root, '../xycut-recovered-0.2.10');
const output = path.join(root, 'resources');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root,'backend/core_worker.py'),path.join(output,'core_worker.py'));
fs.copyFileSync(path.join(root,'restoration-build.json'),path.join(output,'restoration-build.json'));
fs.cpSync(path.join(root,'recovered-ui/video-template-preview'),path.join(output,'video-template-preview'),{recursive:true});
for (const [from, to] of [
  ['recovered/frontend-dist', 'frontend'],
  ['recovered/agent-kit', 'agent-kit'],
  ['recovered/python-restored', 'core'],
  ['recovered/builtin-presets', 'builtin-presets'],
  ['recovered/draft-shell', 'draft-shell'],
]) {
  const source=path.join(recovery,from),target=path.join(output,to);
  if(fs.existsSync(source))fs.cpSync(source,target,{recursive:true,filter:p=>!p.includes('__pycache__')});
  else if(!fs.existsSync(target))throw new Error('缺少恢复资源：'+to+'；请使用包含 resources 的完整工程包');
}
// Recovered scripts remain the baseline; maintained adapters are reapplied after
// copying it so preparing resources cannot silently discard local fixes.
const agentOverrides=path.join(root,'backend/agent-overrides');
if(fs.existsSync(agentOverrides))fs.cpSync(agentOverrides,path.join(output,'agent-kit/skills'),{recursive:true,filter:p=>!p.includes('__pycache__')});
if (process.platform === 'win32') {
  if(fs.existsSync(path.join(recovery,'tools/runtime-python39')))fs.cpSync(path.join(recovery, 'tools/runtime-python39'), path.join(output, 'python'), { recursive: true });
  else if(!fs.existsSync(path.join(output,'python/python.exe')))throw new Error('缺少 Windows Python 3.9 运行组件');
  const found=spawnSync('where.exe',['ffmpeg'],{encoding:'utf8',windowsHide:true}).stdout?.trim().split(/\r?\n/).find(fs.existsSync);
  if(found){const bin=path.dirname(found),target=path.join(output,'ffmpeg');fs.mkdirSync(target,{recursive:true});for(const name of ['ffmpeg.exe','ffprobe.exe'])fs.copyFileSync(path.join(bin,name),path.join(target,name));const license=path.join(bin,'../LICENSE');if(fs.existsSync(license))fs.copyFileSync(license,path.join(target,'LICENSE'));}
}
const htmlFile = path.join(output, 'frontend/index.html');
require('./patch-local-template-access.cjs').patchLocalTemplateAccess(path.join(output, 'frontend'));
const html = fs.readFileSync(htmlFile, 'utf8');
if(!html.includes('src="/bridge.js"'))fs.writeFileSync(htmlFile, html.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: https: blob:; media-src \'self\' https: blob:; connect-src \'self\' https:; frame-src https:; font-src \'self\' data:"><style>.titlebar{-webkit-app-region:drag}.titlebar button,.titlebar input,.titlebar select{-webkit-app-region:no-drag}</style><script src="/bridge.js"></script></head>'));
console.log('Recovered resources prepared. Original files were preserved.');
