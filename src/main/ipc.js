'use strict';

const path = require('path');
const { ipcMain, dialog, shell } = require('electron');

const { inspect } = require('./pdf/inspect');
const { computeLayout, formatRange } = require('./pdf/layout');
const { buildBundle } = require('./pdf/assemble');
// Read from the manifest rather than app.getVersion(): that only resolves the app's
// own package.json in some launch contexts, and reports Electron's version otherwise.
const { version } = require('../../package.json');

const PDF_FILTER = [{ name: 'קובצי PDF', extensions: ['pdf'] }];

/** Turn "1 - פרוטוקול ועדה.pdf" into "פרוטוקול ועדה" as a starting point. */
function titleFromFilename(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/^\s*\d+\s*[-–_.)]\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function inspectAll(filePaths) {
  const results = [];
  for (const filePath of filePaths) {
    results.push({ ...(await inspect(filePath)), suggestedTitle: titleFromFilename(filePath) });
  }
  return results;
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

function registerIpc() {
  ipcMain.handle('app:version', () => ({ ok: true, version }));

  ipcMain.handle('pick:body', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'בחר את כתב התביעה',
      filters: PDF_FILTER,
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: true, cancelled: true };

    try {
      return { ok: true, file: (await inspectAll(filePaths))[0] };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('pick:appendix', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'בחר קבצים לנספח',
      filters: PDF_FILTER,
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || filePaths.length === 0) return { ok: true, cancelled: true };

    try {
      return { ok: true, files: await inspectAll(filePaths) };
    } catch (err) {
      return fail(err);
    }
  });

  // Files arriving by drag-and-drop skip the dialog, so they are inspected here.
  ipcMain.handle('inspect:files', async (_event, filePaths) => {
    try {
      return { ok: true, files: await inspectAll(filePaths) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('layout:preview', (_event, bodyPages, appendixPageCounts) => {
    try {
      if (!bodyPages || appendixPageCounts.length === 0) return { ok: true, layout: null };
      // A single-page table of contents covers any realistic number of appendices;
      // the build re-resolves it for real before writing anything.
      const layout = computeLayout(bodyPages, appendixPageCounts, 1);
      return {
        ok: true,
        layout: {
          ...layout,
          appendices: layout.appendices.map((a) => ({ ...a, range: formatRange(a) })),
        },
      };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('pick:output', async (_event, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'שמירת התיק',
      defaultPath: defaultName,
      filters: PDF_FILTER,
    });
    return canceled || !filePath ? { ok: true, cancelled: true } : { ok: true, path: filePath };
  });

  ipcMain.handle('bundle:build', async (event, spec) => {
    const sender = event.sender;
    try {
      const result = await buildBundle(spec, (stage) => {
        if (!sender.isDestroyed()) sender.send('bundle:progress', stage);
      });
      return { ok: true, result };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('shell:open', async (_event, filePath) => {
    const error = await shell.openPath(filePath);
    return error ? fail(new Error(error)) : { ok: true };
  });

  ipcMain.handle('shell:reveal', (_event, filePath) => {
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}

module.exports = { registerIpc, titleFromFilename };
