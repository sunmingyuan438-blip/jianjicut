'use strict';
// Package a verified platform-enabled app. Never include user data or credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const VERSION=require('../package.json').version;
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8'});if(r.error||r.status!==0)throw new Error(command+' failed: '+(r.stderr||r.error?.message));return r.stdout;}
function build(sourceApp,output){
  if(process.platform!=='darwin')throw new Error('需要 macOS 打包');
  sourceApp=fs.realpathSync(sourceApp);output=path.resolve(output);
  if(fs.existsSync(output))throw new Error('输出目录已存在，拒绝覆盖');
  run('/usr/bin/codesign',['--verify','--deep','--strict',sourceApp]);
  const sourceAsar=path.join(sourceApp,'Contents/Resources/app.asar');
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before=hash(sourceAsar),config=JSON.parse(fs.readFileSync(path.join(sourceApp,'Contents/Resources/xycut/account-sso.json'),'utf8'));
  if(config.broker_url!=='https://zhangmencut.app.aigzm.com'||config.platform_required!==true)throw new Error('应用不是正式平台版');
  const staging=path.join(output,'掌门cut-'+VERSION),app=path.join(staging,'掌门cut.app');fs.mkdirSync(staging,{recursive:true});
  run('/usr/bin/ditto',[sourceApp,app]);
  require('./patch-home-links.cjs').patchHomeLinks(path.join(app,'Contents/Resources/xycut/frontend'));
  require('./patch-app-version.cjs').patchAppVersion(path.join(app,'Contents/Resources/xycut/frontend'),VERSION);
  require('./patch-theme.cjs').patchTheme(path.join(app,'Contents/Resources/xycut/frontend'));
  const info=path.join(app,'Contents/Info.plist');
  run('/usr/bin/plutil',['-replace','CFBundleDisplayName','-string','掌门cut',info]);
  for(const key of ['CFBundleShortVersionString','CFBundleVersion'])run('/usr/bin/plutil',['-replace',key,'-string',VERSION,info]);
  // 应用内 package.json 的版本决定自动更新的比较结果，必须与发布版本一致。
  const packaged=JSON.parse(require('@electron/asar').extractFile(path.join(app,'Contents/Resources/app.asar'),'package.json').toString('utf8')).version;
  if(packaged!==VERSION)throw new Error(`应用内版本 ${packaged} 与发布版本 ${VERSION} 不一致，请先用当前源码重新构建本机助手`);
  run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const arch=run('/usr/bin/lipo',['-archs',path.join(app,'Contents/MacOS/Electron')]).trim();
  if(!['arm64','x86_64'].includes(arch))throw new Error('非预期单架构应用：'+arch);
  const label=arch==='arm64'?'arm64':'x64',file=path.join(output,`ZhangmenCut-${VERSION}-macOS-${label}-AIGZM.zip`);
  fs.writeFileSync(path.join(staging,'安装与登录.txt'),'掌门cut '+VERSION+' · AI 超市版\n\n1. 将“掌门cut.app”拖入“应用程序”。\n2. 打开软件，点击左下角“AI超市账户”，在官方浏览器页面登录并授权。\n3. 返回软件即可使用。无需填写个人API Key；AI调用扣当前用户积分，本地功能按会员权限。\n\n此包仅含软件，不含任何人的账户、素材或草稿。当前为临时签名构建，尚未完成Apple公证；如果macOS拦截，请按系统提示操作，不要关闭Gatekeeper。\n');
  run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',staging,file]);
  run('/usr/bin/unzip',['-tq',file]);
  if(hash(sourceAsar)!==before)throw new Error('源应用意外改变');
  const result={version:VERSION,platform:'darwin',arch:label,file,bytes:fs.statSync(file).size,sha256:hash(file),signature_verified:true,apple_notarized:false,zip_integrity:true,source_unchanged:true,contains_user_data:false,broker_url:config.broker_url};
  fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),result.sha256+'  '+path.basename(file)+'\n');return result;
}
if(require.main===module){try{console.log(JSON.stringify(build(process.argv[2],process.argv[3]),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={build};
