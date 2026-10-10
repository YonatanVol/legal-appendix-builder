'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  PDFDocument, PDFPage, PDFName, PDFDict, PDFArray, PDFStream, PDFNumber, PDFRef, PDFString, PDFHexString, PDFObjectCopier,
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
  for (let k = 0; k < pages.length; k++) {
    const i = pages[k];
    ctx.progress(0.1 + (k / pages.length) * 0.5, `משחיר את עמוד ${i + 1}`);
    const png = await fs.readFile(images[k]);
    // Beyond each mark by a little, so anti-aliased edges of letters do not peek out.
    const boxes = byPage.get(i).map((m) => ({ x: m.x - 0.002, y: m.y - 0.002, w: m.w + 0.004, h: m.h + 0.004 }));
    blacked.set(i, (await imaging.blackOut(png, 'image/png', boxes)).bytes);
    ctx.throwIfCancelled();
  }

  // Every unmarked page is prepared before any is copied. Pages often share one set of
  // resources, and the copier reuses what it copied for the first page that had it, so a
  // drawing added to that set for a later page would otherwise be missing from the copy.
  // What the page shows stays on it; the things that can lead back to other pages or
  // carry hidden text are left behind: a link's destination would pull a redacted page
  // across with it.
  const layers = settleLayers(doc);
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
      const crop = source.getCropBox();
      const turned = source.getRotation().angle % 180 !== 0;
      const w = turned ? crop.height : crop.width;
      const h = turned ? crop.width : crop.height;
      const image = await out.embedJpg(blacked.get(i));
      out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
      continue;
    }
    const node = copier.copy(source.node);
    out.addPage(PDFPage.of(node, out.context.register(node), out));
  }
  // The layers, so Ghostscript leaves out the marked content of the hidden ones; the list
  // itself is taken out of the result after (see withoutLayers).
  if (layers) out.catalog.set(PDFName.of('OCProperties'), copier.copy(layers.list));

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
  if (layers) bytes = await withoutLayers(bytes, options.clean === false ? doc : null);
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
  if (!visible(annot.get(PDFName.of('OC'))) || !visible(look.dict.get(PDFName.of('OC')))) return;
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
 * The document's layers, settled once for the whole file rather than followed from each
 * page: a hidden drawing can sit wherever a resource can (a pattern, a soft mask, a font
 * that draws its own letters, a font chosen through a graphics state...), and following
 * every such path has missed one each time. Instead:
 *
 * - which layers are shown is decided here, as a viewer decides it (PDF 32000, 8.11);
 * - every picture or drawing anywhere in the file placed whole on a hidden layer is
 *   emptied (Ghostscript would draw it: it ignores /OC on them);
 * - every rule over layers anywhere in the file is rewritten in place to name one plain
 *   layer, shown or hidden, by its worked-out answer (Ghostscript does not work out
 *   visibility expressions);
 * - every layer is stripped bare in place, keeping only its type and a plain name, and
 *   listed with its state, so Ghostscript leaves out the marked content of hidden ones.
 *
 * Returns { list, visible(oc) }: the layer list for Ghostscript, and a test of whether an
 * /OC value is shown. With no layers: null.
 */
function settleLayers(doc) {
  const ctxt = doc.context;
  const props = doc.catalog.lookup(PDFName.of('OCProperties'));
  if (!(props instanceof PDFDict)) return null;
  const isLayer = (o) => o instanceof PDFDict && String(o.get(PDFName.of('Type'))) === '/OCG';
  const isRule = (o) => o instanceof PDFDict && String(o.get(PDFName.of('Type'))) === '/OCMD';
  const d = props.lookup(PDFName.of('D'));
  const listOf = (dict, key) => {
    const a = dict instanceof PDFDict ? dict.lookup(PDFName.of(key)) : null;
    return a instanceof PDFArray ? a.asArray().filter((r) => r instanceof PDFRef && isLayer(ctxt.lookup(r))) : [];
  };
  const on = new Set(listOf(d, 'ON').map(String));
  const off = new Set(listOf(d, 'OFF').map(String));
  const allOff = d instanceof PDFDict && String(d.get(PDFName.of('BaseState'))) === '/OFF';

  // Every layer and every rule in the file, wherever it is, found by going through every
  // object once.
  const layers = [];
  const rules = [];
  const streams = [];
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
      if (isRule(o)) rules.push(o);
      for (const [, v] of o.entries()) visit(v);
    }
  };
  for (const [ref, o] of ctxt.enumerateIndirectObjects()) {
    if (isLayer(o)) layers.push(ref);
    if (o instanceof PDFStream) streams.push([ref, o]);
    visit(o);
  }
  const hiddenLayers = new Set(layers.map(String).filter((r) => (allOff ? !on.has(r) : off.has(r))));
  const layerShown = (ref) => !hiddenLayers.has(String(ref));

  // A visibility expression: [/And|/Or|/Not operand...], each operand a layer or another
  // expression. If anything in it is malformed or nests deeper than any real file would
  // (an expression that contains itself nests forever), the whole expression hides. The
  // first such part ends the work, and parts already worked out are remembered, so no
  // file can make this slow.
  const known = new Map();
  const BAD = Symbol('bad');
  const expression = (ve) => {
    const go = (x, depth) => {
      const v = ctxt.lookup(x);
      if (isLayer(v)) return layerShown(x);
      if (!(v instanceof PDFArray) || v.size() < 2 || depth > 50) throw BAD;
      if (known.has(v)) return known.get(v);
      const [op, ...rest] = v.asArray();
      let result;
      if (String(op) === '/And') result = rest.every((y) => go(y, depth + 1));
      else if (String(op) === '/Or') result = rest.some((y) => go(y, depth + 1));
      else if (String(op) === '/Not' && rest.length === 1) result = !go(rest[0], depth + 1);
      else throw BAD;
      known.set(v, result);
      return result;
    };
    try {
      return go(ve, 0);
    } catch (err) {
      if (err === BAD) return false;
      throw err;
    }
  };
  const ruleShown = (o) => {
    if (o.get(PDFName.of('VE'))) return expression(o.get(PDFName.of('VE')));
    const members = o.get(PDFName.of('OCGs'));
    const m = ctxt.lookup(members);
    const group = (m instanceof PDFArray ? m.asArray() : members ? [members] : [])
      .filter((r) => isLayer(ctxt.lookup(r)))
      .map(layerShown);
    if (!group.length) return true;
    const rule = String(o.get(PDFName.of('P')) || '/AnyOn');
    if (rule === '/AllOn') return group.every(Boolean);
    if (rule === '/AnyOff') return group.some((v) => !v);
    if (rule === '/AllOff') return group.every((v) => !v);
    return group.some(Boolean);
  };

  // Decided before anything is changed.
  const answers = new Map(rules.map((o) => [o, ruleShown(o)]));
  const visible = (oc) => {
    if (!oc) return true;
    const o = ctxt.lookup(oc);
    if (isLayer(o)) return layerShown(oc);
    if (isRule(o)) return answers.has(o) ? answers.get(o) : ruleShown(o);
    return true;
  };
  const hiddenStreams = streams.filter(([, x]) => !visible(x.dict.get(PDFName.of('OC'))));

  const shown = ctxt.register(ctxt.obj({ Type: 'OCG', Name: PDFHexString.fromText('מוצג') }));
  const hidden = ctxt.register(ctxt.obj({ Type: 'OCG', Name: PDFHexString.fromText('מוסתר') }));
  hiddenLayers.add(String(hidden));
  for (const [ref] of hiddenStreams) ctxt.assign(ref, ctxt.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] }));
  for (const [o, answer] of answers) {
    for (const key of o.keys()) o.delete(key);
    o.set(PDFName.of('Type'), PDFName.of('OCMD'));
    o.set(PDFName.of('OCGs'), answer ? shown : hidden);
  }
  layers.forEach((ref, k) => {
    const layer = ctxt.lookup(ref);
    for (const key of layer.keys()) layer.delete(key);
    layer.set(PDFName.of('Type'), PDFName.of('OCG'));
    layer.set(PDFName.of('Name'), PDFHexString.fromText(`שכבה ${k + 1}`));
  });
  const all = [shown, hidden, ...layers];
  const list = ctxt.obj({ OCGs: all, D: { Order: all, OFF: all.filter((r) => hiddenLayers.has(String(r))) } });
  return { list, visible };
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

module.exports = { run, strip, availability: () => bin.availability('gs') };
