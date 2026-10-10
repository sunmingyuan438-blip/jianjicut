const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('xycutDesktop',{
  platform:process.platform,
  arch:process.arch,
  invoke:(name,args)=>ipcRenderer.invoke('xycut:invoke',name,args),
  onEvent:callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('xycut:event',handler);return()=>ipcRenderer.removeListener('xycut:event',handler);},
  filePath:file=>webUtils.getPathForFile(file),
});
