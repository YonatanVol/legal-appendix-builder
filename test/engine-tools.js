'use strict';

/**
 * The tools that run qpdf and Ghostscript: Protect, Unlock, Compress, PDF/A, PDF to
 * JPG, PDF to PowerPoint and Repair. Every result is checked independently of the
 * tool that made it: encryption with qpdf and pdf.js, images by their bytes, the
 * presentation by its contents.
 * Launch with:  npx electron test/engine-tools.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, nativeImage } = require('electron');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFRef, PDFString, PDFDict } = require('pdf-lib');
const { openWindow } = require('./helpers/window');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const bin = require('../src/main/engine/binaries');
const runs = require('../src/main/runs');
const text = require('../src/main/pdf/text');
const { registerIpc } = require('../src/main/ipc');
const { renderHtmlToPdf, disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

const runTool = (id, inputs, options = {}) => jobs.start(tools.runnable(id), inputs, options).promise;
const qpdf = (...args) => {
  try {
    return { code: 0, out: execFileSync(bin.locate('qpdf'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
};

/** Page two listed twice, carrying a filled text field and a link; `merged` writes the
 *  field and its box as one object, as many real forms do. */
function listedTwiceWithForm(d, merged) {
  const form = d.getForm();
  const field = form.createTextField('name');
  field.setText('FIELDVAL');
  field.addToPage(d.getPage(1), { x: 60, y: 500, width: 200, height: 30 });
  if (merged) {
    const fieldRef = field.ref;
    const fieldDict = d.context.lookup(fieldRef);
    const boxRef = fieldDict.lookup(PDFName.of('Kids')).get(0);
    const box = d.context.lookup(boxRef);
    for (const [k, v] of fieldDict.entries()) if (!['Kids', 'Parent'].includes(k.asString().slice(1))) box.set(k, v);
    box.delete(PDFName.of('Parent'));
    const acro = d.catalog.lookup(PDFName.of('AcroForm'));
    const fields = acro.lookup(PDFName.of('Fields'));
    fields.set(fields.asArray().findIndex((e) => String(e) === String(fieldRef)), boxRef);
    d.context.delete(fieldRef);
    // Named elsewhere by its object (the order of calculations), with a field action (on a
    // key press) and a box action (on focus).
    acro.set(PDFName.of('CO'), d.context.obj([boxRef]));
    const js = (code) => d.context.obj({ S: 'JavaScript', JS: d.context.obj(code) });
    box.set(PDFName.of('AA'), d.context.obj({ K: js('1'), Fo: js('2') }));
    box.set(PDFName.of('TU'), PDFString.of('Tooltip text'));
    // Tagged for accessibility: a tag names the box by its object.
    const pageRef = d.getPage(1).ref;
    // The tag sits at the bottom of a chain ten thousand tags deep, under a list of tags
    // that lists itself: read without recursion, each once.
    let tag = d.context.register(d.context.obj({ Type: 'StructElem', S: 'Form', Pg: pageRef, K: { Type: 'OBJR', Obj: boxRef, Pg: pageRef } }));
    // Beside it, one tag whose list is longer than a single call can take at once.
    const wide = d.context.register(d.context.obj({ Type: 'StructElem', S: 'P', Pg: pageRef, K: d.context.obj(Array.from({ length: 150000 }, (_, i) => i)) }));
    tag = d.context.register(d.context.obj({ Type: 'StructElem', S: 'Div', K: [wide, tag] }));
    for (let i = 0; i < 10000; i++) tag = d.context.register(d.context.obj({ Type: 'StructElem', S: 'Div', K: tag }));
    const loopRef = d.context.nextRef();
    d.context.assign(loopRef, d.context.obj([loopRef, tag]));
    d.catalog.set(PDFName.of('StructTreeRoot'), d.context.register(d.context.obj({ Type: 'StructTreeRoot', K: loopRef })));
    if (merged === 'nameless') box.delete(PDFName.of('T'));
  }
  const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], Border: [0, 0, 0] }));
  d.getPage(1).node.addAnnot(link);
  const root = d.catalog.Pages();
  const kids = root.lookup(PDFName.of('Kids')).asArray();
  root.set(PDFName.of('Kids'), d.context.obj([kids[0], kids[1], kids[1], kids[2]]));
  root.set(PDFName.of('Count'), d.context.obj(4));
}

/** Page two listed twice, carrying a choice of two (radio buttons) with B chosen; without
 *  `named`, no list of options, as Acrobat writes them. */
function listedTwiceWithChoice(d, named, typeAbove) {
  const radio = d.getForm().createRadioGroup('side');
  radio.addOptionToPage('A', d.getPage(1), { x: 60, y: 500, width: 20, height: 20 });
  radio.addOptionToPage('B', d.getPage(1), { x: 100, y: 500, width: 20, height: 20 });
  radio.select('B');
  if (!named) radio.acroField.dict.delete(PDFName.of('Opt'));
  if (typeAbove) {
    // The group under a parent field that says what type of field it is.
    const group = radio.acroField.dict;
    const groupRef = radio.ref;
    const parent = d.context.register(d.context.obj({ T: PDFString.of('grp'), FT: 'Btn', Ff: group.get(PDFName.of('Ff')), Kids: [groupRef] }));
    group.set(PDFName.of('Parent'), parent);
    group.delete(PDFName.of('FT'));
    group.delete(PDFName.of('Ff'));
    const fields = d.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields'));
    fields.set(fields.asArray().findIndex((e) => String(e) === String(groupRef)), parent);
  }
  const root = d.catalog.Pages();
  const kids = root.lookup(PDFName.of('Kids')).asArray();
  root.set(PDFName.of('Kids'), d.context.obj([kids[0], kids[1], kids[1], kids[2]]));
  root.set(PDFName.of('Count'), d.context.obj(4));
}

/** What pdf.js shows of each page it can open: its words, and its turn and box. */
async function looks(file) {
  const reader = await text.open(file);
  const all = [];
  try {
    for (let i = 1; i <= reader.numPages; i++) {
      try {
        const page = await reader.getPage(i);
        const words = (await page.getTextContent()).items.map((t) => t.str).join('').trim();
        all.push({ text: words, look: `${page.rotate}|${page.view.join(',')}` });
      } catch {
        // shown as an error
      }
    }
  } finally {
    await reader.destroy().catch(() => {});
  }
  return all;
}

async function oddPdf(file) {
  // Three pages, the middle one not saying it is a page (no /Type): pdf.js counts three,
  // pdf-lib two.
  const { PDFName } = require('pdf-lib');
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const w of ['PAGE ONE', 'PAGE TWO', 'PAGE THREE']) d.addPage([595, 842]).drawText(w, { x: 60, y: 700, size: 18, font: f });
  d.getPage(1).node.delete(PDFName.of('Type'));
  await fsp.writeFile(file, await d.save());
  return file;
}

async function opens(file, password) {
  try {
    const doc = await text.open(file, { password });
    const n = doc.numPages;
    await doc.destroy();
    return n;
  } catch (err) {
    return err.name || 'error';
  }
}

async function hebrewPdf(file, pages = 2) {
  const body = Array.from({ length: pages }, (_, i) =>
    `<section style="break-after:page"><h1>כתב תביעה ${i + 1}</h1><p>התובע מבקש מבית המשפט הנכבד לקבל את התביעה.</p></section>`).join('');
  const html = `<!doctype html><html dir="rtl"><body style="font-family:Arial;font-size:13pt">${body}</body></html>`;
  await fsp.writeFile(file, (await renderHtmlToPdf(html, { width: 595, height: 842 }, { top: 60, bottom: 60, left: 60, right: 60 })).bytes);
  return file;
}

/** A page with a big smooth photo-like image, which compresses a lot when downsampled. */
async function heavyPdf(file) {
  const w = 1800;
  const h = 1800;
  const bitmap = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      bitmap[i] = (x * 255) / w;
      bitmap[i + 1] = (y * 255) / h;
      bitmap[i + 2] = ((x + y) * 7) % 256;
      bitmap[i + 3] = 255;
    }
  }
  const jpg = nativeImage.createFromBitmap(bitmap, { width: w, height: h }).toJPEG(95);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedJpg(jpg), { x: 50, y: 250, width: 495, height: 495 });
    page.drawText(`Exhibit page ${i + 1}`, { x: 50, y: 790, size: 20, font });
  }
  await fsp.writeFile(file, await doc.save());
  return { file, jpg };
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'engine-tools-'));
  runs.setStoreFile(path.join(dir, 'runs.json'));
  check('qpdf and Ghostscript are found', !!bin.locate('qpdf') && !!bin.locate('gs'), `${bin.locate('qpdf')} / ${bin.locate('gs')}`);

  const doc = await hebrewPdf(path.join(dir, 'כתב תביעה.pdf'), 3);

  /* ---- protect ---- */
  console.log('\nprotect');
  const seen = [];
  const realRun = bin.run;
  bin.run = (name, args, opts) => {
    seen.push(args.join(' '));
    return realRun(name, args, opts);
  };
  let r = await runTool('protect', [doc], { password: 'סוד-123 abc', allowPrint: false, allowCopy: false });
  const unlockedProbe = await runTool('unlock', [r.display[0]], { password: 'סוד-123 abc' });
  bin.run = realRun;
  check('the password never appears among the arguments qpdf is started with', seen.length >= 3 && unlockedProbe.ok && !seen.some((a) => a.includes('סוד-123')), seen.join(' | '));
  check('  and qpdf is given only plain names, not paths', !seen.some((a) => a.includes(path.sep)), seen.join(' | '));
  const locked = r.display && r.display[0];
  check('the file is written beside the source', r.ok && locked && path.dirname(locked) === dir, r.error);
  check('  it cannot be opened without the password', (await opens(locked)) === 'PasswordException');
  check('  it opens with the Hebrew password', (await opens(locked, 'סוד-123 abc')) === 3);
  const enc = qpdf('--show-encryption', '--password=סוד-123 abc', locked).out;
  check('  with AES-256', /AESv3|256/.test(enc), enc.split('\n').find((l) => /method/i.test(l)));
  check('  and printing and copying are not allowed', /print[^\n]*: not allowed/i.test(enc) && /extract for any purpose: not allowed/i.test(enc));
  check('  the summary says the restrictions depend on the reader, and to keep the password', /תוכנות קריאת PDF/.test(r.summary) && /במקום בטוח/.test(r.summary), r.summary);
  r = await runTool('protect', [locked], { password: 'x' });
  check('protecting a protected file is refused, saying what to do', !r.ok && /כבר מוגן/.test(r.error), r.error);
  r = await runTool('protect', [doc], { password: '' });
  check('an empty password is refused', !r.ok && /סיסמה/.test(r.error), r.error);

  /* ---- unlock ---- */
  console.log('\nunlock');
  r = await runTool('unlock', [locked], { password: 'wrong' });
  check('a wrong password says so plainly', !r.ok && /שגויה/.test(r.error), r.error);
  r = await runTool('unlock', [locked], {});
  check('no password for a locked file asks for it', !r.ok && /כתוב אותה/.test(r.error), r.error);
  r = await runTool('unlock', [locked], { password: 'סוד-123 abc' });
  check('the right password removes it', r.ok && qpdf('--requires-password', r.display[0]).code === 2 && (await opens(r.display[0])) === 3, r.error);
  r = await runTool('unlock', [doc], { password: 'x' });
  check('a file with no password says there is nothing to remove', !r.ok && /אינו מוגן/.test(r.error), r.error);
  const junkPdf = path.join(dir, 'junk.pdf');
  await fsp.writeFile(junkPdf, '%PDF-1.4\n' + 'x'.repeat(400));
  r = await runTool('unlock', [junkPdf], { password: 'x' });
  check('a damaged file is called damaged, not "not protected"', !r.ok && /פגום/.test(r.error), r.error);
  const ownerOnly = path.join(dir, 'owner-only.pdf');
  qpdf('--encrypt', '--user-password=', '--owner-password=boss', '--bits=256', '--print=none', '--', doc, ownerOnly);
  r = await runTool('unlock', [ownerOnly], {});
  check('restrictions without an opening password come off without one', r.ok && /ההגבלות/.test(r.summary) && qpdf('--requires-password', r.display[0]).code === 2, r.error || r.summary);

  // Files from banks and pension funds often keep their page index in a compressed section
  // that is itself encrypted, so it cannot be read before the password is given. Such a file
  // is protected, not damaged, and Unlock takes it (a real pension statement was called
  // damaged, 2026-10-18).
  const packed = {
    'the older encryption (RC4, revision 3)': ['--allow-weak-crypto', '--encrypt', 'pw-packed', 'owner-packed', '128', '--use-aes=n', '--'],
    'AES-256': ['--encrypt', 'pw-packed', 'owner-packed', '256', '--'],
  };
  const packedFiles = {};
  for (const [label, args] of Object.entries(packed)) {
    const file = path.join(dir, `נעול דחוס ${Object.keys(packedFiles).length + 1}.pdf`);
    qpdf('--object-streams=generate', ...args, doc, file);
    packedFiles[label] = file;
    // The file really is the case: pdf-lib cannot count its pages before the password.
    const counted = await PDFDocument.load(await fsp.readFile(file), { ignoreEncryption: true }).then((d) => d.getPageCount()).then(() => 'counted', () => 'cannot count');
    check(`  (${label}: the test file keeps its page index where pdf-lib cannot read it)`, counted === 'cannot count', counted);
    const listed = await require('../src/main/pdf/inspect').describe(file);
    check(`a locked file whose page index is compressed and encrypted (${label}) is listed as protected, not damaged`,
      listed.encrypted === true && /מוגן בסיסמה/.test(listed.error || '') && !/פגום/.test(listed.error || ''), JSON.stringify({ encrypted: listed.encrypted, error: listed.error }));
    r = await runTool('unlock', [file], { password: 'pw-packed' });
    const unlockedPages = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPageCount() : 0;
    check(`  and Unlock opens it with its password, every page there`, r.ok && unlockedPages === 3 && qpdf('--requires-password', r.display[0]).code === 2, r.error || `${unlockedPages} pages`);
  }

  /* ---- history never holds a password ---- */
  const saved = runs.withoutSecrets({ password: 'a', passwordConfirm: 'a', ownerPassword: 'b', forToken: 't', imageToken: 'u', allowPrint: false, pages: '3, 5' });
  check('passwords and session tokens are stripped before a run is recorded', JSON.stringify(saved) === '{"allowPrint":false,"pages":"3, 5"}', JSON.stringify(saved));

  /* ---- compress ---- */
  console.log('\ncompress');
  const heavy = await heavyPdf(path.join(dir, 'סריקה כבדה.pdf'));
  const heavySize = (await fsp.stat(heavy.file)).size;
  r = await runTool('compress', [heavy.file], { level: 'strong' });
  const small = r.display && r.display[0];
  const smallSize = small ? (await fsp.stat(small)).size : 0;
  check('a heavy file comes out much smaller', r.ok && smallSize > 0 && smallSize < heavySize * 0.5, `${Math.round(heavySize / 1024)} KB -> ${Math.round(smallSize / 1024)} KB`);
  check('  with the same pages and its text still text', small && (await opens(small)) === 2 && (await text.documentText(small))[0].includes('Exhibit page 1'));
  check('  and the summary gives both sizes', /←/.test(r.summary) && /קטן ב-\d+%/.test(r.summary), r.summary);
  // A file that has just been compressed at the strongest level has nothing left to give.
  r = await runTool('compress', [small], { level: 'light' });
  check('a file that is already compact is left alone, and the summary says so', r.ok && r.display.length === 0 && /כבר קטן/.test(r.summary), r.summary);

  /* ---- PDF/A ---- */
  console.log('\nPDF/A');
  r = await runTool('pdfa', [doc], { level: '2b' });
  const pdfa = r.display && r.display[0];
  const pdfaBytes = pdfa ? await fsp.readFile(pdfa) : Buffer.alloc(0);
  const latin = pdfaBytes.toString('latin1');
  check('the file declares PDF/A-2 in its metadata', r.ok && /pdfaid:part(>|=["'])2/.test(latin), r.error);
  check('  carries an sRGB output intent', /GTS_PDFA1/.test(latin) || /OutputIntents/.test(latin));
  check('  keeps its Hebrew text', pdfa && (await text.documentText(pdfa))[0].includes('כתב תביעה 1'));
  check('  and says honestly it was converted, not validated', /לא נבדקה/.test(r.summary), r.summary);
  r = await runTool('pdfa', [doc], { level: '1b' });
  check('PDF/A-1b declares part 1', r.ok && /pdfaid:part(>|=["'])1/.test((await fsp.readFile(r.display[0])).toString('latin1')), r.error);

  /* ---- PDF to JPG ---- */
  console.log('\nPDF to JPG');
  r = await runTool('pdf-to-jpg', [doc], { mode: 'pages', format: 'jpg', dpi: 72 });
  const folder = r.display && r.display[0];
  const jpgs = folder && fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
  check('each page becomes a JPG, in a folder, named by page', r.ok && jpgs.length === 3 && /עמ' 1\.jpg$/.test(jpgs[0]), jpgs.join(' | '));
  const first = jpgs[0] ? nativeImage.createFromPath(path.join(folder, jpgs[0])).getSize() : {};
  check('  at the chosen resolution (A4 at 72 DPI is 595 x 842)', Math.abs(first.width - 595) <= 2 && Math.abs(first.height - 842) <= 2, JSON.stringify(first));
  r = await runTool('pdf-to-jpg', [doc], { mode: 'pages', format: 'png', dpi: 150, pages: '2' });
  const one = r.display && r.display[0];
  check('one chosen page as PNG is written beside the source', r.ok && /עמ' 2\.png$/.test(one || '') && fs.readFileSync(one).subarray(1, 4).toString() === 'PNG', r.error || one);

  // A page with a crop box is drawn as shown: inside the box, never the area cut away.
  const cropped = await PDFDocument.create();
  const cropPage = cropped.addPage([595, 842]);
  cropPage.drawText('KEPT', { x: 150, y: 300, size: 24 });
  cropPage.setCropBox(100, 100, 300, 400);
  const croppedFile = path.join(dir, 'חתוך.pdf');
  await fsp.writeFile(croppedFile, await cropped.save());
  r = await runTool('pdf-to-jpg', [croppedFile], { mode: 'pages', format: 'png', dpi: 72 });
  const cropSize = r.ok ? nativeImage.createFromPath(r.display[0]).getSize() : {};
  check('a cropped page becomes a picture of the page as shown, inside its crop box (300 x 400 at 72 DPI)',
    Math.abs(cropSize.width - 300) <= 2 && Math.abs(cropSize.height - 400) <= 2, r.error || JSON.stringify(cropSize));

  r = await runTool('pdf-to-jpg', [heavy.file], { mode: 'images' });
  const imgs = r.ok && r.display[0] ? fs.readdirSync(r.display[0]) : [];
  const same = imgs.length ? fs.readFileSync(path.join(r.display[0], imgs.sort()[0])).equals(heavy.jpg) : false;
  check('the images inside come out byte for byte as they were put in', r.ok && imgs.length === 2 && same, r.error || imgs.join(' | '));
  r = await runTool('pdf-to-jpg', [doc], { mode: 'images' });
  check('a file with no images says so, and points to the other mode', r.ok && /לא נמצאו תמונות/.test(r.summary), r.summary);

  /* ---- PDF to PowerPoint ---- */
  console.log('\nPDF to PowerPoint');
  r = await runTool('pdf-to-ppt', [doc], {});
  const pptx = r.display && r.display[0];
  const entries = pptx ? execFileSync('tar', ['-tf', pptx], { encoding: 'utf8' }).split('\n') : [];
  check('a presentation with one slide per page', r.ok && /\.pptx$/.test(pptx) && entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e)).length === 3, r.error);
  check('  each slide carrying the page as a picture', entries.filter((e) => /^ppt\/media\/.+/.test(e)).length === 3);
  check('  and the summary says the text is not editable', /לא ניתן לעריכה/.test(r.summary), r.summary);

  /* ---- repair with qpdf ---- */
  console.log('\nrepair');
  const good = await fsp.readFile(doc);
  const broken = path.join(dir, 'שבור.pdf');
  await fsp.writeFile(broken, Buffer.from(good.toString('latin1').replace(/startxref\s+\d+/, 'startxref\n12'), 'latin1'));
  r = await runTool('repair', [broken], {});
  check('a broken file is rebuilt with every page', r.ok && (await opens(r.display[0])) === 3 && /פגום/.test(r.summary) && /3 עמודים שוחזרו/.test(r.summary), r.error || r.summary);
  check('  and keeps its text', r.ok && (await text.documentText(r.display[0]))[2].includes('כתב תביעה 3'));
  const truncated = path.join(dir, 'קטוע.pdf');
  await fsp.writeFile(truncated, good.subarray(0, Math.floor(good.length * 0.7)));
  r = await runTool('repair', [truncated], {});
  const recovered = r.ok ? await text.documentText(r.display[0]).catch(() => []) : [];
  check('a cut-off download is recovered as far as it goes: the result opens and holds the first page\'s text',
    r.ok && recovered.length >= 1 && recovered[0].includes('כתב תביעה 1'), r.error || `${recovered.length} pages: ${r.summary}`);
  const odd = await oddPdf(path.join(dir, 'עמוד בלי סוג.pdf'));
  r = await runTool('repair', [odd], {});
  const fixedCount = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPageCount() : 0;
  check('a page that does not say it is a page is marked as one, so every program counts all three',
    r.ok && fixedCount === 3 && /פגום/.test(r.summary) && (await text.documentText(r.display[0]))[1].includes('PAGE TWO'), r.error || `${fixedCount}: ${r.summary}`);
  // The other ways a page tree is read differently, each put right by Repair so that both
  // programs read the same pages: every page without /Type (Repair must not add a blank
  // page), a /Count too small, an entry leading nowhere, and a /Count that leaves out a
  // page without /Type at the end.
  const { pagesAsShown } = require('../src/main/pdf/inspect');
  const treeCases = {
    'every page without /Type': (d) => { for (const p of d.getPages()) p.node.delete(PDFName.of('Type')); },
    'a page count too small': (d) => d.catalog.Pages().set(PDFName.of('Count'), d.context.obj(2)),
    'an entry leading nowhere': (d) => d.catalog.Pages().lookup(PDFName.of('Kids')).push(PDFRef.of(9999)),
    'a loop back to the top of the tree': (d) => d.catalog.Pages().lookup(PDFName.of('Kids')).push(d.catalog.get(PDFName.of('Pages'))),
    'a page that also lists pages under it (an empty list)': (d) => d.getPage(1).node.set(PDFName.of('Kids'), d.context.obj([])),
    'the same count, but other pages (the first without /Type, the count one short)': (d) => {
      d.getPage(0).node.delete(PDFName.of('Type'));
      d.catalog.Pages().set(PDFName.of('Count'), d.context.obj(2));
    },
    'the top of the tree typed as a page': (d) => d.catalog.Pages().set(PDFName.of('Type'), PDFName.of('Page')),
    'a node typed as a page, holding the real pages': (d) => {
      const root = d.catalog.Pages();
      const kids = root.lookup(PDFName.of('Kids'));
      const node = d.context.obj({ Type: 'Page', Parent: d.catalog.get(PDFName.of('Pages')), Kids: kids.asArray(), Count: 3 });
      const nodeRef = d.context.register(node);
      for (const p of d.getPages()) p.node.set(PDFName.of('Parent'), nodeRef);
      root.set(PDFName.of('Kids'), d.context.obj([nodeRef]));
    },
    'a node listed under two parents': (d) => {
      const root = d.catalog.Pages();
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      const node = d.context.register(d.context.obj({ Type: 'Pages', Parent: d.catalog.get(PDFName.of('Pages')), Kids: [kids[1], kids[2]], Count: 2 }));
      root.set(PDFName.of('Kids'), d.context.obj([kids[0], node, node]));
      root.set(PDFName.of('Count'), d.context.obj(5));
    },
    'a node typed as a page, holding pages, under a count too small': (d) => {
      const root = d.catalog.Pages();
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      const node = d.context.register(d.context.obj({ Type: 'Page', Parent: d.catalog.get(PDFName.of('Pages')), Kids: [kids[1], kids[2]], Count: 2 }));
      for (const k of [kids[1], kids[2]]) d.context.lookup(k).set(PDFName.of('Parent'), node);
      root.set(PDFName.of('Kids'), d.context.obj([kids[0], node]));
      root.set(PDFName.of('Count'), d.context.obj(2));
    },
    'a node inside whose count leaves out its second page': (d) => {
      const root = d.catalog.Pages();
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      const node = d.context.register(d.context.obj({ Type: 'Pages', Parent: d.catalog.get(PDFName.of('Pages')), Kids: [kids[0], kids[1]], Count: 1 }));
      for (const k of [kids[0], kids[1]]) d.context.lookup(k).set(PDFName.of('Parent'), node);
      root.set(PDFName.of('Kids'), d.context.obj([node, kids[2]]));
      root.set(PDFName.of('Count'), d.context.obj(2));
    },
    // Read the same by both programs, but not sound: the page is kept twice, as the screen
    // shows it, the second time as a copy of its own.
    'a page listed twice': (d) => {
      const root = d.catalog.Pages();
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      root.set(PDFName.of('Kids'), d.context.obj([kids[0], kids[1], kids[1], kids[2]]));
      root.set(PDFName.of('Count'), d.context.obj(4));
    },
    // A page shown twice whose form field and link must come out on both copies, and stay
    // one field: filling or flattening the form reaches both.
    'a page listed twice, with a filled form field and a link': (d) => listedTwiceWithForm(d, false),
    'a page listed twice, with a form field written as one object with its box': (d) => listedTwiceWithForm(d, true),
    'a page listed twice, carrying a box that is a field without a name': (d) => listedTwiceWithForm(d, 'nameless'),
    // A choice of two (radio buttons, without a list of options, as Acrobat writes them) on
    // a page listed twice: the form still offers each choice once.
    'a page listed twice, with a choice of two': (d) => listedTwiceWithChoice(d, false),
    'a page listed twice, with a choice of two that names its options': (d) => listedTwiceWithChoice(d, true),
    'a page listed twice, with a named choice of two whose type is its parent field\'s': (d) => listedTwiceWithChoice(d, true, true),
    // Resources up the tree that are not a list draw as none; the repaired file must be sound.
    'resources up the tree that are not a list, and a count too small': (d) => {
      const root = d.catalog.Pages();
      const rootRef = d.catalog.get(PDFName.of('Pages'));
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      const two = d.context.lookup(kids[1]);
      root.set(PDFName.of('Resources'), two.get(PDFName.of('Resources')));
      two.delete(PDFName.of('Resources'));
      const node = d.context.register(d.context.obj({ Type: 'Pages', Parent: rootRef, Kids: [kids[1]], Count: 1, Resources: 5 }));
      two.set(PDFName.of('Parent'), node);
      root.set(PDFName.of('Kids'), d.context.obj([kids[0], node, kids[2]]));
      root.set(PDFName.of('Count'), d.context.obj(2));
    },
    'a page with a note listed under it': (d) => {
      const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10] }));
      d.getPage(1).node.set(PDFName.of('Kids'), d.context.obj([note]));
    },
    // Read the way the screen reads it: a page looks as its /Parent says, even when it sits
    // in the tree under a node that says otherwise.
    'a page whose look comes from its /Parent, not the node it sits under, and a count too small': (d) => {
      const root = d.catalog.Pages();
      const rootRef = d.catalog.get(PDFName.of('Pages'));
      const kids = root.lookup(PDFName.of('Kids')).asArray();
      d.context.lookup(kids[1]).delete(PDFName.of('MediaBox'));
      root.set(PDFName.of('MediaBox'), d.context.obj([0, 0, 595, 842]));
      const node = d.context.register(d.context.obj({ Type: 'Pages', Parent: rootRef, Kids: [kids[1]], Count: 1, Rotate: 90, MediaBox: [0, 0, 842, 595] }));
      root.set(PDFName.of('Kids'), d.context.obj([kids[0], node, kids[2]]));
      root.set(PDFName.of('Count'), d.context.obj(2));
    },
    // pdf.js joins a page's resources with its parents', key by key; the page must keep
    // drawing what it draws from its parent's list once the tree is flat. (A form, not a
    // font: pdf.js stands in a font of its own for a missing one, but leaves out a missing form.)
    'a page drawing a form its parent keeps, and a count too small': (d) => {
      const root = d.catalog.Pages();
      const page = d.getPage(1).node;
      const fontRef = page.Resources().lookup(PDFName.of('Font')).entries()[0][1];
      const form = d.context.register(d.context.stream('BT /F1 18 Tf 60 650 Td (FORMTEXT) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: fontRef } },
      }));
      root.set(PDFName.of('Resources'), d.context.obj({ XObject: { Fm9: form } }));
      page.addContentStream(d.context.register(d.context.stream('q /Fm9 Do Q')));
      // pdf.js joins whole keys only: the page's own (empty) list of forms would hide its parent's.
      page.Resources().delete(PDFName.of('XObject'));
      root.set(PDFName.of('Count'), d.context.obj(2));
    },
    'an entry pdf.js can only show as an error': (d) => {
      const junk = d.context.register(d.context.stream('junk'));
      d.catalog.Pages().lookup(PDFName.of('Kids')).push(junk);
      d.catalog.Pages().set(PDFName.of('Count'), d.context.obj(4));
    },
    'a count that leaves out a page without /Type': (d) => {
      const extra = d.addPage([595, 842]);
      extra.drawText('PAGE FOUR', { x: 60, y: 700, size: 18 });
      extra.node.delete(PDFName.of('Type'));
      d.catalog.Pages().set(PDFName.of('Count'), d.context.obj(3));
    },
  };
  for (const [label, spoil] of Object.entries(treeCases)) {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (const w of ['PAGE ONE', 'PAGE TWO', 'PAGE THREE']) d.addPage([595, 842]).drawText(w, { x: 60, y: 700, size: 18, font: f });
    spoil(d);
    const file = path.join(dir, `tree-${label.length}.pdf`);
    await fsp.writeFile(file, await d.save({ addDefaultPage: false }));
    if (/same count/.test(label)) {
      const before = await require('../src/main/pdf/inspect').describe(file);
      check('  (the same count, other pages: told apart by the pages themselves, not their number)',
        before.pageCount === before.shownPages && before.pagesAgree === false, JSON.stringify([before.pageCount, before.shownPages, before.pagesAgree]));
    }
    const lookBefore = await looks(file);
    r = await runTool('repair', [file], {});
    const out = r.ok ? await PDFDocument.load(await fsp.readFile(r.display[0])) : null;
    if (r.ok) {
      // Each page the screen showed looks after Repair as it did: same turn, same box.
      const lookAfter = await looks(r.display[0]);
      const changed = lookAfter.filter((a) => lookBefore.some((b) => b.text === a.text) && !lookBefore.some((b) => b.text === a.text && b.look === a.look));
      check(`  (${label}: every page the screen showed is turned and sized as it was)`, changed.length === 0, JSON.stringify({ before: lookBefore, changed }));
    }
    const asShown = out ? await pagesAsShown(r.display[0], out) : { agree: false };
    if (r.ok) {
      const checked = qpdf('--check', r.display[0]);
      check(`  (${label}: the repaired file passes qpdf's check of its structure)`, checked.code === 0, checked.out.split('\n').filter((l) => /ERROR|WARNING/.test(l)).join(' / '));
    }
    const words = r.ok ? (await text.documentText(r.display[0]).catch((e) => [`<unreadable: ${e.message}>`])).map((w) => w.trim()) : [];
    // Every page the screen showed, in its order, and after each the pages it had hidden
    // that follow it in the file. A node that says it is a page was shown as a blank page,
    // so a blank page it stays, with the pages it held after it.
    const want = {
      'a count that leaves out a page without /Type': ['PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR'],
      'a node typed as a page, holding the real pages': ['', 'PAGE ONE', 'PAGE TWO', 'PAGE THREE'],
      'a node typed as a page, holding pages, under a count too small': ['PAGE ONE', '', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, with a filled form field and a link': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, with a choice of two': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, with a choice of two that names its options': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, with a named choice of two whose type is its parent field\'s': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, carrying a box that is a field without a name': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page listed twice, with a form field written as one object with its box': ['PAGE ONE', 'PAGE TWO', 'PAGE TWO', 'PAGE THREE'],
      'a page drawing a form its parent keeps, and a count too small': ['PAGE ONE', 'PAGE TWO\nFORMTEXT', 'PAGE THREE'],
    }[label] || ['PAGE ONE', 'PAGE TWO', 'PAGE THREE'];
    const found = {
      'a page count too small': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'a node inside whose count leaves out its second page': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'a node typed as a page, holding the real pages': '3 עמודים שלא הוצגו במסך נמצאו בקובץ והוחזרו למקומם',
      'a node typed as a page, holding pages, under a count too small': '2 עמודים שלא הוצגו במסך נמצאו בקובץ והוחזרו למקומם',
      'the same count, but other pages (the first without /Type, the count one short)': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'resources up the tree that are not a list, and a count too small': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'a page whose look comes from its /Parent, not the node it sits under, and a count too small': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'a count that leaves out a page without /Type': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
      'a page drawing a form its parent keeps, and a count too small': 'עמוד אחד שלא הוצג במסך נמצא בקובץ והוחזר למקומו',
    }[label];
    if (!found) check(`  (${label}: the summary claims no page found that was not hidden)`, !/נמצא/.test((r.summary || '').replace('לא נמצא פגם', '')), r.summary);
    if (found) check('  (and the summary says how many pages the screen had not shown were put back in their place)', (r.summary || '').includes(found), r.summary);
    if (/choice of two/.test(label) && r.ok) {
      const read = await require('../src/main/tools/forms').readFields(r.display[0]);
      const inherited = /parent field/.test(label);
      const side = read.find((f) => f.name === (inherited ? 'grp.side' : 'side')) || {};
      const named = /names its options|named choice/.test(label);
      let namesFit = true;
      if (named) {
        // One export name per box, the copies' boxes named as their originals.
        const fixed = await PDFDocument.load(await fsp.readFile(r.display[0]));
        const group = fixed.getForm().getRadioGroup(inherited ? 'grp.side' : 'side').acroField.dict;
        const opt = group.lookup(PDFName.of('Opt'));
        namesFit = opt && opt.size() === group.lookup(PDFName.of('Kids')).size() && JSON.stringify(opt.asArray().map((o) => o.decodeText())) === '["A","B","A","B"]';
      }
      check(`  (${label}: offered once each, chosen as before, with its boxes on both pages${named ? ', each box with its export name' : ''})`,
        // (Without a list of options, its choices are named by their boxes' states, 0 and 1.)
        namesFit && read.length === 1 && (named ? JSON.stringify(side.choices) === '["A","B"]' : (side.choices || []).length === 2) && side.value === side.choices[1] && JSON.stringify([...new Set((side.boxes || []).map((b) => b.page))]) === '[1,2]',
        JSON.stringify(read));
    }
    if (/field without a name/.test(label) && r.ok) {
      // Filling the nameless field and flattening the form reaches both copies.
      const fixed = await PDFDocument.load(await fsp.readFile(r.display[0]));
      const form = fixed.getForm();
      const all = form.getFields();
      if (all.length === 1) all[0].setText('NEWVAL');
      form.flatten();
      const flat = path.join(dir, 'flat-nameless.pdf');
      await fsp.writeFile(flat, await fixed.save());
      const flatWords = (await text.documentText(flat)).map((w) => w.replace(/\s+/g, ' ').trim());
      check('  (a box that is a field without a name: still one field, and filling and flattening it reaches both copies)',
        all.length === 1 && /NEWVAL/.test(flatWords[1]) && /NEWVAL/.test(flatWords[2]), JSON.stringify({ fields: all.length, flatWords }));
    }
    if (/listed twice, with (a filled|a form)/.test(label) && r.ok) {
      // Each copy has its own link and form box, each pointing back to its own page; the
      // field is still one field, and flattening it draws its value on both copies.
      const fixed = await PDFDocument.load(await fsp.readFile(r.display[0]));
      const onPages = fixed.getPages().flatMap((p) => {
        const a = p.node.lookup(PDFName.of('Annots'));
        return a ? a.asArray().map((e) => ({ note: String(e), page: String(p.ref), says: fixed.context.lookup(e).get(PDFName.of('P')) })) : [];
      });
      // No note on two pages, and a note that names its page names its own.
      const own = new Set(onPages.map((n) => n.note)).size === onPages.length && onPages.every((n) => n.says === undefined || String(n.says) === n.page);
      const notes = fixed.getPages().map((p) => (p.node.lookup(PDFName.of('Annots')) || { size: () => 0 }).size());
      const form = fixed.getForm();
      const fields = form.getFields().map((f) => f.getName());
      if (/one object/.test(label)) {
        // The tooltip shows on both copies, and the tag names a box.
        const reader = await text.open(r.display[0]);
        const tips = [];
        for (const n of [2, 3]) tips.push(((await (await reader.getPage(n)).getAnnotations()).find((a) => a.subtype === 'Widget') || {}).alternativeText);
        await reader.destroy();
        let node = fixed.catalog.lookup(PDFName.of('StructTreeRoot')).lookup(PDFName.of('K')).lookup(1);
        while (String(node.get(PDFName.of('S'))) === '/Div') {
          const k = node.lookup(PDFName.of('K'));
          node = k instanceof PDFDict ? k : k.lookup(1);
        }
        const objr = node.lookup(PDFName.of('K'));
        const tagged = objr.get(PDFName.of('Obj'));
        const onItsPage = objr.lookup(PDFName.of('Pg')).lookup(PDFName.of('Annots')).asArray().some((e) => String(e) === String(tagged));
        check('  (the field\'s tooltip shows on both copies, and its accessibility tag names its box, on the tag\'s own page)',
          JSON.stringify(tips) === '["Tooltip text","Tooltip text"]' && String(fixed.context.lookup(tagged).get(PDFName.of('Subtype'))) === '/Widget' && onItsPage,
          JSON.stringify({ tips, tagged: String(fixed.context.lookup(tagged).get(PDFName.of('Subtype'))), onItsPage }));
        // The field keeps its object: the order of calculations still names the field, which
        // keeps its key-press action; each box keeps the focus action.
        const acro = fixed.catalog.lookup(PDFName.of('AcroForm'));
        const named = fixed.context.lookup(acro.lookup(PDFName.of('CO')).get(0));
        const fieldActs = named.lookup(PDFName.of('AA'));
        const boxes = fixed.getPages().flatMap((p) => (p.node.lookup(PDFName.of('Annots')) || { asArray: () => [] }).asArray())
          .map((e) => fixed.context.lookup(e)).filter((a) => String(a.get(PDFName.of('Subtype'))) === '/Widget');
        check('  (the field written as one object with its box keeps that object: the order of calculations and the key-press action stay with the field, the focus action with each box)',
          (named.lookup(PDFName.of('T')) || { decodeText: () => '' }).decodeText() === 'name' && fieldActs && fieldActs.get(PDFName.of('K')) && !fieldActs.get(PDFName.of('Fo')) &&
          boxes.length === 2 && boxes.every((b) => b.lookup(PDFName.of('AA')) && b.lookup(PDFName.of('AA')).get(PDFName.of('Fo')) && !b.lookup(PDFName.of('AA')).get(PDFName.of('K'))),
          JSON.stringify({ T: (named.lookup(PDFName.of('T')) || { decodeText: () => '' }).decodeText(), fieldActs: String(fieldActs), boxes: boxes.map((b) => String(b.get(PDFName.of('AA')))) }));
      }
      form.flatten();
      const flat = path.join(dir, `flat-${label.length}.pdf`);
      await fsp.writeFile(flat, await fixed.save());
      const flatWords = (await text.documentText(flat)).map((w) => w.replace(/\s+/g, ' ').trim());
      check(`  (${label}: both copies have their own link and form box, the form still has one field, and flattening draws its value on both)`,
        own && notes[1] === 2 && notes[2] === 2 && fields.join() === 'name' && /FIELDVAL/.test(flatWords[1]) && /FIELDVAL/.test(flatWords[2]),
        JSON.stringify({ own, notes, fields, flatWords }));
    }
    check(`  ${label}: after Repair both programs read the same pages, every one of them in order, none added, and none said to be lost`,
      asShown.agree && JSON.stringify(words) === JSON.stringify(want) && !/אבד/.test(r.summary || ''), r.error || `${words.join(' | ')} agree=${asShown.agree} ${r.summary}`);
  }
  // And a tool refuses such a file whichever way it is started, while Repair takes it.
  r = await runTool('compress', [odd], {});
  check('a tool started without the screen refuses such a file too, pointing to Repair', !r.ok && /תיקון PDF/.test(r.error || ''), r.error || 'made');
  r = await runTool('pdfa', [truncated], { level: '2b' });
  check('PDF/A refuses to hand over a copy with pages missing', !r.ok && /(עובדו|פגום|נפתח)/.test(r.error), r.ok ? r.summary : r.error);

  /* ---- the tool's first words reach the window ---- */
  // The files are checked before every tool, and that check says so on the bar. The tool's
  // own first message comes right after it, and must not be held back as too soon.
  const said = [];
  const quick = { id: 'quick-test', run: async ({ ctx }) => { ctx.progress(0.1, 'הכלי התחיל'); return { summary: 'ok' }; } };
  // A file the check passes over at once, so the tool's message surely comes within the
  // bar's pause after the check's own.
  const note = path.join(dir, 'הערה.txt');
  await fsp.writeFile(note, 'x');
  await jobs.start(quick, [note], {}, { onProgress: (p) => said.push(p.text) }).promise;
  check('the tool\'s first message is shown, not swallowed after the check of the files', said.includes('הכלי התחיל'), JSON.stringify(said));

  /* ---- a line handler that throws ---- */
  // Progress throws once Esc is pressed; a program's next line must not then escape as an
  // uncaught exception, which in the real program is an error box. The run fails instead.
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  const thrown = await bin.run('gs', ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=nullpage', doc], {
    onLine: (line) => { if (/^Page/.test(line)) throw new Error('stopped here'); },
  }).then(() => null, (e) => e);
  await new Promise((res) => setTimeout(res, 500));
  process.off('uncaughtException', onUncaught);
  check('a line handler that throws fails the run with its error, and nothing escapes uncaught', thrown && thrown.message === 'stopped here' && !uncaught, `${thrown && thrown.message} / uncaught: ${uncaught && uncaught.message}`);

  /* ---- one tool that fails its check ---- */
  const compressModule = require('../src/main/tools/compress');
  const realCheck = compressModule.availability;
  compressModule.availability = () => { throw new Error('probe failed'); };
  let grid = [];
  try {
    grid = await tools.list();
  } catch {
    grid = [];
  } finally {
    compressModule.availability = realCheck;
  }
  const brokenTile = grid.find((t) => t.id === 'compress') || {};
  check('a tool whose check throws is shown unavailable, and every other tile still shows',
    grid.length >= 30 && !brokenTile.available && !!brokenTile.reason && !!(grid.find((t) => t.id === 'merge') || {}).available, `${grid.length} tiles; ${brokenTile.reason}`);

  /* ---- cancelling stops the program ---- */
  console.log('\ncancelling');
  const beforeCancel = fs.readdirSync(dir).sort().join('|');
  // Cancelled the moment Ghostscript reports its first page, so it is surely still running.
  let jobId = null;
  const started = jobs.start(tools.runnable('compress'), [heavy.file], { level: 'light' }, { onProgress: () => jobs.cancel(jobId) });
  jobId = started.id;
  const cancelled = await started.promise;
  check('Esc during Ghostscript stops it and leaves nothing behind', cancelled.cancelled === true && fs.readdirSync(dir).sort().join('|') === beforeCancel, JSON.stringify({ c: cancelled.cancelled, ok: cancelled.ok, e: cancelled.error, extra: fs.readdirSync(dir).filter((n) => !beforeCancel.split('|').includes(n)) }));

  /* ---- a missing program is said, not hidden ---- */
  console.log('\nwhen a program is missing');
  bin.forget();
  process.env.OFFICE_NO_SYSTEM_SEARCH = '1';
  const hidden = bin.locate('gs');
  const listed = await tools.list();
  delete process.env.OFFICE_NO_SYSTEM_SEARCH;
  bin.forget();
  const compressTile = listed.find((t) => t.id === 'compress');
  check('with no Ghostscript, its tiles say which part is missing and that reinstalling brings it back',
    hidden === null && !compressTile.available && /Ghostscript/.test(compressTile.reason) && /התקנה מחדש/.test(compressTile.reason), compressTile.reason);

  /* ---- a Hebrew user name in the temporary folder ---- */
  console.log('\na Hebrew Windows user name');
  const hebrewTemp = path.join(dir, 'משתמש עברי', 'Temp');
  await fsp.mkdir(hebrewTemp, { recursive: true });
  const saveTmp = process.env.TMPDIR;
  process.env.TMPDIR = hebrewTemp;
  const hebTmpOk = os.tmpdir() === hebrewTemp;
  r = await runTool('pdfa', [doc], { level: '2b' });
  const r2 = await runTool('protect', [doc], { password: 'abc' });
  if (saveTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saveTmp;
  check('Ghostscript and qpdf work when the temporary folder has Hebrew in its path', hebTmpOk && r.ok && r2.ok, r.error || r2.error);

  /* ---- the screens ---- */
  console.log('\nthe screens');
  registerIpc();
  const win = await openWindow();
  const page = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page(code)) return true;
      await page('new Promise(r => setTimeout(r, 80))');
    }
    return false;
  };
  const openTool = async (id, files) => {
    await page(`window.shell.goHome()`);
    await page(`(async () => { const r = await window.api.describeFiles(${JSON.stringify(files)}); window.shell.open('${id}', { files: r.files }); })()`);
    await until(`document.body.dataset.screen === 'tool'`);
  };
  const typeInto = (index, value) => page(`(() => { const i = document.querySelectorAll('#tool-options input[type=password]')[${index}]; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const blocked = () => page(`document.getElementById('tool-blocked').textContent`);

  await openTool('protect', [doc]);
  await typeInto(0, 'abc');
  check('Protect: the button waits for the password to be typed twice', /פעם נוספת/.test(await blocked()), await blocked());
  await typeInto(1, 'abd');
  check('  and says when the two differ', /לא זהות/.test(await blocked()), await blocked());
  await typeInto(1, 'abc');
  check('  and runs when they match', (await blocked()) === '' && !(await page(`document.getElementById('tool-run').disabled`)));
  check('  the password is hidden until "show" is pressed', await page(`document.querySelector('#tool-options input').type === 'password'`));

  await openTool('compress', [doc]);
  const order = await page(`(() => {
    const note = [...document.querySelectorAll('#tool-options .opt-preview')].find(n => n.textContent.includes('MB'));
    const node = note.firstChild;
    const rect = (from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
    const t = node.textContent;
    const unit = t.indexOf('MB');
    const digit = t.search(/\\d/);
    return { unitLeft: rect(unit, unit + 2).left, digitRight: rect(digit, digit + 1).right };
  })()`);
  check('Compress: a size in a Hebrew sentence reads "0.1 MB", the unit to the right of the number', order.unitLeft >= order.digitRight - 1, JSON.stringify(order));

  await openTool('merge', [locked, doc]);
  check('Merge refuses a protected file and points to Unlock', /הסרת סיסמה/.test(await blocked()), await blocked());
  await openTool('unlock', [locked]);
  check('Unlock accepts the same file, listed as protected', (await blocked()) === '' &&
    (await page(`document.querySelector('#tool-file-list .file-meta').textContent`)).includes('מוגן בסיסמה') &&
    !(await page(`document.querySelector('#tool-file-list .file-row').classList.contains('bad')`)));

  // The pension statement's case on the screen: listed as protected, and the run goes ahead.
  await openTool('unlock', [packedFiles['the older encryption (RC4, revision 3)']]);
  check('Unlock accepts a locked file with a compressed, encrypted page index, listed as protected and runnable',
    (await blocked()) === '' && (await page(`document.querySelector('#tool-file-list .file-meta').textContent`)).includes('מוגן בסיסמה') &&
    !(await page(`document.querySelector('#tool-file-list .file-row').classList.contains('bad')`)), await page(`document.querySelector('#tool-file-list').textContent`));
  await openTool('unlock', [locked]);

  await page(`(() => { const i = document.querySelector('#tool-options input[type=password]'); i.value = 'סוד-123 abc'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && !document.getElementById('tool-result').classList.contains('hidden')`, 30000);
  const store = fs.existsSync(runs.storeFile()) ? fs.readFileSync(runs.storeFile(), 'utf8') : '';
  check('a run with a password is recorded without it', store.includes('"unlock"') && !store.includes('סוד-123'), store.slice(0, 200));
  check('no errors in the page console', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 3).join(' / '));

  disposeRenderer();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
