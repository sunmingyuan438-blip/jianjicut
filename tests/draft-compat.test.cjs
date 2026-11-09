const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {finalizeJianyingDraft}=require('../backend/draft-compat.cjs');
const {Service}=require('../backend/service.cjs');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhangmen-draft-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const output=path.join(root,'中文 草稿目录'),draft=path.join(output,'掌门cut 测试');fs.mkdirSync(draft,{recursive:true});return{root,output,draft};}
function content(file,media){const draft={tracks:[{type:'video',segments:[{material_id:'m'}]}],materials:{videos:media?[{id:'m',path:media}]:[]},duration:1000000};fs.writeFileSync(file,JSON.stringify(draft));return draft;}
test('中文/空格草稿发布新旧入口并复制引用素材，原始素材和其他工程不变',t=>{
 const {root,output,draft}=setup(t),media=path.join(root,'原始 素材.png');fs.writeFileSync(media,'fixture');content(path.join(draft,'draft_content.json'),media);
 const other=path.join(output,'原有工程');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'untouched'),'keep');
 const r=finalizeJianyingDraft({draft_dir:draft},output);assert.equal(r.copied_media_count,1);
 const d=JSON.parse(fs.readFileSync(r.draft_info));assert.ok(d.materials.videos[0].path.startsWith(draft+path.sep));assert.equal(fs.readFileSync(d.materials.videos[0].path,'utf8'),'fixture');assert.equal(fs.readFileSync(media,'utf8'),'fixture');assert.equal(fs.readFileSync(path.join(other,'untouched'),'utf8'),'keep');
 assert.deepEqual(d,JSON.parse(fs.readFileSync(path.join(draft,'draft_content.json'))));assert.equal(finalizeJianyingDraft({draft_dir:draft},output).copied_media_count,0);
});
test('嵌套模板子草稿也具有draft_info，镜像同步',t=>{
 const {output,draft}=setup(t);content(path.join(draft,'draft_content.json'));const sub=path.join(draft,'subdraft','test');fs.mkdirSync(sub,{recursive:true});content(path.join(sub,'draft_content.json'));fs.writeFileSync(path.join(draft,'template-2.tmp'),'old');
 const r=finalizeJianyingDraft({draft_dir:draft},output);assert.equal(r.compatibility_files,2);assert.ok(fs.existsSync(path.join(sub,'draft_info.json')));assert.equal(fs.readFileSync(path.join(draft,'template-2.tmp'),'utf8'),fs.readFileSync(r.draft_info,'utf8'));
});
test('被引用素材缺失明确失败，不能仅因JSON可读报告成功',t=>{
 const {root,output,draft}=setup(t);content(path.join(draft,'draft_content.json'),path.join(root,'缺失.mp4'));assert.throws(()=>finalizeJianyingDraft({draft_dir:draft},output),/素材不存在/);assert.equal(fs.existsSync(path.join(draft,'draft_info.json')),false);
});
test('拒绝输出越界与符号链接，保护外部数据',t=>{
 const {root,output,draft}=setup(t);const outside=path.join(root,'outside');fs.mkdirSync(outside);content(path.join(outside,'draft_content.json'));assert.throws(()=>finalizeJianyingDraft({draft_dir:outside},output),/输出路径/);assert.throws(()=>finalizeJianyingDraft({draft_dir:output},output),/输出路径/);
 fs.symlinkSync(outside,path.join(draft,'materials'));content(path.join(draft,'draft_content.json'));assert.throws(()=>finalizeJianyingDraft({draft_dir:draft},output),/符号链接/);
});
test('当前客户端草稿目录优先于旧分析中的保存目录，显式请求仍可覆盖',async t=>{
 const {root,output}=setup(t);const stale=path.join(root,'stale');fs.mkdirSync(stale);const svc=Object.create(Service.prototype);Object.assign(svc,{apiContext:{draft_output_dir:output},dataDir:path.join(root,'data'),resources:root,grant(){},runtimeStatus(){return{installed:true};},async worker(request){const folder=path.join(request.payload.draft_output_dir,'new'+Math.random());fs.mkdirSync(folder);content(path.join(folder,'draft_content.json'));return{ok:true,draft_dir:folder};}});
 const body={mode:'template_designer',generation_plan:{draft_output_dir:stale}};const r=await svc.generate(body);assert.equal(path.dirname(r.draft_dir),output);const explicit=await svc.generate({...body,draft_output_dir:stale});assert.equal(path.dirname(explicit.draft_dir),stale);
});
test('Windows效果缓存路径不误判为主媒体缺失，保留资源ID并给出重加载提示',t=>{
 const {output,draft}=setup(t);const d=content(path.join(draft,'draft_content.json'));d.tracks[0].segments[0].extra_material_refs=['effect','sound'];d.materials.effects=[{id:'effect',resource_id:'fixture-effect',path:'C:/Cache/effect/not-shipped'}];d.materials.audios=[{id:'sound',type:'sound',effect_id:'fixture-sound',path:'C:/Cache/music/not-shipped.mp3'}];fs.writeFileSync(path.join(draft,'draft_content.json'),JSON.stringify(d));const r=finalizeJianyingDraft({draft_dir:draft},output);const saved=JSON.parse(fs.readFileSync(r.draft_info));assert.equal(saved.materials.effects[0].path,'');assert.equal(saved.materials.audios[0].path,'');assert.equal(saved.materials.effects[0].resource_id,'fixture-effect');assert.equal(r.warnings.length,2);
});
