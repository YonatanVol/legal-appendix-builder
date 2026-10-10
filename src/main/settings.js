'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { app, safeStorage } = require('electron');

/*
 * The Claude API key for Summarize and Translate.
 *
 * It is stored encrypted with the operating system's own protection for the signed-in
 * user (DPAPI on Windows, the Keychain on a Mac), through Electron's safeStorage. That
 * keeps it unreadable to other users of the PC and in a copied file. It does not stop a
 * program already running as the same Windows user, which can ask the system to decrypt
 * it just as this app does; the README says so.
 *
 * If the system offers no such protection, the key is not stored at all.
 */
let override = null;

function setStoreFile(file) {
  override = file;
}

function storeFile() {
  return override || path.join(app.getPath('userData'), 'settings.json');
}

async function read() {
  try {
    return JSON.parse(await fsp.readFile(storeFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

async function write(data) {
  const file = storeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data), 'utf8');
  await fsp.rename(temp, file);
}

function looksLikeKey(key) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(key || '').trim());
}

async function setApiKey(key) {
  const clean = String(key || '').trim();
  if (!looksLikeKey(clean)) throw new Error('זה לא נראה כמו מפתח API של Claude. מפתח מתחיל ב-sk-ant-.');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('המחשב הזה לא מאפשר לשמור את המפתח מוצפן, ולכן הוא לא נשמר.');
  }
  const data = await read();
  data.apiKey = safeStorage.encryptString(clean).toString('base64');
  data.apiKeyHint = `${clean.slice(0, 10)}…${clean.slice(-4)}`;
  await write(data);
  return data.apiKeyHint;
}

async function getApiKey() {
  const data = await read();
  if (!data.apiKey) return null;
  try {
    return safeStorage.decryptString(Buffer.from(data.apiKey, 'base64'));
  } catch {
    return null;
  }
}

async function apiKeyHint() {
  const data = await read();
  return data.apiKey ? data.apiKeyHint || 'שמור' : null;
}

async function clearApiKey() {
  const data = await read();
  delete data.apiKey;
  delete data.apiKeyHint;
  await write(data);
}

module.exports = { setApiKey, getApiKey, apiKeyHint, clearApiKey, looksLikeKey, setStoreFile, storeFile };
