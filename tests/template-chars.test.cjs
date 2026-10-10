const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {analyzeTemplate,visibleChars}=require('../backend/template.cjs');
const {write}=require('../backend/util.cjs');
const resources=path.resolve(process.env.XYCUT_RESOURCES||path.join(__dirname,'../resources'));
const originals=[
  ['xycut-hot-template-skill','generate_from_template.py','text_visible_chars','f2efdab51af78a87d4c954165afbe8fc24f251706b7792ec51443c9fa4103ed5'],
  ['xycut-video-template-skill','analyze_video_template_plan.py','visible_chars','07df4c86e5ae615b5b5f9086a3e58cee0688fd0cb29131c6368daa86f8dacb7f'],
  ['xycut-video-template-skill','validate_video_template_plan.py','visible_char_count','d5a19557323565886629f6154e88403827dbed7716afc0610b8d466814d27b13'],
  ['xycut-video-template-skill','match_subtitle_presets.py','visible_chars','b2973d3f33cf76bb5221c6b4a15513c416e9254b271994e59194c2ede846d35f']
];
const fixtures=[
  ['',0],[' \t\r\n\u0085\u3000',0],['A',1],['AB',1],['ABC',1],['ABCD',2],
  ['中文',2],['中文 AI',3],['中A',1],['中A!',2],['，。!?',3],
  ['中\n文\r\nAI',3],['😀',1],['👩‍💻',3],['🇨🇳',2],['e\u0301',1],
  ['A\u001cB',1],['A\u0085B',1],['A\ufeffB',2],['A\u200bB',2],
  ['A'.repeat(31),15],['A'.repeat(32),16],['中'.repeat(16),16]
];
let originalResult;
function originalRun(){
  if(originalResult)return originalResult;
  for(const [skill,file,,sha]of originals){
    const source=path.join(resources,'agent-kit/skills',skill,'scripts',file);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),sha,'计数参考必须保持原 Agent 脚本内容：'+file);
  }
  const python=process.env.XYCUT_PYTHON||path.join(resources,'python',process.platform==='win32'?'python.exe':'bin/python3.9');
  assert.ok(fs.existsSync(python),'需要当前平台 CPython 3.9 资源');
  const code=[
    'import importlib.util,json,sys',
    'from pathlib import Path',
    'request=json.load(sys.stdin); modules=[]; counts={}',
    'for skill,name,function,sha in request["originals"]:',
    ' p=Path(request["resources"])/"agent-kit"/"skills"/skill/"scripts"/name',
    ' spec=importlib.util.spec_from_file_location("fixture_"+name.replace(".","_"),p)',
    ' module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); modules.append(module)',
    ' counts[name]=[getattr(module,function)(text) for text in request["texts"]]',
    'hot=modules[0]; validator=modules[2]',
    'plan={"title":{"items":[{"text":"标题"}]},"subtitles":[{"index":1,"style_level":"01","text":"A"*31,"lines":["A"*31],"line_chars":[15],"preset_match":{"source":"template_subtitle_style_groups","variant":{}}}]}',
    'accepted=validator.validate_plan(plan,False)',
    'plan["subtitles"][0].update(text="A"*32,lines=["A"*32],line_chars=[16]); rejected=validator.validate_plan(plan,False)',
    'plan03={"title":{"items":[{"text":"标题"}]},"subtitles":[{"index":1,"style_level":"03","text":"ABCDEFGHIJKLMNOPQ中文","lines":["A"*17,"中文"],"line_chars":[8,2],"preset_match":{}}]}',
    'accepted03=validator.validate_plan(plan03,False)',
    'plan03["subtitles"][0].update(text="A"*18+"中文",lines=["A"*18,"中文"],line_chars=[9,2]); rejected03=validator.validate_plan(plan03,False)',
    'ranges=[hot.text_char_range(slot) for slot in request["slots"]]',
    'spaces=[cp for cp in range(0x110000) if chr(cp).isspace()]',
    'print(json.dumps({"counts":counts,"spaces":spaces,"ranges":ranges,"accepted":accepted,"rejected":rejected,"accepted03":accepted03,"rejected03":rejected03},ensure_ascii=False))'
  ].join('\n');
  const result=spawnSync(python,['-c',code],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},input:JSON.stringify({resources,originals,texts:fixtures.map(([text])=>text),slots:[{original_text:'中'.repeat(20),suggest_chars:'15-25字'},{original_text:'ABCD',suggest_chars:'1-8字'},{original_text:'中'.repeat(25),suggest_chars:'23-25字'}]})});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);
  originalResult=JSON.parse(result.stdout);return originalResult;
}
test('模板与 Agent 的半角计数逐项匹配四份原始脚本',()=>{
  const expected=fixtures.map(([,count])=>count),actual=fixtures.map(([text])=>visibleChars(text));
  assert.deepEqual(actual,expected);
  const original=originalRun();for(const [name,counts]of Object.entries(original.counts))assert.deepEqual(actual,counts,name);
  // Exhaustively cover Python's whitespace table instead of substituting JS \s.
  assert.deepEqual(original.spaces,[9,10,11,12,13,28,29,30,31,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288]);
  for(const code of original.spaces)assert.equal(visibleChars(String.fromCodePoint(code)),0,'U+'+code.toString(16));
  for(const code of [0,8,14,27,127,132,134,0x180e,0x200b,0x200c,0x200d,0x200e,0x200f,0x202a,0x2060,0xfeff])assert.equal(visibleChars(String.fromCodePoint(code)),1,'应保留 U+'+code.toString(16));
});
test('原工作台保留按去 JS 空白码点计数的独立显示规则',()=>{
  const original=fs.readFileSync(path.join(resources,'agent-kit/tools/editing-workbench/public/workbench.js'),'utf8');
  const counter=original.match(/function Xt\(t\)\{return Array\.from\(String\(t\|\|""\)\.replace\(\/\\s\+\/g,""\)\)\.length\}/);
  assert.ok(counter,'原工作台计数函数必须可以辨认');
  const uiCount=vm.runInNewContext('('+counter[0]+')');
  assert.equal(uiCount('中文 AI'),4);assert.equal(visibleChars('中文 AI'),3);
  assert.equal(uiCount('A\u0085B'),3);assert.equal(visibleChars('A\u0085B'),1);
  assert.equal(uiCount('A\ufeffB'),2);assert.equal(visibleChars('A\ufeffB'),2);
  assert.equal(uiCount('👩‍💻'),3);assert.equal(visibleChars('👩‍💻'),3);
});
test('原 Agent 边界校验用半角单位，03 逐槽检查且不截断文本',()=>{
  const original=originalRun();
  assert.equal(original.accepted.ok,true);assert.equal(original.rejected.ok,false);
  assert.ok(original.rejected.errors.some(error=>error.startsWith('long_0102_subtitle_over_limit:')));
  assert.equal(original.accepted03.ok,true);assert.equal(original.rejected03.ok,false);
  assert.ok(original.rejected03.errors.some(error=>error.startsWith('long_03_slot_over_limit:')));
  assert.deepEqual(original.ranges,[[18,20],[1,2],[23,25]]);
});
test('本地转换保留完整中英多段文字且参数采用原 Agent 计数',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xycut-chars-'));
  try{
    const texts=['这是第二行标题\n标题内容可以自动替换','这里是小文案说明\n可以让AI任意替换，这里只做展示','中A！\n👩‍💻'];
    const draft={duration:10000000,canvas_config:{width:1080,height:1920},materials:{texts:texts.map((text,index)=>({id:'t'+index,content:JSON.stringify({text})})),drafts:[{draft:{duration:10000000,materials:{texts:[{id:'nested',content:JSON.stringify({text:'Nested 中\n😀'})}]},tracks:[{type:'text',segments:[{material_id:'nested',target_timerange:{start:0,duration:10000000}}]}]}}]},tracks:texts.map((text,index)=>({type:'text',segments:[{material_id:'t'+index,target_timerange:{start:0,duration:10000000}}]}))};
    write(path.join(root,'preset_draft/draft_content.json'),draft);
    for(const kind of ['video_template','hot_template']){
      const converted=analyzeTemplate(root,kind,'字数测试'),slots=converted.title_slots||converted.text_slots;
      assert.deepEqual(slots.map(slot=>slot.sample_text),[...texts,'Nested 中\n😀']);
      assert.deepEqual(slots.map(slot=>slot.sample_chars),[17,23,5,5]);
      assert.equal(slots[3].draft_path,'root.drafts[0]');
    }
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^xycut-chars-/);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
