const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {Service} = require('../backend/service.cjs');

const resources = path.resolve(process.env.XYCUT_RESOURCES || path.join(__dirname, '..', 'resources'));
const roots = [];
const savedEnvironmentKey = process.env.VOLCENGINE_API_KEY;
// Contract tests must never inherit an account key from the host environment.
process.env.VOLCENGINE_API_KEY = '';
function fixtureRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-speech-')); roots.push(root); return root; }
test.after(() => {
  if (savedEnvironmentKey === undefined) delete process.env.VOLCENGINE_API_KEY; else process.env.VOLCENGINE_API_KEY = savedEnvironmentKey;
  for (const root of roots) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^xycut-speech-/);
    fs.rmSync(root, {recursive: true, force: true});
  }
});
function assertRequestsCleaned(service) {
  const folder = path.join(service.cache, 'requests');
  assert.deepEqual(fs.existsSync(folder) ? fs.readdirSync(folder) : [], []);
}

function startFixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      requests.push({path: req.url, headers: req.headers, body});
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      if (req.url === '/tts-denied' || req.url === '/asr-denied') {
        res.statusCode = 403; res.end(JSON.stringify({message: 'fixture permission denied for resource'})); return;
      }
      if (req.url === '/tts-empty') { res.end(JSON.stringify({code: 20000000, addition: {duration: '0'}}) + '\n'); return; }
      if (req.url === '/asr-empty') { res.end(JSON.stringify({result: {utterances: []}})); return; }
      if (req.url === '/tts') {
        const frontend = JSON.stringify({words: [{word: '测', start_time: 0, end_time: 350}, {word: '试', start_time: 350, end_time: 700}]});
        const line = {code: 20000000, data: Buffer.from('fixture-audio').toString('base64'), addition: {duration: '0.7', frontend}};
        res.setHeader('Content-Type', 'application/x-ndjson'); res.end(JSON.stringify(line) + '\n'); return;
      }
      if (req.url === '/asr') {
        res.end(JSON.stringify({result: {utterances: [{text: '测试', start_time: 0, end_time: 700, words: [{word: '测', start_time: 0, end_time: 350}, {word: '试', start_time: 350, end_time: 700}]}]}})); return;
      }
      res.statusCode = 404; res.end(JSON.stringify({message: 'unknown fixture route'}));
    });
  });
  return {server, requests};
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }

test('豆包 TTS 读取前端参数数组并保留音频与时间戳契约', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const fixture = startFixture(), base = await listen(fixture.server);
  try {
    const service = new Service({resources, dataDir});
    const result = await service.invoke('generate_doubao_tts', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts'}}, parameters: [
      {key: 'KEY', value: 'fixture-speech-key'}, {key: 'VOICE_ID', value: 'voice-fixture'}, {key: 'RESOURCE_ID', value: 'seed-tts-fixture'}, {key: 'APP_ID', value: 'app-fixture'}
    ]}});
    assert.equal(result.ok, true); assert.equal(result.mode, 'tts');
    assert.deepEqual(fs.readFileSync(result.audio_file), Buffer.from('fixture-audio'));
    const timestamps = JSON.parse(fs.readFileSync(result.timestamps_file, 'utf8')); assert.equal(timestamps.words.length, 2);
    const request = fixture.requests[0]; assert.equal(request.path, '/tts'); assert.equal(request.headers['x-api-key'], 'fixture-speech-key');
    assert.equal(request.headers['x-api-resource-id'], 'seed-tts-fixture'); assert.equal(request.headers['x-api-app-id'], 'app-fixture');
    assert.equal(request.body.req_params.speaker, 'voice-fixture'); assert.equal(request.body.req_params.audio_params.format, 'mp3');
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('声音复刻要求显式音色 ID，并使用同一音频输出契约', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const fixture = startFixture(), base = await listen(fixture.server);
  try {
    const service = new Service({resources, dataDir});
    await assert.rejects(service.invoke('generate_doubao_voice_clone', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts'}}, parameters: [{key: 'KEY', value: 'fixture'}]}}), /音色 ID/);
    assert.equal(fixture.requests.length, 0); assertRequestsCleaned(service);
    const result = await service.invoke('generate_doubao_voice_clone', {input: {task_dir: task, text: '测试', voice_id: 'clone-voice-fixture', speech: {tts: {endpoint: base + '/tts'}}, parameters: [{key: 'KEY', value: 'fixture'}]}});
    assert.equal(result.mode, 'voice_clone'); assert.equal(result.voice_id, 'clone-voice-fixture');
    assert.equal(fixture.requests.at(-1).body.req_params.speaker, 'clone-voice-fixture');
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('部分语音配置覆盖保留已有 TTS 和 ASR 的独立字段', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const media = path.join(task, 'input.mp3'); fs.writeFileSync(media, Buffer.from('fixture-audio'));
  const fixture = startFixture(), base = await listen(fixture.server);
  try {
    const service = new Service({resources, dataDir});
    const saved = {speech: {tts: {api_key: 'fixture-saved-tts-key', speaker: 'fixture-saved-speaker', resource_id: 'fixture-saved-tts-resource'}, asr: {api_key: 'fixture-saved-asr-key', flash_resource_id: 'fixture-saved-asr-resource'}}};
    const savedFile = path.join(dataDir, 'agent-context.json'); fs.writeFileSync(savedFile, JSON.stringify(saved));
    await service.invoke('generate_doubao_tts', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts'}}}});
    const tts = fixture.requests[0]; assert.equal(tts.headers['x-api-key'], saved.speech.tts.api_key); assert.equal(tts.headers['x-api-resource-id'], saved.speech.tts.resource_id); assert.equal(tts.body.req_params.speaker, saved.speech.tts.speaker);
    await service.invoke('transcribe_doubao_asr', {input: {task_dir: task, input_media: media, mode: 'flash', speech: {asr: {flash_url: base + '/asr'}}}});
    const asr = fixture.requests[1]; assert.equal(asr.headers['x-api-key'], saved.speech.asr.api_key); assert.equal(asr.headers['x-api-resource-id'], saved.speech.asr.flash_resource_id);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedFile, 'utf8')), saved); assertRequestsCleaned(service);
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('TTS 和 ASR 缺少 KEY 时均不发送 HTTP 请求且清理临时配置', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const media = path.join(task, 'input.mp3'); fs.writeFileSync(media, Buffer.from('fixture-audio'));
  const fixture = startFixture(), base = await listen(fixture.server);
  try {
    const service = new Service({resources, dataDir});
    await assert.rejects(service.invoke('generate_doubao_tts', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts'}}, parameters: [{key: 'KEY', value: '  '}]}}), /API Key/);
    await assert.rejects(service.invoke('transcribe_doubao_asr', {input: {task_dir: task, input_media: media, mode: 'flash', speech: {asr: {flash_url: base + '/asr'}}, parameters: []}}), /API Key/);
    assert.equal(fixture.requests.length, 0); assertRequestsCleaned(service);
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('语音参数验证失败时也删除包含 KEY 的临时上下文', async () => {
  const root = fixtureRoot(), service = new Service({resources, dataDir: path.join(root, 'data')});
  const parameters = [{key: 'KEY', value: 'fixture-only-validation-key'}];
  await assert.rejects(service.invoke('generate_doubao_tts', {input: {text: '', parameters}}), /配音文案为空/); assertRequestsCleaned(service);
  await assert.rejects(service.invoke('generate_doubao_tts', {input: {text: '测试', parameters}}), /output_audio/); assertRequestsCleaned(service);
  const media = path.join(root, 'input.mp3'); fs.writeFileSync(media, 'fixture-audio');
  await assert.rejects(service.invoke('transcribe_doubao_asr', {input: {input_media: media, parameters}}), /output_json/); assertRequestsCleaned(service);
});

test('TTS 和 ASR 保留 HTTP 权限错误并清理请求配置', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const media = path.join(task, 'input.mp3'); fs.writeFileSync(media, Buffer.from('fixture-audio'));
  const fixture = startFixture(), base = await listen(fixture.server), parameters = [{key: 'KEY', value: 'fixture-denied-key'}];
  try {
    const service = new Service({resources, dataDir});
    await assert.rejects(service.invoke('generate_doubao_tts', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts-denied'}}, parameters}}), error => /HTTP 403/.test(error.message) && /fixture permission denied/.test(error.message));
    await assert.rejects(service.invoke('transcribe_doubao_asr', {input: {task_dir: task, input_media: media, mode: 'flash', speech: {asr: {flash_url: base + '/asr-denied'}}, parameters}}), error => /HTTP 403/.test(error.message) && /fixture permission denied/.test(error.message));
    assert.equal(fixture.requests.length, 2); assertRequestsCleaned(service);
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('无音频和无识别时间戳不能返回生成成功', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const media = path.join(task, 'input.mp3'); fs.writeFileSync(media, Buffer.from('fixture-audio'));
  const fixture = startFixture(), base = await listen(fixture.server), parameters = [{key: 'KEY', value: 'fixture-empty-key'}];
  try {
    const service = new Service({resources, dataDir});
    await assert.rejects(service.invoke('generate_doubao_tts', {input: {task_dir: task, text: '测试', speech: {tts: {endpoint: base + '/tts-empty'}}, parameters}}), /未返回音频数据/);
    assert.equal(fs.existsSync(path.join(task, 'input/source.mp3')), false);
    await assert.rejects(service.invoke('transcribe_doubao_asr', {input: {task_dir: task, input_media: media, mode: 'flash', speech: {asr: {flash_url: base + '/asr-empty'}}, parameters}}), /没有可用于生成 SRT 的时间戳/);
    assert.equal(fs.existsSync(path.join(task, 'output/voice.srt')), false); assertRequestsCleaned(service);
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});

test('豆包 ASR 使用独立配置、资源 ID并输出 SRT 与逐词 segments', async () => {
  const root = fixtureRoot(), dataDir = path.join(root, 'data'), task = path.join(root, 'task'); fs.mkdirSync(task, {recursive: true});
  const media = path.join(task, 'input.mp3'); fs.writeFileSync(media, Buffer.from('fixture-audio'));
  const fixture = startFixture(), base = await listen(fixture.server);
  try {
    const service = new Service({resources, dataDir});
    const result = await service.invoke('transcribe_doubao_asr', {input: {task_dir: task, input_media: media, mode: 'flash', speech: {asr: {flash_url: base + '/asr', flash_resource_id: 'volc.asr.fixture'}}, parameters: [{key: 'KEY', value: 'fixture-asr-key'}]}});
    assert.equal(result.ok, true); assert.ok(fs.statSync(result.srt_file).size > 0);
    const segments = JSON.parse(fs.readFileSync(path.join(task, 'speech/segments.json'), 'utf8')); assert.equal(segments.segments[0].words.length, 2);
    const request = fixture.requests[0]; assert.equal(request.path, '/asr'); assert.equal(request.headers['x-api-key'], 'fixture-asr-key');
    assert.equal(request.headers['x-api-resource-id'], 'volc.asr.fixture'); assert.equal(request.body.audio.format, 'mp3');
  } finally { await new Promise(resolve => fixture.server.close(resolve)); }
});
