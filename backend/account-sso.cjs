const crypto = require('node:crypto');

const random = () => crypto.randomBytes(32).toString('base64url');
const challenge = value => crypto.createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function trustedBase(value, allowLocalHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('账户服务须使用 HTTPS 根地址；本机测试仅允许显式启用的回环 HTTP');
  }
  return url.origin;
}
function publicProfile(profile) {
  if (!profile || typeof profile.sub !== 'string' || !/^[\w-]{1,128}$/.test(profile.sub)) throw new Error('账户服务返回的用户资料无效');
  const phone = String(profile.phone_number || '');
  return {sub: profile.sub, phone: /^\+?\d{7,16}$/.test(phone) ? phone.slice(0, -8) + '****' + phone.slice(-4) : '', member_level: String(profile.member_level ?? '').slice(0, 64)};
}
class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Only opaque application sessions cross this boundary. OAuth credentials stay
// in the trusted broker; renderer IPC and agent-context never receive a token.
class AccountSSO {
  constructor({brokerUrl = '', allowLocalHttp = false, openExternal, store, fetcher = fetch, now = Date.now}) {
    this.base = brokerUrl ? trustedBase(brokerUrl, allowLocalHttp) : '';
    this.openExternal = openExternal;
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
    this.session = null;
    this.pending = null;
    this.completingRevision = null;
    this.message = '';
    this.revision = 0;
    this.persisting = Promise.resolve(false);
  }
  status() {
    if (this.pending && this.pending.expires <= this.now()) { this.pending = null; this.message = '登录已超时，请重试'; }
    return {configured: !!this.base, authenticated: !!this.session?.profile, has_session: !!this.session, pending: !!this.pending || this.completingRevision === this.revision,
      profile: this.session?.profile || null, persistent: !!this.session?.persisted,cloud:!!this.cloud,platform_mode:!!this.base||!!this.required,account:this.session?this.accountState||null:null,
      message: this.message || (this.base ? '' : '统一账户服务尚未配置，请联系管理员')};
  }
  async request(route, {token, data, timeout = 15000} = {}) {
    let response;
    try {
      response = await this.fetcher(this.base + route, {method: data ? 'POST' : 'GET', redirect: 'error',
        headers: {...(data ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: 'Bearer ' + token} : {})},
        ...(data ? {body: JSON.stringify(data)} : {}), signal: AbortSignal.timeout(timeout)});
    } catch { throw new AccountError('账户服务暂时无法连接，请稍后重试', 503); }
    if (!response.ok) {
      let result;try{result=await response.json();}catch{}
      const error=new AccountError(response.status===401?'登录已失效，请重新登录':String(result?.message||'账户服务暂时不可用，请稍后重试').slice(0,200),response.status);error.code=result?.code;throw error;
    }
    try { return await response.json(); } catch { throw new AccountError('账户服务返回格式无效', 502); }
  }
  async restore() {
    if (!this.base) return this.status();
    const saved = await this.store?.load();
    if (saved?.broker === this.base && /^[\w-]{43}$/.test(saved.token || '')) {
      this.session = {token: saved.token, profile: null, persisted: true};
      await this.refresh();
    }
    return this.status();
  }
  async persist() {
    // Serialize writes/clears so logout cannot race an in-flight encryption.
    this.persisting = this.persisting.catch(() => false).then(async () => {
      await this.store?.clear();
      return this.session ? !!(await this.store?.save({broker: this.base, token: this.session.token})) : false;
    });
    return this.persisting;
  }
  async login(port) {
    if (!this.base) throw new AccountError('统一账户服务尚未配置，请联系管理员');
    if (this.pending || this.completingRevision === this.revision) return this.status();
    const revision = ++this.revision;
    const pending = {verifier: random(), state: random(), expires: this.now() + 300000};
    this.pending = pending;
    this.message = '';
    try {
      const result = await this.request('/auth/start', {data: {code_challenge: challenge(pending.verifier), state: pending.state, return_uri: `http://127.0.0.1:${port}/account/sso/callback`}});
      const url = new URL(result.login_url);
      if (url.origin !== this.base || !/^\/auth\/login\/[\w-]{43}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new AccountError('账户服务返回的登录地址无效');
      if (revision !== this.revision) return this.status();
      await this.openExternal(url.href);
      return this.status();
    } catch (error) { if (revision === this.revision) { this.pending = null; this.message = error.message; } throw error; }
  }
  async completeCallback(query) {
    const pending = this.pending;
    if (!pending || pending.expires <= this.now() || !equal(query.state, pending.state)) throw new AccountError('登录回调已失效或校验失败，请回到掌门cut重新登录');
    this.pending = null; // Consume before awaiting network; duplicate callbacks cannot redeem.
    const revision = this.revision;
    if (query.error) { this.message = '登录未完成，请重新登录'; throw new AccountError(this.message); }
    if (!/^[\w-]{43}$/.test(query.code || '')) throw new AccountError('登录回调缺少有效授权码');
    this.completingRevision = revision;
    try {
      const result = await this.request('/auth/exchange', {data: {code: query.code, code_verifier: pending.verifier}});
      if (!/^[\w-]{43}$/.test(result.session_token || '')) throw new AccountError('账户服务返回的会话无效');
      if (revision !== this.revision) { await this.request('/auth/logout', {token: result.session_token, data: {}}).catch(() => {}); return this.status(); }
      let profile;
      try { profile = publicProfile(result.profile); }
      catch (error) { await this.request('/auth/logout', {token: result.session_token, data: {}}).catch(() => {}); throw error; }
      this.session = {token: result.session_token, profile};
      this.accountState=null;
      this.cloud = result.cloud === true;
      const persisted = await this.persist();
      if (revision === this.revision) { this.session.persisted = persisted; this.message = persisted ? '已使用 AI 超市账户登录' : '已登录；本次会话仅在内存中保存'; }
      if(revision===this.revision&&this.cloud)await this.refresh();
      if(this.completingRevision===revision)this.completingRevision=null;
      return this.status();
    } catch (error) { this.message = error.message; throw error; }
    finally { if(this.completingRevision===revision)this.completingRevision=null; }
  }
  async refresh() {
    const session = this.session, revision = this.revision;
    if (!session) return this.status();
    try {
      const result = await this.request('/auth/session', {token: session.token});
      if (revision === this.revision && this.session === session) { session.profile = publicProfile(result.profile); this.cloud=result.cloud===true;this.message = ''; }
      if(this.cloud&&revision===this.revision&&this.session===session){const state=await this.request('/account/status',{token:session.token});if(revision===this.revision&&this.session===session)this.accountState=state;}
    } catch (error) {
      if (revision === this.revision) {
        this.message = error.message;
        if (error.status === 401) { this.session = null; await this.persist(); }
      }
    }
    return this.status();
  }
  async logout() {
    ++this.revision;
    const token = this.session?.token;
    this.session = null; this.pending = null;this.accountState=null;
    await this.persist();
    this.message = '已退出掌门cut账户';
    if (token) {
      try { const result = await this.request('/auth/logout', {token, data: {}}); if (!result.revoked) this.message += '；远端授权撤销未确认'; }
      catch { this.message += '；账户服务不可用，远端会话将在到期后失效'; }
    }
    return this.status();
  }
  async authorize(features) {
    if(!this.session)throw new AccountError('请先使用 AI 超市账户登录',401);
    return this.request('/account/authorize',{token:this.session.token,data:{features}});
  }
  async invokeModel(body) {
    if(!this.session)throw new AccountError('请先使用 AI 超市账户登录',401);
    const result=await this.request('/ai/invoke',{token:this.session.token,data:body,timeout:body.operation==='image'?970000:body.operation?.startsWith('asr_')?310000:130000});
    if(result.status!=='success'){const error=new AccountError(result.message||'模型未返回成功结果，请查看原任务',result.code==='insufficient_balance'?402:result.status==='provider_unknown'?503:400);error.code=result.code||result.status;error.request_id=result.request_id;error.task_id=body.task_id;error.step_id=body.step_id;throw error;}
    if(this.cloud)await this.refresh();
    return result;
  }
  async models(){if(!this.session)throw new AccountError('请先登录',401);return this.request('/ai/models',{token:this.session.token});}
  async task(task_id,step_id){if(!this.session)throw new AccountError('请先登录',401);return this.request('/ai/task?'+new URLSearchParams({task_id,step_id}),{token:this.session.token});}
  async billing(intent){if(!this.session)throw new AccountError('请先登录',401);const result=await this.request('/account/billing',{token:this.session.token,data:{intent}});const target=new URL(result.billing_url);if(target.protocol!=='https:'||target.username||target.password)throw new AccountError('平台返回的支付入口无效');await this.openExternal(result.billing_url);return{opened:true};}
}
module.exports = {AccountSSO, AccountError, trustedBase, random, challenge, equal, publicProfile};
