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
  const listener = child;
  listener.on('message', (msg) => {
    if (child !== listener) return;
    if (msg.type !== 'done') return;
    const settle = pending.get(msg.result.id);
    if (settle) {
      pending.delete(msg.result.id);
      settle(msg.result);
    }
  });
  // A crash, typically running out of memory, ends the process and not just the page.
  // Only this process's own exit counts: one that was stopped on purpose may finish
  // exiting after a new one has started, and must not touch the new one's work.
  const own = child;
  own.on('exit', () => {
    if (child !== own) return;
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
