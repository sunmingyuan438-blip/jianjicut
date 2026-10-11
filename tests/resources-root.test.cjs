const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resourceLayout, platformRuntime, resolveDataRoot, resolveResourcesRoot} = require('../desktop/resources.cjs');

function fixture(platform = 'win32', directory = 'resources') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-resources-'));
  const resources = path.join(root, directory);
  const layout = resourceLayout(resources, platform);
  for (const [name, file] of Object.entries(layout)) {
    if (name === 'resourcesRoot') continue;
    fs.mkdirSync(path.dirname(file), {recursive: true});
    if (['agentKit', 'builtinPresets', 'draftShell'].includes(name)) fs.mkdirSync(file, {recursive: true});
    else fs.writeFileSync(file, name === 'python' ? 'runtime' : 'fixture');
  }
  return {root, resources};
}

test('explicit XYCUT_RESOURCES wins over packaged and development candidates', () => {
  const selected = fixture('win32');
  const packaged = fixture('win32');
  const result = resolveResourcesRoot({env:{XYCUT_RESOURCES:selected.resources}, resourcesPath:packaged.root, desktopDir:path.join(packaged.root, 'desktop'), platform:'win32'});
  assert.equal(result.root, path.resolve(selected.resources));
  assert.equal(result.python, path.join(selected.resources, 'python', 'python.exe'));
  fs.rmSync(selected.root, {recursive:true, force:true});
  fs.rmSync(packaged.root, {recursive:true, force:true});
});

test('packaged xycut root is selected even when Electron reports appIsPackaged false', () => {
  const packaged = fixture('win32', 'xycut');
  const development = fixture('win32');
  const result = resolveResourcesRoot({env:{}, resourcesPath:packaged.root, appIsPackaged:false, desktopDir:path.join(development.root, 'desktop'), platform:'win32'});
  assert.equal(result.root, packaged.resources);
  fs.rmSync(packaged.root, {recursive:true, force:true});
  fs.rmSync(development.root, {recursive:true, force:true});
});

test('development resources are used when packaged candidate is absent', () => {
  const development = fixture('win32');
  const result = resolveResourcesRoot({env:{}, resourcesPath:path.join(development.root, 'missing'), desktopDir:path.join(development.root, 'desktop'), platform:'win32'});
  assert.equal(result.root, path.join(development.root, 'resources'));
  fs.rmSync(development.root, {recursive:true, force:true});
});

test('macOS runtime names use bin/python3.9 and executable ffmpeg paths', () => {
  const fixtureRoot = fixture('darwin');
  const result = resolveResourcesRoot({env:{XYCUT_RESOURCES:fixtureRoot.resources}, platform:'darwin'});
  assert.equal(result.python, path.join(fixtureRoot.resources, 'python', 'bin', 'python3.9'));
  assert.equal(result.ffmpeg, path.join(fixtureRoot.resources, 'ffmpeg', 'ffmpeg'));
  fs.rmSync(fixtureRoot.root, {recursive:true, force:true});
});

test('missing resources include resourcesRoot and candidate file paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-resources-missing-'));
  assert.throws(() => resolveResourcesRoot({env:{XYCUT_RESOURCES:path.join(root, 'missing')}, resourcesPath:path.join(root, 'packaged'), desktopDir:path.join(root, 'desktop'), platform:'win32'}), error => {
    assert.match(error.message, /resourcesRoot/);
    assert.match(error.message, /python\\python\.exe/);
    assert.match(error.message, /frontend\\index\.html/);
    return true;
  });
  fs.rmSync(root, {recursive:true, force:true});
});

test('data root honors explicit override and otherwise uses appData', () => {
  assert.equal(resolveDataRoot({env:{XYCUT_DATA_DIR:'./.test-data/override'}, appData:'C:/Users/test/AppData/Roaming'}), path.resolve('.test-data/override'));
  assert.equal(resolveDataRoot({env:{}, appData:'C:/Users/test/AppData/Roaming'}), path.resolve('C:/Users/test/AppData/Roaming/XYCut-restored'));
});

test('platform runtime exposes the same Python and media contract on both platforms', () => {
  const win = platformRuntime('C:/xycut/resources', 'win32');
  assert.equal(win.python, path.resolve('C:/xycut/resources/python/python.exe'));
  assert.equal(win.ffmpeg, path.resolve('C:/xycut/resources/ffmpeg/ffmpeg.exe'));
  const mac = platformRuntime('/Applications/XYCut.app/Contents/Resources/xycut', 'darwin');
  assert.equal(mac.python, path.resolve('/Applications/XYCut.app/Contents/Resources/xycut/python/bin/python3.9'));
  assert.equal(mac.ffprobe, path.resolve('/Applications/XYCut.app/Contents/Resources/xycut/ffmpeg/ffprobe'));
});
