const fs=require('node:fs');
const path=require('node:path');
const {read}=require('./util.cjs');
// The original Agent scripts measure text in half-width units. Python 3.9's
// str.isspace() differs from JavaScript's \s (notably U+0085 and U+FEFF).
// Preserve that contract for template metadata and Agent plans; the original
// workbench's own UI counter intentionally remains unchanged.
function isAgentWhitespace(code){return(code>=0x09&&code<=0x0d)||(code>=0x1c&&code<=0x20)||code===0x85||code===0xa0||code===0x1680||(code>=0x2000&&code<=0x200a)||code===0x2028||code===0x2029||code===0x202f||code===0x205f||code===0x3000;}
function visibleChars(value){
  let units=0;
  for(const char of String(value||'')){const code=char.codePointAt(0);if(!isAgentWhitespace(code))units+=code<128?1:2;}
  return units?Math.max(1,Math.floor(units/2)):0;
}
function draftFile(folder){return[path.join(folder,'preset_draft/draft_content.json'),path.join(folder,'draft_content.json')].find(fs.existsSync);}
function analyzeTemplate(folder,kind,name){
  const file=draftFile(folder);if(!file)throw new Error('没有可读的 draft_content.json');
  const root=read(file),textSlots=[],mediaSlots=[],subtitleGroups=[];
  let textIndex=0,mediaIndex=0;
  function inspect(content,draftPath){
    const texts=new Map((content.materials?.texts||[]).map(m=>[m.id,m]));
    const videos=new Map((content.materials?.videos||[]).map(m=>[m.id,m]));
    for(const[trackIndex,track]of(content.tracks||[]).entries()){
      const trackText=[];
      for(const[segmentIndex,segment]of(track.segments||[]).entries()){
        const range=segment.target_timerange||{},duration=Math.round((range.duration||0)/1000),start=Math.round((range.start||0)/1000);
        const item=texts.get(segment.material_id);
        if(item){let value={};try{value=JSON.parse(item.content||'{}');}catch{}const text=value.text||item.text||'',chars=visibleChars(text);
          trackText.push({index:++textIndex,material_id:item.id,track_index:trackIndex,segment_index:segmentIndex,draft_path:draftPath,start_ms:start,duration_ms:duration,y:segment.clip?.transform?.y||0,original_text:text,sample_text:text,sample_chars:chars,suggest_chars:`${Math.max(1,chars-2)}-${chars}字`,enabled:true});
        }
        const media=videos.get(segment.material_id);
        if(media)mediaSlots.push({index:++mediaIndex,material_id:media.id,track_index:trackIndex,segment_index:segmentIndex,draft_path:draftPath,start_ms:start,duration_ms:duration,min_duration_ms:duration,material_type:media.type==='photo'?'image':'video',orientation:media.height>=media.width?'portrait':'landscape',original_path:media.path,enabled:true});
      }
      if(kind==='video_template'&&trackText.length>1&&trackText.some(t=>t.duration_ms<Number(content.duration||root.duration||0)/1000*0.8)){
        const level=String(Math.min(3,subtitleGroups.length+1)).padStart(2,'0');subtitleGroups.push({style_level:level,name:level==='01'?'普通字幕':'强调字幕',track_index:trackIndex,variants:trackText.map((t,i)=>({...t,index:i+1,variant:i===0?'short':'long'}))});
      }else textSlots.push(...trackText);
    }
    for(const[index,item]of(content.materials?.drafts||[]).entries())if(item.draft)inspect(item.draft,draftPath+`.drafts[${index}]`);
  }
  inspect(root,'root');
  const config={schema_version:1,template_type:kind,template_slug:name,template_name:name,orientation:(root.canvas_config?.height||1920)>=(root.canvas_config?.width||1080)?'portrait':'landscape',duration_ms:Math.round((root.duration||0)/1000),canvas:root.canvas_config,media_slots:mediaSlots};
  if(kind==='hot_template')config.text_slots=textSlots;
  else Object.assign(config,{title_slots:textSlots,title_template_duration_mode:'full_video',subtitle_style_groups:subtitleGroups,subtitle_style_count:subtitleGroups.length,secondary_subtitle:{enabled:false,variants:[]}});
  return config;
}
module.exports={analyzeTemplate,draftFile,visibleChars};
