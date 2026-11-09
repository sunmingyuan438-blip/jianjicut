(() => {
  'use strict';
  const originalFetch=window.fetch.bind(window),assets=new Map();
  let token='',local='',busy=false,noticeTimer;
  const status=document.getElementById('connection-status'),button=document.getElementById('connect');
  async function loadDownloads(){
    const container=document.getElementById('desktop-downloads');if(!container)return;
    const choices=[['darwin','arm64','Mac · Apple Silicon'],['darwin','x64','Mac · Intel'],['win32','x64','Windows · x64']];
    const node=(tag,text)=>{const value=document.createElement(tag);if(text)value.textContent=text;return value;};
    try{
      const response=await originalFetch('/downloads.json',{cache:'no-store'});if(!response.ok)throw new Error('下载信息暂时不可用，请稍后刷新。');
      const manifest=await response.json();if(!Array.isArray(manifest.releases))throw new Error('下载信息暂时不可用，请稍后刷新。');
      container.replaceChildren();
      for(const [platform,arch,label]of choices){
        const item=manifest.releases.find(release=>release.platform===platform&&release.arch===arch);
        const card=node('article');card.className='download-option';card.append(node('h3',label));
        let url;try{url=new URL(item?.url);}catch{}
        const valid=item?.status==='ready'&&url?.protocol==='https:'&&!url.username&&!url.password&&/^[a-f0-9]{64}$/i.test(item.sha256||'')&&Number.isSafeInteger(item.bytes)&&item.bytes>0;
        if(valid){
          const link=node('a','下载掌门cut');link.className='download-button';link.href=url.href;link.rel='noreferrer';card.append(link);
          card.append(node('p',`v${manifest.version} · ${(item.bytes/1024/1024).toFixed(1)} MB`));
          if(platform==='win32')card.append(node('p','适用于 Windows 10 / 11（Intel、AMD 64 位）。'));
          if(item.apple_notarized===false)card.append(node('p','测试版：尚未完成 Apple 公证，首次打开可能受到系统拦截。请按系统提示操作。'));
          if(platform==='win32'&&item.authenticode_signed===false)card.append(node('p','测试版：尚未完成 Windows 代码签名，系统可能提示未知发布者。请核对下载来源和校验值。'));
          if(item.validation==='not_live_tested')card.append(node('p','此版本尚未完成对应系统的实机验收。'));
          const check=node('details');check.append(node('summary','查看 SHA-256 校验值'),node('code',item.sha256));card.append(check);
        }else{card.append(node('p','暂未发布可下载版本'));}
        container.append(card);
      }
    }catch(error){container.replaceChildren(node('p',error.message||'下载信息暂时不可用，请稍后刷新。'));}
  }
  void loadDownloads();
  const notice=message=>{const element=document.getElementById('companion-notice');element.textContent=message;element.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{element.hidden=true;},6000);};
  const remember=value=>{for(const [key,url] of Object.entries(value.assets||{}))assets.set(key,local+url);};
  async function request(route,body,{timeout=1200000,raw=false}={}) {
    const response=await originalFetch(local+route,{method:'POST',mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+token,...(!raw?{'Content-Type':'application/json'}:{})},body:raw?body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
    let data;try{data=await response.json();}catch{throw new Error('助手响应无效，请检查本机助手。');}
    if(!response.ok)throw new Error(data.message||'本机操作失败');
    remember(data);return data;
  }
  function loadScript(src,module=false){return new Promise((resolve,reject)=>{const script=document.createElement('script');if(module)script.type='module';script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('界面资源加载失败，请刷新网页。'));document.head.append(script);});}
  const nonce=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
  function browserWindow(command){
    const size={width:innerWidth,height:innerHeight};
    const values={inner_size:size,outer_size:size,scale_factor:devicePixelRatio,is_maximized:false,is_minimized:false,is_visible:true,is_focused:document.hasFocus(),current_monitor:{name:'Browser',size,position:{x:0,y:0},scaleFactor:devicePixelRatio}};
    if(Object.hasOwn(values,command))return values[command];
    if(['hide','close','minimize'].includes(command))notice('这是网页工作台；可关闭浏览器标签页，或点击右下角断开助手。');
    return null;
  }
  async function mount(meta){
    window.xycutDesktop={
      platform:meta.platform,arch:meta.arch,localOrigin:local,browser:true,
      invoke:async(name,args={})=>{
        if(name.startsWith('plugin:window|'))return browserWindow(name.split('|')[1]);
        return (await request('/companion/invoke',{name,args})).result;
      },
      onEvent:callback=>{const resize=()=>callback({event:'tauri://resize',payload:{width:innerWidth,height:innerHeight}});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},
      fileUrl:file=>assets.get(file)||'data:,',
      importFiles:async files=>{const paths=[];for(const file of files){if(file.size>1024*1024*1024)throw new Error('单个文件不能超过1GB');const result=await request('/companion/upload?name='+encodeURIComponent(file.name),file,{raw:true});paths.push(result.path);}return paths;}
    };
    window.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
      if(url.origin===location.origin&&/^\/(?:ai-editing|sucai|ai\/platform)\//.test(url.pathname)){
        const method=String(options?.method||'GET').toUpperCase();let body={};
        if(options?.body)body=JSON.parse(options.body);
        const result=await request('/companion/http',{path:url.pathname+url.search,method,body});
        return new Response(JSON.stringify(result.result),{status:result.status,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(input,options);
    };
    const manifest=await (await originalFetch('/app-manifest.json',{cache:'no-store'})).json();
    for(const href of manifest.styles){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
    await loadScript('/bridge.js');
    document.getElementById('companion-gate').hidden=true;document.body.classList.add('companion-connected');
    document.getElementById('helper-label').textContent='本机已连接 · '+(meta.platform==='darwin'?'Mac':meta.platform==='win32'?'Windows':meta.platform);
    document.getElementById('companion-toolbar').hidden=false;
    for(const src of manifest.modules)await loadScript(src,true);
  }
  button.addEventListener('click',async()=>{
    if(busy)return;busy=true;button.disabled=true;
    local='http://127.0.0.1:'+document.getElementById('helper-port').value;
    try{
      status.textContent='正在连接本机助手…';
      const probe=await originalFetch(local+'/companion/status',{mode:'cors',credentials:'omit',signal:AbortSignal.timeout(6000)});
      const meta=await probe.json();if(!probe.ok||meta.service!=='zhangmen-companion'||meta.protocol!==1)throw new Error('此助手版本不支持网页连接，请更新本机助手。');
      status.textContent='请在本机助手弹窗中允许本次连接。';
      const clientNonce=nonce(),response=await originalFetch(local+'/companion/connect',{method:'POST',mode:'cors',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_nonce:clientNonce}),signal:AbortSignal.timeout(180000)});
      const value=await response.json();if(!response.ok)throw new Error(value.message||'连接未获批准');
      if(value.client_nonce!==clientNonce||! /^[\w-]{43}$/.test(value.token||''))throw new Error('连接校验失败，请重试');
      token=value.token;await mount(value);
    }catch(error){status.textContent=error.message==='Failed to fetch'?'未能连接。请运行新版本机助手，核对端口；如浏览器询问本地网络权限，请允许本页面。':error.message;}
    finally{busy=false;button.disabled=false;}
  });
  document.getElementById('disconnect').addEventListener('click',async()=>{try{await request('/companion/disconnect',{});}finally{token='';assets.clear();location.reload();}});
  window.addEventListener('pagehide',()=>{if(token)void originalFetch(local+'/companion/disconnect',{method:'POST',mode:'cors',credentials:'omit',keepalive:true,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'}).catch(()=>{});});
  window.addEventListener('zm-companion-error',event=>notice(event.detail));
})();
