'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const bin = require('../engine/binaries');
const { stage, scratchPath } = require('../engine/stage');

/**
 * Repair a damaged PDF.
 *
 * Three methods, strongest first, each tried only if the one before could not:
 *  1. qpdf rebuilds the file's structure and keeps everything in it: the usual damage,
 *     a broken cross-reference table from an interrupted download or a bad scanner
 *     driver, is exactly what it reconstructs.
 *  2. Ghostscript reads the pages and writes them again, for files whose objects are
 *     damaged rather than only their index.
 *  3. pdf-lib reads the file object by object and copies every page that survives.
 *
 * The result says what happened: whether the file was damaged at all, how many pages
 * came back, and how many were lost.
 */
async function run({ inputs, ctx }) {
  const outputs = [];
  const notes = [];
  for (let f = 0; f < inputs.length; f++) {
    const name = path.basename(inputs[f]);
    ctx.progress(f / inputs.length, `בודק את "${name}"…`);
    const bytes = await fs.readFile(inputs[f]);
    const expected = countPagesLoosely(bytes);
    const src = await stage(ctx, inputs[f], f);

    let fixed = null;
    let damaged = looksDamaged(bytes);

    if (bin.locate('qpdf')) {
      const out = scratchPath(ctx, `q-${f}.pdf`);
      const r = await bin.run('qpdf', ['--object-streams=generate', '--', src, out], { signal: ctx.signal });
      ctx.throwIfCancelled();
      if (/password/i.test(r.stderr) && r.code === 2) {
        throw new Error(`הקובץ "${name}" מוגן בסיסמה. הסר אותה בכלי "הסרת סיסמה" לפני התיקון.`);
      }
      if (r.code === 3) damaged = true;
      if ((r.code === 0 || r.code === 3) && (await pageCount(out)) > 0) fixed = { file: out, how: 'qpdf' };
    }

    if (!fixed && bin.locate('gs')) {
      ctx.progress((f + 0.4) / inputs.length, `"${name}": מנסה שיטה שנייה…`);
      const out = scratchPath(ctx, `g-${f}.pdf`);
      const r = await bin.run('gs', ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dAutoRotatePages=/None', `-sOutputFile=${out}`, src], { signal: ctx.signal });
      ctx.throwIfCancelled();
      // Ghostscript turns even pure junk into a blank page and reports success, so its
      // result counts only if some page actually has something on it.
      if (r.code === 0 && (await pageCount(out)) > 0 && (await hasContent(out))) {
        fixed = { file: out, how: 'gs' };
        damaged = true;
      }
    }

    if (!fixed) {
      ctx.progress((f + 0.7) / inputs.length, `"${name}": מנסה שיטה שלישית…`);
      fixed = await byPages(bytes, name, scratchPath(ctx, `l-${f}.pdf`));
      damaged = damaged || fixed.lost > 0;
    }

    const kept = await pageCount(fixed.file);
    const lost = Math.max(0, (expected || kept) - kept);
    outputs.push(await ctx.writeOutput(await fs.readFile(fixed.file), { source: inputs[f], label: 'מתוקן', ext: 'pdf' }));
    notes.push(
      `${inputs.length > 1 ? `"${name}": ` : ''}${damaged ? 'הקובץ היה פגום ונבנה מחדש' : 'לא נמצא פגם במבנה, הקובץ נכתב מחדש'}` +
      `, ${kept === 1 ? 'עמוד אחד שוחזר' : `${kept} עמודים שוחזרו`}${lost ? `, ${lost === 1 ? 'עמוד אחד אבד' : `${lost} עמודים אבדו`}` : ''}.`
    );
  }
  return { summary: notes.join(' '), display: outputs };
}

async function byPages(bytes, name, out) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  } catch {
    throw new Error(`לא ניתן היה לשחזר את "${name}": לא נמצא בו מבנה PDF שאפשר לקרוא.`);
  }
  if (doc.isEncrypted) throw new Error(`הקובץ "${name}" מוגן בסיסמה. הסר אותה בכלי "הסרת סיסמה" לפני התיקון.`);
  let count = 0;
  try {
    count = doc.getPageCount();
  } catch {
    throw new Error(`לא ניתן היה לשחזר את "${name}": לא נמצאו בו עמודים שאפשר לקרוא.`);
  }
  const fresh = await PDFDocument.create();
  let kept = 0;
  for (let i = 0; i < count; i++) {
    try {
      const [page] = await fresh.copyPages(doc, [i]);
      fresh.addPage(page);
      kept++;
    } catch {
      // a page whose objects are gone; the rest can still be saved
    }
  }
  if (!kept) throw new Error(`לא נמצא אף עמוד שאפשר לשחזר ב-"${name}".`);
  await fs.writeFile(out, await fresh.save({ useObjectStreams: true }));
  return { file: out, how: 'pdf-lib', lost: count - kept };
}

async function pageCount(file) {
  try {
    const doc = await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

/** True if any page draws something: text, an image, a line. */
async function hasContent(file) {
  try {
    const doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
    const zlib = require('zlib');
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      if (!contents) continue;
      const refs = typeof contents.size === 'function' ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
      for (const ref of refs) {
        const stream = doc.context.lookup(ref);
        if (!stream || !stream.contents) continue;
        let ops;
        try {
          ops = zlib.inflateSync(Buffer.from(stream.contents)).toString('latin1');
        } catch {
          ops = Buffer.from(stream.contents).toString('latin1');
        }
        if (/\b(Tj|TJ|Do|re|l|c|sh)\b/.test(ops)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Pages the file claims, read loosely, so a repair that drops pages can say so. */
function countPagesLoosely(bytes) {
  const text = bytes.toString('latin1');
  const m = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

/** Damaged in the way most files are: a cross-reference table that is missing or wrong. */
function looksDamaged(bytes) {
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  const m = /startxref\s+(\d+)/.exec(tail);
  if (!m || !/%%EOF/.test(tail)) return true;
  const at = Number(m[1]);
  if (at <= 0 || at >= bytes.length) return true;
  const head = bytes.subarray(at, at + 20).toString('latin1');
  return !/^(xref|\d+\s+\d+\s+obj)/.test(head);
}

module.exports = { run, looksDamaged };
