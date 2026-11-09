const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {AccountSSO,random,challenge}=require('../backend/account-sso.cjs');
const {createBroker}=require('../sso/broker.cjs');
const {MemoryStore,codec}=require('../sso/store.cjs');
const {configuration}=require('../sso/cloud.cjs');
const {Service}=require('../backend/service.cjs');
const {startServer}=require('../backend/server.cjs');
const platform=require('../backend/platform-client.cjs');

async function fixture(t,{store,policy={local_edit:0,template_apply:1,draft_export:2,ai_invoke:0}}={}){
  let member=2,currentUser='usr_a',scope='openid identity membership.read points.read points.spend billing.initiate',balance='50',calls=[],mode='success',clock=Date.now(),opened,pendingNonce,grantDenied=false,entitled=true;
  const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...keys.publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
  const identities=new Map(),refreshes=new Map();
  const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  const stateStore=store||new MemoryStore({now:()=>clock});
  const fetcher=async(url,options={})=>{
    const route=new URL(url).pathname;
    if(route==='/v1/.well-known/jwks.json')return response({keys:[jwk]});
    if(route==='/v1/oauth/token'){
      assert.equal(options.headers.Authorization,'Basic '+Buffer.from('sbx_fixture:fixture-only-secret').toString('base64'));
      const body=JSON.parse(options.body);const user=body.grant_type==='refresh_token'?refreshes.get(body.refresh_token):currentUser;
      const access='fixture-access-'+random(),refresh='fixture-refresh-'+random();identities.set(access,user);refreshes.set(refresh,user);
      const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:'https://issuer-fixture.invalid/sandbox',aud:'sbx_fixture',sub:user,nonce:pendingNonce,token_use:'id',iat:Math.floor(clock/1000),exp:Math.floor(clock/1000)+3600})).toString('base64url');
      const id_token=header+'.'+payload+'.'+crypto.sign('RSA-SHA256',Buffer.from(header+'.'+payload),keys.privateKey).toString('base64url');
      return response({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope,id_token});
    }
    const access=(options.headers?.Authorization||'').slice(7),user=identities.get(access);assert.ok(user,'所有用户接口必须携带真实 mock 用户的 OAuth token');
    if(route==='/v1/oauth/userinfo')return response({sub:user,phone_number:'13800000000',member_level:member});
    if(route==='/v1/oauth/revoke')return response({revoked:true});
    if(route==='/v1/user/membership/details')return response({member_level:member,plan:{name:'Fixture',benefits:[]},current_subscription:null,scheduled_subscription:null});
    if(route==='/v1/user/app-entitlement')return response({sub:user,access:entitled?'granted':'purchase_required',entitled});
    if(route==='/v1/user/wallet')return response({sub:user,wallet:{balance,available:balance,frozen:'3'}});
    if(route==='/v1/platform/models')return response({items:[['chat-fixture','chat'],['embedding-fixture','embedding'],['asr-fixture','speech'],['image-fixture','image']].map(([model_key,model_category])=>({model_key,model_category,display_name:model_key}))});
    if(route.startsWith('/v1/models/')){
      calls.push({route,user,authorization:options.headers.Authorization,body:JSON.parse(options.body)});
      if(mode==='insufficient')return new Response('{"error":"insufficient_balance"}',{status:402});
      if(mode==='network')throw new Error('fixture network');
      if(mode==='wait')await new Promise(resolve=>setTimeout(resolve,35));
      if(mode==='success'||mode==='wait')balance=String(Number(balance)-5);
      return response({status:mode==='unknown'?'provider_unknown':'success',request_id:'req_fixture_'+calls.length,output:{text:'完成',data:[{index:0,embedding:[.1,.2]}]}});
    }
    if(route==='/v1/user/billing-entries'){const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body).sort(),['intent','return_uri']);return response({entry_id:random(),billing_url:'https://idp-fixture.invalid/billing/opaque',expires_at:'2099-01-01'});}
    throw new Error('未允许的 mock 接口 '+route);
  };
  // Public model index is deliberately unauthenticated.
  const upstream=async(url,options)=>new URL(url).pathname==='/v1/platform/models'?response({items:[['chat-fixture','chat'],['embedding-fixture','embedding'],['asr-fixture','speech'],['image-fixture','image']].map(([model_key,model_category])=>({model_key,model_category}))}):fetcher(url,options);
  const reserved=http.createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));const base='http://127.0.0.1:'+port;
  const config={publicUrl:base,idpWebUrl:'https://idp-fixture.invalid',idpApiUrl:'https://idp-fixture.invalid',clientId:'sbx_fixture',clientSecret:'fixture-only-secret',allowLocalHttp:true,store:stateStore,fetcher:upstream,now:()=>clock,cloud:{expectedIssuer:'https://issuer-fixture.invalid/sandbox',memberPolicy:policy,models:{analyze:'chat-fixture',embedding:'embedding-fixture',asr_short:'asr-fixture',asr_long:'asr-fixture',image:'image-fixture'},billingReturnUri:base+'/billing/return'}};
  let server;
  const boot=async()=>{server=createBroker(config);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));};await boot();
  const shutdown=()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});t.after(shutdown);
  const account=new AccountSSO({brokerUrl:base,allowLocalHttp:true,openExternal:async url=>{opened=url;}});
  const signIn=async(target=account)=>{
    await target.login(17652);const first=await fetch(opened,{redirect:'manual'});assert.equal(first.status,302);const authorization=new URL(first.headers.get('location'));pendingNonce=authorization.searchParams.get('nonce');
    assert.ok(pendingNonce);assert.equal(authorization.searchParams.get('scope'),scope);
    const callback=new URL(authorization.searchParams.get('redirect_uri'));callback.searchParams.set('code',random());callback.searchParams.set('state',authorization.searchParams.get('state'));
    const second=await fetch(callback,{redirect:'manual'});assert.equal(second.status,302,await second.clone().text());await target.completeCallback(Object.fromEntries(new URL(second.headers.get('location')).searchParams));return target;
  };
  return{account,signIn,base,stateStore,calls,config,upstream,changeUser:v=>{currentUser=v;},member:v=>{member=v;},mode:v=>{mode=v;},entitled:v=>{entitled=v;},balance:()=>balance,restart:async()=>{await shutdown();await boot();},advance:ms=>{clock+=ms;}};
}
const job=()=>({task_id:crypto.randomUUID(),step_id:'analyze',operation:'analyze',input:{messages:[{role:'user',content:'整理口播'}]}});

test('平台 OAuth/OIDC、即时会员读取和用户模型积分通道（离线 mock）',async t=>{
  const f=await fixture(t);await f.signIn();const status=f.account.status();assert.equal(status.account.membership.member_level,2);assert.equal(status.account.wallet.available,'50');assert.doesNotMatch(JSON.stringify(status),/fixture-access|fixture-refresh|session_token/);
  const result=await f.account.invokeModel(job());assert.equal(result.status,'success');assert.equal(f.balance(),'45');assert.equal(f.calls[0].user,'usr_a');assert.match(f.calls[0].authorization,/^Bearer fixture-access-/);assert.equal(f.calls[0].route,'/v1/models/chat-fixture/invoke');assert.ok(f.calls[0].body.idempotency_key.startsWith('zm_'));
  assert.equal(f.account.status().account.wallet.available,'45','模型成功后刷新当前用户积分');
  assert.equal((await f.account.authorize(['template_apply','draft_export'])).allowed,true);assert.equal(f.balance(),'45');
});
test('会员降级即时拒绝本地导出；无门槛配置和撤销应用权益均拒绝，均不扣积分',async t=>{
  const f=await fixture(t);await f.signIn();f.member(0);await assert.rejects(f.account.authorize(['draft_export']),/会员等级不足/);assert.equal(f.calls.length,0);assert.equal(f.balance(),'50');
  f.entitled(false);await assert.rejects(f.account.invokeModel(job()),/使用权益/);assert.equal(f.calls.length,0);
  const g=await fixture(t,{policy:{}});await g.signIn();await assert.rejects(g.account.authorize(['draft_export']),/尚未配置/);assert.equal(g.calls.length,0);
});
test('相同任务重试只调用一次，改内容冲突；模型网关未知状态不会自动重试扣费',async t=>{
  const f=await fixture(t);await f.signIn();const request=job();await f.account.invokeModel(request);await f.account.invokeModel(request);assert.equal(f.calls.length,1);assert.equal(f.balance(),'45');await assert.rejects(f.account.invokeModel({...request,input:{messages:[]}}),/内容已改变/);
  f.mode('unknown');const unknown=job();await assert.rejects(f.account.invokeModel(unknown),/无法确认/);await assert.rejects(f.account.invokeModel(unknown),/无法确认/);assert.equal(f.calls.length,2);
});
test('并发任务重复点击、重启恢复与跨用户隔离',async t=>{
  const f=await fixture(t);await f.signIn();f.mode('wait');const body=job();const values=await Promise.allSettled([f.account.invokeModel(body),f.account.invokeModel(body)]);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
  await f.restart();assert.equal((await f.account.refresh()).authenticated,true);await f.account.invokeModel(body);assert.equal(f.calls.length,1);
  const a=new AccountSSO({brokerUrl:f.base,allowLocalHttp:true,openExternal:f.account.openExternal});f.changeUser('usr_b');await f.signIn(a);await assert.rejects(a.task(body.task_id,body.step_id),/不存在/);await a.invokeModel(body);assert.equal(f.calls.length,2);assert.equal(f.calls[1].user,'usr_b');assert.notEqual(f.calls[0].body.idempotency_key,f.calls[1].body.idempotency_key);
});
test('积分不足无开发者 Key 兜底；充值仅打开平台入口',async t=>{
  const f=await fixture(t);await f.signIn();f.mode('insufficient');const body=job();await assert.rejects(f.account.invokeModel(body),/积分不足/);assert.equal(f.calls.length,1);assert.equal(f.balance(),'50');assert.equal((await f.account.billing('recharge')).opened,true);assert.equal(f.balance(),'50');f.mode('success');await f.account.invokeModel(body);assert.equal(f.calls.length,2);assert.equal(f.calls[0].body.idempotency_key,f.calls[1].body.idempotency_key);assert.equal(f.balance(),'45');
});
test('持久化加密绑定记录，密钥或记录标识错误均不能解密',()=>{
  const c=codec(crypto.randomBytes(32)),text={token:'sensitive-fixture-only',nonce:'private'};const bytes=c.encode(text,'record-a');assert.equal(bytes.includes(text.token),false);assert.deepEqual(c.decode(bytes,'record-a'),text);assert.throws(()=>c.decode(bytes,'record-b'));assert.throws(()=>codec(crypto.randomBytes(32)).decode(bytes,'record-a'));
});
test('平台配置不接收混用环境；未知会员门槛不默认为付费等级',()=>{
  const env={DATABASE_URL:'mysql://fixture:fixture@localhost/fixture',AIGZM_PUBLIC_URL:'https://app.invalid',AIGZM_API_ORIGIN:'https://idp.invalid',AIGZM_AUTHORIZATION_UI_ORIGIN:'https://idp.invalid',AIGZM_CLIENT_ID:'sbx_fixture',AIGZM_CLIENT_SECRET:'fixture',AIGZM_EXPECTED_ISSUER:'https://issuer.invalid',AIGZM_ENVIRONMENT:'sandbox',ZHANGMEN_SESSION_KEY:crypto.randomBytes(32).toString('base64')};
  assert.deepEqual(configuration(env).cloud.memberPolicy,{local_edit:1,template_apply:1,draft_export:1,ai_invoke:0});assert.throws(()=>configuration({...env,AIGZM_ENVIRONMENT:'production'}));assert.throws(()=>configuration({...env,ZHANGMEN_MEMBER_POLICY:'{"draft_export":-1}'}));assert.throws(()=>configuration({...env,ZHANGMEN_SESSION_KEY:'invalid'}));
});
test('桌面云端模式：本地生成先校验权限、向量仅走平台、不回退旧 Key',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zm-cloud-service-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];const service=new Service({resources:root,dataDir:root,account:{base:'https://cloud.invalid',authorize:async f=>{calls.push(f);throw new Error('会员不足');},invokeModel:async body=>{calls.push(body);return{status:'success',model:'embedding-fixture',output:{data:[{index:0,embedding:[.1,.2]}]}};}}});
  await assert.rejects(service.generate({}),/会员不足/);assert.deepEqual(calls[0],['template_apply','draft_export']);
  await assert.rejects(service.invoke('delete_local_video_template',{slug:'fixture'}),/会员不足/);assert.deepEqual(calls.pop(),['template_apply']);
  const result=await service.embeddings({items:[{id:'one',text:'素材描述'}]});assert.deepEqual(result.embeddings,[{id:'one',embedding:[.1,.2]}]);assert.equal(calls[1].operation,'embedding');
  await assert.rejects(service.generateDoubaoTts({}),/不会回退/);
});
test('本机付费 API 需要独立 Agent 凭证，跨站仍拒绝',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zm-cloud-http-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let calls=0;
  const service=new Service({resources:root,dataDir:root,account:{base:'https://cloud.invalid'}});service.platformInvoke=async()=>{calls++;return{status:'success'};};
  const {server,url}=await startServer(service,{port:0});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  assert.equal((await fetch(url+'/ai/platform/invoke',{method:'POST',body:'{}'})).status,401);assert.equal(calls,0);
  assert.equal((await fetch(url+'/ai/platform/invoke',{method:'POST',headers:{Authorization:'Bearer '+service.platformApiKey(),'Content-Type':'application/json'},body:'{}'})).status,200);assert.equal(calls,1);
});
test('OIDC 拒绝伪造签名、错误 issuer/audience/nonce、过期及错误 token_use',async()=>{
  const {createIdTokenVerifier}=require('../sso/identity.cjs');const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),kid='fixture-kid',jwk={...keys.publicKey.export({format:'jwk'}),kid,alg:'RS256'};
  const now=Date.now(),base={iss:'https://issuer.invalid',aud:'client',sub:'usr_a',nonce:'nonce',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+600,token_use:'id'};
  const sign=claims=>{const a=Buffer.from(JSON.stringify({alg:'RS256',kid})).toString('base64url'),b=Buffer.from(JSON.stringify(claims)).toString('base64url');return a+'.'+b+'.'+crypto.sign('RSA-SHA256',Buffer.from(a+'.'+b),keys.privateKey).toString('base64url');};
  const verify=createIdTokenVerifier({api:'https://idp.invalid',issuer:base.iss,clientId:'client',now:()=>now,fetcher:async()=>new Response(JSON.stringify({keys:[jwk]}))});
  assert.equal((await verify(sign(base),'nonce')).sub,'usr_a');
  for(const changes of [{iss:'https://other.invalid'},{aud:'other'},{nonce:'wrong'},{exp:1},{token_use:'access'}])await assert.rejects(verify(sign({...base,...changes}),'nonce'),/身份校验失败/);
  const valid=sign(base);await assert.rejects(verify(valid.slice(0,-3)+'aaa','nonce'),/身份校验失败/);
});
test('MySQL 实库加密、跨连接并发锁、服务重启恢复与重复任务（独立容器）',{skip:!process.env.ZHANGMEN_TEST_MYSQL_FILE},async t=>{
  const mysql=require('../sso/node_modules/mysql2/promise');const {MysqlStore}=require('../sso/store.cjs');
  const config=JSON.parse(fs.readFileSync(process.env.ZHANGMEN_TEST_MYSQL_FILE)),key=crypto.randomBytes(32),namespace='test-'+crypto.randomUUID();
  const a=new MysqlStore({pool:mysql.createPool(config),key,namespace}),b=new MysqlStore({pool:mysql.createPool(config),key,namespace});t.after(()=>Promise.all([a.close(),b.close()]));await a.init();await b.init();
  await a.put('counter','one',0,Date.now()+60000);await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).atomic('counter','one',value=>({value:value+1}))));assert.equal(await b.get('counter','one'),20);
  const f=await fixture(t,{store:a});await f.signIn();const body=job();await f.account.invokeModel(body);assert.equal(f.calls.length,1);f.config.store=b;await f.restart();await f.account.refresh();assert.equal(f.account.status().authenticated,true);await f.account.invokeModel(body);assert.equal(f.calls.length,1);
  const [rows]=await b.pool.execute('SELECT payload FROM zhangmen_state WHERE payload IS NOT NULL');assert.ok(rows.length>0);for(const row of rows){assert.equal(row.payload.includes('fixture-access-'),false);assert.equal(row.payload.includes('整理口播'),false);}
});
test('平台语音桥接实际 FFmpeg 提取与 SRT 时间戳（模型响应模拟）',{skip:!process.env.XYCUT_RESOURCES},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zm-platform-asr-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {run,read}=require('../backend/util.cjs');let sent;
  const service=new Service({resources:process.env.XYCUT_RESOURCES,dataDir:root,account:{base:'https://cloud.invalid',invokeModel:async body=>{sent=body;return{status:'success',request_id:'req_asr_fixture',model:'asr-fixture',output:{duration:2,segments:[{start:0,end:1,text:'第一句'},{start:1,end:2,text:'第二句'}]}};}}});
  const source=path.join(root,'input.mp4');await run(service.tool('ffmpeg'),['-v','error','-y','-f','lavfi','-i','color=c=blue:s=64x64:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac','-shortest',source]);
  const result=await service.transcribeDoubaoAsr({input_media:source,task_dir:root});assert.equal(sent.operation,'asr_short');assert.ok(Buffer.from(sent.input.audio,'base64').length>0);assert.equal(result.segment_count,2);assert.match(fs.readFileSync(result.srt_file,'utf8'),/00:00:01,000 --> 00:00:02,000/);assert.equal(read(result.segments_json).segments[1].timing_source,'provider_segment');
  let called=false;service.account.invokeModel=async()=>{called=true;};await assert.rejects(service.transcribeDoubaoAsr({input_media:source,output_json:'/not-authorized/output.json',output_srt:path.join(root,'x.srt'),output_segments_json:path.join(root,'x.json')}),/未登记/);assert.equal(called,false);
  await assert.rejects(service.transcribeDoubaoAsr({input_media:source,output_json:path.join(root,'same.json'),output_srt:path.join(root,'x.srt'),output_segments_json:path.join(root,'same.json')}),/不能重复/);assert.equal(called,false);
});
test('既有 Agent 向量与 ASR CLI 使用本机平台通道，不读取旧供应商 Key',{skip:!process.env.XYCUT_RESOURCES},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zm-platform-agent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {run}=require('../backend/util.cjs'),received=[];
  const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-local-capability');let body='';for await(const part of req)body+=part;received.push({path:req.url,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/embedding'?{embeddings:[{id:'one',embedding:[.2,.3]}]}:{provider:'aigzm',segment_count:2,srt_file:'fixture.srt'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,credential=path.join(root,'local.key');fs.writeFileSync(credential,'fixture-local-capability',{mode:0o600});
  const context=path.join(root,'context.json');fs.writeFileSync(context,JSON.stringify({platform:{provider:'aigzm'},local_api:{base_url:base,authorization_file:credential,sucai_embeddings_url:base+'/embedding',platform_asr_url:base+'/asr'},third_party_apis:[]}));
  const items=path.join(root,'items.json');fs.writeFileSync(items,JSON.stringify([{id:'one',text:'fixture'}]));
  const python=path.join(process.env.XYCUT_RESOURCES,'python/bin/python3.9'),scripts=path.resolve(__dirname,'../backend/agent-overrides/xycut-video-template-skill/scripts'),env={PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:path.join(process.env.XYCUT_RESOURCES,'agent-kit/skills/xycut-video-template-skill/scripts'),HTTP_PROXY:'http://invalid-proxy.invalid:65500'};
  const value=JSON.parse(await run(python,[path.join(scripts,'generate_query_embeddings.py'),'--agent-context-file',context,'--items-file',items,'--output',path.join(root,'embedding.json')],undefined,{env}));assert.equal(value.ok,true);assert.deepEqual(received[0].body.items,[{id:'one',text:'fixture'}]);
  const speech=JSON.parse(await run(python,[path.join(scripts,'transcribe_volcengine_asr.py'),'--agent-context-file',context,'--input-media',path.join(root,'input.mp4'),'--output-json',path.join(root,'asr.json'),'--output-srt',path.join(root,'voice.srt')],undefined,{env}));assert.equal(speech.provider,'aigzm');assert.equal(received[1].path,'/asr');
});

test('已确认门槛：L0 可调用 AI，L1 才能使用本地功能（模型与积分模拟）',async t=>{
 const f=await fixture(t,{policy:{local_edit:1,template_apply:1,draft_export:1,ai_invoke:0}});await f.signIn();f.member(0);
 await assert.rejects(f.account.authorize(['local_edit','template_apply','draft_export']),/会员等级不足/);
 assert.equal((await f.account.invokeModel(job())).status,'success');assert.equal(f.calls.length,1);
 f.member(1);assert.equal((await f.account.authorize(['local_edit','template_apply','draft_export'])).allowed,true);assert.equal(f.calls.length,1);
});
