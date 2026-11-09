(() => {
  // Legacy account/share features stay disabled; updates are served by the main process.
  // Preserve saved user settings; never send legacy authentication requests.
  const featureFetch=window.fetch.bind(window);
  window.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    // 软件更新改由主进程读取 AI 超市平台的下载清单，网页本身不直接访问外部更新接口。
    if(url.hostname==='yushe.neirongpai.com'&&url.pathname==='/api/update'&&window.xycutDesktop?.browser)return new Response(JSON.stringify({enabled:false}),{headers:{'Content-Type':'application/json'}});
    if(url.hostname==='yushe.neirongpai.com'&&url.pathname==='/api/update'&&window.xycutDesktop?.invoke){
      try{return new Response(JSON.stringify(await window.xycutDesktop.invoke('check_app_update',{})),{headers:{'Content-Type':'application/json'}});}
      catch(error){return new Response(JSON.stringify({enabled:false,message:error?.message||'暂时无法检查更新'}),{headers:{'Content-Type':'application/json'}});}
    }
    if(['yushe.neirongpai.com','www.xycut.com','xycut.com'].includes(url.hostname)&&/^\/api\/(?:auth|pay|share-uploads|promotion-submissions|update)(?:\/|$)/.test(url.pathname)){
      return new Response(JSON.stringify({message:'登录、分享和更新功能已停用'}),{status:410,headers:{'Content-Type':'application/json'}});
    }
    return featureFetch(input,options);
  };
  // The legacy service publishes Windows runtimes. Mac reinstalls use the
  // architecture-specific runtimes that are physically included in this app.
  if(window.xycutDesktop.platform==='darwin'){
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const runtime=url.pathname==='/api/app/ai-runtime'?'python':url.pathname==='/api/app/ffmpeg-runtime'?'ffmpeg':null;
      if(runtime&&url.hostname==='yushe.neirongpai.com')return new Response(JSON.stringify({enabled:true,version:'1.0.0',platform:'macos',arch:window.xycutDesktop.arch,download_url:(window.xycutDesktop.localOrigin||location.origin)+'/bundled/'+runtime,sha256:null}),{headers:{'Content-Type':'application/json'}});
      return nativeFetch(input,options);
    };
  }
  const loadAccount=()=>{
    for(const name of ['account-ui','platform-ui','skill-ui']){
      const style=document.createElement('link');style.rel='stylesheet';style.href='/'+name+'.css';document.head.append(style);
      const script=document.createElement('script');script.src='/'+name+'.js';document.head.append(script);
    }
  };
  if(['interactive','complete'].includes(document.readyState))loadAccount();else document.addEventListener('DOMContentLoaded',loadAccount,{once:true});
  let nextId=1;
  const callbacks=new Map(),listeners=new Map();
  const invoke=async(name,args={})=>{
    if(name==='plugin:event|listen'){const id=nextId++;listeners.set(id,{event:args.event,callback:args.handler});return id;}
    if(name==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
    return window.xycutDesktop.invoke(name,JSON.parse(JSON.stringify(args)));
  };
  window.__TAURI_INTERNALS__={
    invoke,
    transformCallback:(callback,once=false)=>{const id=nextId++;callbacks.set(id,value=>{if(once)callbacks.delete(id);callback(value);});return id;},
    unregisterCallback:id=>callbacks.delete(id),
    convertFileSrc:file=>window.xycutDesktop.fileUrl?window.xycutDesktop.fileUrl(file):location.origin+'/ai-editing/file?path='+encodeURIComponent(file),
    metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_name,id)=>listeners.delete(id)};
  const emit=(event,payload)=>{for(const[id,listener]of listeners)if(listener.event===event)callbacks.get(listener.callback)?.({event,id,payload});};
  window.xycutDesktop.onEvent(value=>emit(value.event,value.payload));
  for(const type of ['dragenter','dragover','dragleave','drop'])document.addEventListener(type,async event=>{
    event.preventDefault();
    const name={dragenter:'enter',dragover:'over',dragleave:'leave',drop:'drop'}[type];
    let paths=[];
    try{if(type==='drop')paths=window.xycutDesktop.importFiles?await window.xycutDesktop.importFiles([...event.dataTransfer.files]):[...event.dataTransfer.files].map(file=>window.xycutDesktop.filePath(file));}
    catch(error){window.dispatchEvent(new CustomEvent('zm-companion-error',{detail:error.message}));return;}
    emit('tauri://drag-'+name,{paths,position:{x:event.clientX,y:event.clientY}});
  });
})();
