'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.handlers={};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(name,handler){this.handlers[name]=handler;}
}
async function render(manifest,{ok=true}={}){
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Node('div'));return nodes.get(id);};
  const window={fetch:async()=>({ok,json:async()=>manifest}),addEventListener(){}};
  const document={getElementById:get,createElement:tag=>new Node(tag)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/client.js'),'utf8'),{window,document,URL,AbortSignal,setTimeout,clearTimeout});
  await new Promise(resolve=>setImmediate(resolve));return nodes;
}
const release={platform:'darwin',arch:'arm64',status:'ready',url:'https://downloads.example.invalid/zm.zip',bytes:123456,sha256:'a'.repeat(64),apple_notarized:false};
const links=node=>[...(node.tag==='a'?[node]:[]),...node.children.flatMap(links)];
const text=node=>[node.textContent||'',...node.children.map(text)].join(' ');
test('只有已发布且含HTTPS、大小、SHA的对应平台包才展示下载，不把其他系统旧包替代',async()=>{
  const nodes=await render({version:'0.2.10',releases:[release]}),root=nodes.get('desktop-downloads'),anchors=links(root);
  assert.equal(anchors.length,1);assert.equal(anchors[0].href,release.url);assert.match(text(root),/尚未完成 Apple 公证/);assert.equal((text(root).match(/暂未发布可下载版本/g)||[]).length,2);
});
test('拒绝未发布、缺校验、非HTTPS或含凭据的下载信息',async()=>{
  for(const changes of [{status:'uploading'},{sha256:''},{bytes:0},{url:'javascript:alert(1)'},{url:'http://downloads.example.invalid/zm.zip'},{url:'https://user:password@downloads.example.invalid/zm.zip'}]){
    const nodes=await render({version:'0.2.10',releases:[{...release,...changes}]});assert.equal(links(nodes.get('desktop-downloads')).length,0);
  }
});
test('下载目录加载失败提供明确提示，网页连接仍保留',async()=>{
  const nodes=await render(null,{ok:false});assert.match(text(nodes.get('desktop-downloads')),/下载信息暂时不可用/);assert.equal(typeof nodes.get('connect').handlers.click,'function');
});
test('Windows测试包明确提示未实机验收和未签名，不标为完整验证',async()=>{
  const nodes=await render({version:'0.2.10',releases:[{...release,platform:'win32',arch:'x64',apple_notarized:undefined,authenticode_signed:false,validation:'not_live_tested'}]});
  const root=nodes.get('desktop-downloads');assert.equal(links(root).length,1);assert.match(text(root),/Windows 代码签名/);assert.match(text(root),/尚未完成对应系统的实机验收/);
});
