// Exercise the original React configuration dialog and desktop IPC with an
// isolated provider response. Never send a real API key or provider request.
const fs=require('node:fs');
const path=require('node:path');
exports.run=async({window,dataDir})=>{
  const requests=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(url!=='https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal')throw new Error('离线验收拒绝其他服务请求');
    if(options.headers.Authorization!=='Bearer fixture-desktop-test-key')throw new Error('离线验收仅允许测试用密钥');
    requests.push({url,method:options.method,body:JSON.parse(options.body)});
    return new Response(JSON.stringify({data:{embedding:[0.1,-0.2,0.3]}}),{status:200});
  };
  const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
  async function click(selector){await window.webContents.executeJavaScript(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('找不到界面控件 '+${JSON.stringify(selector)});element.click();})()`);await pause();}
  async function fill(value){await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('.third-party-api-editor-modal input[placeholder="参数值"]');if(!input)throw new Error('找不到 KEY 编辑框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause();}
  async function test(){await window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('.third-party-api-editor-modal button')].find(element=>element.textContent.trim()==='测试');if(!button)throw new Error('找不到测试按钮');button.click();})()`);await pause();}
  try{
    await window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(element=>element.textContent.replace(/\\s/g,'')==='AI剪辑');if(!button)throw new Error('找不到 AI 剪辑页面');button.click();})()`);await pause();
    await click('.ai-editing-settings-tab');
    await window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('.video-editing-setting-card')].find(element=>element.textContent.includes('豆包大模型 API'));if(!button)throw new Error('找不到豆包设置入口');button.click();})()`);await pause();
    await fill('');await test();
    const missingKeyMessage=await window.webContents.executeJavaScript('document.querySelector(".third-party-api-test-message")?.textContent');
    if(!missingKeyMessage?.includes('未填写密钥')||requests.length)throw new Error('未填写 KEY 的测试行为不正确');
    await fill('fixture-desktop-test-key');await test();
    let message='';const deadline=Date.now()+5000;
    while(Date.now()<deadline){message=await window.webContents.executeJavaScript('document.querySelector(".third-party-api-test-message")?.textContent');if(message?.includes('连接成功'))break;await pause();}
    const request=requests[0];
    const ok=message==='豆包多模态向量模型连接成功'&&requests.length===1&&request.method==='POST'&&request.body.model==='doubao-embedding-vision-251215'&&request.body.input?.[0]?.type==='text';
    let screenshotError=null;
    try{const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(dataDir,'screenshots/豆包连接测试.png'),screenshot.toPNG());}catch(error){screenshotError=error.message;}
    return {ok,live_provider_called:false,missing_key_message:missingKeyMessage,message,requests,screenshot_error:screenshotError};
  }finally{
    globalThis.fetch=originalFetch;
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify('[aria-label="关闭 AI 服务编辑"]')})?.click()`);
  }
};

// Verify the original settings switch controls the actual local Agent API.
exports.runSwitch=async({window,service,dataDir})=>{
  const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
  const checked=()=>window.webContents.executeJavaScript('document.querySelector(".settings-modal [role=switch]")?.getAttribute("aria-checked")');
  async function set(value){
    if(await checked()!==String(value))await window.webContents.executeJavaScript('document.querySelector(".settings-modal [role=switch]").click()');
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if(await checked()===String(value)&&service.apiContext.ai_editing_enabled===value)return;await pause();}
    throw new Error('AI 剪辑开关未同步至本地服务：'+value);
  }
  await window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(element=>element.textContent.trim()==='设置');if(!button)throw new Error('找不到设置页面');button.click();})()`);await pause();
  await window.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('.settings-overview-card')].find(element=>element.querySelector('strong')?.textContent==='启动 AI 剪辑');if(!card)throw new Error('找不到 AI 剪辑开关设置');card.querySelector('button').click();})()`);await pause();
  try{
    await set(true);await set(false);
    const response=await fetch(`http://127.0.0.1:${service.port}/ai-editing/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),disabled=await response.json();
    const health=await(await fetch(`http://127.0.0.1:${service.port}/health`)).json();
    if(response.status!==403||health.enabled!==false||!disabled.message.includes('AI 剪辑已关闭'))throw new Error('关闭开关后仍允许 Agent 生成');
    await set(true);
    const enabled=await(await fetch(`http://127.0.0.1:${service.port}/health`)).json();
    let screenshotError=null;try{fs.writeFileSync(path.join(dataDir,'screenshots/AI剪辑开关.png'),(await window.webContents.capturePage()).toPNG());}catch(error){screenshotError=error.message;}
    return {ok:enabled.enabled===true,disabled_generate_status:response.status,disabled_message:disabled.message,enabled_after_toggle:enabled.enabled,screenshot_error:screenshotError};
  }finally{await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify('[aria-label="关闭设置"]')})?.click()`);}
};
