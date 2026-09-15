'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const { disposeRenderer } = require('./pdf/render');
const { version } = require('../../package.json');

/**
 * The one window the app has. The self-test opens this same window, hidden, so what it
 * exercises on Windows is what Rotem gets rather than a copy that could drift.
 */
function createWindow({ show = true, quitOnClose = true } = {}) {
  const win = new BrowserWindow({
    width: 1040,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    show,
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

  // The page carries its own <title>, which replaces whatever the window was given
  // as soon as it loads. Setting it again afterwards keeps the version visible in
  // the title bar and the task bar, which is where a build gets identified.
  win.webContents.on('did-finish-load', () => {
    win.setTitle(`בונה תיקי נספחים ${version}`);
  });

  // External links would be blocked anyway; refuse to even open a window for them.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // The renderer keeps a hidden window alive for generating pages. It is not a window
  // the user ever closes, so quitting is driven off this one instead of
  // 'window-all-closed', which would otherwise never fire.
  if (quitOnClose) {
    win.on('closed', () => {
      disposeRenderer();
      if (process.platform !== 'darwin') app.quit();
    });
  }

  return win;
}

module.exports = { createWindow };
