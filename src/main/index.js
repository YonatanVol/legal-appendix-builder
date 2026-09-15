'use strict';

const { app, BrowserWindow } = require('electron');

const { registerIpc, isBuilding } = require('./ipc');
const { disposeRenderer } = require('./pdf/render');
const { lockDownNetwork } = require('./security');
const { createWindow } = require('./window');
const updater = require('./updater');
const { version } = require('../../package.json');

// Must match appId in electron-builder.yml; test/config.js checks that it does. Windows
// uses it to tie the running window to its Start-menu shortcut and taskbar pin.
const APP_ID = 'com.rotem.office.appendixbuilder';

if (process.env.APPENDIX_BUILDER_SELFTEST) {
  // Run by the Windows CI against the installed program. See src/main/selftest.js.
  require('./selftest').run();
} else if (!app.requestSingleInstanceLock()) {
  // A second copy would write the same history file and, worse, try to install the same
  // update when it closes. The installer launches the app when it finishes, so a double
  // start is easy to cause; send her to the window that is already open instead.
  app.quit();
} else {
  let mainWindow = null;

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    lockDownNetwork();
    registerIpc();
    mainWindow = createWindow();
    updater.start({ getWindow: () => mainWindow, isBuilding, version });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('before-quit', disposeRenderer);
}

module.exports = { APP_ID };
