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

/** One page as a PNG, base64, at `dpi`. */
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
    return btoa(binary);
  } finally {
    page.cleanup();
  }
};

/** Done with a document. */
window.release = async (token) => {
  const doc = open.get(token);
  open.delete(token);
  if (doc) await (await doc).destroy();
};

window.pagePictureReady = true;
