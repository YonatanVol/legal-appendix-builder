'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const bin = require('../engine/binaries');
const imaging = require('../engine/imaging');
const { stage } = require('../engine/stage');
const { renderPages } = require('../engine/render');
const { ocrFile } = require('./ocr');
const { loadPdf } = require('../pdf/inspect');
const { samePages } = require('../engine/verify');

const DPI = 200;

/**
 * Redact: remove what is marked, for real.
 *
 * A black rectangle drawn over text hides it from the eye and nothing else: the text
 * is still in the file, and copying the page brings it back. So every page that has a
 * mark is redrawn as a picture with the marked areas painted black, and the picture
 * replaces the page. Nothing of the original page survives on it: no text, no layers,
 * no hidden objects. Pages without marks are kept as they are.
 *
 * options.marks     [{ page, x, y, w, h }]: 0-based page, the rest fractions of the page
 *                   as shown, measured from its top-left corner
 * options.clean     also remove the document's metadata, comments and attached files
 *                   (default true)
 * options.ocr       make the redacted pages searchable again afterwards; the black areas
 *                   have nothing to find
 */
async function run({ inputs, options = {}, ctx }) {
  const source = inputs[0];
  const marks = Array.isArray(options.marks) ? options.marks.filter(valid) : [];
  if (!marks.length) throw new Error('לא סומן מה להשחיר. סמן אזורים על העמוד, או חפש טקסט וסמן את התוצאות.');

  const doc = await loadPdf(source);
  const total = doc.getPageCount();
  const byPage = new Map();
  for (const m of marks) {
    if (m.page >= total) throw new Error('הסימונים אינם תואמים את הקובץ. ייתכן שהוא השתנה מאז שנפתח.');
    if (!byPage.has(m.page)) byPage.set(m.page, []);
    byPage.get(m.page).push(m);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);

  const src = await stage(ctx, source, 'redact');
  ctx.progress(0.05, 'מצייר את העמודים המסומנים…');
  const images = await renderPages(ctx, src, pages, { dpi: DPI, device: 'png16m', tag: 'red' });

  // The result is a new document holding only what it should. Removing a page from the
  // original and saving would not do: pdf-lib writes every object it read, referenced
  // or not, so the original page, its fonts, the old metadata and attachments would all
  // still be inside the file, invisible to a reader and readable with any PDF tool.
  const out = await PDFDocument.create();
  const blacked = new Map();
  for (let k = 0; k < pages.length; k++) {
    const i = pages[k];
    ctx.progress(0.1 + (k / pages.length) * 0.5, `משחיר את עמוד ${i + 1}`);
    const png = await fs.readFile(images[k]);
    // Beyond each mark by a little, so anti-aliased edges of letters do not peek out.
    const boxes = byPage.get(i).map((m) => ({ x: m.x - 0.002, y: m.y - 0.002, w: m.w + 0.004, h: m.h + 0.004 }));
    blacked.set(i, (await imaging.blackOut(png, 'image/png', boxes)).bytes);
    ctx.throwIfCancelled();
  }

  for (let i = 0; i < total; i++) {
    ctx.progress(0.6 + (i / total) * 0.15, `בונה את עמוד ${i + 1}`);
    const source = doc.getPage(i);
    if (blacked.has(i)) {
      const crop = source.getCropBox();
      const turned = source.getRotation().angle % 180 !== 0;
      const w = turned ? crop.height : crop.width;
      const h = turned ? crop.width : crop.height;
      const image = await out.embedJpg(blacked.get(i));
      out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
      continue;
    }
    // Things on a page that can lead back to other pages or carry hidden text are left
    // behind: a link's destination would pull a redacted page across with it.
    strip(source, options.clean !== false);
    const [copy] = await out.copyPages(doc, [i]);
    out.addPage(copy);
  }

  if (options.clean === false) {
    // Asked to keep the document's details: only the standard, visible ones.
    for (const [get, set] of [['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject']]) {
      const value = doc[get]();
      if (value) out[set](value);
    }
  }
  out.setProducer('');
  out.setCreator('');

  ctx.progress(0.75, 'שומר…');
  let bytes = await out.save({ useObjectStreams: true });

  // Then Ghostscript draws every page of the new document and writes a PDF of only what
  // was drawn. A copied page can carry more than it draws: resources inherited from the
  // page tree, a picture used only by a redacted page, an unused form nested inside a
  // form the page does draw, a pattern's own resources. Nothing a page does not draw
  // survives this, whatever the structure that carried it, so the result holds the
  // redacted pages as pictures and the others as what they show, nothing else.
  await fs.writeFile(path.join(ctx.scratch, 'built.pdf'), bytes);
  const r = await bin.run('gs', [
    '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite',
    '-dAutoRotatePages=/None', '-dCompatibilityLevel=1.7',
    `-dPreserveAnnots=${options.clean === false ? 'true' : 'false'}`,
    '-dPreserveMarkedContent=false', '-dPassThroughJPEGImages=true', '-dDetectDuplicateImages=true',
    '-sOutputFile=pruned.pdf', 'built.pdf',
  ], { cwd: ctx.scratch, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (r.code !== 0) throw new Error('הבנייה האחרונה של הקובץ המושחר נכשלה, ולכן לא נוצר עותק. אפשר לנסות קודם את "תיקון PDF".');
  await samePages(path.join(ctx.scratch, 'pruned.pdf'), total, path.basename(source));
  bytes = await fs.readFile(path.join(ctx.scratch, 'pruned.pdf'));
  let searchable = '';
  if (options.ocr && bin.locate('gs')) {
    const temp = path.join(ctx.scratch, 'redacted.pdf');
    await fs.writeFile(temp, bytes);
    const read = await ocrFile(temp, { langs: 'heb+eng' }, ctx, (fraction, label) => ctx.progress(0.75 + fraction * 0.23, label));
    if (read.bytes) bytes = read.bytes;
    searchable = ' העמודים המושחרים זוהו מחדש, ואפשר לחפש בהם בכל מה שלא הושחר.';
  }
  const outputPath = await ctx.writeOutput(bytes, { source, label: 'מושחר', ext: 'pdf' });
  const what = pages.length === 1 ? 'עמוד אחד הושחר' : `${pages.length} עמודים הושחרו`;
  const how = options.ocr ? '' : ' העמודים המושחרים הפכו לתמונה, ולכן אי אפשר לחפש בהם טקסט.';
  return {
    summary: `${what}. ${marks.length === 1 ? 'האזור המסומן נמחק' : `${marks.length} האזורים המסומנים נמחקו`} מהקובץ עצמו, לא רק הוסתרו.${how}${searchable}${options.clean !== false ? ' גם פרטי המסמך, ההערות והקבצים המצורפים הוסרו.' : ''}`,
    display: [outputPath],
  };
}

function valid(m) {
  return m && Number.isInteger(m.page) && m.page >= 0 &&
    [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.w > 0 && m.h > 0 &&
    m.x >= -0.01 && m.y >= -0.01 && m.x + m.w <= 1.01 && m.y + m.h <= 1.01;
}

/**
 * Before an unmarked page is copied: links always go (their destinations would bring
 * other pages, redacted ones included, into the new file), and with `clean`, comments
 * and every other annotation, page-level metadata, thumbnails and article beads.
 */
function strip(page, clean) {
  const node = page.node;
  const ctxt = page.doc.context;
  const annots = node.lookup(PDFName.of('Annots'));
  if (annots && typeof annots.asArray === 'function') {
    const keep = [];
    if (!clean) {
      for (const ref of annots.asArray()) {
        const a = ctxt.lookup(ref);
        if (!a || !a.get) continue;
        const sub = a.get(PDFName.of('Subtype'));
        if (!sub || ['/Link', '/Widget', '/Popup'].includes(sub.toString()) || a.get(PDFName.of('Dest')) || a.get(PDFName.of('A'))) continue;
        // A shallow copy without its references to other objects: its page (/P), a
        // field (/Parent), the note it answers (/IRT) and its popup. Any of those could
        // lead to a redacted page and bring it into the new file whole.
        const copy = a.clone(ctxt);
        for (const key of ['P', 'Parent', 'IRT', 'Popup', 'AP', 'StructParent']) copy.delete(PDFName.of(key));
        keep.push(ctxt.register(copy));
      }
    }
    if (keep.length) node.set(PDFName.of('Annots'), ctxt.obj(keep));
    else node.delete(PDFName.of('Annots'));
  }
  for (const key of ['B', 'Thumb', 'AA', 'PieceInfo', 'Metadata', 'StructParents', 'Tabs', 'AF']) node.delete(PDFName.of(key));
}

module.exports = { run, strip, availability: () => bin.availability('gs') };
