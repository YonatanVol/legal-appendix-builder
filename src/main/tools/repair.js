'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName, PDFDict, PDFArray } = require('pdf-lib');

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
 * Last, the page tree is put in order (typePages): a page that does not say it is one, a
 * count that is wrong, an entry that leads nowhere. Programs read such a tree differently,
 * so one would show a page that another leaves out; no method above fixes that, as each
 * keeps the tree as it was.
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

    if (await typePages(fixed.file)) damaged = true;
    const kept = await strictPages(fixed.file);
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

/**
 * Puts the page tree in order where programs could read it differently: every leaf is
 * marked as a page (/Type /Page) and every inner node as a node of pages; each node's
 * /Count is set to the pages actually under it; entries that lead to nothing are dropped.
 * pdf.js counts a file's pages by /Count and pdf-lib by the pages it finds, so after this
 * both count, and show, the same pages. Saves the file only if something was out of
 * order, and says whether it was.
 */
async function typePages(file) {
  let doc;
  try {
    doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  } catch {
    return false;
  }
  const ctxt = doc.context;
  let changed = false;
  const inner = new Set();
  // Returns how many pages are under `node`.
  const walk = (node) => {
    const kids = node.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) {
      if (String(node.get(PDFName.of('Type'))) !== '/Page') {
        node.set(PDFName.of('Type'), PDFName.of('Page'));
        changed = true;
      }
      return 1;
    }
    // A node met again on the way down is a loop: it counts for nothing there.
    if (inner.has(node)) return 0;
    inner.add(node);
    if (String(node.get(PDFName.of('Type'))) !== '/Pages') {
      node.set(PDFName.of('Type'), PDFName.of('Pages'));
      changed = true;
    }
    const kept = [];
    let count = 0;
    for (const ref of kids.asArray()) {
      const kid = ctxt.lookup(ref);
      if (!(kid instanceof PDFDict)) {
        changed = true;
        continue;
      }
      kept.push(ref);
      count += walk(kid);
    }
    if (kept.length !== kids.size()) node.set(PDFName.of('Kids'), ctxt.obj(kept));
    const said = node.lookup(PDFName.of('Count'));
    if (!said || typeof said.asNumber !== 'function' || said.asNumber() !== count) {
      node.set(PDFName.of('Count'), ctxt.obj(count));
      changed = true;
    }
    inner.delete(node);
    return count;
  };
  const root = doc.catalog.lookup(PDFName.of('Pages'));
  if (!(root instanceof PDFDict)) return false;
  walk(root);
  if (!changed) return false;
  // Read afresh, so the pages are read as pages, and written again; never with a page of
  // pdf-lib's own added to an empty-looking file.
  const again = await PDFDocument.load(await doc.save({ useObjectStreams: true, addDefaultPage: false }), { updateMetadata: false });
  await fs.writeFile(file, await again.save({ useObjectStreams: true, addDefaultPage: false }));
  return true;
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
