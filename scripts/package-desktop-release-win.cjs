'use strict';
// Reuse verified Windows native runtimes; assemble current maintained code on
// any build host. NSIS is native to the host, no Wine or user credentials needed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const asar=require('@electron/asar'),ResEdit=require('resedit');
const {inspectResourceRoot}=require('../desktop/resources.cjs');
const VERSION=require('../package.json').version,VERSION4=VERSION.split('.').concat('0','0','0').slice(0,4);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:20*1024*1024,...options});if(r.error||r.status!==0)throw new Error(command+' failed: '+(r.stderr||r.stdout||r.error?.message));return r.stdout;}
function peMachine(file){const b=fs.readFileSync(file);if(b.toString('ascii',0,2)!=='MZ')throw new Error('不是Windows PE：'+file);const off=b.readUInt32LE(0x3c);if(b.toString('ascii',off,off+4)!=='PE\0\0')throw new Error('PE头无效：'+file);return b.readUInt16LE(off+4);}
function walk(root){let result=[];for(const e of fs.readdirSync(root,{withFileTypes:true})){const file=path.join(root,e.name);if(e.isSymbolicLink())throw new Error('Windows包不接受符号链接：'+file);if(e.isDirectory())result.push(...walk(file));else if(e.isFile())result.push(file);}return result;}
const quote=value=>String(value).replace(/\$/g,'$$$$').replace(/"/g,'$\\"');
function installerSource({app,installer,icon}){
  const files=walk(app).map(f=>path.relative(app,f).split(path.sep).join('\\'));
  const dirs=[...new Set(files.flatMap(file=>{let d=path.win32.dirname(file),out=[];while(d!=='.'){out.push(d);d=path.win32.dirname(d);}return out;}))].sort((a,b)=>b.split('\\').length-a.split('\\').length||b.length-a.length);
  // Delete only exact installed payload names, never recursively remove an
  // arbitrary directory or AppData. Existing projects and user data survive.
  const remove=files.map(f=>'  Delete "$INSTDIR\\'+quote(f)+'"').concat(dirs.map(d=>'  RMDir "$INSTDIR\\'+quote(d)+'"')).join('\n');
  return `Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Name "掌门cut"
OutFile "${quote(installer)}"
InstallDir "$LOCALAPPDATA\\Programs\\ZhangmenCut-AIGZM"
InstallDirRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
BrandingText "掌门cut · AI超市版"
VIProductVersion "${VERSION4.join('.')}"
VIAddVersionKey /LANG=2052 "ProductName" "掌门cut"
VIAddVersionKey /LANG=2052 "FileDescription" "掌门cut AI超市版安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION4.join('.')}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "掌门cut"
!define MUI_ICON "${quote(icon)}"
!define MUI_UNICON "${quote(icon)}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\\掌门cut.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开掌门cut，使用AI超市账户登录"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  \${IfNot} \${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要64位Windows。"
    Abort
  \${EndIf}
  \${IfNot} \${AtLeastWin10}
    MessageBox MB_ICONSTOP "此安装包需要Windows 10或更高版本。"
    Abort
  \${EndIf}
  SetRegView 64
  SetShellVarContext current
FunctionEnd
Section "掌门cut" SEC_APP
  SetOutPath "$INSTDIR"
  File /r "${quote(app)}/*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\掌门cut"
  CreateShortcut "$SMPROGRAMS\\掌门cut\\掌门cut.lnk" "$INSTDIR\\掌门cut.exe"
  CreateShortcut "$DESKTOP\\掌门cut.lnk" "$INSTDIR\\掌门cut.exe"
  WriteRegStr HKCU "Software\\Classes\\zhangmencut" "" "URL:掌门cut"
  WriteRegStr HKCU "Software\\Classes\\zhangmencut" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\zhangmencut\\DefaultIcon" "" '$\\"$INSTDIR\\掌门cut.exe$\\",0'
  WriteRegStr HKCU "Software\\Classes\\zhangmencut\\shell\\open\\command" "" '$\\"$INSTDIR\\掌门cut.exe$\\" $\\"%1$\\"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "DisplayName" "掌门cut · AI超市版"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "Publisher" "掌门cut"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "DisplayIcon" "$INSTDIR\\掌门cut.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64" "NoRepair" 1
SectionEnd
Section "Uninstall"
  SetRegView 64
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\\Classes\\zhangmencut\\shell\\open\\command" ""
  StrCmp $0 '$\\"$INSTDIR\\掌门cut.exe$\\" $\\"%1$\\"' 0 +2
    DeleteRegKey HKCU "Software\\Classes\\zhangmencut"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZhangmenCut-AIGZM-x64"
  Delete "$DESKTOP\\掌门cut.lnk"
  Delete "$SMPROGRAMS\\掌门cut\\掌门cut.lnk"
  RMDir "$SMPROGRAMS\\掌门cut"
${remove}
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`;
}
async function build({sourceApp,commonResources,output,nsisDir=process.env.NSISDIR}){
  const root=path.resolve(__dirname,'..');sourceApp=fs.realpathSync(sourceApp);commonResources=fs.realpathSync(commonResources);output=path.resolve(output);
  if(fs.existsSync(output))throw new Error('输出目录已存在，拒绝覆盖');
  const oldAsar=path.join(sourceApp,'resources/app.asar');if(!fs.existsSync(oldAsar))throw new Error('Windows应用目录缺resources/app.asar');
  const sourceHash=hash(oldAsar),app=path.join(output,'app'),code=path.join(output,'code');fs.mkdirSync(output,{recursive:true});
  fs.cpSync(sourceApp,app,{recursive:true,filter:file=>!/(?:^|[\\/])(?:\.DS_Store|__pycache__|Uninstall[^\\/]*\.exe)$/.test(file)});
  const originalExe=fs.readdirSync(app).find(name=>/\.exe$/i.test(name)&&!/^uninstall/i.test(name));if(!originalExe||peMachine(path.join(app,originalExe))!==0x8664)throw new Error('源应用不是x64 Windows');
  const target=path.join(app,'resources/xycut'),windows=path.join(output,'windows-native');fs.mkdirSync(windows);
  for(const name of ['python','ffmpeg'])fs.renameSync(path.join(target,name),path.join(windows,name));
  fs.rmSync(target,{recursive:true});fs.mkdirSync(target);
  for(const name of fs.readdirSync(commonResources))if(!['python','ffmpeg','account-sso.json','.DS_Store'].includes(name))fs.cpSync(path.join(commonResources,name),path.join(target,name),{recursive:true,filter:f=>!f.includes('__pycache__')&&!f.endsWith('.DS_Store')});
  for(const name of ['python','ffmpeg'])fs.renameSync(path.join(windows,name),path.join(target,name));
  require('./patch-home-links.cjs').patchHomeLinks(path.join(target,'frontend'));
  require('./patch-app-version.cjs').patchAppVersion(path.join(target,'frontend'),VERSION);
  require('./patch-theme.cjs').patchTheme(path.join(target,'frontend'));
  fs.copyFileSync(path.join(root,'backend/core_worker.py'),path.join(target,'core_worker.py'));
  fs.cpSync(path.join(root,'backend/agent-overrides'),path.join(target,'agent-kit/skills'),{recursive:true,filter:f=>!f.includes('__pycache__')});
  fs.writeFileSync(path.join(target,'account-sso.json'),JSON.stringify({...require('../desktop/platform-config.cjs'),companion:true})+'\n');
  const resourceCheck=inspectResourceRoot(target,'win32');if(!resourceCheck.valid)throw new Error('Windows资源缺失：'+resourceCheck.missing.join(', '));
  for(const file of [path.join(target,'python/python.exe'),path.join(target,'python/python39.dll'),path.join(target,'ffmpeg/ffmpeg.exe'),path.join(target,'ffmpeg/ffprobe.exe')])if(peMachine(file)!==0x8664)throw new Error('Windows组件架构不匹配：'+file);
  asar.extractAll(oldAsar,code);
  // 先清掉底包里的旧代码，源码中已删除的文件不会残留进新包。
  for(const name of ['desktop','backend']){fs.rmSync(path.join(code,name),{recursive:true,force:true});fs.cpSync(path.join(root,name),path.join(code,name),{recursive:true,filter:f=>!f.includes('__pycache__')});}
  for(const name of fs.readdirSync(path.join(root,'tests')).filter(n=>/^desktop.*\.cjs$/.test(n)))fs.copyFileSync(path.join(root,'tests',name),path.join(code,'tests',name));
  fs.copyFileSync(path.join(root,'package.json'),path.join(code,'package.json'));
  const asarFile=path.join(app,'resources/app.asar');fs.rmSync(asarFile);await asar.createPackage(code,asarFile);fs.rmSync(code,{recursive:true});
  const exe=path.join(app,'掌门cut.exe');if(originalExe!=='掌门cut.exe')fs.renameSync(path.join(app,originalExe),exe);
  const pe=ResEdit.NtExecutable.from(fs.readFileSync(exe),{ignoreCert:true}),resource=ResEdit.NtExecutableResource.from(pe),icons=ResEdit.Data.IconFile.from(fs.readFileSync(path.join(target,'frontend/icon.ico'))).icons.map(i=>i.data);
  for(const group of ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries))ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries,group.id,group.lang,icons);
  for(const version of ResEdit.Resource.VersionInfo.fromEntries(resource.entries)){
    for(const lang of version.getAllLanguagesForStringValues()){version.setFileVersion(...VERSION4.map(Number),lang.lang);version.setProductVersion(...VERSION4.map(Number),lang.lang);version.setStringValues(lang,{ProductName:'掌门cut',FileDescription:'掌门cut · AI超市版',CompanyName:'掌门cut',OriginalFilename:'掌门cut.exe',InternalName:'ZhangmenCut'});}
    version.outputToResourceEntries(resource.entries);
  }
  const integrity=crypto.createHash('sha256').update(asar.getRawHeader(asarFile).headerString).digest('hex');
  resource.entries=resource.entries.filter(e=>!(e.type==='INTEGRITY'&&e.id==='ELECTRONASAR'));
  resource.entries.push({type:'INTEGRITY',id:'ELECTRONASAR',lang:1033,codepage:1200,bin:Buffer.from(JSON.stringify([{file:'resources\\app.asar',alg:'SHA256',value:integrity}]))});
  resource.outputResource(pe);fs.writeFileSync(exe,Buffer.from(pe.generate()));
  const privateNames=['session.enc','platform-api.key','settings.json','api-context.json','xycut-sucai.db'];const privateFiles=walk(app).filter(f=>privateNames.includes(path.basename(f)));if(privateFiles.length)throw new Error('包内含用户数据，停止：'+privateFiles.join(', '));
  const installer=path.join(output,`ZhangmenCut-${VERSION}-Windows-x64-AIGZM-Setup.exe`),script=path.join(output,'installer.nsi');fs.writeFileSync(script,installerSource({app,installer,icon:path.join(target,'frontend/icon.ico')}));
  const buildLog=run(process.platform==='win32'?'makensis.exe':'makensis',['-INPUTCHARSET','UTF8','-V3',script],{env:{...process.env,...(nsisDir?{NSISDIR:nsisDir}:{})}});fs.writeFileSync(path.join(output,'nsis-build.log'),buildLog);
  if(hash(oldAsar)!==sourceHash)throw new Error('源应用改变');
  const files=walk(app).map(file=>({file:path.relative(app,file).split(path.sep).join('/'),bytes:fs.statSync(file).size,sha256:hash(file)}));fs.writeFileSync(path.join(output,'payload-files.json'),JSON.stringify(files,null,2));
  const result={version:VERSION,platform:'win32',arch:'x64',file:installer,bytes:fs.statSync(installer).size,sha256:hash(installer),authenticode_signed:false,windows_live_tested:false,resource_check:resourceCheck,source_unchanged:true,contains_user_data:false,asar_sha256:hash(asarFile),asar_header_integrity:integrity,broker_url:'https://zhangmencut.app.aigzm.com',file_count:files.length};
  fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(output,'SHA256SUMS-Windows.txt'),result.sha256+'  '+path.basename(installer)+'\n');return result;
}
if(require.main===module)build({sourceApp:process.argv[2],commonResources:process.argv[3],output:process.argv[4]}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={build,installerSource,peMachine};
