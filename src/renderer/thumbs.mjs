// Page thumbnails and previews through pdf.js, in the renderer, with the work in its
// worker so the window never freezes while a 400-page scan is being drawn.
//
// Documents are read by token from app://office/doc/<token>: the renderer never sees a
// path and can only read files the main process has been handed.

import * as pdfjs from '/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const open = new Map(); // token -> Promise<PDFDocumentProxy>

function load(token) {
  if (!open.has(token)) {
    const task = pdfjs.getDocument({
      url: `/doc/${encodeURIComponent(token)}`,
      cMapUrl: '/pdfjs-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs-fonts/',
      // No network, no eval: the document is ours and the fonts are bundled.
      isEvalSupported: false,
      // The handler serves whole files; asking for ranges would only add round trips.
      disableRange: true,
      disableStream: true,
    });
    const promise = task.promise.catch((err) => {
      open.delete(token);
      throw err;
    });
    open.set(token, promise);
  }
  return open.get(token);
}

async function pageCount(token) {
  return (await load(token)).numPages;
}

/**
 * Draw one page into a canvas `width` CSS pixels wide (device pixels follow the
 * display's ratio so thumbnails are crisp on a high-density screen).
 * @returns {Promise<HTMLCanvasElement>}
 */
async function render(token, pageIndex, width, { signal } = {}) {
  const doc = await load(token);
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (width / base.width) * ratio;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.round(viewport.width / ratio)}px`;
  canvas.style.height = `${Math.round(viewport.height / ratio)}px`;

  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  if (signal) signal.addEventListener('abort', () => task.cancel(), { once: true });
  try {
    await task.promise;
  } finally {
    page.cleanup();
  }
  return canvas;
}

/** Page sizes in points, for layouts that need them before any page is drawn. */
async function pageSizes(token) {
  const doc = await load(token);
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    sizes.push({ width, height, rotation: page.rotate });
  }
  return sizes;
}

/** Text with positions, for find, redact and extraction previews. */
async function pageText(token, pageIndex) {
  const doc = await load(token);
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  return { items: content.items, width: viewport.width, height: viewport.height };
}

async function close(token) {
  const promise = open.get(token);
  open.delete(token);
  if (!promise) return;
  try {
    (await promise).destroy();
  } catch {
    // already gone
  }
}

window.thumbs = { render, pageCount, pageSizes, pageText, close, version: pdfjs.version };
document.dispatchEvent(new Event('thumbs-ready'));
