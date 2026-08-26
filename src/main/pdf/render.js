'use strict';

const { BrowserWindow } = require('electron');
const { PDFDocument } = require('pdf-lib');

// printToPDF takes pageSize in inches (not microns, and not points).
const POINTS_PER_INCH = 72;

// One hidden window is created lazily and reused for every page we generate.
// Creating and destroying a window per page fails on the second render
// (ERR_FAILED, and often a crash); reusing one is both reliable and faster.
let renderWindow = null;

function getRenderWindow() {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow;

  renderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Scripting is on because the table of contents measures its own dotted leaders
      // after layout. The pages are ours, built from escaped text, loaded from a
      // data: URL with no node access and with the network blocked session-wide.
      javascript: true,
    },
  });

  return renderWindow;
}

function disposeRenderer() {
  if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy();
  renderWindow = null;
}

/**
 * Render an HTML string to PDF bytes using Chromium's own layout and print engine.
 *
 * This is the reason the app is built on Electron: the generated pages mix Hebrew
 * with Latin digits and dates ("עמ' 10-17", "07/07/26"). Chromium resolves the
 * bidirectional ordering correctly, where a PDF text-drawing library would need it
 * resolved by hand.
 *
 * The HTML travels as a data: URL so that no case details are ever written to a
 * temporary file.
 *
 * Margins are applied by the print engine rather than as CSS padding: padding on a
 * block that spans pages is laid down only once, at the start and end of the flow, so
 * a table of contents running onto a second page would spill off the bottom edge.
 *
 * @param {string} html
 * @param {{width: number, height: number}} pageSize  in PDF points
 * @param {{top: number, bottom: number, left: number, right: number}} margins  in points
 * @param {{script?: string}} [options]  script run after layout, before printing
 * @returns {Promise<{bytes: Uint8Array, pageCount: number, scriptResult: any}>}
 */
async function renderHtmlToPdf(
  html,
  pageSize,
  margins = { top: 0, bottom: 0, left: 0, right: 0 },
  { script } = {}
) {
  const win = getRenderWindow();

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // A page may need to finish its own layout — see LEADER_SCRIPT in the templates.
  // A failure here costs the dotted leaders, not the document, so it is not fatal.
  let scriptResult = null;
  if (script) {
    try {
      scriptResult = await win.webContents.executeJavaScript(script, true);
    } catch (err) {
      scriptResult = { error: err.message };
    }
  }

  const bytes = await win.webContents.printToPDF({
    pageSize: {
      width: pageSize.width / POINTS_PER_INCH,
      height: pageSize.height / POINTS_PER_INCH,
    },
    margins: {
      top: margins.top / POINTS_PER_INCH,
      bottom: margins.bottom / POINTS_PER_INCH,
      left: margins.left / POINTS_PER_INCH,
      right: margins.right / POINTS_PER_INCH,
    },
    printBackground: true,
    preferCSSPageSize: false,
  });

  const doc = await PDFDocument.load(bytes);
  return { bytes, pageCount: doc.getPageCount(), scriptResult };
}

module.exports = { renderHtmlToPdf, disposeRenderer };
