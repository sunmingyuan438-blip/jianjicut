const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {run,write,within} = require('./util.cjs');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function taskId(value) { const h=digest(JSON.stringify(value));return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; }
async function invoke(service,operation,input,options={}) {
  if(service.apiContext?.ai_editing_enabled===false)throw new Error('AI 剪辑已关闭，请在设置中开启');
  const task_id=options.task_id||taskId({operation,input}),step_id=options.step_id||operation;
  if(!/^[\da-f-]{36}$/i.test(task_id)||!/^[\w-]{1,64}$/.test(step_id))throw new Error('任务标识无效');
  const folder=path.join(service.dataDir,'platform-tasks',task_id),file=path.join(folder,step_id+'.json');
  // Stable IDs survive retries and app restarts. Media/model inputs are not logged.
  try {const result=await service.account.invokeModel({task_id,step_id,operation,input});write(file,{task_id,step_id,operation,status:result.status,request_id:result.request_id,model:result.model});return result;}
  catch(error){write(file,{task_id,step_id,operation,status:error.code||'error',request_id:error.request_id||null});throw error;}
}
async function embeddings(service,body) {
  const items=body.items||[];
  if(!items.length)return{provider:'aigzm',embeddings:[]};
  if(!Array.isArray(items)||items.length>100||items.some(i=>!i||!i.id||typeof i.text!=='string'))throw new Error('向量请求需要带 id 和 text 的素材列表');
  const result=await invoke(service,'embedding',{input:items.map(i=>i.text),encoding_format:'float'},body),data=result.output?.data;
  if(!Array.isArray(data)||data.length!==items.length)throw new Error('平台向量结果数量不匹配');
  const indexed=new Map(data.map((d,i)=>[d.index??i,d.embedding]));
  if(indexed.size!==items.length)throw new Error('平台返回了重复的向量索引');
  const vectors=items.map((item,index)=>{const vector=indexed.get(index);if(!Array.isArray(vector)||!vector.length||vector.some(v=>!Number.isFinite(v)))throw new Error('平台返回无效向量');return{id:item.id,embedding:vector};});
  return{provider:'aigzm',model:result.model,request_id:result.request_id,embeddings:vectors};
}
const timestamp=seconds=>{const ms=Math.max(0,Math.round(seconds*1000));return`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
async function transcribe(service,input) {
  const source=service.resolvePath(input.input_media||'');
  if(!input.input_media||!fs.existsSync(source)||!service.canRead(source))throw new Error('输入媒体不存在或未登记到当前任务');
  const ffmpeg=service.tool('ffmpeg'),ffprobe=service.tool('ffprobe');if(!ffmpeg||!ffprobe)throw new Error('缺少 FFmpeg 或 ffprobe');
  const metadata=JSON.parse(await run(ffprobe,['-v','error','-show_entries','format=duration','-of','json',source]));
  const duration=Number(metadata.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('无法读取音视频时长');
  const destinations={output_json:'speech/asr.raw.json',output_srt:'output/voice.srt',output_segments_json:'speech/segments.json'};
    const paths={};
    for(const [name,fallback]of Object.entries(destinations)){
      const file=input[name]||(input.task_dir&&path.join(input.task_dir,fallback));if(!file)throw new Error('缺少输出路径或 task_dir');
      const resolved=service.resolvePath(file);
      if(path.extname(resolved).toLowerCase()!==(name==='output_srt'?'.srt':'.json')||resolved===source||(fs.existsSync(resolved)&&fs.realpathSync(resolved)===fs.realpathSync(source)))throw new Error('字幕输出不能覆盖输入素材，且须使用对应的 JSON/SRT 扩展名');
      if(![...service.authorized].some(root=>within(root,resolved)))throw new Error('输出路径未登记到当前任务');paths[name]=resolved;
    }
  const outputIdentities=Object.values(paths).map(file=>fs.existsSync(file)?fs.realpathSync(file):file);
  if(new Set(outputIdentities).size!==outputIdentities.length)throw new Error('字幕的 JSON/SRT 输出路径不能重复');
  const root=path.join(service.cache,'platform-asr',crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
  const segments=[],calls=[];
  try {
    for(let offset=0,index=0;offset<duration;offset+=600,index++){
      const length=Math.min(600,duration-offset),file=path.join(root,index+'.mp3');
      await run(ffmpeg,['-v','error','-y','-ss',String(offset),'-i',source,'-t',String(length),'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','32k',file],undefined,{timeout:300000});
      const audio=fs.readFileSync(file),operation=length<=60?'asr_short':'asr_long';
      if(audio.length>(operation==='asr_short'?2200000:3700000))throw new Error('压缩音频超过平台单次限制，请缩短片段');
      const result=await invoke(service,operation,{audio:audio.toString('base64')},{task_id:input.task_id||taskId({audio:digest(audio),offset}),step_id:'asr_'+index});
      const output=result.output;
      if(!Array.isArray(output?.segments)||!output.segments.length)throw new Error('平台 ASR 未返回带时间戳的字幕');
      for(const part of output.segments){const start=Number(part.start),end=Number(part.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>length+1||typeof part.text!=='string')throw new Error('平台 ASR 时间戳无效');segments.push({id:segments.length,line_id:'line_'+String(segments.length+1).padStart(3,'0'),start:start+offset,end:Math.min(end+offset,duration),text:part.text,timing_source:'provider_segment'});}
      calls.push({request_id:result.request_id,model:result.model});
    }
    write(paths.output_json,{provider:'aigzm',duration,segments,calls});write(paths.output_segments_json,{duration,segments});
    fs.mkdirSync(path.dirname(paths.output_srt),{recursive:true});fs.writeFileSync(paths.output_srt,segments.map((s,i)=>`${i+1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${s.text.replace(/\r?\n/g,' ')}\n`).join('\n'));
    return{provider:'aigzm',asr_json:paths.output_json,srt_file:paths.output_srt,segments_json:paths.output_segments_json,segment_count:segments.length,calls};
  }finally{service.removeManaged(root);}
}
module.exports={invoke,embeddings,transcribe,taskId,timestamp};
