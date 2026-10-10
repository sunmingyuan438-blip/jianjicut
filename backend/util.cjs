const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');

function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function within(root, file) { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function safeName(name) { const result = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim(); if (!result || result === '.' || result === '..') throw new Error('名称不能为空'); return result.slice(0, 120); }
function walk(root, predicate = () => true, depth = 12) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && depth > 0) result.push(...walk(file, predicate, depth - 1));
    else if (entry.isFile() && predicate(file)) result.push(file);
  }
  return result;
}
function run(executable, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide: true, ...options, env: {...process.env, PYTHONIOENCODING: 'utf-8', ...options.env}, stdio: ['pipe','pipe','pipe']});
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => {child.kill(); reject(new Error('处理超时'));}, options.timeout || 120000);
    child.stdout.on('data', c => {stdout += c; if (stdout.length > 64000000) child.kill();});
    child.stderr.on('data', c => {stderr += c;});
    child.on('error', e => {clearTimeout(timeout); reject(e);});
    child.on('close', code => {clearTimeout(timeout); if (code !== 0) {try {const data = JSON.parse(stdout); reject(new Error(data.message || data.error || stderr));} catch (e) {reject(e instanceof SyntaxError ? new Error(stderr || `进程退出 ${code}`) : e);} } else resolve(stdout);});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function download(url, destination, sha256) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('下载地址无效');
  const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== sha256.toLowerCase()) throw new Error('文件 SHA-256 校验失败');
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, bytes);
  return destination;
}
function extract(zipFile, destination) {
  const Zip = require('adm-zip');
  const zip = new Zip(zipFile);
  for (const entry of zip.getEntries()) {
    if (entry.entryName.includes('\\') || !within(destination, path.resolve(destination, entry.entryName))) throw new Error('压缩包包含越界路径');
  }
  fs.mkdirSync(destination, {recursive: true}); zip.extractAllTo(destination, true);
}
module.exports = {read, write, within, safeName, walk, run, download, extract};
