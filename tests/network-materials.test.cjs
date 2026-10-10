const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {Service} = require('../backend/service.cjs');

const resources = path.resolve(__dirname, '../resources');
const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-network-'));
  roots.push(root);
  return {root, service: new Service({resources, dataDir: path.join(root, 'data')})};
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});

test('F-18 网络素材脚本在没有旧 app 目录时用本地 Pexels HTTP 契约下载并回填路径', async () => {
  const {root, service} = fixture();
  const media = Buffer.from('fixture-mp4-content');
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/videos/search')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({videos: [{id: 77, url: 'https://pexels.test/video/77', user: {name: 'fixture'}, video_files: [{link: `http://127.0.0.1:${server.address().port}/media.mp4`}]}]}));
      return;
    }
    if (request.url === '/media.mp4') {
      response.setHeader('Content-Type', 'video/mp4');
      response.end(media);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const planPath = path.join(root, 'task', 'output', 'video_template_plan.json');
    const contextPath = path.join(root, 'agent-context.json');
    fs.mkdirSync(path.dirname(planPath), {recursive: true});
    fs.writeFileSync(planPath, JSON.stringify({subtitles: [{line_id: 'line_001', index: 1, text: '城市夜景', start_ms: 0, end_ms: 2000}]}));
    fs.writeFileSync(contextPath, JSON.stringify({pexels: {api_key: 'fixture-key', base_url: `http://127.0.0.1:${server.address().port}`}}));
    const result = await service.script('xycut-video-template-skill', 'download_network_materials.py', [
      '--plan', planPath,
      '--agent-context-file', contextPath,
      '--output', planPath,
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.downloaded_count, 1);
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const item = saved.material_plan.items[0];
    assert.equal(item.provider, 'pexels');
    assert.equal(item.source, 'network');
    assert.equal(fs.readFileSync(item.file_path).toString(), media.toString());
    assert.equal(fs.existsSync(path.join(root, 'app', 'utils', 'pexels_downloader.py')), false);
  } finally {
    await close(server);
  }
});

test('F-24 分析批次只取未完成来源，保存一批后下一批从剩余来源继续', async () => {
  const {root, service} = fixture();
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir, {recursive: true});
  const sourcePaths = [0, 1, 2].map(index => {
    const file = path.join(sourceDir, `素材-${index}.png`);
    fs.writeFileSync(file, Buffer.from(`image-${index}`));
    return file;
  });
  const created = await service.invoke('create_sucai_library', {name: '批次继续'});
  const libraryId = created.library_id;
  await service.invoke('import_sucai_materials', {libraryId, sourcePaths});
  const firstPath = path.join(root, 'batch-1.json');
  const first = await service.script('xycut-sucai-skill', 'prepare_analysis_batch.py', [
    '--db', service.dbPath, '--library-id', libraryId, '--limit', '1', '--no-frames', '--output', firstPath,
  ]);
  assert.equal(first.count, 1);
  const firstSource = first.materials[0];
  const analysisPath = path.join(root, 'analysis-1.json');
  fs.writeFileSync(analysisPath, JSON.stringify({items: [{source_id: firstSource.source_id, summary: '已完成一批', keywords: ['批次'], quality_score: 0.9}]}));
  const saved = await service.script('xycut-sucai-skill', 'save_material_analysis.py', [analysisPath, '--db', service.dbPath]);
  assert.equal(saved.saved_count, 1);
  const second = await service.script('xycut-sucai-skill', 'prepare_analysis_batch.py', [
    '--db', service.dbPath, '--library-id', libraryId, '--limit', '1', '--no-frames',
  ]);
  assert.equal(second.count, 1);
  assert.notEqual(second.materials[0].source_id, firstSource.source_id);
  const status = await service.invoke('get_sucai_db_status');
  assert.equal(status.libraries[0].analyzed_count, 1);
  assert.equal(status.source_materials.filter(item => item.status === 'processing').length, 1);
});
