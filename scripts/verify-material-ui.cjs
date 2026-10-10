const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {startServer}=require('../backend/server.cjs');
const {write,read}=require('../backend/util.cjs');
const {fixture,image,digest,analysis,index,cleanup}=require('../tests/material-lifecycle.test.cjs');
const root=path.resolve(__dirname,'../.test-data/material-lifecycle-ui');
const f=fixture(),service=f.service;
fs.mkdirSync(root,{recursive:true});
// Chromium holds its profile open until process exit; keep it outside fixture cleanup.
app.setPath('userData',path.join(root,'electron'));
app.disableHardwareAcceleration();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let window,server,local;
const commands=[],consoleErrors=[],captureErrors=[];
async function button(text,scope='document'){
  await window.webContents.executeJavaScript(`(()=>{const element=[...${scope}.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)}&&item.getClientRects().length);if(!element)throw new Error('缺少按钮：'+${JSON.stringify(text)});if(element.disabled)throw new Error('按钮不可用：'+${JSON.stringify(text)});element.click();})()`);
  await delay(75);
}
async function waitFor(predicate,label){
  const deadline=Date.now()+5000;while(Date.now()<deadline){if(await predicate())return;await delay(80);}throw new Error('等待失败：'+label);
}
async function capture(name){try{const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(root,name+'.png'),screenshot.toPNG());}catch(error){captureErrors.push({name,message:error.message});}}
async function drop(paths){
  await delay(200);
  window.webContents.send('xycut:event',{event:'tauri://drag-drop',payload:{paths,position:{x:200,y:200}}});
  await waitFor(async()=>{const value=await window.webContents.executeJavaScript("document.querySelector('.sucai-modal textarea')?.value||''");return paths.every(item=>value.includes(item));},'拖入目录显示');
}
async function materialState(){return service.invoke('get_sucai_db_status');}
async function selectAll(){await window.webContents.executeJavaScript('document.querySelector(\'input[aria-label="选择当前页素材"]\').click()');await delay(100);assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.sucai-table tbody input:checked').length"),2);}
async function main(){
  fs.mkdirSync(root,{recursive:true});
  const created=await service.invoke('create_sucai_library',{name:'原界面素材生命周期验收'}),library=created.library_id;
  const originalA=image(path.join(f.source,'一级','二级','三级','产品 A.png'),'A');
  const originalB=image(path.join(f.source,'另一组','产品 B.png'),'B');
  const originalC=image(path.join(f.source,'第二批','产品 C.png'),'C');
  const originals=[originalA,originalB,originalC],hashes=originals.map(digest);
  const started=await startServer(service,{port:0});server=started.server;local=started;
  await service.context();
  service.desktop={invokePlugin:async(name,args)=>{
    if(name==='plugin:app|version')return'0.2.10';
    if(name==='plugin:app|name')return'XYCut';
    if(name==='plugin:resources|close')return;
    if(name.startsWith('plugin:window|')){
      const command=name.split('|')[1],bounds=window.getBounds(),size=args.value?.Logical||args.value?.Physical||args.value||args.size;
      const handlers={is_maximized:()=>window.isMaximized(),is_minimized:()=>window.isMinimized(),is_visible:()=>window.isVisible(),is_focused:()=>window.isFocused(),scale_factor:()=>1,inner_size:()=>({width:bounds.width,height:bounds.height}),outer_size:()=>({width:bounds.width,height:bounds.height}),current_monitor:()=>({name:'Fixture',size:{width:1920,height:1080},position:{x:0,y:0},scaleFactor:1}),set_size:()=>window.setSize(Math.round(size.width),Math.round(size.height)),set_min_size:()=>window.setMinimumSize(Math.round(size.width),Math.round(size.height)),set_resizable:()=>window.setResizable(args.value),set_decorations:()=>{},set_title:()=>{},show:()=>window.show(),hide:()=>window.hide(),set_focus:()=>window.focus(),center:()=>window.center(),minimize:()=>window.minimize(),maximize:()=>window.maximize(),unmaximize:()=>window.unmaximize(),toggle_maximize:()=>window.isMaximized()?window.unmaximize():window.maximize()};
      if(handlers[command])return handlers[command]();
    }
    throw new Error('界面测试没有授权此桌面调用：'+name);
  }};
  window=new BrowserWindow({width:1000,height:900,show:true,webPreferences:{preload:path.resolve(__dirname,'../desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.on('console-message',details=>{if(details.level==='error')consoleErrors.push(details.message);});
  ipcMain.handle('xycut:invoke',async(event,name,args)=>{
    if(event.sender!==window.webContents||!event.senderFrame.url.startsWith(local.url+'/'))throw new Error('测试调用来源不合法');
    commands.push({name});return service.invoke(name,args);
  });
  await window.loadURL(local.url);await delay(1000);
  await button('素材库');await waitFor(async()=>await window.webContents.executeJavaScript("!!document.querySelector('.sucai-library-card')"),'库卡片');
  await button('进入素材库');await button('添加素材');
  await drop([path.join(f.source,'一级'),path.join(f.source,'另一组'),originalA]);
  await button('添加素材',"document.querySelector('.sucai-modal')");
  await waitFor(async()=>await window.webContents.executeJavaScript("!!document.querySelector('.sucai-modal-addResult')"),'第一批结果');
  let state=await materialState();assert.equal(state.pending_source_count,2);assert.deepEqual(new Set(state.source_materials.map(item=>item.original_path)),new Set([originalA,originalB]));
  await capture('递归分批导入');
  await button('继续添加素材');await drop([originalC,originalA]);await button('添加素材',"document.querySelector('.sucai-modal')");
  await waitFor(async()=>await window.webContents.executeJavaScript("!!document.querySelector('.sucai-modal-addResult')"),'第二批结果');
  state=await materialState();assert.equal(state.pending_source_count,3);assert.equal(commands.filter(item=>item.name==='import_sucai_materials').length,2);
  assert.match(await window.webContents.executeJavaScript("document.querySelector('.sucai-modal').innerText"),/已添加 1 个待整理素材.*跳过 1 个/);
  await window.webContents.executeJavaScript('document.querySelector(\'[aria-label="关闭素材库面板"]\').click()');
  const processed=await analysis(service,state.source_materials.filter(item=>item.original_path!==originalC),'界面分析');await index(service,processed);
  await button('刷新');await waitFor(async()=>await window.webContents.executeJavaScript("document.querySelectorAll('.sucai-table tbody tr.sucai-clickable-row').length===2"),'正式素材表格');
  assert.match(await window.webContents.executeJavaScript("document.querySelector('.sucai-inline-stats').innerText"),/可智能匹配 2 \/ 2/);
  await capture('理解完成与可匹配');
  await window.webContents.executeJavaScript("document.querySelector('.sucai-inline-text-button').click()");await delay(100);
  let beforeCount=commands.filter(item=>item.name==='clear_sucai_pending_sources').length;
  await button('取消',"document.querySelector('.confirm-dialog')");assert.equal(commands.filter(item=>item.name==='clear_sucai_pending_sources').length,beforeCount);assert.equal((await materialState()).pending_source_count,1);
  await window.webContents.executeJavaScript("document.querySelector('.sucai-inline-text-button').click()");await delay(100);await button('确认清除',"document.querySelector('.confirm-dialog')");
  await waitFor(async()=>(await materialState()).pending_source_count===0,'清空pending');assert.equal((await materialState()).material_count,2);assert.deepEqual(originals.map(digest),hashes);
  await window.webContents.executeJavaScript("document.querySelector('.sucai-clickable-row').click()");await delay(100);
  await window.webContents.executeJavaScript("(()=>{const element=document.querySelector('.sucai-material-summary-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,'界面修改后的红色产品');element.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await delay(75);await button('保存修改',"document.querySelector('.sucai-material-modal')");
  await waitFor(async()=>!(await window.webContents.executeJavaScript("!!document.querySelector('.sucai-material-modal')")),'修改已保存');
  state=await materialState();assert.equal(state.materials.filter(item=>item.summary==='界面修改后的红色产品').length,1);assert.equal(state.embedding_count,1);assert.equal(state.libraries[0].analyzed_count,2);assert.equal(state.libraries[0].embedded_count,1);
  assert.match(await window.webContents.executeJavaScript("document.querySelector('.sucai-inline-stats').innerText"),/可智能匹配 1 \/ 2/);
  const resetSnapshot=JSON.stringify(state.materials);await selectAll();await button('重新分析',"document.querySelector('.sucai-batch-toolbar')");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.confirm-dialog strong').textContent"),'批量重新分析素材？');
  await capture('批量重置确认');beforeCount=commands.filter(item=>item.name==='reset_sucai_material_analysis').length;
  await button('取消',"document.querySelector('.confirm-dialog')");assert.equal(commands.filter(item=>item.name==='reset_sucai_material_analysis').length,beforeCount);assert.equal(JSON.stringify((await materialState()).materials),resetSnapshot);
  await button('重新分析',"document.querySelector('.sucai-batch-toolbar')");await button('确认重新分析',"document.querySelector('.confirm-dialog')");
  await waitFor(async()=>await window.webContents.executeJavaScript("!document.querySelector('.confirm-dialog')"),'批量重置结束');
  state=await materialState();assert.equal(state.material_count,2);assert.equal(state.embedding_count,0);assert.ok(state.materials.every(item=>item.analysis_status==='pending'&&item.summary===''&&item.embedding_status==='pending'));
  assert.equal(commands.filter(item=>item.name==='reset_sucai_material_analysis').length-beforeCount,2);assert.deepEqual(originals.map(digest),hashes);
  const copied=state.materials.map(item=>item.path),deleteSnapshot=JSON.stringify(state.materials);
  await selectAll();await button('删除',"document.querySelector('.sucai-batch-toolbar')");assert.equal(await window.webContents.executeJavaScript("document.querySelector('.confirm-dialog strong').textContent"),'批量删除素材？');
  await capture('批量删除确认');beforeCount=commands.filter(item=>item.name==='delete_sucai_material').length;
  await button('取消',"document.querySelector('.confirm-dialog')");assert.equal(commands.filter(item=>item.name==='delete_sucai_material').length,beforeCount);assert.equal(JSON.stringify((await materialState()).materials),deleteSnapshot);assert.ok(copied.every(fs.existsSync));
  await button('删除',"document.querySelector('.sucai-batch-toolbar')");await button('确认删除',"document.querySelector('.confirm-dialog')");
  await waitFor(async()=>await window.webContents.executeJavaScript("!document.querySelector('.confirm-dialog')"),'批量删除结束');
  state=await materialState();assert.equal(state.material_count,0);assert.equal(state.embedding_count,0);assert.ok(copied.every(file=>!fs.existsSync(file)));assert.deepEqual(originals.map(digest),hashes);
  assert.equal(commands.filter(item=>item.name==='delete_sucai_material').length-beforeCount,2);
  await capture('删除后原始文件保留');assert.deepEqual(consoleErrors,[]);
  const report={build_id:read(path.join(service.resources,'restoration-build.json')).id,ok:true,requirements:['F-23','F-26','F-31','F-32'],recursive_batches:2,imported:3,completed_materials:2,edited_materials:1,clear_pending:{cancel_kept:1,confirmed_removed:1,completed_kept:2},batch_reset:{cancel_unchanged:true,confirmed:2},batch_delete:{cancel_unchanged:true,confirmed:2,copies_removed:2,original_files_unchanged:3},index_backend_fixture_only:true,paid_or_live_provider_calls:false,console_errors:consoleErrors,capture_errors:captureErrors,command_counts:Object.fromEntries([...new Set(commands.map(item=>item.name))].map(name=>[name,commands.filter(item=>item.name===name).length]))};
  write(path.join(root,'material-ui-report.json'),report);console.log(JSON.stringify(report));
}
app.whenReady().then(main).then(()=>{server?.close();window?.destroy();cleanup();app.exit(0);}).catch(error=>{
  write(path.join(root,'material-ui-report.json'),{ok:false,message:error.message,stack:error.stack,console_errors:consoleErrors,commands});console.error(error);server?.close();window?.destroy();cleanup();app.exit(1);
});
