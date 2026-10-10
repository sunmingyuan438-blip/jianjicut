const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Service}=require('../backend/service.cjs');
const {startServer}=require('../backend/server.cjs');
const {read,write}=require('../backend/util.cjs');
const root=path.resolve(__dirname,'../.test-data/workbench-ui');
app.setPath('userData',path.join(root,'electron'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const service=new Service({resources:path.resolve(__dirname,'../resources'),dataDir:path.join(root,'data')});
  const local=await startServer(service,{port:0});
  let window;
  try{
    const task=path.join(root,'task'),output=path.join(root,'generated-drafts');fs.mkdirSync(output,{recursive:true});
    assert.equal(path.dirname(path.resolve(task)),root);fs.rmSync(task,{recursive:true,force:true});
    fs.mkdirSync(path.join(task,'input'),{recursive:true});fs.copyFileSync(path.resolve(__dirname,'../.test-data/e2e/input/source.mp4'),path.join(task,'input/source.mp4'));
    const plan=read(path.resolve(__dirname,'../.test-data/e2e/video_template-plan.json'));
    plan.source_video.file_path=path.join(task,'input/source.mp4');plan.draft_output_dir=output;
    plan.title={items:[{text:'工作台主标题'},{text:'工作台副标题'},{text:'可编辑说明文案'}]};
    delete plan.titles;
    const lines=plan.subtitles.map((line,index)=>{const chars=[...line.text],start=line.start_ms/1000,end=line.end_ms/1000;return{line_id:'line_'+String(index+1).padStart(3,'0'),start,end,text:line.text,words:chars.map((word,n)=>({idx:index*100+n,word,text:word,start:start+(end-start)*n/chars.length,end:start+(end-start)*(n+1)/chars.length}))};});
    write(path.join(task,'speech/segments.json'),{duration:3,segments:lines});
    write(path.join(task,'edit/line_timeline.json'),{schema_version:1,source_duration:3,duration:3,lines});
    write(path.join(task,'edit/review_state.json'),{schema_version:1,deleted_line_ids:[],deleted_word_indices:[],manual_time_ranges:[],protected_ranges:[],review_lines:[],word_text_overrides:{}});
    plan.edit_files={line_timeline_file:path.join(task,'edit/line_timeline.json'),cut_plan_file:path.join(task,'edit/cut_plan.json')};
    write(path.join(task,'output/video_template_plan.json'),plan);
    await service.script('xycut-video-template-skill','analyze_video_template_plan.py',['--plan',path.join(task,'output/video_template_plan.json'),'--template-config-file',plan.template_config_file,'--analysis-output',path.join(task,'output/video_template_analysis.json')]);
    await service.context({draft_output_dir:output});
    const opened=local.workbench.open({task_dir:task});
    const failures=[],warnings=[],requests=[],captureErrors=[];
    window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    window.webContents.on('console-message',details=>{if(details.level==='error')failures.push(details.message);else if(details.level==='warning')warnings.push(details.message);});
    window.webContents.session.webRequest.onCompleted(details=>{if(details.url.startsWith(local.url))requests.push({url:details.url,status:details.statusCode});});
    await window.loadURL(opened.url);await new Promise(resolve=>setTimeout(resolve,1200));
    const steps=[];
    for(const step of ['cut','material','draft']){
      await window.webContents.executeJavaScript(`document.querySelector('.tab[data-step="${step}"]').click()`);
      await new Promise(resolve=>setTimeout(resolve,700));
      const state=await window.webContents.executeJavaScript(`({status:document.querySelector('#saveStatus').textContent,text:document.querySelector('#mainScroll').innerText,buttons:[...document.querySelectorAll('#mainScroll button')].map(b=>({text:b.textContent,id:b.id,className:b.className})),words:[...document.querySelectorAll('[data-word]')].map(e=>({text:e.textContent,idx:e.dataset.word})),titles:[...document.querySelectorAll('.draft-title-input')].map(e=>e.value)})`);
      try{const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(root,step+'.png'),screenshot.toPNG());}catch(error){captureErrors.push({step,error:error.message});}
      steps.push({step,...state});
      if(step==='cut'){
        await window.webContents.executeJavaScript(`(()=>{const word=document.querySelector('[data-word="1"]');if(!word)throw new Error('缺少逐字字幕');const box=word.getBoundingClientRect();word.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:box.left+3,clientY:box.top+3}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:box.left+3,clientY:box.top+3}));document.querySelector('#selectionPrimary').click();})()`);
        const savedDeadline=Date.now()+4000;let saved;
        while(Date.now()<savedDeadline){await new Promise(resolve=>setTimeout(resolve,100));saved=read(path.join(task,'edit/review_state.json'));if(saved.deleted_word_indices?.includes(1))break;}
        assert.deepEqual(saved.deleted_word_indices,[1]);
      }
      if(step==='material'){
        await window.webContents.executeJavaScript(`document.querySelector('[data-material-local-add]').click()`);
        await window.webContents.executeJavaScript(`document.querySelector('#localMaterialPathInput').value=${JSON.stringify(path.join(service.resources,'frontend/background.jpg'))};document.querySelector('#confirmLocalMaterialPath').click()`);
        await new Promise(resolve=>setTimeout(resolve,500));
        assert.equal(read(path.join(task,'output/material_plan.json')).items.length,1);
      }
    }
    await window.webContents.executeJavaScript(`(()=>{const title=document.querySelector('.draft-title-input');if(!title)throw new Error('缺少标题编辑框');title.value='工作台改字验收';title.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#nextStep').click();})()`);
    let resultText='';const deadline=Date.now()+15000;
    while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,200));resultText=await window.webContents.executeJavaScript('document.body.innerText');if(resultText.includes('剪映草稿已生成')||resultText.includes('生成失败'))break;}
    assert.match(resultText,/剪映草稿已生成/);
    const drafts=fs.readdirSync(output).map(name=>({folder:path.join(output,name),time:fs.statSync(path.join(output,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
    const content=read(path.join(drafts[0].folder,'draft_content.json'));
    const texts=[];function collect(value){if(Array.isArray(value)){value.forEach(collect);return;}if(!value||typeof value!=='object')return;for(const text of value.materials?.texts||[]){try{texts.push(JSON.parse(text.content).text);}catch{}}Object.values(value).forEach(collect);}collect(content);
    const cut=read(path.join(task,'edit/cut_plan.json'));
    assert.ok(texts.includes('工作台改字验收'));assert.ok(texts.includes('第句验证字幕'));assert.equal(content.duration,Math.round(cut.duration*1000000));
    assert.ok(requests.filter(r=>r.url.includes('/video-template/analysis')).length<10);
    await window.loadURL(local.url+'/ai-editing/video-template/preview?analysis_file='+encodeURIComponent(path.join(task,'output/video_template_analysis.json')));
    const previewState=await window.webContents.executeJavaScript(`({title:document.querySelector('h1')?.textContent,title_inputs:document.querySelectorAll('.title-input').length,subtitle_inputs:document.querySelectorAll('.subtitle-input').length})`);
    assert.equal(previewState.title,'视频模板分析预览');assert.equal(previewState.title_inputs,3);assert.equal(previewState.subtitle_inputs,2);
    await window.webContents.executeJavaScript(`(()=>{const title=document.querySelector('.title-input');title.value='独立预览改字验收';title.dispatchEvent(new Event('input',{bubbles:true}));const subtitle=document.querySelector('.subtitle-input');subtitle.value='预览窗口修改的字幕';subtitle.dispatchEvent(new Event('input',{bubbles:true}));subtitle.setSelectionRange(0,2);document.querySelector('.highlight-add').click();document.querySelector('#saveBtn').click();})()`);
    const saveDeadline=Date.now()+4000;let badge='';
    while(Date.now()<saveDeadline){await new Promise(resolve=>setTimeout(resolve,100));badge=await window.webContents.executeJavaScript('document.querySelector("#dirtyBadge").textContent');if(badge==='已保存')break;}
    assert.equal(badge,'已保存');
    const savedAnalysis=read(path.join(task,'output/video_template_analysis.json'));
    assert.equal(savedAnalysis.title.lines[0],'独立预览改字验收');assert.equal(savedAnalysis.generation_plan.title.lines[0],'独立预览改字验收');assert.equal(savedAnalysis.subtitles[0].text,'预览窗口修改的字幕');assert.deepEqual(savedAnalysis.subtitles[0].highlight_terms,['预览']);
    try{const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(root,'standalone-preview.png'),screenshot.toPNG());}catch(error){captureErrors.push({step:'standalone-preview',error:error.message});}
    await window.webContents.executeJavaScript('document.querySelector("#generateBtn").click()');
    const previewDeadline=Date.now()+15000;let previewResult='';
    while(Date.now()<previewDeadline){await new Promise(resolve=>setTimeout(resolve,200));previewResult=await window.webContents.executeJavaScript('document.body.innerText');if(previewResult.includes('剪映草稿已生成')||previewResult.includes('重试生成'))break;}
    assert.match(previewResult,/剪映草稿已生成/);
    const previewDrafts=fs.readdirSync(output).map(name=>({folder:path.join(output,name),time:fs.statSync(path.join(output,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
    const previewContent=read(path.join(previewDrafts[0].folder,'draft_content.json'));texts.length=0;collect(previewContent);
    assert.ok(texts.includes('独立预览改字验收'));assert.ok(texts.includes('预览窗口修改的字幕'));assert.equal(previewContent.duration,Math.round(cut.duration*1000000));assert.deepEqual(failures,[]);
    const report={build_id:read(path.join(service.resources,'restoration-build.json')).id,pass:true,platform:process.platform,hardware_acceleration:false,steps,requests,console_errors:failures,console_warnings:warnings,capture_errors:captureErrors,generated:{draft_dir:drafts[0].folder,duration_us:content.duration,material_count:read(path.join(task,'output/material_plan.json')).items.length,deleted_word_indices:[1]},standalone_preview:{...previewState,saved:true,highlight_terms:['预览'],draft_dir:previewDrafts[0].folder,duration_us:previewContent.duration,texts:[...texts]}};write(path.join(root,'workbench-ui-report.json'),report);
    console.log(JSON.stringify({report:path.join(root,'workbench-ui-report.json'),steps:steps.map(s=>({step:s.step,status:s.status,text:s.text.slice(0,220),buttons:s.buttons}))},null,2));
  }finally{window?.destroy();await new Promise(resolve=>local.server.close(resolve));}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
