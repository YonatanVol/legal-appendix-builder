'use strict';

const path = require('path');
const { ipcMain, dialog, shell } = require('electron');

const { inspect, describe } = require('./pdf/inspect');
const { computeLayout, formatRange } = require('./pdf/layout');
const { buildBundle } = require('./pdf/assemble');
const history = require('./history');
const runs = require('./runs');
const docs = require('./docs');
const jobs = require('./jobs');
const tools = require('./tools');
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

  registerToolIpc();
}

/* ---------------- the tool grid ---------------- */

const EXT_LABELS = {
  pdf: 'קובצי PDF',
  doc: 'מסמכי Word', docx: 'מסמכי Word', rtf: 'מסמכי Word', odt: 'מסמכי Word',
  ppt: 'מצגות', pptx: 'מצגות', odp: 'מצגות',
  xls: 'גיליונות', xlsx: 'גיליונות', ods: 'גיליונות', csv: 'גיליונות',
  jpg: 'תמונות', jpeg: 'תמונות', png: 'תמונות', tif: 'תמונות', tiff: 'תמונות', bmp: 'תמונות', webp: 'תמונות', heic: 'תמונות',
};

function filtersFor(extensions) {
  const groups = new Map();
  for (const ext of extensions) {
    const label = EXT_LABELS[ext] || ext.toUpperCase();
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(ext);
  }
  return [...groups].map(([name, exts]) => ({ name, extensions: exts }));
}

/** A file as the tool screens see it: description plus the token the renderer reads it by. */
async function describeAll(filePaths) {
  const files = [];
  for (const filePath of filePaths) {
    const info = await describe(filePath);
    files.push({ ...info, token: info.error && !info.encrypted ? null : docs.register(filePath) });
  }
  return files;
}

const activeJobs = new Map(); // job id -> promise, so a cancel can find it

function registerToolIpc() {
  ipcMain.handle('tools:list', async () => {
    try {
      return { ok: true, tools: await tools.list(), groups: tools.GROUPS };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('files:describe', async (_event, filePaths) => {
    try {
      return { ok: true, files: await describeAll(filePaths) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('files:pick', async (_event, { extensions = ['pdf'], multiple = true, title } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: title || 'בחירת קבצים',
      filters: filtersFor(extensions),
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: true, cancelled: true };
    try {
      return { ok: true, files: await describeAll(filePaths) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('folder:pick', async (_event, { title } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: title || 'בחירת תיקייה',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || filePaths.length === 0) return { ok: true, cancelled: true };
    return { ok: true, path: filePaths[0] };
  });

  ipcMain.handle('job:start', async (event, { toolId, inputs, options, outputFolder }) => {
    const tool = tools.runnable(toolId);
    if (!tool) return fail(new Error('הכלי הזה עדיין לא זמין בגרסה הזו.'));
    if (!Array.isArray(inputs) || inputs.some((p) => typeof p !== 'string')) {
      return fail(new Error('לא נבחרו קבצים.'));
    }
    const sender = event.sender;
    building += 1;
    try {
      const { id, promise } = jobs.start(tool, inputs, options || {}, {
        outputFolder: outputFolder || undefined,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send('job:progress', progress);
        },
      });
      activeJobs.set(id, promise);
      if (!sender.isDestroyed()) sender.send('job:started', { id, toolId });
      const result = await promise;
      activeJobs.delete(id);

      if (result.ok) {
        try {
          await runs.record({ toolId, inputs, options: options || {}, outputs: result.outputs, summary: result.summary });
        } catch (err) {
          console.error('runs: could not record the run:', err.message);
        }
        for (const out of result.outputs) {
          if (/\.pdf$/i.test(out)) docs.register(out);
        }
      }
      return { ...result, id };
    } catch (err) {
      return fail(err);
    } finally {
      building -= 1;
    }
  });

  ipcMain.handle('job:cancel', (_event, id) => ({ ok: true, cancelled: jobs.cancel(id) }));

  ipcMain.handle('runs:list', async () => {
    try {
      return { ok: true, entries: await runs.list() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('runs:remove', async (_event, id) => {
    try {
      return { ok: true, removed: await runs.remove(id) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('runs:recent', async () => {
    try {
      const files = await runs.recentFiles();
      return { ok: true, files: await describeAll(files.map((f) => f.path)) };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerIpc, titleFromFilename, isBuilding, filtersFor };
