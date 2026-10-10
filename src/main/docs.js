'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * The renderer never sees the file system. When the main process hands it a document
 * (after a drop, a picker, or a history restore), the document gets a random token,
 * and the renderer reads it back as app://office/doc/<token> for thumbnails and
 * previews. A token cannot be guessed, and the table only ever holds files the user
 * chose in this session, so the renderer still cannot read anything else.
 */
const byToken = new Map();
const byPath = new Map();

function keyFor(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function register(filePath) {
  const key = keyFor(filePath);
  const existing = byPath.get(key);
  if (existing) return existing;
  const token = crypto.randomBytes(16).toString('hex');
  byToken.set(token, path.resolve(filePath));
  byPath.set(key, token);
  return token;
}

function resolve(token) {
  return byToken.get(String(token)) || null;
}

/** Test seam. */
function clear() {
  byToken.clear();
  byPath.clear();
}

module.exports = { register, resolve, clear };
