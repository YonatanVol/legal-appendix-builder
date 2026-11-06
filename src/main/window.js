'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const { disposeRenderer } = require('./pdf/render');
const { registerAppProtocol, defaultMounts, INDEX_URL } = require('./protocol');
const { version } = require('../../package.json');

const PRODUCT = 'כלי המשרד';
const TITLE = `${PRODUCT} ${version}`;

let protocolReady = false;

/**
 * Serve the renderer on app://office. Idempotent, so every harness that opens the
 * window (the app, the self-test, the UI tests) can call it without caring who was
 * first.
 */
function serveRenderer(ses = session.defaultSession) {
  if (protocolReady) return;
  registerAppProtocol(ses, defaultMounts());
  protocolReady = true;
}

/**
 * The one window the app has. The self-test opens this same window, hidden, so what it
 * exercises on Windows is what the office gets rather than a copy that could drift.
 */
function createWindow({ show = true, quitOnClose = true } = {}) {
  serveRenderer();

  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show,
    title: TITLE,
    backgroundColor: '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(INDEX_URL);

  // The page carries its own <title>, which replaces whatever the window was given
  // as soon as it loads. Setting it again afterwards keeps the version visible in
  // the title bar and the task bar, which is where a build gets identified.
  win.webContents.on('did-finish-load', () => {
    win.setTitle(TITLE);
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

module.exports = { createWindow, serveRenderer, PRODUCT, TITLE, INDEX_URL };
