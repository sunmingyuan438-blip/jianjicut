'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');

const random = () => crypto.randomBytes(32).toString('base64url');
const MEDIA = /\.(?:png|jpe?g|webp|gif|bmp|svg|ico|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|ogg|ttf|otf|woff2?)$/i;
const IMPORT = /\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|ogg|srt|zip)$/i;
const HTTP = new Map([
  ['/ai-editing/workbench/open','POST'], ['/ai-editing/workbench/api/task','GET'],
  ['/ai-editing/workbench/api/state','POST'], ['/ai-editing/workbench/api/media-analysis','POST'],
  ['/ai-editing/video-template/analysis','GET'], ['/ai-editing/video-template/save-analysis','POST'],
  ['/ai-editing/generate','POST'], ['/ai-editing/template-designer/generate','POST'],
  ['/sucai/embeddings','POST'], ['/sucai/embeddings/build','POST'],
  ['/ai/platform/invoke','POST'], ['/ai/platform/transcribe','POST'],
  ['/ai/platform/models','GET'], ['/ai/platform/task','GET'], ['/ai/platform/status','GET'],
]);
const error = (message, status = 400) => Object.assign(new Error(message), {status});
async function body(request, limit = 8 * 1024 * 1024) {
  let bytes = 0; const parts = [];
  for await (const part of request) { bytes += part.length; if (bytes > limit) throw error('请求过大',413); parts.push(part); }
  let value; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw error('请求格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('请求格式无效');
  return value;
}

// Loopback only. OAuth credentials never cross this bridge. Each browser tab
// needs a native consent, an Origin-bound in-memory session, and a Bearer header.
function createCompanion({service, confirmConnection, origins = [], now = Date.now, ttl = 8 * 3600000, sendFile}) {
  const allowed = new Set(origins.map(value => {
    const url = new URL(value);
    if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw error('助手网站配置无效');
    return value;
  }));
  const sessions = new Map(), tickets = new Map();
  let confirming = false, starts = 0, startWindow = now();
  const json = (response, value, status = 200) => { response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); response.end(JSON.stringify(value)); };
  function prune() {
    for (const [key,value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const [key,value] of tickets) if (!sessions.has(value.session) || value.expires <= now()) tickets.delete(key);
  }
  function sessionFor(request) {
    const token = /^Bearer ([\w-]{43})$/.exec(request.headers.authorization || '')?.[1];
    const session = sessions.get(token);
    if (!session || session.origin !== request.headers.origin || session.expires <= now()) throw error('请重新连接本机助手',401);
    return {token, session};
  }
  function assetsFor(value, token) {
    const assets = {}; let count = 0;
    const visit = (item, depth = 0) => {
      if (depth > 20 || count > 2500) return;
      if (typeof item === 'string' && MEDIA.test(item) && path.isAbsolute(item)) {
        count++;
        try {
          if (service.canRead(item) && fs.statSync(item).isFile()) {
            if (tickets.size > 12000) return;
            const ticket = random(); tickets.set(ticket,{file:fs.realpathSync(item),session:token,expires:now()+30*60000});
            assets[item] = '/companion/media?ticket=' + ticket;
          }
        } catch {}
      } else if (Array.isArray(item)) item.forEach(child => visit(child,depth+1));
      else if (item && typeof item === 'object') Object.values(item).forEach(child => visit(child,depth+1));
    };
    visit(value); return assets;
  }
  async function handle(request,response) {
    const url = new URL(request.url,'http://127.0.0.1');
    if (!url.pathname.startsWith('/companion/')) return false;
    response.setHeader('Cache-Control','no-store'); response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Content-Type-Options','nosniff');
    try {
      // Reject alternate Host names even if DNS resolves to the loopback.
      if (request.headers.host !== '127.0.0.1:' + service.port) throw error('仅接受本机回环地址',403);
      prune();
      const origin = request.headers.origin;
      // Scoped image/video tickets can be used by media tags, which omit Origin.
      if (url.pathname === '/companion/media' && ['GET','HEAD'].includes(request.method)) {
        if (origin && !allowed.has(origin)) throw error('网站未获授权',403);
        const ticket = tickets.get(url.searchParams.get('ticket'));
        if (!ticket || !sessions.has(ticket.session) || ticket.expires <= now() || !service.canRead(ticket.file) || !MEDIA.test(ticket.file)) throw error('媒体访问许可已失效，请刷新页面',403);
        response.setHeader('Cross-Origin-Resource-Policy','cross-origin');
        if (origin) { response.setHeader('Access-Control-Allow-Origin',origin); response.setHeader('Vary','Origin'); }
        sendFile(request,response,ticket.file); return true;
      }
      if (!allowed.has(origin)) throw error('网站未获授权',403);
      response.setHeader('Access-Control-Allow-Origin',origin); response.setHeader('Vary','Origin');
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        if (!['GET','POST'].includes(method)) throw error('请求方法无效',405);
        const headers = String(request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
        if (headers.some(v=>!['authorization','content-type'].includes(v))) throw error('请求头无效',403);
        response.setHeader('Access-Control-Allow-Methods','GET, POST');
        response.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network','true');
        response.writeHead(204);response.end();return true;
      }
      if (url.pathname === '/companion/status' && request.method === 'GET') {
        json(response,{service:'zhangmen-companion',protocol:1,version:'0.2.10',platform:process.platform,arch:process.arch});return true;
      }
      if (url.pathname === '/companion/connect' && request.method === 'POST') {
        const input = await body(request,2048);
        if (!/^[\w-]{43}$/.test(input.client_nonce || '')) throw error('连接参数无效');
        if (now()-startWindow >= 60000) { starts=0;startWindow=now(); }
        if (++starts > 6 || confirming || sessions.size >= 4) throw error('连接请求过于频繁，请稍后重试',429);
        confirming = true; let approved;
        try { approved = await confirmConnection({origin}); } finally { confirming = false; }
        if (!approved) throw error('本机助手未批准连接',403);
        if (request.aborted || response.destroyed) return true;
        const token = random(), expires = now()+ttl;
        sessions.set(token,{origin,expires});
        json(response,{token,expires,client_nonce:input.client_nonce,platform:process.platform,arch:process.arch,protocol:1});return true;
      }
      const {token} = sessionFor(request);
      if (url.pathname === '/companion/disconnect' && request.method === 'POST') {
        sessions.delete(token);prune();json(response,{ok:true});return true;
      }
      if (url.pathname === '/companion/invoke' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.name !== 'string' || input.name.length > 128 || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw error('接口参数无效');
        // 软件更新只能在本机软件内操作，网页不能让助手下载安装包或退出。
        if (['check_app_update','download_and_open_update'].includes(input.name)) throw error('请在本机掌门cut中检查更新',403);
        const result = await service.invoke(input.name,input.args);
        json(response,{result:result ?? null,assets:assetsFor(result,token)});return true;
      }
      if (url.pathname === '/companion/http' && request.method === 'POST') {
        const input = await body(request), target = new URL(input.path,'http://127.0.0.1:'+service.port);
        if (target.origin !== 'http://127.0.0.1:'+service.port || target.username || target.password || HTTP.get(target.pathname) !== input.method) throw error('接口未开放给网站',403);
        const protectedRoute=target.pathname.startsWith('/ai/platform/')||target.pathname.startsWith('/sucai/embeddings');
        const result = await fetch(target,{method:input.method,headers:{'Content-Type':'application/json',...(protectedRoute&&service.platformEnabled?{Authorization:'Bearer '+service.platformApiKey()}:{})},...(input.method==='POST'?{body:JSON.stringify(input.body || {})}:{})});
        if (!result.headers.get('content-type')?.startsWith('application/json')) throw error('接口返回格式无效',502);
        const data=await result.json();json(response,{status:result.status,result:data,assets:assetsFor(data,token)});return true;
      }
      if (url.pathname === '/companion/upload' && request.method === 'POST') {
        const name=String(url.searchParams.get('name')||'').normalize('NFC');
        if (!name || name.length>200 || /[\\/\0]/.test(name) || !IMPORT.test(name)) throw error('不支持此文件类型');
        const directory=path.join(service.dataDir,'browser-imports',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const file=path.join(directory,name);let size=0;
        try { await pipeline(request,new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>1024*1024*1024?error('单个文件不能超过1GB',413):null,chunk);}}),fs.createWriteStream(file,{flags:'wx',mode:0o600})); }
        catch(e){fs.rmSync(directory,{recursive:true,force:true});throw e;}
        service.grant(file);json(response,{path:file,assets:assetsFor(file,token)});return true;
      }
      throw error('助手接口不存在',404);
    } catch(e) { if (!response.headersSent && !response.destroyed) json(response,{ok:false,message:e.status?e.message:'本机操作失败，请在助手中查看详情'},e.status||400); }
    return true;
  }
  return {handle,close(){sessions.clear();tickets.clear();}};
}
module.exports={createCompanion};
