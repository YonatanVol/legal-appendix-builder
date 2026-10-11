'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const bin = require('../engine/binaries');
const imaging = require('../engine/imaging');
const pagepicture = require('../engine/pagepicture');
const { ocrFile } = require('./ocr');
const { loadPdf } = require('../pdf/inspect');
const docs = require('../docs');

const DPI = 200;

/**
 * Redact: remove what is marked, for real.
 *
 * A black rectangle drawn over text hides it from the eye and nothing else: the text
 * is still in the file, and copying the page brings it back. So every page is redrawn
 * as a picture of exactly what the screen showed (pdf.js draws it, as it drew the page
 * the user marked), the marked areas painted black, and the pictures make a new PDF.
 * Nothing of the original file comes across: no text, no layers, no hidden objects, no
 * comments' words, no attachments, no metadata. A file can hide content in many ways
 * that one reader shows and another does not; a picture of the screen holds only what
 * was seen. Optionally the pages are read again (OCR), so the copy is searchable; the
 * black areas have nothing to find.
 *
 * options.marks     [{ page, x, y, w, h }]: 0-based page, the rest fractions of the page
 *                   as shown, measured from its top-left corner
 * options.clean     leave out the document's title, author and subject (default true)
 * options.ocr       read the pages again so the copy can be searched (default true)
 * options.forToken  the screen's token for the file, to confirm the marks are for this
 *                   version of it
 */
async function run({ inputs, options = {}, ctx }) {
  const source = inputs[0];
  const marks = Array.isArray(options.marks) ? options.marks.filter(valid) : [];
  if (!marks.length) throw new Error('לא סומן מה להשחיר. סמן אזורים על העמוד, או חפש טקסט וסמן את התוצאות.');

  // Refuses a locked file with its own message, and gives the details to keep if asked.
  const original = await loadPdf(source);

  // From here on the file is read from a copy, so it cannot change midway; and the copy
  // is checked to be the version the screen showed.
  ctx.progress(0.02, 'קורא את הקובץ…');
  const given = path.join(ctx.scratch, 'given.pdf');
  await fs.copyFile(source, given);
  if (options.forToken && docs.register(source) !== options.forToken) {
    throw new Error('הקובץ השתנה מאז שסומן, ולכן לא נוצר עותק. פתח אותו שוב וסמן מחדש.');
  }

  const out = await PDFDocument.create({ updateMetadata: false });
  const view = pagepicture.open(given, { signal: ctx.signal });
  let total = 0;
  const byPage = new Map();
  const ocr = options.ocr !== false && !!bin.locate('gs');
  try {
    try {
      total = (await view.pageList()).length;
    } catch (err) {
      failed(ctx, err);
    }
    for (const m of marks) {
      if (m.page >= total) throw new Error('הסימונים אינם תואמים את הקובץ. ייתכן שהוא השתנה מאז שנפתח.');
      if (!byPage.has(m.page)) byPage.set(m.page, []);
      byPage.get(m.page).push(m);
    }
    for (let i = 0; i < total; i++) {
      ctx.progress(0.05 + (i / total) * (ocr ? 0.4 : 0.85), byPage.has(i) ? `משחיר את עמוד ${i + 1} מתוך ${total}` : `מצייר את עמוד ${i + 1} מתוך ${total}`);
      let picture;
      try {
        picture = await view.draw(i, DPI);
      } catch (err) {
        failed(ctx, err);
      }
      // Beyond each mark by a little, so anti-aliased edges of letters do not peek out.
      const boxes = (byPage.get(i) || []).map((m) => ({ x: m.x - 0.002, y: m.y - 0.002, w: m.w + 0.004, h: m.h + 0.004 }));
      const jpg = (await imaging.blackOut(picture.png, 'image/png', boxes)).bytes;
      // The size pdf.js showed the page at.
      const image = await out.embedJpg(jpg);
      out.addPage([picture.width, picture.height]).drawImage(image, { x: 0, y: 0, width: picture.width, height: picture.height });
      ctx.throwIfCancelled();
    }
  } finally {
    await view.release();
  }

  if (options.clean === false) {
    // Asked to keep the document's details: only the standard, visible ones.
    for (const [get, set] of [['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject']]) {
      const value = original[get]();
      if (value) out[set](value);
    }
  }
  ctx.progress(ocr ? 0.45 : 0.9, 'שומר…');
  let bytes = await out.save({ useObjectStreams: true });

  let searchable = '';
  if (ocr) {
    const temp = path.join(ctx.scratch, 'redacted.pdf');
    await fs.writeFile(temp, bytes);
    const read = await ocrFile(temp, { langs: 'heb+eng' }, ctx, (fraction, label) => ctx.progress(0.45 + fraction * 0.53, label));
    if (read.bytes) bytes = read.bytes;
    searchable = ' הטקסט זוהה מחדש בכל העמודים, ואפשר לחפש בו בכל מה שלא הושחר.';
  }
  const outputPath = await ctx.writeOutput(bytes, { source, label: 'מושחר', ext: 'pdf' });
  const marked = byPage.size;
  const what = marked === 1 ? 'עמוד אחד הושחר' : `${marked} עמודים הושחרו`;
  const how = searchable || ' לא זוהה טקסט, ולכן אי אפשר לחפש בעותק.';
  return {
    summary: `${what}. ${marks.length === 1 ? 'האזור המסומן נמחק מהקובץ עצמו, לא רק הוסתר.' : `${marks.length} האזורים המסומנים נמחקו מהקובץ עצמו, לא רק הוסתרו.`} כל עמוד בעותק הוא תמונה של מה שהוצג במסך, ושום דבר אחר מהקובץ המקורי לא עבר אליו.${how}`,
    display: [outputPath],
  };
}

/** A page pdf.js could not draw: Esc is passed on, anything else said in Hebrew. */
function failed(ctx, err) {
  ctx.throwIfCancelled();
  console.error('[redact] drawing a page failed:', err);
  if (err && err.timedOut) {
    throw new Error('ציור אחד העמודים לא הסתיים גם אחרי שתי דקות, ולכן לא נוצר עותק. העמוד כבד מאוד לציור; אפשר לנסות לכווץ את הקובץ קודם.');
  }
  throw new Error('לא ניתן היה לצייר את אחד העמודים, ולכן לא נוצר עותק. אפשר לנסות קודם את "תיקון PDF".');
}

function valid(m) {
  return m && Number.isInteger(m.page) && m.page >= 0 &&
    [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.w > 0 && m.h > 0 &&
    m.x >= -0.01 && m.y >= -0.01 && m.x + m.w <= 1.01 && m.y + m.h <= 1.01;
}

module.exports = { run, availability: () => bin.availability('gs') };
