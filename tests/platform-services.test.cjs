'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../backend/service.cjs'),{startServer}=require('../backend/server.cjs');
function fixture(t,authenticated=true){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'掌门 平台API-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let refreshes=0,models=0,charges=0;
 const account={base:'https://platform.invalid',required:true,status:()=>({configured:true,authenticated,account:{membership:{member_level:3},wallet:{available:'42'}},profile:{sub:'private-user'},token:'must-not-export'}),refresh:async()=>{refreshes++;},models:async()=>{models++;return {operations:{analyze:'chat-model',embedding:'vector-model',asr_short:'speech-model',image:'wrong-category'},items:[{model_key:'chat-model',model_category:'chat'},{model_key:'vector-model',model_category:'embedding'},{model_key:'speech-model',model_category:'speech'},{model_key:'wrong-category',model_category:'chat'}]};},invokeModel:async()=>{charges++;throw new Error('不允许收费');}};
 const service=new Service({resources:root,dataDir:path.join(root,'data'),account});return {root,service,counters:()=>({refreshes,models,charges})};
}
test('平台设置仅返回当前用户积分和可用能力，不需Key、不收费、不泄露身份或令牌',async t=>{
 const f=fixture(t),status=await f.service.invoke('get_platform_service_status',{refresh:true});
 assert.equal(status.requires_user_api_key,false);assert.equal(status.available_points,'42');assert.equal(status.billing,'current_oauth_user');assert.equal(status.operations.find(o=>o.operation==='analyze').available,true);assert.equal(status.operations.find(o=>o.operation==='image').available,false);assert.equal(status.operations.find(o=>o.operation==='asr_long').available,false);
 assert.doesNotMatch(JSON.stringify(status),/must-not-export|private-user/);assert.deepEqual(f.counters(),{refreshes:1,models:1,charges:0});
});
test('未登录不读取模型、不收费；旧版独立Service保持明确非平台状态',async t=>{
 const f=fixture(t,false);assert.equal((await f.service.platformServiceStatus()).authenticated,false);assert.deepEqual(f.counters(),{refreshes:0,models:0,charges:0});
 f.service.account=null;assert.deepEqual(await f.service.platformServiceStatus(),{platform_mode:false});
});
test('平台Agent上下文明确语音/向量已统一接入；忽略新供应商Key而保留磁盘原配置',async t=>{
 const f=fixture(t),s=f.service;s.python=()=>'/fixture/python';s.ffmpegStatus=()=>({});
 s.apiContext.third_party_apis=[{type:'doubao_speech',parameters:{KEY:'old-private-fixture'}}];
 await s.context({third_party_apis:[{type:'doubao_speech',parameters:{KEY:'new-must-not-save'}}]});
 const disk=JSON.parse(fs.readFileSync(path.join(s.dataDir,'api-context.json'))),exported=JSON.parse(fs.readFileSync(path.join(s.dataDir,'agent-context.json')));
 assert.equal(disk.third_party_apis[0].parameters.KEY,'old-private-fixture');assert.deepEqual(exported.third_party_apis,[]);assert.doesNotMatch(JSON.stringify(exported),/old-private-fixture|new-must-not-save|volcengine|volces/);
 assert.equal(exported.ai_services.doubao_speech.configured,true);assert.equal(exported.ai_services.doubao_speech.mode,'aigzm');assert.equal(exported.speech.asr.configured,true);assert.equal(exported.speech.tts.configured,false);assert.equal(exported.ai_services.requires_user_api_key,false);
});
test('Agent状态入口仍受本机凭据保护且不接受跨站访问',async t=>{
 const f=fixture(t),{server,url}=await startServer(f.service,{port:0});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 assert.equal((await fetch(url+'/ai/platform/status')).status,401);
 const headers={Authorization:'Bearer '+f.service.platformApiKey()};assert.equal((await fetch(url+'/ai/platform/status',{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
 const response=await fetch(url+'/ai/platform/status',{headers});assert.equal(response.status,200);assert.equal((await response.json()).requires_user_api_key,false);assert.equal(f.counters().charges,0);
});
