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
 * How different one page of document B looks from one page of document A, as pdf.js
 * draws both: the largest mean difference, from 0 to 255, over any square of 8 by 8
 * pixels at `dpi`. `boxes` (fractions of the shown page, the marked areas, blacked out
 * by construction) and `masks` (rectangles in A's page space) are painted the same grey
 * on both, with a pixel to spare, so they are not compared.
 */
window.comparePages = async (tokenA, indexA, tokenB, indexB, { dpi = 50, boxes = [], masks = [], pictured = false } = {}) => {
  // `over`: drawn that many times larger, then shrunk, as pdf.js shrinks a picture. Used
  // for A when B's page is a picture of A's (a marked page), so both are shrunk alike.
  const draw = async (token, index, size, over = 1) => {
    const doc = await load(token);
    const page = await doc.getPage(index + 1);
    try {
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = size ? size[0] : Math.ceil(viewport.width);
      canvas.height = size ? size[1] : Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Drawn to fill the canvas, so a page a fraction of a point larger still lines up.
      const fitted = page.getViewport({ scale: (dpi / 72) * (canvas.width / Math.ceil(viewport.width)) });
      if (over > 1) {
        const big = document.createElement('canvas');
        big.width = canvas.width * over;
        big.height = canvas.height * over;
        const bctx = big.getContext('2d');
        bctx.fillStyle = '#ffffff';
        bctx.fillRect(0, 0, big.width, big.height);
        await page.render({ canvasContext: bctx, viewport: page.getViewport({ scale: fitted.scale * over }) }).promise;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(big, 0, 0, canvas.width, canvas.height);
        big.width = 0;
      } else {
        await page.render({ canvasContext: ctx, viewport: fitted }).promise;
      }
      return { canvas, ctx, viewport: fitted };
    } finally {
      page.cleanup();
    }
  };
  const a = await draw(tokenA, indexA, null, pictured ? 4 : 1);
  const b = await draw(tokenB, indexB, [a.canvas.width, a.canvas.height]);
  const { width, height } = a.canvas;
  const grey = (x, y, w, h) => {
    for (const c of [a.ctx, b.ctx]) {
      c.fillStyle = '#808080';
      c.fillRect(Math.floor(x) - 2, Math.floor(y) - 2, Math.ceil(w) + 4, Math.ceil(h) + 4);
    }
  };
  for (const m of boxes) grey(m.x * width, m.y * height, m.w * width, m.h * height);
  for (const r of masks) {
    const [x1, y1, x2, y2] = a.viewport.convertToViewportRectangle(r);
    grey(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  // Both softened a little first, so a picture shrunk more softly than text is drawn
  // does not count as a difference; a word or a line that is not the same still does.
  const soft = (src) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.filter = 'blur(1px)';
    x.drawImage(src, 0, 0);
    const data = x.getImageData(0, 0, width, height).data;
    c.width = 0;
    return data;
  };
  const pa = soft(a.canvas);
  const pb = soft(b.canvas);
  const gray = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const B = 8;
  let worst = 0;
  for (let by = 0; by < height; by += B) {
    for (let bx = 0; bx < width; bx += B) {
      let sum = 0;
      let n = 0;
      for (let y = by; y < Math.min(by + B, height); y++) {
        for (let x = bx; x < Math.min(bx + B, width); x++) {
          const i = (y * width + x) * 4;
          sum += Math.abs(gray(pa, i) - gray(pb, i));
          n++;
        }
      }
      worst = Math.max(worst, sum / n);
    }
  }
  a.canvas.width = 0;
  b.canvas.width = 0;
  return Math.round(worst * 10) / 10;
};

/** Done with a document. */
window.release = async (token) => {
  const doc = open.get(token);
  open.delete(token);
  if (doc) await (await doc).destroy();
};

window.pagePictureReady = true;
