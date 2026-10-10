(() => {
  // The legacy service publishes Windows runtimes. Mac reinstalls use the
  // architecture-specific runtimes that are physically included in this app.
  if(window.xycutDesktop.platform==='darwin'){
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const runtime=url.pathname==='/api/app/ai-runtime'?'python':url.pathname==='/api/app/ffmpeg-runtime'?'ffmpeg':null;
      if(runtime&&url.hostname==='yushe.neirongpai.com')return new Response(JSON.stringify({enabled:true,version:'1.0.0',platform:'macos',arch:window.xycutDesktop.arch,download_url:location.origin+'/bundled/'+runtime,sha256:null}),{headers:{'Content-Type':'application/json'}});
      return nativeFetch(input,options);
    };
  }
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
    convertFileSrc:file=>location.origin+'/ai-editing/file?path='+encodeURIComponent(file),
    metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_name,id)=>listeners.delete(id)};
  const emit=(event,payload)=>{for(const[id,listener]of listeners)if(listener.event===event)callbacks.get(listener.callback)?.({event,id,payload});};
  window.xycutDesktop.onEvent(value=>emit(value.event,value.payload));
  for(const type of ['dragenter','dragover','dragleave','drop'])document.addEventListener(type,event=>{
    event.preventDefault();
    const name={dragenter:'enter',dragover:'over',dragleave:'leave',drop:'drop'}[type];
    const paths=type==='drop'?[...event.dataTransfer.files].map(file=>window.xycutDesktop.filePath(file)):[];
    emit('tauri://drag-'+name,{paths,position:{x:event.clientX,y:event.clientY}});
  });
})();
