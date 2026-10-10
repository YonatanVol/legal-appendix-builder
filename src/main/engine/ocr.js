'use strict';

const path = require('path');
const { utilityProcess } = require('electron');

/*
 * Supervises the OCR process: one page at a time, because each Tesseract worker holds
 * its own core and language data, around 150 MB, and the office PCs are not large.
 */
let child = null;
let seq = 0;
const pending = new Map();

function spawn() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'ocr-worker.js'), [], { stdio: 'ignore', serviceName: 'office-ocr' });
  child.on('message', (msg) => {
    if (msg.type !== 'done') return;
    const settle = pending.get(msg.result.id);
    if (settle) {
      pending.delete(msg.result.id);
      settle(msg.result);
    }
  });
  // A crash, typically running out of memory, ends the process and not just the page.
  child.on('exit', () => {
    for (const settle of pending.values()) settle({ error: 'תהליך זיהוי הטקסט נעצר באמצע.' });
    pending.clear();
    child = null;
  });
  return child;
}

/**
 * Recognise one page image.
 * @param {{file: string, langs: string, dpi: number}} page
 * @param {AbortSignal} [signal]  aborting ends the process: Tesseract cannot be interrupted
 * @returns {Promise<{words: Array, text: string, confidence: number}>}
 */
function recognise(page, signal) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      stop();
      const err = new Error('הפעולה בוטלה.');
      err.cancelled = true;
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    pending.set(id, (result) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (result.error) reject(new Error(`זיהוי הטקסט נכשל: ${result.error}`));
      else resolve(result);
    });
    spawn().postMessage({ type: 'recognise', id, ...page });
  });
}

function stop() {
  if (!child) return;
  const c = child;
  child = null;
  for (const settle of pending.values()) settle({ error: 'בוטל.' });
  pending.clear();
  c.kill();
}

function shutdown() {
  if (!child) return;
  try {
    child.postMessage({ type: 'shutdown' });
  } catch {
    child.kill();
  }
  child = null;
}

module.exports = { recognise, stop, shutdown };
