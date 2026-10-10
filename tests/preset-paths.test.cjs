const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Service, resolvePresetDirectory} = require('../backend/service.cjs');
const {read, write} = require('../backend/util.cjs');

const resources = path.resolve(__dirname, '../resources');
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-preset-path-')); const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir, {recursive:true}); return {root, dataDir, service:new Service({resources, dataDir})}; }
function touch(file, value = '') { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); }

test('F-02 自动定位含中文空格路径中的 Combination/Presets，直接选择该目录也保持不变', () => {
  const {service, root} = fixture();
  const install = path.join(root, '剪映 安装目录');
  const presets = path.join(install, 'Combination', 'Presets');
  const folder = path.join(presets, '我的 预设');
  touch(path.join(folder, 'preset_draft', 'draft_content.json'), '{}');
  const nested = resolvePresetDirectory(install);
  assert.equal(nested, path.resolve(presets));
  const fromParent = service.invoke('scan_local_presets', {customDir:install});
  return Promise.resolve(fromParent).then(result => {
    assert.equal(result.exists, true); assert.equal(result.preset_dir, path.resolve(presets)); assert.equal(result.presets.length, 1);
    return service.invoke('scan_local_presets', {customDir:presets});
  }).then(result => {
    assert.equal(result.preset_dir, path.resolve(presets));
    assert.equal(read(path.join(service.dataDir, 'settings.json')).preset_dir, path.resolve(presets));
    fs.rmSync(root, {recursive:true, force:true});
  });
});

test('F-01 预设目录与草稿目录分别持久化，重启后上下文使用真实目录生成草稿', async () => {
  const {service, dataDir, root} = fixture();
  const presetDir = path.join(root, '剪映 Presets'); fs.mkdirSync(presetDir, {recursive:true});
  const draftDir = path.join(root, '剪映 草稿'); fs.mkdirSync(draftDir, {recursive:true});
  const context = await service.invoke('update_agent_api_context', {input:{preset_dir:presetDir, draft_output_dir:draftDir}});
  assert.equal(context.enabled, true);
  const reopened = new Service({resources, dataDir});
  const generated = await reopened.generate({mode:'template_designer', generation_plan:{draft_name:'路径验收',duration_ms:1000,canvas:{width:1080,height:1920},background:{type:'image',file_path:path.join(resources,'frontend/background.jpg'),box:{x:0,y:0,w:1080,h:1920}},text_blocks:[{text:'中文路径',box:{x:120,y:160,w:840,h:96}}]}});
  assert.equal(generated.ok, true); assert.equal(path.dirname(generated.draft_content), path.join(path.resolve(draftDir), '路径验收'));
  const saved = read(path.join(dataDir,'api-context.json')); assert.equal(saved.preset_dir, path.resolve(presetDir)); assert.equal(saved.draft_output_dir, path.resolve(draftDir));
  const agent = read(path.join(dataDir,'agent-context.json')); assert.equal(agent.paths.preset_dir, path.resolve(presetDir)); assert.equal(agent.paths.draft_output_dir, path.resolve(draftDir));
  fs.rmSync(root, {recursive:true, force:true});
});

test('F-02 不存在的目录不覆盖已保存路径', async () => {
  const {service, dataDir, root} = fixture();
  const presetDir = path.join(root, 'valid'); fs.mkdirSync(presetDir, {recursive:true});
  await service.invoke('scan_local_presets', {customDir:presetDir});
  const result = await service.invoke('scan_local_presets', {customDir:path.join(root,'不存在')});
  assert.equal(result.exists, false); assert.equal(result.preset_dir, ''); assert.equal(read(path.join(dataDir,'settings.json')).preset_dir, path.resolve(presetDir));
  fs.rmSync(root, {recursive:true, force:true});
});
