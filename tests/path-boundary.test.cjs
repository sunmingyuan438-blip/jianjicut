const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {within} = require('../backend/util.cjs');

test('路径边界比较兼容 macOS /var 到 /private/var 的符号链接', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-path-boundary-'));
  const child = path.join(root, '中文 空格', 'file.txt');
  fs.mkdirSync(path.dirname(child), {recursive: true});
  fs.writeFileSync(child, 'ok');
  try {
    assert.equal(within(os.tmpdir(), child), true);
    assert.equal(within(root, child), true);
    assert.equal(within(child, root), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('不存在的目标路径仍按已存在父目录进行边界判断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xycut-path-boundary-'));
  try {
    assert.equal(within(root, path.join(root, 'new', '未来文件')), true);
    assert.equal(within(root, path.join(root, '..', 'outside')), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
