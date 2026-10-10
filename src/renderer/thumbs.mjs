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

/**
 * Every piece of text on a page with its box, as fractions of the page as shown
 * (top-left origin), whichever way the page is turned. Used by Redact to find and
 * mark text. The box is found from the run's four corners, so it is right on pages
 * turned by 90 or 270 degrees too.
 */
async function textBoxes(token, pageIndex) {
  const doc = await load(token);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const boxes = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const ul = Math.hypot(a, b) || 1;
    const vl = Math.hypot(c, d) || 1;
    const ux = a / ul, uy = b / ul, vx = c / vl, vy = d / vl;
    const w = item.width;
    const h = item.height || vl;
    // A little below the baseline, for descenders.
    const ox = e - vx * h * 0.25, oy = f - vy * h * 0.25;
    const corners = [[ox, oy], [ox + ux * w, oy + uy * w], [ox + vx * h * 1.2, oy + vy * h * 1.2], [ox + ux * w + vx * h * 1.2, oy + uy * w + vy * h * 1.2]]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    boxes.push({
      str: item.str,
      rtl: item.dir === 'rtl',
      vertical: right - left < bottom - top && item.str.length > 1,
      x: left / viewport.width,
      y: top / viewport.height,
      w: (right - left) / viewport.width,
      h: (bottom - top) / viewport.height,
    });
  }
  page.cleanup();
  return boxes;
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

window.thumbs = { render, pageCount, pageSizes, pageText, textBoxes, close, version: pdfjs.version };
document.dispatchEvent(new Event('thumbs-ready'));
