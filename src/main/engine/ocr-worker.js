'use strict';

/*
 * Tesseract, in its own process.
 *
 * A Node process rather than a page worker: the language data is read from a plain
 * folder with fs, so there is no download fallback to disable and nothing cached
 * anywhere. Its own process rather than the main one, because a page is one
 * synchronous WebAssembly call of several seconds: in the main process it would
 * freeze the window, and the only way to stop it is to end the process, which is
 * what the supervisor does when the user presses Esc.
 *
 * The same arrangement the document scanner app settled on, with English added.
 */
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'tessdata');

// WebAssembly memory only grows, so a worker is replaced after this many pages.
const RECYCLE_AFTER = 40;

let worker = null;
let workerLangs = '';
let pages = 0;

async function getWorker(langs) {
  if (worker && workerLangs === langs && pages < RECYCLE_AFTER) return worker;
  if (worker) await worker.terminate().catch(() => {});
  worker = await createWorker(langs, 1, {
    langPath: LANG_PATH,
    gzip: true,
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: () => {},
  });
  workerLangs = langs;
  pages = 0;
  return worker;
}

async function recognise({ id, file, langs, dpi }) {
  const w = await getWorker(langs || 'heb');
  await w.setParameters({ user_defined_dpi: String(Math.max(70, Math.round(dpi || 300))) });
  const { data } = await w.recognize(file, {}, { blocks: true, text: true });
  pages++;
  const words = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const wd of l.words || []) {
          if (!wd.text || !wd.text.trim()) continue;
          words.push({ text: wd.text, bbox: wd.bbox, confidence: wd.confidence, line: l.bbox });
        }
      }
    }
  }
  return { id, words, text: data.text || '', confidence: data.confidence || 0 };
}

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'recognise') {
      process.parentPort.postMessage({ type: 'done', result: await recognise(msg) });
    } else if (msg.type === 'shutdown') {
      if (worker) await worker.terminate().catch(() => {});
      process.exit(0);
    }
  } catch (err) {
    process.parentPort.postMessage({ type: 'done', result: { id: msg.id, error: String(err && err.message ? err.message : err) } });
  }
});
