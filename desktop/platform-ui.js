(() => {
  'use strict';
  const invoke=(name,args={})=>window.xycutDesktop.invoke(name,args);
  const legacyNames=new Set(['豆包语音 API','豆包大模型 API','可选 AI 服务接口']);
  const labels={analyze:'AI 分析与剪辑规划',embedding:'素材语义检索',asr_short:'短视频语音识别',asr_long:'长视频语音识别',image:'AI 生图'};
  let enabled=false,current=null,panel=null,loading=false,scheduled=false;
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  function paint(){
    if(!panel)return;
    const content=panel.querySelector('.zm-platform-content');content.replaceChildren();
    content.append(element('p','登录 AI 超市即可使用，无需填写 API Key。AI 调用按平台价格扣除当前登录用户的积分。'));
    const message=current?.authenticated?`已连接 AI 超市 · L${current.member_level??'—'} · 可用积分 ${current.available_points??'—'}`:current?.pending?'正在完成登录…':'请先登录 AI 超市账户';
    content.append(element('p',message,'zm-platform-account'));
    if(current?.error)content.append(element('p',current.error,'zm-platform-error'));
    if(current?.authenticated){
      const list=element('ul');
      for(const item of current.operations||[])list.append(element('li',`${labels[item.operation]||item.operation}：${item.available?(item.name||'平台统一提供'):'暂不可用'}`));
      content.append(list);
    }
    content.append(element('p','配音、声音克隆及素材搜索暂未接通平台，当前不可用。','zm-platform-muted'));
    content.append(element('p','本地套模板、素材管理和草稿导出按会员权限使用；不额外调用收费模型。','zm-platform-muted'));
    const actions=element('div',null,'zm-platform-actions');
    const account=element('button',current?.authenticated?'查看账户':'登录 AI 超市','install-button');account.type='button';account.addEventListener('click',()=>document.getElementById('zm-account-button')?.click());
    const refresh=element('button',loading?'刷新中…':'刷新模型与积分','ghost-button');refresh.type='button';refresh.disabled=loading;refresh.addEventListener('click',()=>update(true));
    actions.append(account,refresh);content.append(actions);
  }
  async function update(refresh=false){
    if(loading)return;loading=true;paint();
    try{current=await invoke('get_platform_service_status',{refresh});}
    catch(error){current={...current,error:error.message||'平台服务暂时无法连接，请稍后重试'};}
    finally{loading=false;paint();}
  }
  function sync(){
    scheduled=false;if(!enabled)return;
    for(const root of document.querySelectorAll('.video-editing-settings')){
      const legacy=[...root.querySelectorAll('.video-editing-settings-section')].filter(section=>[...section.querySelectorAll('button strong')].some(title=>legacyNames.has(title.textContent.trim())));
      for(const section of legacy)if(!section.classList.contains('zm-platform-legacy'))section.classList.add('zm-platform-legacy');
      if(!root.querySelector('.zm-platform-services')){
        panel=element('section',null,'zm-platform-services');panel.setAttribute('aria-label','AI 超市服务');
        panel.append(element('h3','AI 超市服务'),element('div',null,'zm-platform-content'));root.prepend(panel);paint();void update();
      }
    }
  }
  async function start(){
    const status=await invoke('account_sso_status').catch(()=>null);
    if(!status?.platform_mode)return;
    enabled=true;document.body.classList.add('zm-platform-edition');
    new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(sync);}}).observe(document.getElementById('root')||document.body,{childList:true,subtree:true});
    document.addEventListener('click',event=>{
      const title=event.target.closest?.('button')?.querySelector('strong');
      if(title&&legacyNames.has(title.textContent.trim())){event.preventDefault();event.stopImmediatePropagation();sync();}
    },true);
    document.addEventListener('close',event=>{if(event.target.id==='zm-account-dialog')void update(true);},true);
    sync();
  }
  void start();
})();
