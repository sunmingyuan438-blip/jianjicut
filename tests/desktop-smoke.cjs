const fs=require('node:fs');
const path=require('node:path');
const {write,read}=require('../backend/util.cjs');
const {makeCutPlan}=require('../backend/workbench.cjs');
const {BrowserWindow}=require('electron');
exports.run=async({window,service,app,dataDir})=>{
  const errors=[];
  window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  window.webContents.on('render-process-gone',(_e,d)=>errors.push(d.reason));
  await new Promise(resolve=>setTimeout(resolve,2000));
  await window.webContents.executeJavaScript(`document.querySelectorAll('button').forEach(e=>{if(e.textContent==='稍后提醒')e.click();})`);
  const pages=[];
  for(const label of ['首页','AI剪辑','爆款模板','素材库','在线预设','本地预设','收藏','设置']){
    const result=await window.webContents.executeJavaScript(`(()=>{const items=[...document.querySelectorAll('button')];const element=items.find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(label)});if(!element)return {found:false,text:document.body.innerText.slice(0,1200)};element.click();return {found:true};})()`);
    await new Promise(resolve=>setTimeout(resolve,500));
    pages.push({label,...result,text:await window.webContents.executeJavaScript('document.body.innerText.slice(0,1200)')});
    fs.mkdirSync(path.join(dataDir,'screenshots'),{recursive:true});const image=await window.webContents.capturePage();fs.writeFileSync(path.join(dataDir,'screenshots',label+'.png'),image.toPNG());
  }
  const integration={};
  try{
    integration.doubao=await require('./desktop-ai-smoke.cjs').run({window,dataDir});
    integration.ai_switch=await require('./desktop-ai-smoke.cjs').runSwitch({window,service,dataDir});
    const library=await service.invoke('create_sucai_library',{name:'安装包验收素材库'});
    integration.sqlite=library.status.libraries.some(item=>item.id===library.library_id);
    await service.invoke('delete_sucai_library',{libraryId:library.library_id});
    integration.pillow=JSON.parse(await require('../backend/util.cjs').run(service.python(),['-c','import PIL,json; print(json.dumps({"version":PIL.__version__}))']));
    integration.ffmpeg=await require('../backend/util.cjs').run(service.tool('ffmpeg'),['-version']);
    integration.ffmpeg=integration.ffmpeg.split('\n')[0];
    const output=path.join(dataDir,'generated-drafts');fs.mkdirSync(output,{recursive:true});
    const generated=await service.generate({mode:'template_designer',draft_output_dir:output,generation_plan:{draft_name:'恢复版_安装包验收',duration_ms:1000,canvas:{width:1080,height:1920},background:{type:'image',file_path:path.join(service.resources,'frontend/background.jpg'),box:{x:0,y:0,w:1080,h:1920}},text_blocks:[{text:'Mac 与 Windows 核心验收',role:'headline',box:{x:120,y:160,w:840,h:96},style:{font_size_px:60,color:'#FFFFFF',align:'center'}}]}});
    const content=require('../backend/util.cjs').read(generated.draft_content);
    integration.core={ok:content.duration===1000000&&content.materials.texts.some(item=>item.content.includes('Mac 与 Windows 核心验收')),draft_dir:generated.draft_dir,duration_us:content.duration,tracks:content.tracks.map(item=>item.type)};
    const template=await service.invoke('save_local_preset_as_video_template',{presetDir:path.join(service.resources,'builtin-presets/xycut_001'),templateName:'验收视频模板'});
    const task=path.join(dataDir,'video-task'),oldTimeline={source_duration:1.366666,duration:1.366666,lines:[{line_id:'line_001',start:0,end:1.366666,text:'第一句字幕'}]};
    const plan={mode:'video_template',template_dir:template.template_dir,template_config_file:template.template_config_file,draft_output_dir:output,timeline_duration_ms:1367,source_video:{file_path:path.join(service.resources,'builtin-presets/xycut_001/xycut_001.mp4'),duration_ms:1367,width:1080,height:1920},title:{items:[{text:'修改前标题'},{text:'副标题'}]},subtitles:[{line_id:'line_001',text:'第一句字幕',lines:['第一句字幕'],start_ms:0,end_ms:1367,duration_ms:1367,style_level:'01'}],line_timeline:oldTimeline};
    const analysisFile=path.join(task,'output/video_template_analysis.json'),cutFile=path.join(task,'edit/cut_plan.json'),timelineFile=path.join(task,'edit/line_timeline.json');
    write(analysisFile,{...plan,generation_plan:plan,title:{lines:['双平台视频剪辑验收','副标题'],items:[{text:'双平台视频剪辑验收'},{text:'副标题'}]}});write(cutFile,makeCutPlan([{start:.2,end:.4}],1.366666));write(timelineFile,{source_duration:1.366666,duration:1.166666,lines:[{line_id:'line_001',start:0,end:1.166666,text:'第句字幕'}]});
    const video=await service.generate({analysis_file:analysisFile,cut_plan_file:cutFile,line_timeline_file:timelineFile});
    const draft=read(video.draft_content),texts=[];function collect(value){if(Array.isArray(value)){value.forEach(collect);return;}if(!value||typeof value!=='object')return;for(const item of value.materials?.texts||[]){try{texts.push(JSON.parse(item.content).text);}catch{}}Object.values(value).forEach(collect);}collect(draft);
    integration.video={ok:draft.duration===1167000&&texts.includes('双平台视频剪辑验收')&&texts.includes('第句字幕'),draft_dir:video.draft_dir,duration_us:draft.duration,texts:[...texts]};
    const preview=new BrowserWindow({width:850,height:750,parent:window,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    preview.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
    try{
      await preview.loadURL(`http://127.0.0.1:${service.port}/ai-editing/video-template/preview?analysis_file=`+encodeURIComponent(analysisFile));
      const heading=await preview.webContents.executeJavaScript('document.querySelector("h1")?.textContent');
      if(heading!=='视频模板分析预览')throw new Error('独立分析预览页未正确加载');
      await preview.webContents.executeJavaScript(`(()=>{const title=document.querySelector('.title-input');if(!title)throw new Error('预览页没有标题编辑框');title.value='双平台预览编辑验收';title.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#generateBtn').click();})()`);
      const deadline=Date.now()+15000;let status='';
      while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));status=await preview.webContents.executeJavaScript('document.querySelector("#dirtyBadge").textContent');if(status==='生成成功')break;}
      const latest=fs.readdirSync(output).map(name=>({folder:path.join(output,name),time:fs.statSync(path.join(output,name)).mtimeMs})).sort((a,b)=>b.time-a.time)[0];
      const result=read(path.join(latest.folder,'draft_content.json'));texts.length=0;collect(result);
      await new Promise(resolve=>setTimeout(resolve,300));
      let screenshotError=null;
      try{const image=await preview.webContents.capturePage();fs.writeFileSync(path.join(dataDir,'screenshots/视频模板分析预览.png'),image.toPNG());}catch(error){screenshotError=error.message;}
      integration.preview={ok:status==='生成成功'&&result.duration===1167000&&texts.includes('双平台预览编辑验收')&&texts.includes('第句字幕'),status,draft_dir:latest.folder,duration_us:result.duration,texts:[...texts],screenshot_error:screenshotError};
    }finally{preview.destroy();}
  }catch(error){errors.push(error.stack||error.message);}
  const report={build_id:read(path.join(service.resources,'restoration-build.json'),{}).id,pages,errors,integration,commandErrors:service.commandErrors,runtime_paths:service.resourceStatus(),platform:process.platform,arch:process.arch,version:app.getVersion(),pass:pages.every(p=>p.found)&&integration.doubao?.ok===true&&integration.ai_switch?.ok===true&&integration.sqlite===true&&integration.core?.ok===true&&integration.video?.ok===true&&integration.preview?.ok===true&&errors.length===0&&service.commandErrors.length===0};
  write(path.join(dataDir,'desktop-smoke.json'),report);console.log(JSON.stringify({report:path.join(dataDir,'desktop-smoke.json'),pass:report.pass,pages:pages.map(p=>({label:p.label,found:p.found}))}));
  app.exit(report.pass?0:1);
};
