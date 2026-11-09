'use strict';
// Build a new helper from an already verified native distribution. No credentials
// or user data are copied; the source application is never modified.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const asar=require('@electron/asar');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function command(binary,args){const result=spawnSync(binary,args,{encoding:'utf8'});if(result.error||result.status!==0)throw new Error('构建命令失败：'+binary+'\n'+(result.stderr||''));return result.stdout.trim();}
async function build({sourceApp,outputApp,broker='https://zhangmencut.app.aigzm.com'}){
  if(process.platform!=='darwin')throw new Error('此构建器需要Mac；Windows继续通过build:win打包');
  const root=path.resolve(__dirname,'..'),source=fs.realpathSync(sourceApp),output=path.resolve(outputApp);
  if(!output.endsWith('.app')||fs.existsSync(output)||source===output)throw new Error('请指定尚不存在的新.app输出目录');
  const info=path.join(source,'Contents/Info.plist'),sourceAsar=path.join(source,'Contents/Resources/app.asar');
  command('/usr/bin/codesign',['--verify','--deep','--strict',source]);
  const before={info:hash(info),asar:hash(sourceAsar)};
  const stage=output.slice(0,-4)+'.building-'+crypto.randomUUID()+'.app',code=stage+'.code';
  try{
    command('/usr/bin/ditto',[source,stage]);asar.extractAll(sourceAsar,code);
    // 先清掉底包里的旧代码，源码中已删除的文件（如旧 Motion 模块）不会残留进新包。
    for(const dir of ['desktop','backend']){fs.rmSync(path.join(code,dir),{recursive:true,force:true});fs.cpSync(path.join(root,dir),path.join(code,dir),{recursive:true,filter:f=>!f.includes('__pycache__')});}
    for(const file of fs.readdirSync(path.join(root,'tests')).filter(name=>/^desktop.*\.cjs$/.test(name)))fs.copyFileSync(path.join(root,'tests',file),path.join(code,'tests',file));
    fs.copyFileSync(path.join(root,'package.json'),path.join(code,'package.json'));
    fs.rmSync(path.join(stage,'Contents/Resources/app.asar'),{force:true});await asar.createPackage(code,path.join(stage,'Contents/Resources/app.asar'));
    const resources=path.join(stage,'Contents/Resources/xycut');
    require('./patch-home-links.cjs').patchHomeLinks(path.join(resources,'frontend'));
    const version=require('../package.json').version;
    require('./patch-app-version.cjs').patchAppVersion(path.join(resources,'frontend'),version);
    require('./patch-theme.cjs').patchTheme(path.join(resources,'frontend'));
    const agentOverrides=path.join(root,'backend/agent-overrides');
    if(fs.existsSync(agentOverrides))fs.cpSync(agentOverrides,path.join(resources,'agent-kit/skills'),{recursive:true,filter:file=>!file.includes('__pycache__')});
    fs.writeFileSync(path.join(resources,'account-sso.json'),JSON.stringify({platform_required:true,broker_url:broker,companion:true})+'\n');
    const outputInfo=path.join(stage,'Contents/Info.plist');
    command('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string','com.xycut.restored.companion',outputInfo]);
    command('/usr/bin/plutil',['-replace','CFBundleDisplayName','-string','掌门cut本机助手',outputInfo]);
    for(const key of ['CFBundleShortVersionString','CFBundleVersion'])command('/usr/bin/plutil',['-replace',key,'-string',version,outputInfo]);
    command('/usr/bin/plutil',['-replace','CFBundleURLTypes','-json',JSON.stringify([{CFBundleURLName:'掌门cut本机助手',CFBundleURLSchemes:['zhangmencut']}]),outputInfo]);
    const header=asar.getRawHeader(path.join(stage,'Contents/Resources/app.asar'));
    command('/usr/bin/plutil',['-replace','ElectronAsarIntegrity','-json',JSON.stringify({'Resources/app.asar':{algorithm:'SHA256',hash:crypto.createHash('sha256').update(header.headerString).digest('hex')}}),outputInfo]);
    command('/usr/bin/codesign',['--force','--deep','--sign','-',stage]);command('/usr/bin/codesign',['--verify','--deep','--strict',stage]);
    if(hash(info)!==before.info||hash(sourceAsar)!==before.asar)throw new Error('源应用发生变化，停止构建');
    fs.renameSync(stage,output);
    const result={created_at:new Date().toISOString(),source_app:source,output_app:output,source_unchanged:true,signature_verified:true,broker_url:broker,source_hashes:before,helper_asar_sha256:hash(path.join(output,'Contents/Resources/app.asar'))};
    fs.writeFileSync(output+'.build.json',JSON.stringify(result,null,2)+'\n');return result;
  }finally{fs.rmSync(code,{recursive:true,force:true});if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
if(require.main===module)build({sourceApp:process.argv[2],outputApp:process.argv[3]}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={build};
