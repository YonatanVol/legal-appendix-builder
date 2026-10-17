'use strict';

/**
 * Opens the app's page the way the app does: served over app://office, not file://.
 * Requiring this registers the scheme, which Electron only allows before the app is
 * ready, so test files require it at the top.
 */

const path = require('path');
const { BrowserWindow } = require('electron');

const { registerSchemes } = require('../../src/main/protocol');
const { serveRenderer, INDEX_URL } = require('../../src/main/window');

registerSchemes();

/**
 * @param {{width?: number, height?: number, screen?: string}} [options]
 *   screen: 'appendix' opens the appendix builder, as the older suites expect.
 */
async function openWindow({ width = 1240, height = 900, screen } = {}) {
  serveRenderer();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Collected from before the first byte loads: a script that fails to parse reports
  // only once, while the page is loading.
  win.consoleErrors = [];
  win.webContents.on('console-message', (event) => {
    const level = event.level !== undefined ? event.level : event;
    const message = event.message || '';
    if (level === 'error' || level === 3 || /^thumbnail:|^panel:/.test(message)) {
      if (!/update:status/.test(message)) win.consoleErrors.push(message);
    }
  });
  await win.loadURL(INDEX_URL);
  await win.webContents.executeJavaScript('window.shell.ready', true);
  if (screen) await win.webContents.executeJavaScript(`window.shell.open(${JSON.stringify(screen)})`, true);
  return win;
}

module.exports = { openWindow };
