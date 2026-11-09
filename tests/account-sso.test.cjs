const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {AccountSSO, trustedBase, random, challenge, equal} = require('../backend/account-sso.cjs');
const {createAccountStore} = require('../desktop/account-store.cjs');
const {createBroker} = require('../sso/broker.cjs');
const {Service} = require('../backend/service.cjs');
const {startServer} = require('../backend/server.cjs');

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function memoryStore() {
  let saved;
  return {available: () => true, load: async () => saved, save: async value => { saved = value; return true; }, clear: async () => { saved = null; }};
}
async function fixture(t) {
  let clock = Date.now(), tokenCount = 0, refreshCount = 0, revoked = 0, rejectRefresh = false, outage = false, deferRefresh;
  const requests = [], authorizationCodes = new Map(), issued = new Map();
  const idp = await listen(t, http.createServer(async (req, res) => {
    requests.push({route: req.url, authorization: req.headers.authorization});
    res.setHeader('Content-Type', 'application/json');
    if (outage) { res.writeHead(503); res.end('{}'); return; }
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/oauth/authorize') {
      const url = new URL(req.url, 'http://localhost');
      assert.equal(url.searchParams.get('scope'), 'identity membership.read');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('client_id'), 'local-client');
      const code = random(); authorizationCodes.set(code, {challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri')});
      const target = new URL(url.searchParams.get('redirect_uri')); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, {Location: target.href}); res.end(); return;
    }
    if (route === '/v1/oauth/token') {
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('local-client:fixture-secret-not-real').toString('base64'));
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body); assert.equal(value.client_id, 'local-client');
      if (value.grant_type === 'authorization_code') {
        const source = authorizationCodes.get(value.code); authorizationCodes.delete(value.code);
        assert.ok(source); assert.equal(challenge(value.code_verifier), source.challenge); assert.equal(value.redirect_uri, source.redirect);
      } else {
        assert.equal(value.grant_type, 'refresh_token'); refreshCount++;
        if (deferRefresh) await deferRefresh;
        if (rejectRefresh) { res.writeHead(400); res.end('{"error":"invalid_grant"}'); return; }
      }
      const n = ++tokenCount, access = 'fixture-access-' + n; issued.set(access, true);
      res.end(JSON.stringify({access_token: access, refresh_token: 'fixture-refresh-' + n, token_type: 'Bearer', expires_in: 30})); return;
    }
    if (route === '/v1/oauth/userinfo') {
      assert.ok(issued.has((req.headers.authorization || '').slice(7)));
      res.end(JSON.stringify({sub: 'usr_fixture', phone_number: '13800000000', member_level: 'standard'})); return;
    }
    if (route === '/v1/oauth/revoke') { revoked++; res.end('{"revoked":true}'); return; }
    res.writeHead(404); res.end('{}');
  }));
  // Reserve an ephemeral broker port before creating its validated public URL.
  const reserved = http.createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  const brokerUrl = 'http://127.0.0.1:' + port;
  const callback = 'http://127.0.0.1:17652/account/sso/callback';
  const broker = createBroker({publicUrl: brokerUrl, idpWebUrl: idp, idpApiUrl: idp, clientId: 'local-client', clientSecret: 'fixture-secret-not-real', returnUris: [callback], allowLocalHttp: true, now: () => clock});
  await new Promise(resolve => broker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { broker.close(resolve); broker.closeAllConnections(); }));
  const store = memoryStore(); let opened;
  const account = new AccountSSO({brokerUrl, allowLocalHttp: true, store, now: () => clock, openExternal: async url => { opened = url; }});
  const post = (route, data, headers = {}) => fetch(brokerUrl + route, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(data)});
  async function browserCallback() {
    await account.login(17652);
    let url = opened;
    for (let i = 0; i < 3; i++) { const response = await fetch(url, {redirect: 'manual'}); assert.equal(response.status, 302); url = response.headers.get('location'); }
    assert.ok(url.startsWith(callback + '?'));
    assert.doesNotMatch(url, /fixture-access|fixture-refresh|fixture-secret/);
    return Object.fromEntries(new URL(url).searchParams);
  }
  return {account, store, post, brokerUrl, requests, browserCallback,
    advance: ms => { clock += ms; }, refreshCount: () => refreshCount, revoked: () => revoked,
    rejectRefresh: () => { rejectRefresh = true; }, outage: value => { outage = value; },
    deferRefresh: value => { deferRefresh = value; }};
}

test('离线 HTTP 全流程：浏览器授权、两层 PKCE、会话恢复、资料脱敏、退出撤销', async t => {
  const f = await fixture(t), query = await f.browserCallback();
  assert.equal(f.account.status().pending, true);
  const value = await f.account.completeCallback(query);
  assert.equal(value.authenticated, true); assert.equal(value.profile.phone, '138****0000');
  assert.equal(value.profile.sub, 'usr_fixture'); assert.doesNotMatch(JSON.stringify(value), /session_token|access_token|refresh_token|fixture-secret|13800000000/);
  await assert.rejects(f.account.completeCallback(query), /失效|失败/);
  const restored = new AccountSSO({brokerUrl: f.brokerUrl, allowLocalHttp: true, store: f.store});
  assert.equal((await restored.restore()).authenticated, true);
  assert.equal((await restored.logout()).authenticated, false); assert.equal(f.revoked(), 1);
  assert.equal(await f.store.load(), null);
  assert.ok(f.requests.every(value => !/yushe|xycut\.com/.test(value.route)));
});
test('state 错误、Unicode 伪造、一次性授权码重放、错误 PKCE 均拒绝', async t => {
  const f = await fixture(t), query = await f.browserCallback();
  await assert.rejects(f.account.completeCallback({...query, state: '中'.repeat(43)}), /校验失败/);
  assert.equal(f.account.status().pending, true);
  assert.equal((await f.post('/auth/exchange', {code: query.code, code_verifier: random()})).status, 401);
  await f.account.completeCallback(query);
  assert.equal((await f.post('/auth/exchange', {code: query.code, code_verifier: random()})).status, 401);
  assert.equal(equal('中', 'a'), false);
});
test('过期授权码、超时 state 和取消登录不产生账户', async t => {
  const f = await fixture(t), query = await f.browserCallback(); f.advance(61000);
  await assert.rejects(f.account.completeCallback(query), /失效/);
  await f.account.login(17652); f.advance(300001);
  assert.equal(f.account.status().pending, false);
  const q = await f.browserCallback(); await f.account.logout();
  await assert.rejects(f.account.completeCallback(q), /失效/); assert.equal(f.account.status().authenticated, false);
});
test('并发刷新只旋转一次；网络故障保留会话，授权撤销则清除', async t => {
  const f = await fixture(t); await f.account.completeCallback(await f.browserCallback());
  f.advance(25000);
  let release; f.deferRefresh(new Promise(resolve => { release = resolve; }));
  const pending = Promise.all([f.account.refresh(), f.account.refresh()]);
  // Reach the real mock HTTP refresh handler before releasing it.
  for (let i = 0; i < 100 && !f.refreshCount(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  release(); await pending; assert.equal(f.refreshCount(), 1);
  f.outage(true); assert.equal((await f.account.refresh()).authenticated, true); assert.ok(await f.store.load());
  f.outage(false); f.rejectRefresh(); f.advance(25000);
  assert.equal((await f.account.refresh()).authenticated, false); assert.equal(await f.store.load(), null);
});
test('拒绝非 HTTPS、任意回调、网页跨域和恶意登录跳转', async t => {
  assert.throws(() => trustedBase('http://example.com', true));
  for (const value of ['https://a.test/path', 'https://u:p@a.test', 'https://a.test/?secret=x', 'javascript:alert(1)']) assert.throws(() => trustedBase(value));
  const f = await fixture(t);
  assert.equal((await f.post('/auth/start', {state: random(), code_challenge: challenge(random()), return_uri: 'http://evil.test/callback'})).status, 400);
  assert.equal((await f.post('/auth/start', {}, {Origin: 'http://evil.test'})).status, 403);
  assert.equal((await fetch(f.brokerUrl + '/auth/callback?state=bad&code=secret')).status, 400);
  const unsafe = new AccountSSO({brokerUrl: 'https://broker.invalid', openExternal: () => assert.fail('不得打开恶意地址'), fetcher: async () => new Response(JSON.stringify({login_url: 'https://evil.invalid/auth/login/' + random()}))});
  await assert.rejects(unsafe.login(17652), /登录地址无效/);
});
test('登出与授权码兑换并发时，迟到响应不能恢复账户', async () => {
  let release, exchangeStarted;
  const exchangeReady = new Promise(resolve => { exchangeStarted = resolve; });
  const store = memoryStore(), calls = [];
  const token = random(), code = random();
  const account = new AccountSSO({brokerUrl:'https://broker.invalid',store,openExternal:async()=>{},fetcher:async(url)=>{
    calls.push(url);
    if(url.endsWith('/auth/start'))return new Response(JSON.stringify({login_url:'https://broker.invalid/auth/login/'+random()}));
    if(url.endsWith('/auth/exchange')){exchangeStarted();await new Promise(resolve=>{release=resolve;});return new Response(JSON.stringify({session_token:token,profile:{sub:'usr_fixture'}}));}
    return new Response('{"revoked":true}');
  }});
  await account.login(17652);
  const pending=account.completeCallback({code,state:account.pending.state});await exchangeReady;
  await account.logout();release();await pending;
  assert.equal(account.status().has_session,false);assert.equal(await store.load(),null);assert.ok(calls.some(url=>url.endsWith('/auth/logout')));
});
test('授权兑换和安全存储期间保持pending，避免账户界面提前停止轮询', async () => {
  let exchangeReady, releaseExchange, savingReady, releaseSave;
  const exchanging=new Promise(resolve=>{exchangeReady=resolve;});
  const saving=new Promise(resolve=>{savingReady=resolve;});
  let starts=0;
  const account=new AccountSSO({brokerUrl:'https://broker.invalid',openExternal:async()=>{},store:{clear:async()=>{},save:async()=>{savingReady();await new Promise(resolve=>{releaseSave=resolve;});return true;}},fetcher:async url=>{
    if(url.endsWith('/auth/start')){starts++;return new Response(JSON.stringify({login_url:'https://broker.invalid/auth/login/'+random()}));}
    exchangeReady();await new Promise(resolve=>{releaseExchange=resolve;});return new Response(JSON.stringify({session_token:random(),profile:{sub:'usr_fixture'}}));
  }});
  await account.login(17656);
  const completion=account.completeCallback({code:random(),state:account.pending.state});await exchanging;
  assert.equal(account.status().pending,true);assert.equal(account.status().authenticated,false);
  await account.login(17656);assert.equal(starts,1);
  releaseExchange();await saving;assert.equal(account.status().pending,true);
  releaseSave();const result=await completion;
  assert.equal(result.pending,false);assert.equal(result.authenticated,true);assert.equal(account.status().pending,false);
});
test('持久化与登出并发不留下会话，切换 broker 不恢复旧账户', async () => {
  let release, saving;
  const savingReady=new Promise(resolve=>{saving=resolve;});
  let saved;
  const store={available:()=>true,load:async()=>saved,clear:async()=>{saved=null;},save:async value=>{saving();await new Promise(resolve=>{release=resolve;});saved=value;return true;}};
  const account=new AccountSSO({brokerUrl:'https://broker.invalid',store,openExternal:async()=>{},fetcher:async url=>new Response(JSON.stringify(url.endsWith('/auth/start')?{login_url:'https://broker.invalid/auth/login/'+random()}:url.endsWith('/auth/exchange')?{session_token:random(),profile:{sub:'usr_fixture'}}:{revoked:true}))});
  await account.login(17652);const completing=account.completeCallback({code:random(),state:account.pending.state});await savingReady;
  const logout=account.logout();release();await Promise.all([completing,logout]);assert.equal(saved,null);assert.equal(account.status().authenticated,false);
  saved={broker:'https://other.invalid',token:random()};
  const restored=new AccountSSO({brokerUrl:'https://broker.invalid',store,fetcher:()=>assert.fail('不可发送另一服务的令牌')});assert.equal((await restored.restore()).has_session,false);
});
test('移除磁盘旧 auth_token 时保留自有 API 和工程目录', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zm-legacy-account-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const previous={auth_token:'synthetic-token',draft_output_dir:root,third_party_apis:[{type:'doubao_llm',parameters:{api_key:'fixture-not-real'}}]};
  fs.writeFileSync(path.join(root,'api-context.json'),JSON.stringify(previous));
  const service=new Service({resources:root,dataDir:root});
  const disk=JSON.parse(fs.readFileSync(path.join(root,'api-context.json')));assert.equal(Object.hasOwn(disk,'auth_token'),false);assert.deepEqual(disk.third_party_apis,previous.third_party_apis);assert.equal(service.apiContext.draft_output_dir,root);
});
test('中文空格数据目录使用加密会话；不可用时不写明文（模拟系统加密接口）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-account-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const key = crypto.randomBytes(32), dataDir = path.join(root, '中文 目录');
  const store = createAccountStore({dataDir, safeStorage: {isEncryptionAvailable: () => true,
    encryptString: value => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decryptString: value => { const c = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(); }}});
  const session = {broker: 'https://broker.invalid', token: random()}; assert.equal(await store.save(session), true); assert.deepEqual(await store.load(), session);
  const file = path.join(dataDir, 'account/session.enc'); assert.equal(fs.readFileSync(file).includes(session.token), false); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await store.clear(); assert.equal(fs.existsSync(file), false);
  const unavailable = createAccountStore({dataDir, safeStorage: {isEncryptionAvailable: () => false}});
  assert.equal(await unavailable.save(session), false); assert.equal(fs.existsSync(file), false);
});
test('本地 HTTP 回调与账户静态文件可用；不提供网页读取令牌接口', async t => {
  let received;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-account-http-'));t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const service = {port: 0, dataDir:root, resources: root, apiContext: {}, account: {completeCallback: async query => { received = query; }}};
  const {server, url} = await startServer(service, {port: 0}); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal((await fetch(url + '/account/sso/callback?code=fixture&state=fixture')).status, 200); assert.equal(received.code, 'fixture');
  for (const asset of ['account-ui.js', 'account-ui.css']) assert.equal((await fetch(url + '/' + asset)).status, 200);
  assert.equal((await fetch(url + '/account/sso/callback', {headers: {Origin: 'https://evil.invalid'}})).status, 403);
  assert.equal((await fetch(url + '/auth/session')).status, 404);
  const s = Object.create(Service.prototype); assert.equal((await s.invoke('account_sso_status')).configured, false);
});
