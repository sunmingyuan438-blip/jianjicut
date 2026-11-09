const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {AccountError, trustedBase, random, challenge, equal} = require('../backend/account-sso.cjs');
const {MemoryStore} = require('./store.cjs');
const {createIdTokenVerifier} = require('./identity.cjs');
const fail = (message, status = 400, code = 'invalid_request') => Object.assign(new AccountError(message, status), {code});
const json = (response, status, value) => { response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(value)); };
const level = value => Number.isInteger(value) && value >= 0 && value <= 4;
async function readBody(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > limit) throw fail('请求过大', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw fail('请求格式无效'); }
}
function stable(value, depth = 0) {
  if (depth > 64) throw fail('请求嵌套过深');
  if (Array.isArray(value)) return value.map(v => stable(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], depth + 1)]));
  return value;
}
function createBroker({publicUrl, idpWebUrl, idpApiUrl, clientId, clientSecret, returnUris = ['http://127.0.0.1:17652/account/sso/callback'], allowLocalHttp = false, fetcher = fetch, now = Date.now, sessionTtl = 8 * 3600000, store = new MemoryStore({now}), cloud = null, ready = () => true, webHost = null}) {
  const base = trustedBase(publicUrl, allowLocalHttp), web = trustedBase(idpWebUrl, allowLocalHttp), api = trustedBase(idpApiUrl, allowLocalHttp);
  if (typeof clientId !== 'string' || !clientId || clientId.length > 64 || typeof clientSecret !== 'string' || !clientSecret || /[:\r\n]/.test(clientId)) throw new Error('缺少有效的服务端 OAuth 客户端配置');
  if (cloud && !cloud.expectedIssuer) throw new Error('平台模式须配置明确的 OAuth issuer');
  const returns = new Set(returnUris.map(value => { const url = new URL(value); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/account/sso/callback' || url.search || url.hash || url.username || url.password) throw new Error('桌面回调必须是显式许可的 IPv4 回环地址'); return url.href; }));
  const callback = base + '/auth/callback', namespace = challenge((cloud?.expectedIssuer || api) + ':' + clientId);
  const ns = name => namespace + ':' + name;
  const verifyIdToken = cloud ? createIdTokenVerifier({api, issuer: cloud.expectedIssuer, clientId, fetcher, now}) : null;
  let catalogue, catalogueExpires = 0;
  let starts=0,startWindow=now();
  async function upstream(route, {data, accessToken, publicRequest = false, timeout = 15000} = {}) {
    let response;
    try {
      response = await fetcher(api + route, {method: data ? 'POST' : 'GET', redirect: 'error', headers: {...(data ? {'Content-Type': 'application/json'} : {}), ...(!publicRequest ? {Authorization: accessToken ? 'Bearer ' + accessToken : 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')} : {})}, ...(data ? {body: JSON.stringify(data)} : {}), signal: AbortSignal.timeout(timeout)});
    } catch { throw fail('AI 超市服务暂时无法连接', 503, 'upstream_unavailable'); }
    let result; try { result = await response.json(); } catch { throw fail('AI 超市响应格式无效', 502, 'invalid_upstream_response'); }
    if (!response.ok) {
      const code = typeof result.error === 'string' ? result.error : '';
      if (code === 'invalid_grant' || code === 'invalid_token' || response.status === 401) throw fail('授权已失效，请重新登录', 401, 'login_required');
      const known = {402:['用户积分不足，请到 AI 超市充值','insufficient_balance'],403:['当前授权或会员权限不足','permission_denied'],409:['请求处理中或幂等参数冲突，请查看原任务','in_progress'],429:['请求过于频繁，请稍后重试','rate_limited']};
      const [message, mapped] = known[response.status] || ['AI 超市服务暂时不可用','upstream_unavailable'];
      throw fail(message, response.status >= 500 ? 503 : response.status, code === 'idempotency_key_conflict' ? code : mapped);
    }
    return result;
  }
  function setTokens(session, result) {
    if (typeof result.access_token !== 'string' || !result.access_token || result.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || typeof result.refresh_token !== 'string' || !result.refresh_token) throw fail('AI 超市授权响应无效', 502);
    if (cloud && !['identity','membership.read','points.read','points.spend'].every(scope => String(result.scope || '').split(' ').includes(scope))) throw fail('授权范围不完整，请重新授权', 403);
    session.access = result.access_token; session.refresh = result.refresh_token; session.accessExpires = now() + result.expires_in * 1000;
  }
  async function profile(session) {
    const value = await upstream('/v1/oauth/userinfo', {accessToken: session.access});
    if (typeof value.sub !== 'string' || !/^[\w-]{1,128}$/.test(value.sub) || (session.sub && session.sub !== value.sub)) throw fail('AI 超市用户资料无效', 502);
    return {sub: value.sub, phone_number: value.phone_number, member_level: value.member_level};
  }
  async function sessionFor(token) {
    if (!/^[\w-]{43}$/.test(token || '')) throw fail('请先登录 AI 超市账户', 401, 'login_required');
    const result = await store.atomic(ns('session'), challenge(token), async session => {
      if (!session) throw fail('登录已失效，请重新登录', 401, 'login_required');
      try {
        if (session.accessExpires <= now() + 10000) setTokens(session, await upstream('/v1/oauth/token', {data: {grant_type:'refresh_token',refresh_token:session.refresh,client_id:clientId}}));
        return {value:session, expires:session.expires, result:{session}};
      } catch (error) { if (error.status === 401) return {value:null,result:{error}}; throw error; }
    });
    if (result.error) throw result.error; return result.session;
  }
  async function membership(session) {
    const [details, entitlement] = await Promise.all([upstream('/v1/user/membership/details',{accessToken:session.access}),upstream('/v1/user/app-entitlement',{accessToken:session.access})]);
    if (!level(details.member_level)) throw fail('会员状态返回无效',502);
    if (entitlement.access !== 'granted') throw fail('请先在 AI 超市取得此应用的使用权益',403,'app_access_required');
    return details;
  }
  async function authorize(session, features) {
    if (!cloud || !Array.isArray(features) || !features.length || features.length > 8 || features.some(f => !['template_apply','draft_export','local_edit','ai_invoke'].includes(f))) throw fail('功能权限参数无效');
    if (features.some(f => !level(cloud.memberPolicy?.[f]))) throw fail('该功能的会员门槛尚未配置',403,'policy_unconfigured');
    const details = await membership(session);
    if (features.some(f => details.member_level < cloud.memberPolicy[f])) throw fail('当前会员等级不足，请到 AI 超市升级',403,'membership_required');
    return {allowed:true,member_level:details.member_level,features};
  }
  async function modelCatalogue() {
    if (!catalogue || catalogueExpires <= now()) {
      const value = await upstream('/v1/platform/models',{publicRequest:true});
      if (!Array.isArray(value.items)) throw fail('模型目录暂不可用',503);
      catalogue = value.items.map(m=>({model_key:m.model_key,display_name:m.display_name,model_category:m.model_category})); catalogueExpires=now()+300000;
    }
    return catalogue;
  }
  async function invoke(session, body) {
    if (!/^[\da-f-]{36}$/i.test(body.task_id || '') || !/^[\w-]{1,64}$/.test(body.step_id || '') || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw fail('缺少有效的任务、步骤或模型输入');
    const categories={analyze:'chat',embedding:'embedding',asr_short:'speech',asr_long:'speech',image:'image'}, operation=body.operation;
    if (!Object.hasOwn(categories,operation)) throw fail('不支持的 AI 操作');
    const model = cloud?.models?.[operation], found=(await modelCatalogue()).find(m=>m.model_key===model);
    if (!found || found.model_category!==categories[operation]) throw fail('该功能尚未配置可用的平台模型',503,'model_not_configured');
    await authorize(session,['ai_invoke']);
    const owner=challenge(namespace+':'+session.sub), taskKey=challenge(owner+':'+body.task_id+':'+body.step_id);
    const hash=challenge(JSON.stringify(stable({operation,input:body.input,model}))), idempotencyKey='zm_'+taskKey;
    const claim=await store.atomic(ns('task'),taskKey,old=>{
      if(old){
        if(old.hash!==hash)throw fail('同一任务步骤的内容已改变，请创建新步骤',409,'idempotency_key_conflict');
        if(old.status!=='retryable'){
          if(old.status==='running'&&now()-old.created_at>1200000){old.status='provider_unknown';old.message='原任务执行中断，结果待核对；不会自动再次调用';return{value:old,result:{old}};}
          return{result:{old}};
        }
      }
      const value={hash,operation,model,task_id:body.task_id,step_id:body.step_id,status:'running',created_at:now(),idempotency_key:idempotencyKey};
      return{value,expires:now()+30*86400000,result:{created:value}};
    });
    if(claim.old){if(claim.old.status==='running')throw fail('原任务仍在处理，请查询原任务',409,'in_progress');return{...claim.old,cached:true};}
    const record=claim.created;
    try {
      const timeout=operation==='image'?960000:operation.startsWith('asr_')?300000:120000;
      const result=await upstream('/v1/models/'+encodeURIComponent(model)+'/invoke',{data:{input:body.input,idempotency_key:idempotencyKey},accessToken:session.access,timeout});
      if(!['success','failed','provider_unknown'].includes(result.status)||typeof result.request_id!=='string')throw fail('模型结果不完整，请保留原任务待核对',502,'invalid_upstream_response');
      record.status=result.status;record.request_id=result.request_id;
      if(result.status==='success')record.output=result.output;
      else record.message=result.status==='provider_unknown'?'平台暂时无法确认结果，请保留任务等待核对':'模型调用失败，请查看平台记录';
    } catch(error) {
      record.status=[402,403,429].includes(error.status)||(error.status===409&&error.code==='in_progress')?'retryable':[400,409,413,422].includes(error.status)?'failed':'provider_unknown';
      record.code=error.code;record.message=error.message;
      // Never invent a successful result or silently retry another model/key.
    }
    await store.put(ns('task'),taskKey,record,now()+30*86400000);
    return record;
  }
  async function revoke(session) { try { await upstream('/v1/oauth/revoke',{data:{},accessToken:session.access}); return true; } catch { return false; } }
  const server=http.createServer(async(request,response)=>{
    for(const [name,value] of Object.entries({'Cache-Control':'no-store',Pragma:'no-cache','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}))response.setHeader(name,value);
    try {
      const url=new URL(request.url,base),route=url.pathname;
      if(webHost&&webHost(request,response))return;
      if(request.headers.origin)throw fail('不接受网页跨域请求',403);
      if((route==='/'||route==='/health')&&request.method==='GET'){json(response,route==='/health'&&!ready()?503:200,{ok:true,ready:ready(),service:'zhangmen-cut',session_store:store.kind,cloud:!!cloud});return;}
      if(!ready())throw fail('服务正在准备，请稍后重试',503,'initializing');
      if(route==='/auth/start'&&request.method==='POST'){
        if(now()-startWindow>=60000){starts=0;startWindow=now();}if(++starts>120)throw fail('登录请求过于频繁，请稍后重试',429,'rate_limited');
        const body=await readBody(request);if(!returns.has(body.return_uri)||!/^[\w-]{43}$/.test(body.code_challenge||'')||!/^[\w-]{43}$/.test(body.state||''))throw fail('登录参数无效');
        const id=random(),flow={desktopState:body.state,desktopChallenge:body.code_challenge,returnUri:body.return_uri,expires:now()+300000,verifier:random(),oauthState:random(),nonce:random(),opened:false};
        await store.put(ns('flow'),id,flow,flow.expires);await store.put(ns('state'),flow.oauthState,id,flow.expires);
        json(response,200,{login_url:base+'/auth/login/'+id});return;
      }
      if(route.startsWith('/auth/login/')&&request.method==='GET'){
        const flow=await store.atomic(ns('flow'),route.slice(12),value=>{if(!value)throw fail('登录链接已失效');value.opened=true;return{value,expires:value.expires,result:value};});
        const target=new URL(web+'/oauth/authorize'),params={response_type:'code',client_id:clientId,redirect_uri:callback,scope:cloud?'openid identity membership.read points.read points.spend billing.initiate':'identity membership.read',code_challenge:challenge(flow.verifier),code_challenge_method:'S256',state:flow.oauthState};if(cloud)params.nonce=flow.nonce;
        target.search=new URLSearchParams(params).toString();response.writeHead(302,{Location:target.href});response.end();return;
      }
      if(route==='/auth/callback'&&request.method==='GET'){
        const state=url.searchParams.get('state');if(!/^[\w-]{43}$/.test(state||''))throw fail('OAuth 回调校验失败或已过期');
        const id=await store.take(ns('state'),state),flow=id&&await store.take(ns('flow'),id);
        if(!flow?.opened||!equal(flow.oauthState,state))throw fail('OAuth 回调校验失败或已过期');
        const target=new URL(flow.returnUri);target.searchParams.set('state',flow.desktopState);
        if(url.searchParams.has('error'))target.searchParams.set('error','login_cancelled');
        else {
          const code=url.searchParams.get('code');if(!code||code.length>2048)throw fail('OAuth 回调缺少授权码');
          const session={expires:now()+sessionTtl};const result=await upstream('/v1/oauth/token',{data:{grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:callback,client_id:clientId}});setTokens(session,result);
          try {const claims=verifyIdToken?await verifyIdToken(result.id_token,flow.nonce):null;session.profile=await profile(session);session.sub=session.profile.sub;if(claims&&claims.sub!==session.sub)throw fail('登录主体不一致',401);}
          catch(error){await revoke(session);throw error;}
          const exchangeCode=random();await store.put(ns('code'),challenge(exchangeCode),{session,desktopChallenge:flow.desktopChallenge},now()+60000);target.searchParams.set('code',exchangeCode);
        }
        response.writeHead(302,{Location:target.href});response.end();return;
      }
      if(route==='/auth/exchange'&&request.method==='POST'){
        const body=await readBody(request),entry=await store.atomic(ns('code'),challenge(String(body.code||'')),entry=>{if(!entry||!/^[\w.~-]{43,128}$/.test(body.code_verifier||'')||!equal(entry.desktopChallenge,challenge(body.code_verifier)))throw fail('登录授权码无效或已过期',401);return{value:null,result:entry};});
        const token=random();await store.put(ns('session'),challenge(token),entry.session,entry.session.expires);json(response,200,{session_token:token,profile:entry.session.profile,cloud:!!cloud});return;
      }
      const authenticated=route==='/auth/session'||route==='/auth/logout'||(cloud&&(route.startsWith('/account/')||route.startsWith('/ai/')));
      if(authenticated){
        const token=/^Bearer ([\w-]{43})$/.exec(request.headers.authorization||'')?.[1];
        if(route==='/auth/logout'&&request.method==='POST'){const session=token&&await store.take(ns('session'),challenge(token));if(!session)throw fail('登录已失效',401);json(response,200,{revoked:await revoke(session)});return;}
        const session=await sessionFor(token);
        if(route==='/auth/session'&&request.method==='GET'){json(response,200,{profile:await profile(session),cloud:!!cloud});return;}
        if(route==='/account/status'&&request.method==='GET'){const [details,wallet]=await Promise.all([membership(session),upstream('/v1/user/wallet',{accessToken:session.access})]);json(response,200,{membership:details,wallet:wallet.wallet,policy:cloud.memberPolicy||{}});return;}
        if(route==='/account/authorize'&&request.method==='POST'){json(response,200,await authorize(session,(await readBody(request)).features));return;}
        if(route==='/account/billing'&&request.method==='POST'){const body=await readBody(request);if(!['membership','recharge'].includes(body.intent)||!cloud.billingReturnUri)throw fail('充值或会员入口尚未配置');json(response,200,await upstream('/v1/user/billing-entries',{data:{intent:body.intent,return_uri:cloud.billingReturnUri},accessToken:session.access}));return;}
        if(route==='/ai/models'&&request.method==='GET'){json(response,200,{items:await modelCatalogue(),operations:cloud.models||{}});return;}
        if(route==='/ai/invoke'&&request.method==='POST'){json(response,200,await invoke(session,await readBody(request,6000000)));return;}
        if(route==='/ai/task'&&request.method==='GET'){const task=url.searchParams.get('task_id'),step=url.searchParams.get('step_id');if(!/^[\da-f-]{36}$/i.test(task||'')||!/^[\w-]{1,64}$/.test(step||''))throw fail('任务参数无效');const owner=challenge(namespace+':'+session.sub),record=await store.atomic(ns('task'),challenge(owner+':'+task+':'+step),old=>{if(old?.status==='running'&&now()-old.created_at>1200000){old.status='provider_unknown';old.message='原任务执行中断，结果待核对；不会自动再次调用';return{value:old,result:old};}return{result:old};});if(!record)throw fail('任务不存在',404);json(response,200,record);return;}
      }
      throw fail('接口不存在',404);
    }catch(error){json(response,error.status||500,{code:error.code||'internal_error',message:error instanceof AccountError?error.message:'账户服务内部错误'});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  return server;
}
if(require.main===module){try{const file=process.env.ZHANGMEN_SSO_CONFIG;if(!file)throw new Error();const stat=fs.lstatSync(file);if(!stat.isFile()||(process.platform!=='win32'&&((stat.mode&0o077)||stat.uid!==process.getuid())))throw new Error();const config=JSON.parse(fs.readFileSync(file,'utf8'));createBroker(config).listen(config.listenPort||17653,'127.0.0.1',()=>console.log('本机账户测试服务已启动'));}catch{console.error('账户服务未启动：请检查配置文件路径、权限和客户端配置；不输出配置内容。');process.exitCode=1;}}
module.exports={createBroker,stable};
