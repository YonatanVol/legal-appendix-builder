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

async function list() {
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    return (parsed.signatures || []).filter((s) => s && typeof s.id === 'string' && /^data:image\/png;base64,/.test(s.dataUrl));
  } catch {
    return [];
  }
}

async function write(signatures) {
  const file = storeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ version: 1, signatures }), 'utf8');
  await fsp.rename(temp, file);
}

async function save({ dataUrl, kind }) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl)) || dataUrl.length > 4 * 1024 * 1024) {
    throw new Error('החתימה אינה תמונה תקינה.');
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), dataUrl, kind: String(kind || 'draw'), savedAt: new Date().toISOString() };
  const rest = await list();
  await write([entry, ...rest].slice(0, MAX));
  return entry;
}

async function remove(id) {
  const rest = (await list()).filter((s) => s.id !== id);
  await write(rest);
  return true;
}

module.exports = { list, save, remove, setStoreFile, storeFile };
