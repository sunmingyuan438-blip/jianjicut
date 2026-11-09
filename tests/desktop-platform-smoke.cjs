const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {write}=require('../backend/util.cjs');
// This smoke uses the real packaged app with no account service configured.
// It verifies navigation and fail-closed behavior; it never injects a user or bypasses membership.
exports.run=async({window,service,app,dataDir})=>{
 const errors=[],pages=[],checks={};
 window.webContents.setBackgroundThrottling(false);
 window.webContents.on('render-process-gone',(_e,d)=>errors.push(d.reason));
 window.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
 try{
  await new Promise(resolve=>setTimeout(resolve,1200));
  for(const label of ['首页','AI剪辑','爆款模板','素材库','在线预设','本地预设','收藏','设置']){
   const found=await window.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(label)});if(!e)return false;e.click();return true;})()`);
   await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   await new Promise(resolve=>setTimeout(resolve,700));
   const state=await window.webContents.executeJavaScript(`({text:document.body.innerText.slice(0,1800),title:document.title})`);
   assert.ok(found&&state.text.trim().length>20,label+' 未正常显示');
   fs.mkdirSync(path.join(dataDir,'screenshots'),{recursive:true});const image=(await window.webContents.capturePage()).toPNG();assert.ok(!pages.length||require('node:crypto').createHash('sha256').update(image).digest('hex')!==pages.at(-1).screenshot_sha256,label+' 截图未更新');fs.writeFileSync(path.join(dataDir,'screenshots',label+'.png'),image);pages.push({label,found,...state,screenshot_sha256:require('node:crypto').createHash('sha256').update(image).digest('hex')});
  }
  checks.platform_required=service.platformEnabled===true;assert.ok(checks.platform_required);
  for(const [label,fn]of [['draft_export',()=>service.generate({})],['library_create',()=>service.invoke('create_sucai_library',{name:'不应被创建'})],['ai_invoke',()=>service.platformInvoke({operation:'analyze',input:{}})]]){
   let denied=false;try{await fn();}catch(e){denied=true;checks[label]={denied,message:e.message};}assert.ok(denied,label+' 未拒绝无账户操作');
  }
  const exported=await service.context(),context=JSON.parse(fs.readFileSync(exported.agent_context_file,'utf8'));checks.agent_context_no_supplier_keys=Array.isArray(context.third_party_apis)&&context.third_party_apis.length===0;assert.ok(checks.agent_context_no_supplier_keys);
  await window.webContents.executeJavaScript(`document.querySelector('#zm-account-button').click()`);
  const account=await window.webContents.executeJavaScript(`({open:document.querySelector('#zm-account-dialog').open,text:document.querySelector('#zm-account-dialog').innerText,login_disabled:[...document.querySelectorAll('#zm-account-dialog button')].find(e=>e.textContent==='使用 AI 超市登录').disabled})`);
  assert.ok(account.open&&account.login_disabled);checks.account=account;
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,700));
  fs.writeFileSync(path.join(dataDir,'account-unconfigured.png'),(await window.webContents.capturePage()).toPNG());
 }catch(e){errors.push(e.stack||e.message);}
 const report={scope:'packaged_platform_unconfigured_fail_closed',platform:process.platform,arch:process.arch,resources:service.resources,data_dir:dataDir,pages,checks,errors,commandErrors:service.commandErrors,pass:pages.length===8&&errors.length===0};
 write(path.join(dataDir,'desktop-platform-smoke.json'),report);console.log(JSON.stringify({pass:report.pass,pages:pages.length,report:path.join(dataDir,'desktop-platform-smoke.json')}));app.exit(report.pass?0:1);
};
