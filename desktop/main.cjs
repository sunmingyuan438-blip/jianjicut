const {app,BrowserWindow,ipcMain,dialog,shell,screen}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Service}=require('../backend/service.cjs');
const {startServer}=require('../backend/server.cjs');
const {run,write}=require('../backend/util.cjs');
const {resolveJianying,applicationName}=require('./jianying.cjs');
const {createTray}=require('./tray.cjs');
const {resolveDataRoot,resolveResourcesRoot}=require('./resources.cjs');
let window,server,service,trayController;
const smoke=process.argv.includes('--smoke-test');
const dataDir=resolveDataRoot({env:process.env,appData:app.getPath('appData')});
app.setPath('userData',path.join(dataDir,'electron'));
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.whenReady().then(start).catch(error=>{console.error(error);dialog.showErrorBox('XYCut 启动失败',error.message);app.exit(1);});
}
async function start(){
  const resolved=resolveResourcesRoot({env:process.env,resourcesPath:process.resourcesPath,appIsPackaged:app.isPackaged,desktopDir:__dirname,platform:process.platform});
  const resources=resolved.root;
  process.env.XYCUT_RESOURCES=resources;
  const runtimePaths={event:'resources-resolved',resourcesRoot:resources,candidates:resolved.candidates,appIsPackaged:app.isPackaged,platform:process.platform,arch:process.arch,python:resolved.python,ffmpeg:resolved.ffmpeg,ffprobe:resolved.ffprobe,frontend:resolved.frontend,coreWorker:resolved.coreWorker,agentKit:resolved.agentKit,builtinPresets:resolved.builtinPresets,draftShell:resolved.draftShell,buildManifest:resolved.buildManifest,checks:resolved.checks};
  write(path.join(dataDir,'runtime-paths.json'),runtimePaths);
  console.log(JSON.stringify(runtimePaths));
  const desktop={
    openPath:async file=>{const error=await shell.openPath(file);if(error)throw new Error(error);},
    restartJianying:async()=>{
      const target=resolveJianying({platform:process.platform,env:process.env,settings:service.settings});
      if(!target)throw new Error('未找到剪映，请确认本机已安装剪映并保留原应用名称。');
      if(process.platform==='darwin'){
        const name=applicationName(target);
        await run('/usr/bin/osascript',['-e',`tell application "${name.replace(/"/g,'\\"')}" to quit`]).catch(()=>{});
        await run('/usr/bin/open',['-a',target]);
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
      if(name==='plugin:app|version')return '0.2.10';
      if(name==='plugin:app|name')return 'XYCut';
      if(name==='plugin:resources|close')return;
      throw new Error('桌面接口尚未支持：'+name);
    }
  };
  service=new Service({resources,dataDir,desktop});
  const local=await startServer(service,{port:Number(process.env.XYCUT_PORT||17652)});server=local.server;
  await service.context();
  window=new BrowserWindow({width:660,height:655,minWidth:420,minHeight:655,frame:false,show:false,backgroundColor:'#f8fafc',icon:path.join(resources,'frontend/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  service.commandErrors=[];
  ipcMain.handle('xycut:invoke',async(event,name,args)=>{if(event.sender!==window.webContents || !event.senderFrame.url.startsWith(local.url+'/'))throw new Error('来源不合法');try{return await service.invoke(name,args);}catch(error){service.commandErrors.push({name,message:error.message});throw error;}});
  window.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith(local.url+'/')){const child=new BrowserWindow({width:1200,height:850,parent:window,webPreferences:{contextIsolation:true,nodeIntegration:false}});child.loadURL(url);}else if(/^https?:/.test(url))shell.openExternal(url);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(local.url+'/')){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url);}});
  for(const event of ['resize','focus','blur'])window.on(event,()=>{window.webContents.send('xycut:event',{event:'tauri://'+event,payload:event==='resize'?{width:window.getBounds().width,height:window.getBounds().height}:null});});
  window.webContents.on('console-message',details=>{if(details.level==='warning'||details.level==='error')console.error(details.message);});
  trayController=createTray({app,window,resources});
  await window.loadURL(local.url);window.show();
  if(smoke)await require('../tests/desktop-smoke.cjs').run({window,service,app,dataDir});
}
app.on('window-all-closed',()=>{server?.close();app.quit();});
app.on('before-quit',()=>server?.close());
