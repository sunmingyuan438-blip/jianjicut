const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {within,write}=require('./util.cjs');

// Current Jianying indexes imported drafts as draft_info.json. Keep the legacy
// file for the recovered core/preview, and publish the same content for Jianying.
// This is called only for a newly assembled output, never for an existing user draft.
function finalizeJianyingDraft(result, outputRoot) {
  const root=path.resolve(outputRoot),folder=path.resolve(result.draft_dir||'');
  if(!result.draft_dir||folder===root||!within(root,folder)||fs.lstatSync(folder).isSymbolicLink())throw new Error('草稿输出路径不在指定保存目录中');
  const files=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory())walk(file);
    else if(entry.name==='draft_content.json')files.push(file);
  }}
  walk(folder);
  if(!files.includes(path.join(folder,'draft_content.json')))throw new Error('生成结果缺少 draft_content.json');
  // Validate all files before writing any compatibility file.
  const drafts=files.map(file=>{
    const data=fs.readFileSync(file,'utf8');let draft;
    try{draft=JSON.parse(data);}catch{throw new Error('生成草稿不是有效 JSON：'+file);}
    if(!Array.isArray(draft.tracks)||!draft.materials||typeof draft.materials!=='object')throw new Error('生成草稿缺少轨道或素材：'+file);
    return {file,draft};
  });
  const copies=new Map(),assets=path.join(folder,'materials');
  if(fs.existsSync(assets)&&fs.lstatSync(assets).isSymbolicLink())throw new Error('拒绝写入素材符号链接目录');
  const pending=[],warnings=[];
  for(const {file,draft} of drafts){
    const used=new Set();
    function collect(value){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){
      if(key==='material_id'&&typeof item==='string')used.add(item);
      else if(key==='extra_material_refs'&&Array.isArray(item))item.forEach(id=>used.add(id));
      else if(item&&typeof item==='object')collect(item);
    }}
    collect(draft.tracks);
    for(const [kind,list] of Object.entries(draft.materials)){
      if(!Array.isArray(list))continue;
      for(const material of list){
        for(const key of ['path','media_path','file_path']){
          const source=material[key];if(typeof source!=='string'||!source)continue;
          const media=['videos','audios','images'].includes(kind);
          const reloadable=!media||kind==='audios'&&material.type==='sound'&&!!(material.resource_id||material.effect_id);
          if(/^(?:https?:|data:)/i.test(source)){if(used.has(material.id)&&!reloadable)throw new Error('草稿素材尚未下载：'+source);continue;}
          let stat;try{stat=fs.statSync(source);}catch{
            if(reloadable&&(material.resource_id||material.effect_id)){
              material[key]='';
              if(used.has(material.id))warnings.push('模板效果缓存缺失，需剪映重新加载：'+String(material.name||material.material_name||material.resource_id||material.effect_id));
              continue;
            }
            if(media&&used.has(material.id))throw new Error('草稿素材不存在：'+source);
            continue;
          }
          if(!stat.isFile())continue;
          if(within(folder,source))continue;
          if(!copies.has(source)){
            const name=crypto.createHash('sha256').update(source).digest('hex').slice(0,16)+path.extname(source);
            copies.set(source,path.join(assets,name));
          }
          pending.push({material,key,source,target:copies.get(source)});
        }
      }
    }
    const target=path.join(path.dirname(file),'draft_info.json');
    if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('拒绝写入草稿符号链接：'+target);
  }
  if(copies.size)fs.mkdirSync(assets,{recursive:true});
  for(const [source,target] of copies){if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('拒绝覆盖素材符号链接');fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}
  for(const {material,key,target} of pending)material[key]=target;
  for(const {file,draft} of drafts){
    write(file,draft);
    write(path.join(path.dirname(file),'draft_info.json'),draft);
    for(const name of ['template.tmp','template-2.tmp']){
      const mirror=path.join(path.dirname(file),name);
      if(fs.existsSync(mirror)){if(fs.lstatSync(mirror).isSymbolicLink())throw new Error('拒绝写入草稿符号链接：'+mirror);write(mirror,draft);}
    }
  }
  return {...result,draft_info:path.join(folder,'draft_info.json'),jianying_compatible:true,compatibility_files:drafts.length,copied_media_count:copies.size,warnings:[...new Set(warnings)],import_message:'草稿已写入剪映目录；若剪映首页尚未显示，请保存当前工程后退出并重新打开剪映。'+(warnings.length?' 部分模板效果缓存缺失，需要剪映联网重新加载。':'')};
}
module.exports={finalizeJianyingDraft};
