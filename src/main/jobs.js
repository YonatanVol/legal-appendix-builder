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

const SCRATCH_ROOT = path.join(os.tmpdir(), 'rotem-office');
const inUse = new Set();

async function makeScratch() {
  // Named with this process's number, so a sweep can tell a folder still in use by a
  // running program (another copy, a test) from one left by a program that is gone.
  const dir = path.join(SCRATCH_ROOT, `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  inUse.add(dir);
  return dir;
}

/**
 * Removes the folders of runs that never got to clean up: the program was closed by force,
 * the computer lost power. They can hold copies of the documents (Redact keeps one while
 * it works), so they are not left lying in the temporary folder. Called when the program
 * starts. Only folders whose program is no longer running are removed; folders of an
 * older version, named without a process number, are left alone.
 */
function alive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function sweepLeftovers() {
  let names = [];
  try {
    names = await fs.readdir(SCRATCH_ROOT);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(SCRATCH_ROOT, name);
    if (inUse.has(dir)) continue;
    const pid = Number((/^(\d+)-/.exec(name) || [])[1]);
    if (!pid || alive(pid)) continue;
    await fs.rm(dir, { recursive: true, force: true }).then(() => { removed++; }, () => {});
  }
  return removed;
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
      /**
       * @param {Uint8Array|Buffer|string} bytes
       * @param {{source?: string, label?: string, ext?: string, name?: string, dir?: string}} where
       *   `dir` with `name` writes inside a folder the tool made with outputFolder().
       */
      async writeOutput(bytes, { source, label, ext = 'pdf', name, dir }) {
        throwIfAborted(controller.signal);
        const temp = path.join(scratch, `out-${job.outputs.length}.${ext}`);
        await fs.writeFile(temp, bytes);
        throwIfAborted(controller.signal);
        let target;
        if (dir) target = { dir, stem: name };
        else if (name) target = { dir: hooks.outputFolder || path.dirname(source), stem: name };
        else target = output.targetFor(source, label, { folder: hooks.outputFolder });
        const finalPath = await output.placeFile(temp, target.dir, target.stem, ext);
        job.outputs.push(finalPath);
        await fs.rm(temp, { force: true });
        return finalPath;
      },
      async outputFolder(source, label) {
        throwIfAborted(controller.signal);
        const target = output.targetFor(source, label, { folder: hooks.outputFolder });
        const folder = await output.makeFolder(target.dir, target.stem);
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
      inUse.delete(scratch);
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

async function removeAll(paths) {
  for (const p of paths) await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  paths.length = 0;
}

/** An error the user can act on. Tool code throws Hebrew messages; anything else is wrapped. */
function describe(err) {
  const message = err && err.message ? err.message : String(err);
  if (/[֐-׿]/.test(message)) return message;
  if ((err && err.name === 'PasswordException') || /No password given|Incorrect Password/i.test(message)) {
    return 'הקובץ מוגן בסיסמה, ולכן אי אפשר לעבוד עליו. הסר אותה בכלי "הסרת סיסמה" ונסה שוב.';
  }
  if (/ENOENT/.test(message)) return 'הקובץ לא נמצא. ייתכן שהוזז או נמחק.';
  if (/EACCES|EPERM|EBUSY/.test(message)) {
    return 'אין הרשאה לכתוב לתיקייה הזו, או שהקובץ פתוח בתוכנה אחרת. סגור אותו ונסה שוב.';
  }
  if (/ENOSPC/.test(message)) return 'אין מספיק מקום פנוי בדיסק.';
  return `הפעולה נכשלה: ${message}`;
}

module.exports = { start, cancel, running, Cancelled, describe, sweepLeftovers, SCRATCH_ROOT };
