'use strict';

const text = require('../pdf/text');

/*
 * A result from qpdf or Ghostscript is accepted only if an independent, strict reader
 * opens it and finds the pages it should have.
 *
 * Both programs can finish "successfully" with something wrong: qpdf may write a
 * truncated download back out without its catalogue, which nothing can open, and
 * Ghostscript reads what it can of a damaged file and writes only that. Either would
 * otherwise be handed over as a repaired, compressed or archival copy.
 */

/** Pages pdf.js finds in the file, or 0 if it cannot open it. */
async function strictPages(file) {
  try {
    const doc = await text.open(file);
    const n = doc.numPages;
    await doc.destroy();
    return n;
  } catch {
    return 0;
  }
}

/** Throws a sentence a person can act on unless `file` opens with exactly `expected` pages. */
async function samePages(file, expected, name) {
  const got = await strictPages(file);
  if (got === expected) return;
  if (!got) throw new Error(`העיבוד של "${name}" לא הצליח: הקובץ שנוצר לא נפתח. אפשר לנסות קודם את "תיקון PDF".`);
  throw new Error(`רק ${got} מתוך ${expected} העמודים של "${name}" עובדו, ולכן לא נוצר עותק. ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);
}

module.exports = { strictPages, samePages };
