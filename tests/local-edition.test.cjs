const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Service}=require('../backend/service.cjs');

test('没有主进程更新器时不能下载或打开更新包，分享命令保持停用',async()=>{
  const service=Object.create(Service.prototype);
  service.desktop={openPath(){throw new Error('不应打开文件');}};
  // 更新只能由主进程 desktop/updater.cjs 按 AI 超市清单下载；渲染进程传入的地址不会被直接使用。
  await assert.rejects(service.invoke('download_and_open_update',{url:'https://fixture.invalid/setup.exe'}),/不支持自动更新/);
  await assert.rejects(service.invoke('upload_share_source',{path:'/private/not-readable.zip'}),/分享功能已停用/);
});
for(const platform of ['darwin','win32'])test(`${platform} 停用账户/支付/推广/更新请求，保留素材及自有 API`,async()=>{
  const requests=[];
  const window={fetch:async(input)=>{requests.push(String(input));return new Response('{}');},xycutDesktop:{platform,arch:'arm64',onEvent(){}}};
  const context={window,document:{addEventListener(){}},location:{href:'http://127.0.0.1:17652/',origin:'http://127.0.0.1:17652'},URL,Response,Map};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/bridge.js'),'utf8'),context);
  for(const route of ['/api/auth/sms/send-code','/api/auth/sms/login','/api/auth/me','/api/pay/products','/api/share-uploads','/api/promotion-submissions','/api/update']){
    const response=await window.fetch('https://yushe.neirongpai.com'+route);
    assert.equal(response.status,410);assert.match((await response.json()).message,/已停用/);
  }
  assert.equal(requests.length,0);
  for(const route of ['https://yushe.neirongpai.com/api/templates/download','https://yushe.neirongpai.com/api/presets','https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'])await window.fetch(route);
  assert.equal(requests.length,3);
});
