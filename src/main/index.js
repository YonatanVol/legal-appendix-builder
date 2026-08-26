'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const { registerIpc } = require('./ipc');
const { disposeRenderer } = require('./pdf/render');
const { lockDownNetwork } = require('./security');
const { version } = require('../../package.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: `בונה תיקי נספחים ${version}`,
    backgroundColor: '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // External links would be blocked anyway; refuse to even open a window for them.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // The renderer keeps a hidden window alive for generating pages. It is not a window
  // the user ever closes, so quitting is driven off this one instead of
  // 'window-all-closed', which would otherwise never fire.
  win.on('closed', () => {
    disposeRenderer();
    if (process.platform !== 'darwin') app.quit();
  });

  return win;
}

app.whenReady().then(() => {
  lockDownNetwork();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', disposeRenderer);
