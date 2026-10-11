'use strict';

/**
 * The page tools, run through the real job runner on PDFs generated here, and checked
 * by reading the results back: page order, sizes, rotation, crop boxes, and where the
 * stamped text actually sits on the page as shown.
 * Launch with:  npx electron test/page-tools.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { app } = require('electron');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const text = require('../src/main/pdf/text');
const { renderHtmlToPdf, disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

async function runTool(id, inputs, options) {
  const tool = tools.runnable(id);
  if (!tool) return { ok: false, error: `no tool ${id}` };
  return jobs.start(tool, inputs, options).promise;
}

/** Pages of distinct widths (500, 510, 520, ...) so order can be read back. */
async function makePdf(file, pages, { base = 500, rotate = 0, marks = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const w = base + i * 10;
    const page = doc.addPage([w, 800]);
    page.drawText(`P${i + 1}`, { x: 150, y: 400, size: 30, font });
    if (marks) {
      page.drawText('TOPMARK', { x: w / 2, y: 770, size: 10, font });
      page.drawText('LEFTMARK', { x: 8, y: 300, size: 10, font });
    }
    if (rotate) page.setRotation(degrees(rotate));
  }
  await fsp.writeFile(file, await doc.save());
  return file;
}

async function load(file) {
  return PDFDocument.load(await fsp.readFile(file));
}
const widths = async (file) => (await load(file)).getPages().map((p) => Math.round(p.getSize().width));
const rotations = async (file) => (await load(file)).getPages().map((p) => p.getRotation().angle);

/** Lines of a page as shown, with positions as fractions of the shown page. */
async function shownLines(file, pageNumber) {
  const doc = await text.open(file);
  try {
    const { lines, width, height } = await text.pageLines(doc, pageNumber);
    return lines.map((l) => ({ text: l.text, fx: l.x / width, fr: l.right / width, fy: l.y / height }));
  } finally {
    await doc.destroy();
  }
}

/** Every content stream of every page, decompressed, joined. */
async function contentOf(file, pageIndex = 0) {
  const doc = await load(file);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const refs = contents.size ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    const raw = stream.contents || stream.getContents();
    try {
      return zlib.inflateSync(Buffer.from(raw)).toString('latin1');
    } catch {
      return Buffer.from(raw).toString('latin1');
    }
  });
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'page-tools-'));
  const scratchRoot = path.join(os.tmpdir(), 'rotem-office');
  const scratchBefore = new Set(fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot) : []);
  const six = await makePdf(path.join(dir, 'שישה עמודים.pdf'), 6);
  const two = await makePdf(path.join(dir, 'other.pdf'), 2, { base: 700 });

  /* ---- split ---- */
  console.log('\nsplit');
  let r = await runTool('split', [six], { mode: 'ranges', ranges: '1-2, 3-5' });
  const folder = r.display && r.display[0];
  const parts = folder && fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
  check('ranges: one file per range, in a folder beside the source', r.ok && parts.length === 2 && path.dirname(folder) === dir, parts.join(' | '));
  check('  named so they sort in order and say their pages', /חלק 01 \(עמ' 1-2\)\.pdf$/.test(parts[0] || '') && /חלק 02 \(עמ' 3-5\)\.pdf$/.test(parts[1] || ''));
  check('  each with the right pages', parts.length === 2 &&
    (await widths(path.join(folder, parts[0]))).join() === '500,510' &&
    (await widths(path.join(folder, parts[1]))).join() === '520,530,540');

  r = await runTool('split', [six], { mode: 'ranges', ranges: '5-6, 1', mergeRanges: true });
  check('ranges merged into one file, in the order typed', r.ok && (await widths(r.display[0])).join() === '540,550,500', r.error);

  r = await runTool('split', [six], { mode: 'every', every: 4 });
  const every = r.ok ? fs.readdirSync(r.display[0]).sort() : [];
  check('every N pages: the last part takes what is left', every.length === 2 &&
    (await widths(path.join(r.display[0], every[1]))).join() === '540,550', every.join(' | '));

  r = await runTool('split', [six], { mode: 'extract', pages: '4, 2' });
  check('extract: chosen pages in document order, one file', r.ok && (await widths(r.display[0])).join() === '510,530', r.error);
  r = await runTool('split', [six], { mode: 'extract', pages: '2-3', extractEach: true });
  check('extract each page as its own file', r.ok && fs.readdirSync(r.display[0]).length === 2);

  r = await runTool('split', [six], { mode: 'ranges', ranges: '2-9' });
  check('a page that does not exist is refused, saying how many there are', !r.ok && /6 עמודים/.test(r.error), r.error);
  r = await runTool('split', [six], { mode: 'every', every: 6 });
  check('splitting every N >= length is refused with the reason', !r.ok && /שלם/.test(r.error), r.error);

  // Pages heavy enough that size matters: each carries its own noisy image.
  const heavy = await PDFDocument.create();
  for (let i = 0; i < 6; i++) {
    const page = heavy.addPage([600, 800]);
    const png = noisePng(220, 220, i);
    page.drawImage(await heavy.embedPng(png), { x: 50, y: 50, width: 500, height: 500 });
  }
  const heavyFile = path.join(dir, 'heavy.pdf');
  await fsp.writeFile(heavyFile, await heavy.save());
  const perPage = (await fsp.stat(heavyFile)).size / 6;
  const limitMb = (perPage * 2.5) / 1024 / 1024;
  r = await runTool('split', [heavyFile], { mode: 'size', maxMb: limitMb });
  const sized = r.ok ? fs.readdirSync(r.display[0]).map((n) => fs.statSync(path.join(r.display[0], n)).size) : [];
  check('by size: several parts, none over the limit', sized.length >= 3 && sized.every((s) => s <= limitMb * 1024 * 1024),
    `${sized.length} parts, limit ${Math.round(limitMb * 1024)} KB, sizes ${sized.map((s) => Math.round(s / 1024)).join(', ')} KB`);

  /* ---- organize ---- */
  console.log('\norganize');
  r = await runTool('organize', [six, two], {
    pages: [
      { f: 0, p: 5, r: 0 },
      { f: 1, p: 1, r: 0 },
      { blank: true, w: 300, h: 400 },
      { f: 0, p: 0, r: 1 },
      { f: 0, p: 2, r: 3 },
    ],
  });
  check('pages come out in the new order, with inserted and blank pages', r.ok && (await widths(r.display[0])).join() === '550,710,300,500,520', r.error);
  check('  turned pages carry their rotation', r.ok && (await rotations(r.display[0])).join() === '0,0,0,90,270');
  check('  and the summary says how many were removed', /3 עמודים הוסרו/.test(r.summary || ''), r.summary);
  r = await runTool('organize', [six], { pages: [{ f: 0, p: 9, r: 0 }] });
  check('a sequence that no longer matches the file is refused', !r.ok && /אינו תואם/.test(r.error), r.error);

  /* ---- rotate ---- */
  console.log('\nrotate');
  const tilted = await makePdf(path.join(dir, 'tilted.pdf'), 3, { rotate: 90 });
  r = await runTool('rotate', [six, tilted], { angle: 90 });
  check('every page of every file turns, adding to what was there', r.ok && r.display.length === 2 &&
    (await rotations(r.display[0])).every((a) => a === 90) && (await rotations(r.display[1])).every((a) => a === 180));
  r = await runTool('rotate', [six], { angle: 180, pages: '2, 4-5' });
  check('only the chosen pages turn', r.ok && (await rotations(r.display[0])).join() === '0,180,0,180,180,0');
  r = await runTool('rotate', [six, two], { angle: 90, pages: '1' });
  check('choosing pages across several files is refused', !r.ok && /קובץ אחד/.test(r.error), r.error);

  /* ---- crop ---- */
  console.log('\ncrop');
  for (const angle of [0, 90]) {
    const marked = await makePdf(path.join(dir, `marked-${angle}.pdf`), 1, { marks: true, rotate: angle });
    const beforeTop = (await shownLines(marked, 1)).find((l) => l.text === 'TOPMARK');
    r = await runTool('crop', [marked], { margins: { top: 0.12, right: 0, bottom: 0, left: 0.1 } });
    const after = r.ok ? await shownLines(r.display[0], 1) : [];
    const doc = r.ok ? await text.open(r.display[0]) : null;
    const vp = doc ? (await doc.getPage(1)).getViewport({ scale: 1 }) : null;
    if (doc) await doc.destroy();
    const fullW = angle ? 800 : 500;
    const fullH = angle ? 500 : 800;
    check(`page turned ${angle}: the shown page shrinks by the margins`, vp && Math.abs(vp.width - fullW * 0.9) < 1 && Math.abs(vp.height - fullH * 0.88) < 1,
      vp ? `${Math.round(vp.width)}x${Math.round(vp.height)}` : r.error);
    // Everything left inside the frame moves exactly as the margins say, in the page as
    // shown, whichever way the page is turned: this is what catches margins applied to
    // the wrong sides.
    const before = await shownLines(marked, 1);
    const inside = before.filter((l) => l.fx > 0.12 && l.fr < 0.98 && l.fy > 0.14 && l.fy < 0.98);
    const moves = inside.map((b) => {
      const a = after.find((l) => l.text === b.text);
      return a && Math.abs(a.fx - (b.fx - 0.1) / 0.9) < 0.02 && Math.abs(a.fy - (b.fy - 0.12) / 0.88) < 0.02;
    });
    check(`  page turned ${angle}: text inside the frame lands where the margins put it`, inside.length > 0 && moves.every(Boolean),
      `${inside.length} lines: ${inside.map((l) => l.text).join(', ')}`);
    if (angle === 0) {
      const top = after.find((l) => l.text === 'TOPMARK');
      const left = after.find((l) => l.text === 'LEFTMARK');
      const mid = after.find((l) => l.text === 'P1');
      check('  the cut is at the top and left as shown: those marks are now off the page',
        beforeTop && beforeTop.fy > 0 && (!top || top.fy < 0) && (!left || left.fr < 0.02), JSON.stringify({ top, left }));
      check('  and what is inside stays', mid && mid.fx > 0 && mid.fx < 1 && mid.fy > 0 && mid.fy < 1, JSON.stringify(mid));
    }
  }
  r = await runTool('crop', [six], { margins: { top: 0.5, bottom: 0.5 } });
  check('a crop that would leave nothing is refused', !r.ok && /גדול מדי/.test(r.error), r.error);

  /* ---- page numbers ---- */
  console.log('\npage numbers');
  const mixed = path.join(dir, 'mixed.pdf');
  {
    const doc = await PDFDocument.create();
    for (const angle of [0, 90, 180, 270]) doc.addPage([500, 800]).setRotation(degrees(angle));
    await fsp.writeFile(mixed, await doc.save());
  }
  r = await runTool('page-numbers', [mixed], { position: 'bottom-right', format: 'page-n-of', margin: 'normal' });
  check('the numbering runs', r.ok, r.error);
  for (let p = 1; p <= 4; p++) {
    const lines = r.ok ? await shownLines(r.display[0], p) : [];
    const line = lines.find((l) => l.text.includes('מתוך'));
    check(`page ${p} (turned ${(p - 1) * 90}): "עמוד ${p} מתוך 4" in reading order, at the bottom right as shown`,
      line && line.text === `עמוד ${p} מתוך 4` && line.fr > 0.85 && line.fy > 0.9,
      line ? `${line.text} at ${line.fr.toFixed(2)}, ${line.fy.toFixed(2)}` : lines.map((l) => l.text).join(' / '));
  }

  r = await runTool('page-numbers', [six], { position: 'top-left', format: 'n', pages: '2-', start: 1 });
  const p1 = r.ok ? await shownLines(r.display[0], 1) : [];
  const p2 = r.ok ? await shownLines(r.display[0], 2) : [];
  const n2 = p2.find((l) => l.text === '1');
  check('numbering can skip the first page and start at 1 on the second', r.ok && !p1.some((l) => /^\d+$/.test(l.text)) && n2, p2.map((l) => l.text).join(' / '));
  check('  placed at the top left', n2 && n2.fx < 0.15 && n2.fy < 0.1, n2 && `${n2.fx.toFixed(2)}, ${n2.fy.toFixed(2)}`);

  /* ---- watermark ---- */
  console.log('\nwatermark');
  r = await runTool('watermark', [six], { kind: 'text', text: 'טיוטה לעיון', opacity: 0.3, angle: 45 });
  const wm = r.ok ? await shownLines(r.display[0], 3) : [];
  check('the Hebrew text is on every page, in reading order', r.ok && wm.some((l) => l.text === 'טיוטה לעיון'), wm.map((l) => l.text).join(' / '));
  const wmDoc = r.ok ? await load(r.display[0]) : null;
  const gs = wmDoc ? String(wmDoc.getPage(0).node.Resources().lookup(require('pdf-lib').PDFName.of('ExtGState'))) : '';
  check('  drawn see-through', /\/ca 0\.3/.test(gs), gs.slice(0, 120));

  r = await runTool('watermark', [six], { kind: 'text', text: 'COPY', layer: 'under' });
  const streams = r.ok ? await contentOf(r.display[0], 0) : [];
  const wmAt = streams.findIndex((x) => / Do/.test(x));
  const textAt = streams.findIndex((x) => /\bBT\b/.test(x) && !/ Do/.test(x));
  check('under the content: the watermark is drawn before the page\'s own text', r.ok && wmAt === 0 && textAt > wmAt, `watermark in stream ${wmAt}, text in stream ${textAt}`);

  r = await runTool('watermark', [six], { kind: 'text', text: 'X', position: 'tile' });
  const tiles = r.ok ? (await contentOf(r.display[0], 0)).join('\n').match(/ Do/g) || [] : [];
  check('tiled: repeated across the page', tiles.length >= 6, `${tiles.length} copies`);

  const pngFile = path.join(dir, 'logo.png');
  await fsp.writeFile(pngFile, noisePng(40, 20, 7));
  r = await runTool('watermark', [six], { kind: 'image', image: pngFile, scale: 0.5 });
  check('an image watermark is placed', r.ok && (await contentOf(r.display[0], 0)).join('').includes(' Do'), r.error);
  r = await runTool('watermark', [six], { kind: 'image', image: path.join(dir, 'nothing.png') });
  check('a missing image is reported by name', !r.ok && /nothing\.png/.test(r.error), r.error);
  r = await runTool('watermark', [six], { kind: 'text', text: '  ' });
  check('empty text is refused', !r.ok && /כתוב/.test(r.error), r.error);

  /* ---- markdown ---- */
  console.log('\nPDF to Markdown');
  const mdSource = path.join(dir, 'מסמך.pdf');
  const html = `<!doctype html><html dir="rtl"><body style="font-family:Arial;font-size:12pt">
    <h1 style="font-size:28pt">כותרת ראשית</h1>
    <p>זו פסקה ראשונה של טקסט רגיל במסמך.</p>
    <p>פסקה שנייה, עם מספר 2026 ושם באנגלית Kalner.</p>
    <p>• פריט ראשון</p><p style="margin-top:-8pt">\uF0B7 פריט שני</p>
    <p>1. סעיף ממוספר</p>
    <p>מועד המצאת ההחלטה: 07/07/2026.</p>
    <p>נייד: 054-3074511</p>
  </body></html>`;
  await fsp.writeFile(mdSource, (await renderHtmlToPdf(html, { width: 595, height: 842 }, { top: 50, bottom: 50, left: 50, right: 50 })).bytes);
  r = await runTool('pdf-to-markdown', [mdSource], {});
  const md = r.ok ? await fsp.readFile(r.display[0], 'utf8') : '';
  check('a Markdown file is written beside the PDF', r.ok && r.display[0].endsWith('מסמך.md'), r.error || r.display);
  check('  the large line becomes a heading', /^# כותרת ראשית$/m.test(md), md.split('\n')[0]);
  check('  paragraphs stay whole and in reading order', /^זו פסקה ראשונה של טקסט רגיל במסמך\.$/m.test(md));
  check('  Latin words and numbers inside Hebrew keep their place', /^פסקה שנייה, עם מספר 2026 ושם באנגלית Kalner\.$/m.test(md), (md.match(/^פסקה שנייה.*$/m) || [''])[0]);
  check('  bullets become a list, including Word symbol bullets', /^- פריט ראשון\n- פריט שני$/m.test(md), JSON.stringify(md));
  check('  numbered lines stay numbered', /^1\. סעיף ממוספר$/m.test(md));
  check('  a colon stays with its Hebrew label and the full stop ends the sentence', /^מועד המצאת ההחלטה: 07\/07\/2026\.$/m.test(md), (md.match(/^מועד.*$/m) || [''])[0]);
  check('  a phone number keeps its order', /^נייד: 054-3074511$/m.test(md), (md.match(/^נייד.*$/m) || [''])[0]);

  const blank = path.join(dir, 'scan.pdf');
  {
    const doc = await PDFDocument.create();
    doc.addPage().drawRectangle({ x: 50, y: 50, width: 200, height: 300, color: rgb(0.5, 0.5, 0.5) });
    await fsp.writeFile(blank, await doc.save());
  }
  r = await runTool('pdf-to-markdown', [blank], {});
  check('a page with no text says to run OCR first', r.ok && /OCR/.test(r.summary), r.summary);

  /* ---- repair ---- */
  console.log('\nrepair');
  const good = await fsp.readFile(six);
  const broken = Buffer.from(good.toString('latin1').replace(/startxref\s+\d+/, 'startxref\n999999999'), 'latin1');
  const brokenFile = path.join(dir, 'broken.pdf');
  await fsp.writeFile(brokenFile, broken);
  r = await runTool('repair', [brokenFile], {});
  const fixed = r.ok ? await text.open(r.display[0]) : null;
  check('a file with a broken cross-reference is rebuilt', r.ok && fixed && fixed.numPages === 6, r.error);
  if (fixed) await fixed.destroy();
  check('  and the summary says it was damaged and how many pages came back', /פגום/.test(r.summary || '') && /6 עמודים שוחזרו/.test(r.summary || ''), r.summary);
  r = await runTool('repair', [six], {});
  check('a healthy file is rewritten, and the summary says nothing was wrong', r.ok && /לא נמצא פגם/.test(r.summary), r.summary);
  const junk = path.join(dir, 'junk.pdf');
  await fsp.writeFile(junk, '%PDF-1.4\n' + 'x'.repeat(500));
  r = await runTool('repair', [junk], {});
  check('a file with nothing recoverable says so', !r.ok && /junk\.pdf/.test(r.error), r.error);

  /* ---- every output is beside its source and nothing is left in the scratch area ---- */
  /* ---- a cancelled split removes only what it made ---- */
  console.log('\ncancelling a split');
  const theirs = path.join(dir, 'שישה עמודים - מפוצל');
  await fsp.mkdir(theirs, { recursive: true });
  await fsp.writeFile(path.join(theirs, 'someone else.pdf'), 'keep me');
  const foldersBefore = fs.readdirSync(dir).filter((n) => n.startsWith('שישה עמודים - מפוצל')).sort().join(' | ');
  let splitId = null;
  const splitting = jobs.start(tools.runnable('split'), [six], { mode: 'every', every: 1 }, {
    onProgress: (p) => { if (p.fraction > 0.3) jobs.cancel(splitId); },
  });
  splitId = splitting.id;
  const stopped = await splitting.promise;
  const folders = fs.readdirSync(dir).filter((n) => n.startsWith('שישה עמודים - מפוצל')).sort().join(' | ');
  check('a cancelled split removes the folder it made, and only that', stopped.cancelled && folders === foldersBefore, `${foldersBefore} -> ${folders}`);
  check('  and never touches a folder that was there before', fs.existsSync(path.join(theirs, 'someone else.pdf')));

  /* ---- two results claim different names ---- */
  const [x, y] = await Promise.all([runTool('rotate', [six], { angle: 90 }), runTool('rotate', [six], { angle: 180 })]);
  check('two runs at once never land on the same name', x.ok && y.ok && x.display[0] !== y.display[0] &&
    (await rotations(x.display[0]))[0] !== (await rotations(y.display[0]))[0], `${path.basename(x.display[0])} / ${path.basename(y.display[0])}`);

  /* ---- a re-saved file is a new document to the page ---- */
  const docs = require('../src/main/docs');
  const t1 = docs.register(six);
  await new Promise((res) => setTimeout(res, 20));
  await fsp.appendFile(six, '\n');
  const t2 = docs.register(six);
  check('a file saved again gets a new token, so its thumbnails are drawn afresh', t1 && t2 && t1 !== t2);
  check('only PDFs and pictures can be read back by the page', docs.register(path.join(dir, 'runs.txt')) === null &&
    docs.register(pngFile) !== null);

  const leftovers = (fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot) : []).filter((n) => !scratchBefore.has(n));
  check('no scratch folders are left behind', jobs.running() === 0 && leftovers.length === 0, leftovers.join(', '));
  // A folder a run left behind when the program was closed by force (it may hold a copy
  // of a document) is removed the next time the program starts.
  // A process number no program has (the largest there can be).
  const orphan = path.join(jobs.SCRATCH_ROOT, '4194304-left-by-a-crash');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'given.pdf'), 'a copy of a document');
  // One whose program is still running (this test's own parent) is another's work.
  const living = path.join(jobs.SCRATCH_ROOT, `${process.ppid}-still-running`);
  fs.mkdirSync(living, { recursive: true });
  const swept = await jobs.sweepLeftovers();
  check('a folder left by a run that never finished is removed at start', swept >= 1 && !fs.existsSync(orphan));
  check('  while a folder of a program still running is left alone', fs.existsSync(living));
  fs.rmSync(living, { recursive: true, force: true });

  disposeRenderer();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

/** A PNG of random grey noise, which does not compress, so its size is predictable. */
function noisePng(w, h, seed) {
  let s = seed * 9301 + 49297;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      s = (s * 9301 + 49297) % 233280;
      raw[y * (w * 3 + 1) + 1 + x] = Math.floor((s / 233280) * 256);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return crc ^ 0xffffffff;
}
