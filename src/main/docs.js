'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * The renderer never sees the file system. When the main process hands it a document
 * the user chose (a drop, a picker, a result), the document gets a random token, and
 * the renderer reads it back as app://office/doc/<token> for thumbnails and previews.
 *
 * Only PDFs and pictures get a token: those are all the page ever shows. Anything else
 * a page asked about is described but cannot be read back through this door.
 *
 * The token belongs to one version of the file: its path, size and modification time.
 * A letter re-saved under the same name gets a new token, so its thumbnails are drawn
 * afresh instead of showing the old pages from a cache.
 */
const SERVABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const byToken = new Map();
const byKey = new Map();

function keyFor(filePath, stat) {
  const resolved = path.resolve(filePath);
  const name = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `${name}|${stat.size}|${stat.mtimeMs}`;
}

function servable(filePath) {
  return SERVABLE.has(path.extname(filePath).toLowerCase());
}

/** A token for this version of the file, or null if it is not a kind the page shows. */
function register(filePath) {
  if (!servable(filePath)) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const key = keyFor(filePath, stat);
  const existing = byKey.get(key);
  if (existing) return existing;
  const token = crypto.randomBytes(16).toString('hex');
  byToken.set(token, path.resolve(filePath));
  byKey.set(key, token);
  return token;
}

function resolve(token) {
  return byToken.get(String(token)) || null;
}

/** Test seam. */
function clear() {
  byToken.clear();
  byKey.clear();
}

module.exports = { register, resolve, clear, servable, SERVABLE };
