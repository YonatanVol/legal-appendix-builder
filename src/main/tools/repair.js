'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName, PDFDict, PDFRef } = require('pdf-lib');

const bin = require('../engine/binaries');
const { stage, scratchPath } = require('../engine/stage');
const { strictPages } = require('../engine/verify');

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
 * Last, the pages are put in one plain list (alignPages) where programs read the file's
 * page tree differently (a page that does not say it is one, a wrong count, an entry that
 * leads nowhere or back up the tree): one would show a page that another leaves out, and
 * no method above fixes that, as each keeps the tree as it was.
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
    // The pages the screen showed (pdf.js), so "pages lost" means pages the user could see;
    // where pdf.js cannot open the file, the pages the file claims.
    const expected = (await shownCount(inputs[f])) || countPagesLoosely(bytes);
    const src = await stage(ctx, inputs[f], f);

    let fixed = null;
    let damaged = looksDamaged(bytes);

    if (bin.locate('qpdf')) {
      const out = `q-${f}.pdf`;
      const r = await bin.run('qpdf', ['--object-streams=generate', '--', src, out], { cwd: ctx.scratch, signal: ctx.signal });
      ctx.throwIfCancelled();
      if (/password/i.test(r.stderr) && r.code === 2) {
        throw new Error(`הקובץ "${name}" מוגן בסיסמה. הסר אותה בכלי "הסרת סיסמה" לפני התיקון.`);
      }
      if (r.code === 3) damaged = true;
      // qpdf can write a cut-off file back out without its catalogue, which nothing opens;
      // its result counts only if a strict reader finds pages in it.
      if ((r.code === 0 || r.code === 3) && (await strictPages(scratchPath(ctx, out))) > 0) fixed = { file: scratchPath(ctx, out), how: 'qpdf' };
    }

    if (!fixed && bin.locate('gs')) {
      ctx.progress((f + 0.4) / inputs.length, `"${name}": מנסה שיטה שנייה…`);
      const out = `g-${f}.pdf`;
      const r = await bin.run('gs', ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dAutoRotatePages=/None', `-sOutputFile=${out}`, src], { cwd: ctx.scratch, signal: ctx.signal });
      ctx.throwIfCancelled();
      // Ghostscript turns even pure junk into a blank page and reports success, so its
      // result counts only if some page actually has something on it.
      if (r.code === 0 && (await strictPages(scratchPath(ctx, out))) > 0 && (await hasContent(scratchPath(ctx, out)))) {
        fixed = { file: scratchPath(ctx, out), how: 'gs' };
        damaged = true;
      }
    }

    if (!fixed) {
      ctx.progress((f + 0.7) / inputs.length, `"${name}": מנסה שיטה שלישית…`);
      fixed = await byPages(bytes, name, scratchPath(ctx, `l-${f}.pdf`));
      if (!(await strictPages(fixed.file))) throw new Error(`לא ניתן היה לשחזר את "${name}": גם הקובץ שנבנה מחדש לא נפתח.`);
      damaged = damaged || fixed.lost > 0;
    }

    const aligned = await alignPages(fixed.file);
    if (aligned.changed) damaged = true;
    const kept = await strictPages(fixed.file);
    const lost = Math.max(0, (expected || kept) - kept - aligned.added);
    outputs.push(await ctx.writeOutput(await fs.readFile(fixed.file), { source: inputs[f], label: 'מתוקן', ext: 'pdf' }));
    notes.push(
      `${inputs.length > 1 ? `"${name}": ` : ''}${damaged ? 'הקובץ היה פגום ונבנה מחדש' : 'לא נמצא פגם במבנה, הקובץ נכתב מחדש'}` +
      `, ${kept === 1 ? 'עמוד אחד שוחזר' : `${kept} עמודים שוחזרו`}${lost ? `, ${lost === 1 ? 'עמוד אחד אבד' : `${lost} עמודים אבדו`}` : ''}.` +
      (aligned.added ? ` ${aligned.added === 1 ? 'עמוד אחד שלא הוצג במסך נמצא בקובץ ונוסף בסופו' : `${aligned.added} עמודים שלא הוצגו במסך נמצאו בקובץ ונוספו בסופו`}.` : '')
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

/**
 * Where pdf.js (which draws the pages on screen) and pdf-lib (which the tools use) read
 * the file's pages differently, the page tree is replaced by one plain list: the pages
 * pdf.js shows, in its order, then any page only pdf-lib finds (one a wrong count hid, say),
 * at the end. Each page gets what it inherited from the old tree (resources, page boxes,
 * turn), so it looks as it did. Built from what the screen showed rather than by mending
 * the old tree's rules, both programs then read the same pages, whatever its shape was.
 * Returns { changed, added }: whether the file was rewritten, and how many pages only
 * pdf-lib had found were added at the end.
 */
async function alignPages(file) {
  const none = { changed: false, added: 0 };
  let shown;
  let reader;
  try {
    reader = await require('../pdf/text').open(file);
    shown = [];
    for (let i = 1; i <= reader.numPages; i++) {
      try {
        const { num, gen } = (await reader.getPage(i)).ref || {};
        if (Number.isInteger(num)) shown.push(`${num} ${gen || 0}`);
      } catch {
        // a page pdf.js cannot read (it shows an error in its place): nothing to keep
      }
    }
  } catch {
    return none;
  } finally {
    if (reader) await reader.destroy().catch(() => {});
  }
  let doc;
  try {
    doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  } catch {
    return none;
  }
  let own = null;
  try {
    own = doc.getPages().map((p) => `${p.ref.objectNumber} ${p.ref.generationNumber}`);
  } catch {
    // pdf-lib cannot walk the tree at all: it is rebuilt below
  }
  if (own && own.length === shown.length && own.every((r, k) => r === shown[k])) return none;

  const ctxt = doc.context;
  const seen = new Set(shown);
  const extra = (own || []).filter((r) => !seen.has(r));
  const order = [...shown, ...extra];
  const refOf = (key) => {
    const [num, gen] = key.split(' ').map(Number);
    return PDFRef.of(num, gen);
  };
  const isPage = (key) => ctxt.lookup(refOf(key)) instanceof PDFDict;
  const pages = order.filter(isPage).map(refOf);
  if (!pages.length) return none;

  const root = ctxt.obj({ Type: 'Pages', Kids: pages, Count: pages.length });
  const rootRef = ctxt.register(root);
  const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  for (const ref of pages) {
    const page = ctxt.lookup(ref);
    for (const key of INHERITED) {
      if (page.get(PDFName.of(key)) !== undefined) continue;
      // Up the old tree, as a reader would have found it.
      let node = page.lookup(PDFName.of('Parent'));
      const up = new Set();
      while (node instanceof PDFDict && !up.has(node)) {
        up.add(node);
        const value = node.get(PDFName.of(key));
        if (value !== undefined) {
          page.set(PDFName.of(key), value);
          break;
        }
        node = node.lookup(PDFName.of('Parent'));
      }
    }
    if (!page.get(PDFName.of('MediaBox'))) page.set(PDFName.of('MediaBox'), ctxt.obj([0, 0, 612, 792]));
    if (!page.get(PDFName.of('Resources'))) page.set(PDFName.of('Resources'), ctxt.obj({}));
    page.set(PDFName.of('Type'), PDFName.of('Page'));
    page.delete(PDFName.of('Kids'));
    page.delete(PDFName.of('Count'));
    page.set(PDFName.of('Parent'), rootRef);
  }
  doc.catalog.set(PDFName.of('Pages'), rootRef);
  // Read afresh, so the pages are read as pages, and written again; never with a page of
  // pdf-lib's own added to an empty-looking file.
  const again = await PDFDocument.load(await doc.save({ useObjectStreams: true, addDefaultPage: false }), { updateMetadata: false });
  await fs.writeFile(file, await again.save({ useObjectStreams: true, addDefaultPage: false }));
  return { changed: true, added: extra.filter(isPage).length };
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

async function shownCount(file) {
  let reader;
  try {
    reader = await require('../pdf/text').open(file);
    return reader.numPages;
  } catch {
    return 0;
  } finally {
    if (reader) await reader.destroy().catch(() => {});
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
