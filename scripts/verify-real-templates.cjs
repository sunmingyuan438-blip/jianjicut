const fs=require('node:fs');
const path=require('node:path');
const {Service}=require('../backend/service.cjs');
const {read,write,extract,run}=require('../backend/util.cjs');
async function main(){
  const root=path.resolve(__dirname,'../.test-data/e2e'),resources=path.resolve(__dirname,'../resources');
  fs.mkdirSync(root,{recursive:true});
  const service=new Service({resources,dataDir:path.join(root,'data')});
  const output=path.join(root,'drafts');fs.mkdirSync(output,{recursive:true});
  const video=path.join(root,'input/source.mp4'),srt=path.join(root,'input/source.srt');fs.mkdirSync(path.dirname(video),{recursive:true});
  await run(service.tool('ffmpeg'),['-y','-v','error','-f','lavfi','-i','color=c=navy:s=1080x1920:r=30:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
  fs.writeFileSync(srt,'1\n00:00:00,000 --> 00:00:01,400\n第一句验证字幕\n\n2\n00:00:01,400 --> 00:00:03,000\n第二句验证字幕\n');
  const report=[];
  for(const[kind,slug]of [['video_template','xycut_kb_005'],['hot_template','xycut_news_017']]){
    const directory=path.join(root,kind);extract(path.join(root,kind+'.zip'),directory);
    const endpoint=kind==='video_template'?'video-templates':'hot-templates';
    const response=await fetch('https://yushe.neirongpai.com/api/'+endpoint+'?page=1&page_size=100');if(!response.ok)throw new Error('模板列表读取失败');
    const catalog=await response.json(),template=catalog.templates.find(t=>t.slug===slug);if(!template)throw new Error('未找到模板 '+slug);
    const info=await service.saveTemplate(kind,{slug,templateName:slug,templateDir:path.join(directory,slug),templateConfigJson:template.template_config});
    let plan;
    if(kind==='video_template'){
      const planFile=path.join(root,'task/output/video_template_plan.json');
      await service.script('xycut-video-template-skill','prepare_video_template_plan.py',['--template-dir',info.template_path,'--template-config-file',info.config_path,'--draft-output-dir',output,'--mp4-file',video,'--srt-file',srt,'--draft-name','恢复版_真实口播模板验证','--output',planFile]);
      plan=read(planFile);
      plan.titles=(template.template_config.title_slots||[]).map((slot,index)=>['真实模板第一行标题','真实模板第二行标题','第三行说明文案'][index]||slot.sample_text);
    }else plan={draft_name:'恢复版_真实爆款模板验证',text_replacements:(template.template_config.text_slots||[]).map(s=>({slot_index:s.index,text:s.sample_text||s.original_text||'验证文案'})),media_replacements:[]};
    write(path.join(root,kind+'-plan.json'),plan);
    const result=await service.generate({mode:kind,template_dir:info.template_path,template_config_file:info.config_path,draft_output_dir:output,generation_plan:plan});
    const content=read(result.draft_content),materials=content.materials||{};
    const textValues=[];
    const collect=value=>{if(Array.isArray(value)){value.forEach(collect);return;}if(!value||typeof value!=='object')return;for(const m of value.materials?.texts||[]){try{textValues.push(JSON.parse(m.content).text);}catch{}}Object.values(value).forEach(collect);};collect(content);
    if(kind==='video_template'&&!textValues.includes('第一句验证字幕'))throw new Error('生成的口播草稿缺少实际字幕');
    if(kind==='video_template'&&!textValues.includes('真实模板第一行标题'))throw new Error('生成的口播草稿缺少嵌套标题');
    const missing=[];
    const visit=obj=>{if(Array.isArray(obj)){obj.forEach(visit);return;}if(!obj||typeof obj!=='object')return;for(const list of ['videos','audios'])for(const item of obj.materials?.[list]||[])if(item.path&&!/^https?:/.test(item.path)&&!fs.existsSync(item.path))missing.push(item.path);Object.values(obj).forEach(visit);};visit(content);
    report.push({kind,slug,ok:result.ok,draft_dir:result.draft_dir,draft_content:result.draft_content,duration_us:content.duration,tracks:(content.tracks||[]).map(t=>({type:t.type,segments:t.segments?.length})),texts:textValues,missing_media:missing});
  }
  write(path.join(root,'real-template-report.json'),{cases:report,jianying_open_tested:false,macos_tested:false});console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
