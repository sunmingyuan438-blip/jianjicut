const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const appRoot = process.env.XYCUT_TEST_APP_ROOT || root;
const {createTray} = require(path.join(appRoot, 'desktop/tray.cjs'));
const resources = process.env.XYCUT_TEST_APP_ROOT ? path.join(path.dirname(appRoot), 'xycut') : path.join(root, 'resources');
const reportDir = path.join(root, '.test-data/desktop-tray');
app.setPath('userData', path.join(reportDir, crypto.randomUUID()));
app.disableHardwareAcceleration();
const report = {build_id: JSON.parse(fs.readFileSync(path.join(resources, 'restoration-build.json'))).id, platform: process.platform, packaged_code: !!process.env.XYCUT_TEST_APP_ROOT, checks: {}, ok: false};
function save() { fs.mkdirSync(reportDir, {recursive: true}); fs.writeFileSync(path.join(reportDir, 'tray-report.json'), JSON.stringify(report, null, 2)); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({width: 480, height: 320, show: true});
  await window.loadURL('data:text/html;charset=utf-8,<h1>XYCut 窗口恢复验收</h1>');
  const controller = createTray({app, window, resources});
  assert.equal(controller.tray.isDestroyed(), false);
  report.checks.native_tray_created = true;
  for (const [name, restore] of [
    ['tray_click', () => controller.tray.emit('click')],
    ['tray_menu', () => controller.menu.items[0].click()],
    ['dock_activate', () => app.emit('activate')],
    ['second_instance', () => app.emit('second-instance')],
  ]) {
    window.hide();
    assert.equal(window.isVisible(), false);
    restore(); await delay(150);
    assert.equal(window.isVisible(), true, name);
    report.checks[name] = true;
  }
  window.minimize(); await delay(200);
  assert.equal(window.isMinimized(), true);
  controller.tray.emit('double-click'); await delay(200);
  assert.equal(window.isMinimized(), false);
  assert.equal(window.isVisible(), true);
  report.checks.restore_minimized = true;
  app.once('will-quit', () => {
    report.checks.quit_menu = true;
    report.checks.tray_disposed = controller.tray.isDestroyed();
    report.ok = Object.values(report.checks).every(value => value === true);
    save(); console.log(JSON.stringify(report));
  });
  controller.menu.items.at(-1).click();
}).catch(error => {report.error = error.stack; save(); console.error(error); app.exit(1);});
