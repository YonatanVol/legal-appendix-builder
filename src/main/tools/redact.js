'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  PDFDocument, PDFPage, PDFName, PDFDict, PDFArray, PDFStream, PDFNumber, PDFRef, PDFObjectCopier, PDFOperator,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} = require('pdf-lib');

const bin = require('../engine/binaries');
const imaging = require('../engine/imaging');
const { stage } = require('../engine/stage');
const { renderPages } = require('../engine/render');
const { ocrFile } = require('./ocr');
const { loadPdf } = require('../pdf/inspect');
const { samePages } = require('../engine/verify');
const { staleFields, drawAppearances } = require('./forms');

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
  // Attached files never come across, in either mode: one may be the unredacted original.
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const attached = (names instanceof PDFDict && !!names.get(PDFName.of('EmbeddedFiles'))) ||
    doc.getPages().some((p) => {
      const list = p.node.lookup(PDFName.of('Annots'));
      return list instanceof PDFArray && list.asArray().some((ref) => {
        const a = doc.context.lookup(ref);
        return a instanceof PDFDict && String(a.get(PDFName.of('Subtype'))) === '/FileAttachment';
      });
    });

  const src = await stage(ctx, source, 'redact');
  ctx.progress(0.05, 'מצייר את העמודים המסומנים…');
  const images = await renderPages(ctx, src, pages, { dpi: DPI, device: 'png16m', tag: 'red' });

  // The result is a new document holding only what it should. Removing a page from the
  // original and saving would not do: pdf-lib writes every object it read, referenced
  // or not, so the original page, its fonts, the old metadata and attachments would all
  // still be inside the file, invisible to a reader and readable with any PDF tool.
  const out = await PDFDocument.create();
  // Filled fields whose drawing is missing or out of date are drawn now, so that their
  // values can become part of the page below instead of disappearing with the form.
  try {
    const stale = staleFields(doc.getForm());
    if (stale.length) await drawAppearances(doc, stale);
  } catch {
    // A form pdf-lib cannot read keeps whatever drawings it already has.
  }
  const blacked = new Map();
  let copier = null;
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
    // What the page shows stays on it; the things that can lead back to other pages or
    // carry hidden text are left behind: a link's destination would pull a redacted page
    // across with it.
    strip(source, options.clean !== false);
    if (!copier) {
      await doc.flush();
      copier = PDFObjectCopier.for(doc.context, out.context);
    }
    const node = copier.copy(source.node);
    out.addPage(PDFPage.of(node, out.context.register(node), out));
  }
  // The document's layers, copied with the same copier as the pages so they name the same
  // objects: without them a layer the document keeps hidden would be drawn on the page.
  const layers = doc.catalog.lookup(PDFName.of('OCProperties'));
  if (copier && layers instanceof PDFDict) out.catalog.set(PDFName.of('OCProperties'), copier.copy(layers));

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
    summary: `${what}. ${marks.length === 1 ? 'האזור המסומן נמחק' : `${marks.length} האזורים המסומנים נמחקו`} מהקובץ עצמו, לא רק הוסתרו.${how}${searchable}${options.clean !== false ? ' גם פרטי המסמך, ההערות והקבצים המצורפים הוסרו.' : attached ? ' הקבצים המצורפים לא הועתקו, כי אחד מהם יכול להיות המסמך המקורי לפני ההשחרה.' : ''}`,
    display: [outputPath],
  };
}

function valid(m) {
  return m && Number.isInteger(m.page) && m.page >= 0 &&
    [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.w > 0 && m.h > 0 &&
    m.x >= -0.01 && m.y >= -0.01 && m.x + m.w <= 1.01 && m.y + m.h <= 1.01;
}

// Annotations whose look a viewer draws again from their own description, so they can stay
// as annotations when comments are kept. Any other kind that is shown (a stamp, a filled
// field, a signature picture) is drawn into the page instead.
const REDRAWN = new Set(['/Text', '/FreeText', '/Line', '/Square', '/Circle', '/Polygon', '/PolyLine',
  '/Highlight', '/Underline', '/Squiggly', '/StrikeOut', '/Caret', '/Ink']);
// Never drawn into the page: a link, a note's popup, attached files and media, and a
// redaction someone marked but never applied.
const NEVER = new Set(['/Link', '/Popup', '/FileAttachment', '/Sound', '/Movie', '/Screen', '/RichMedia', '/3D', '/Redact']);
// The only entries a kept comment keeps, and only when they hold no reference to another
// object: anything else (/AA, /FS, /P, /Parent, /IRT, media...) could lead to a redacted
// page and bring it into the new file whole.
const KEPT_KEYS = ['Type', 'Subtype', 'Rect', 'Contents', 'NM', 'M', 'F', 'C', 'CA', 'T', 'Subj', 'CreationDate',
  'Border', 'BS', 'IC', 'QuadPoints', 'InkList', 'Vertices', 'L', 'LE', 'DA', 'Q', 'RC', 'DS', 'Name', 'Open', 'RD'];

/**
 * Before an unmarked page is copied: what the page shows stays, as page content where it
 * was an annotation's drawing; links always go (their destinations would bring other
 * pages, redacted ones included, into the new file); with `clean` every annotation goes,
 * and without it the comments a viewer can draw again stay, holding only plain values.
 * Page-level metadata, thumbnails and article beads go too.
 */
function strip(page, clean) {
  const node = page.node;
  const ctxt = page.doc.context;
  const annots = node.lookup(PDFName.of('Annots'));
  const keep = [];
  if (annots instanceof PDFArray) {
    for (const ref of annots.asArray()) {
      const a = ctxt.lookup(ref);
      if (!(a instanceof PDFDict)) continue;
      const sub = String(a.get(PDFName.of('Subtype')) || '');
      if (NEVER.has(sub)) continue;
      if (!clean && REDRAWN.has(sub)) {
        const copy = ctxt.obj({});
        for (const key of KEPT_KEYS) {
          const value = a.get(PDFName.of(key));
          if (value !== undefined && plain(value)) copy.set(PDFName.of(key), value);
        }
        keep.push(ctxt.register(copy));
      } else if (!(clean && sub === '/Text')) {
        flatten(page, a);
      }
    }
  }
  if (keep.length) node.set(PDFName.of('Annots'), ctxt.obj(keep));
  else node.delete(PDFName.of('Annots'));
  for (const key of ['B', 'Thumb', 'AA', 'PieceInfo', 'Metadata', 'StructParents', 'Tabs', 'AF']) node.delete(PDFName.of(key));
}

/** A value with no reference to another object anywhere inside it. */
function plain(value) {
  if (value instanceof PDFRef) return false;
  if (value instanceof PDFArray) return value.asArray().every(plain);
  if (value instanceof PDFStream) return false;
  if (value instanceof PDFDict) return [...value.entries()].every(([, v]) => plain(v));
  return true;
}

const numbers = (arr) => (arr instanceof PDFArray ? arr.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)) : []);

/**
 * Draws an annotation's appearance into the page's content, where the annotation is,
 * as a viewer would show it (PDF 32000, 12.5.5). A hidden annotation is not drawn, and
 * one on a layer stays on that layer.
 */
function flatten(page, annot) {
  const ctxt = page.doc.context;
  const flags = annot.lookup(PDFName.of('F'));
  if (flags instanceof PDFNumber && (flags.asNumber() & (2 | 32))) return;
  const ap = annot.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return;
  let ref = ap.get(PDFName.of('N'));
  let look = ctxt.lookup(ref);
  if (look instanceof PDFDict && !(look instanceof PDFStream)) {
    // A drawing per state, as a checkbox has: the one the annotation is in.
    const state = annot.get(PDFName.of('AS'));
    ref = state ? look.get(state) : undefined;
    look = ref && ctxt.lookup(ref);
  }
  if (!(look instanceof PDFStream)) return;
  if (!(ref instanceof PDFRef)) ref = ctxt.register(look);

  const rect = numbers(annot.lookup(PDFName.of('Rect')));
  const bbox = numbers(look.dict.lookup(PDFName.of('BBox')));
  let m = numbers(look.dict.lookup(PDFName.of('Matrix')));
  if (m.length !== 6 || !m.every(Number.isFinite)) m = [1, 0, 0, 1, 0, 0];
  if (rect.length !== 4 || bbox.length !== 4 || ![...rect, ...bbox].every(Number.isFinite)) return;
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const bx = corners.map((c) => c[0]);
  const by = corners.map((c) => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...bx), Math.max(...bx), Math.min(...by), Math.max(...by)];
  const [r0, r1, s0, s1] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
  const sx = (r1 - r0) / (x1 - x0);
  const sy = (s1 - s0) / (y1 - y0);

  const name = page.node.newXObject('Flat', ref);
  const ops = [pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, r0 - x0 * sx, s0 - y0 * sy), drawObject(name), popGraphicsState()];
  const layer = annot.get(PDFName.of('OC'));
  if (layer) {
    const { Resources } = page.node.normalizedEntries();
    let props = Resources.lookup(PDFName.of('Properties'));
    if (!(props instanceof PDFDict)) {
      props = ctxt.obj({});
      Resources.set(PDFName.of('Properties'), props);
    }
    const tag = PDFName.of(`FlatOC${props.keys().length}`);
    props.set(tag, layer);
    ops.unshift(PDFOperator.of('BDC', [PDFName.of('OC'), tag]));
    ops.push(PDFOperator.of('EMC'));
  }
  page.pushOperators(...ops);
}

module.exports = { run, strip, availability: () => bin.availability('gs') };
