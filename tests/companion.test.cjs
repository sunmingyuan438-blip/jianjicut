'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Service}=require('../backend/service.cjs'),{startServer}=require('../backend/server.cjs');
const ORIGIN='https://zhangmencut.app.aigzm.com';
test('首次启动没有会话文件时不访问系统钥匙串',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'zm-fresh-account-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));let calls=0;
  const store=require('../desktop/account-store.cjs').createAccountStore({dataDir,safeStorage:{isEncryptionAvailable(){calls++;throw new Error('must not access Keychain');}}});
  assert.equal(await store.load(),null);assert.equal(calls,0);
});
async function fixture(t,{approve=true,ttl=8*3600000,now=Date.now}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'掌门助手 空格-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const service=new Service({resources:root,dataDir:path.join(root,'data')});let confirmations=0,invocations=0;
  service.invoke=async(name,args)=>{invocations++;if(name==='fixture')return {name,args,cover_path:path.join(root,'中文 图片.png')};throw new Error('fixture rejected');};
  const image=path.join(root,'中文 图片.png');fs.writeFileSync(image,Buffer.from([1,2,3]));
  const local=await startServer(service,{port:0,companion:{origins:[ORIGIN],ttl,now,confirmConnection:async()=>{confirmations++;return approve;}}});
  t.after(()=>new Promise(resolve=>{local.server.close(resolve);local.server.closeAllConnections();}));
  const request=(route,{origin=ORIGIN,token,body,method=body?'POST':'GET',headers={}}={})=>fetch(local.url+route,{method,headers:{...(origin?{Origin:origin}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  const connect=async()=>{const response=await request('/companion/connect',{body:{client_nonce:crypto.randomBytes(32).toString('base64url')}});return {response,data:await response.json()};};
  return {root,service,...local,request,connect,confirmations:()=>confirmations,invocations:()=>invocations};
}
test('助手先原生确认，拒绝任意Origin/缺少凭证/Host重绑定；只许可回环接口',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/companion/status',{origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.request('/companion/status',{origin:null})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const request=require('node:http').get(f.url+'/companion/status',{headers:{Origin:ORIGIN,Host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(rebound,403);
  const preflight=await f.request('/companion/invoke',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(preflight.headers.get('access-control-allow-private-network'),'true');
  assert.equal((await f.request('/companion/invoke',{body:{name:'fixture',args:{}}})).status,401);assert.equal(f.invocations(),0);
  const {data,response}=await f.connect();assert.equal(response.status,200);assert.match(data.token,/^[\w-]{43}$/);assert.equal(f.confirmations(),1);
  const wrong=await f.request('/companion/invoke',{origin:'https://evil.invalid',token:data.token,body:{name:'fixture',args:{}}});assert.equal(wrong.status,403);assert.equal(f.invocations(),0);
  const result=await f.request('/companion/invoke',{token:data.token,body:{name:'fixture',args:{text:'中文 空格'}}});assert.equal(result.status,200);assert.equal((await result.json()).result.args.text,'中文 空格');
  assert.equal((await f.request('/health',{origin:ORIGIN})).status,403);
});
test('拒绝配对不会签发会话；已有会话过期或断开立即失效',async t=>{
  const denied=await fixture(t,{approve:false});const d=await denied.connect();assert.equal(d.response.status,403);assert.equal(d.data.token,undefined);
  let time=1000;const f=await fixture(t,{ttl:100,now:()=>time});const {data}=await f.connect();time+=101;
  assert.equal((await f.request('/companion/invoke',{token:data.token,body:{name:'fixture',args:{}}})).status,401);
  const next=(await f.connect()).data;
  assert.equal((await f.request('/companion/disconnect',{token:next.token,body:{}})).status,200);
  assert.equal((await f.request('/companion/invoke',{token:next.token,body:{name:'fixture',args:{}}})).status,401);
});
test('媒体只签发响应中已授权文件的短期单文件票据，支持Range；不暴露会话或路径',async t=>{
  const f=await fixture(t),{data}=await f.connect();
  const result=await (await f.request('/companion/invoke',{token:data.token,body:{name:'fixture',args:{}}})).json();
  const ticket=result.assets[path.join(f.root,'中文 图片.png')];assert.ok(ticket);assert.equal(ticket.includes(data.token),false);assert.equal(ticket.includes(f.root),false);
  const image=await f.request(ticket,{origin:null,headers:{Range:'bytes=1-2'}});assert.equal(image.status,206);assert.deepEqual([...new Uint8Array(await image.arrayBuffer())],[2,3]);
  assert.equal((await f.request('/companion/media?ticket=missing',{origin:null})).status,403);
  await f.request('/companion/disconnect',{token:data.token,body:{}});
  assert.equal((await f.request(ticket,{origin:null})).status,403);
});
test('浏览器拖入文件只写助手独立导入目录，拒绝穿越与可执行文件；HTTP桥不接受任意URL或私密文件',async t=>{
  const f=await fixture(t),{data}=await f.connect();
  const headers={Origin:ORIGIN,Authorization:'Bearer '+data.token};
  const upload=await fetch(f.url+'/companion/upload?name='+encodeURIComponent('中文 视频.mp4'),{method:'POST',headers,body:Buffer.from('synthetic-video')});
  assert.equal(upload.status,200);const item=await upload.json();assert.equal(fs.readFileSync(item.path,'utf8'),'synthetic-video');assert.ok(item.path.startsWith(path.join(f.service.dataDir,'browser-imports')));
  for(const name of ['../secret.mp4','x.exe'])assert.equal((await fetch(f.url+'/companion/upload?name='+encodeURIComponent(name),{method:'POST',headers,body:'x'})).status,400);
  for(const p of ['https://evil.invalid/','/ai-editing/file?path=/etc/passwd','/ai/platform/invoke'])assert.equal((await f.request('/companion/http',{token:data.token,body:{path:p,method:'GET'}})).status,403);
});
test('已配对网页可走平台AI接口，但本机Agent凭证只在助手内部使用',async t=>{
  const f=await fixture(t);f.service.account={base:'https://fixture.invalid'};let calls=0;
  f.service.platformInvoke=async()=>{calls++;return{status:'success',request_id:'fixture-request',output:{text:'fixture'}};};
  const input={path:'/ai/platform/invoke',method:'POST',body:{operation:'analyze'}};
  assert.equal((await f.request('/companion/http',{body:input})).status,401);assert.equal(calls,0);
  const {data}=await f.connect(),response=await f.request('/companion/http',{token:data.token,body:input});
  const result=await response.json();assert.equal(result.status,200);assert.equal(result.result.status,'success');assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes(f.service.platformApiKey()),false);
});
