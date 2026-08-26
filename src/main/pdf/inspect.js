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
async function loadPdf(filePath) {
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
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
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

module.exports = { loadPdf, inspect, A4 };
