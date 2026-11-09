const {app,BrowserWindow,ipcMain,dialog,shell,screen,safeStorage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Service}=require('../backend/service.cjs');
const {startServer}=require('../backend/server.cjs');
const {run,write}=require('../backend/util.cjs');
const {resolveJianying,inspectJianying}=require('./jianying.cjs');
const {createTray}=require('./tray.cjs');
const {resolveResources}=require('./resources.cjs');
const {AccountSSO}=require('../backend/account-sso.cjs');
const {createAccountStore}=require('./account-store.cjs');
const {restoreMainWindow}=require('./lifecycle.cjs');
const {createUpdater}=require('./updater.cjs');
app.setName('掌门cut');
let window,server,service,trayController;
const smoke=process.argv.includes('--smoke-test');
const platformSmoke=process.argv.includes('--platform-smoke-test');
let companionEdition=false;
try{companionEdition=app.isPackaged&&JSON.parse(fs.readFileSync(path.join(process.resourcesPath,'xycut/account-sso.json'),'utf8')).companion===true;}catch{}
const dataDir=process.env.XYCUT_DATA_DIR||path.join(app.getPath('appData'),companionEdition?'ZhangmenCut-companion':'XYCut-restored');
process.env.PYTHONDONTWRITEBYTECODE ||= '1';
process.env.PYTHONIOENCODING ||= 'utf-8';
app.setPath('userData',path.join(dataDir,'electron'));
if(app.isPackaged)app.setAsDefaultProtocolClient('zhangmencut');
app.on('open-url',(event,url)=>{event.preventDefault();if(/^zhangmencut:\/\/open\/?$/.test(url))restoreMainWindow(window);});
// Windows delivers repeated launches/protocol links through second-instance.
// Only restore the existing window; never execute arbitrary URL/file arguments.
app.on('second-instance',()=>restoreMainWindow(window));
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.whenReady().then(start).catch(error=>{console.error(error);dialog.showErrorBox('掌门cut 启动失败',error.message);app.exit(1);});
}
async function start(){
  const resources=resolveResources({app});
  const desktop={
    openPath:async file=>{const error=await shell.openPath(file);if(error)throw new Error(error);},
    restartJianying:async()=>{
      const target=resolveJianying({platform:process.platform,env:process.env,settings:service.settings});
      if(!target){
        const status=inspectJianying({platform:process.platform,env:process.env,settings:service.settings});
        throw new Error('未找到剪映应用。请在设置中配置剪映应用路径。已检查候选路径：'+String.fromCharCode(10)+status.candidates.join(String.fromCharCode(10)));
      }
      if(process.platform==='darwin'){
        await run('/usr/bin/open',[target]);
        return '剪映已重新启动。';
      }
      await run('taskkill.exe',['/IM',path.basename(target),'/T']).catch(()=>{});
      spawn(target,[],{detached:true,stdio:'ignore',windowsHide:true}).unref();
      return '剪映已重新启动。';
    },
    invokePlugin:async(name,args)=>{
      const command=name.split('|')[1];
      if(name.startsWith('plugin:window|')){
        const bounds=window.getBounds(),display=screen.getDisplayMatching(bounds);
        const value=args.value??args.size;
        const size=value?.Logical||value?.Physical||value;
        const handlers={close:()=>window.close(),minimize:()=>window.minimize(),maximize:()=>window.maximize(),unmaximize:()=>window.unmaximize(),toggle_maximize:()=>window.isMaximized()?window.unmaximize():window.maximize(),is_maximized:()=>window.isMaximized(),is_minimized:()=>window.isMinimized(),is_visible:()=>window.isVisible(),is_focused:()=>window.isFocused(),show:()=>window.show(),hide:()=>window.hide(),set_focus:()=>window.focus(),center:()=>window.center(),set_size:()=>window.setSize(Math.round(size.width),Math.round(size.height)),set_min_size:()=>window.setMinimumSize(Math.round(size.width),Math.round(size.height)),set_title:()=>window.setTitle(args.value||args.title),inner_size:()=>({width:Math.round(bounds.width*display.scaleFactor),height:Math.round(bounds.height*display.scaleFactor)}),outer_size:()=>({width:Math.round(bounds.width*display.scaleFactor),height:Math.round(bounds.height*display.scaleFactor)}),scale_factor:()=>display.scaleFactor,current_monitor:()=>({name:'Current',size:display.size,position:display.bounds,scaleFactor:display.scaleFactor}),start_dragging:()=>{},set_resizable:()=>window.setResizable(args.value??args.resizable),set_decorations:()=>{},set_always_on_top:()=>window.setAlwaysOnTop(args.value??args.alwaysOnTop)};
        if(!handlers[command])throw new Error('窗口接口尚未支持：'+command);return handlers[command]();
      }
      if(name==='plugin:dialog|open'){
        const options=args.options||{},result=await dialog.showOpenDialog(window,{title:options.title,defaultPath:options.defaultPath,filters:options.filters,properties:[options.directory?'openDirectory':'openFile',...(options.multiple?['multiSelections']:[])]});
        if(result.canceled)return null;result.filePaths.forEach(p=>service.grant(p));return options.multiple?result.filePaths:result.filePaths[0];
      }
      if(name==='plugin:dialog|save'){const result=await dialog.showSaveDialog(window,args.options||{});return result.canceled?null:result.filePath;}
      if(name==='plugin:opener|open_url'||name==='plugin:shell|open'){const url=args.url||args.path;if(!/^https?:\/\//i.test(url))throw new Error('网址无效');await shell.openExternal(url);return;}
      if(name==='plugin:opener|open_path')return desktop.openPath(args.path);
      if(name==='plugin:app|version')return app.getVersion();
      if(name==='plugin:app|name')return '掌门cut';
      if(name==='plugin:resources|close')return;
      throw new Error('桌面接口尚未支持：'+name);
    }
  };
  let account,brokerUrl='';let platformRequired=process.env.ZHANGMEN_PLATFORM_REQUIRED==='1'||!!process.env.ZHANGMEN_SSO_BROKER_URL;
  const accountOptions={openExternal:url=>shell.openExternal(url),store:createAccountStore({dataDir,safeStorage})};
  try {
    const ssoConfigFile=path.join(resources,'account-sso.json');
    const ssoConfig=fs.existsSync(ssoConfigFile)?JSON.parse(fs.readFileSync(ssoConfigFile,'utf8')):require('./platform-config.cjs');
    platformRequired ||= ssoConfig.platform_required===true||!!ssoConfig.broker_url;
    brokerUrl=process.env.ZHANGMEN_SSO_BROKER_URL||ssoConfig.broker_url||'';
    account=new AccountSSO({...accountOptions,brokerUrl,allowLocalHttp:!app.isPackaged&&process.env.ZHANGMEN_SSO_ALLOW_LOCAL_HTTP==='1'});
  }catch{account=new AccountSSO(accountOptions);account.message='账户服务配置无效，请联系管理员';}
  account.required=platformRequired;
  // 自动更新：读取 AI 超市托管站点上的同一份 downloads.json。
  // Mac 包的可执行文件名是 Electron，app.isPackaged 不可靠；以 resources 下是否有 app.asar 判断是否为正式包。
  const shipped=app.isPackaged||fs.existsSync(path.join(process.resourcesPath,'app.asar'));
  const updater=createUpdater({app,shell,allowLocalHttp:!shipped&&process.env.ZHANGMEN_UPDATE_ALLOW_LOCAL_HTTP==='1',manifestUrl:(process.env.ZHANGMEN_UPDATE_MANIFEST_URL&&!shipped?process.env.ZHANGMEN_UPDATE_MANIFEST_URL:(brokerUrl||require('./platform-config.cjs').broker_url).replace(/\/$/,'')+'/downloads.json'),cacheDir:path.join(dataDir,'cache'),currentVersion:app.getVersion(),readVersion:appPath=>{try{return JSON.parse(fs.readFileSync(path.join(appPath,'Contents/Resources/app.asar/package.json'),'utf8')).version;}catch{return '';}}});
  // 检查失败（离线、平台唤醒中）只视为“暂无更新”，不打断使用；自动验收时不访问网络。
  desktop.checkUpdate=()=>smoke||platformSmoke?{enabled:false,current_version:app.getVersion()}:updater.check().catch(error=>({enabled:false,current_version:app.getVersion(),message:error.message}));
  desktop.installUpdate=args=>updater.install(args);
  desktop.appVersion=app.getVersion();
  service=new Service({resources,dataDir,desktop,account});
  const local=await startServer(service,{port:Number(process.env.XYCUT_PORT||(companionEdition?17656:17652)),companion:account.base?{
    origins:[account.base],
    confirmConnection:async({origin})=>{
      window?.show();window?.focus();
      const result=await dialog.showMessageBox(window,{type:'question',title:'连接掌门cut网站',message:'允许这个网站连接本机助手？',detail:origin+'\n\n网站可以使用助手中的素材库、打开本机文件选择器，并按你的操作生成草稿、打开剪映。原片留在本机；AI调用仍使用当前登录账户并扣除其积分。关闭助手或在网页断开即可撤销本次连接。',buttons:['取消','允许本次连接'],defaultId:0,cancelId:0,noLink:true});
      return result.response===1;
    }
  }:null});server=local.server;
  await service.context();
  await account.restore().catch(()=>{account.message='无法恢复账户会话，请重新登录';});
  window=new BrowserWindow({width:660,height:655,minWidth:420,minHeight:655,frame:false,show:false,backgroundColor:'#f8fafc',icon:path.join(resources,'frontend/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  service.commandErrors=[];
  ipcMain.handle('xycut:invoke',async(event,name,args)=>{if(event.sender!==window.webContents || !event.senderFrame.url.startsWith(local.url+'/'))throw new Error('来源不合法');try{return await service.invoke(name,args);}catch(error){service.commandErrors.push({name,message:error.message});throw error;}});
  window.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith(local.url+'/')){const child=new BrowserWindow({width:1200,height:850,parent:window,webPreferences:{contextIsolation:true,nodeIntegration:false}});child.loadURL(url);}else if(/^https?:/.test(url))shell.openExternal(url);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(local.url+'/')){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url);}});
  for(const event of ['resize','focus','blur'])window.on(event,()=>{window.webContents.send('xycut:event',{event:'tauri://'+event,payload:event==='resize'?{width:window.getBounds().width,height:window.getBounds().height}:null});});
  window.webContents.on('console-message',details=>{if(details.level==='warning'||details.level==='error')console.error(details.message);});
  trayController=createTray({app,window,resources});
  await window.loadURL(local.url);window.show();
  if(platformSmoke)await require('../tests/desktop-platform-smoke.cjs').run({window,service,app,dataDir});
  else if(smoke)await require('../tests/desktop-smoke.cjs').run({window,service,app,dataDir});
}
app.on('window-all-closed',()=>{server?.close();app.quit();});
app.on('before-quit',()=>server?.close());
