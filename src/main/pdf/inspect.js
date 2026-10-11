'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const A4 = { width: 595.28, height: 841.89 };

/**
 * Load a PDF from disk, failing with a Hebrew message the user can act on.
 * Scanned files are frequently encrypted with an empty password; pdf-lib cannot
 * decrypt content streams, so copying such pages would silently produce garbage.
 * We refuse instead, and say what to do about it.
 */
async function loadPdf(filePath, { updateMetadata = true } = {}) {
  const name = path.basename(filePath);
  let bytes;

  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new Error(`לא ניתן לקרוא את הקובץ "${name}": ${err.message}`);
  }

  if (bytes.length === 0) {
    throw new Error(`הקובץ "${name}" ריק.`);
  }
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`הקובץ "${name}" אינו קובץ PDF תקין.`);
  }

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata });
  } catch (err) {
    throw new Error(`הקובץ "${name}" פגום או לא נתמך: ${err.message}`);
  }

  if (doc.isEncrypted) {
    throw new Error(
      `הקובץ "${name}" מוגן בהצפנה ולכן לא ניתן לשלב אותו. ` +
        `פתח אותו בקורא PDF, בחר "הדפס" ואז "שמור כ-PDF", והעלה את הקובץ החדש.`
    );
  }

  if (doc.getPageCount() === 0) {
    throw new Error(`הקובץ "${name}" אינו מכיל עמודים.`);
  }

  return doc;
}

/** Page count plus the first page's size — used to match generated pages to the body. */
async function inspect(filePath) {
  const doc = await loadPdf(filePath);
  const first = doc.getPage(0);
  const { width, height } = first.getSize();
  const angle = first.getRotation().angle % 360;
  const rotated = angle === 90 || angle === 270;

  return {
    path: filePath,
    name: path.basename(filePath),
    pageCount: doc.getPageCount(),
    // Report the visual size, so a rotated body still yields an upright divider.
    pageSize: rotated ? { width: height, height: width } : { width, height },
  };
}

/**
 * What the tool screens show for a file the user dropped. Never throws: a file that
 * cannot be used comes back with `error` (and `encrypted` when that is the reason),
 * so the list can show the row with the problem next to it instead of refusing the
 * whole drop.
 */
/**
 * How many pages pdf.js, which draws every page on screen, counts. The tools count with
 * pdf-lib; in an unusual file (a page that does not say it is one) the two differ, and a
 * tool could then put out a page the screen never showed. The screen holds such a file
 * back until Repair has marked its pages. Where pdf.js cannot open the file, its own
 * pictures say so; the count then stands as pdf-lib's.
 */
async function shownPageCount(filePath, fallback) {
  let reader;
  try {
    reader = await require('./text').open(filePath);
    return reader.numPages;
  } catch {
    return fallback;
  } finally {
    if (reader) await reader.destroy().catch(() => {});
  }
}

async function describe(filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (err) {
    return { path: filePath, name, ext, size, pageCount: 0, error: `לא ניתן לקרוא את הקובץ "${name}": ${err.message}` };
  }

  if (ext !== 'pdf') return { path: filePath, name, ext, size, pageCount: 0 };

  try {
    const bytes = await fs.readFile(filePath);
    if (bytes.length === 0) return { path: filePath, name, ext, size, pageCount: 0, error: `הקובץ "${name}" ריק.` };
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { path: filePath, name, ext, size, pageCount: 0, error: `הקובץ "${name}" אינו קובץ PDF תקין.` };
    }
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const encrypted = doc.isEncrypted;
    const pageCount = doc.getPageCount();
    const first = pageCount ? doc.getPage(0) : null;
    const pageSize = first ? first.getSize() : null;
    return {
      path: filePath,
      name,
      ext,
      size,
      pageCount,
      shownPages: encrypted ? pageCount : await shownPageCount(filePath, pageCount),
      pageSize,
      encrypted,
      error: encrypted ? `הקובץ "${name}" מוגן בסיסמה. הסר את הסיסמה בכלי "הסרת סיסמה" ונסה שוב.` : undefined,
    };
  } catch (err) {
    return { path: filePath, name, ext, size, pageCount: 0, error: `הקובץ "${name}" פגום או לא נתמך. אפשר לנסות את כלי "תיקון PDF".` };
  }
}

module.exports = { loadPdf, inspect, describe, A4 };
