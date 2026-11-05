'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const A4 = { width: 595.28, height: 841.89 };

/**
 * Whether `bytes` start as a PDF. The standard lets a file carry a little before its
 * "%PDF-" line (some systems prefix a download with a header of their own), and every
 * reader accepts up to 1024 bytes of it, as Acrobat does; so does this check.
 */
function looksLikePdf(bytes) {
  const head = bytes.subarray(0, 1024 + 5).toString('latin1');
  return head.indexOf('%PDF-') !== -1;
}

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
  if (!looksLikePdf(bytes)) {
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
 * The pages as pdf.js, which draws every page on screen, reads them, against the pages
 * the tools (pdf-lib) read: { shown, agree }. In an unusual file (a page that does not say
 * it is one, a page count that is wrong, an entry that leads nowhere) the two read
 * different pages, and a tool could put out a page the screen never showed. Such a file
 * waits for Repair, which puts its page tree in order. Where pdf.js cannot open the file
 * its own pictures say so; the tools' reading then stands.
 */
async function pagesAsShown(filePath, doc) {
  let own;
  try {
    own = doc.getPages().map((p) => `${p.ref.objectNumber} ${p.ref.generationNumber}`);
  } catch {
    // pdf-lib cannot list its pages: the tool itself says what is wrong.
    return { shown: 0, agree: true };
  }
  let reader;
  try {
    reader = await require('./text').open(filePath);
  } catch {
    return { shown: own.length, agree: true };
  }
  try {
    if (reader.numPages !== own.length) return { shown: reader.numPages, agree: false };
    for (let i = 1; i <= reader.numPages; i++) {
      const { num, gen } = (await reader.getPage(i)).ref || {};
      if (`${num} ${gen}` !== own[i - 1]) return { shown: reader.numPages, agree: false };
    }
    return { shown: reader.numPages, agree: true };
  } catch {
    return { shown: reader.numPages, agree: false };
  } finally {
    await reader.destroy().catch(() => {});
  }
}

/**
 * What the tool screens show for a file the user dropped. Never throws: a file that
 * cannot be used comes back with `error` (and `encrypted` when that is the reason),
 * so the list can show the row with the problem next to it instead of refusing the
 * whole drop.
 */
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
    if (!looksLikePdf(bytes)) {
      return { path: filePath, name, ext, size, pageCount: 0, error: `הקובץ "${name}" אינו קובץ PDF תקין.` };
    }
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const encrypted = doc.isEncrypted;
    // A locked file often keeps its page index in a compressed section that is encrypted too
    // (bank and pension statements do), so its pages cannot be counted before the password
    // is given. That file is protected, not damaged: it is listed as such, pages unknown.
    let pageCount = 0;
    let pageSize = null;
    try {
      pageCount = doc.getPageCount();
      const first = pageCount ? doc.getPage(0) : null;
      pageSize = first ? first.getSize() : null;
    } catch (err) {
      if (!encrypted) throw err;
      pageCount = 0;
    }
    if (encrypted) {
      // Locked only against printing and copying: it opens without a password, as every
      // reader opens it, and the tools work on an opened copy (src/main/pdf/restrictions.js).
      // Its pages are counted as the screen shows them.
      const open = await shownWithoutPassword(filePath);
      if (open) {
        return { path: filePath, name, ext, size, pageCount: open.pages, shownPages: open.pages, pagesAgree: true, pageSize: open.size, encrypted, restricted: true };
      }
    }
    return {
      path: filePath,
      name,
      ext,
      size,
      pageCount,
      ...(encrypted ? { shownPages: pageCount, pagesAgree: true } : await pagesAsShown(filePath, doc).then(({ shown, agree }) => ({ shownPages: shown, pagesAgree: agree }))),
      pageSize,
      encrypted,
      error: encrypted ? `הקובץ "${name}" מוגן בסיסמה. הסר את הסיסמה בכלי "הסרת סיסמה" ונסה שוב.` : undefined,
    };
  } catch (err) {
    // `damaged`: Repair takes it, and its row leads there.
    return { path: filePath, name, ext, size, pageCount: 0, damaged: true, error: `הקובץ "${name}" פגום או לא נתמך. אפשר לנסות את כלי "תיקון PDF".` };
  }
}

/** The pages of an encrypted file as pdf.js shows them without a password, or null if it needs one. */
async function shownWithoutPassword(filePath) {
  let reader;
  try {
    reader = await require('./text').open(filePath);
    const view = (await reader.getPage(1)).view;
    return { pages: reader.numPages, size: { width: view[2] - view[0], height: view[3] - view[1] } };
  } catch {
    return null;
  } finally {
    if (reader) await reader.destroy().catch(() => {});
  }
}

/** Refuses, naming the file, any PDF among `files` whose pages pdf.js and pdf-lib read differently. */
async function samePagesEverywhere(files, signal) {
  for (const file of files) {
    if (signal && signal.aborted) return;
    if (!/\.pdf$/i.test(file)) continue;
    let doc;
    try {
      doc = await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true, updateMetadata: false });
    } catch {
      continue; // the tool says what is wrong with it
    }
    if (doc.isEncrypted) continue;
    if (!(await pagesAsShown(file, doc)).agree) {
      throw new Error(`בקובץ "${path.basename(file)}" יש עמודים שתוכנות שונות קוראות אחרת, ולכן אי אפשר לעבוד עליו בבטחה. הרץ עליו קודם את "תיקון PDF", ועבוד על הקובץ המתוקן.`);
    }
  }
}

module.exports = { looksLikePdf, loadPdf, inspect, describe, pagesAsShown, samePagesEverywhere, A4 };
