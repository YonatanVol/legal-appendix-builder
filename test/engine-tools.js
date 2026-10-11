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
const { PDFDocument, StandardFonts, rgb, PDFName, PDFRef } = require('pdf-lib');
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
    r = await runTool('repair', [file], {});
    const out = r.ok ? await PDFDocument.load(await fsp.readFile(r.display[0])) : null;
    const asShown = out ? await pagesAsShown(r.display[0], out) : { agree: false };
    const words = r.ok ? (await text.documentText(r.display[0])).map((w) => w.trim()) : [];
    // What the screen showed, then what only the tools found; a page neither showed (past
    // the count, without /Type) stays out, as both programs already agree on that file.
    const want = {
      // Both programs read the node as one blank page and agree; the pages under it are seen
      // by neither, so the file is not held back and Repair leaves it as both show it.
      'a node typed as a page, holding the real pages': [''],
      'a node listed under two parents': ['PAGE ONE', 'PAGE TWO', 'PAGE THREE'],
    }[label] || ['PAGE ONE', 'PAGE TWO', 'PAGE THREE'];
    if (/count too small/.test(label)) check('  (and the summary says a page the screen did not show was found and put at the end)', /נמצא בקובץ ונוסף בסופו/.test(r.summary || ''), r.summary);
    check(`  ${label}: after Repair both programs read the same pages, every one of them, none added`,
      asShown.agree && JSON.stringify(words) === JSON.stringify(want), r.error || `${words.join(' | ')} agree=${asShown.agree}`);
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
  await jobs.start(quick, [heavy.file], {}, { onProgress: (p) => said.push(p.text) }).promise;
  check('the tool\'s first message is shown, not swallowed after the check of the files', said.includes('הכלי התחיל'), JSON.stringify(said));

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
