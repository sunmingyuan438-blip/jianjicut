'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const U=require('../desktop/updater.cjs');
const {patchBundle}=require('../scripts/patch-app-version.cjs');
const MANIFEST_URL='https://zhangmencut.app.aigzm.com/downloads.json';
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'zm-updater-'));
const macRelease={platform:'darwin',arch:'arm64',status:'ready',url:'https://github.com/sunmingyuan438-blip/jianjicut/releases/download/v0.2.11/ZhangmenCut-0.2.11-macOS-arm64-AIGZM.zip',bytes:10,sha256:'a'.repeat(64)};
const winRelease={platform:'win32',arch:'x64',status:'ready',url:'https://github.com/sunmingyuan438-blip/jianjicut/releases/download/v0.2.11/ZhangmenCut-0.2.11-Windows-x64-AIGZM-Setup.exe',bytes:10,sha256:'b'.repeat(64)};
const manifest=(extra={})=>({version:'0.2.11',notes:['新增自动更新'],releases:[macRelease,winRelease],...extra});
const pick=(m,opts={})=>U.selectRelease(m,{platform:'darwin',arch:'arm64',currentVersion:'0.2.10',manifestUrl:MANIFEST_URL,...opts});
function fakeFetch(body,{status=200,url}={}){
  return async requested=>({ok:status>=200&&status<300,status,url:url||requested,body:(async function*(){for(let i=0;i<body.length;i+=4)yield body.subarray(i,i+4);})(),json:async()=>JSON.parse(body.toString())});
}

test('版本比较按数字逐段比较',()=>{
  assert.ok(U.compareVersions('0.2.10','0.2.9')>0);
  assert.ok(U.compareVersions('v0.3.0','0.2.99')>0);
  assert.equal(U.compareVersions('0.2.10','0.2.10.0'),0);
  assert.ok(U.compareVersions('0.2.10','0.2.11')<0);
});

test('只在清单版本更新且当前平台有合格安装包时提示更新',()=>{
  const release=pick(manifest());
  assert.equal(release.version,'0.2.11');assert.equal(release.fileName,'ZhangmenCut-0.2.11-macOS-arm64-AIGZM.zip');assert.equal(release.mandatory,false);assert.deepEqual(release.notes,['新增自动更新']);
  assert.equal(pick(manifest(),{currentVersion:'0.2.11'}),null);
  assert.equal(pick(manifest(),{currentVersion:'0.3.0'}),null);
  assert.equal(pick(manifest(),{arch:'x64'}),null,'未发布 Intel 版时不能拿 arm64 包顶替');
  assert.equal(pick(manifest(),{platform:'win32',arch:'x64'}).fileName,'ZhangmenCut-0.2.11-Windows-x64-AIGZM-Setup.exe');
});

test('拒绝不安全或不完整的发布条目',()=>{
  for(const change of [{status:'uploading'},{sha256:''},{sha256:'xyz'},{bytes:0},{bytes:2*1024*1024*1024},{url:'http://github.com/a/b.zip'},{url:'https://evil.example.com/ZhangmenCut.zip'},{url:'https://u:p@github.com/a/b.zip'},{url:'https://github.com/a/b.exe'},{version:'0.2.12'}]){
    assert.equal(pick({...manifest(),releases:[{...macRelease,...change}]}),null,JSON.stringify(change));
  }
  assert.throws(()=>pick({releases:[]}),/版本号/);
  assert.throws(()=>pick({version:'0.2.11'}),/格式无效/);
});

test('强制更新：显式 mandatory 或低于最低支持版本',()=>{
  assert.equal(pick(manifest({mandatory:true})).mandatory,true);
  assert.equal(pick(manifest({min_supported_version:'0.2.11'})).mandatory,true);
  assert.equal(pick(manifest({min_supported_version:'0.2.9'})).mandatory,false);
});

test('转成原版前端认识的 /api/update 字段',()=>{
  const value=U.legacyResponse(pick(manifest()),'0.2.10');
  assert.deepEqual(Object.keys(value).sort(),['current_version','download_url','enabled','file_name','latest_version','mandatory','notes','sha256']);
  assert.equal(value.enabled,true);assert.equal(value.download_url,macRelease.url);
  assert.deepEqual(U.legacyResponse(null,'0.2.10'),{enabled:false,latest_version:'0.2.10',current_version:'0.2.10',notes:[]});
});

test('下载：大小与 SHA-256 一致才保留文件，重复调用复用已校验文件',async()=>{
  const dir=tmp(),body=Buffer.from('zhangmencut-update-payload'),release={...pick(manifest()),bytes:body.length,sha256:sha(body)};
  const file=await U.downloadVerified(release,path.join(dir,'a.zip'),{fetcher:fakeFetch(body),manifestUrl:MANIFEST_URL});
  assert.deepEqual(fs.readFileSync(file),body);
  let called=false;await U.downloadVerified(release,file,{fetcher:async()=>{called=true;throw new Error('不应重新下载');},manifestUrl:MANIFEST_URL});assert.equal(called,false);
});

test('下载：校验失败、超长、截断、重定向到不受信任主机时删除并报错',async()=>{
  const dir=tmp(),body=Buffer.from('zhangmencut-update-payload'),base={...pick(manifest()),bytes:body.length,sha256:sha(body)};
  const cases=[
    [{...base,sha256:'0'.repeat(64)},fakeFetch(body),/SHA-256/],
    [{...base,bytes:body.length-3},fakeFetch(body),/超出预期/],
    [{...base,bytes:body.length+5},fakeFetch(body),/不完整/],
    [base,fakeFetch(body,{url:'https://evil.example.com/x.zip'}),/不受信任/],
    [base,fakeFetch(body,{status:404}),/HTTP 404/],
  ];
  for(const [release,fetcher,error] of cases){
    const target=path.join(dir,'b.zip');
    await assert.rejects(U.downloadVerified(release,target,{fetcher,manifestUrl:MANIFEST_URL}),error);
    assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(target+'.part'),false);
  }
});

test('updater.install 不使用渲染进程传来的其他下载地址',async()=>{
  const body=Buffer.from(JSON.stringify(manifest()));
  const updater=U.createUpdater({app:{isPackaged:false},manifestUrl:MANIFEST_URL,cacheDir:tmp(),currentVersion:'0.2.10',platform:'darwin',arch:'arm64',fetcher:fakeFetch(body)});
  assert.equal((await updater.check()).enabled,true);
  await assert.rejects(updater.install({url:'https://evil.example.com/ZhangmenCut.zip'}),/更新信息已变化/);
});

test('前端版本常量替换：唯一匹配、可重复执行、结构变化时拒绝',()=>{
  const bundle='x,Hh="/background.jpg",Bs="0.2.10",pd=[];const wn={version:"0.2.10",configVersion:"2026.08.21"};Cb=1;v.useEffect(()=>{Ct(null)},[]);try{await U("download_and_open_update",{url:Qe.downloadUrl,fileName:Qe.fileName,sha256:Qe.sha256||null}),el("更新包已打开，请按安装向导完成更新。")}catch(r){}';
  const next=patchBundle(bundle,'0.2.11');
  assert.match(next,/Bs="0\.2\.11"/);assert.match(next,/\{version:"0\.2\.11",configVersion/);
  assert.equal(patchBundle(next,'0.2.11'),next);
  assert.ok(!next.includes('Ct(null)'));assert.match(next,/Ed\(Cb,r\.signal,"update info"\)\.then\(S=>Ct\(ex\(S\)\)\)/);assert.match(next,/setInterval\(g,216e5\)/);assert.match(next,/el\(zmUpdate\?\.message\|\|/);
  assert.throws(()=>patchBundle('const a=1','0.2.11'),/结构已变化/);
  assert.throws(()=>patchBundle(bundle,'latest'),/格式无效/);
});

test('真实前端包可被版本补丁识别',{skip:!fs.existsSync(path.join(__dirname,'../.test-data/motiontemplates-sync-20261016/win-release-final/app/resources/xycut/frontend/assets'))},()=>{
  const dir=path.join(__dirname,'../.test-data/motiontemplates-sync-20261016/win-release-final/app/resources/xycut/frontend/assets');
  const file=fs.readdirSync(dir).find(n=>n.endsWith('.js')&&fs.readFileSync(path.join(dir,n),'utf8').includes('"/background.jpg"'));
  const next=patchBundle(fs.readFileSync(path.join(dir,file),'utf8'),'0.2.11');
  assert.equal((next.match(/"0\.2\.11"/g)||[]).length,2);
  assert.ok(!next.includes('v.useEffect(()=>{Ct(null)},[])'),'应恢复启动时的更新检查');
  assert.ok(next.includes('el(zmUpdate?.message||'),'应显示主进程返回的安装说明');
});

// ---- macOS 真实替换流程（使用临时签名的最小 .app，不触碰已安装应用） ----
const mac=process.platform==='darwin';
function fakeApp(dir,{id='com.xycut.restored.companion',version='0.2.10',marker='old'}={}){
  const app=path.join(dir,'掌门cut.app'),contents=path.join(app,'Contents');
  fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true});fs.mkdirSync(path.join(contents,'Resources'),{recursive:true});
  fs.writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Electron</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  fs.copyFileSync('/usr/bin/true',path.join(contents,'MacOS/Electron'));
  fs.writeFileSync(path.join(contents,'Resources/marker.txt'),marker);
  const r=spawnSync('/usr/bin/codesign',['--force','--deep','--sign','-',app]);assert.equal(r.status,0,String(r.stderr));
  return app;
}
const readMarker=app=>fs.readFileSync(path.join(app,'Contents/Resources/marker.txt'),'utf8');
const readVersion=app=>spawnSync('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).stdout.trim();

test('Mac：解压后校验签名、Bundle ID 与版本号',{skip:!mac},()=>{
  const root=tmp(),current=fakeApp(path.join(root,'Applications'));
  const build=path.join(root,'build','掌门cut-0.2.11');fakeApp(build,{version:'0.2.11',marker:'new'});
  const zip=path.join(root,'u.zip');assert.equal(spawnSync('/usr/bin/ditto',['-c','-k','--keepParent',build,zip]).status,0);
  const next=U.prepareMacUpdate(zip,{version:'0.2.11'},{stagingDir:path.join(root,'staging'),currentApp:current,readVersion});
  assert.equal(readMarker(next),'new');
  assert.throws(()=>U.prepareMacUpdate(zip,{version:'0.2.12'},{stagingDir:path.join(root,'staging'),currentApp:current,readVersion}),/版本/);
  const other=path.join(root,'other','掌门cut-0.2.11');fakeApp(other,{id:'com.example.other',version:'0.2.11'});
  const zip2=path.join(root,'o.zip');spawnSync('/usr/bin/ditto',['-c','-k','--keepParent',other,zip2]);
  assert.throws(()=>U.prepareMacUpdate(zip2,{version:'0.2.11'},{stagingDir:path.join(root,'staging2'),currentApp:current,readVersion}),/应用标识/);
  const unsigned=path.join(root,'unsigned','掌门cut-0.2.11');const ua=fakeApp(unsigned,{version:'0.2.11'});fs.writeFileSync(path.join(ua,'Contents/Resources/marker.txt'),'tampered');
  const zip3=path.join(root,'t.zip');spawnSync('/usr/bin/ditto',['-c','-k','--keepParent',unsigned,zip3]);
  assert.throws(()=>U.prepareMacUpdate(zip3,{version:'0.2.11'},{stagingDir:path.join(root,'staging3'),currentApp:current,readVersion}),/codesign/);
});

async function waitFor(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return true;await new Promise(r=>setTimeout(r,100));}return false;}

test('Mac：进程退出后替换为新版，保留旧版备份',{skip:!mac},async()=>{
  const root=tmp(),target=fakeApp(path.join(root,'Applications')),next=fakeApp(path.join(root,'staging'),{marker:'new'});
  const sleeper=require('node:child_process').spawn('/bin/sleep',['1']);
  const log=path.join(root,'install.log'),backup=path.join(root,'previous.app');
  U.scheduleMacSwap({pid:sleeper.pid,target,next,backup,log,scriptFile:path.join(root,'swap.sh'),env:{...process.env,ZHANGMEN_UPDATE_NO_RELAUNCH:'1'}});
  assert.equal(readMarker(target),'old','进程仍在运行时不能替换');
  assert.ok(await waitFor(()=>fs.existsSync(log)&&fs.readFileSync(log,'utf8').includes('替换完成')),fs.existsSync(log)?fs.readFileSync(log,'utf8'):'无日志');
  assert.equal(readMarker(target),'new');assert.equal(readMarker(backup),'old');
  assert.equal(spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',target]).status,0);
});

test('Mac：新版复制后签名不通过时自动还原旧版',{skip:!mac},async()=>{
  const root=tmp(),target=fakeApp(path.join(root,'Applications')),next=fakeApp(path.join(root,'staging'),{marker:'new'});
  fs.writeFileSync(path.join(next,'Contents/Resources/marker.txt'),'tampered');
  const log=path.join(root,'install.log');
  U.scheduleMacSwap({pid:999999,target,next,backup:path.join(root,'previous.app'),log,scriptFile:path.join(root,'swap.sh'),env:{...process.env,ZHANGMEN_UPDATE_NO_RELAUNCH:'1'}});
  assert.ok(await waitFor(()=>fs.existsSync(log)&&fs.readFileSync(log,'utf8').includes('还原旧版本')));
  await waitFor(()=>fs.existsSync(target)&&readMarker(target)==='old',5000);
  assert.equal(readMarker(target),'old');
});

test('Mac：应用随机化路径与开发模式不做自动替换',()=>{
  assert.equal(U.currentMacApp('/private/var/folders/x/AppTranslocation/ABC/d/掌门cut.app/Contents/MacOS/Electron'),null);
  const hasAsar=file=>file==='/Applications/掌门cut.app/Contents/Resources/app.asar';
  assert.equal(U.currentMacApp('/Users/a/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',hasAsar),null,'开发用 Electron 没有 app.asar');
  assert.equal(U.currentMacApp('/Applications/掌门cut.app/Contents/MacOS/Electron',hasAsar),'/Applications/掌门cut.app');
});

test('本地 HTTP 只在显式开发联调开关下放行',()=>{
  const local={version:'0.2.11',releases:[{...macRelease,url:'http://127.0.0.1:18080/ZhangmenCut-0.2.11-macOS-arm64-AIGZM.zip'}]};
  assert.equal(pick(local,{manifestUrl:'http://127.0.0.1:18080/downloads.json'}),null);
  assert.equal(pick(local,{manifestUrl:'http://127.0.0.1:18080/downloads.json',allowLocalHttp:true}).version,'0.2.11');
  assert.equal(pick({...local,releases:[{...macRelease,url:'http://192.168.1.2/ZhangmenCut.zip'}]},{allowLocalHttp:true}),null);
});

test('网页端不能通过本机助手触发更新',()=>{
  const companion=fs.readFileSync(path.join(__dirname,'../backend/companion.cjs'),'utf8');
  assert.match(companion,/\['check_app_update','download_and_open_update'\]\.includes\(input\.name\)\) throw error\('请在本机掌门cut中检查更新',403\)/);
  const bridge=fs.readFileSync(path.join(__dirname,'../desktop/bridge.js'),'utf8');
  assert.ok(bridge.indexOf('xycutDesktop?.browser')<bridge.indexOf("invoke('check_app_update'"),'网页端应在调用主进程前直接返回无更新');
});
