const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Service} = require('../backend/service.cjs');
const {write, read} = require('../backend/util.cjs');

const resources = path.resolve(process.env.XYCUT_RESOURCES || path.join(__dirname, '../resources'));
const roots = [];
function temporary(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
function makePreset(root, name, metadata) {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, 'preset_draft'), {recursive: true});
  write(path.join(folder, 'preset_draft', 'draft_content.json'), {tracks: []});
  write(path.join(folder, `${name}.json`), {name, ...metadata});
  return folder;
}
test.after(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});

test('本地预设筛选支持标签、字体、字数、比例、时长和稳定排序，并规范剪映微秒时长', async () => {
  const dataDir = temporary('xycut-test-');
  const presetRoot = path.join(dataDir, 'presets');
  fs.mkdirSync(presetRoot, {recursive: true});
  makePreset(presetRoot, '竖屏口播', {
    tags: ['口播', '教育'], style_tags: ['黑体'], font_style: '黑体', subtitle_word_count: 18,
    aspect_ratio: '9:16', rough_cut_duration: 1366666, category_id: 'education'
  });
  makePreset(presetRoot, '横屏新闻', {
    tags: ['新闻'], style_tags: ['衬线'], font_style: '衬线', subtitle_word_count: 8,
    aspect_ratio: '16:9', duration_ms: 4200, category_id: 'news'
  });
  const service = new Service({resources, dataDir});
  const all = await service.invoke('scan_local_presets', {customDir: presetRoot, sort: 'duration'});
  assert.equal(all.total_count, 2);
  assert.equal(all.presets[0].name, '竖屏口播');
  assert.equal(all.presets[0].duration_ms, 1367);
  const filtered = await service.invoke('scan_local_presets', {
    customDir: presetRoot, tags: ['口播'], font_style: '黑体', min_words: 10, ratio: '9:16',
    min_duration_ms: 1000, max_duration_ms: 2000
  });
  assert.equal(filtered.total_count, 2);
  assert.equal(filtered.filtered_count, 1);
  assert.equal(filtered.presets[0].name, '竖屏口播');
});

test('本地字幕预设匹配命令写回普通/重点样式和候选原因', async () => {
  const dataDir = temporary('xycut-test-');
  const service = new Service({resources, dataDir});
  const plan = path.join(dataDir, 'plan.json');
  const favorite = path.join(dataDir, 'favorite-index.json');
  const output = path.join(dataDir, 'matched.json');
  write(plan, {subtitles: [
    {index: 1, text: '普通字幕', lines: ['普通字幕'], line_chars: [4], style_level: '01', duration_ms: 1200},
    {index: 2, text: '重点字幕', lines: ['重点字幕'], line_chars: [4], style_level: '03', duration_ms: 1200}
  ]});
  write(favorite, {default_group_id: 'default', presets: [
    {preset_id: 'normal', name: '普通黑体', preset_path: 'normal', style_level: '01', favorite_group_ids: ['default'], slot_max_chars: [8], duration_ms: 1200},
    {preset_id: 'strong', name: '重点黑体', preset_path: 'strong', style_level: '03', favorite_group_ids: ['default'], slot_max_chars: [8], duration_ms: 1200}
  ]});
  const result = await service.invoke('match_subtitle_presets', {input: {plan_path: plan, favorite_index_path: favorite, output_path: output, top_k: 2}});
  assert.equal(result.ok, true);
  const matched = read(output);
  assert.equal(matched.subtitles[0].preset_match.preset_id, 'normal');
  assert.equal(matched.subtitles[1].preset_match.preset_id, 'strong');
  assert.equal(matched.subtitles[0].preset_candidates.length, 2);
});
