const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Service}=require('../backend/service.cjs');
const {run,read}=require('../backend/util.cjs');
const resources=path.resolve(process.env.XYCUT_RESOURCES||path.join(__dirname,'../resources'));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xycut-embedding-'));t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^xycut-embedding-/);fs.rmSync(root,{recursive:true,force:true});});return new Service({resources,dataDir:path.join(root,'data')});}
async function material(t){const service=fixture(t),library=await service.invoke('create_sucai_library',{name:'异步索引验收'}),source=path.join(service.dataDir,'source');fs.mkdirSync(source);fs.copyFileSync(path.join(resources,'frontend/icon.png'),path.join(source,'fixture.png'));const indexed=await service.invoke('index_sucai_classified_directory',{libraryId:library.library_id,libraryName:'异步索引验收',rootPath:source});const item=indexed.status.materials[0];await service.invoke('update_sucai_material',{materialId:item.id,summary:'当前描述',keywords:['fixture'],qualityScore:0.9});return{service,id:item.id,libraryId:library.library_id};}

test('Agent 用户 KEY 模式优先于客户端令牌，实际 Python 配置保留模型、接口和别名',async t=>{
  const service=fixture(t);let request;
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('离线用例禁止请求在线服务');});
  await service.context({auth_token:'synthetic-client-token',third_party_apis:[{type:'doubao_llm',parameters:[{key:'APIKEY',value:'fixture-key'},{key:'MODEL',value:'fixture-model'},{key:'BASE_URL',value:'https://fixture.invalid/embeddings'}]}]});
  t.mock.method(service,'worker',async value=>{request=value;return{provider:'fixture',model:'fixture-model',items:[]};});
  await service.embeddings({items:[]});assert.equal(request.op,'embeddings');assert.equal(request.context.ai_services.doubao_llm.mode,'user_key');
  const program='import json,sys; from pathlib import Path; r=json.load(sys.stdin); sys.path.insert(0,str(Path(r["resources"])/"agent-kit/skills/xycut-video-template-skill/scripts")); import generate_query_embeddings as e; print(json.dumps(e.doubao_llm_config(r["context"])))';
  const config=JSON.parse(await run(service.python(),['-c',program],{resources,context:request.context}));
  assert.deepEqual(config,{api_key:'fixture-key',model:'fixture-model',endpoint:'https://fixture.invalid/embeddings'});
  assert.equal(read(path.join(service.dataDir,'api-context.json')).third_party_apis[0].parameters[0].key,'APIKEY');
});

test('无用户 KEY 的客户端模式保留原在线向量协议和返回结果',async t=>{
  const service=fixture(t),requests=[];await service.context({auth_token:'synthetic-client-token',api_base_urls:['https://fixture.invalid'],third_party_apis:[]});
  const payload={provider:'fixture',model:'fixture-model',credit_cost:0,embeddings:[{id:'fixture',embedding:[.1,.2]}]};
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(payload));});
  assert.deepEqual(await service.embeddings({purpose:'query',items:[{id:'fixture',text:'测试'}]}),payload);
  assert.equal(requests[0].url,'https://fixture.invalid/api/sucai/embeddings');assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic-client-token');assert.equal(JSON.parse(requests[0].options.body).purpose,'query');
});

test('构建索引保留请求时描述散列，修改描述后的旧向量不能回写',async t=>{
  const {service,id,libraryId}=await material(t);
  t.mock.method(service,'embeddings',async body=>{await service.invoke('update_sucai_material',{materialId:id,summary:'已经更新的描述',keywords:['fixture'],qualityScore:0.9});return{provider:'fixture',model:'fixture-model',embeddings:body.items.map(item=>({id:item.id,embedding:[.1,.2]}))};});
  await assert.rejects(service.buildEmbeddings({library_id:libraryId}),/描述|失效|更新|过期|hash/);
  const status=await service.invoke('get_sucai_db_status');assert.equal(status.embedding_count,0);assert.equal(status.materials[0].summary,'已经更新的描述');assert.equal(status.materials[0].embedding_status,'pending');
});

test('索引请求与保存数量真实，重复更新不再请求已完成素材',async t=>{
  const {service,libraryId}=await material(t);let calls=0;
  t.mock.method(service,'embeddings',async body=>{calls++;return{provider:'fixture',model:'fixture-model',embeddings:body.items.map(item=>({id:item.id,embedding:[.1,.2]}))};});
  const result=await service.buildEmbeddings({library_id:libraryId});assert.equal(result.requested_count,1);assert.equal(result.saved_count,1);assert.equal(result.built_count,1);assert.equal(result.status.embedding_count,1);
  assert.deepEqual(await service.buildEmbeddings({library_id:libraryId}),{ok:true,requested_count:0,saved_count:0,built_count:0});assert.equal(calls,1);
});

test('服务返回重复或无关素材时拒绝整批，数据库不产生虚假成功',async t=>{
  const {service,id,libraryId}=await material(t);let payload;
  t.mock.method(service,'embeddings',async()=>({provider:'fixture',model:'fixture-model',embeddings:payload}));
  for(const values of [[{id,embedding:[.1]},{id,embedding:[.2]}],[{id:'unrequested-id',embedding:[.1]}],'invalid-list']){payload=values;await assert.rejects(service.buildEmbeddings({library_id:libraryId}),/重复|本次索引|列表/);assert.equal((await service.invoke('get_sucai_db_status')).embedding_count,0);}
});
