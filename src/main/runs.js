'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * Every tool run is recorded: which tool, which files, which options, what came out.
 * That lets a run be repeated with one click and an output be found again later.
 * Paths only; the documents are never copied.
 *
 * The appendix builder keeps its own store (history.js), because its rows are
 * arrangements that can be reopened for editing, which these cannot.
 */

const FILE_VERSION = 1;
const MAX_ENTRIES = 500;

let overrideFile = null;

function setStoreFile(filePath) {
  overrideFile = filePath;
}

function storeFile() {
  return overrideFile || path.join(app.getPath('userData'), 'runs.json');
}

function isUsable(entry) {
  return (
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.toolId === 'string' &&
    Array.isArray(entry.inputs) &&
    entry.inputs.every((p) => typeof p === 'string') &&
    Array.isArray(entry.outputs) &&
    entry.outputs.every((p) => typeof p === 'string')
  );
}

async function read() {
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isUsable);
  } catch {
    return [];
  }
}

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (!TRANSIENT.has(err.code) || attempt >= 6) throw err;
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

// Passwords are never written to disk; a repeated run asks for them again. Tokens are
// per session and per file version, so a recorded one would only mislead a later run.
const SECRET = /password|token/i;

// Pictures (a signature, an inserted image) travel as long data: strings. They are not
// recorded: a signature does not belong in a history file, and they would make it huge.
// An object that held one is left out of a recorded list as a whole.
const LONG = 4096;

function clean(value) {
  if (typeof value === 'string') return value.length > LONG ? undefined : value;
  if (Array.isArray(value)) {
    return value.map(clean).filter((v, i) => v !== undefined && !(value[i] && typeof value[i] === 'object' && hasLong(value[i])));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET.test(k)) continue;
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return value;
}

function hasLong(value) {
  if (typeof value === 'string') return value.length > LONG;
  if (value && typeof value === 'object') return Object.values(value).some(hasLong);
  return false;
}

function withoutSecrets(options) {
  if (!options || typeof options !== 'object') return {};
  return clean(options);
}

/**
 * @param {{toolId: string, inputs: string[], options: object, outputs: string[], summary?: string}} run
 */
async function record(run) {
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    toolId: run.toolId,
    savedAt: new Date().toISOString(),
    inputs: run.inputs.slice(),
    inputNames: run.inputs.map((p) => path.basename(p)),
    options: withoutSecrets(run.options),
    outputs: run.outputs.slice(),
    outputNames: run.outputs.map((p) => path.basename(p)),
    summary: run.summary || '',
  };
  const rest = await read();
  await write([entry, ...rest].slice(0, MAX_ENTRIES));
  return entry;
}

/** Newest first, with a cheap check of whether each output still exists. */
async function list() {
  const entries = await read();
  return entries
    .slice()
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .map((entry) => ({
      ...entry,
      outputsExist: entry.outputs.map((p) => fs.existsSync(p)),
    }));
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

/** The files most recently used as inputs, newest first, each once, still existing. */
async function recentFiles(limit = 8) {
  const seen = new Set();
  const out = [];
  for (const entry of await list()) {
    for (const p of [...entry.outputs, ...entry.inputs]) {
      const key = process.platform === 'win32' ? p.toLowerCase() : p;
      if (seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: p, name: path.basename(p) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { withoutSecrets, record, list, get, remove, recentFiles, setStoreFile, storeFile };
