'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Where a tool's result goes and what it is called.
 *
 * The rule the user can predict: next to the source file, as "<name> - <what>.<ext>",
 * and never over an existing file. If that name is taken, " (2)", " (3)" and so on are
 * added, so running a tool twice leaves two results rather than replacing the first.
 *
 * Names are claimed, not checked: a file is placed with an exclusive copy and a folder
 * made with a non-recursive mkdir, each of which fails if the name exists. Checking
 * first and writing after would let two runs at the same moment, say two people on a
 * shared office drive, land on the same name, and a cancelled run then removes what it
 * made, which would be the other person's work.
 */

/** Windows forbids these in file names; the others are safe. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_TRIES = 500;

function safeName(name) {
  return String(name).replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'קובץ';
}

function baseName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function candidates(dir, stem, suffix) {
  const clean = safeName(stem);
  const list = [];
  for (let n = 1; n <= MAX_TRIES; n++) list.push(path.join(dir, n === 1 ? `${clean}${suffix}` : `${clean} (${n})${suffix}`));
  return list;
}

/**
 * Copy `fromFile` to the first free "<stem>.<ext>", "<stem> (2).<ext>", ... in `dir`.
 * The name is claimed first with an exclusive create, then filled; if filling fails,
 * the claimed file is removed, so a half-written result is never left behind.
 */
async function placeFile(fromFile, dir, stem, ext) {
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  await fs.mkdir(dir, { recursive: true });
  for (const candidate of candidates(dir, stem, suffix)) {
    let handle;
    try {
      handle = await fs.open(candidate, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await handle.close();
      await fs.copyFile(fromFile, candidate);
      return candidate;
    } catch (err) {
      await fs.rm(candidate, { force: true }).catch(() => {});
      throw err;
    }
  }
  throw new Error(`יש כבר יותר מדי קבצים בשם "${safeName(stem)}" בתיקייה הזו.`);
}

/** Make the first free "<stem>", "<stem> (2)", ... folder in `dir`; it is new and ours. */
async function makeFolder(dir, stem) {
  await fs.mkdir(dir, { recursive: true });
  for (const candidate of candidates(dir, stem, '')) {
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`יש כבר יותר מדי תיקיות בשם "${safeName(stem)}".`);
}

/** The folder and stem for a result derived from `sourcePath`. */
function targetFor(sourcePath, label, { folder } = {}) {
  return {
    dir: folder || path.dirname(sourcePath),
    stem: label ? `${baseName(sourcePath)} - ${label}` : baseName(sourcePath),
  };
}

module.exports = { placeFile, makeFolder, targetFor, safeName, baseName };
