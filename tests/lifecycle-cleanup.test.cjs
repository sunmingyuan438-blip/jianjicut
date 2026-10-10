const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Service} = require('../backend/service.cjs');
const {Workbench} = require('../backend/workbench.cjs');
const {startServer} = require('../backend/server.cjs');
const {read, write} = require('../backend/util.cjs');
const {jianyingCandidates, resolveJianying} = require('../desktop/jianying.cjs');

const resources = path.resolve(process.env.XYCUT_RESOURCES || path.join(__dirname, '../resources'));
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-lifecycle-')); const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir, {recursive:true}); return {root, dataDir, service:new Service({resources, dataDir})}; }
function touch(file, value = 'fixture') { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); }

test('F-35 剪映发现仅解析存在的 Win/Mac 安装，不触碰进程', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-jianying-'));
  const win = path.join(root, 'JianyingPro.exe'); touch(win);
  assert.equal(resolveJianying({platform:'win32', env:{LOCALAPPDATA:'', ProgramFiles:'', 'ProgramFiles(x86)':''}, settings:{jianying_exe:win}}), path.resolve(win));
  const mac = path.join(root, '剪映.app'); fs.mkdirSync(mac);
  assert.equal(resolveJianying({platform:'darwin', env:{HOME:''}, settings:{jianying_app:mac}}), path.resolve(mac));
  assert.ok(jianyingCandidates({platform:'win32', env:{}, settings:{}}).every(item => path.isAbsolute(item)));
  fs.rmSync(root, {recursive:true, force:true});
});

test('F-36 首页记录重启后从磁盘恢复并使用当前端口，清理后不会复活旧记录', async () => {
  const {dataDir, service, root} = fixture();
  const taskDir = path.join(root, 'task'); fs.mkdirSync(taskDir, {recursive:true});
  const first = new Workbench(service).open({task_dir:taskDir});
  const reopened = new Service({resources, dataDir});
  const {server, url} = await startServer(reopened, {port:0});
  try {
    const records = await reopened.invoke('list_recent_workbench_tasks', {limit:5});
    assert.equal(records.length, 1); assert.equal(records[0].task_id, first.task_id); assert.equal(records[0].url, `${url}/xycut/${first.task_id}`);
    const staleWorkbench = new Workbench(reopened); await reopened.invoke('clear_cache', {options:{workbench_records:true}});
    assert.deepEqual(await reopened.invoke('list_recent_workbench_tasks', {limit:5}), []);
    assert.deepEqual(staleWorkbench.reload(), []);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive:true, force:true}); }
});

test('F-37 缓存分类清理只删除选中缓存，保留草稿、素材库和原始文件', () => {
  const {service, dataDir, root} = fixture();
  const original = path.join(root, 'original.mp4'), draft = path.join(root, 'drafts', 'draft_content.json'); touch(original, 'original'); touch(draft, 'draft');
  for (const folder of ['updates','imports','runtime-downloads','template-tests','requests','backups']) touch(path.join(service.cache, folder, 'item.bin'));
  touch(path.join(service.cache, 'keep.bin')); service.clearCache({update_packages:true, preset_temp_files:true, runtime_downloads:true, template_tests:true, ai_editing_requests:true, backups:false});
  for (const folder of ['updates','imports','runtime-downloads','template-tests','requests']) assert.equal(fs.existsSync(path.join(service.cache, folder)), false, folder);
  assert.equal(fs.existsSync(path.join(service.cache,'backups','item.bin')), true); assert.equal(fs.existsSync(path.join(service.cache,'keep.bin')), true); assert.equal(fs.readFileSync(original,'utf8'),'original'); assert.equal(fs.readFileSync(draft,'utf8'),'draft');
  fs.rmSync(root, {recursive:true, force:true});
});

test('F-38 软件数据清理只重置所选目录并同步运行环境状态', () => {
  const {service, dataDir, root} = fixture();
  for (const folder of ['hot-templates','video-templates','subtitle-presets','presets','runtime/python','runtime/ffmpeg']) touch(path.join(dataDir, folder, 'keep.bin'));
  const draft = path.join(root, 'drafts', 'draft_content.json'), original = path.join(root, 'original.mov'); touch(draft,'draft'); touch(original,'original');
  service.resetData({hot_templates:true, python_runtime:true});
  assert.equal(fs.existsSync(path.join(dataDir,'hot-templates')), false); assert.equal(fs.existsSync(path.join(dataDir,'runtime/python')), false); assert.equal(fs.existsSync(path.join(dataDir,'video-templates','keep.bin')), true); assert.equal(fs.existsSync(path.join(dataDir,'runtime/ffmpeg','keep.bin')), true);
  assert.equal(service.settings.ai_runtime_disabled, true); assert.equal(service.settings.ffmpeg_disabled, undefined); assert.equal(fs.readFileSync(draft,'utf8'),'draft'); assert.equal(fs.readFileSync(original,'utf8'),'original');
  fs.rmSync(root, {recursive:true, force:true});
});
