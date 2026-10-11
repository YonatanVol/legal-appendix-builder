'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  PDFDocument, PDFPage, PDFName, PDFDict, PDFArray, PDFStream, PDFNumber, PDFRef, PDFNull, PDFString, PDFHexString, PDFObjectCopier,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} = require('pdf-lib');

const bin = require('../engine/binaries');
const imaging = require('../engine/imaging');
const pagepicture = require('../engine/pagepicture');
const { ocrFile } = require('./ocr');
const { loadPdf } = require('../pdf/inspect');
const { samePages } = require('../engine/verify');
const docs = require('../docs');
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

  // The marks were made on the file as it was when the screen opened it.
  if (options.forToken && docs.register(source) !== options.forToken) {
    throw new Error('הקובץ השתנה מאז שסומן, ולכן לא נוצר עותק. פתח אותו שוב וסמן מחדש.');
  }
  // Refuses a locked file with its own message.
  await loadPdf(source);

  // From here on the file is read from a copy, so it cannot change midway; and the copy
  // is checked to be the version the screen showed.
  ctx.progress(0.02, 'קורא את הקובץ…');
  const given = path.join(ctx.scratch, 'given.pdf');
  await fs.copyFile(source, given);
  if (options.forToken && docs.register(source) !== options.forToken) {
    throw new Error('הקובץ השתנה מאז שסומן, ולכן לא נוצר עותק. פתח אותו שוב וסמן מחדש.');
  }

  // pdf.js (which drew the screen and draws the marked pages) and pdf-lib (which copies
  // the other pages) read a file differently where it is ambiguous: an object written
  // twice, two tables of objects, a damaged one. qpdf writes the file afresh, each object
  // once, and pdf-lib reads that copy. Then every page of the copy is confirmed, below,
  // to read to pdf.js exactly as the file itself does.
  // Without object streams, so pdf-lib reads plain objects only.
  const q = await bin.run('qpdf', ['--object-streams=disable', '--', 'given.pdf', 'single.pdf'], { cwd: ctx.scratch, signal: ctx.signal });
  ctx.throwIfCancelled();
  // 3: qpdf repaired something and says so; the copy is still confirmed page by page.
  if (q.code !== 0 && q.code !== 3) {
    throw new Error('הקובץ פגום או בנוי באופן שאינו חד משמעי, ולכן אין ודאות מה בדיוק הוצג במסך. לא נוצר עותק. אפשר להריץ קודם את "תיקון PDF" ולסמן שוב בקובץ המתוקן.');
  }
  const single = path.join(ctx.scratch, 'single.pdf');
  const doc = await loadPdf(single);
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

  // The marked pages are drawn by pdf.js, as the screen drew them when the user marked
  // them (engine/pagepicture.js), so the picture holds what they saw. First the pages
  // are matched: the marks are numbered as pdf.js numbers the pages, and the pictures
  // replace pages as pdf-lib numbers them. A file can be made so that the two disagree,
  // and a picture would then replace a page other than the one marked.
  ctx.progress(0.05, 'מצייר את העמודים המסומנים…');
  // The pictures are drawn from the file itself, as the screen drew it. The fresh copy
  // is read by pdf.js too, to confirm pdf-lib sees its pages as pdf.js does; and the two
  // pdf.js readings must count the same pages.
  const view = pagepicture.open(given, { signal: ctx.signal });
  const copyView = pagepicture.open(single, { signal: ctx.signal });
  const blacked = new Map();
  try {
    let onScreen;
    let shown;
    try {
      onScreen = await view.pageList();
      shown = await copyView.pageList();
    } catch (err) {
      failed(ctx, err);
    }
    const same = onScreen.length === total && shown.length === total && doc.getPages().every((p, i) =>
      shown[i][0] === p.ref.objectNumber && shown[i][1] === p.ref.generationNumber);
    if (!same) {
      throw new Error('העמודים בקובץ הזה בנויים כך שאין ודאות איזה עמוד סומן, ולכן לא נוצר עותק. אפשר להריץ קודם "תיקון PDF" ולסמן שוב בקובץ המתוקן.');
    }
    // Every page of the copy pdf-lib reads must read to pdf.js exactly as the file itself
    // does (the screen): the same text, seen or not, the same drawing, the same picture.
    // Two readers that took the same bytes differently (two tables of objects, an object
    // stream out of order, an object written twice) differ here, before anything is made.
    for (let i = 0; i < total; i++) {
      ctx.progress(0.05 + (i / total) * 0.25, `בודק את עמוד ${i + 1} מתוך ${total}`);
      let differs;
      try {
        differs = await view.same(i, copyView);
      } catch (err) {
        failed(ctx, err);
      }
      if (differs) {
        console.error(`[redact] page ${i + 1} reads differently in the copy (${differs})`);
        throw new Error(`הקובץ בנוי כך שתוכנות שונות קוראות את עמוד ${i + 1} בו בצורה שונה, ולכן אין ודאות מה בדיוק יישאר בו. לא נוצר עותק. אפשר להריץ קודם את "תיקון PDF" ולסמן שוב בקובץ המתוקן.`);
      }
    }
    for (let k = 0; k < pages.length; k++) {
      const i = pages[k];
      ctx.progress(0.3 + (k / pages.length) * 0.3, `משחיר את עמוד ${i + 1}`);
      let picture;
      try {
        picture = await view.draw(i, DPI);
      } catch (err) {
        failed(ctx, err);
      }
      // Beyond each mark by a little, so anti-aliased edges of letters do not peek out.
      const boxes = byPage.get(i).map((m) => ({ x: m.x - 0.002, y: m.y - 0.002, w: m.w + 0.004, h: m.h + 0.004 }));
      blacked.set(i, { jpg: (await imaging.blackOut(picture.png, 'image/png', boxes)).bytes, width: picture.width, height: picture.height });
      ctx.throwIfCancelled();
    }
  } finally {
    await view.release();
    await copyView.release();
  }
  const layers = settleLayers(doc);

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

  // Every unmarked page is prepared before any is copied. Pages often share one set of
  // resources, and the copier reuses what it copied for the first page that had it, so a
  // drawing added to that set for a later page would otherwise be missing from the copy.
  // What the page shows stays on it; the things that can lead back to other pages or
  // carry hidden text are left behind: a link's destination would pull a redacted page
  // across with it.
  const removed = { handwriting: 0, typed: 0 };
  for (let i = 0; i < total; i++) {
    if (blacked.has(i)) continue;
    const page = doc.getPage(i);
    const r = strip(page, options.clean !== false, layers);
    removed.handwriting += r.handwriting;
    removed.typed += r.typed;
  }
  await doc.flush();
  const copier = PDFObjectCopier.for(doc.context, out.context);
  for (let i = 0; i < total; i++) {
    ctx.progress(0.6 + (i / total) * 0.15, `בונה את עמוד ${i + 1}`);
    const source = doc.getPage(i);
    if (blacked.has(i)) {
      // The size pdf.js showed the page at, so the picture is not stretched.
      const { jpg, width: w, height: h } = blacked.get(i);
      const image = await out.embedJpg(jpg);
      out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
      continue;
    }
    const node = copier.copy(source.node);
    out.addPage(PDFPage.of(node, out.context.register(node), out));
  }
  // The layers, so Ghostscript leaves out the marked content of the hidden ones; the list
  // itself is taken out of the result after (see withoutLayers).
  if (layers.list) out.catalog.set(PDFName.of('OCProperties'), copier.copy(layers.list));

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
  if (layers.list) bytes = await withoutLayers(bytes, options.clean === false ? doc : null);
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
    summary: `${what}. ${marks.length === 1 ? 'האזור המסומן נמחק מהקובץ עצמו, לא רק הוסתר.' : `${marks.length} האזורים המסומנים נמחקו מהקובץ עצמו, לא רק הוסתרו.`}${how}${searchable}${options.clean !== false ? ` גם פרטי המסמך, ההערות והקבצים המצורפים הוסרו.${notedRemovals(removed)}` : attached ? ' הקבצים המצורפים לא הועתקו, כי אחד מהם יכול להיות המסמך המקורי לפני ההשחרה.' : ''}`,
    display: [outputPath],
  };
}

/** What a person would not think of as a comment, among the comments removed. */
function notedRemovals({ handwriting, typed }) {
  const kinds = [handwriting && 'כתב יד', typed && 'טקסט שהוקלד על העמוד'].filter(Boolean);
  if (!kinds.length) return '';
  return ` בין ההערות שהוסרו יש גם ${kinds.join(' וגם ')}. כדי לשמור ${kinds.length === 1 ? 'אותו' : 'אותם'}, אפשר להשחיר שוב בלי "הסרת פרטי המסמך, הערות וקבצים מצורפים".`;
}

/** A page pdf.js could not draw or read: Esc is passed on, anything else said in Hebrew. */
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
function strip(page, clean, layers = null) {
  const node = page.node;
  const ctxt = page.doc.context;
  // A page whose list of contents is shared with another gets its own list, so what is
  // drawn into this page is not drawn into the other too.
  const contents = node.get(PDFName.of('Contents'));
  const list = ctxt.lookup(contents);
  if (contents instanceof PDFRef && list instanceof PDFArray) node.set(PDFName.of('Contents'), ctxt.obj(list.asArray()));
  const annots = node.lookup(PDFName.of('Annots'));
  const keep = [];
  const removed = { handwriting: 0, typed: 0 };
  if (annots instanceof PDFArray) {
    for (const ref of annots.asArray()) {
      const a = ctxt.lookup(ref);
      if (!(a instanceof PDFDict)) continue;
      const sub = String(a.get(PDFName.of('Subtype')) || '');
      if (NEVER.has(sub)) continue;
      // Text typed onto the page, with a drawing of it to put there; without one it is
      // treated as any comment.
      const typed = sub === '/FreeText' && String(a.get(PDFName.of('IT'))) === '/FreeTextTypeWriter' && !!appearanceOf(a);
      // A comment on a hidden layer is not shown, so it does not come across.
      if (layers && !layers.visible(a.get(PDFName.of('OC')), 'annot')) continue;
      if (!clean && REDRAWN.has(sub) && !typed) {
        const copy = ctxt.obj({});
        for (const key of KEPT_KEYS) {
          const value = a.get(PDFName.of(key));
          if (value !== undefined && plain(value)) copy.set(PDFName.of(key), value);
        }
        keep.push(ctxt.register(copy));
      } else if (!REDRAWN.has(sub) || typed) {
        // What is not a comment (a filled field, a stamp, a signature picture, text typed
        // onto the page) is drawn into the page.
        flatten(page, a, layers);
      } else {
        // A comment goes with the others when they are removed.
        if (sub === '/Ink') removed.handwriting++;
        if (sub === '/FreeText' && String(a.get(PDFName.of('IT'))) === '/FreeTextTypeWriter') removed.typed++;
      }
    }
  }
  if (keep.length) node.set(PDFName.of('Annots'), ctxt.obj(keep));
  else node.delete(PDFName.of('Annots'));
  for (const key of ['B', 'Thumb', 'AA', 'PieceInfo', 'Metadata', 'StructParents', 'Tabs', 'AF']) node.delete(PDFName.of(key));
  return removed;
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
 * The drawing an annotation shows now: its normal appearance, or for one with a drawing
 * per state (a checkbox) the one for the state it is in. { look, ref } or null.
 */
function appearanceOf(annot) {
  const ctxt = annot.context;
  const ap = annot.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return null;
  let ref = ap.get(PDFName.of('N'));
  let look = ctxt.lookup(ref);
  if (look instanceof PDFDict && !(look instanceof PDFStream)) {
    const state = annot.get(PDFName.of('AS'));
    ref = state ? look.get(state) : undefined;
    look = ref && ctxt.lookup(ref);
  }
  return look instanceof PDFStream ? { look, ref } : null;
}

/**
 * Draws an annotation's appearance into the page's content, where the annotation is,
 * as a viewer would show it (PDF 32000, 12.5.5). A hidden annotation is not drawn, nor
 * one whose layer, or whose drawing's layer, is hidden.
 */
function flatten(page, annot, layers) {
  const visible = layers ? layers.visible : () => true;
  const ctxt = page.doc.context;
  const flags = annot.lookup(PDFName.of('F'));
  if (flags instanceof PDFNumber && (flags.asNumber() & (2 | 32))) return;
  const found = appearanceOf(annot);
  if (!found) return;
  const { look } = found;
  let { ref } = found;
  // The drawing's own /OC does not count: pdf.js ignores it for an annotation's drawing.
  if (!visible(annot.get(PDFName.of('OC')), 'annot')) return;
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
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, r0 - x0 * sx, s0 - y0 * sy), drawObject(name), popGraphicsState());
}

/**
 * The document's layers, settled once for the whole file.
 *
 * What counts as shown is exactly what the screen showed when the user marked the file:
 * the rules are pdf.js's own (the version this app ships, display intent), ported line
 * for line from OptionalContentConfig.isVisible and PartialEvaluator's
 * parseMarkedContentProps and _parseVisibilityExpression, including where they differ
 * from the PDF specification (an unknown layer shows; a list of no layers under AnyOn
 * hides; a visibility expression stops at ten levels, its deeper parts counting as shown).
 * Matching the screen, rather than the specification, means the result shows what the
 * user saw, no more and no less.
 *
 * Then, for Ghostscript, which works out less of this than pdf.js does:
 * - every picture or drawing in the file whose /OC is hidden is emptied (Ghostscript
 *   ignores /OC on them);
 * - every rule over layers is rewritten in place to name one plain layer, shown or hidden;
 * - every layer named in any /Properties dictionary is replaced there by the plain shown
 *   or hidden layer, so Ghostscript needs to know only those two.
 * The list of the two is taken out of the result afterwards (withoutLayers).
 *
 * Everything is found by going through every object in the file once, not by following
 * references from the pages: following them missed a new place each review round.
 *
 * pdf.js resolves every value it reads, so this reads every value through lookup too.
 * Where pdf.js fails on an /OC (a value that is not a dictionary, a /null among a rule's
 * layers), it leaves out the picture, drawing or annotation that carries it, and shows
 * marked content: so does this.
 *
 * Returns { list, visible(oc, use) }, `use` being 'content' (marked content), 'xobject'
 * or 'annot'. `list` is null when the file has no layer list, and then nothing is
 * rewritten for Ghostscript; only what pdf.js leaves out on error is.
 */
function settleLayers(doc) {
  const ctxt = doc.context;
  const props = doc.catalog.lookup(PDFName.of('OCProperties'));
  const typeOf = (o) => (o instanceof PDFDict ? String(o.lookup(PDFName.of('Type'))) : '');

  // The layers pdf.js knows: those in /OCGs, with no /D or no /OCGs list meaning none.
  // Each starts shown; BaseState /OFF hides all; then /ON shows and /OFF hides (OFF last,
  // so it wins). A layer whose /Usage /View /ViewState is /OFF never shows on screen.
  const groups = new Map();
  const d = props instanceof PDFDict ? props.lookup(PDFName.of('D')) : null;
  const listed = props instanceof PDFDict ? props.lookup(PDFName.of('OCGs')) : null;
  if (d instanceof PDFDict && listed instanceof PDFArray) {
    for (const ref of listed.asArray()) {
      if (!(ref instanceof PDFRef) || groups.has(String(ref))) continue;
      const layer = ctxt.lookup(ref);
      // pdf.js gives up on the whole list then, and shows everything.
      if (!(layer instanceof PDFDict)) {
        groups.clear();
        break;
      }
      const usage = layer.lookup(PDFName.of('Usage'));
      const view = usage instanceof PDFDict ? usage.lookup(PDFName.of('View')) : null;
      const viewState = view instanceof PDFDict ? String(view.lookup(PDFName.of('ViewState'))) : '';
      groups.set(String(ref), { on: true, viewOff: viewState === '/OFF' });
    }
    const set = (key, on) => {
      const a = d.lookup(PDFName.of(key));
      if (!(a instanceof PDFArray)) return;
      for (const r of a.asArray()) if (r instanceof PDFRef && groups.has(String(r))) groups.get(String(r)).on = on;
    };
    if (String(d.lookup(PDFName.of('BaseState'))) === '/OFF') for (const g of groups.values()) g.on = false;
    set('ON', true);
    set('OFF', false);
  }
  // Undefined for a layer pdf.js does not know, which then shows.
  const known = (id) => groups.get(id);
  const groupShown = (g) => g.on && !g.viewOff;

  // A visibility expression, parsed and worked out as pdf.js does. Each (expression,
  // depth) is worked out once, so shared or self-containing parts cannot make this slow.
  const answers = new Map();
  // Returns undefined when pdf.js's parse would yield nothing (bad operator, too short,
  // past ten levels), else whether the expression shows.
  const expression = (array, nesting) => {
    const level = nesting + 1;
    let byLevel = answers.get(array);
    if (!byLevel) answers.set(array, (byLevel = new Map()));
    if (byLevel.has(level)) return byLevel.get(level);
    byLevel.set(level, undefined);
    let result;
    const items = array.asArray();
    const op = items.length ? ctxt.lookup(items[0]) : null;
    const name = op instanceof PDFName ? op.asString().slice(1) : '';
    if (level <= 10 && items.length >= 2 && ['And', 'Or', 'Not'].includes(name)) {
      // Parsed: arrays nest, references name layers, anything else is dropped.
      const elements = [];
      for (const raw of items.slice(1)) {
        const value = ctxt.lookup(raw);
        if (value instanceof PDFArray) elements.push({ nested: value });
        else if (raw instanceof PDFRef) elements.push({ id: String(raw) });
      }
      result = evaluate(name, elements, level);
    }
    byLevel.set(level, result);
    return result;
  };
  const evaluate = (name, elements, level) => {
    if (elements.length < 1) return true;
    for (const element of elements) {
      let state;
      if (element.nested) {
        const inner = expression(element.nested, level);
        state = inner === undefined ? true : inner;
      } else {
        const g = known(element.id);
        if (!g) return true;
        state = groupShown(g);
      }
      if (name === 'And' && !state) return false;
      if (name === 'Or' && state) return true;
      if (name === 'Not') return !state;
    }
    return name === 'And';
  };
  // A list of layers under a policy, as pdf.js reads it: in order, and "shown" at the
  // first layer it does not know. Worked out once per list and policy.
  const lists = new Map();
  const policyShown = (ids, policy, list) => {
    const memo = list && lists.get(list);
    if (memo && memo.has(policy)) return memo.get(policy);
    // The first layer (in order) for which `stop` holds: 'unknown', 'hit' or 'none'.
    const scan = (stop) => {
      for (const id of ids) {
        const g = known(id);
        if (!g) return 'unknown';
        if (stop(groupShown(g))) return 'hit';
      }
      return 'none';
    };
    let result;
    if (policy === 'AnyOn') result = scan((v) => v) !== 'none';
    else if (policy === 'AllOn') result = scan((v) => !v) !== 'hit';
    else if (policy === 'AnyOff') result = scan((v) => !v) !== 'none';
    else if (policy === 'AllOff') result = scan((v) => v) !== 'hit';
    else result = true;
    if (list) {
      if (!lists.has(list)) lists.set(list, new Map());
      lists.get(list).set(policy, result);
    }
    return result;
  };
  // Whether an /OC value (or a /Properties entry) shows: parseMarkedContentProps, then
  // isVisible. `raw` is the value as written, so a layer is known by its reference.
  // What pdf.js's parseMarkedContentProps makes of an /OC value: 'error' where it throws,
  // null where it yields nothing (shown), else a function giving the answer.
  const ERROR = 'error';
  const parsed = (raw) => {
    const o = ctxt.lookup(raw);
    if (!(o instanceof PDFDict) || o instanceof PDFStream) return ERROR;
    const type = typeOf(o);
    if (type === '/OCG') {
      return () => {
        const g = raw instanceof PDFRef ? known(String(raw)) : undefined;
        return g ? groupShown(g) : true;
      };
    }
    if (type !== '/OCMD') return null;
    const ve = o.lookup(PDFName.of('VE'));
    if (ve instanceof PDFArray && expression(ve, 0) !== undefined) return () => expression(ve, 0);
    const membersRaw = o.get(PDFName.of('OCGs'));
    const members = ctxt.lookup(membersRaw);
    const policyName = o.lookup(PDFName.of('P'));
    const policy = policyName instanceof PDFName ? policyName.asString().slice(1) : 'AnyOn';
    if (members instanceof PDFArray) {
      if (members.asArray().some((m) => m === PDFNull)) return ERROR;
      return () => policyShown(members.asArray().map(String), policy, members);
    }
    if (members instanceof PDFDict) return () => policyShown([membersRaw instanceof PDFRef ? String(membersRaw) : ''], policy, null);
    return null;
  };
  // Whether something carrying this /OC is on screen. With no /OC at all it is. An
  // annotation's /OC counts only when it is a dictionary (setOptionalContent). On an
  // error, /OC null included, pdf.js leaves out a picture or drawing and an annotation,
  // and shows marked content.
  const visible = (raw, use = 'content', stream = null) => {
    if (raw === undefined) return true;
    const o = ctxt.lookup(raw);
    if (use === 'annot' && (!(o instanceof PDFDict) || o instanceof PDFStream)) return true;
    if (o instanceof PDFName && use === 'xobject') {
      // A picture's /OC given as a name: pdf.js looks it up in the /Properties of the
      // resources that draw the picture, and fails (leaving the picture out) where there
      // is none. A picture can be drawn from several resources, so it shows only if every
      // one of them names a layer for it that shows.
      return (drawnFrom.get(String(stream)) || []).every((resources) => {
        const named = resources.lookup(PDFName.of('Properties'));
        return named instanceof PDFDict && named.has(o) && visible(named.get(o), 'xobject');
      });
    }
    const p = parsed(raw);
    if (p === ERROR) return use === 'content';
    if (!p || !groups.size) return true;
    return p();
  };

  // Every rule, stream and /Properties dictionary in the file, found by going through
  // every object once.
  const rules = [];
  const streams = [];
  const properties = [];
  const annotations = [];
  // For each picture or drawing, the resources that draw it.
  const drawnFrom = new Map();
  const seen = new Set();
  const visit = (o) => {
    if (!o || typeof o !== 'object' || o instanceof PDFRef || seen.has(o)) return;
    seen.add(o);
    if (o instanceof PDFStream) {
      visit(o.dict);
      return;
    }
    if (o instanceof PDFArray) {
      for (const x of o.asArray()) visit(x);
      return;
    }
    if (o instanceof PDFDict) {
      if (typeOf(o) === '/OCMD') rules.push(o);
      if (o.has(PDFName.of('AP')) && o.has(PDFName.of('Rect'))) annotations.push(o);
      const named = o.lookup(PDFName.of('Properties'));
      if (named instanceof PDFDict) properties.push(named);
      const xobjects = o.lookup(PDFName.of('XObject'));
      if (xobjects instanceof PDFDict) {
        for (const [, ref] of xobjects.entries()) {
          if (!(ref instanceof PDFRef)) continue;
          if (!drawnFrom.has(String(ref))) drawnFrom.set(String(ref), []);
          drawnFrom.get(String(ref)).push(o);
        }
      }
      for (const [, v] of o.entries()) visit(v);
    }
  };
  for (const [ref, o] of ctxt.enumerateIndirectObjects()) {
    if (o instanceof PDFStream) streams.push([ref, o]);
    visit(o);
  }

  // Decided before anything is changed.
  const ruleAnswers = new Map(rules.map((o) => [o, visible(o)]));
  const ruleErrors = new Set(rules.filter((o) => parsed(o) === ERROR));
  // Only pictures and drawings: pdf.js and every viewer ignore /OC on any other stream (a
  // page's own content, a colour profile, a font), so those are left as they are.
  // (Read raw: pdf-lib's get turns /OC null into no /OC, and pdf.js does not.)
  const rawOC = (dict) => dict.dict.get(PDFName.of('OC'));
  const hiddenStreams = streams.filter(([ref, x]) => ['/Image', '/Form'].includes(String(x.dict.lookup(PDFName.of('Subtype')))) &&
    !visible(rawOC(x.dict), 'xobject', ref));
  const propertyAnswers = properties.map((named) => [named, named.entries()
    .filter(([, value]) => typeOf(ctxt.lookup(value)) === '/OCG')
    .map(([key, value]) => [key, visible(value)])]);

  // An annotation's own drawing is shown whatever its /OC says (pdf.js ignores it there),
  // while the same drawing placed in a page is not. So before a hidden drawing is
  // emptied, an annotation that shows it gets a copy of its own, without the /OC.
  const hiddenRefs = new Set(hiddenStreams.map(([ref]) => String(ref)));
  const ownCopy = (ref) => {
    const copy = ctxt.lookup(ref).clone(ctxt);
    copy.dict.delete(PDFName.of('OC'));
    return ctxt.register(copy);
  };
  for (const annot of annotations) {
    const ap = annot.lookup(PDFName.of('AP'));
    if (!(ap instanceof PDFDict)) continue;
    const n = ap.get(PDFName.of('N'));
    if (n instanceof PDFRef && hiddenRefs.has(String(n))) ap.set(PDFName.of('N'), ownCopy(n));
    const states = ctxt.lookup(n);
    if (states instanceof PDFDict && !(states instanceof PDFStream)) {
      for (const [state, ref] of states.entries()) if (ref instanceof PDFRef && hiddenRefs.has(String(ref))) states.set(state, ownCopy(ref));
    }
  }
  for (const [ref] of hiddenStreams) ctxt.assign(ref, ctxt.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] }));
  if (!(props instanceof PDFDict)) return { list: null, visible: (raw, use) => visible(raw, use) };

  const shown = ctxt.register(ctxt.obj({ Type: 'OCG', Name: PDFHexString.fromText('מוצג') }));
  const hidden = ctxt.register(ctxt.obj({ Type: 'OCG', Name: PDFHexString.fromText('מוסתר') }));
  // Only the keys of a rule are replaced: the same dictionary may serve as something else
  // too, and its other keys are left for that.
  for (const [o, answer] of ruleAnswers) {
    for (const key of ['VE', 'P', 'OCGs']) o.delete(PDFName.of(key));
    o.set(PDFName.of('OCGs'), answer ? shown : hidden);
  }
  for (const [named, entries] of propertyAnswers) {
    for (const [key, answer] of entries) named.set(key, answer ? shown : hidden);
  }
  const list = ctxt.obj({ OCGs: [shown, hidden], D: { Order: [shown, hidden], OFF: [hidden] } });
  // After the rewrite every rule names a plain layer, so answers come from the record.
  const decided = (raw, use = 'content') => {
    const o = ctxt.lookup(raw);
    if (ruleAnswers.has(o)) return use !== 'content' && ruleErrors.has(o) ? false : ruleAnswers.get(o);
    return visible(raw, use);
  };
  return { list, visible: decided };
}

/**
 * The result with the layer list taken out. Once Ghostscript has left out what the hidden
 * layers held, the list only shows empty layers in a viewer's panel, one of them named
 * "hidden", and tells how many layers the original had. The pages are copied into a new
 * document, which holds only what they use. With `details`, the kept title, author and
 * subject are set again.
 */
async function withoutLayers(bytes, details) {
  const built = await PDFDocument.load(bytes, { updateMetadata: false });
  const result = await PDFDocument.create({ updateMetadata: false });
  const copied = await result.copyPages(built, built.getPageIndices());
  for (const page of copied) result.addPage(page);
  if (details) {
    for (const [get, set] of [['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject']]) {
      const value = details[get]();
      if (value) result[set](value);
    }
  }
  return result.save({ useObjectStreams: true });
}

module.exports = { run, strip, availability: () => bin.availability('gs', 'qpdf') };
