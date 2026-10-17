// Pictures of pages for Redact, drawn by pdf.js as the screen drew them when the user
// marked them: the same library, the same way of opening the document (pdf-document.mjs),
// display intent, with annotations, as thumbs.mjs. This page runs in a hidden window and
// is driven by src/main/engine/pagepicture.js.

import * as pdfjs from '/pdfjs/pdf.mjs';
import { documentParams } from './pdf-document.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const open = new Map(); // token -> Promise<PDFDocumentProxy>

function load(token) {
  if (!open.has(token)) {
    open.set(token, pdfjs.getDocument(documentParams(token)).promise);
  }
  return open.get(token);
}

// The longest side a picture may have, so a poster-sized page stays within what a canvas
// can hold; such a page is drawn at a lower resolution.
const MAX_SIDE = 12000;

/**
 * The pages as pdf.js counts them, each by its object number and generation. A document
 * locked with a password fails here with pdf.js's PasswordException.
 */
window.pageList = async (token) => {
  let doc;
  try {
    doc = await load(token);
  } catch (err) {
    open.delete(token);
    // Said plainly, as its name does not survive the trip back to the main process.
    if (err && err.name === 'PasswordException') throw new Error('PDF_LOCKED');
    throw err;
  }
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

/** Done with a document. */
window.release = async (token) => {
  const doc = open.get(token);
  open.delete(token);
  if (doc) await (await doc).destroy();
};

window.pagePictureReady = true;
