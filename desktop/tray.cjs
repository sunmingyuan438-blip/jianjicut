const path = require('node:path');
const {Tray, Menu, nativeImage} = require('electron');

// Keep this controller alive for the lifetime of the application. The recovered
// close button calls hide(), so a persistent restore action is essential.
exports.createTray = ({app, window, resources}) => {
  const restore = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const icon = nativeImage.createFromPath(path.join(resources, 'frontend', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  const tray = new Tray(process.platform === 'darwin' ? icon.resize({width: 18, height: 18}) : icon);
  const menu = Menu.buildFromTemplate([
    {label: '打开 XYCut', click: restore},
    {type: 'separator'},
    {label: '退出 XYCut', click: () => app.quit()},
  ]);
  tray.setToolTip('XYCut 恢复版');
  tray.setContextMenu(menu);
  tray.on('click', restore);
  tray.on('double-click', restore);
  app.on('activate', restore);
  app.on('second-instance', restore);
  const dispose = () => {
    app.removeListener('activate', restore);
    app.removeListener('second-instance', restore);
    if (!tray.isDestroyed()) tray.destroy();
  };
  app.once('will-quit', dispose);
  return {tray, menu, restore, dispose};
};
