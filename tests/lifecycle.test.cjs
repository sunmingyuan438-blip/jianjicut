'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreMainWindow}=require('../desktop/lifecycle.cjs');
test('重复启动或协议打开恢复最小化窗口并聚焦，未创建/已销毁窗口安全跳过',()=>{
  const calls=[];restoreMainWindow(null);restoreMainWindow({isDestroyed:()=>true});
  restoreMainWindow({isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')});assert.deepEqual(calls,['restore','show','focus']);
  calls.length=0;restoreMainWindow({isMinimized:()=>false,show:()=>calls.push('show'),focus:()=>calls.push('focus')});assert.deepEqual(calls,['show','focus']);
});
