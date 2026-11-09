'use strict';
const fs=require('node:fs');
const path=require('node:path');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp4':'video/mp4'};
function createWebHost({root,frontend}) {
  root=fs.realpathSync(root);frontend=fs.realpathSync(frontend);
  for(const file of ['index.html','client.js','style.css','downloads.css','downloads.json','app-manifest.json','bridge.js','account-ui.js','account-ui.css','platform-ui.js','platform-ui.css'])if(!fs.existsSync(path.join(root,file)))throw new Error('完整网页资源缺失：'+file);
  return (request,response)=>{
    const url=new URL(request.url,'http://localhost');
    if(!['GET','HEAD'].includes(request.method))return false;
    let file,base;
    if(url.pathname==='/'||url.pathname==='/connect'){file=path.join(root,'index.html');base=root;}
    // 原 Motion 模板库地址保留，统一指向掌门独家剪辑 Skill 页面。
    else if(url.pathname==='/skills'||url.pathname==='/motion-templates'){file=path.join(root,'skills.html');base=root;}
    else if(['/client.js','/style.css','/downloads.css','/downloads.json','/app-manifest.json','/bridge.js','/account-ui.js','/account-ui.css','/platform-ui.js','/platform-ui.css','/skill-ui.js','/skill-ui.css','/skill-catalog.json'].includes(url.pathname)){file=path.join(root,url.pathname.slice(1));base=root;}
    else if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/ai-recommended-themes/')||/^\/(?:icon\.(?:png|ico)|background\.jpg|brand-banner\.svg|brand-logo\.png|xycut-banner\.gif|xycut-hero\.jpg)$/.test(url.pathname)){
      try{file=path.resolve(frontend,'.'+decodeURIComponent(url.pathname));}catch{return false;}base=frontend;
    }else return false;
    try{
      const real=fs.realpathSync(file),relative=path.relative(base,real),type=TYPES[path.extname(real).toLowerCase()];
      if(!type||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!fs.statSync(real).isFile())return false;
      const local='http://127.0.0.1:17652 http://127.0.0.1:17656';
      response.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: ${local}; media-src 'self' blob: https: ${local}; connect-src 'self' https: ${local}; frame-src 'self' https: ${local}; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://aigzm.com`);
      response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Content-Type-Options','nosniff');
      response.writeHead(200,{'Content-Type':type,'Content-Length':fs.statSync(real).size});
      if(request.method==='HEAD')response.end();else fs.createReadStream(real).pipe(response);
      return true;
    }catch{return false;}
  };
}
module.exports={createWebHost};
