const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {inspectResourceRoot, resolveResources, requiredResources, resourceCandidates} = require('../desktop/resources.cjs');

function makeResources(platform, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  for (const [relative, kind] of requiredResources(platform)) {
    const target = path.join(root, relative);
    if (kind === 'directory') fs.mkdirSync(target, {recursive: true});
    else { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'fixture'); }
  }
  return root;
}

test('Mac resources resolve from an explicit Chinese path containing spaces', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'XYCut 中文 路径 '));
  const root = path.join(parent, '应用资源');
  fs.mkdirSync(root, {recursive: true});
  for (const [relative, kind] of requiredResources('darwin')) {
    const target = path.join(root, relative);
    if (kind === 'directory') fs.mkdirSync(target, {recursive: true});
    else { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'fixture'); }
  }
  assert.equal(resolveResources({platform: 'darwin', env: {XYCUT_RESOURCES: root}, dirname: parent}), root);
  fs.rmSync(parent, {recursive: true, force: true});
});

test('packaged Mac resources prefer process.resourcesPath/xycut', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-packaged-'));
  const resourcesPath = path.join(root, 'Resources');
  const packagedRoot = path.join(resourcesPath, 'xycut');
  fs.mkdirSync(packagedRoot, {recursive: true});
  for (const [relative, kind] of requiredResources('darwin')) {
    const target = path.join(packagedRoot, relative);
    if (kind === 'directory') fs.mkdirSync(target, {recursive: true});
    else { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'fixture'); }
  }
  const appPath = path.join(resourcesPath, 'app.asar');
  fs.mkdirSync(appPath, {recursive: true});
  const resolved = resolveResources({
    platform: 'darwin',
    app: {isPackaged: true, getAppPath: () => appPath},
    env: {},
    resourcesPath,
    dirname: path.join(root, 'desktop'),
  });
  // The host process.resourcesPath is not controllable in a unit test. The
  // app-path sibling fallback remains deterministic and is covered here.
  assert.equal(resolved, path.join(resourcesPath, 'xycut'));
  assert.ok(inspectResourceRoot(resolved, 'darwin').valid);
  fs.rmSync(root, {recursive: true, force: true});
});

test('Mac development mode resolves app.getAppPath()/resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-dev-中文 路径-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, {recursive: true});
  for (const [relative, kind] of requiredResources('darwin')) {
    const target = path.join(resources, relative);
    if (kind === 'directory') fs.mkdirSync(target, {recursive: true});
    else { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'fixture'); }
  }
  assert.equal(resolveResources({platform: 'darwin', app: {isPackaged: false, getAppPath: () => root}, env: {}, dirname: root}), resources);
  fs.rmSync(root, {recursive: true, force: true});
});

test('Windows resource contract uses Windows runtime and executable names', () => {
  const root = makeResources('win32', 'xycut-win-');
  const check = inspectResourceRoot(root, 'win32');
  assert.equal(check.valid, true);
  assert.ok(fs.existsSync(path.join(root, 'python', 'python.exe')));
  assert.ok(fs.existsSync(path.join(root, 'ffmpeg', 'ffmpeg.exe')));
  assert.ok(fs.existsSync(path.join(root, 'ffmpeg', 'ffprobe.exe')));
  fs.rmSync(root, {recursive: true, force: true});
});

test('missing resources report every required relative path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-missing-'));
  assert.throws(() => resolveResources({platform: 'darwin', env: {XYCUT_RESOURCES: root}, dirname: root}), error => {
    assert.equal(error.code, 'XYCUT_RESOURCES_INVALID');
    assert.match(error.message, /frontend\/index\.html/);
    assert.match(error.message, /core_worker\.py/);
    assert.match(error.message, /python[\\/]bin[\\/]python3\.9/);
    assert.match(error.message, /ffmpeg[\\/]ffprobe/);
    return true;
  });
  fs.rmSync(root, {recursive: true, force: true});
});

function fillResources(root, platform) {
  for (const [relative, kind] of requiredResources(platform)) {
    const target = path.join(root, relative);
    if (kind === 'directory') fs.mkdirSync(target, {recursive: true});
    else { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'fixture'); }
  }
  return root;
}

test('required resource contract names the runtime files for each platform', () => {
  const names = platform => requiredResources(platform).map(([relative]) => relative.split(path.sep).join('/'));
  for (const name of ['frontend/index.html', 'core_worker.py', 'python/bin/python3.9', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) assert.ok(names('darwin').includes(name), name);
  for (const name of ['frontend/index.html', 'core_worker.py', 'python/python.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe']) assert.ok(names('win32').includes(name), name);
  assert.ok(!names('win32').some(name => name.includes('python3.9')));
  assert.ok(!names('darwin').some(name => name.endsWith('.exe')));
});

test('Mac .app launched directly (isPackaged=false) still uses process.resourcesPath/xycut', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'XYCut 恢复版 '));
  const resourcesPath = path.join(root, 'XYCut 恢复版.app', 'Contents', 'Resources');
  const packagedRoot = fillResources(path.join(resourcesPath, 'xycut'), 'darwin');
  const resolved = resolveResources({
    platform: 'darwin',
    // Electron's default_app or a direct binary launch may report an
    // unrelated app path; the bundled Resources directory must still win.
    app: {isPackaged: false, getAppPath: () => path.join(root, 'elsewhere')},
    env: {},
    resourcesPath,
    dirname: path.join(root, 'elsewhere', 'desktop'),
  });
  assert.equal(resolved, packagedRoot);
  fs.rmSync(root, {recursive: true, force: true});
});

test('an invalid XYCUT_RESOURCES override falls through to the packaged Mac resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-override-'));
  const broken = path.join(root, '空 目录');
  fs.mkdirSync(broken, {recursive: true});
  const resourcesPath = path.join(root, 'Resources');
  const packagedRoot = fillResources(path.join(resourcesPath, 'xycut'), 'darwin');
  const options = {platform: 'darwin', app: {isPackaged: true, getAppPath: () => path.join(resourcesPath, 'app.asar')}, env: {XYCUT_RESOURCES: broken}, resourcesPath, dirname: path.join(root, 'desktop')};
  assert.equal(resourceCandidates(options)[0], broken);
  assert.equal(resolveResources(options), packagedRoot);
  fs.rmSync(root, {recursive: true, force: true});
});

test('Windows packaged and development candidates keep drive letters, spaces and Chinese names', () => {
  const win = path.win32;
  const install = 'C:\\Program Files\\XYCut 恢复版';
  const packaged = resourceCandidates({
    pathModule: win,
    app: {isPackaged: true, getAppPath: () => `${install}\\resources\\app.asar`},
    env: {},
    resourcesPath: `${install}\\resources`,
    dirname: `${install}\\resources\\app.asar\\desktop`,
  });
  assert.equal(packaged[0], `${install}\\resources\\xycut`);
  for (const candidate of packaged) {
    assert.match(candidate, /^C:\\/);
    assert.ok(!candidate.includes('/'), candidate);
  }
  const source = 'D:\\开发 目录\\jianjicut-main';
  const development = resourceCandidates({
    pathModule: win,
    app: {isPackaged: false, getAppPath: () => source},
    env: {XYCUT_RESOURCES: 'D:/临时 资源/xycut'},
    resourcesPath: `${source}\\node_modules\\electron\\dist\\resources`,
    dirname: `${source}\\desktop`,
  });
  assert.equal(development[0], 'D:\\临时 资源\\xycut');
  assert.ok(development.includes(`${source}\\resources`));
  assert.equal(new Set(development).size, development.length);
});

test('missing Windows resources list every candidate and the .exe runtime names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-win-missing-'));
  const override = path.join(root, 'override');
  fs.mkdirSync(override);
  const resourcesPath = path.join(root, 'resources');
  assert.throws(() => resolveResources({platform: 'win32', app: {isPackaged: true, getAppPath: () => path.join(resourcesPath, 'app.asar')}, env: {XYCUT_RESOURCES: override}, resourcesPath, dirname: path.join(root, 'desktop')}), error => {
    assert.equal(error.code, 'XYCUT_RESOURCES_INVALID');
    assert.ok(error.candidates.length >= 2);
    for (const check of error.candidates) {
      assert.ok(error.message.includes(check.root), check.root);
      assert.equal(check.valid, false);
    }
    assert.ok(error.message.includes(override));
    assert.ok(error.message.includes(path.join(resourcesPath, 'xycut')));
    for (const name of ['frontend/index.html', 'core_worker.py']) assert.ok(error.message.includes(name), name);
    assert.match(error.message, /python[\\/]python\.exe/);
    assert.match(error.message, /ffmpeg[\\/]ffmpeg\.exe/);
    assert.match(error.message, /ffmpeg[\\/]ffprobe\.exe/);
    return true;
  });
  fs.rmSync(root, {recursive: true, force: true});
});

test('each missing runtime file is reported on its own', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const [relative, kind] of requiredResources(platform)) {
      if (kind !== 'file') continue;
      const root = fillResources(fs.mkdtempSync(path.join(os.tmpdir(), 'xycut 单项 缺失-')), platform);
      fs.rmSync(path.join(root, relative));
      const check = inspectResourceRoot(root, platform);
      assert.equal(check.valid, false, `${platform} ${relative}`);
      assert.deepEqual(check.missing, [relative]);
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
});

test('a directory where a runtime file is expected is not accepted', () => {
  const root = fillResources(fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-kind-')), 'darwin');
  fs.rmSync(path.join(root, 'core_worker.py'));
  fs.mkdirSync(path.join(root, 'core_worker.py'));
  assert.deepEqual(inspectResourceRoot(root, 'darwin').missing, ['core_worker.py']);
  fs.rmSync(root, {recursive: true, force: true});
});

test('Mac launch scripts keep user data outside the .app and disable Python bytecode', () => {
  const root = path.join(__dirname, '..');
  const preparation = fs.readFileSync(path.join(root, 'scripts', 'prepare-mac-test.command'), 'utf8');
  const packager = fs.readFileSync(path.join(root, 'scripts', 'package-mac.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.match(preparation, /export XYCUT_DATA_DIR="\$ROOT\/验收记录"/);
  assert.match(preparation, /export PYTHONDONTWRITEBYTECODE=1/);
  assert.match(preparation, /"\$ELECTRON"/);
  assert.doesNotMatch(preparation, /\/usr\/bin\/open/);
  assert.match(packager, /export XYCUT_DATA_DIR="\$PWD\/验收记录"/);
  assert.match(packager, /export PYTHONDONTWRITEBYTECODE=1/);
  assert.match(main, /PYTHONDONTWRITEBYTECODE \|\|= '1'/);
  assert.match(main, /XYCUT_DATA_DIR\|\|path\.join\(app\.getPath\('appData'\)/);
});

test('Service keeps settings, cache and storage under dataDir, not resources', () => {
  const {Service} = require('../backend/service.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut 数据 隔离-'));
  const resources = fillResources(path.join(root, 'XYCut 恢复版.app', 'Contents', 'Resources', 'xycut'), 'darwin');
  const listing = dir => fs.readdirSync(dir, {recursive: true}).map(String).sort();
  const before = listing(resources);
  const dataDir = path.join(root, '用户 数据');
  const service = new Service({resources, dataDir});
  assert.deepEqual(listing(resources), before);
  for (const dir of [service.cache, service.storage, path.dirname(service.dbPath), path.dirname(service.settingsFile)]) {
    assert.ok(path.resolve(dir).startsWith(path.resolve(dataDir) + path.sep) || path.resolve(dir) === path.resolve(dataDir), dir);
  }
  fs.rmSync(root, {recursive: true, force: true});
});

test('Mac runtime preparation can import package-mac.py without a Windows build', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-mac.py'), 'utf8');
  const moduleLevel = source.split(/\n(?=def |if __name__)/)[0];
  assert.doesNotMatch(moduleLevel, /verify-mac-inputs/);
  assert.match(source, /def build\(arch\):\n(?:\s+#.*\n)*\s+subprocess\.run\(\["node", str\(ROOT \/ "scripts\/verify-mac-inputs\.cjs"\)\]/);
});

test('native Mac build packages only the staged Mac runtime and fails with a non-zero exit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-native-mac.cjs'), 'utf8');
  // package.json maps ./resources (Windows runtime in the source delivery) to
  // xycut; electron-builder would otherwise merge it with the Mac stage.
  assert.match(source, /config:\{[^}]*extraResources:null,mac:\{extraResources:\[\{from:path\.join\(stage,'resources'\),to:'xycut'/);
  assert.match(source, /main\(\)\.catch\(error=>\{console\.error\(error\);process\.exit\(1\);\}\);/);
});

test('interrupted runtime downloads are not left in the build cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-mac.py'), 'utf8');
  assert.match(source, /partial = file\.with_name\(file\.name \+ "\.part"\)/);
  assert.match(source, /partial\.replace\(file\)/);
  assert.match(source, /if actual != wanted:\n\s+file\.unlink\(\)/);
});
