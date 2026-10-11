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
// A page pdf.js has not drawn in this long is given up on: a file can be made so that
// drawing it never ends.
let pageLimitMs = 120000;

let win = null;
let opening = null;

async function page() {
  if (win && !win.isDestroyed()) return win;
  if (!opening) {
    opening = (async () => {
      require('../window').serveRenderer();
      const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      try {
        await w.loadURL(URL);
        const deadline = Date.now() + 15000;
        while (!(await w.webContents.executeJavaScript('window.pagePictureReady === true', true))) {
          if (Date.now() > deadline) throw new Error('page pictures did not load');
          await new Promise((r) => setTimeout(r, 30));
        }
      } catch (err) {
        if (!w.isDestroyed()) w.destroy();
        throw err;
      }
      // A page that ran out of memory takes the window with it; the next call opens anew.
      w.webContents.on('render-process-gone', () => { if (win === w) dispose(); });
      win = w;
      return w;
    })().finally(() => { opening = null; });
  }
  return opening;
}

/**
 * Runs code in the window, stopping at once when `signal` aborts or the time is up: the
 * window is then closed, which is the only way to stop pdf.js mid-page.
 */
function call(code, { signal, limit = pageLimitMs } = {}) {
  return page().then((w) => new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!w.isDestroyed()) w.webContents.removeListener('destroyed', onGone);
      fn(value);
    };
    const onAbort = () => {
      dispose();
      finish(reject, Object.assign(new Error('cancelled'), { cancelled: true }));
    };
    const timer = setTimeout(() => {
      dispose();
      finish(reject, Object.assign(new Error('drawing the page took too long'), { timedOut: true }));
    }, limit);
    // A window that is gone never answers: say so at once rather than at the time limit.
    // (A page that dies takes the window with it; see page().)
    const onGone = () => finish(reject, new Error('the drawing window was lost'));
    w.webContents.once('destroyed', onGone);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    w.webContents.executeJavaScript(code, true).then((v) => finish(resolve, v), (e) => finish(reject, e));
  }));
}

/**
 * A view of one file: its pages as pdf.js counts them, and pictures of them one at a time.
 * Release it when done.
 * @param {string} file
 * @param {{signal?: AbortSignal}} [options]
 */
function open(file, { signal } = {}) {
  const token = docs.register(file);
  if (!token) throw new Error('not a PDF this app can draw');
  const t = JSON.stringify(token);
  return {
    /** [[objectNumber, generation], ...] for every page, in pdf.js's order. */
    pageList: () => call(`window.pageList(${t})`, { signal }),
    /** One page (0-based): { png: Buffer, width, height } with the size in points as shown. */
    async draw(index, dpi = 200) {
      const r = await call(`window.drawPage(${t}, ${Number(index)}, ${Number(dpi)})`, { signal });
      return { png: Buffer.from(r.png, 'base64'), width: r.width, height: r.height };
    },
    /**
     * How different page `index` of `other` (another view) looks from page `index` of
     * this one, 0 to 255 (see comparePages in page-picture.mjs).
     */
    compare(index, other, { boxes = [], masks = [], pictured = false } = {}) {
      return call(`window.comparePages(${t}, ${Number(index)}, ${JSON.stringify(other.token)}, ${Number(index)}, ${JSON.stringify({ boxes, masks, pictured })})`, { signal });
    },
    token,
    async release() {
      if (win && !win.isDestroyed()) await win.webContents.executeJavaScript(`window.release(${t})`, true).catch(() => {});
    },
  };
}

/** For tests: a shorter time limit per page. */
function setPageLimitForTest(ms) {
  pageLimitMs = ms;
}

/** For tests: whether the window is open, and the window itself. */
function windowForTest() {
  return win && !win.isDestroyed() ? win : null;
}

function dispose() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { open, dispose, windowForTest, setPageLimitForTest };
