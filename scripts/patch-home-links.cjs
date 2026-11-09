'use strict';
const fs=require('node:fs'),path=require('node:path');
const website='https://zhangmencut.app.aigzm.com/';
const marker='/* zhangmen-home-links-v1 */';
function replaceOnce(text,before,after){
  if(text.split(before).length!==2)throw new Error('首页结构已变化，无法安全更新：'+before.slice(0,90));
  return text.replace(before,after);
}
function patchBundle(text){
  if(text.includes(marker))return text;
  // Use the current product URL directly, including when legacy remote config
  // or a cached setting still supplies the previous product website.
  text=replaceOnce(text,'onClick:()=>{c&&h(c)},children:"产品官网"',`onClick:()=>h(${JSON.stringify(website)}),children:"产品官网"`);
  text=replaceOnce(text,',o?l.jsx("button",{type:"button",onClick:()=>B(!0),children:"加微信进交流群"}):null','');
  text=replaceOnce(text,',O&&l.jsx("div",{className:"confirm-overlay settings-modal-overlay",onClick:()=>B(!1),children:l.jsxs("div",{className:"settings-modal home-community-modal",onClick:ie=>ie.stopPropagation(),children:[l.jsx("div",{className:"settings-modal-header",children:l.jsxs("div",{children:[l.jsx("strong",{children:f||"加微信进交流群"}),l.jsx("span",{children:"扫码添加微信，加入交流群"})]})}),l.jsx("div",{className:"home-community-qr",children:l.jsx("img",{src:o,alt:f||"交流群"})})]})})','');
  text=text.replace(/websiteUrl:"https:\/\/yushe\.neirongpai\.com\/admin\/"/g,`websiteUrl:${JSON.stringify(website)}`)
    .replace(/communityQrUrl:"https:\/\/presets\.xycut\.com\/down\/appbanner\/community-qr\.jpg"/g,'communityQrUrl:""');
  return marker+'\n'+text;
}
function patchHomeLinks(frontend){
  const files=fs.readdirSync(path.join(frontend,'assets')).filter(name=>name.endsWith('.js'));
  const main=files.filter(name=>{const t=fs.readFileSync(path.join(frontend,'assets',name),'utf8');return t.includes('className:"home-brand-links"');});
  if(main.length!==1)throw new Error('未找到唯一的首页界面模块');
  const file=path.join(frontend,'assets',main[0]),old=fs.readFileSync(file,'utf8'),next=patchBundle(old);
  if(next!==old)fs.writeFileSync(file,next);
  return {file,website,community_removed:true};
}
module.exports={patchHomeLinks,patchBundle,website};
if(require.main===module)console.log(JSON.stringify(patchHomeLinks(path.resolve(process.argv[2]||'resources/frontend'))));
