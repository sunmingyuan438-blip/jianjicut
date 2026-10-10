const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {applyEditedTimeline} = require('../backend/generation.cjs');
const {Service} = require('../backend/service.cjs');
const {Workbench, makeCutPlan} = require('../backend/workbench.cjs');
const {read, write, run, within, walk} = require('../backend/util.cjs');

const resources = path.resolve(process.env.XYCUT_RESOURCES || path.join(__dirname, '../resources'));
const copy = value => JSON.parse(JSON.stringify(value));
const word = (idx, text, start, end) => ({idx, text, start, end});
const line = (line_id, text, words, start = 0, end = 1) => ({line_id, text, words, start, end});
const subtitle = (fields = {}) => ({
  line_id: 'line_001_01', source_line_id: 'line_001', style_level: '01',
  text: '甲乙', lines: ['甲乙'], line_chars: [2], start_ms: 0, end_ms: 400, duration_ms: 400,
  ...fields,
});

function edit(subtitles, before, after) {
  return applyEditedTimeline({subtitles: copy(subtitles)}, {lines: copy(after)}, {lines: copy(before)}).subtitles;
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-generation-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^xycut-generation-test-/);
    assert.ok(within(os.tmpdir(), resolved));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  return root;
}

// Requirements and expected results come from the original Agent's
// subtitle-planning.md, analyze_video_template_plan.py and direct offline
// probes of both the protected and restored CPython 3.9 cores.
test('已删除的完整词范围不会按剩余父行时长复活主字幕或副字幕', () => {
  const before = line('line_001', '甲乙丙丁', [word(1, '甲', 0, .2), word(2, '乙', .2, .4), word(3, '丙', .4, .6), word(4, '丁', .6, .8)]);
  const after = line('line_001', '丙丁', [word(3, '丙', 0, .2), word(4, '丁', .2, .4)], 0, .6);
  const result = edit([
    subtitle({source_word_start_idx: 1, source_word_end_idx: 2, secondary_text: 'Removed phrase'}),
    subtitle({line_id: 'line_001_02', text: '丙丁', lines: ['丙丁'], source_word_start_idx: 3, source_word_end_idx: 4, secondary_text: 'Kept phrase'}),
  ], [before], [after]);
  assert.deepEqual(result.map(item => item.text), ['丙丁']);
  assert.deepEqual(result.map(item => item.secondary_text), ['Kept phrase']);
  assert.equal(result[0].start_ms, 0);
  assert.equal(result[0].end_ms, 400);
});

test('缺少旧词证据时不把合法编号误判为用户已删除的字幕', () => {
  const item = subtitle({source_word_start_idx: 1, source_word_end_idx: 2});
  const result = edit([item], [line('line_001', '甲乙', [], 0, 1)], [line('line_001', '甲乙', [], 0, .8)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '甲乙');
  assert.equal(result[0].end_ms, 800);
});

test('03 局部删字保留两槽边界，并使用原 Agent 的半角字数契约', () => {
  const words = [word(1, '先', 0, .1), word(2, '学', .1, .2), word(3, 'AI', .2, .4), word(4, '再', .4, .5), word(5, '练', .5, .6), word(6, '习', .6, .7)];
  const before = line('line_001', '先学AI再练习', words);
  const after = line('line_001', '学AI再练习', words.slice(1).map(w => ({...w, start: w.start - .1, end: w.end - .1})), 0, .9);
  const item = subtitle({text: '先学AI再练习', style_level: '03', lines: ['先学AI', '再练习'], line_chars: [3, 3], agent_locked_lines: true,
    source_word_start_idx: 1, source_word_end_idx: 6,
    highlight_terms: ['AI'], highlight_ranges: [{field: 'main', start: 2, end: 4, text: 'AI'}],
    preset_match: {slot_count: 2, slot_max_chars: [4, 4], input_lengths: [3, 3], overflow_chars: 0, preset: {slot_count: 2, slot_max_chars: [4, 4]}},
  });
  const result = edit([item], [before], [after]);
  assert.equal(result[0].text, '学AI再练习');
  assert.deepEqual(result[0].lines, ['学AI', '再练习']);
  assert.deepEqual(result[0].line_chars, [2, 3]);
  assert.deepEqual(result[0].preset_match.input_lengths, [2, 3]);
  assert.equal(result[0].preset_match.overflow_chars, 0);
  assert.equal(result[0].agent_locked_lines, true);
  assert.deepEqual(result[0].highlight_terms, []);
  assert.deepEqual(result[0].highlight_ranges, []);
});

test('03 某个完整槽被删除时提示重新选择或调整预设', () => {
  const before = line('line_001', '甲乙丙丁', [word(1, '甲', 0, .2), word(2, '乙', .2, .4), word(3, '丙', .4, .6), word(4, '丁', .6, .8)]);
  const after = line('line_001', '丙丁', [word(3, '丙', 0, .2), word(4, '丁', .2, .4)], 0, .6);
  const item = subtitle({text: '甲乙丙丁', style_level: '03', lines: ['甲乙', '丙丁'], line_chars: [2, 2], agent_locked_lines: true,
    source_word_start_idx: 1, source_word_end_idx: 4,
    preset_match: {slot_count: 2, preset: {slot_count: 2}},
  });
  assert.throws(() => edit([item], [before], [after]), /(?:03|重点)[\s\S]*(?:槽|分段|预设)[\s\S]*(?:重选|重新|调整|选择)|(?:重选|重新|调整)[\s\S]*(?:槽|分段|预设)/);
});

test('03 跨槽重复汉字按具体词编号删除，不能只凭相同正文猜槽位', () => {
  const words = [word(1, '甲', 0, .2), word(2, '甲', .2, .4), word(3, '甲', .4, .6), word(4, '乙', .6, .8)];
  const before = line('line_001', '甲甲甲乙', words);
  const item = subtitle({text: before.text, style_level: '03', lines: ['甲甲', '甲乙'], line_chars: [2, 2], agent_locked_lines: true,
    source_word_start_idx: 1, source_word_end_idx: 4,
    preset_match: {slot_count: 2, slot_max_chars: [8, 8], input_lengths: [2, 2], preset: {slot_count: 2}},
  });
  // Both deletions produce identical text, but the correct original slots
  // differ. A whole-sentence diff alone cannot determine their ownership.
  for (const [deletedIdx, expected] of [[2, ['甲', '甲乙']], [3, ['甲甲', '乙']]]) {
    const kept = words.filter(w => w.idx !== deletedIdx).map((w, index) => ({...w, start: index * .2, end: (index + 1) * .2}));
    const after = line('line_001', '甲甲乙', kept, 0, .8);
    const result = edit([item], [before], [after]);
    assert.deepEqual(result[0].lines, expected, 'Deleted word idx=' + deletedIdx);
    assert.deepEqual(result[0].line_chars, expected.map(value => value.length));
    assert.deepEqual(result[0].preset_match.input_lengths, expected.map(value => value.length));
  }
});

test('ASR 词和编号没变时保留 hello world 正文及分段内的空格', () => {
  const words = [word(1, 'hello', .1, .4), word(2, 'world', .4, .8)];
  const before = line('line_001', 'hello world', words);
  const after = line('line_001', 'hello world', words.map(w => ({...w, start: w.start + .1, end: w.end + .1})), .1, 1);
  for (const [style_level, lines, line_chars] of [['01', ['hello world'], [5]], ['03', ['hello ', 'world'], [2, 2]]]) {
    const item = subtitle({text: 'hello world', style_level, lines, line_chars, source_word_start_idx: 1, source_word_end_idx: 2});
    const result = edit([item], [before], [after]);
    assert.equal(result[0].text, 'hello world');
    assert.deepEqual(result[0].lines, lines);
    assert.deepEqual(result[0].line_chars, line_chars);
    assert.equal(result[0].start_ms, 200);
    assert.equal(result[0].end_ms, 900);
  }
});

test('删前缀后强调移位，并按 Unicode code point 重建范围', () => {
  const before = line('line_001', '前😀甲强调乙', [word(1, '前', 0, .1), word(2, '😀', .1, .2), word(3, '甲', .2, .3), word(4, '强调', .3, .5), word(5, '乙', .5, .6)]);
  const after = line('line_001', '😀甲强调乙', before.words.slice(1).map(w => ({...w, start: w.start - .1, end: w.end - .1})), 0, .9);
  const item = subtitle({text: before.text, lines: [before.text], style_level: '02', source_word_start_idx: 1, source_word_end_idx: 5,
    highlight_terms: ['强调'], highlight_ranges: [{field: 'main', start: 3, end: 5, text: '强调'}],
  });
  const result = edit([item], [before], [after]);
  assert.deepEqual(result[0].highlight_terms, ['强调']);
  assert.deepEqual(result[0].highlight_ranges, [{field: 'main', start: 2, end: 4, text: '强调'}]);
  assert.equal(result[0].text, '😀甲强调乙');
});

test('只有旧强调范围时保留对应的词，不让旧索引强调新的片段', () => {
  const before = line('line_001', '甲乙强调丙丁', []);
  const after = line('line_001', '强调丙丁', [], 0, .6);
  const item = subtitle({text: before.text, lines: [before.text], style_level: '02', highlight_ranges: [{field: 'main', start: 2, end: 4}]});
  const result = edit([item], [before], [after]);
  assert.deepEqual(result[0].highlight_terms, ['强调']);
  assert.deepEqual(result[0].highlight_ranges, [{field: 'main', start: 0, end: 2, text: '强调'}]);
});

test('被删除的强调词不会留下错误的新正文范围', () => {
  const before = line('line_001', '甲强调乙', []);
  const after = line('line_001', '甲乙', [], 0, .5);
  const item = subtitle({text: before.text, lines: [before.text], style_level: '02', highlight_terms: ['强调'], highlight_ranges: [{field: 'main', start: 1, end: 3, text: '强调'}]});
  const result = edit([item], [before], [after]);
  assert.deepEqual(result[0].highlight_terms, []);
  assert.deepEqual(result[0].highlight_ranges, []);
});

test('独立预览手改正文和副字幕保留，词锚点只更新其时间', () => {
  const before = line('line_001', '甲乙', [word(1, '甲', 0, .2), word(2, '乙', .2, .4)]);
  const after = line('line_001', '甲乙', [word(1, '甲', .1, .3), word(2, '乙', .3, .5)], 0, .8);
  const item = subtitle({text: '用户手改的正文', lines: ['用户手改的正文'], source_word_start_idx: 1, source_word_end_idx: 2, secondary_text: 'User edited translation'});
  const result = edit([item], [before], [after]);
  assert.equal(result[0].text, item.text);
  assert.deepEqual(result[0].lines, item.lines);
  assert.equal(result[0].secondary_text, item.secondary_text);
  assert.equal(result[0].start_ms, 100);
  assert.equal(result[0].end_ms, 500);
});

test('source_line_ids 跨父行词锚点共同决定主副字幕时段', () => {
  const before = [line('line_001', '甲乙', [word(1, '甲', 0, .1), word(2, '乙', .1, .2)], 0, .2), line('line_002', '丙丁', [word(3, '丙', .2, .3), word(4, '丁', .3, .4)], .2, .4)];
  const after = [line('line_001', '甲乙', [word(1, '甲', 0, .1), word(2, '乙', .1, .2)], 0, .2), line('line_002', '丙丁', [word(3, '丙', .3, .4), word(4, '丁', .4, .5)], .3, .5)];
  const item = subtitle({line_id: 'joined', text: '乙丙', lines: ['乙丙'], source_line_ids: ['line_001', 'line_002'], source_word_start_idx: 2, source_word_end_idx: 3, secondary_text: 'B C'});
  const result = edit([item], before, after);
  assert.equal(result[0].text, '乙丙');
  assert.equal(result[0].start_ms, 100);
  assert.equal(result[0].end_ms, 400);
  assert.equal(result[0].duration_ms, 300);
  assert.equal(result[0].secondary_text, 'B C');
});

test('没有词时间时 source_text 半开偏移把删字投影到各短字幕', () => {
  const before = line('line_001', '甲乙丙丁', [], 0, 1);
  const after = line('line_001', '甲丁', [], 0, .5);
  const items = [subtitle({source_text_start: 0, source_text_end: 2}), subtitle({line_id: 'line_001_02', text: '丙丁', lines: ['丙丁'], source_text_start: 2, source_text_end: 4})];
  assert.deepEqual(edit(items, [before], [after]).map(item => item.text), ['甲', '丁']);
  assert.deepEqual(edit(items, [before], [line('line_001', '丙丁', [], 0, .5)]).map(item => item.text), ['丙丁']);
});

test('工作台读取毫秒词时间，生成字幕使用保存后的重排时刻', async t => {
  const root = temporary(t), service = new Service({resources, dataDir: path.join(root, 'data')}), workbench = new Workbench(service);
  const task = path.join(root, 'task'); fs.mkdirSync(task);
  const before = {line_id: 'line_001', start_ms: 0, end_ms: 1000, text: '甲乙', words: [
    {idx: 1, word: '甲', start_ms: 200, end_ms: 400},
    {idx: 2, word: '乙', start_ms: 600, end_ms: 900},
  ]};
  write(path.join(task, 'edit/line_timeline.json'), {source_duration: 1, lines: [before]});
  const opened = workbench.open({task_dir: task});
  const saved = await workbench.state({...opened, manual_delete_ranges: [{start: .1, end: .2}]});
  const [first, second] = saved.line_timeline.lines[0].words;
  assert.ok(Math.abs(first.start - .1) < 1e-9);
  assert.ok(Math.abs(first.end - .3) < 1e-9);
  assert.ok(Math.abs(second.start - .5) < 1e-9);
  assert.ok(Math.abs(second.end - .8) < 1e-9);
  assert.equal(first.source_start, .2);
  assert.equal(first.source_end, .4);
  const result = edit([subtitle({source_word_start_idx: 1, source_word_end_idx: 2})], [before], saved.line_timeline.lines);
  assert.equal(result[0].start_ms, 100, 'An old source start_ms must not override remapped target start.');
  assert.equal(result[0].end_ms, 800);
  const fallback = edit([subtitle({text: '用户手工正文', lines: ['用户手工正文']})], [before], saved.line_timeline.lines);
  assert.equal(fallback[0].start_ms, 0);
  assert.equal(fallback[0].end_ms, 900, 'An old line end_ms must not extend a remapped parent back to its source duration.');
});

test('工作台删光所有词后即使源行还有静音范围也不保留旧字幕正文', async t => {
  const root = temporary(t), service = new Service({resources, dataDir: path.join(root, 'data')}), workbench = new Workbench(service);
  const task = path.join(root, 'task'); fs.mkdirSync(task);
  const before = line('line_001', '全部删掉', [word(1, '全部', .2, .3), word(2, '删掉', .3, .5)], 0, 1);
  write(path.join(task, 'edit/line_timeline.json'), {source_duration: 1, lines: [before]});
  const opened = workbench.open({task_dir: task});
  const saved = await workbench.state({...opened, deleted_word_indices: [1, 2], manual_delete_ranges: [{start: .2, end: .5}]});
  assert.equal(saved.cut_plan.keep_ranges.length, 2, 'Leading and trailing silent media are still retained.');
  assert.ok(Math.abs(saved.cut_plan.duration - .7) < 1e-9);
  assert.deepEqual(saved.line_timeline.lines, []);
  assert.deepEqual(read(path.join(task, 'edit/line_timeline.json')).lines, []);
  const captions = edit([subtitle({text: before.text, lines: [before.text], source_word_start_idx: 1, source_word_end_idx: 2, secondary_text: 'Deleted entirely'})], [before], saved.line_timeline.lines);
  assert.deepEqual(captions, []);
});

test('原保护核心和恢复核心实际采用 Unicode 强调范围契约', async t => {
  const root = temporary(t);
  const service = new Service({resources, dataDir: path.join(root, 'data')});
  const code = `import sys,json\nr=json.load(sys.stdin)\nsys.path.insert(0,r['core'])\nimport xycut_core.shared.simple_draft as c\nprint(json.dumps([c._subtitle_highlight_ranges(i,i['text']) for i in r['items']],ensure_ascii=False))`;
  const items = [{text: '😀甲强调乙', highlight_terms: ['强调']}, {text: '😀甲强调乙', highlight_ranges: [{field: 'main', start: 3, end: 5, text: '强调'}]}, {text: '强调丙丁', highlight_ranges: [{field: 'main', start: 0, end: 2, text: '强调'}]}];
  const variants = [{name: 'restored', core: path.join(resources, 'core')}];
  const original = path.resolve(__dirname, '../../xycut-recovered-0.2.10/protected/xycut-python-core');
  if (process.platform === 'win32' && fs.existsSync(path.join(original, 'xycut_core'))) variants.push({name: 'original protected', core: original});
  for (const variant of variants) {
    const actual = JSON.parse(await run(service.python(), ['-c', code], {core: variant.core, items}));
    assert.deepEqual(actual, [[{start: 2, end: 4}], [], [{start: 0, end: 2}]], variant.name);
  }
  t.diagnostic('Compared ' + variants.map(variant => variant.name).join(' and ') + ' entirely offline.');
});

async function videoFixture(t) {
  const root = temporary(t), dataDir = path.join(root, 'data'), service = new Service({resources, dataDir});
  const template = await service.invoke('save_local_preset_as_video_template', {presetDir: path.join(resources, 'builtin-presets/xycut_001'), templateName: '字幕协议验收模板'});
  const output = path.join(root, 'drafts');
  fs.mkdirSync(output);
  return {root, dataDir, service, template, output};
}

function basePlan(fixture, subtitles, before, duration = 1367) {
  return {mode: 'video_template', template_dir: fixture.template.template_dir, template_config_file: fixture.template.template_config_file, draft_output_dir: fixture.output,
    timeline_duration_ms: duration, source_video: {file_path: path.join(resources, 'builtin-presets/xycut_001/xycut_001.mp4'), duration_ms: 1367, width: 1080, height: 1920},
    title: {items: []}, subtitles, line_timeline: {source_duration: 1.366666, duration: 1.366666, lines: before}};
}

async function generateEdited(fixture, plan, lines, cutRanges) {
  const analysisFile = path.join(fixture.root, 'task/output/video_template_analysis.json');
  write(analysisFile, {...plan, generation_plan: copy(plan)});
  write(path.join(fixture.root, 'task/edit/cut_plan.json'), makeCutPlan(cutRanges, 1.366666));
  write(path.join(fixture.root, 'task/edit/line_timeline.json'), {source_duration: 1.366666, duration: makeCutPlan(cutRanges, 1.366666).duration, lines});
  return fixture.service.generate({analysis_file: analysisFile});
}

function draftTextsAndRanges(result) {
  const allTexts = [], ranges = new Map();
  function collect(content) {
    if (!content || typeof content !== 'object') return;
    if (Array.isArray(content)) { content.forEach(collect); return; }
    const texts = new Map();
    for (const material of content.materials?.texts || []) {
      const text = JSON.parse(material.content || '{}').text;
      allTexts.push(text); texts.set(material.id, text);
    }
    for (const track of content.tracks || []) for (const segment of track.segments || []) {
      const text = texts.get(segment.material_id);
      if (text) {if (!ranges.has(text)) ranges.set(text, []); ranges.get(text).push(segment.target_timerange);}
    }
    Object.values(content).forEach(collect);
  }
  for (const file of walk(result.draft_dir, file => path.basename(file) === 'draft_content.json')) collect(read(file));
  return {allTexts, ranges};
}

test('实际恢复核心将删字后的 03 两槽分别写入生成草稿', async t => {
  const fixture = await videoFixture(t);
  const words = [word(1, '先', 0, .1), word(2, '学', .1, .2), word(3, 'AI', .2, .4), word(4, '再', .4, .5), word(5, '练', .5, .6), word(6, '习', .6, .7)];
  const before = line('line_001', '先学AI再练习', words, 0, 1.366666);
  const after = line('line_001', '学AI再练习', words.slice(1).map(w => ({...w, start: w.start - .1, end: w.end - .1})), 0, 1.266666);
  const item = subtitle({text: before.text, style_level: '03', lines: ['先学AI', '再练习'], line_chars: [3, 3], agent_locked_lines: true, source_word_start_idx: 1, source_word_end_idx: 6,
    preset_match: {source: 'user_selected', slot_count: 2, input_lengths: [3, 3], slot_max_chars: [8, 8], preset: {preset_path: path.join(resources, 'builtin-presets/xycut_001'), slot_count: 2, slot_max_chars: [8, 8]}}});
  const result = await generateEdited(fixture, basePlan(fixture, [item], [before]), [after], [{start: 0, end: .1}]);
  assert.equal(result.ok, true);
  const {allTexts} = draftTextsAndRanges(result);
  assert.ok(allTexts.includes('学AI'), JSON.stringify(allTexts));
  assert.ok(allTexts.includes('再练习'), JSON.stringify(allTexts));
  assert.ok(!allTexts.includes('先学AI'));
  assert.ok(!allTexts.includes('学AI再练习'), 'The two compound slots must not be flattened into one.');
});

test('实际恢复核心不生成已删除主副字幕，保留的主副轨道时段相同', async t => {
  const fixture = await videoFixture(t);
  const templateFile = path.join(fixture.template.template_dir, 'preset_draft/draft_content.json');
  const compound = read(templateFile);
  // The original builtin has a compound wrapper. Use its genuine two-text
  // embedded draft as the local test template's root so both detected styles
  // refer to text segments that the original secondary-subtitle cloner reads.
  const content = compound.materials.drafts[0].draft;
  assert.ok(content.materials.texts.length >= 2);
  write(templateFile, content);
  const [primary, secondary] = content.materials.texts;
  const config = read(fixture.template.template_config_file);
  config.title_slots = [];
  config.subtitle_style_groups = [{style_level: '01', variants: [{material_id: primary.id, sample_chars: 4}]}];
  config.secondary_subtitle = {enabled: true, language_name: '英语', variants: [{material_id: secondary.id, sample_chars: 12}]};
  write(fixture.template.template_config_file, config);
  const removed = line('line_001', '删除主字幕', [word(1, '删除主字幕', 0, .4)], 0, .4);
  const kept = line('line_002', '保留主字幕', [word(2, '保留主字幕', .4, 1.366666)], .4, 1.366666);
  const items = [subtitle({line_id: 'line_001', text: removed.text, lines: [removed.text], source_word_start_idx: 1, source_word_end_idx: 1, secondary_text: 'Removed translation'}),
    subtitle({line_id: 'line_002', source_line_id: 'line_002', text: kept.text, lines: [kept.text], source_word_start_idx: 2, source_word_end_idx: 2, start_ms: 400, duration_ms: 967, end_ms: 1367, secondary_text: 'Kept translation'})];
  const after = line('line_002', kept.text, [word(2, kept.text, 0, .966666)], 0, .966666);
  const result = await generateEdited(fixture, basePlan(fixture, items, [removed, kept]), [after], [{start: 0, end: .4}]);
  assert.equal(result.ok, true);
  const {allTexts, ranges} = draftTextsAndRanges(result);
  assert.ok(!allTexts.includes('删除主字幕'), JSON.stringify(allTexts));
  assert.ok(!allTexts.includes('Removed translation'), JSON.stringify(allTexts));
  assert.ok(allTexts.includes('保留主字幕'), JSON.stringify(allTexts));
  assert.ok(allTexts.includes('Kept translation'), JSON.stringify(allTexts));
  assert.ok(ranges.get('保留主字幕')?.length);
  assert.deepEqual(ranges.get('Kept translation'), ranges.get('保留主字幕'));
});
