const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Service} = require('../backend/service.cjs');

const resources = path.resolve(__dirname, '../resources');
const roots = [];

test.after(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});

test('F-17 语义候选排除失效文件和低质量素材，保留同模型向量检索', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-search-quality-'));
  roots.push(root);
  const service = new Service({resources, dataDir: path.join(root, 'data')});
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir, {recursive: true});
  const files = ['高质量海边.png', '低质量海边.png'].map((name, index) => {
    const file = path.join(sourceDir, name);
    fs.copyFileSync(path.join(resources, 'frontend', 'icon.png'), file);
    fs.appendFileSync(file, Buffer.from(String(index)));
    return file;
  });
  const libraryId = (await service.invoke('create_sucai_library', {name: '语义检索'})).library_id;
  await service.invoke('import_sucai_materials', {libraryId, sourcePaths: files});
  const pending = (await service.invoke('get_sucai_db_status')).source_materials;
  const analysisPath = path.join(root, 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify({items: pending.map((item, index) => ({
    source_id: item.id,
    summary: '海边日落素材',
    keywords: ['海边', '日落'],
    quality_score: index === 0 ? 0.92 : 0.1,
  }))}));
  assert.equal((await service.script('xycut-sucai-skill', 'save_material_analysis.py', [analysisPath, '--db', service.dbPath])).saved_count, 2);
  const embeddingItems = (await service.invoke('list_sucai_embedding_items', {libraryId})).items;
  await service.invoke('save_sucai_embeddings', {provider: 'fixture', model: 'fixture-embedding', items: embeddingItems.map(item => ({id: item.id, source_hash: item.source_hash, embedding: [1, 0]}))});
  const result = await service.script('xycut-sucai-skill', 'search_materials.py', [
    '--db', service.dbPath, '--library-id', libraryId, '--query', '海边', '--query-embedding-json', '[1,0]', '--min-quality', '0.35', '--top-k', '20',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.candidates[0].original_file_name, '高质量海边.png');
  fs.unlinkSync(result.candidates[0].path);
  const afterMissing = await service.script('xycut-sucai-skill', 'search_materials.py', [
    '--db', service.dbPath, '--library-id', libraryId, '--query', '海边', '--min-quality', '0.35', '--top-k', '20',
  ]);
  assert.equal(afterMissing.count, 0);
});
