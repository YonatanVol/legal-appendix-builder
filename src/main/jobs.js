'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const output = require('./output');

/**
 * Runs tools. A tool is a function of plain data: input paths, the options object the
 * screen produced, and a context for progress, cancellation and writing results.
 *
 * What the context promises:
 *  - progress(fraction, text): the window shows a bar and the stage in words.
 *  - signal: an AbortSignal; Esc aborts it. Tools check it between pages.
 *  - scratch: a private temporary folder, deleted when the run ends however it ends.
 *  - writeOutput(bytes, {source, label, ext}): writes next to the source file under a
 *    name that is never taken, through a temporary file, so a cancelled or failed run
 *    leaves nothing half written. Outputs of a cancelled run are removed again.
 */

const jobs = new Map();
let nextId = 1;

class Cancelled extends Error {
  constructor() {
    super('הפעולה בוטלה.');
    this.name = 'Cancelled';
    this.cancelled = true;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new Cancelled();
}

async function makeScratch() {
  const dir = path.join(os.tmpdir(), 'rotem-office', crypto.randomBytes(6).toString('hex'));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {{id: string, run: Function}} tool
 * @param {string[]} inputs
 * @param {object} options
 * @param {{onProgress?: Function, outputFolder?: string}} [hooks]
 */
function start(tool, inputs, options, hooks = {}) {
  const id = String(nextId++);
  const controller = new AbortController();
  const job = {
    id,
    toolId: tool.id,
    inputs,
    options,
    controller,
    outputs: [],
    startedAt: Date.now(),
    lastProgress: { fraction: 0, text: '' },
  };
  jobs.set(id, job);

  job.promise = (async () => {
    const scratch = await makeScratch();
    let lastSent = 0;
    const ctx = {
      signal: controller.signal,
      scratch,
      progress(fraction, text) {
        throwIfAborted(controller.signal);
        job.lastProgress = { fraction: clamp(fraction), text: text || job.lastProgress.text };
        const now = Date.now();
        // At most ~30 updates a second reach the window; a page loop can call far more.
        if (hooks.onProgress && (now - lastSent > 33 || fraction >= 1)) {
          lastSent = now;
          hooks.onProgress({ id, ...job.lastProgress });
        }
      },
      async writeOutput(bytes, { source, label, ext = 'pdf', name }) {
        throwIfAborted(controller.signal);
        const finalPath = name
          ? await output.unusedPath(hooks.outputFolder || path.dirname(source), name, ext)
          : await output.outputFor(source, label, ext, { folder: hooks.outputFolder });
        const temp = path.join(scratch, `out-${job.outputs.length}.${ext}`);
        await fs.writeFile(temp, bytes);
        throwIfAborted(controller.signal);
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await moveFile(temp, finalPath);
        job.outputs.push(finalPath);
        return finalPath;
      },
      async outputFolder(source, label) {
        throwIfAborted(controller.signal);
        const folder = await output.outputFolderFor(source, label, { folder: hooks.outputFolder });
        job.outputs.push(folder);
        return folder;
      },
      cancelled: () => controller.signal.aborted,
      throwIfCancelled: () => throwIfAborted(controller.signal),
    };

    try {
      const result = await tool.run({ inputs, options, ctx });
      throwIfAborted(controller.signal);
      return { ok: true, outputs: job.outputs.slice(), ...result };
    } catch (err) {
      if (controller.signal.aborted || (err && err.cancelled)) {
        await removeAll(job.outputs);
        return { ok: false, cancelled: true, error: new Cancelled().message };
      }
      await removeAll(job.outputs);
      return { ok: false, error: describe(err) };
    } finally {
      jobs.delete(id);
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return { id, promise: job.promise };
}

function cancel(id) {
  const job = jobs.get(String(id));
  if (!job) return false;
  job.controller.abort();
  return true;
}

function running() {
  return jobs.size;
}

function clamp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** rename() fails across drives on Windows; copy and delete is the fallback. */
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

async function removeAll(paths) {
  for (const p of paths) await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  paths.length = 0;
}

/** An error the user can act on. Tool code throws Hebrew messages; anything else is wrapped. */
function describe(err) {
  const message = err && err.message ? err.message : String(err);
  if (/[֐-׿]/.test(message)) return message;
  if (/ENOENT/.test(message)) return 'הקובץ לא נמצא. ייתכן שהוזז או נמחק.';
  if (/EACCES|EPERM|EBUSY/.test(message)) {
    return 'אין הרשאה לכתוב לתיקייה הזו, או שהקובץ פתוח בתוכנה אחרת. סגור אותו ונסה שוב.';
  }
  if (/ENOSPC/.test(message)) return 'אין מספיק מקום פנוי בדיסק.';
  return `הפעולה נכשלה: ${message}`;
}

module.exports = { start, cancel, running, Cancelled, describe };
