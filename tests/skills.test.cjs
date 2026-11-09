'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {catalog,normalize}=require('../backend/skills.cjs');
const root=path.join(__dirname,'..');

test('Skill 目录可读取，目前为空并带标题',()=>{
  const value=catalog();
  assert.equal(value.title,'掌门独家剪辑 Skill');assert.ok(Array.isArray(value.skills));
});

test('目录条目会被规范化：过滤非法 id、重复项和非 HTTPS 地址',()=>{
  const value=normalize({skills:[
    {id:'dark-console',name:'暗色控制台口播',summary:'科技风',category:'口播包装',tags:['竖屏',''],cover:'https://cdn.example.com/a.jpg',demo:'http://cdn.example.com/a.mp4',prompt:'调用 $dark-console',status:'ready'},
    {id:'dark-console',name:'重复'},{id:'Bad ID',name:'非法'},{id:'no-name'},
    {id:'paper-fold',name:'纸面翻折',status:'coming_soon',cover:'javascript:alert(1)'},
  ]});
  assert.deepEqual(value.skills.map(s=>s.id),['dark-console','paper-fold']);
  assert.equal(value.skills[0].cover,'https://cdn.example.com/a.jpg');assert.equal(value.skills[0].demo,null);assert.deepEqual(value.skills[0].tags,['竖屏']);
  assert.equal(value.skills[1].cover,null);assert.equal(value.skills[1].status,'coming_soon');
  assert.throws(()=>normalize({}),/格式无效/);
});

test('Motion 模板板块已从产品中移除',()=>{
  for(const file of ['backend/motion-templates.cjs','backend/motion-catalog.json','desktop/motion-ui.js','desktop/motion-ui.css','web/motion-templates.html'])assert.equal(fs.existsSync(path.join(root,file)),false,file);
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.match(read('desktop/bridge.js'),/'skill-ui'/);assert.doesNotMatch(read('desktop/bridge.js'),/motion-ui/);
  assert.match(read('backend/service.cjs'),/zhangmen_skill_catalog/);assert.doesNotMatch(read('backend/service.cjs'),/motion_template/);
  assert.match(read('web/index.html'),/href="\/skills">浏览掌门独家剪辑 Skill/);
});

class Node{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.dataset={};this.textContent='';this.hidden=false;this.style={};this.value='';}
  append(...n){this.children.push(...n);} replaceChildren(...n){this.children=n;} setAttribute(k,v){this.attributes[k]=v;} hasAttribute(k){return k in this.attributes;}
  addEventListener(n,f){this.listeners[n]=f;} get childElementCount(){return this.children.length;} remove(){} select(){} showModal(){this.open=true;} close(){}
  querySelectorAll(){return [];}
}
const text=n=>[n.textContent||'',...(n.children||[]).filter(c=>c instanceof Node).map(text)].join(' ');
async function renderStandalone(data){
  const nodes={'skill-library-root':new Node('main')};
  const body=new Node('body');body.attributes['data-skill-library']='';
  const document={body,getElementById:id=>nodes[id]||null,createElement:tag=>new Node(tag),querySelectorAll:()=>[],execCommand:()=>true};
  class Option{constructor(t,v){this.textContent=t;this.value=v;}}
  vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/skill-ui.js'),'utf8'),{window:{},document,fetch:async()=>({ok:true,json:async()=>data}),URL,Option,navigator:{clipboard:{writeText:async()=>{}}},setTimeout,MutationObserver:class{observe(){}}});
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  return nodes['skill-library-root'];
}

test('网页端：空目录显示“正在准备中”',async()=>{
  const view=await renderStandalone({title:'掌门独家剪辑 Skill',skills:[]});
  assert.match(text(view),/掌门独家剪辑 Skill/);assert.match(text(view),/首批独家 Skill 正在准备中/);
});

test('网页端：有 Skill 时显示卡片、标签和复制提示词按钮',async()=>{
  const view=await renderStandalone(normalize({skills:[{id:'dark-console',name:'暗色控制台口播',summary:'科技风口播包装',category:'口播包装',tags:['竖屏'],prompt:'调用 $dark-console'},{id:'soon',name:'即将上线的 Skill',status:'coming_soon'}]}));
  const all=text(view);
  assert.match(all,/暗色控制台口播/);assert.match(all,/科技风口播包装/);assert.match(all,/竖屏/);assert.match(all,/复制使用提示词/);assert.match(all,/即将上线/);
  assert.equal((all.match(/复制使用提示词/g)||[]).length,1,'即将上线的 Skill 不提供复制');
  assert.match(all,/共 2 个 Skill/);
});
