'use strict';

const { PDFDocument } = require('pdf-lib');

/*
 * A PDF sent to Claude travels inside the request as base64, a third larger than the file,
 * and a request may be at most 32 MB. So whether a document, or a part of it, can be sent
 * is decided by its size once encoded, with room left for the instructions around it.
 */

const MAX_ENCODED = 30 * 1000 * 1000;

/** The size of `bytes` once written as base64. */
function encodedSize(bytes) {
  return 4 * Math.ceil(bytes / 3);
}

function fits(bytes) {
  return encodedSize(bytes.length) <= MAX_ENCODED;
}

/** The pages from..to (0-based, end exclusive) of a document, as a PDF of their own. */
async function partBytes(doc, from, to) {
  // No time stamp of its own, so the part made to be sent is the very one that was measured.
  const part = await PDFDocument.create({ updateMetadata: false });
  const pages = await part.copyPages(doc, Array.from({ length: to - from }, (_, k) => from + k));
  pages.forEach((p) => part.addPage(p));
  return part.save({ useObjectStreams: true });
}

/**
 * Which pages go together, in parts of at most `maxPages` pages, each small enough to send:
 * a part too large is halved until it fits. Only the page ranges are kept, not the bytes.
 * A single page too large to send on its own cannot be helped by splitting, and is said so
 * here, before anything is sent (and paid for).
 */
async function plan(doc, maxPages, name) {
  const ranges = [];
  const add = async (from, to) => {
    const bytes = await partBytes(doc, from, to);
    if (fits(bytes)) return ranges.push({ from, to });
    if (to - from === 1) {
      const mb = Math.ceil(bytes.length / (1024 * 1024));
      throw new Error(`עמוד ${from + 1} של "${name}" גדול מדי לשליחה ל-Claude (כ-${mb} MB). אפשר לכווץ את הקובץ בכלי "כיווץ PDF" ולנסות שוב.`);
    }
    const middle = from + Math.ceil((to - from) / 2);
    await add(from, middle);
    return add(middle, to);
  };
  const pages = doc.getPageCount();
  for (let from = 0; from < pages; from += maxPages) await add(from, Math.min(pages, from + maxPages));
  return ranges;
}

/**
 * The document's parts, planned first (so a page that cannot be sent stops everything
 * before the first request), then made one at a time as each is sent, so only the part
 * being sent is held in memory. Yields { from, to, bytes } in page order.
 */
async function* sendableParts(doc, maxPages, name) {
  for (const { from, to } of await plan(doc, maxPages, name)) yield { from, to, bytes: await partBytes(doc, from, to) };
}

module.exports = { sendableParts, fits, encodedSize, MAX_ENCODED };
