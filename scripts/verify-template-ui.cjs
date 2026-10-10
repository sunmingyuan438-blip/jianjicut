const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const Zip=require('adm-zip');
const appRoot=process.env.XYCUT_TEST_APP_ROOT?path.resolve(process.env.XYCUT_TEST_APP_ROOT):path.resolve(__dirname,'..');
const {Service}=require(path.join(appRoot,'backend/service.cjs'));
const {startServer}=require(path.join(appRoot,'backend/server.cjs'));
const {analyzeTemplate}=require(path.join(appRoot,'backend/template.cjs'));
const {read,write}=require(path.join(appRoot,'backend/util.cjs'));
const root=path.resolve(__dirname,'../.test-data/'+(process.env.XYCUT_TEST_APP_ROOT?'template-ui-installed':'template-ui'));
const runRoot=path.join(root,crypto.randomUUID());
app.setPath('userData',path.join(runRoot,'electron'));
app.disableHardwareAcceleration();
const resources=process.env.XYCUT_TEST_APP_ROOT?path.join(path.dirname(appRoot),'xycut'):path.join(appRoot,'resources');
const service=new Service({resources,dataDir:path.join(runRoot,'data')});
let window,local,files;
const commands=[],requests=[],commandErrors=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=async code=>{
  try{return await window.webContents.executeJavaScript(code);}
  catch(error){throw new Error(error.message+'\nExpression: '+code+'\nPage: '+await window.webContents.executeJavaScript('document.body.innerText'));}
};
async function waitFor(code,label){
  for(let i=0;i<150;i++){if(await evaluate(code))return;await delay(80);}
  throw new Error('等待失败：'+label+'\n'+await evaluate('document.body.innerText'));
}
async function click(label,scope='document'){
  await evaluate(`(()=>{const button=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(label.replace(/\s/g,''))}&&e.getClientRects().length);if(!button||button.disabled)throw new Error('按钮不可用：'+${JSON.stringify(label)});button.click();})()`);
  await delay(100);
}
async function closeNotice(){await evaluate(`document.querySelectorAll('.dialog-close-button').forEach(e=>e.click());[...document.querySelectorAll('button')].filter(e=>['知道了','我知道了','关闭'].includes(e.textContent.trim())&&e.getClientRects().length).forEach(e=>e.click());`);}
async function main(){
  const presetDir=path.join(runRoot,'剪映 Presets');
  await service.installFolder(path.join(resources,'builtin-presets/xycut_001'),presetDir);
  const packages={};
  for(const kind of ['hot_template','video_template']){
    const source=path.join(resources,'builtin-presets/xycut_001');
    const config=analyzeTemplate(source,kind,kind+'-fixture');
    config.analysis_reviewed=true;
    config.excluded_media_slots=[{index:91,enabled:false,exclude_reason:'fixed_content'}];
    const zip=new Zip();zip.addLocalFolder(source,'template');zip.addFile('template/template-config.json',Buffer.from(JSON.stringify(config)));
    packages[kind]={config,bytes:zip.toBuffer()};
  }
  files=http.createServer((req,res)=>{const item=packages[req.url.slice(1)];if(!item){res.writeHead(404);res.end('fixture failure');return;}res.end(item.bytes);});
  await new Promise(resolve=>files.listen(0,'127.0.0.1',resolve));
  const downloadBase=`http://127.0.0.1:${files.address().port}`;
  const catalog=kind=>({templates:[{slug:kind+'-fixture',name:kind==='hot_template'?'爆款安装验收':'视频安装验收',credit_cost:0,member_only:false,template_config:kind==='hot_template'?packages[kind].config:undefined},{slug:'broken-'+kind,name:'失败模板',credit_cost:0,member_only:false}],pagination:{page:1,page_size:100,total:2},category_options:[]});
  await session.defaultSession.protocol.handle('https',async request=>{
    const url=new URL(request.url);requests.push({path:url.pathname,method:request.method});
    let result={};
    if(url.pathname==='/api/app-config')result={features:{membership_enabled:true}};
    else if(url.pathname==='/api/hot-templates')result=catalog('hot_template');
    else if(url.pathname==='/api/video-templates')result=catalog('video_template');
    else if(url.pathname==='/api/presets')result={presets:[],pagination:{page:1,page_size:100,total:0}};
    else if(url.pathname==='/api/templates/download'){
      const input=await request.json();
      result={download_url:downloadBase+'/'+(input.slug.startsWith('broken-')?'missing':input.type),allowed:true,credit_cost:0};
    }else if(url.pathname==='/api/pay/products')result={products:[]};
    else if(!url.pathname.startsWith('/api/'))return new Response(fs.readFileSync(path.join(resources,'frontend/icon.png')),{headers:{'Content-Type':'image/png'}});
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
  });
  local=await startServer(service,{port:0});await service.context();
  window=new BrowserWindow({width:1100,height:900,show:true,webPreferences:{preload:path.join(appRoot,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  service.desktop={invokePlugin:async(name,args)=>{
    if(name==='plugin:app|version')return '0.2.10';
    if(name==='plugin:app|name')return 'XYCut';
    if(name==='plugin:resources|close')return;
    if(name.startsWith('plugin:window|')){
      const command=name.split('|')[1];
      if(['inner_size','outer_size'].includes(command))return {width:1100,height:900};
      if(command==='current_monitor')return {name:'Fixture',size:{width:1920,height:1080},position:{x:0,y:0},scaleFactor:1};
      if(command==='scale_factor')return 1;
      if(command.startsWith('is_'))return false;
      return;
    }
    throw new Error('未授权的测试桌面接口：'+name);
  }};
  ipcMain.handle('xycut:invoke',async(event,name,args)=>{
    assert.equal(event.sender,window.webContents);commands.push({name});
    try{return await service.invoke(name,args);}catch(error){commandErrors.push({name,message:error.message});throw error;}
  });
  await window.loadURL(local.url);
  await evaluate(`localStorage.setItem('xiaoyuan.aiEditingEnabled','true');localStorage.setItem('xiaoyuan.customPresetDir',${JSON.stringify(presetDir)});`);
  await window.loadURL(local.url);
  await waitFor('document.body.innerText.length>100','首页');
  await evaluate(`(()=>{window.__copied=[];try{navigator.clipboard.writeText=async text=>{window.__copied.push(text);};}catch{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied.push(text);}}});}return true;})()`);
  await delay(500);
  const cases=[];
  for(const [kind,nav,name] of [['hot_template','爆款模板','爆款安装验收'],['video_template','AI剪辑','视频安装验收']]){
    await closeNotice();await click(nav);
    await waitFor(`!![...document.querySelectorAll('.hot-template-card')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`,name);
    const scope=`[...document.querySelectorAll('.hot-template-card')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`;
    const before=await evaluate('window.__copied.length');
    await click('复制提示词',scope);
    await waitFor(`window.__copied.length===${before+1}`,'模板提示词已复制');
    const prompt=await evaluate('window.__copied.at(-1)');
    const configFile=prompt.match(/模板参数：([^\r\n]+)/)?.[1];
    const contextFile=prompt.match(/Agent 上下文文件：\s*([^\r\n]+)/)?.[1];
    assert.ok(configFile&&fs.existsSync(configFile));assert.ok(contextFile&&fs.existsSync(contextFile));
    assert.deepEqual(read(configFile).excluded_media_slots,packages[kind].config.excluded_media_slots);
    assert.equal(read(configFile).analysis_reviewed,true);
    assert.match(prompt,new RegExp(kind==='hot_template'?'xycut-hot-template-skill':'xycut-video-template-skill'));
    fs.writeFileSync(path.join(root,kind+'.png'),(await window.webContents.capturePage()).toPNG());
    await closeNotice();
    const failBefore=await evaluate('window.__copied.length');
    await click('复制提示词',"[...document.querySelectorAll('.hot-template-card')].find(e=>e.textContent.includes('失败模板'))");
    await waitFor(`document.body.innerText.includes('404')`,'下载错误显示');
    assert.equal(await evaluate('window.__copied.length'),failBefore);
    cases.push({kind,prompt_config_exists:true,prompt_context_exists:true,reviewed_config_preserved:true,failed_download_did_not_copy:true});
  }
  const conversions=[];
  for(const [kind,label] of [['hot_template','保存为爆款模板'],['video_template','保存为视频模板']]){
    await closeNotice();await click('本地预设');
    await waitFor(`!!document.querySelector('.preset-card')`,'本地预设卡片');
    await evaluate(`document.querySelector('.preset-card .media-frame').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:200}));`);
    await waitFor(`!!document.querySelector('.preset-context-menu')`,'预设菜单');
    await click(label,"document.querySelector('.preset-context-menu')");
    await waitFor(`document.body.innerText.includes(${JSON.stringify(kind==='hot_template'?'已保存为本地爆款模板':'已保存为本地视频模板')})`,label);
    assert.ok(commands.some(item=>item.name==='save_local_preset_as_'+kind));
    const result=service.templates(kind).templates.find(item=>item.slug==='xycut_001');
    assert.ok(result&&fs.existsSync(result.template_config_file));
    fs.writeFileSync(path.join(root,'local-'+kind+'.png'),(await window.webContents.capturePage()).toPNG());
    conversions.push({kind,ui_invoked:true,config_exists:true});
  }
  assert.equal(requests.some(item=>item.path.startsWith('/api/auth/')),false);
  assert.equal(commandErrors.length,2);assert.ok(commandErrors.every(item=>item.name==='install_online_preset'&&item.message.includes('404')));
  const report={build_id:read(path.join(resources,'restoration-build.json')).id,app_root:appRoot,resources,ok:true,cases,local_conversion_without_login:true,local_conversion_ui:conversions,remote_membership_enabled_in_fixture:true,paid_or_live_provider_calls:false,command_errors:commandErrors,commands,requests};
  write(path.join(root,'template-ui-report.json'),report);console.log(JSON.stringify(report));
}
function finish(code){local?.server.close();files?.close();window?.destroy();app.exit(code);}
app.whenReady().then(main).then(()=>finish(0)).catch(error=>{write(path.join(root,'template-ui-report.json'),{ok:false,message:error.message,stack:error.stack,commands,commandErrors,requests});console.error(error);finish(1);});
