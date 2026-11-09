'use strict';
// 掌门cut 红色主题：把恢复前端里的青色系（原 XYCut 主色 #00c1cd 及其深浅变体）
// 按色相映射为 Logo 同色系的红色，保留原来的明暗层级；中性灰、成功绿、链接蓝不动。
// 打包时调用，可重复执行。
const fs=require('node:fs'),path=require('node:path');
const MARKER='/* zhangmen-theme-red-v2 */';
const RED_HUE=358/360;
// 主色几档单独指定，保证按钮、选中态和文字对比度。
const EXPLICIT={
  '00c1cd':'d7262b', // 主色 --accent
  '00aab4':'b81d22', // --accent-strong / 悬停
  '008f98':'a3191d', // --accent-text（浅色模式文字）
  '00bfcb':'d7262b','00b7c2':'cf2429','00b7c8':'cf2429','00aeb9':'c42227','00a8b5':'bd2025','00a2ad':'b81d22',
  '0badb7':'c42227','03969f':'a91b20','0097a7':'a91b20','087d86':'8f171b','087f8c':'8f171b','07848e':'94181c','078da2':'a3191d','087d89':'8f171b',
  '00b9c8':'cf2429','00b7c5':'cf2429','00a9b9':'bd2025',
};
function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;if(max===min)return[0,0,l];const d=max-min,s=l>0.5?d/(2-max-min):d/(max+min);let h=max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4;return[h/6,s,l];}
function hslToRgb(h,s,l){if(s===0){const v=Math.round(l*255);return[v,v,v];}const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;const f=t=>{t=(t+1)%1;return t<1/6?p+(q-p)*6*t:t<1/2?q:t<2/3?p+(q-p)*(2/3-t)*6:p;};return[f(h+1/3),f(h),f(h-1/3)].map(v=>Math.round(v*255));}
// 青色：色相约 170°–195°、饱和度足够；偏蓝的灰色与绿色不在此范围。
// 深色模式里带青色调的深灰（饱和度低）也一并换成暖灰，避免红色旁边透出青绿。
function isCyan(r,g,b){const[h,s,l]=rgbToHsl(r,g,b);return h>=170/360&&h<=195/360&&l>0.04&&l<0.997&&(s>=0.25||(s>=0.08&&l<0.35));}
function mapRgb(r,g,b){const[,s,l]=rgbToHsl(r,g,b);return hslToRgb(RED_HUE,Math.min(s,0.82),l);}
const hex=v=>v.map(n=>n.toString(16).padStart(2,'0')).join('');
// 支持 #rgb、#rgba、#rrggbb、#rrggbbaa；透明度原样保留。
function mapHex(value){
  let h=value.toLowerCase();if(h.length<=4)h=h.split('').map(c=>c+c).join('');
  const color=h.slice(0,6),alpha=h.slice(6);
  if(EXPLICIT[color])return EXPLICIT[color]+alpha;
  const rgb=[0,2,4].map(i=>parseInt(color.slice(i,i+2),16));
  return isCyan(...rgb)?hex(mapRgb(...rgb))+alpha:null;
}
function recolor(css){
  let count=0;
  css=css.replace(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,(all,h)=>{const next=mapHex(h);if(!next)return all;count++;return '#'+next;});
  css=css.replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(\s*,\s*[\d.]+)?\s*\)/g,(all,r,g,b,a)=>{
    const rgb=[r,g,b].map(Number);if(!isCyan(...rgb))return all;count++;const n=mapRgb(...rgb);return a?`rgba(${n.join(',')}${a.replace(/\s/g,'')})`:`rgb(${n.join(',')})`;
  });
  return {css,count};
}
function patchTheme(frontend){
  const dir=path.join(frontend,'assets');
  const files=fs.readdirSync(dir).filter(n=>n.endsWith('.css'));
  if(!files.length)throw new Error('未找到前端样式文件');
  let total=0;
  for(const name of files){
    const file=path.join(dir,name),old=fs.readFileSync(file,'utf8');
    if(old.startsWith(MARKER))continue;
    if(old.startsWith('/* zhangmen-theme-red-'))throw new Error('前端样式已被旧版主题补丁处理，请从未处理的底包重新构建');
    const {css,count}=recolor(old);total+=count;
    fs.writeFileSync(file,MARKER+'\n'+css);
  }
  return {frontend,replaced:total};
}
module.exports={patchTheme,recolor,mapHex,isCyan,MARKER};
if(require.main===module)console.log(JSON.stringify(patchTheme(path.resolve(process.argv[2]||'resources/frontend'))));
