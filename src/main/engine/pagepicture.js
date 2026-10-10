'use strict';

const { BrowserWindow } = require('electron');

const docs = require('../docs');

/*
 * Pictures of pages drawn by pdf.js, in a hidden window, for Redact. The screen showed
 * the user each page through pdf.js, and the user marked what to black out on that
 * picture; drawing the redacted page the same way means it holds exactly what they saw.
 * Ghostscript, drawing the same page, follows other rules: it prints annotations a
 * viewer hides, ignores layers set on annotations, and works out less of the layer rules.
 *
 * The window loads the app's own page (app://office) with no Node and no network (the
 * session blocks it), and reads the document by token, as the main window does.
 */

const URL = 'app://office/page-picture.html';

let win = null;
let opening = null;

async function page() {
  if (win && !win.isDestroyed()) return win;
  if (!opening) {
    opening = (async () => {
      require('../window').serveRenderer();
      const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await w.loadURL(URL);
      const deadline = Date.now() + 15000;
      while (!(await w.webContents.executeJavaScript('window.pagePictureReady === true', true))) {
        if (Date.now() > deadline) throw new Error('page pictures did not load');
        await new Promise((r) => setTimeout(r, 30));
      }
      win = w;
      return w;
    })().finally(() => { opening = null; });
  }
  return opening;
}

/**
 * Pictures of the given pages (0-based) of `file`, as PNG buffers, in that order.
 * @param {string} file
 * @param {number[]} pages
 * @param {{dpi?: number, ctx?: {throwIfCancelled: Function}}} [options]
 */
async function drawPages(file, pages, { dpi = 200, ctx } = {}) {
  const token = docs.register(file);
  if (!token) throw new Error('הקובץ אינו PDF שאפשר לצייר.');
  const w = await page();
  const out = [];
  try {
    for (const index of pages) {
      const b64 = await w.webContents.executeJavaScript(`window.drawPage(${JSON.stringify(token)}, ${Number(index)}, ${Number(dpi)})`, true);
      out.push(Buffer.from(b64, 'base64'));
      if (ctx) ctx.throwIfCancelled();
    }
  } finally {
    if (!w.isDestroyed()) await w.webContents.executeJavaScript(`window.release(${JSON.stringify(token)})`, true).catch(() => {});
  }
  return out;
}

function dispose() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { drawPages, dispose };
