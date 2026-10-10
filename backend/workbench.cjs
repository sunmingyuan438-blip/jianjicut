const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {read, write, run,walk} = require('./util.cjs');

function mergeRanges(ranges, duration, gap = 0) {
  const sorted = ranges.map(r => ({start: Math.max(0, Math.min(duration, Number(r.start))), end: Math.max(0, Math.min(duration, Number(r.end)))})).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).sort((a,b) => a.start - b.start);
  const output = [];
  for (const range of sorted) { const last = output.at(-1); if (last && range.start <= last.end + gap) last.end = Math.max(last.end, range.end); else output.push({...range}); }
  return output;
}
function subtractRanges(ranges, protectedRanges) {
  let result = ranges;
  for (const p of protectedRanges) result = result.flatMap(r => r.end <= p.start || r.start >= p.end ? [r] : [{start:r.start,end:Math.min(p.start,r.end)}, {start:Math.max(p.end,r.start),end:r.end}].filter(a => a.end > a.start));
  return result;
}
function makeCutPlan(deletions, duration, protectedRanges = [], gap = 0) {
  const deleted = subtractRanges(mergeRanges(deletions, duration, gap), mergeRanges(protectedRanges, duration));
  const keep = []; let source = 0, target = 0;
  for (const d of [...deleted, {start: duration, end: duration}]) { if (d.start > source) {keep.push({source_start:source, source_end:d.start, target_start:target,target_end:target+d.start-source}); target += d.start-source;} source = d.end; }
  return {schema_version:1,kind:'cut_plan',source_duration:duration,duration:target,total_keep_duration:target,delete_ranges:deleted,keep_ranges:keep};
}
function remapTime(time, keep) {let result = 0; for (const r of keep) { if (time >= r.source_end) result = r.target_end; else if (time >= r.source_start) return r.target_start + time-r.source_start; else return result; } return result;}

class Workbench {
  constructor(service) {this.service = service; this.file = path.join(service.dataDir, 'workbench-tasks.json'); this.tasks = []; this.reload();}
  reload() {const records = read(this.file, []); this.tasks = Array.isArray(records) ? records.filter(item => item && typeof item === 'object' && item.task_id && item.task_dir) : []; return this.tasks;}
  open(body) {
    this.reload();
    const root = this.service.resolvePath(body.task_dir || '');
    if (!body.task_dir || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('任务目录不存在');
    this.service.grant(root);
    let task = this.tasks.find(t => t.task_dir === root);
    if (!task) task = {task_id:crypto.createHash('sha256').update(root).digest('hex').slice(0,16),task_dir:root,name:path.basename(root)};
    task.title=task.title||task.name;
    task.updated_at = Math.floor(Date.now()/1000);
    task.url = `http://127.0.0.1:${this.service.port}/xycut/${task.task_id}`;
    this.tasks = [task,...this.tasks.filter(t => t.task_id !== task.task_id)].slice(0,100); write(this.file,this.tasks);
    return {ok:true,...task};
  }
  root(parameters) {
    this.reload();
    if (parameters.task_id) {const task = this.tasks.find(t => t.task_id === parameters.task_id); if (!task) throw new Error('任务不存在'); this.service.grant(task.task_dir); return task.task_dir;}
    if (parameters.task_dir) {const root = this.service.resolvePath(parameters.task_dir); if (!this.tasks.some(t => t.task_dir === root)) throw new Error('请先通过工作台打开接口登记任务'); return root;}
    throw new Error('缺少 task_id');
  }
  async task(parameters) {
    const root = this.root(parameters), locate = (...names) => names.map(n => path.join(root,n)).find(fs.existsSync) || null;
    const analysisFile = locate('output/video_template_analysis.json','video_template_analysis.json');
    const plan = read(locate('output/video_template_plan.json','video_template_plan.json') || '', {});
    const timeline = read(path.join(root,'edit/line_timeline.json'), {});
    const segments = read(path.join(root,'speech/segments.json'), {});
    const sourceVideo = locate('input/source.mp4','input/source.mov') || plan.source_video?.file_path || null;
    const sourceAudio = locate('input/source.mp3','input/source.wav','speech/voice.mp3') || plan.source_audio?.file_path || null;
    for (const file of [sourceVideo,sourceAudio]) if (file) this.service.grant(file);
    let duration = Number(timeline.source_duration || segments.duration || plan.duration_ms / 1000 || 0);
    if (!duration && (sourceVideo || sourceAudio) && this.service.tool('ffprobe')) {
      const metadata = JSON.parse(await run(this.service.tool('ffprobe'), ['-v','error','-show_entries','format=duration','-of','json',sourceVideo || sourceAudio]));
      duration = Number(metadata.format?.duration || 0);
    }
    duration = Math.max(duration, ...[...(timeline.lines || []), ...(segments.segments || []), ...(plan.subtitles || [])].map(l => Number(l.end ?? (l.end_ms || 0)/1000)), 0);
    const sidecar = (file, empty) => read(path.join(root,file), {schema_version:1,kind:path.basename(file,'.json'),missing:true,...empty});
    return {ok:true,task_id:parameters.task_id||null,task_dir:root,task_name:path.basename(root),source_video_path:sourceVideo,source_audio_path:sourceAudio,duration,source_duration:duration,analysis_file:analysisFile,
      plan,segments,line_timeline:timeline,review_state:read(path.join(root,'edit/review_state.json'),{}),peaks:read(path.join(root,'speech/peaks.json')),silence_periods:read(path.join(root,'speech/silence_periods.json')),
      material_plan:sidecar('output/material_plan.json',{items:[]}),subtitle_plan:sidecar('output/subtitle_plan.json',{subtitles:[]})};
  }
  async state(body) {
    const root = this.root(body), current = await this.task(body), duration = current.duration;
    const cut = makeCutPlan(body.manual_delete_ranges || body.manual_time_ranges || [],duration,body.protected_ranges || [],Number(body.cut_options?.merge_gap || 0));
    const deletedLines = new Set(body.deleted_line_ids || []), deletedWords = new Set((body.deleted_word_indices || []).map(Number));
    const lines = (body.review_lines || current.line_timeline.lines || current.segments.segments || current.plan.subtitles || []).filter(line => !deletedLines.has(line.line_id || line.id)).flatMap((line,index) => {
      const start = Number(line.start ?? (line.start_ms || 0)/1000), end = Number(line.end ?? (line.end_ms || 0)/1000);
      if (!cut.keep_ranges.some(r => r.source_start < end && r.source_end > start)) return [];
      const words = (line.words || []).filter(w => !deletedWords.has(Number(w.idx))).map(word => {const sourceStart=Number(word.start??Number(word.start_ms)/1000),sourceEnd=Number(word.end??Number(word.end_ms)/1000),targetStart=remapTime(sourceStart,cut.keep_ranges),targetEnd=remapTime(sourceEnd,cut.keep_ranges);return {...word,text:body.word_text_overrides?.[word.idx]??word.text??word.word,source_start:sourceStart,source_end:sourceEnd,start:targetStart,end:targetEnd,start_ms:Math.round(targetStart*1000),end_ms:Math.round(targetEnd*1000)};}).filter(word=>word.end>word.start);
      if(line.words?.length&&!words.length&&line.text_authority!=='literal')return [];
      const text = line.text_authority === 'literal' || !words.length ? line.text : words.map(w => w.text).join('');
      const targetStart=remapTime(start,cut.keep_ranges),targetEnd=remapTime(end,cut.keep_ranges);
      return [{...line,line_id:line.line_id || line.id || 'line_'+String(index+1).padStart(3,'0'),source_start:start,source_end:end,start:targetStart,end:targetEnd,start_ms:Math.round(targetStart*1000),end_ms:Math.round(targetEnd*1000),duration_ms:Math.round((targetEnd-targetStart)*1000),text,words}];
    });
    write(path.join(root,'edit/review_state.json'),body);
    write(path.join(root,'edit/cut_plan.json'),cut);
    write(path.join(root,'edit/line_timeline.json'),{schema_version:1,kind:'line_timeline',source_duration:duration,duration:cut.duration,lines});
    write(path.join(root,'edit/review_log.json'),{saved_at:new Date().toISOString(),deleted_line_ids:[...deletedLines],deleted_word_indices:[...deletedWords],delete_ranges:cut.delete_ranges,protected_ranges:body.protected_ranges || []});
    return {ok:true,cut_plan:cut,line_timeline:{lines,duration:cut.duration}};
  }
  async mediaAnalysis(parameters) {
    const root = this.root(parameters), task = await this.task(parameters);
    if (task.peaks && task.silence_periods) return {ok:true,cached:true,peaks:task.peaks,silence_periods:task.silence_periods};
    const source = task.source_video_path || task.source_audio_path;
    if (!source) throw new Error('任务没有音视频源文件');
    const ffmpeg = this.service.tool('ffmpeg'); if (!ffmpeg) throw new Error('请安装 FFmpeg 视频组件');
    const file = path.join(root,'speech/wave.pcm');fs.mkdirSync(path.dirname(file),{recursive:true});
    await run(ffmpeg,['-y','-v','error','-i',source,'-vn','-ac','1','-ar','8000','-f','s16le',file]);
    const pcm = fs.readFileSync(file), values = [], quiet = []; let silenceStart = null;
    for (let offset=0;offset<pcm.length;offset+=160) {let max=0,sum=0,count=0; for(let p=offset;p<Math.min(pcm.length,offset+160);p+=2){const sample=pcm.readInt16LE(p)/32768;max=Math.max(max,Math.abs(sample));sum+=sample*sample;count++;} const time=offset/16000;values.push(max);if(Math.sqrt(sum/Math.max(1,count))<0.01){if(silenceStart === null)silenceStart=time;}else if(silenceStart!==null){if(time-silenceStart>=0.3)quiet.push({start:silenceStart,end:time});silenceStart=null;}}
    const duration=pcm.length/16000;if(silenceStart!==null&&duration-silenceStart>=0.3)quiet.push({start:silenceStart,end:duration});
    const peaks={sample_rate:8000,step_sec:0.01,duration,peaks:values,values};const silences={periods:quiet,duration};
    write(path.join(root,'speech/peaks.json'),peaks);write(path.join(root,'speech/silence_periods.json'),silences);fs.unlinkSync(file);
    return {ok:true,cached:false,peaks,silence_periods:silences};
  }
  analysis(file) {
    file=this.service.resolvePath(file);if(!this.service.canRead(file))throw new Error('分析文件未登记到任务');
    const analysis=read(file);if(!analysis)throw new Error('分析文件不存在');
    const plan=analysis.generation_plan||analysis;
    const template=analysis.template_dir||plan.template_dir;
    if(template&&fs.existsSync(template)){
      this.service.grant(template);
      const files=walk(template,()=>true,0);
      analysis.template_preview={...analysis.template_preview,detected_image_path:files.find(f=>/\.(jpe?g|png|webp)$/i.test(f))||null,detected_video_path:files.find(f=>/\.(mp4|mov|webm)$/i.test(f))||null};
    }
    return {ok:true,analysis,analysis_file:file};
  }
  saveAnalysis(body) {
    const file=this.service.resolvePath(body.analysis_file);if(!this.service.canRead(file))throw new Error('分析文件未登记到任务');
    if(!body.analysis || typeof body.analysis!=='object')throw new Error('缺少分析内容');
    const analysis=body.analysis;
    if(analysis.generation_plan){const {generation_plan,updated_plan,plan,template_preview,...edited}=analysis;analysis.generation_plan={...generation_plan,...edited};}
    write(file,analysis);
    const root=path.basename(path.dirname(file))==='output'?path.dirname(path.dirname(file)):path.dirname(file);
    const plan=analysis.generation_plan || analysis;
    const materialFile=path.join(root,'output/material_plan.json'),subtitleFile=path.join(root,'output/subtitle_plan.json');
    if(plan.material_plan)write(materialFile,plan.material_plan);
    if(plan.subtitles)write(subtitleFile,{schema_version:1,kind:'subtitle_plan',subtitles:plan.subtitles,subtitle_strategy:plan.subtitle_strategy,favorite_selection:plan.favorite_selection});
    return {ok:true,analysis_file:file,material_plan_file:fs.existsSync(materialFile)?materialFile:null,subtitle_plan_file:fs.existsSync(subtitleFile)?subtitleFile:null};
  }
}
module.exports={Workbench,makeCutPlan,mergeRanges,subtractRanges,remapTime};
