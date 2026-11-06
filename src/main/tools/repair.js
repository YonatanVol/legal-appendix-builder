'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = require('pdf-lib');

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
 * Last, the pages are put in one plain list (alignPages) where programs could read the
 * file's page tree differently (a page that does not say it is one, a node that says it is
 * a page, a wrong count, an entry that leads nowhere or back up the tree): one would show
 * a page that another leaves out, and no method above fixes that, as each keeps the tree
 * as it was. Every page the screen showed stays; pages it hid come back in their place.
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
    const seen = await pagesShown(inputs[f]);
    const expected = (seen && seen.opened) || countPagesLoosely(bytes);
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
    // Counted the same way on both sides: pages pdf.js could open in the file given, and in
    // the rebuilt one before its pages were put in order (that step loses none). Pages it
    // had not shown, now in their place, are said apart.
    const lost = Math.max(0, (expected || kept) - (aligned.shownBefore === null ? kept : aligned.shownBefore));
    outputs.push(await ctx.writeOutput(await fs.readFile(fixed.file), { source: inputs[f], label: 'מתוקן', ext: 'pdf' }));
    notes.push(
      `${inputs.length > 1 ? `"${name}": ` : ''}${damaged ? 'הקובץ היה פגום ונבנה מחדש' : 'לא נמצא פגם במבנה, הקובץ נכתב מחדש'}` +
      `, ${kept === 1 ? 'עמוד אחד שוחזר' : `${kept} עמודים שוחזרו`}${lost ? `, ${lost === 1 ? 'עמוד אחד אבד' : `${lost} עמודים אבדו`}` : ''}.` +
      (aligned.added ? ` ${aligned.added === 1 ? 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו' : `${aligned.added} עמודים שלא הוצגו במסך נמצאו בקובץ והוחזרו למקומם`}.` : '')
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
 * Where pdf.js (which draws the pages on screen) and pdf-lib (which the tools use) could
 * read the file's pages differently, the page tree is replaced by one plain list that both
 * read the same way. What the screen showed is the ground: every page it showed stays, in
 * its order (one shown twice stays twice), and looks as it did, with what it inherits read
 * up its /Parent as pdf.js reads it. Nothing is guessed away. Pages are only added: a dict
 * in the tree that says it is a page, or says nothing and has content of its own, which the
 * screen did not show (a wrong count, a node that says it is a page, hid it). Each goes back
 * after the shown page that comes before it in the file's own order.
 * Returns { changed, added, shownBefore }: whether the file was rewritten, how many pages
 * the screen had not shown were added, and how many pages pdf.js could open before (null
 * if it could not open the file at all).
 */
async function alignPages(file) {
  let doc;
  try {
    doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  } catch {
    const shown = await pagesShown(file);
    return { changed: false, added: 0, shownBefore: shown ? shown.opened : null };
  }
  const ctxt = doc.context;
  const key = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

  // A page written straight into a list of pages has no number, so the screen's pages could
  // not be matched to it; each such page is given one first.
  let numbered = false;
  const number = (entry, above) => {
    const dict = entry instanceof PDFRef ? ctxt.lookup(entry) : entry;
    if (!(dict instanceof PDFDict) || above.has(dict)) return;
    const kids = dict.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) return;
    const path = new Set(above).add(dict);
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.get(i);
      if (kid instanceof PDFDict) {
        kids.set(i, ctxt.register(kid));
        numbered = true;
      }
      number(kids.get(i), path);
    }
  };
  number(doc.catalog.get(PDFName.of('Pages')), new Set());
  if (numbered) {
    await fs.writeFile(file, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
    doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  }

  const shown = await pagesShown(file);
  const none = { changed: numbered, added: 0, shownBefore: shown ? shown.opened : null };
  if (!shown || !shown.refs.length) return none;
  const docCtxt = doc.context;
  let own = null;
  try {
    own = doc.getPages().map((p) => key(p.ref));
  } catch {
    // pdf-lib cannot walk the tree at all: it is rebuilt below
  }

  // The file's own order: every dict the tree leads to that says it is a page, or says
  // nothing and has content of its own. Loops are cut; a page reached twice counts once.
  const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  const onScreen = new Set(shown.refs);
  const inFile = [];
  const nodes = new Set();
  const walk = (entry, passed, above) => {
    if (!(entry instanceof PDFRef)) return;
    const dict = docCtxt.lookup(entry);
    if (!(dict instanceof PDFDict) || above.has(dict)) return;
    const type = dict.get(PDFName.of('Type'));
    const kids = dict.lookup(PDFName.of('Kids'));
    const looksLikePage = String(type) === '/Page' || (type === undefined && dict.get(PDFName.of('Contents')) !== undefined);
    const at = inFile.length;
    if (looksLikePage) inFile.push({ ref: entry, passed });
    if (!(kids instanceof PDFArray)) return;
    const down = { ...passed };
    for (const k of INHERITED) {
      const v = dict.get(PDFName.of(k));
      if (v !== undefined) down[k] = v;
    }
    const path = new Set(above).add(dict);
    for (const kid of kids.asArray()) walk(kid, down, path);
    // One that holds pages is a node, whatever it says it is; unless the screen showed it
    // as a page, when it stays one.
    if (looksLikePage && inFile.length > at + 1 && !onScreen.has(key(entry))) inFile.splice(at, 1);
    if (!looksLikePage || inFile[at] === undefined || inFile[at].ref !== entry) nodes.add(entry);
  };
  walk(doc.catalog.get(PDFName.of('Pages')), {}, new Set());

  const hidden = [];
  const after = new Map(); // shown page -> hidden pages that follow it in the file
  let anchor = null;
  const taken = new Set();
  for (const { ref, passed } of inFile) {
    const k = key(ref);
    if (onScreen.has(k)) {
      anchor = k;
      continue;
    }
    if (taken.has(k)) continue;
    taken.add(k);
    hidden.push({ ref, passed });
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor).push(ref);
  }

  const same = (list) => list && list.length === shown.refs.length && list.every((r, i) => r === shown.refs[i]);
  const twice = new Set(shown.refs).size !== shown.refs.length;
  // A page that also has a list of pages under it (empty, or holding something else) is
  // read as a page by both, but a program that checks the tree takes it for a node.
  const listing = shown.refs.some((k) => {
    const [num, gen] = k.split(' ').map(Number);
    const page = docCtxt.lookup(PDFRef.of(num, gen));
    return page instanceof PDFDict && page.get(PDFName.of('Kids')) !== undefined;
  });
  if (!hidden.length && !twice && !listing && shown.refs.length === shown.count && same(own)) return none;

  const refOf = (k) => {
    const [num, gen] = k.split(' ').map(Number);
    return PDFRef.of(num, gen);
  };
  const order = [...(after.get(null) || [])];
  const placed = new Set();
  for (const k of shown.refs) {
    order.push(refOf(k));
    if (placed.has(k)) continue;
    placed.add(k);
    for (const hiddenRef of after.get(k) || []) order.push(hiddenRef);
  }

  // What each page inherits, read before anything moves, exactly as pdf.js reads it: up the
  // page's /Parent, from the page itself; the nearest value wins, and resources are joined
  // key by key, the nearest first. A page the screen did not show whose /Parent leads
  // nowhere takes what it met on the way down the tree instead.
  const passedOf = new Map(hidden.map((h) => [key(h.ref), h.passed]));
  const settle = new Map();
  for (const ref of order) {
    const k = key(ref);
    if (settle.has(k)) continue;
    const page = docCtxt.lookup(ref);
    const values = {};
    for (const name of INHERITED) {
      const found = [];
      let node = page;
      const up = new Set();
      while (node instanceof PDFDict && !up.has(node)) {
        up.add(node);
        const v = node.get(PDFName.of(name));
        if (v !== undefined) found.push(v);
        node = node.lookup(PDFName.of('Parent'));
      }
      if (!found.length) {
        const passed = passedOf.get(k);
        if (passed && passed[name] !== undefined && !(page.lookup(PDFName.of('Parent')) instanceof PDFDict)) values[name] = passed[name];
        continue;
      }
      const dicts = found.map((v) => docCtxt.lookup(v));
      if (found.length === 1 || !(dicts[0] instanceof PDFDict)) {
        if (page.get(PDFName.of(name)) === undefined) values[name] = found[0];
        continue;
      }
      // Several resource lists on the way up: joined into a new one, so a list other pages
      // share is not changed.
      const joined = new Map();
      for (const d of dicts) {
        if (!(d instanceof PDFDict)) continue;
        for (const [entry, value] of d.entries()) if (!joined.has(entry.toString())) joined.set(entry.toString(), [entry, value]);
      }
      const merged = docCtxt.obj({});
      for (const [entry, value] of joined.values()) merged.set(entry, value);
      values[name] = merged;
    }
    // Resources that are not a list at all draw as none on screen; written as an empty list,
    // so the page looks the same and the file is sound.
    const resources = values.Resources !== undefined ? values.Resources : page.get(PDFName.of('Resources'));
    if (resources !== undefined && !(docCtxt.lookup(resources) instanceof PDFDict)) values.Resources = docCtxt.obj({});
    settle.set(k, { page, values });
  }

  const rootRef = docCtxt.nextRef();
  for (const { page, values } of settle.values()) {
    for (const [name, v] of Object.entries(values)) page.set(PDFName.of(name), v);
    if (!page.get(PDFName.of('MediaBox'))) page.set(PDFName.of('MediaBox'), docCtxt.obj([0, 0, 612, 792]));
    if (!page.get(PDFName.of('Resources'))) page.set(PDFName.of('Resources'), docCtxt.obj({}));
    page.set(PDFName.of('Type'), PDFName.of('Page'));
    page.delete(PDFName.of('Kids'));
    page.delete(PDFName.of('Count'));
    page.set(PDFName.of('Parent'), rootRef);
  }
  // A page the screen showed twice stays twice, the second time as a copy of its own: one
  // page object listed twice is not a tree, and programs that check say so.
  const listed = new Set();
  const kids = order.map((ref) => {
    if (!listed.has(key(ref))) {
      listed.add(key(ref));
      return ref;
    }
    const copy = docCtxt.lookup(ref).clone(docCtxt);
    const copyRef = docCtxt.register(copy);
    ownNotes(doc, copy, copyRef, [...settle.values()].map((v) => v.page));
    return copyRef;
  });
  docCtxt.assign(rootRef, docCtxt.obj({ Type: 'Pages', Kids: kids, Count: kids.length }));
  doc.catalog.set(PDFName.of('Pages'), rootRef);
  // The old tree's nodes are no longer used; they go, so nothing points the old way.
  for (const ref of nodes) if (!settle.has(key(ref))) docCtxt.delete(ref);
  // Read afresh, so the pages are read as pages, and written again; never with a page of
  // pdf-lib's own added to an empty-looking file.
  const again = await PDFDocument.load(await doc.save({ useObjectStreams: true, addDefaultPage: false }), { updateMetadata: false });
  await fs.writeFile(file, await again.save({ useObjectStreams: true, addDefaultPage: false }));
  return { changed: true, added: hidden.length, shownBefore: shown.opened };
}

// What belongs to the box that shows a form field on a page, rather than to the field;
// and which of the actions a box carries are the box's (the rest are the field's).
const BOX_KEYS = ['Type', 'Subtype', 'Rect', 'Contents', 'P', 'NM', 'M', 'F', 'AP', 'AS', 'Border', 'C', 'StructParent', 'OC', 'H', 'MK', 'A', 'BS', 'CA', 'ca', 'BM', 'Lang', 'AF'];
const BOX_ACTIONS = ['E', 'X', 'D', 'U', 'Fo', 'Bl', 'PO', 'PC', 'PV', 'PI'];

/**
 * A copy of a page gets notes, links and form boxes of its own, each pointing back to the
 * copy: an annotation sits on one page only. A form box on the copy is a second box of the
 * same field, so filling or flattening the form reaches both pages. A field written as one
 * object with its box keeps that object, so whatever names the field (the form's list,
 * the order of calculations, a reset button) still does; only the box moves into an object
 * of its own, on every page that lists it. The copy carries no accessibility tags (two
 * pages, or two boxes, may not share one entry).
 */
function ownNotes(doc, copy, copyRef, pages) {
  const ctxt = doc.context;
  copy.delete(PDFName.of('StructParents'));
  let annots = copy.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return;
  for (const entry of annots.asArray()) {
    const note = ctxt.lookup(entry);
    // A box that is a field itself: it has a name, or no field above it.
    if (entry instanceof PDFRef && note instanceof PDFDict && String(note.get(PDFName.of('Subtype'))) === '/Widget' && note.get(PDFName.of('Kids')) === undefined &&
      (note.get(PDFName.of('T')) !== undefined || !(note.lookup(PDFName.of('Parent')) instanceof PDFDict))) {
      splitBox(doc, entry, note, [...pages, copy]);
    }
  }
  annots = copy.lookup(PDFName.of('Annots'));
  const made = new Map();
  const fresh = annots.asArray().map((entry) => {
    const note = ctxt.lookup(entry);
    if (!(note instanceof PDFDict) || !(entry instanceof PDFRef)) return entry;
    const twin = note.clone(ctxt);
    twin.set(PDFName.of('P'), copyRef);
    twin.delete(PDFName.of('StructParent'));
    const twinRef = ctxt.register(twin);
    made.set(entry.toString(), twinRef);
    const field = note.get(PDFName.of('Parent'));
    if (String(note.get(PDFName.of('Subtype'))) === '/Widget' && note.get(PDFName.of('T')) === undefined && field instanceof PDFRef) {
      const holder = ctxt.lookup(field);
      const kids = holder instanceof PDFDict ? holder.lookup(PDFName.of('Kids')) : null;
      if (kids instanceof PDFArray) {
        // A button's list of export names has one entry per box; the twin repeats its box's.
        const names = holder.lookup(PDFName.of('Opt'));
        const at = kids.asArray().findIndex((k) => k.toString() === entry.toString());
        if (fieldType(holder) === '/Btn' && names instanceof PDFArray && names.size() === kids.size() && at >= 0) names.push(names.get(at));
        kids.push(twinRef);
      }
    }
    return twinRef;
  });
  // A note's pop-up, and the pop-up's note, point to their own twins; a pop-up the page
  // does not list is copied for the twin all the same.
  for (const twinRef of [...made.values()]) {
    const twin = ctxt.lookup(twinRef);
    for (const link of ['Popup', 'IRT']) {
      const to = twin.get(PDFName.of(link));
      if (to && made.has(to.toString())) twin.set(PDFName.of(link), made.get(to.toString()));
      else if (link === 'Popup' && to instanceof PDFRef && ctxt.lookup(to) instanceof PDFDict) {
        const popup = ctxt.lookup(to).clone(ctxt);
        popup.set(PDFName.of('P'), copyRef);
        popup.set(PDFName.of('Parent'), twinRef);
        twin.set(PDFName.of('Popup'), ctxt.register(popup));
      }
    }
    const parent = twin.get(PDFName.of('Parent'));
    if (String(twin.get(PDFName.of('Subtype'))) === '/Popup' && parent && made.has(parent.toString())) twin.set(PDFName.of('Parent'), made.get(parent.toString()));
  }
  copy.set(PDFName.of('Annots'), ctxt.obj(fresh));
}

/** A field's type, which it may take from a field above it. */
function fieldType(field) {
  const up = new Set();
  for (let node = field; node instanceof PDFDict && !up.has(node); node = node.lookup(PDFName.of('Parent'))) {
    up.add(node);
    const type = node.get(PDFName.of('FT'));
    if (type !== undefined) return String(type);
  }
  return '';
}

/**
 * Every tag that names an object (an annotation, say) in the file's accessibility tags, by
 * that object: read once per file, walking the tags without recursion, each list and tag
 * once, so a deep or looping tree costs no more than its size.
 */
const tagIndex = new WeakMap();
function tagsNaming(doc) {
  if (tagIndex.has(doc)) return tagIndex.get(doc);
  const ctxt = doc.context;
  const index = new Map();
  const seen = new Set();
  const stack = [doc.catalog.get(PDFName.of('StructTreeRoot'))];
  while (stack.length) {
    const node = stack.pop();
    const item = node instanceof PDFRef ? ctxt.lookup(node) : node;
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof PDFArray) {
      // One at a time: a list of tags can be longer than one call can take at once.
      for (const entry of item.asArray()) stack.push(entry);
      continue;
    }
    if (!(item instanceof PDFDict)) continue;
    if (String(item.get(PDFName.of('Type'))) === '/OBJR') {
      const obj = item.get(PDFName.of('Obj'));
      if (obj instanceof PDFRef) {
        if (!index.has(obj.toString())) index.set(obj.toString(), []);
        index.get(obj.toString()).push(item);
      }
      continue;
    }
    const kids = item.get(PDFName.of('K'));
    if (kids !== undefined) stack.push(kids);
  }
  tagIndex.set(doc, index);
  return index;
}

/**
 * A field written as one object with its box: the box's own entries move to a new object,
 * a box of the field, which takes the old one's place in every page's list of annotations.
 * The field keeps its object, its name, its value and its own actions.
 */
function splitBox(doc, ref, field, pages) {
  const ctxt = doc.context;
  const box = ctxt.obj({});
  for (const k of BOX_KEYS) {
    const v = field.get(PDFName.of(k));
    if (v === undefined) continue;
    box.set(PDFName.of(k), v);
    field.delete(PDFName.of(k));
  }
  const actions = field.lookup(PDFName.of('AA'));
  if (actions instanceof PDFDict) {
    const own = ctxt.obj({});
    const left = ctxt.obj({});
    for (const [k, v] of actions.entries()) (BOX_ACTIONS.includes(k.asString().slice(1)) ? own : left).set(k, v);
    if (own.entries().length) box.set(PDFName.of('AA'), own);
    if (left.entries().length) field.set(PDFName.of('AA'), left);
    else field.delete(PDFName.of('AA'));
  }
  // The tooltip is the field's, but a reader may look for it on the box: both have it.
  if (field.get(PDFName.of('TU')) !== undefined) box.set(PDFName.of('TU'), field.get(PDFName.of('TU')));
  box.set(PDFName.of('Parent'), ref);
  const boxRef = ctxt.register(box);
  field.set(PDFName.of('Kids'), ctxt.obj([boxRef]));
  // The accessibility tags named the box by the old object; they name the new box now.
  for (const objr of tagsNaming(doc).get(ref.toString()) || []) objr.set(PDFName.of('Obj'), boxRef);
  const seen = new Set();
  for (const page of pages) {
    const list = page.lookup(PDFName.of('Annots'));
    if (!(list instanceof PDFArray) || seen.has(list)) continue;
    seen.add(list);
    list.asArray().forEach((e, i) => {
      if (e instanceof PDFRef && e.toString() === ref.toString()) list.set(i, boxRef);
    });
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

/**
 * The pages pdf.js shows that it can open, as "number generation" of each (a slot it can
 * only show as an error is not a page), how many pages it opened (a page written straight
 * into a list has no number, but is a page), and how many slots it shows in all:
 * { refs, opened, count }. Null if pdf.js cannot open the file.
 */
async function pagesShown(file) {
  let reader;
  try {
    reader = await require('../pdf/text').open(file);
    const refs = [];
    let opened = 0;
    for (let i = 1; i <= reader.numPages; i++) {
      try {
        const { num, gen } = (await reader.getPage(i)).ref || {};
        opened++;
        if (Number.isInteger(num)) refs.push(`${num} ${gen || 0}`);
      } catch {
        // shown as an error in its place
      }
    }
    return { refs, opened, count: reader.numPages };
  } catch {
    return null;
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
