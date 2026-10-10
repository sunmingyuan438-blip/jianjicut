const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {Service}=require('../backend/service.cjs');
const {run,write,read}=require('../backend/util.cjs');
const resources=path.resolve(process.env.XYCUT_RESOURCES||path.join(__dirname,'../resources'));
const roots=[];
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xycut-material-'));roots.push(root);
  const service=new Service({resources,dataDir:path.join(root,'data')});
  return{root,service,source:path.join(root,'source')};
}
function image(file,label){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.concat([fs.readFileSync(path.join(resources,'frontend/icon.png')),Buffer.from(label)]));return file;}
function digest(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
async function sql(service,statement,parameters=[]){
  const program='import json,sqlite3,sys; r=json.load(sys.stdin); c=sqlite3.connect(r["db"]); c.row_factory=sqlite3.Row; q=c.execute(r["sql"],r["parameters"]); rows=[dict(x) for x in q.fetchall()]; c.commit(); print(json.dumps(rows))';
  return JSON.parse(await run(service.python(),['-c',program],{db:service.dbPath,sql:statement,parameters}));
}
async function analysis(service,sources,label='本地分析'){
  const file=path.join(service.dataDir,'fixture-analysis.json');
  write(file,{items:sources.map((source,index)=>({source_id:source.id,summary:label+index,keywords:['fixture',String(index)],quality_score:0.8}))});
  const result=await service.script('xycut-sucai-skill','save_material_analysis.py',[file,'--db',service.dbPath]);
  assert.equal(result.ok,true);assert.equal(result.saved_count,sources.length);
  return(await service.invoke('get_sucai_db_status')).materials;
}
async function completedFixture(count=3){
  const f=fixture(),created=await f.service.invoke('create_sucai_library',{name:'生命周期验收'});
  f.library=created.status.libraries[0];f.originals=[];
  for(let index=0;index<count;index++)f.originals.push(image(path.join(f.source,'分组'+index,'原始'+index+'.png'),'image-'+index));
  const imported=await f.service.invoke('import_sucai_materials',{libraryId:f.library.id,sourcePaths:[f.source]});
  f.materials=(await analysis(f.service,imported.status.source_materials)).sort((a,b)=>a.id.localeCompare(b.id));
  return f;
}
async function index(service,materials){
  const pending=await service.invoke('list_sucai_embedding_items',{limit:100});
  const selected=new Set(materials.map(item=>item.id));
  return service.invoke('save_sucai_embeddings',{provider:'fixture-local',model:'fixture-local',items:pending.items.filter(item=>selected.has(item.id)).map(item=>({id:item.id,source_hash:item.source_hash,embedding:[0.2,0.8]}))});
}
function cleanup(){for(const root of roots){assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^xycut-material-/);fs.rmSync(root,{recursive:true,force:true});}}

if(!process.versions.electron){
  const test=require('node:test');test.after(cleanup);

  test('F-23 多层目录分批导入、跨路径去重和已入库素材去重保留来源',async()=>{
    const {service,source}=fixture();const library=(await service.invoke('create_sucai_library',{name:'递归导入'})).library_id;
    const first=image(path.join(source,'一层','二层','三层','产品 A.png'),'A');
    const second=image(path.join(source,'一层','另组','产品 B.PNG'),'B');
    const duplicate=path.join(source,'另外目录','同内容.png');fs.mkdirSync(path.dirname(duplicate),{recursive:true});fs.copyFileSync(first,duplicate);
    fs.writeFileSync(path.join(source,'备注.txt'),'不是素材');
    const hashes=[first,second,duplicate].map(digest);
    const imported=await service.invoke('import_sucai_materials',{libraryId:library,sourcePaths:[path.join(source,'一层'),first,duplicate]});
    assert.equal(imported.imported_count,2);assert.equal(imported.skipped_count,1);assert.equal(imported.status.pending_source_count,2);
    assert.deepEqual(new Set(imported.status.source_materials.map(item=>item.original_path)),new Set([first,second]));
    const repeat=await service.invoke('import_sucai_materials',{libraryId:library,sourcePaths:[source]});assert.equal(repeat.imported_count,0);assert.equal(repeat.skipped_count,3);
    await analysis(service,repeat.status.source_materials);
    await sql(service,'DELETE FROM source_materials WHERE library_id=?',[library]);
    const completedDuplicate=await service.invoke('import_sucai_materials',{libraryId:library,sourcePaths:[first,duplicate]});assert.equal(completedDuplicate.imported_count,0);assert.equal(completedDuplicate.skipped_count,2);
    assert.deepEqual([first,second,duplicate].map(digest),hashes);
    const another=(await service.invoke('create_sucai_library',{name:'独立素材库'})).library_id;
    assert.equal((await service.invoke('import_sucai_materials',{libraryId:another,sourcePaths:[first]})).imported_count,1);
  });

  test('F-31 清空仅移除指定库 pending 来源，保留完成素材、进行中/失败记录和原始文件',async()=>{
    const f=await completedFixture(1),{service,source}=f;
    const paths=['待处理','进行中','失败'].map(label=>image(path.join(source,label+'.png'),label));
    const pending=await service.invoke('import_sucai_materials',{libraryId:f.library.id,sourcePaths:paths});
    const processing=pending.status.source_materials.find(item=>item.original_path===paths[1]);
    const failed=pending.status.source_materials.find(item=>item.original_path===paths[2]);
    await sql(service,"UPDATE source_materials SET status='processing' WHERE id=?",[processing.id]);
    await sql(service,"UPDATE source_materials SET status='failed',error_message='fixture' WHERE id=?",[failed.id]);
    const other=(await service.invoke('create_sucai_library',{name:'另一个库'})).library_id;
    await service.invoke('import_sucai_materials',{libraryId:other,sourcePaths:[paths[0]]});
    const originals=[...f.originals,...paths],hashes=originals.map(digest),copyHash=digest(f.materials[0].path);
    const cleared=await service.invoke('clear_sucai_pending_sources',{libraryId:f.library.id});
    assert.equal(cleared.cleared_count,1);assert.equal(cleared.status.material_count,1);assert.equal(cleared.status.pending_source_count,1);
    assert.deepEqual(cleared.status.source_materials.filter(item=>item.library_id===f.library.id).map(item=>item.status).sort(),['completed','failed','processing']);
    assert.equal(digest(f.materials[0].path),copyHash);assert.deepEqual(originals.map(digest),hashes);
    assert.equal((await service.invoke('clear_sucai_pending_sources',{libraryId:f.library.id})).cleared_count,0);
  });

  test('F-26 编辑后的 completed 状态可被原 Agent 检索，索引不重复且旧描述向量不能覆盖新描述',async()=>{
    const f=await completedFixture(1),{service}=f,material=f.materials[0];
    let changed=await service.invoke('update_sucai_material',{materialId:material.id,summary:'蓝色瓶装产品',keywords:['瓶装','瓶装','蓝色'],qualityScore:0.7});
    assert.equal(changed.status.materials[0].analysis_status,'completed');assert.equal(changed.status.libraries[0].analyzed_count,1);assert.equal(changed.status.libraries[0].embedded_count,0);
    const searched=await service.script('xycut-sucai-skill','search_materials.py',['--db',service.dbPath,'--library-id',f.library.id,'--query','蓝色']);
    assert.equal(searched.ok,true);assert.ok(searched.candidates.some(item=>item.material_id===material.id));
    const before=await service.invoke('list_sucai_embedding_items',{libraryId:f.library.id});assert.equal(before.items.length,1);
    const saved=await index(service,[material]);assert.equal(saved.saved_count,1);assert.equal(saved.status.materials[0].embedding_status,'completed');assert.equal(saved.status.libraries[0].embedded_count,1);
    assert.deepEqual((await service.invoke('list_sucai_embedding_items',{libraryId:f.library.id})).items,[]);
    changed=await service.invoke('update_sucai_material',{materialId:material.id,summary:'红色瓶装产品',keywords:['红色'],qualityScore:0.8});
    assert.equal(changed.status.embedding_count,0);assert.equal(changed.status.materials[0].embedding_status,'pending');
    await assert.rejects(service.invoke('save_sucai_embeddings',{provider:'fixture-local',model:'fixture-local',items:[{id:material.id,source_hash:before.items[0].source_hash,embedding:[0.1,0.9]}]}),/描述已变更/);
    const failed=await service.invoke('get_sucai_db_status');assert.equal(failed.embedding_count,0);assert.equal(failed.materials[0].embedding_status,'pending');
    assert.equal((await index(service,[material])).saved_count,1);
    const newest=await sql(service,'SELECT source_text,source_hash FROM material_embeddings');assert.equal(newest[0].source_text,'红色瓶装产品');
    await assert.rejects(service.invoke('update_sucai_material',{materialId:material.id,summary:'不可保存',qualityScore:'NaN'}),/有限数字/);
    assert.equal((await service.invoke('get_sucai_db_status')).materials[0].summary,'红色瓶装产品');
  });

  test('F-26 批次错误整批回滚，片段向量归属与重复保存正确，父分类包含子分类',async()=>{
    const f=await completedFixture(2),{service}=f,[first,second]=f.materials;
    const pending=(await service.invoke('list_sucai_embedding_items',{libraryId:f.library.id})).items;
    await assert.rejects(service.invoke('save_sucai_embeddings',{provider:'fixture-local',model:'fixture-local',items:[{id:first.id,source_hash:pending.find(item=>item.id===first.id).source_hash,embedding:[0.2]},{id:second.id,embedding:[true]}]}),/有限数值/);
    assert.equal((await service.invoke('get_sucai_db_status')).embedding_count,0);
    const timestamp='2026-10-09T00:00:00+00:00';
    await sql(service,'INSERT INTO material_segments VALUES (?,?,?,?,?,?,?,?,?)',['fixture-segment',first.id,0,1,'片段说明','[]',0.8,timestamp,timestamp]);
    await assert.rejects(service.invoke('save_sucai_embeddings',{provider:'fixture-local',model:'fixture-local',items:[{id:second.id,segment_id:'fixture-segment',embedding:[0.1]}]}),/片段不属于/);
    for(let i=0;i<2;i++)await service.invoke('save_sucai_embeddings',{provider:'fixture-local',model:'fixture-local',items:[{id:first.id,segment_id:'fixture-segment',text:'片段说明',embedding:[0.1,i]}]});
    assert.equal((await sql(service,'SELECT COUNT(*) AS count FROM material_embeddings'))[0].count,1);
    assert.equal((await service.invoke('list_sucai_embedding_items',{libraryId:f.library.id})).items.length,2);
    for(const [id,parent,name] of [['fixture-parent',null,'一级'],['fixture-child','fixture-parent','二级']])await sql(service,'INSERT INTO collections VALUES (?,?,?,?,?,?,?)',[id,f.library.id,parent,name,'folder',timestamp,timestamp]);
    await sql(service,"UPDATE materials SET collection_id='fixture-child' WHERE id=?",[first.id]);
    assert.deepEqual((await service.invoke('list_sucai_embedding_items',{collectionId:'fixture-parent'})).items.map(item=>item.id),[first.id]);
    assert.equal((await service.invoke('list_sucai_embedding_items',{limit:0})).items.length,0);
  });

  test('F-32 逐项多选重置/删除只作用于选择项，重置清空片段，删除受控复制文件而原始文件不变',async()=>{
    const f=await completedFixture(3),{service}=f,[first,second,untouched]=f.materials;
    await index(service,f.materials);const originals=f.originals.map(digest),untouchedHash=digest(untouched.path);
    const timestamp='2026-10-09T00:00:00+00:00';
    await sql(service,'INSERT INTO material_segments VALUES (?,?,?,?,?,?,?,?,?)',['reset-segment',first.id,0,1,'需要清空的片段','["标签"]',0.8,timestamp,timestamp]);
    for(const selected of [first,second])await service.invoke('reset_sucai_material_analysis',{materialId:selected.id});
    let status=await service.invoke('get_sucai_db_status');
    for(const selected of [first,second]){const row=status.materials.find(item=>item.id===selected.id);assert.equal(row.summary,'');assert.equal(row.keywords_json,'[]');assert.equal(row.quality_score,null);assert.equal(row.analysis_status,'pending');assert.equal(row.embedding_status,'pending');assert.equal(fs.existsSync(row.path),true);}
    assert.equal((await sql(service,'SELECT COUNT(*) AS count FROM material_segments'))[0].count,0);assert.equal(status.embedding_count,1);assert.equal(status.materials.find(item=>item.id===untouched.id).embedding_status,'completed');
    for(const selected of [first,second]){const deleted=await service.invoke('delete_sucai_material',{materialId:selected.id});assert.equal(deleted.removed_copy_count,1);assert.equal(fs.existsSync(selected.path),false);}
    status=await service.invoke('get_sucai_db_status');assert.deepEqual(status.materials.map(item=>item.id),[untouched.id]);assert.equal(status.embedding_count,1);assert.equal(digest(untouched.path),untouchedHash);assert.deepEqual(f.originals.map(digest),originals);
  });

  test('删除库仅清理所有权明确复制文件，保留未知文件与外部分类目录',async()=>{
    const f=await completedFixture(2),{service}=f;const originals=f.originals.map(digest);
    const unknown=path.join(f.library.root_path,'用户另存的笔记.txt');fs.writeFileSync(unknown,'必须保留');
    const removed=await service.invoke('delete_sucai_library',{libraryId:f.library.id});assert.equal(removed.removed_copy_count,2);assert.equal(removed.status.material_count,0);
    assert.deepEqual(f.originals.map(digest),originals);assert.equal(fs.readFileSync(unknown,'utf8'),'必须保留');assert.equal(fs.existsSync(f.library.root_path),true);
    const external=(await service.invoke('create_sucai_library',{name:'外部分类库'})).library_id;
    const indexed=await service.invoke('index_sucai_classified_directory',{libraryId:external,libraryName:'外部分类库',rootPath:f.source});assert.equal(indexed.status.material_count,2);
    const externalDeleted=await service.invoke('delete_sucai_library',{libraryId:external});assert.equal(externalDeleted.removed_copy_count,0);assert.deepEqual(f.originals.map(digest),originals);
  });

  test('素材库迁移保留旧文件并迁移所有权，新目录删除复制文件仍保留原始来源',async()=>{
    const f=await completedFixture(1),{service}=f,original=f.originals[0],originalHash=digest(original),oldCopy=f.materials[0].path;
    const newRoot=path.join(f.root,'new-storage');
    const moved=await service.invoke('update_sucai_storage_dir',{newBaseDir:newRoot});
    const material=moved.status.materials[0];assert.notEqual(material.path,oldCopy);assert.equal(digest(material.path),originalHash);assert.equal(digest(oldCopy),originalHash);
    const reopened=new Service({resources,dataDir:service.dataDir});
    const deleted=await reopened.invoke('delete_sucai_material',{materialId:material.id});assert.equal(deleted.removed_copy_count,1);assert.equal(fs.existsSync(material.path),false);assert.equal(digest(oldCopy),originalHash);assert.equal(digest(original),originalHash);
  });
}

module.exports={fixture,image,digest,analysis,index,sql,cleanup};
