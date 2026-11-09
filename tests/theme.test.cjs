'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {recolor,mapHex,patchTheme,MARKER}=require('../scripts/patch-theme.cjs');

test('主色几档映射为 Logo 同色系红色',()=>{
  assert.equal(mapHex('00c1cd'),'d7262b');
  assert.equal(mapHex('00AAB4'),'b81d22');
  assert.equal(mapHex('008f98'),'a3191d');
});

test('带透明度的青色保留透明度，浅色与深色变体按明暗映射',()=>{
  assert.equal(mapHex('00c1cd1f'),'d7262b1f');
  assert.equal(mapHex('e0fafb'),'fbe0e1');
  assert.equal(mapHex('343f40'),'403434','深色模式青灰换成暖灰');
});

test('中性灰、成功绿、链接蓝、白色与黑色不改',()=>{
  for(const value of ['dce2ef','303241','047857','0c8a58','2469cf','fff','000000','f6f7fb','b42318'])assert.equal(mapHex(value),null,value);
});

test('rgba 与多种写法一并替换',()=>{
  const {css,count}=recolor('a{color:#00c1cd;border:1px solid #0c1;box-shadow:0 0 0 2px rgba(8,188,202,.24)}b{color:#303241}');
  assert.equal(count,2);
  assert.match(css,/color:#d7262b/);assert.match(css,/rgba\(\d+,\d+,\d+,\.24\)/);assert.match(css,/#303241/);
  assert.doesNotMatch(css,/8,188,202/);
});

test('打包补丁可重复执行，处理后不再残留青色',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zm-theme-'));fs.mkdirSync(path.join(dir,'assets'));
  const file=path.join(dir,'assets/index.css');fs.writeFileSync(file,':root{--accent: #00c1cd;--accent-soft: #e0fafb}.x{box-shadow:0 0 0 1px #00c1cd1f}');
  assert.equal(patchTheme(dir).replaced,3);
  const once=fs.readFileSync(file,'utf8');assert.ok(once.startsWith(MARKER));assert.doesNotMatch(once,/00c1cd/i);
  assert.equal(patchTheme(dir).replaced,0);assert.equal(fs.readFileSync(file,'utf8'),once);
});

test('真实前端样式处理后没有残留青色主色',{skip:!fs.existsSync(path.join(__dirname,'../.test-data/motiontemplates-sync-20261016/掌门cut本机助手-Motion模板-新版.app'))},()=>{
  const dir=path.join(__dirname,'../.test-data/motiontemplates-sync-20261016/掌门cut本机助手-Motion模板-新版.app/Contents/Resources/xycut/frontend/assets');
  const name=fs.readdirSync(dir).find(n=>n.endsWith('.css'));
  const {css,count}=recolor(fs.readFileSync(path.join(dir,name),'utf8'));
  assert.ok(count>100);assert.doesNotMatch(css,/#00c1cd|#00aab4|#008f98|8,188,202/i);
});

test('自带的界面样式已是红色系',()=>{
  for(const file of ['desktop/account-ui.css','desktop/platform-ui.css','desktop/skill-ui.css','web/style.css','web/downloads.css']){
    assert.equal(recolor(fs.readFileSync(path.join(__dirname,'..',file),'utf8')).count,0,file+' 仍有青色');
  }
});
