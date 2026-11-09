const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {within}=require('./util.cjs');
const {Workbench}=require('./workbench.cjs');
const {renderPreview}=require('./preview.cjs');
const MIME={'.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.mp4':'video/mp4','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav'};
async function body(request){let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>16000000)throw new Error('请求内容过大');chunks.push(chunk);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}
function json(response,data,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data));}
function sendFile(request,response,file){
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){json(response,{ok:false,message:'文件不存在'},404);return;}
  const size=fs.statSync(file).size,headers={'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes'};
  let start=0,end=size-1,status=200;
  if(request.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);if(!m){response.writeHead(416);response.end();return;}if(m[1]){start=Number(m[1]);if(m[2])end=Number(m[2]);}else start=Math.max(0,size-Number(m[2]));end=Math.min(end,size-1);if(start>end||start>=size){response.writeHead(416,{'Content-Range':`bytes */${size}`});response.end();return;}status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;}
  headers['Content-Length']=Math.max(0,end-start+1);response.writeHead(status,headers);if(request.method==='HEAD'||size===0)response.end();else fs.createReadStream(file,{start,end}).pipe(response);
}
async function startServer(service,{port=17652,companion=null}={}){
  const workbench=new Workbench(service);
  const bridge=companion?require('./companion.cjs').createCompanion({service,...companion,sendFile}):null;
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https:; frame-src https:; font-src 'self' data:");
    response.setHeader('X-Content-Type-Options','nosniff');
    try{
      if(bridge&&await bridge.handle(request,response))return;
      const url=new URL(request.url,`http://127.0.0.1:${service.port}`),route=url.pathname,query=Object.fromEntries(url.searchParams);
      const origin=request.headers.origin;
      if(origin && origin!==`http://127.0.0.1:${service.port}`){json(response,{ok:false,message:'拒绝来自其他网站的本地请求'},403);return;}
      if(service.platformEnabled&&(['/sucai/embeddings','/sucai/embeddings/build'].includes(route)||route.startsWith('/ai/platform/'))){
        const {equal}=require('./account-sso.cjs');if(!equal(request.headers.authorization,'Bearer '+service.platformApiKey())){json(response,{ok:false,message:'缺少本机 Agent 调用凭证'},401);return;}
      }
      if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
      if(route==='/account/sso/callback'&&request.method==='GET'){
        try {if(!service.account)throw new Error('账户服务未配置');await service.account.completeCallback(query);response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});response.end('<!doctype html><meta charset="utf-8"><title>掌门cut 账户</title><p>登录流程已完成，请返回掌门cut查看账户状态。可以关闭此页面。</p>');}
        catch {json(response,{ok:false,message:'登录未完成或回调已失效，请返回掌门cut重试'},400);}return;
      }
      if(route==='/skill-catalog.json'&&request.method==='GET'){json(response,require('./skills.cjs').catalog());return;}
      if(['/account-ui.js','/account-ui.css','/platform-ui.js','/platform-ui.css','/skill-ui.js','/skill-ui.css'].includes(route)&&request.method==='GET'){sendFile(request,response,path.join(__dirname,'../desktop',route.slice(1)));return;}
      if(route==='/health'){json(response,{ok:true,port:service.port,service:'xiaoying-agent-api',restored:true,enabled:service.apiContext.ai_editing_enabled!==false});return;}
      if(route==='/ai/platform/invoke'&&request.method==='POST'){json(response,await service.platformInvoke(await body(request)));return;}
      if(route==='/ai/platform/status'&&request.method==='GET'){json(response,await service.platformServiceStatus({refresh:true}));return;}
      if(route==='/ai/platform/transcribe'&&request.method==='POST'){json(response,await service.transcribeDoubaoAsr(await body(request)));return;}
      if(route==='/ai/platform/models'&&request.method==='GET'){json(response,await service.account.models());return;}
      if(route==='/ai/platform/task'&&request.method==='GET'){json(response,await service.account.task(query.task_id,query.step_id));return;}
      if(service.apiContext.ai_editing_enabled===false&&request.method==='POST'&&(route.startsWith('/ai-editing/')||route.startsWith('/sucai/embeddings'))){json(response,{ok:false,message:'AI 剪辑已关闭，请在设置中开启后再调用 Agent 接口。'},403);return;}
      if(route==='/ai-editing/workbench/open'&&request.method==='POST'){json(response,workbench.open(await body(request)));return;}
      if(route==='/ai-editing/workbench/api/task'){json(response,await workbench.task(query));return;}
      if(route==='/ai-editing/workbench/api/state'&&request.method==='POST'){json(response,await workbench.state(await body(request)));return;}
      if(route==='/ai-editing/workbench/api/media-analysis'&&request.method==='POST'){json(response,await workbench.mediaAnalysis(query));return;}
      if(route==='/ai-editing/video-template/analysis'){json(response,workbench.analysis(query.analysis_file));return;}
      if(route==='/ai-editing/video-template/preview'){
        const html=renderPreview(service.resources,workbench.analysis(query.analysis_file));
        // The recovered original page uses inline scripts and event attributes.
        response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https:; font-src 'self' data:");
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(html);return;
      }
      if(route==='/ai-editing/video-template/save-analysis'&&request.method==='POST'){json(response,workbench.saveAnalysis(await body(request)));return;}
      if(['/ai-editing/generate','/ai-editing/template-designer/generate'].includes(route)&&request.method==='POST'){json(response,await service.generate(await body(request)));return;}
      if(route==='/sucai/embeddings'&&request.method==='POST'){json(response,await service.embeddings(await body(request)));return;}
      if(route==='/sucai/embeddings/build'&&request.method==='POST'){json(response,await service.buildEmbeddings(await body(request)));return;}
      if(route==='/ai-editing/file'){const file=service.resolvePath(query.path||'');if(!service.canRead(file)){json(response,{ok:false,message:'文件未登记到当前应用'},403);return;}sendFile(request,response,file);return;}
      if(route==='/bridge.js'){sendFile(request,response,path.join(__dirname,'../desktop/bridge.js'));return;}
      if(route==='/ai-editing/workbench'||/^\/xycut\/[^/]+$/.test(route)){sendFile(request,response,path.join(service.resources,'agent-kit/tools/editing-workbench/public/index.html'));return;}
      if(route.startsWith('/ai-editing/workbench/assets/')){const name=path.basename(route);sendFile(request,response,path.join(service.resources,name==='app-icon.png'?'frontend/icon.png':'agent-kit/tools/editing-workbench/public/'+name));return;}
      const root=path.join(service.resources,'frontend'),file=path.resolve(root,'.'+decodeURIComponent(route==='/'?'/index.html':route));
      if(!within(root,file)){json(response,{ok:false,message:'路径越界'},403);return;}sendFile(request,response,file);
    }catch(error){json(response,{ok:false,message:error.message,code:error.code,request_id:error.request_id,task_id:error.task_id,step_id:error.step_id},error.status||400);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  service.port=server.address().port;
  server.once('close',()=>bridge?.close());
  return {server,workbench,companion:bridge,url:`http://127.0.0.1:${service.port}`};
}
module.exports={startServer,sendFile};
