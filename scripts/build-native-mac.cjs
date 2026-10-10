const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {build,Platform,Arch}=require('electron-builder');
async function main(){
  if(process.platform!=='darwin')throw new Error('请在 Mac 上运行原生构建；Windows 可运行 package-mac.py 生成未验证测试包');
  const root=path.resolve(__dirname,'..');
  const shared=spawnSync(process.execPath,[path.join(__dirname,'prepare-resources.cjs')],{cwd:root,stdio:'inherit'});
  if(shared.error)throw shared.error;
  if(shared.status!==0)throw new Error('共享界面和草稿资源同步失败');
  const architectures=process.argv.slice(2).length?process.argv.slice(2):['arm64','x64'];
  for(const arch of architectures){
    if(!['arm64','x64'].includes(arch))throw new Error('架构只支持 arm64 或 x64');
    const prepared=spawnSync('python3',[path.join(__dirname,'prepare-mac-runtime.py'),arch],{cwd:root,stdio:'inherit'});
    if(prepared.status!==0)throw new Error('Mac 运行组件准备失败');
    const stage=path.join(root,'.test-data','mac-stage-'+arch);
    await build({projectDir:root,targets:Platform.MAC.createTarget('zip',Arch[arch]),publish:'never',config:{electronDist:path.join(stage,'electron'),extraResources:[{from:path.join(stage,'resources'),to:'xycut',filter:['**/*','!**/__pycache__/**']}],mac:{identity:'-',hardenedRuntime:false,artifactName:'XYCut-restored-${version}-macOS-${arch}-LOCAL-TEST.${ext}'}}});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
