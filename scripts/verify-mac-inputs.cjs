const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, 'restoration-build.json'), 'utf8'));
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(archive)) throw new Error('请先构建当前 Windows app.asar，再打包 Mac 测试包');
const packagedMarker = path.join(root, 'dist', 'win-unpacked', 'resources', 'xycut', 'restoration-build.json');
if (!fs.existsSync(packagedMarker)) throw new Error('Windows 包缺少当前 restoration-build.json，请先重建 Windows 包');
const packagedBuild = JSON.parse(fs.readFileSync(packagedMarker, 'utf8'));
if (packagedBuild.id !== build.id) throw new Error(`app.asar 构建编号 ${packagedBuild.id} 与当前 ${build.id} 不一致，请先重建 Windows 包`);
const main = asar.extractFile(archive, 'desktop/main.cjs').toString('utf8');
const archiveFiles = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
if (!main.includes("require('./tray.cjs')") || !archiveFiles.includes('/desktop/tray.cjs')) {
  throw new Error('app.asar 没有当前托盘恢复代码，请先重建 Windows 包');
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
console.log(JSON.stringify({build_id: build.id, app_asar: path.relative(root, archive), app_asar_sha256: hash, tray_present: true, ok: true}));
