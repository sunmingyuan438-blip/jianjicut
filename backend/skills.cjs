'use strict';
// 掌门独家剪辑 Skill 目录。数据来自 backend/skill-catalog.json，每个条目格式：
// {
//   "id": "dark-console-koubo",            // 小写字母、数字、连字符
//   "name": "暗色控制台口播",
//   "summary": "一句话说明适合什么视频",
//   "category": "口播包装",                 // 可选，用于分类筛选
//   "tags": ["竖屏", "科技风"],              // 可选
//   "version": "1.0.0",
//   "cover": "https://…/cover.jpg",          // 可选，HTTPS 图片
//   "demo": "https://…/demo.mp4",            // 可选，HTTPS 样片
//   "prompt": "调用 $dark-console-koubo，把我的口播视频…", // 可选，界面提供“复制使用提示词”
//   "status": "ready" | "coming_soon"
// }
const fs=require('node:fs'),path=require('node:path');
const ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
function https(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
function normalize(raw){
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.skills))throw new Error('Skill 目录格式无效');
  const seen=new Set();
  const skills=raw.skills.filter(item=>item&&ID.test(item.id)&&text(item.name,60)&&!seen.has(item.id)&&seen.add(item.id)).map(item=>({
    id:item.id,name:text(item.name,60),summary:text(item.summary,200),category:text(item.category,20),
    tags:Array.isArray(item.tags)?item.tags.map(t=>text(t,16)).filter(Boolean).slice(0,6):[],
    version:text(item.version,20),cover:https(item.cover),demo:https(item.demo),prompt:text(item.prompt,4000),
    status:item.status==='coming_soon'?'coming_soon':'ready',
  }));
  return {schema_version:1,title:text(raw.title,40)||'掌门独家剪辑 Skill',description:text(raw.description,200),updated_at:text(raw.updated_at,20),skills};
}
function catalog(){return normalize(JSON.parse(fs.readFileSync(path.join(__dirname,'skill-catalog.json'),'utf8')));}
module.exports={catalog,normalize};
