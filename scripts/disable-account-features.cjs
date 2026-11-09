const fs = require('node:fs');
const path = require('node:path');
const marker = '/* zhangmen-local-features */';
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('功能裁剪标记缺失或不唯一：' + before.slice(0, 100));
  return text.replace(before, after);
}
function patchBundle(text) {
  if (text.includes(marker)) return text;
  text = once(text, 'const[c,o]=v.useState("home"),', 'const[c,zhangmenSetNav]=v.useState("home"),o=v.useCallback(next=>zhangmenSetNav(previous=>{const target=typeof next==="function"?next(previous):next;return ["account","share","about"].includes(target)?"home":target}),[]),');
  text = once(text, '[qe,tc]=v.useState(()=>localStorage.getItem(vd)??""),', '[qe,tc]=v.useState(""),');
  const navStart = 'children:Qg.map(r=>';
  const begin = text.indexOf(navStart);
  const navEnd = ']},r.id)})})';
  const end = text.indexOf(navEnd, begin);
  if (begin < 0 || end < 0 || end - begin > 2500) throw new Error('辅助导航结构不匹配');
  const replacement = 'children:l.jsx("button",{className:"rail-button restart-jianying-button",onMouseDown:r=>r.stopPropagation(),onClick:()=>Js(!0),title:"打开/重启剪映","aria-label":"打开/重启剪映",children:l.jsxs(v.Fragment,{children:[l.jsx(_b,{size:17}),l.jsx("span",{className:"rail-button-label",children:"重启剪映"})]})})';
  text = text.slice(0,begin) + replacement + '})' + text.slice(end+navEnd.length);
  const nav = /Qg=\[\{id:"account",label:"我的",icon:L1\},\{id:"share",label:"[^"]+",icon:n1\},\{id:"about",label:"更新",icon:vl\}\]/;
  const oldNav = text.match(nav)?.[0];
  if (!oldNav) throw new Error('辅助导航定义不匹配');
  text = once(text, oldNav, 'Qg=[]');
  text = once(text, 'At=c==="about",vs=c==="import",Ll=c==="share",fl=c==="account",', 'At=!1,vs=c==="import",Ll=!1,fl=!1,');
  // 软件更新不再停用：检查由 bridge 转给主进程读取 AI 超市的下载清单（见 desktop/updater.cjs）。
  return marker + '\n' + text;
}
function disableAccountFeatures(frontend) {
  let count=0;
  for (const name of fs.readdirSync(path.join(frontend,'assets')).filter(name=>name.endsWith('.js'))) {
    const file=path.join(frontend,'assets',name),text=fs.readFileSync(file,'utf8');
    if (!text.includes('function px(){') && !text.includes(marker)) continue;
    fs.writeFileSync(file,patchBundle(text)); count++;
  }
  if(count!==1) throw new Error('未找到唯一的主界面模块');
}
module.exports={disableAccountFeatures,patchBundle};
if(require.main===module)disableAccountFeatures(path.resolve(process.argv[2]||'resources/frontend'));
