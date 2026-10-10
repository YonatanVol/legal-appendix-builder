'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

/**
 * Repair a damaged PDF by reading every object it still holds and writing a new,
 * well-formed file from them.
 *
 * pdf-lib reads a file object by object rather than trusting its cross-reference
 * table, which is the part most often broken by an interrupted download or a bad
 * scanner driver. Pages that survive are copied into a fresh document.
 *
 * The result says what happened: how many pages came back, and whether the file was
 * actually damaged or only rewritten.
 */
async function run({ inputs, ctx }) {
  const outputs = [];
  const notes = [];
  for (let f = 0; f < inputs.length; f++) {
    const name = path.basename(inputs[f]);
    ctx.progress(f / inputs.length, `קורא את "${name}"…`);
    const bytes = await fs.readFile(inputs[f]);
    const damaged = await looksDamaged(bytes);

    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
    } catch (err) {
      throw new Error(`לא ניתן היה לשחזר את "${name}": לא נמצא בו מבנה PDF שאפשר לקרוא.`);
    }
    if (doc.isEncrypted) throw new Error(`הקובץ "${name}" מוגן בסיסמה. הסר אותה בכלי "הסרת סיסמה" לפני התיקון.`);

    const fresh = await PDFDocument.create();
    let kept = 0;
    let count = 0;
    try {
      count = doc.getPageCount();
    } catch {
      throw new Error(`לא ניתן היה לשחזר את "${name}": לא נמצאו בו עמודים שאפשר לקרוא.`);
    }
    for (let i = 0; i < count; i++) {
      try {
        const [page] = await fresh.copyPages(doc, [i]);
        fresh.addPage(page);
        kept++;
      } catch {
        // A page whose objects are gone cannot be copied; the rest still can.
      }
    }
    if (!kept) throw new Error(`לא נמצא אף עמוד שאפשר לשחזר ב-"${name}".`);

    outputs.push(await ctx.writeOutput(await fresh.save({ useObjectStreams: true }), { source: inputs[f], label: 'מתוקן', ext: 'pdf' }));
    const lost = count - kept;
    notes.push(
      `${inputs.length > 1 ? `"${name}": ` : ''}${damaged ? 'הקובץ היה פגום ונבנה מחדש' : 'לא נמצא פגם במבנה, הקובץ נכתב מחדש'}` +
      `, ${kept === 1 ? 'עמוד אחד שוחזר' : `${kept} עמודים שוחזרו`}${lost ? `, ${lost === 1 ? 'עמוד אחד אבד' : `${lost} עמודים אבדו`}` : ''}.`
    );
  }
  return { summary: notes.join(' '), display: outputs };
}

/** Damaged in the way most files are: a cross-reference table that is missing or wrong. */
async function looksDamaged(bytes) {
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  const m = /startxref\s+(\d+)/.exec(tail);
  if (!m || !/%%EOF/.test(tail)) return true;
  const at = Number(m[1]);
  if (at <= 0 || at >= bytes.length) return true;
  const head = bytes.subarray(at, at + 20).toString('latin1');
  return !/^(xref|\d+\s+\d+\s+obj)/.test(head);
}

module.exports = { run, looksDamaged };
