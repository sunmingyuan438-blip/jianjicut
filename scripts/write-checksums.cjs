const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
async function main(){
  const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
  const names=[`XYCut-restored-${version}-Windows-x64-Setup.exe`,...['arm64','x64'].map(arch=>`XYCut-restored-${version}-macOS-${arch}-TEST.zip`),`XYCut-restored-${version}-source.zip`];
  const sums=await Promise.all(names.map(async name=>{const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(path.join(root,'dist',name)))hash.update(bytes);return hash.digest('hex')+'  '+name;}));
  fs.writeFileSync(path.join(root,'dist/SHA256SUMS.txt'),sums.join('\n')+'\n');
  console.log(sums.join('\n'));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
