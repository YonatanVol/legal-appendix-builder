'use strict';

const path = require('path');
const { ipcMain, dialog, shell } = require('electron');

const { inspect } = require('./pdf/inspect');
const { computeLayout, formatRange } = require('./pdf/layout');
const { buildBundle } = require('./pdf/assemble');
const history = require('./history');
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

/**
 * Read a file back for a restore. Anything that stops it being usable, gone, moved,
 * corrupt or encrypted, comes back as missing rather than throwing: the rest of the
 * arrangement is still worth restoring, and she can point at the one file again.
 */
async function inspectOrMissing(filePath) {
  try {
    return { ...(await inspect(filePath)), missing: false };
  } catch (err) {
    return {
      path: filePath,
      name: path.basename(filePath),
      pageCount: 0,
      missing: true,
      reason: err.message,
    };
  }
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

// True while a filing is being written. The updater reads it so that a restart can
// never land in the middle of a build.
let building = 0;
const isBuilding = () => building > 0;

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

  // Used when a restored file is no longer where it was, so the dialog says so
  // rather than reusing a picker titled for a different job.
  ipcMain.handle('pick:locate', async (_event, missingName) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: missingName ? `אתר את הקובץ "${missingName}"` : 'אתר את הקובץ',
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
    building += 1;
    try {
      const result = await buildBundle(spec, (stage) => {
        if (!sender.isDestroyed()) sender.send('bundle:progress', stage);
      });

      // The bundle already exists on disk. Losing its history row is a small
      // inconvenience; reporting a failed build would be a lie.
      let historyId = null;
      try {
        historyId = (await history.record(spec, result)).id;
      } catch (err) {
        console.error('history: could not record the bundle:', err.message);
      }

      return { ok: true, result: { ...result, historyId } };
    } catch (err) {
      return fail(err);
    } finally {
      building -= 1;
    }
  });

  ipcMain.handle('history:list', async () => {
    try {
      return { ok: true, entries: await history.list() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('history:restore', async (_event, id) => {
    try {
      const entry = await history.get(id);
      if (!entry) return fail(new Error('התיק הזה כבר לא נמצא בהיסטוריה.'));

      // Every file is read again rather than trusting the page counts that were
      // stored. Correcting a letter is the whole point of this feature, and a
      // corrected letter is a different length: stale counts would put every range
      // in the table of contents quietly wrong.
      const body = await inspectOrMissing(entry.bodyPath);

      const appendices = [];
      for (const appendix of entry.appendices) {
        const files = [];
        for (const file of appendix.files) files.push(await inspectOrMissing(file));
        appendices.push({ title: appendix.title, files });
      }

      return {
        ok: true,
        restored: {
          id: entry.id,
          outputPath: entry.outputPath,
          savedAt: entry.savedAt,
          body,
          appendices,
        },
      };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('history:remove', async (_event, id) => {
    try {
      return { ok: true, removed: await history.remove(id) };
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

module.exports = { registerIpc, titleFromFilename, isBuilding };
