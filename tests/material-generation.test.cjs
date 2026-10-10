const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Service} = require('../backend/service.cjs');
const {read} = require('../backend/util.cjs');

const resources = path.resolve(process.env.XYCUT_RESOURCES || path.join(__dirname, '../resources'));
const temporaryRoots = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-material-generation-'));
  temporaryRoots.push(root);
  return root;
}

function fixture() {
  const root = temporaryRoot();
  const dataDir = path.join(root, 'data');
  const generated = path.join(root, 'materials', 'ai');
  const output = path.join(root, 'drafts');
  fs.mkdirSync(generated, {recursive: true});
  fs.mkdirSync(output, {recursive: true});

  // These files stand in for paths handed back by an external Agent. No API
  // is called; the draft assembly must consume the real local paths directly.
  const sourceVideo = path.join(resources, 'builtin-presets/xycut_001/xycut_001.mp4');
  const sourceImage = path.join(resources, 'frontend/icon.png');
  const generatedVideo = path.join(generated, 'line_001', 'jimeng_fixture.mp4');
  const generatedImage = path.join(generated, 'line_002', 'gpt_image_fixture.png');
  fs.mkdirSync(path.dirname(generatedVideo), {recursive: true});
  fs.mkdirSync(path.dirname(generatedImage), {recursive: true});
  fs.copyFileSync(sourceVideo, generatedVideo);
  fs.copyFileSync(sourceImage, generatedImage);

  return {
    root,
    service: new Service({resources, dataDir}),
    output,
    sourceVideo,
    generatedVideo,
    generatedImage,
  };
}

function planFor(f, sourceTrim) {
  const materialPlan = {
    mode: 'sucai_library',
    scope: 'partial_broll',
    source_mode: 'user_provided',
    match_mode: 'fast',
    items: [
      {
        line_id: 'line_001',
        query: 'fixture video',
        file_path: f.generatedVideo,
        source: 'ai_generated',
        provider: 'jimeng',
        asset_type: 'video',
        target_start_ms: 0,
        target_end_ms: 500,
      },
      {
        line_id: 'line_002',
        query: 'fixture image',
        file_path: f.generatedImage,
        source: 'ai_generated',
        provider: 'gpt_image',
        asset_type: 'image',
        target_start_ms: 500,
        target_end_ms: 1000,
      },
    ],
  };
  if (sourceTrim !== undefined) {
    materialPlan.source_trim = {video_head_ms: sourceTrim, apply_to: 'matched_broll_video'};
  }
  return {
    mode: 'video_template',
    draft_name: '外部 Agent 素材契约',
    template_dir: f.template.template_dir,
    template_config_file: f.template.template_config_file,
    draft_output_dir: f.output,
    timeline_duration_ms: 1000,
    source_video: {
      file_path: f.sourceVideo,
      duration_ms: 1367,
      width: 1080,
      height: 1920,
    },
    title: {items: []},
    subtitles: [
      {line_id: 'line_001', text: '视频素材', lines: ['视频素材'], start_ms: 0, end_ms: 500, duration_ms: 500, style_level: '01'},
      {line_id: 'line_002', text: '图片素材', lines: ['图片素材'], start_ms: 500, end_ms: 1000, duration_ms: 500, style_level: '01'},
    ],
    line_timeline: {
      source_duration: 1,
      duration: 1,
      lines: [
        {line_id: 'line_001', start: 0, end: 0.5, text: '视频素材'},
        {line_id: 'line_002', start: 0.5, end: 1, text: '图片素材'},
      ],
    },
    material_plan: materialPlan,
  };
}

function materialByPath(draft, file) {
  return [...(draft.materials?.videos || []), ...(draft.materials?.images || [])]
    .find(item => path.normalize(item.path || item.media_path || '') === path.normalize(file));
}

function trackByName(draft, name) {
  const track = (draft.tracks || []).find(item => item.name === name);
  assert.ok(track, `缺少可编辑轨道: ${name}`);
  return track;
}

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, {recursive: true, force: true});
});

test('F-19 外部 Agent 的真实图片/视频路径进入可编辑剪映草稿', async () => {
  const f = fixture();
  f.template = await f.service.invoke('save_local_preset_as_video_template', {
    presetDir: path.join(resources, 'builtin-presets/xycut_001'),
    templateName: '外部素材契约模板',
  });
  const result = await f.service.generate({generation_plan: planFor(f)});
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.draft_content));

  // Inspect the actual draft JSON, rather than only trusting the service
  // summary, because Jianying edits these material/track references later.
  const draft = read(result.draft_content);
  assert.equal(result.summary.broll_count, 2);
  assert.equal(result.summary.broll_video_count, 1);
  assert.equal(result.summary.broll_image_count, 1);

  const videoMaterial = materialByPath(draft, f.generatedVideo);
  const imageMaterial = materialByPath(draft, f.generatedImage);
  assert.ok(videoMaterial, '草稿 materials.videos 未保留 Agent 视频真实路径');
  assert.ok(imageMaterial, '草稿 materials.images 未保留 Agent 图片真实路径');
  assert.equal(path.normalize(videoMaterial.path), path.normalize(f.generatedVideo));
  assert.equal(path.normalize(imageMaterial.path), path.normalize(f.generatedImage));

  const broll = trackByName(draft, 'B-roll素材');
  assert.equal(broll.segments.length, 2);
  const videoSegment = broll.segments.find(segment => segment.material_id === videoMaterial.id);
  const imageSegment = broll.segments.find(segment => segment.material_id === imageMaterial.id);
  assert.ok(videoSegment, 'B-roll 视频片段没有引用视频 material');
  assert.ok(imageSegment, 'B-roll 图片片段没有引用图片 material');
  assert.deepEqual(videoSegment.target_timerange, {start: 0, duration: 500000});
  assert.deepEqual(imageSegment.target_timerange, {start: 500000, duration: 500000});
  assert.ok(videoSegment.source_timerange && imageSegment.source_timerange, 'B-roll 片段缺少可编辑源时间范围');

  const main = trackByName(draft, '口播视频');
  const mainMaterial = materialByPath(draft, f.sourceVideo);
  assert.ok(mainMaterial, '主视频真实路径未进入草稿 materials');
  const mainSegment = main.segments.find(segment => segment.material_id === mainMaterial.id);
  assert.ok(mainSegment, '主视频轨道片段没有引用主视频 material');
  assert.equal(mainSegment.source_timerange.start, 0);
  assert.equal(mainSegment.target_timerange.start, 0);
});

test('F-20 source_trim 默认 500、自定义和 0 只作用于 B-roll 视频', async () => {
  const cases = [
    {label: 'default', value: undefined, expected: 500000},
    {label: 'custom', value: 200, expected: 200000},
    {label: 'disabled', value: 0, expected: 0},
  ];

  for (const item of cases) {
    const f = fixture();
    f.output = path.join(f.root, 'drafts', item.label);
    fs.mkdirSync(f.output, {recursive: true});
    f.template = await f.service.invoke('save_local_preset_as_video_template', {
      presetDir: path.join(resources, 'builtin-presets/xycut_001'),
      templateName: `source_trim_${item.label}`,
    });
    const result = await f.service.generate({generation_plan: planFor(f, item.value)});
    const draft = read(result.draft_content);
    const broll = trackByName(draft, 'B-roll素材');
    const videoMaterial = materialByPath(draft, f.generatedVideo);
    const imageMaterial = materialByPath(draft, f.generatedImage);
    const brollVideo = broll.segments.find(segment => segment.material_id === videoMaterial.id);
    const brollImage = broll.segments.find(segment => segment.material_id === imageMaterial.id);
    const main = trackByName(draft, '口播视频');
    const mainMaterial = materialByPath(draft, f.sourceVideo);
    const mainSegment = main.segments.find(segment => segment.material_id === mainMaterial.id);

    assert.equal(result.summary.broll_video_head_trim_ms, item.value === undefined ? 500 : item.value, item.label);
    assert.equal(result.summary.broll_video_head_trim_applied, item.value === 0 ? 0 : 1, item.label);
    assert.equal(brollVideo.source_timerange.start, item.expected, `B-roll 起点: ${item.label}`);
    assert.equal(brollVideo.source_timerange.duration, 500000, `B-roll 时长: ${item.label}`);
    // The source trim is for matched B-roll video only. Main A-roll and the
    // generated image must retain their own zero source offsets.
    assert.deepEqual(mainSegment.source_timerange, {start: 0, duration: 1367000}, `主视频被 source_trim 改写: ${item.label}`);
    assert.deepEqual(brollImage.source_timerange, {start: 0, duration: 0}, `图片被 source_trim 改写: ${item.label}`);
  }
});
