// Pictures of pages for Redact, drawn by pdf.js exactly as the screen drew them when the
// user marked them: same library, same settings as thumbs.mjs (display intent, with
// annotations), so the redacted page shows what the user saw, no more and no less.
// This page runs in a hidden window and is driven by src/main/engine/pagepicture.js.

import * as pdfjs from '/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const open = new Map(); // token -> Promise<PDFDocumentProxy>

function load(token) {
  if (!open.has(token)) {
    open.set(token, pdfjs.getDocument({
      url: `/doc/${encodeURIComponent(token)}`,
      cMapUrl: '/pdfjs-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs-fonts/',
      isEvalSupported: false,
      disableRange: true,
      disableStream: true,
    }).promise);
  }
  return open.get(token);
}

// The longest side a picture may have, so a poster-sized page stays within what a canvas
// can hold; such a page is drawn at a lower resolution.
const MAX_SIDE = 12000;

/**
 * The pages as pdf.js counts them, each by its object number and generation, so the
 * caller can confirm they are the pages it means to replace.
 */
window.pageList = async (token) => {
  const doc = await load(token);
  const refs = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { num, gen } = (await doc.getPage(i)).ref || {};
    refs.push([num, gen]);
  }
  return refs;
};

/** One page as a PNG, base64, at `dpi`, with its size in points as shown. */
window.drawPage = async (token, pageIndex, dpi) => {
  const doc = await load(token);
  const page = await doc.getPage(pageIndex + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    const longest = Math.max(base.width, base.height) * scale;
    if (longest > MAX_SIDE) scale *= MAX_SIDE / longest;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no picture'))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    canvas.width = 0;
    canvas.height = 0;
    return { png: btoa(binary), width: base.width, height: base.height };
  } finally {
    page.cleanup();
  }
};

/**
 * Whether page `index` reads to pdf.js the same in document A and in document B: the
 * same text (all of it, seen or not), the same drawing operations in the same order, and
 * the same picture at a low resolution, pixel for pixel. Returns '' when the same, else
 * what differs. Used on a file and a copy of it written afresh, which hold the same
 * content, so there is nothing to tolerate: any difference means the two are read
 * differently.
 */
window.samePage = async (tokenA, tokenB, index) => {
  const read = async (token) => {
    const doc = await load(token);
    const page = await doc.getPage(index + 1);
    try {
      const text = (await page.getTextContent()).items.map((i) => (typeof i.str === 'string' ? i.str : '')).join('\u0001');
      const ops = await page.getOperatorList();
      const drawing = Array.from(ops.fnArray).join(',');
      const viewport = page.getViewport({ scale: 36 / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const size = [canvas.width, canvas.height];
      canvas.width = 0;
      return { text, drawing, size, pixels };
    } finally {
      page.cleanup();
    }
  };
  const a = await read(tokenA);
  const b = await read(tokenB);
  if (a.text !== b.text) return 'text';
  if (a.drawing !== b.drawing) return 'drawing';
  if (a.size[0] !== b.size[0] || a.size[1] !== b.size[1]) return 'size';
  for (let i = 0; i < a.pixels.length; i++) if (Math.abs(a.pixels[i] - b.pixels[i]) > 2) return 'picture';
  return '';
};

/** Done with a document. */
window.release = async (token) => {
  const doc = open.get(token);
  open.delete(token);
  if (doc) await (await doc).destroy();
};

window.pagePictureReady = true;
