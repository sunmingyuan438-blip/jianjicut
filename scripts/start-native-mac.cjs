// Development/test entry point uses the native runtime, never the Windows
// resources retained in the portable source delivery.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
function main(){
  if(process.platform!=='darwin')throw new Error('start:mac / test:mac 需要在 Mac 上执行');
  if(!['arm64','x64'].includes(process.arch))throw new Error('Mac 仅支持 Apple Silicon 和 Intel');
  const root=path.resolve(__dirname,'..'),options=process.argv.slice(2);
  if(options.some(option=>!['--test','--smoke-test'].includes(option))||options.length>1)throw new Error('可选参数为 --test 或 --smoke-test');
  const shared=spawnSync(process.execPath,[path.join(__dirname,'prepare-resources.cjs')],{cwd:root,stdio:'inherit'});
  if(shared.error)throw shared.error;
  if(shared.status!==0)throw new Error('共享界面和草稿资源同步失败');
  const prepared=spawnSync('python3',[path.join(__dirname,'prepare-mac-runtime.py'),process.arch],{cwd:root,stdio:'inherit'});
  if(prepared.error)throw new Error('无法运行 Python 3：'+prepared.error.message);
  if(prepared.status!==0)throw new Error('Mac 原生运行组件准备失败');
  const stage=path.join(root,'.test-data','mac-stage-'+process.arch),dataRoot=path.join(root,'.test-data','mac-data-'+process.arch),env={...process.env,XYCUT_RESOURCES:path.join(stage,'resources'),XYCUT_DATA_DIR:dataRoot,XYCUT_PORT:'17662',PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'};
  const testing=options.includes('--test');
  const executable=testing?process.execPath:path.join(stage,'electron/Electron.app/Contents/MacOS/Electron');
  const args=testing?['--test',...fs.readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.test.cjs')).map(name=>path.join(root,'tests',name))]:[root,...options];
  const result=spawnSync(executable,args,{cwd:root,env,stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}
main();
