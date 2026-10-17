'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * Saved signatures, so a person draws theirs once. Kept in the user's own app data
 * folder on this PC, as PNG pictures; never sent anywhere. Each PC has its own.
 */
const MAX = 12;
let override = null;

function setStoreFile(file) {
  override = file;
}

function storeFile() {
  return override || path.join(app.getPath('userData'), 'signatures.json');
}

// Saves and removals run one at a time, so two at once cannot overwrite each other.
let queue = Promise.resolve();
const serial = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

async function list() {
  let raw;
  try {
    raw = await fsp.readFile(storeFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A damaged file is not treated as empty: the next save would erase every signature.
    throw new Error('קובץ החתימות השמורות פגום, ולכן לא נשמר בו דבר. החתימות לא נמחקו.');
  }
  return (parsed.signatures || []).filter((s) => s && typeof s.id === 'string' && /^data:image\/png;base64,/.test(s.dataUrl));
}

async function write(signatures) {
  const file = storeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ version: 1, signatures }), 'utf8');
  await fsp.rename(temp, file);
}

function save(spec) {
  return serial(() => saveNow(spec));
}

async function saveNow({ dataUrl, kind }) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl)) || dataUrl.length > 4 * 1024 * 1024) {
    throw new Error('החתימה אינה תמונה תקינה.');
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), dataUrl, kind: String(kind || 'draw'), savedAt: new Date().toISOString() };
  const rest = await list();
  await write([entry, ...rest].slice(0, MAX));
  return entry;
}

function remove(id) {
  return serial(async () => {
    const rest = (await list()).filter((s) => s.id !== id);
    await write(rest);
    return true;
  });
}

module.exports = { list, save, remove, setStoreFile, storeFile };
