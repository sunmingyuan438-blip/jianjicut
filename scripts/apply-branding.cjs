const fs=require('node:fs');
const path=require('node:path');
const name='掌门cut';
const assets=path.resolve(__dirname,'../branding/zhangmen');
function brandText(text){
  return text.replace(/小圆\s*XYCut\s*/g,name).replace(/XYCut 恢复版/g,name).replace(/小圆/g,name).replace(/XYCut(?=[\s"'<])/g,name);
}
function walk(root){if(!fs.existsSync(root))return [];return fs.readdirSync(root,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(root,x.name)):[path.join(root,x.name)]);}
function applyBranding(resources){
 const front=path.join(resources,'frontend');
 for(const dir of [front,path.join(resources,'agent-kit/tools/editing-workbench/public'),path.join(resources,'video-template-preview')]){
  for(const file of walk(dir)){
   if(!/\.(html|js|css)$/.test(file))continue;
   const old=fs.readFileSync(file,'utf8');
   let next=brandText(old).replaceAll('/xycut-banner.gif','/brand-banner.svg').replaceAll('/xycut-hero.jpg','/brand-banner.svg').replaceAll('children:"xycut.com"','children:"产品官网"');
   if(file.endsWith('.css')) {
     next=next.replace(/background:url\(\/(?:xycut-hero\.jpg|brand-banner\.svg)\) center top \/ cover no-repeat/g,'background:linear-gradient(180deg,#fff5f4 0%,#f6f8fc 48%)');
     if(next.includes('.home-banner{')&&!next.includes('/* zhangmen-brand */'))next+='\n/* zhangmen-brand */\n.home-banner{flex-wrap:wrap;gap:10px;margin:12px 0 16px;padding:10px 0;}.home-banner img{width:100%;max-width:380px;max-height:none;height:auto;}.home-brand-links{width:100%;flex-direction:row;justify-content:center;gap:18px;}\n';
   }
   if(next!==old)fs.writeFileSync(file,next);
  }
 }
 fs.copyFileSync(path.join(assets,'icon-512.png'),path.join(front,'icon.png'));
 fs.copyFileSync(path.join(assets,'icon-512.png'),path.join(front,'brand-logo.png'));
 fs.copyFileSync(path.join(assets,'icon.ico'),path.join(front,'icon.ico'));
 fs.copyFileSync(path.join(assets,'icon.icns'),path.join(front,'icon.icns'));
 const base64=fs.readFileSync(path.join(assets,'icon-512.png')).toString('base64');
 fs.writeFileSync(path.join(front,'brand-banner.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="280" viewBox="0 0 960 280"><rect width="960" height="280" rx="28" fill="#fff5f4"/><image href="data:image/png;base64,${base64}" x="46" y="28" width="224" height="224"/><text x="310" y="144" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="66" font-weight="700" fill="#25232a">掌门cut</text><text x="313" y="196" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="25" fill="#71666a">让剪辑更简单</text></svg>`);
 // Replace copied workbench icons too; keep resource names stable for existing clients.
 for(const file of walk(path.join(resources,'agent-kit/tools/editing-workbench/public'))){if(/(?:app-icon|logo|icon)\.png$/.test(path.basename(file)))fs.copyFileSync(path.join(assets,'icon-512.png'),file);}
 require('./patch-home-links.cjs').patchHomeLinks(front);
 return {name,resources};
}
module.exports={applyBranding,brandText};
if(require.main===module)console.log(JSON.stringify(applyBranding(path.resolve(process.argv[2]||'resources'))));
