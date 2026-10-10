// Apply saved workbench edits without flattening preset text slots or replacing
// text edited in the standalone preview with an older ASR transcription.
const {visibleChars}=require('./template.cjs');
function key(line,index){return String(line.line_id||line.id||'line_'+String(index+1).padStart(3,'0'));}
function compact(value){return String(value??'').replace(/\s/g,'');}
function parentIds(item){return [...new Set([...(Array.isArray(item.source_line_ids)?item.source_line_ids:[]),item.source_line_id,item.line_id,item.id].filter(Boolean).map(String))];}
function timeMs(value,name){const explicit=value[name+'_ms'];return Number.isFinite(Number(explicit))&&explicit!=null?Math.round(Number(explicit)):Math.round(Number(value[name])*1000);}
function wordsText(words){return words.map(word=>String(word.text??word.word??'')).join('');}
function wordRange(item){const start=Number(item.source_word_start_idx),end=Number(item.source_word_end_idx);return item.source_word_start_idx!=null&&item.source_word_end_idx!=null&&Number.isInteger(start)&&Number.isInteger(end)&&end>=start?{start,end}:null;}
function withinWords(lines,range){return lines.flatMap(line=>line.words||[]).filter(word=>Number(word.idx)>=range.start&&Number(word.idx)<=range.end);}

// Retained characters keep their original slot; insertions inherit the
// adjacent source position. This never divides a sentence into new slots.
function characterOwners(before,after){
  if(before===after)return [...String(before)].map((_char,index)=>index);
  const a=[...String(before)],b=[...String(after)],rows=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
  let i=0,j=0;const owners=[];
  while(j<b.length){if(i<a.length&&a[i]===b[j]){owners.push(i);i++;j++;}else if(i<a.length&&rows[i+1][j]>=rows[i][j+1])i++;else{owners.push(Math.min(i,Math.max(0,a.length-1)));j++;}}
  return owners;
}
function projectSlots(parts,after){
  const before=parts.join(''),sourceSlots=parts.flatMap((part,index)=>[...part].map(()=>index)),owners=characterOwners(before,after),result=parts.map(()=>[]);
  [...after].forEach((char,index)=>result[sourceSlots[owners[index]]??0].push(char));
  return result.map(chars=>chars.join(''));
}
function projectWordSlots(parts,oldWords,newWords){
  if(compact(parts.join(''))!==compact(wordsText(oldWords)))return projectSlots(parts,wordsText(newWords));
  const slots=parts.flatMap((part,index)=>[...part].filter(char=>! /\s/.test(char)).map(()=>index)),offsets=new Map();let offset=0;
  for(const word of oldWords){const chars=[...compact(word.text??word.word??'')];offsets.set(Number(word.idx),{offset,text:chars.join('')});offset+=chars.length;}
  const result=parts.map(()=>[]);
  for(const word of newWords){const source=offsets.get(Number(word.idx));if(!source)continue;const content=String(word.text??word.word??''),owners=characterOwners(source.text,content);[...content].forEach((char,index)=>result[slots[source.offset+owners[index]]??0].push(char));}
  return result.map(chars=>chars.join(''));
}
function sourceTextProjection(item,old,line){
  const start=Number(item.source_text_start),end=Number(item.source_text_end);
  if(item.source_text_start==null||item.source_text_end==null||!Number.isInteger(start)||!Number.isInteger(end)||end<=start||!old)return null;
  const before=String(old.text??''),after=String(line.text??''),original=[...before].slice(start,end).join('');
  if(compact(item.text)!==compact(original))return null;
  const owners=characterOwners(before,after);
  return [...after].filter((_char,index)=>owners[index]>=start&&owners[index]<end).join('');
}
function refreshHighlights(updated,original){
  if(String(updated.style_level)==='03'){updated.highlight_terms=[];updated.highlight_ranges=[];return;}
  const source=String(original.text??''),current=String(updated.text??'');
  let terms=original.highlight_terms||original.keywords||[];
  if(!Array.isArray(terms))terms=typeof terms==='string'?terms.split(/[,，、;；\n]/):[];
  terms=terms.map(term=>typeof term==='object'&&term?term.text||term.word||term.term||term.value||term.keyword||'':String(term));
  if(!terms.length)terms=(original.highlight_ranges||[]).filter(range=>range.field!=='secondary').map(range=>String(range.text||[...source].slice(Number(range.start),Number(range.end)).join('')));
  terms=[...new Set(terms.map(term=>term.trim()).filter(term=>term&&term!==current&&current.includes(term)))].slice(0,3);
  if(terms.length||original.highlight_terms||original.highlight_ranges||original.keywords){
    updated.highlight_terms=terms;
    updated.highlight_ranges=terms.map(term=>{const offset=current.indexOf(term);const start=[...current.slice(0,offset)].length;return{field:'main',start,end:start+[...term].length,text:term};});
  }
}
function updateText(updated,original,desired,oldWords=[],words=[]){
  if(desired===null||desired===undefined||desired===original.text)return;
  updated.text=desired;updated.chars=visibleChars(desired);
  if(String(original.style_level)==='03'&&Array.isArray(original.lines)&&original.lines.length){
    if(compact(original.lines.join(''))!==compact(original.text))throw new Error('重点字幕文字与分段不一致，请在字幕预览中调整分段后生成。');
    updated.lines=oldWords.length?projectWordSlots(original.lines.map(String),oldWords,words):projectSlots(original.lines.map(String),desired);
    if(updated.lines.some(line=>!line.trim()))throw new Error('删词后重点字幕有空文字槽，请在字幕预览中重新选择预设或调整分段。');
  }else updated.lines=[desired];
  updated.line_chars=updated.lines.map(visibleChars);
  if(updated.preset_match){const match={...updated.preset_match,input_lengths:[...updated.line_chars]};const limits=match.slot_max_chars||match.preset?.slot_max_chars||[];match.overflow_chars=updated.line_chars.reduce((sum,length,index)=>{const limit=Number(limits[Math.min(index,limits.length-1)]);return sum+(limit>0?Math.max(0,length-limit):0);},0);updated.preset_match=match;}
}
function applyEditedTimeline(plan,timeline,previous={}){
  if(!Array.isArray(timeline?.lines))return plan;
  const oldLines=new Map((previous?.lines||[]).map((line,index)=>[key(line,index),line]));
  const byId=new Map(timeline.lines.map((line,index)=>[key(line,index),line]));
  const prepared=[];
  for(const item of plan.subtitles||[]){
    const ids=parentIds(item),parents=ids.filter(id=>byId.has(id)).map(id=>byId.get(id)),oldParents=ids.filter(id=>oldLines.has(id)).map(id=>oldLines.get(id));
    if(!parents.length){if(!oldParents.length)prepared.push({original:item,updated:{...item},unmapped:true});continue;}
    const range=wordRange(item),words=range?withinWords(parents,range):[],oldWords=range?withinWords(oldParents,range):[];
    // No timestamps is different from a confirmed source range deleted in full.
    if(range&&oldWords.length&&!words.length)continue;
    const updated={...item};let desired,wordTimed=false;
    if(range&&words.length){
      const start=Math.min(...words.map(word=>timeMs(word,'start'))),end=Math.max(...words.map(word=>timeMs(word,'end')));
      if(Number.isFinite(start)&&Number.isFinite(end)&&end>start){updated.start_ms=start;updated.end_ms=end;updated.duration_ms=end-start;wordTimed=true;}
      const unchanged=oldWords.length===words.length&&oldWords.every((word,index)=>Number(word.idx)===Number(words[index].idx)&&String(word.text??word.word??'')===String(words[index].text??words[index].word??''));
      if(!unchanged&&oldWords.length&&compact(item.text)===compact(wordsText(oldWords)))desired=wordsText(words);
    }else if(parents.length===1&&oldParents.length===1){
      desired=sourceTextProjection(item,oldParents[0],parents[0]);
      if(desired===null&&compact(item.text)===compact(oldParents[0].text))desired=String(parents[0].text??'');
    }
    if(desired==='')continue;
    updateText(updated,item,desired,oldWords,words);refreshHighlights(updated,item);
    prepared.push({original:item,updated,parents,ids,wordTimed});
  }
  const groups=new Map();
  for(const entry of prepared){
    if(entry.unmapped||entry.wordTimed)continue;
    if(entry.parents.length>1){entry.updated.start_ms=Math.min(...entry.parents.map(line=>timeMs(line,'start')));entry.updated.end_ms=Math.max(...entry.parents.map(line=>timeMs(line,'end')));entry.updated.duration_ms=entry.updated.end_ms-entry.updated.start_ms;continue;}
    const id=entry.ids.find(id=>byId.has(id));if(!groups.has(id))groups.set(id,[]);groups.get(id).push(entry);
  }
  for(const[id,group]of groups){
    const line=byId.get(id),start=timeMs(line,'start'),end=timeMs(line,'end'),weights=group.map(entry=>Math.max(1,Number(entry.original.duration_ms)||Number(entry.original.end_ms)-Number(entry.original.start_ms)||1)),total=weights.reduce((sum,value)=>sum+value,0);let weight=0;
    group.forEach((entry,index)=>{entry.updated.start_ms=Math.round(start+(end-start)*weight/total);weight+=weights[index];entry.updated.end_ms=index===group.length-1?end:Math.round(start+(end-start)*weight/total);entry.updated.duration_ms=entry.updated.end_ms-entry.updated.start_ms;});
  }
  plan.subtitles=prepared.filter(entry=>entry.unmapped||entry.updated.duration_ms>0).map(entry=>entry.updated);
  if(plan.material_plan?.items)plan.material_plan.items=plan.material_plan.items.filter(item=>{const ids=parentIds(item);return ids.some(id=>byId.has(id))||!ids.some(id=>oldLines.has(id));}).map(item=>{const lines=parentIds(item).filter(id=>byId.has(id)).map(id=>byId.get(id));if(!lines.length)return item;const start=Math.min(...lines.map(line=>timeMs(line,'start'))),end=Math.max(...lines.map(line=>timeMs(line,'end')));return{...item,subtitle_text:lines.map(line=>line.text).join(''),target_start_ms:start,target_end_ms:end,target_duration_ms:Math.max(1,end-start)};});
  plan.line_timeline=timeline;
  return plan;
}
module.exports={applyEditedTimeline};
