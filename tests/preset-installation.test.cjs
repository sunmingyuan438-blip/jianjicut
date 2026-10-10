const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const AdmZip = require('adm-zip');
const {Service} = require('../backend/service.cjs');

const resources = path.resolve(__dirname, '../resources');
const roots = [];

test.after(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});

test('F-34 在线预设同步后同时保留 XYCut 缓存和个人剪映预设结构', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-preset-install-'));
  roots.push(root);
  const service = new Service({resources, dataDir: path.join(root, 'data')});
  const zip = new AdmZip();
  zip.addFile('remote-demo/preset_draft/draft_content.json', Buffer.from(JSON.stringify({materials: {videos: []}})));
  zip.addFile('remote-demo/remote-demo.json', Buffer.from(JSON.stringify({name: '远程演示', tags: ['演示'], category_name: '本地'})));
  const bytes = zip.toBuffer();
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/zip');
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const personalDir = path.join(root, '剪映 Presets');
    const result = await service.invoke('install_online_preset', {
      downloadUrl: `http://127.0.0.1:${server.address().port}/remote.zip`,
      folderName: '远程演示',
      customDir: personalDir,
      syncToJianying: true,
      installKind: 'preset',
    });
    assert.equal(result.cache_path, path.join(service.dataDir, 'presets', '远程演示'));
    assert.equal(result.target_path, path.join(personalDir, '远程演示'));
    assert.equal(fs.existsSync(path.join(result.cache_path, 'preset_draft', 'draft_content.json')), true);
    assert.equal(fs.existsSync(path.join(result.target_path, 'preset_draft', 'draft_content.json')), true);
    const scanned = await service.invoke('scan_local_presets', {customDir: personalDir});
    assert.equal(scanned.presets.length, 1);
    assert.equal(scanned.presets[0].name, '远程演示');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

for (const kind of ['hot_template', 'video_template']) {
  test(`F-05/F-11 ${kind} 安装返回原界面路径契约并保留人工配置`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-template-flow-'));
    roots.push(root);
    const service = new Service({resources, dataDir: path.join(root, 'data')});
    const reviewed = {
      template_slug: 'upstream-name', template_name: '人工审核模板', analysis_reviewed: true,
      title_template_duration_mode: 'original',
      title_slots: [{index: 1, y: 0.71, start_ms: 400, duration_ms: 2100, enabled: true}],
      text_slots: [{index: 2, draft_path: 'root.drafts[1]', suggest_chars: '12-20字', enabled: true}],
      excluded_media_slots: [{index: 3, enabled: false, exclude_reason: 'fixed_content'}],
      subtitle_style_groups: [{style_level: '03', variants: [{index: 1, y: -0.42}]}],
      secondary_subtitle: {enabled: true, language_hint: 'en', track_indexes: [7]},
    };
    const zip = new AdmZip();
    zip.addFile('package/preset_draft/draft_content.json', Buffer.from(JSON.stringify({materials: {videos: []}})));
    zip.addFile('package/template-config.json', Buffer.from(JSON.stringify(reviewed)));
    const bytes = zip.toBuffer();
    const server = http.createServer((_request, response) => response.end(bytes));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const installed = await service.invoke('install_online_preset', {
        downloadUrl: `http://127.0.0.1:${server.address().port}/template.zip`,
        folderName: '中文 模板', installKind: kind, syncToJianying: false,
      });
      // These are the exact property names and follow-up arguments used by Kr/Su
      // in the recovered renderer. The previous result made templateDir undefined.
      const templateDir = installed.cache_path || installed.target_path;
      assert.equal(templateDir, installed.template_dir);
      assert.equal(fs.existsSync(path.join(templateDir, 'preset_draft/draft_content.json')), true);
      const fromPackage = JSON.parse(fs.readFileSync(installed.template_config_file, 'utf8'));
      assert.deepEqual(fromPackage, {...reviewed, template_slug: '中文 模板', template_dir: templateDir});
      const saved = await service.invoke(`save_${kind}_config`, {
        slug: '中文 模板', templateName: reviewed.template_name, templateDir,
        templateConfigJson: JSON.stringify(reviewed),
      });
      assert.equal(saved.config_path, installed.template_config_file);
      assert.equal(fs.existsSync(path.join(saved.skill_dir, 'SKILL.md')), true);
      await service.invoke(`save_${kind}_config`, {
        slug: '中文 模板', templateName: reviewed.template_name, templateDir,
        templateConfigJson: '{}',
      });
      const restarted = new Service({resources, dataDir: service.dataDir});
      const listed = await restarted.invoke(kind === 'hot_template' ? 'list_local_hot_templates' : 'list_local_video_templates');
      assert.equal(listed.templates.length, 1);
      assert.deepEqual(listed.templates[0].template_config, fromPackage);
      assert.equal(listed.templates[0].config_path, saved.config_path);
      assert.equal(restarted.canRead(saved.config_path), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('保存无效模板配置不覆盖现有模板文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-template-invalid-'));
  roots.push(root);
  const service = new Service({resources, dataDir: path.join(root, 'data')});
  const original = path.join(service.templateRoot('hot_template'), 'existing');
  const replacement = path.join(root, 'replacement');
  for (const folder of [original, replacement]) fs.mkdirSync(path.join(folder, 'preset_draft'), {recursive: true});
  const draft = path.join(original, 'preset_draft/draft_content.json');
  fs.writeFileSync(draft, '{"keep":true}');
  fs.writeFileSync(path.join(replacement, 'preset_draft/draft_content.json'), '{"keep":false}');
  await assert.rejects(service.invoke('save_hot_template_config', {
    slug: 'existing', templateDir: replacement, templateConfigJson: '[]',
  }), /模板配置须为 JSON 对象/);
  assert.equal(fs.readFileSync(draft, 'utf8'), '{"keep":true}');
});
