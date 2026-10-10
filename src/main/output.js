'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Where a tool's result goes and what it is called.
 *
 * The rule the user can predict: next to the source file, as "<name> - <what>.<ext>",
 * and never over an existing file. If that name is taken, " (2)", " (3)" and so on are
 * added, so running a tool twice leaves two results rather than replacing the first.
 */

/** Windows forbids these in file names; the others are safe. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;

function safeName(name) {
  return String(name).replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim() || 'קובץ';
}

function baseName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** First free "<stem>.<ext>", "<stem> (2).<ext>", ... in `dir`. */
async function unusedPath(dir, stem, ext) {
  const clean = safeName(stem);
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  let candidate = path.join(dir, clean + suffix);
  for (let n = 2; await exists(candidate); n++) candidate = path.join(dir, `${clean} (${n})${suffix}`);
  return candidate;
}

/**
 * The output path for a result derived from `sourcePath`.
 * @param {string} sourcePath
 * @param {string} label   what was done, in Hebrew, e.g. "מאוחד"
 * @param {string} ext     "pdf", "docx", ...
 * @param {{folder?: string}} [options]  a folder chosen in settings, instead of the source's
 */
async function outputFor(sourcePath, label, ext, { folder } = {}) {
  const dir = folder || path.dirname(sourcePath);
  const stem = label ? `${baseName(sourcePath)} - ${label}` : baseName(sourcePath);
  return unusedPath(dir, stem, ext);
}

/** A folder beside the source for results that are many files (page images, split parts). */
async function outputFolderFor(sourcePath, label, { folder } = {}) {
  const dir = folder || path.dirname(sourcePath);
  const stem = `${baseName(sourcePath)} - ${label}`;
  let candidate = path.join(dir, safeName(stem));
  for (let n = 2; await exists(candidate); n++) candidate = path.join(dir, `${safeName(stem)} (${n})`);
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

module.exports = { outputFor, outputFolderFor, unusedPath, safeName, baseName };
