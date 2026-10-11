const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Service}=require('../backend/service.cjs');
const {startServer}=require('../backend/server.cjs');
const {Workbench,makeCutPlan}=require('../backend/workbench.cjs');
const {write,read,within,extract}=require('../backend/util.cjs');
const resources=path.resolve(process.env.XYCUT_RESOURCES||path.join(__dirname,'../resources'));
const temporaryRoots=[];
function temporary(prefix){const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));temporaryRoots.push(root);return root;}
function fixture(){const dataDir=temporary('xycut-test-');return{dataDir,service:new Service({resources,dataDir})};}
test.after(()=>{for(const root of temporaryRoots){assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^xycut-(test|source)-/);fs.rmSync(root,{recursive:true,force:true});}});

test('运行环境状态统一报告 resourcesRoot、Python 和 FFmpeg 实际路径',()=>{
  const {service}=fixture();
  const status=service.resourceStatus();
  assert.equal(status.resources_root,resources);
  assert.equal(status.python_path,path.join(resources,'python','python.exe'));
  assert.equal(status.ffmpeg_path,path.join(resources,'ffmpeg','ffmpeg.exe'));
  assert.equal(status.ffprobe_path,path.join(resources,'ffmpeg','ffprobe.exe'));
  assert.equal(status.exists.frontend_path,true);
  assert.equal(status.exists.core_worker_path,true);
});

test('缺少 Python 时错误包含 resourcesRoot 和候选路径',()=>{
  const dataDir=temporary('xycut-test-'),missing=temporary('xycut-source-');
  const service=new Service({resources:missing,dataDir});
  assert.throws(()=>service.python(),error=>{assert.match(error.message,/resourcesRoot=/);assert.match(error.message,/python[\\/]python\.exe/);return true;});
});

test('素材库、去重、原 Agent SQLite 索引与编辑状态共享',async()=>{
  const {service,dataDir}=fixture();
  const library=await service.invoke('create_sucai_library',{name:'测试素材库'});
  assert.equal(library.status.libraries.length,1);
  const source=temporary('xycut-source-');const image=path.join(source,'fixture.png');fs.copyFileSync(path.join(resources,'frontend/icon.png'),image);
  const imported=await service.invoke('import_sucai_materials',{libraryId:library.library_id,sourcePaths:[image]});
  assert.equal(imported.imported_count,1);
  const duplicate=await service.invoke('import_sucai_materials',{libraryId:library.library_id,sourcePaths:[image]});assert.equal(duplicate.skipped_count,1);
  const indexed=await service.invoke('index_sucai_classified_directory',{libraryId:library.library_id,libraryName:'测试素材库',rootPath:source});
  assert.equal(indexed.status.materials.length,1);const material=indexed.status.materials[0];
  const reopened=new Service({resources,dataDir});assert.equal(reopened.canRead(image),false);await reopened.invoke('get_sucai_db_status');assert.equal(reopened.canRead(image),true);
  const changed=await service.invoke('update_sucai_material',{materialId:material.id,summary:'青色圆形图标',keywords:['图标'],qualityScore:0.9});assert.equal(changed.status.materials[0].summary,'青色圆形图标');
  const saved=await service.invoke('save_sucai_embeddings',{provider:'fixture',model:'fixture',items:[{id:material.id,embedding:[0.2,0.3],text:'图标'}]});assert.equal(saved.status.embedding_count,1);
  await assert.rejects(service.invoke('save_sucai_embeddings',{items:[{id:material.id,embedding:[]}]}),/向量/);
  const reset=await service.invoke('reset_sucai_material_analysis',{materialId:material.id});assert.equal(reset.status.embedding_count,0);
  const deleted=await service.invoke('delete_sucai_library',{libraryId:library.library_id});assert.equal(deleted.status.materials.length,0);assert.equal(fs.existsSync(image),true);
});

test('原预设复制、缓存扫描、ZIP 与模板转换持久化',async()=>{
  const {service,dataDir}=fixture();
  const builtin=await service.invoke('scan_builtin_presets');assert.ok(builtin.presets.length>=2);
  const installed=await service.invoke('install_builtin_preset',{folderName:'xycut_001',customDir:path.join(dataDir,'presets')});assert.ok(fs.existsSync(installed.target_path));
  const scanned=await service.invoke('scan_local_presets',{customDir:path.join(dataDir,'presets')});assert.equal(scanned.presets.length,1);
  const packed=await service.invoke('pack_template_folder',{input:{presetDir:installed.target_path}});assert.ok(fs.statSync(packed.zip_path).size>0);
  const converted=await service.invoke('save_local_preset_as_hot_template',{presetDir:installed.target_path,templateName:'测试爆款模板'});assert.ok(fs.existsSync(converted.template_config_file));assert.equal(converted.template_config.text_slots.length,2);
  const listed=await service.invoke('list_local_hot_templates');assert.equal(listed.templates[0].name,'测试爆款模板');
  const removed=await service.invoke('delete_local_hot_template',{slug:listed.templates[0].slug});assert.equal(removed.templates.length,0);assert.ok(fs.existsSync(installed.target_path));
});

test('真实恢复核心通过桌面服务生成可编辑草稿',async()=>{
  const {service,dataDir}=fixture();const output=path.join(dataDir,'drafts');fs.mkdirSync(output);
  const result=await service.generate({mode:'template_designer',draft_output_dir:output,generation_plan:{draft_name:'Desktop_core_integration',duration_ms:1000,canvas:{width:1080,height:1920},background:{type:'image',file_path:path.join(resources,'frontend/background.jpg'),box:{x:0,y:0,w:1080,h:1920}},text_blocks:[{text:'恢复桌面工程',role:'headline',box:{x:120,y:160,w:840,h:96},style:{font_size_px:60,color:'#FFFFFF',align:'center'}}]}});
  assert.equal(result.ok,true);const content=read(result.draft_content);assert.equal(content.duration,1000000);assert.deepEqual(content.tracks.map(t=>t.type),['video','text']);
  assert.ok(content.materials.texts[0].content.includes('恢复桌面工程'));
});

test('保护区从删除范围扣除且时间线重排保持总时长',()=>{
  const plan=makeCutPlan([{start:1,end:3},{start:2.5,end:4}],5,[{start:2,end:2.5}]);
  assert.deepEqual(plan.delete_ranges,[{start:1,end:2},{start:2.5,end:4}]);assert.equal(plan.duration,2.5);assert.equal(plan.keep_ranges.at(-1).target_end,2.5);
});

test('工作台读取原格式 sidecar、保存删除与改字并生成真实波形',async()=>{
  const {service,dataDir}=fixture(),workbench=new Workbench(service),root=path.join(dataDir,'task');fs.mkdirSync(root);
  const video=path.join(resources,'builtin-presets/xycut_001/xycut_001.mp4');fs.mkdirSync(path.join(root,'input'));fs.copyFileSync(video,path.join(root,'input/source.mp4'));
  write(path.join(root,'speech/segments.json'),{duration:1.366666,segments:[{line_id:'line_001',start:0,end:1.366666,text:'测试'}]});
  write(path.join(root,'edit/line_timeline.json'),{source_duration:1.366666,lines:[{line_id:'line_001',start:0,end:1.366666,text:'测试'}]});
  const opened=workbench.open({task_dir:root});assert.match(opened.url,/\/xycut\//);const task=await workbench.task(opened);assert.equal(task.task_dir,root);
  const state=await workbench.state({...opened,manual_delete_ranges:[{start:0.5,end:0.7}],review_lines:[{line_id:'line_001',start:0,end:1.366666,text:'修改后的字幕',text_authority:'literal'}]});assert.equal(state.line_timeline.lines[0].text,'修改后的字幕');assert.ok(Math.abs(state.cut_plan.duration-1.166666)<0.00001);
  const waveform=await workbench.mediaAnalysis(opened);assert.ok(waveform.peaks.peaks.length>0);assert.ok(waveform.peaks.duration>1);
});

test('本地 API 拒绝其他网页调用和未授权文件，支持媒体范围请求',async()=>{
  const {service}=fixture();const {server,url}=await startServer(service,{port:0});
  try{assert.equal((await fetch(url+'/health')).status,200);assert.equal((await fetch(url+'/health',{headers:{Origin:'https://other.example'}})).status,403);
    assert.equal((await fetch(url+'/ai-editing/file?path='+encodeURIComponent(__filename))).status,403);
    const image=path.join(resources,'frontend/icon.png');const response=await fetch(url+'/ai-editing/file?path='+encodeURIComponent(image),{headers:{Range:'bytes=0-9'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,10);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('工作台分析响应使用原界面读取的 analysis 字段',async()=>{
  const {service,dataDir}=fixture();const {server,workbench,url}=await startServer(service,{port:0});
  try{
    const task=path.join(dataDir,'task');fs.mkdirSync(task);const file=path.join(task,'output/video_template_analysis.json');
    const analysis={schema_version:2,mode:'video_template',draft_name:'响应契约验收',generation_plan:{subtitles:[{text:'字幕',start_ms:0,end_ms:1000}]}};write(file,analysis);
    workbench.open({task_dir:task});
    const response=await fetch(url+'/ai-editing/video-template/analysis?analysis_file='+encodeURIComponent(file));
    const data=await response.json();assert.equal(data.ok,true);assert.deepEqual(data.analysis,analysis);assert.equal(data.analysis_file,file);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('独立模板预览恢复原页面并安全嵌入用户输入',async()=>{
  const {service,dataDir}=fixture();const {server,workbench,url}=await startServer(service,{port:0});
  try{
    const task=path.join(dataDir,'task');fs.mkdirSync(task);const file=path.join(task,'output/video_template_analysis.json');
    const injected='</script><script>window.unexpected=1</script>';
    write(file,{mode:'video_template',title:{lines:[injected]},subtitles:[]});workbench.open({task_dir:task});
    const response=await fetch(url+'/ai-editing/video-template/preview?analysis_file='+encodeURIComponent(file));
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);
    const html=await response.text();assert.match(html,/视频模板分析预览/);assert.match(html,/function generateDraft\(/);assert.match(html,/const analysisFile =/);
    assert.ok(!html.includes(injected));assert.ok(html.includes('\\u003c/script>'));assert.ok(!html.includes('__XYCUT_'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('ZIP 越界路径在解压前被拒绝',()=>{
  const {dataDir}=fixture();const Zip=require('adm-zip'),zip=new Zip();zip.addFile('safe.txt',Buffer.from('ok'));
  const entry=zip.getEntry('safe.txt');entry.entryName='../outside.txt';const file=path.join(dataDir,'unsafe.zip');zip.writeZip(file);
  assert.throws(()=>extract(file,path.join(dataDir,'unpacked')),/越界/);assert.equal(fs.existsSync(path.join(dataDir,'outside.txt')),false);
});

test('清空并重新安装组件后仍能调用 CPython 与媒体工具',async()=>{
  const {service}=fixture();service.port=17662;
  assert.equal((await service.invoke('clear_ai_runtime')).installed,false);
  const installed=await service.invoke('install_ai_runtime',{downloadUrl:'http://127.0.0.1:17662/bundled/python'});assert.equal(installed.installed,true);
  assert.ok((await service.invoke('get_sucai_db_status')).libraries);
  assert.equal((await service.invoke('clear_ffmpeg_runtime')).installed,false);
  assert.equal((await service.invoke('install_ffmpeg_runtime',{downloadUrl:'http://127.0.0.1:17662/bundled/ffmpeg'})).installed,true);
});

test('素材库迁移更新数据库路径并保留原文件',async()=>{
  const {service,dataDir}=fixture();const created=await service.invoke('create_sucai_library',{name:'迁移验收'});
  const oldRoot=service.storage,libraryRoot=created.status.libraries[0].root_path;
  const image=path.join(libraryRoot,'fixture.png');fs.copyFileSync(path.join(resources,'frontend/icon.png'),image);
  await service.invoke('index_sucai_classified_directory',{libraryId:created.library_id,libraryName:'迁移验收',rootPath:libraryRoot});
  const next=path.join(dataDir,'moved');const moved=await service.invoke('update_sucai_storage_dir',{newBaseDir:next});
  assert.ok(moved.status.libraries.every(item=>within(next,item.root_path)));
  assert.ok(moved.status.materials.every(item=>within(next,item.path)));
  assert.ok(fs.existsSync(image));assert.ok(fs.existsSync(oldRoot));
});

test('工作台的修改标题和删词时间线进入真实视频草稿',async()=>{
  const {service,dataDir}=fixture();const template=await service.invoke('save_local_preset_as_video_template',{presetDir:path.join(resources,'builtin-presets/xycut_001'),templateName:'剪辑验收模板'});
  const task=path.join(dataDir,'task'),output=path.join(dataDir,'drafts');fs.mkdirSync(output);
  const previous={source_duration:1.366666,duration:1.366666,lines:[{line_id:'line_001',start:0,end:1.366666,text:'第一句字幕'}]};
  const base={mode:'video_template',template_dir:template.template_dir,template_config_file:template.template_config_file,draft_output_dir:output,timeline_duration_ms:1367,source_video:{file_path:path.join(resources,'builtin-presets/xycut_001/xycut_001.mp4'),duration_ms:1367,width:1080,height:1920},title:{items:[{text:'修改前标题'},{text:'副标题'}]},subtitles:[{line_id:'line_001',text:'第一句字幕',lines:['第一句字幕'],start_ms:0,end_ms:1367,duration_ms:1367,style_level:'01'}],line_timeline:previous};
  const analysisFile=path.join(task,'output/video_template_analysis.json');write(analysisFile,{...base,generation_plan:base,title:{items:[{text:'用户修改的新标题'},{text:'副标题'}]}});
  const cutFile=path.join(task,'edit/cut_plan.json');write(cutFile,makeCutPlan([{start:.2,end:.4}],1.366666));
  const timelineFile=path.join(task,'edit/line_timeline.json');write(timelineFile,{source_duration:1.366666,duration:1.166666,lines:[{line_id:'line_001',start:0,end:1.166666,text:'第句字幕'}]});
  // The original standalone preview sends only analysis_file. Saved task edits
  // must still be used without redundant sidecar arguments from the caller.
  const generated=await service.generate({analysis_file:analysisFile});
  const content=read(generated.draft_content),texts=[];const collect=value=>{if(Array.isArray(value)){value.forEach(collect);return;}if(!value||typeof value!=='object')return;for(const item of value.materials?.texts||[]){try{texts.push(JSON.parse(item.content).text);}catch{}}Object.values(value).forEach(collect);};collect(content);
  assert.ok(texts.includes('用户修改的新标题'));assert.ok(texts.includes('第句字幕'));assert.equal(content.duration,1167000);
  assert.ok(content.tracks.filter(t=>t.type==='video').flatMap(t=>t.segments).some(s=>s.source_timerange?.start===400000));
});

test('豆包仅 KEY 配置请求默认多模态向量模型，兼容显式配置',async t=>{
  const {service}=fixture(),requests=[];
  let payload={data:{embedding:[0.1,-0.2,0]}};
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(payload),{status:200});});
  for(const response of [{data:{embedding:[0.1]}},{embedding:[0.1]},{data:[{embedding:[0.1]}]},{data:[0.1,-0.2]}]){
    payload=response;assert.equal((await service.invoke('test_ai_service_api',{input:{service_type:'doubao_llm',parameters:[{key:'KEY',value:'fixture-test-key'}]}})).ok,true);
  }
  const request=requests[0];assert.equal(request.url,'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');assert.equal(request.options.method,'POST');assert.equal(request.options.headers.Authorization,'Bearer fixture-test-key');
  assert.deepEqual(JSON.parse(request.options.body),{model:'doubao-embedding-vision-251215',input:[{type:'text',text:'连接测试'}]});
  await service.testAI({service_type:'doubao_llm',parameters:{APIKEY:'fixture-test-key',model:'custom-embedding',base_url:'https://provider.example/embeddings'}});
  assert.equal(requests.at(-1).url,'https://provider.example/embeddings');assert.equal(JSON.parse(requests.at(-1).options.body).model,'custom-embedding');
  await service.testAI({service_type:'doubao_llm',parameters:{api_key:'fixture-test-key',endpoint_id:'ep-fixture'}});assert.equal(JSON.parse(requests.at(-1).options.body).model,'ep-fixture');
  const before=requests.length;await assert.rejects(service.testAI({service_type:'doubao_llm',parameters:{KEY:'  '}}),/API Key/);assert.equal(requests.length,before);
  await service.context({third_party_apis:[{type:'doubao_llm',parameters:[{key:'APIKEY',value:'fixture-test-key'}]}]});
  assert.equal(read(path.join(service.dataDir,'agent-context.json')).ai_services.doubao_llm.mode,'user_key');
});

test('豆包连接测试拒绝无效向量并保留认证、配额和格式错误',async t=>{
  const {service}=fixture();let payload={},status=200,raw=null;
  t.mock.method(globalThis,'fetch',async()=>new Response(raw??JSON.stringify(payload),{status}));
  const input={service_type:'doubao_llm',parameters:{key:'fixture-test-key'}};
  for(const response of [null,{},{data:{embedding:[]}},{data:{embedding:['0.2']}},{embedding:[null]},{data:[{embedding:[Infinity]}]}]){payload=response;await assert.rejects(service.testAI(input),/有效向量/);}
  for(const code of [401,403,429]){status=code;payload={error:{message:'provider error '+code}};await assert.rejects(service.testAI(input),new RegExp('provider error '+code));}
  status=502;raw='<html>Service unavailable</html>';await assert.rejects(service.testAI(input),/不是 JSON：502/);
});

test('AI 开关限制 Agent 写入接口，配置重启恢复并使用实际监听端口',async()=>{
  const {service,dataDir}=fixture(),presets=temporary('xycut-source-'),cover=path.join(presets,'封面.png');fs.copyFileSync(path.join(resources,'frontend/icon.png'),cover);
  await service.invoke('update_agent_api_context',{input:{ai_editing_enabled:false,preset_dir:presets,sucai_context:{default_library_id:'fixture-library'}}});
  const reopened=new Service({resources,dataDir});assert.equal(reopened.apiContext.ai_editing_enabled,false);
  assert.equal(reopened.canRead(cover),true);
  const {server,url}=await startServer(reopened,{port:0});
  try{
    const disabled=await reopened.invoke('save_agent_context_file',{input:{}});assert.equal(disabled.enabled,false);const context=read(path.join(dataDir,'agent-context.json'));assert.equal(context.local_api.port,reopened.port);assert.equal(context.local_api.base_url,url);assert.equal(context.local_api.enabled,false);assert.equal(context.sucai.default_library_id,'fixture-library');assert.equal(context.paths.preset_dir,presets);
    assert.deepEqual(await reopened.invoke('get_agent_api_context'),{agent_context_file:path.join(dataDir,'agent-context.json'),base_url:url,enabled:false,port:reopened.port});
    for(const route of ['/ai-editing/generate','/ai-editing/template-designer/generate','/ai-editing/workbench/open','/ai-editing/workbench/api/state','/ai-editing/video-template/save-analysis','/sucai/embeddings','/sucai/embeddings/build']){
      const response=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);assert.match((await response.json()).message,/AI 剪辑已关闭/);
    }
    assert.equal((await(await fetch(url+'/health')).json()).enabled,false);
    await reopened.invoke('update_agent_api_context',{input:{ai_editing_enabled:true}});
    const output=path.join(dataDir,'drafts');fs.mkdirSync(output);
    const response=await fetch(url+'/ai-editing/template-designer/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'template_designer',draft_output_dir:output,generation_plan:{duration_ms:1000,canvas:{width:1080,height:1920},background:{type:'image',file_path:path.join(resources,'frontend/background.jpg'),box:{x:0,y:0,w:1080,h:1920}},text_blocks:[{text:'开关启用后生成',box:{x:120,y:160,w:840,h:96}}]}})});
    assert.equal(response.status,200);const generated=await response.json();assert.equal(generated.ok,true);assert.equal(read(generated.draft_content).duration,1000000);assert.equal((await(await fetch(url+'/health')).json()).enabled,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
