'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * A record of the bundles that have been produced, so an arrangement can be reopened
 * and corrected instead of rebuilt from nothing.
 *
 * Only the arrangement is kept: which files, in what order, under what titles. The
 * documents themselves stay where they are. They are medical records, and duplicating
 * them into the app's own folder would be both a privacy cost and hundreds of
 * megabytes per case. What was lost after a build was never the files.
 */

const FILE_VERSION = 1;
// Enough that a year of work fits; a bound so the file cannot grow without limit.
const MAX_ENTRIES = 200;

let overrideFile = null;

/** Test seam: point the store at a scratch file instead of the real user's history. */
function setStoreFile(filePath) {
  overrideFile = filePath;
}

function storeFile() {
  return overrideFile || path.join(app.getPath('userData'), 'history.json');
}

/**
 * Entries are keyed by output file, so rebuilding a corrected bundle updates its row
 * rather than adding a near-duplicate. Windows paths are case-insensitive and may mix
 * separators, so the key is resolved and folded, or the same file would key twice.
 */
function keyFor(outputPath) {
  const resolved = path.resolve(outputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const idFor = (outputPath) =>
  crypto.createHash('sha1').update(keyFor(outputPath)).digest('hex').slice(0, 12);

/** The file is on disk and can be edited or truncated; never trust its shape. */
function isUsable(entry) {
  return (
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.outputPath === 'string' &&
    typeof entry.bodyPath === 'string' &&
    Array.isArray(entry.appendices) &&
    entry.appendices.every(
      (a) => a && typeof a.title === 'string' && Array.isArray(a.files) &&
        a.files.every((f) => typeof f === 'string')
    )
  );
}

/** Missing or damaged history yields an empty list rather than breaking the app. */
async function read() {
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isUsable);
  } catch {
    return [];
  }
}

/** Written through a temporary file so an interrupted write cannot corrupt the store. */
// On Windows, antivirus and the search indexer open a file the moment it is written, and
// for that instant a rename over it fails with EPERM, EBUSY or EACCES. Waiting a beat
// and trying again is what every Windows tool does; giving up would drop the row.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (!TRANSIENT.has(err.code) || attempt >= RENAME_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
    }
  }
}

async function write(entries) {
  const file = storeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ version: FILE_VERSION, entries }, null, 2), 'utf8');
  try {
    await renameWithRetry(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * @param {{outputPath: string, bodyPath: string, appendices: {title: string, files: string[]}[]}} spec
 * @param {{totalPages: number, tocPage: number}} result
 */
/**
 * Read, replace, write. That is safe here because the app has one window and the
 * build button is disabled while a build runs, so two records cannot overlap. A
 * second writer would need locking rather than this.
 */
async function record(spec, result) {
  const key = keyFor(spec.outputPath);

  const entry = {
    id: idFor(spec.outputPath),
    outputPath: spec.outputPath,
    outputName: path.basename(spec.outputPath),
    savedAt: new Date().toISOString(),
    bodyPath: spec.bodyPath,
    bodyName: path.basename(spec.bodyPath),
    appendices: spec.appendices.map((a) => ({
      title: String(a.title).trim(),
      files: a.files.slice(),
    })),
    totalPages: result.totalPages,
    tocPage: result.tocPage,
  };

  const rest = (await read()).filter((e) => keyFor(e.outputPath) !== key);
  await write([entry, ...rest].slice(0, MAX_ENTRIES));
  return entry;
}

/**
 * Newest first. `outputExists` is a cheap stat so the list can hide "open the PDF"
 * for a bundle that has since been moved or deleted; no PDF is opened or parsed here,
 * because the drawer has to appear instantly.
 */
async function list() {
  const entries = await read();
  return entries
    .slice()
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .map((entry) => ({ ...entry, outputExists: fs.existsSync(entry.outputPath) }));
}

async function get(id) {
  return (await read()).find((entry) => entry.id === id) || null;
}

async function remove(id) {
  const entries = await read();
  const rest = entries.filter((entry) => entry.id !== id);
  if (rest.length !== entries.length) await write(rest);
  return rest.length !== entries.length;
}

module.exports = { record, list, get, remove, setStoreFile, storeFile, idFor, keyFor };
