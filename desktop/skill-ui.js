(() => {
  'use strict';
  // 掌门独家剪辑 Skill：桌面端在左侧导航加入口，网页端 /skills 独立页面。
  const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const https=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
  async function copyText(value){
    try{await navigator.clipboard.writeText(value);return true;}catch{}
    const area=make('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();
    let ok=false;try{ok=document.execCommand('copy');}catch{}area.remove();return ok;
  }
  let catalog;
  async function loadCatalog(){
    if(window.xycutDesktop&&!window.xycutDesktop.browser){try{return await window.xycutDesktop.invoke('zhangmen_skill_catalog',{});}catch{}}
    const response=await fetch('/skill-catalog.json',{cache:'no-store'});if(!response.ok)throw new Error('Skill 目录暂时不可用');return response.json();
  }
  function buildPanel(container){
    const panel=make('section',null,'zm-skill-library');panel.setAttribute('aria-label','掌门独家剪辑 Skill');container.append(panel);
    const head=make('header',null,'zm-skill-heading');head.append(make('span','掌门独家','zm-skill-eyebrow'),make('h1','掌门独家剪辑 Skill'),make('p','掌门cut 官方出品的剪辑 Skill。选一个风格，复制提示词交给 Agent，就能按这套风格完成剪辑。'));
    if(container.tagName==='DIALOG'||String(container.tagName).toLowerCase()==='dialog'){const close=make('button','关闭','zm-skill-close');close.type='button';close.onclick=()=>container.close();head.append(close);}
    const controls=make('div',null,'zm-skill-filters'),query=make('input');query.type='search';query.placeholder='搜索 Skill';query.setAttribute('aria-label','搜索 Skill');
    const select=make('select');select.setAttribute('aria-label','Skill 分类');controls.append(query,select);
    const status=make('p','正在加载…','zm-skill-count');status.setAttribute('role','status');
    const grid=make('div',null,'zm-skill-grid');grid.setAttribute('aria-live','polite');
    panel.append(head,controls,status,grid);
    function paint(){
      grid.replaceChildren();if(!catalog)return;
      const needle=query.value.trim().toLocaleLowerCase();
      const rows=catalog.skills.filter(s=>(!select.value||s.category===select.value)&&(!needle||[s.name,s.summary,...s.tags].join(' ').toLocaleLowerCase().includes(needle)));
      controls.hidden=!catalog.skills.length;
      if(!catalog.skills.length){status.textContent='';grid.append(empty());return;}
      status.textContent=`共 ${catalog.skills.length} 个 Skill · 当前显示 ${rows.length} 个`;
      for(const row of rows)grid.append(card(row,status));
      if(!rows.length)grid.append(make('p','没有找到匹配的 Skill，试试其他关键词。','zm-skill-none'));
    }
    query.addEventListener('input',paint);select.addEventListener('change',paint);
    loadCatalog().then(value=>{
      catalog=value;select.replaceChildren(new Option('全部分类',''));
      for(const name of [...new Set(catalog.skills.map(s=>s.category).filter(Boolean))])select.append(new Option(name,name));
      paint();
    }).catch(error=>{status.textContent=error.message||'Skill 目录加载失败，请稍后重试';});
    return panel;
  }
  function empty(){
    const box=make('div',null,'zm-skill-empty');
    box.append(make('span','✦','zm-skill-empty-icon'),make('h2','首批独家 Skill 正在准备中'),make('p','上线后会出现在这里，软件更新后即可使用。'));
    return box;
  }
  function card(row,status){
    const article=make('article',null,'zm-skill-card');article.dataset.skillId=row.id;
    const media=make('div',null,'zm-skill-media');
    const cover=https(row.cover);
    if(cover){const img=make('img');img.src=cover;img.alt=row.name+' 封面';img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.remove());media.append(img);}
    else media.append(make('span',row.name.slice(0,2),'zm-skill-monogram'));
    const demo=https(row.demo);
    if(demo){const play=make('button','播放样片','zm-skill-play');play.type='button';play.addEventListener('click',()=>{
      document.querySelectorAll('.zm-skill-library video').forEach(v=>v.pause());
      const video=make('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.src=demo;if(cover)video.poster=cover;media.replaceChildren(video);void video.play().catch(()=>{});
    });media.append(play);}
    if(row.status==='coming_soon')media.append(make('span','即将上线','zm-skill-badge'));
    const body=make('div',null,'zm-skill-body');
    const title=make('h2',row.name);body.append(title);
    if(row.summary)body.append(make('p',row.summary,'zm-skill-summary'));
    const meta=make('div',null,'zm-skill-tags');for(const tag of [row.category,...row.tags].filter(Boolean))meta.append(make('span',tag));if(row.version)meta.append(make('span','v'+row.version,'zm-skill-version'));
    if(meta.childElementCount)body.append(meta);
    if(row.prompt&&row.status!=='coming_soon'){
      const copy=make('button','复制使用提示词','zm-skill-primary');copy.type='button';
      copy.addEventListener('click',async()=>{const ok=await copyText(row.prompt);copy.textContent=ok?'已复制':'复制失败，请重试';setTimeout(()=>{copy.textContent='复制使用提示词';},1800);});
      body.append(copy);
    }
    article.append(media,body);return article;
  }
  function launch(){
    let dialog=document.getElementById('zm-skill-dialog');
    if(!dialog){dialog=make('dialog');dialog.id='zm-skill-dialog';document.body.append(dialog);buildPanel(dialog);dialog.addEventListener('close',()=>dialog.querySelectorAll('video').forEach(v=>v.pause()));}
    dialog.showModal();
  }
  if(document.body.hasAttribute('data-skill-library')){buildPanel(document.getElementById('skill-library-root'));return;}
  const mount=()=>{const nav=document.querySelector('[aria-label="主导航"]');if(!nav||document.getElementById('zm-skill-button'))return;
    const button=make('button',null,'rail-button');button.id='zm-skill-button';button.type='button';button.setAttribute('aria-label','掌门独家剪辑 Skill');button.title='掌门独家剪辑 Skill';
    button.append(make('span','✦','zm-skill-icon'),make('span','独家Skill','rail-button-label'));button.addEventListener('click',launch);nav.append(button);
  };
  new MutationObserver(mount).observe(document.getElementById('root')||document.body,{childList:true,subtree:true});mount();
})();
