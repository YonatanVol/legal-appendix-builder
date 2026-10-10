'use strict';

/**
 * OCR, Scan to PDF, Redact and PDF to Excel, on documents made here: Hebrew pages
 * typeset by Chromium, then turned into "scans" by drawing them as pictures. Results
 * are read back independently: text with pdf.js, the spreadsheet with exceljs, the
 * Word file by its XML.
 * Launch with:  npx electron test/recognition.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { PDFDocument, PDFName, degrees } = require('pdf-lib');
const ExcelJS = require('exceljs');
const { openWindow } = require('./helpers/window');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const text = require('../src/main/pdf/text');
const bin = require('../src/main/engine/binaries');
const stamp = require('../src/main/pdf/stamp');
const runs = require('../src/main/runs');
const { registerIpc } = require('../src/main/ipc');
const { renderHtmlToPdf, disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

const runTool = (id, inputs, options = {}, hooks) => jobs.start(tools.runnable(id), inputs, options, hooks).promise;

// The second ID is written with eight digits, as people do when it starts with a zero.
const LETTER = `<h2>בית הדין האזורי לעבודה</h2>
  <p>המערער מבקש לקבל את הערעור על החלטת הוועדה מיום 07/07/2026.</p>
  <p>תעודת זהות 024624470, טלפון 054-3074511.</p>
  <p>Invoice number 4521 total 1,250.00</p>
  <p>ת.ז. של הנתבע 24624471</p>`;

async function vectorPdf(file, body, { pages = 1, style = 'font-family:Arial;font-size:16pt' } = {}) {
  const html = `<!doctype html><html dir="rtl"><body style="${style}">${Array.from({ length: pages }, () => `<section style="break-after:page">${body}</section>`).join('')}</body></html>`;
  await fsp.writeFile(file, (await renderHtmlToPdf(html, { width: 595, height: 842 }, { top: 60, bottom: 60, left: 60, right: 60 })).bytes);
  return file;
}

/** A page image of `source` at 200 DPI, as a scanner would make. */
function picture(source, out, page = 1) {
  execFileSync(bin.locate('gs'), ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pnggray', '-r200', `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${out}`, source]);
  return out;
}

/** A PDF holding only pictures of pages, each turned by `rotations[i]` but upright as shown. */
async function scannedPdf(file, png, rotations) {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(await fsp.readFile(png));
  for (const rot of rotations) {
    const page = doc.addPage(rot % 180 ? [842, 595] : [595, 842]);
    page.setRotation(degrees(rot));
    stamp.drawAt(page, { image, width: image.width, height: image.height }, { vx: 0, vy: 0, w: 595, h: 842 });
  }
  await fsp.writeFile(file, await doc.save());
  return file;
}

async function linesOf(file, page) {
  const doc = await text.open(file);
  try {
    return (await text.pageLines(doc, page)).lines.map((l) => l.text);
  } finally {
    await doc.destroy();
  }
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recognition-'));
  app.setPath('documents', path.join(dir, 'Documents'));
  runs.setStoreFile(path.join(dir, 'runs.json'));

  const vector = await vectorPdf(path.join(dir, 'מכתב.pdf'), LETTER);
  const png = picture(vector, path.join(dir, 'page.png'));

  /* ---- OCR ---- */
  console.log('\nOCR');
  const scan = await scannedPdf(path.join(dir, 'סריקה.pdf'), png, [0, 90, 270]);
  check('the "scan" has no text to begin with', (await linesOf(scan, 1)).length === 0);
  let r = await runTool('ocr', [scan], { langs: 'heb+eng', alsoWord: true, alsoText: true });
  const searchable = r.ok && r.display.find((p) => p.endsWith('.pdf'));
  check('OCR runs and says how many pages it read', r.ok && /3 עמודים זוהו/.test(r.summary), r.error || r.summary);
  for (const [n, rot] of [[1, 0], [2, 90], [3, 270]]) {
    const lines = searchable ? await linesOf(searchable, n) : [];
    check(`page ${n} (turned ${rot}): the Hebrew reads in order, with the date and numbers intact`,
      lines.includes('המערער מבקש לקבל את הערעור על החלטת הוועדה מיום 07/07/2026.') && lines.some((l) => l.includes('024624470')),
      lines.slice(0, 3).join(' / '));
  }
  check('  and English too, when asked for', searchable && (await linesOf(searchable, 1)).includes('Invoice number 4521 total 1,250.00'));
  const looks = searchable ? (await PDFDocument.load(await fsp.readFile(searchable))).getPage(1).getRotation().angle : -1;
  check('the pages themselves are unchanged: still turned as they were', looks === 90);
  const docx = r.ok && r.display.find((p) => p.endsWith('.docx'));
  const xml = docx ? execFileSync('tar', ['-xOf', docx, 'word/document.xml'], { encoding: 'utf8' }) : '';
  check('the Word file holds the text, set right to left', xml.includes('בית הדין האזורי לעבודה') && /<w:bidi\/>|<w:bidi /.test(xml) && /<w:rtl\/>|<w:rtl /.test(xml));
  const txt = r.ok && r.display.find((p) => p.endsWith('.txt'));
  check('the text file holds it too', txt && fs.readFileSync(txt, 'utf8').includes('תעודת זהות 024624470'));

  r = await runTool('ocr', [vector], {});
  check('a file that already has text is left alone, and says so', r.ok && r.display.length === 0 && /כבר יש טקסט/.test(r.summary), r.summary);

  const longScan = await scannedPdf(path.join(dir, 'ארוך.pdf'), png, [0, 0, 0, 0, 0, 0]);
  let jobId = null;
  const before = fs.readdirSync(dir).sort().join('|');
  const ocrJob = jobs.start(tools.runnable('ocr'), [longScan], {}, { onProgress: (p) => { if (/עמוד 2/.test(p.text)) jobs.cancel(jobId); } });
  jobId = ocrJob.id;
  const stopped = await ocrJob.promise;
  check('Esc in the middle of OCR stops it and leaves nothing behind', stopped.cancelled && fs.readdirSync(dir).sort().join('|') === before);
  r = await runTool('ocr', [scan], {});
  check('  and the next OCR still works', r.ok, r.error);

  /* ---- Scan to PDF ---- */
  console.log('\nScan to PDF');
  const crooked = await vectorPdf(path.join(dir, 'עקום.pdf'), `<div style="transform:rotate(-3deg);transform-origin:center;padding:40px">${LETTER}</div>`);
  const crookedPng = picture(crooked, path.join(dir, 'צילום עקום.png'));
  r = await runTool('scan', [crookedPng, png], { mode: 'bw', straighten: true, enhance: true, ocr: true });
  const scanned = r.ok && r.display[0];
  check('two pictures become one PDF beside the first', r.ok && path.dirname(scanned) === dir && (await PDFDocument.load(await fsp.readFile(scanned))).getPageCount() === 2, r.error);
  check('  the crooked page is straightened, and the summary says so', /עמוד אחד יושר/.test(r.summary || ''), r.summary);
  const scannedLines = scanned ? await linesOf(scanned, 1) : [];
  check('  and its text can be found after OCR', scannedLines.some((l) => l.includes('המערער מבקש לקבל את הערעור')), scannedLines.slice(0, 3).join(' / '));
  r = await runTool('scan', [path.join(dir, 'page.png')], { mode: 'color', ocr: false, pageSize: 'image' });
  const sized = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPage(0).getSize() : {};
  check('"as the picture" gives the page the picture\'s own shape', r.ok && Math.abs(sized.width - 595) < 3 && Math.abs(sized.height - 842) < 3, JSON.stringify(sized));

  const wia = require('../src/main/engine/wia');
  const fromScanner = path.join(wia.SCANS_ROOT, 'test-batch');
  await fsp.mkdir(fromScanner, { recursive: true });
  const scannerPage = path.join(fromScanner, 'page-001.png');
  await fsp.copyFile(png, scannerPage);
  r = await runTool('scan', [scannerPage], { ocr: false });
  check('pages from the scanner are saved to Documents\\סריקות, named by date', r.ok && path.dirname(r.display[0]) === path.join(dir, 'Documents', 'סריקות') && /סריקה \d\d-\d\d-\d{4}/.test(path.basename(r.display[0])), r.error || r.display[0]);
  await fsp.rm(fromScanner, { recursive: true, force: true });
  check('on this Mac the scanner says it is a Windows feature', !wia.available().available && /Windows/.test(wia.available().reason));

  /* ---- Redact ---- */
  console.log('\nRedact');
  const secret = await vectorPdf(path.join(dir, 'חסוי.pdf'), LETTER, { pages: 2 });
  {
    const d = await PDFDocument.load(await fsp.readFile(secret));
    d.setTitle('תיק של איתי ליבן');
    d.setAuthor('רון קלנר');
    await fsp.writeFile(secret, await d.save());
  }
  // The box of the line with the ID number on page 1, as the screen would mark it.
  const reader = await text.open(secret);
  const { lines, width, height } = await text.pageLines(reader, 1);
  await reader.destroy();
  const idLine = lines.find((l) => l.text.includes('024624470'));
  const mark = { page: 0, x: idLine.x / width - 0.01, y: (idLine.y - idLine.height) / height - 0.005, w: (idLine.right - idLine.x) / width + 0.02, h: (idLine.height * 1.4) / height };
  r = await runTool('redact', [secret], { marks: [mark], clean: true });
  const redacted = r.ok && r.display[0];
  const page1 = redacted ? (await text.documentText(redacted))[0] : '';
  check('the marked ID number is gone from the file itself', r.ok && !page1.includes('024624470') && !page1.includes('3074511') && page1 === '', r.error || page1);
  const p2 = redacted ? await linesOf(redacted, 2) : [];
  check('  the page without marks keeps its text', p2.some((l) => l.includes('024624470')));
  const rd = redacted ? await PDFDocument.load(await fsp.readFile(redacted), { updateMetadata: false }) : null;
  check('  the document\'s title and author are cleared', rd && !rd.getTitle() && !rd.getAuthor());
  check('  and the summary says the areas were deleted, not hidden', /נמחק/.test(r.summary || ''), r.summary);
  r = await runTool('redact', [secret], { marks: [mark], ocr: true });
  const reread = r.ok ? await linesOf(r.display[0], 1) : [];
  check('with OCR after, the rest of the redacted page is searchable and the ID still is not',
    reread.some((l) => l.includes('בית הדין האזורי')) && !reread.join(' ').includes('024624470'), r.error || reread.join(' / '));
  r = await runTool('redact', [secret], { marks: [] });
  check('nothing marked is refused, saying how to mark', !r.ok && /סמן/.test(r.error), r.error);

  /* ---- PDF to Excel ---- */
  console.log('\nPDF to Excel');
  const table = await vectorPdf(path.join(dir, 'טבלה.pdf'), `
    <p>דוח תשלומים לתיק 4521</p>
    <table style="border-collapse:collapse" cellpadding="6">
      <tr><td>תאריך</td><td style="padding-right:40px">תיאור</td><td style="padding-right:40px">סכום</td></tr>
      <tr><td>07/08/2026</td><td style="padding-right:40px">שכר טרחה</td><td style="padding-right:40px">1,250.50</td></tr>
      <tr><td>15/08/2026</td><td style="padding-right:40px">אגרה</td><td style="padding-right:40px">300</td></tr>
    </table>
    <p>סוף הדוח.</p>`, { style: 'font-family:Arial;font-size:13pt' });
  r = await runTool('pdf-to-excel', [table], {});
  const book = new ExcelJS.Workbook();
  if (r.ok) await book.xlsx.readFile(r.display[0]);
  const sheet = r.ok ? book.worksheets[0] : null;
  const row = (n) => (sheet ? [1, 2, 3].map((c) => sheet.getCell(n, c).value) : []);
  check('the spreadsheet is written and finds the table', r.ok && /טבלה אחת/.test(r.summary), r.error || r.summary);
  check('  the sheet reads right to left', sheet && sheet.views[0].rightToLeft === true);
  check('  the text above the table is in the first column', sheet && sheet.getCell(1, 1).value === 'דוח תשלומים לתיק 4521', JSON.stringify(row(1)));
  check('  the header row has its columns in Hebrew order', JSON.stringify(row(2)) === '["תאריך","תיאור","סכום"]', JSON.stringify(row(2)));
  check('  amounts become numbers, dates stay as written', JSON.stringify(row(3)) === '["07/08/2026","שכר טרחה",1250.5]' && row(4)[2] === 300, `${JSON.stringify(row(3))} ${JSON.stringify(row(4))}`);

  const english = await vectorPdf(path.join(dir, 'english.pdf'), `
    <table cellpadding="6" style="direction:ltr"><tr><td>Item</td><td style="padding-left:40px">Qty</td></tr><tr><td>Paper</td><td style="padding-left:40px">12</td></tr></table>`,
  { style: 'font-family:Arial;font-size:13pt;direction:ltr' });
  r = await runTool('pdf-to-excel', [english], {});
  const book2 = new ExcelJS.Workbook();
  if (r.ok) await book2.xlsx.readFile(r.display[0]);
  const s2 = r.ok ? book2.worksheets[0] : null;
  check('an English table reads left to right', s2 && !s2.views[0].rightToLeft && s2.getCell(1, 1).value === 'Item' && s2.getCell(2, 2).value === 12,
    s2 ? JSON.stringify([s2.getCell(1, 1).value, s2.getCell(1, 2).value, s2.getCell(2, 2).value]) : r.error);

  const scannedTable = await scannedPdf(path.join(dir, 'טבלה סרוקה.pdf'), picture(table, path.join(dir, 'table.png')), [0]);
  r = await runTool('pdf-to-excel', [scannedTable], {});
  const book3 = new ExcelJS.Workbook();
  if (r.ok) await book3.xlsx.readFile(r.display[0]);
  const s3 = r.ok ? book3.worksheets[0] : null;
  const s3text = s3 ? s3.getSheetValues().flat().filter(Boolean).join(' ') : '';
  check('a scanned table is read with OCR first, and the summary says to check the numbers', r.ok && /סרוק/.test(r.summary) && s3text.includes('שכר טרחה'), r.error || r.summary);

  /* ---- the Redact screen ---- */
  console.log('\nthe Redact screen');
  registerIpc();
  const win = await openWindow();
  const page = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page(code)) return true;
      await page('new Promise(r => setTimeout(r, 100))');
    }
    return false;
  };
  await page(`(async () => { const r = await window.api.describeFiles(${JSON.stringify([secret])}); window.shell.open('redact', { files: r.files }); })()`);
  await until(`document.querySelector('.redact-stage img')`);
  check('nothing marked: the button explains how', /סמן מה להשחיר/.test(await page(`document.getElementById('tool-blocked').textContent`)));
  await page(`[...document.querySelectorAll('.redact-presets .chip')].find(b => b.textContent === 'מספרי זהות').click()`);
  await until(`/נמצאו|נמצאה/.test(document.querySelector('.redact-found').textContent)`);
  const foundText = await page(`document.querySelector('.redact-found').textContent`);
  check('"ID numbers" finds both on each page, the nine-digit and the eight-digit one', /נמצאו 4 תוצאות/.test(foundText) && /2 עמודים/.test(foundText), foundText);
  check('  and shows them on the page before anything is marked', (await page(`document.querySelectorAll('.redact-stage .redact-hit').length`)) === 2);
  await page(`document.querySelector('.redact-bar .primary').click()`);
  const marks = await page(`window.shell.view.perTool.get('redact').options.marks`);
  check('"mark all" marks them', marks.length === 4 && marks.every((m) => m.w > 0.05 && m.w < 0.3), JSON.stringify(marks.map((m) => [m.page, m.x.toFixed(2), m.w.toFixed(2)])));
  const drawn = await page(`(() => {
    const stage = document.querySelector('.redact-stage');
    const r = stage.getBoundingClientRect();
    const o = (x, y) => ({ bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: r.left + r.width * x, clientY: r.top + r.height * y });
    stage.setPointerCapture = () => {};
    stage.dispatchEvent(new PointerEvent('pointerdown', o(0.1, 0.5)));
    stage.dispatchEvent(new PointerEvent('pointermove', o(0.4, 0.55)));
    stage.dispatchEvent(new PointerEvent('pointerup', o(0.4, 0.55)));
    return window.shell.view.perTool.get('redact').options.marks.length;
  })()`);
  check('dragging on the page adds a mark', drawn === 5);
  await page(`document.querySelector('.redact-stage .redact-mark:last-of-type').click()`);
  check('clicking a mark removes it', (await page(`window.shell.view.perTool.get('redact').options.marks.length`)) === 4);
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && !document.getElementById('tool-result').classList.contains('hidden')`, 60000);
  const out = await page(`document.querySelector('#tool-result-outputs .out-name').title`);
  const after = (await text.documentText(out)).join(' ');
  check('running it from the screen removes every ID number', !after.includes('024624470') && !after.includes('24624471'), after.slice(0, 120));
  check('no errors in the page console', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 3).join(' / '));

  require('../src/main/engine/ocr').shutdown();
  require('../src/main/engine/imaging').dispose();
  disposeRenderer();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
