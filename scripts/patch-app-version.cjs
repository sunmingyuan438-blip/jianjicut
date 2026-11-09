'use strict';
// 把恢复前端里写死的版本号（关于页、更新比较）改成 package.json 的版本。
// 打包时调用；可重复执行，版本相同则不改动文件。
const fs=require('node:fs'),path=require('node:path');
const VERSION=/^\d+\.\d+\.\d+$/;
function patchBundle(text,version){
  if(!VERSION.test(version))throw new Error('版本号格式无效：'+version);
  const current=/(,\w+="\/background\.jpg",\w+=")(\d+\.\d+\.\d+)(")/g;
  const defaults=/(=\{version:")(\d+\.\d+\.\d+)(",configVersion:)/g;
  if((text.match(current)||[]).length!==1||(text.match(defaults)||[]).length!==1)throw new Error('前端版本常量结构已变化，无法安全更新');
  text=text.replace(current,`$1${version}$3`).replace(defaults,`$1${version}$3`);
  // 旧的功能裁剪把启动时的更新检查替换成了 Ct(null)；恢复检查，并每 6 小时再查一次。
  if(text.split(DISABLED_CHECK).length===2)text=text.replace(DISABLED_CHECK,UPDATE_CHECK);
  if(!text.includes('Ed(Cb,'))throw new Error('前端更新检查结构已变化，无法恢复');
  // 原提示固定写“请按安装向导完成更新”；改为显示主进程返回的实际说明（Mac 自动重启、手动拖入等）。
  if(text.split(INSTALL_CALL).length===2)text=text.replace(INSTALL_CALL,INSTALL_CALL_WITH_MESSAGE);
  if(!text.includes(INSTALL_CALL_WITH_MESSAGE))throw new Error('前端更新安装调用结构已变化');
  return text;
}
const INSTALL_CALL='await U("download_and_open_update",{url:Qe.downloadUrl,fileName:Qe.fileName,sha256:Qe.sha256||null}),el("更新包已打开，请按安装向导完成更新。")';
const INSTALL_CALL_WITH_MESSAGE='const zmUpdate=await U("download_and_open_update",{url:Qe.downloadUrl,fileName:Qe.fileName,sha256:Qe.sha256||null});el(zmUpdate?.message||"更新包已打开，请按安装向导完成更新。")';
const DISABLED_CHECK='v.useEffect(()=>{Ct(null)},[])';
const UPDATE_CHECK='v.useEffect(()=>{let r=new AbortController;const g=()=>{r.abort();r=new AbortController;Ed(Cb,r.signal,"update info").then(S=>Ct(ex(S))).catch(S=>{S instanceof DOMException&&S.name==="AbortError"||console.warn("Failed to load update info",S)})};g();const S=setInterval(g,216e5);return()=>{clearInterval(S),r.abort()}},[])';
function patchAppVersion(frontend,version=require('../package.json').version){
  const dir=path.join(frontend,'assets');
  const main=fs.readdirSync(dir).filter(name=>name.endsWith('.js')&&fs.readFileSync(path.join(dir,name),'utf8').includes('"/background.jpg"'));
  if(main.length!==1)throw new Error('未找到唯一的前端主模块');
  const file=path.join(dir,main[0]),old=fs.readFileSync(file,'utf8'),next=patchBundle(old,version);
  if(next!==old)fs.writeFileSync(file,next);
  return {file,version,changed:next!==old};
}
module.exports={patchAppVersion,patchBundle};
if(require.main===module)console.log(JSON.stringify(patchAppVersion(path.resolve(process.argv[2]||'resources/frontend'),process.argv[3])));
