'use strict';

/**
 * Word, PowerPoint and Excel to PDF, and PDF to Word.
 *
 * On a Mac this runs the LibreOffice route; Microsoft Office's route is the same tool
 * with a PowerShell script in front, whose syntax the Windows workflow checks and whose
 * run is verified on an office PC (GitHub's machines have no Office).
 * Launch with:  npx electron test/office.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const { PDFDocument } = require('pdf-lib');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const text = require('../src/main/pdf/text');
const office = require('../src/main/engine/office');
const bin = require('../src/main/engine/binaries');
const { wordDocument } = require('../src/main/pdf/docx');
const { renderHtmlToPdf, disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}
const runTool = (id, inputs, options = {}) => jobs.start(tools.runnable(id), inputs, options).promise;
const allText = async (file) => (await text.documentText(file)).join('\n');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-'));
  const found = await office.detect();
  check('LibreOffice is found on this machine', !!found.libre, found.libre || 'not installed');

  /* ---- to PDF ---- */
  console.log('\nto PDF');
  const docx = path.join(dir, 'כתב תביעה.docx');
  await fsp.writeFile(docx, await wordDocument(['התובע מבקש מבית המשפט הנכבד לקבל את התביעה.\n\nסכום התביעה 12,500 ש"ח.']));
  let r = await runTool('word-to-pdf', [docx]);
  const pdf = r.ok && r.display[0];
  check('a Word document becomes a PDF beside it, named after it', r.ok && path.basename(pdf) === 'כתב תביעה.pdf', r.error || pdf);
  const wordText = pdf ? await allText(pdf) : '';
  check('  with its Hebrew text, in reading order', wordText.includes('התובע מבקש מבית המשפט הנכבד לקבל את התביעה.') && wordText.includes('12,500'), wordText.slice(0, 120));
  check('  and the summary names the program that converted it', /LibreOffice|Word/.test(r.summary || ''), r.summary);

  const xlsx = path.join(dir, 'הוצאות.xlsx');
  {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('תשלומים');
    sheet.views = [{ rightToLeft: true }];
    sheet.addRows([['תאריך', 'תיאור', 'סכום'], ['07/08/2026', 'שכר טרחה', 1250.5]]);
    await book.xlsx.writeFile(xlsx);
  }
  r = await runTool('excel-to-pdf', [xlsx]);
  const sheetText = r.ok ? await allText(r.display[0]) : '';
  check('a spreadsheet becomes a PDF with its cells', r.ok && sheetText.includes('שכר טרחה') && /1,?250\.5/.test(sheetText), r.error || sheetText.slice(0, 120));

  const pptx = path.join(dir, 'מצגת.pptx');
  {
    const deck = new PptxGenJS();
    deck.addSlide().addText('סיכום התיק', { x: 1, y: 1, w: 8, h: 1, fontSize: 32, rtlMode: true });
    deck.addSlide().addText('Next steps', { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
    await deck.writeFile({ fileName: pptx });
  }
  r = await runTool('ppt-to-pdf', [pptx]);
  const deckPdf = r.ok && r.display[0];
  const slides = deckPdf ? (await PDFDocument.load(await fsp.readFile(deckPdf))).getPageCount() : 0;
  check('a presentation becomes a PDF, one page per slide', r.ok && slides === 2 && (await allText(deckPdf)).includes('סיכום התיק'), r.error || `${slides} pages`);

  r = await runTool('word-to-pdf', [docx, path.join(dir, 'missing.docx')]);
  check('a file that is not there is reported, and nothing is left behind', !r.ok && !fs.existsSync(path.join(dir, 'כתב תביעה (2).pdf')), r.error);

  /* ---- PDF to Word ---- */
  console.log('\nPDF to Word');
  const source = path.join(dir, 'החלטה.pdf');
  await fsp.writeFile(source, (await renderHtmlToPdf(`<!doctype html><html dir="rtl"><body style="font-family:Arial;font-size:14pt">
    <h2>החלטה</h2><p>הוועדה דנה בערר והחליטה לקבל אותו בחלקו.</p><p>Case 4521</p></body></html>`,
  { width: 595, height: 842 }, { top: 60, bottom: 60, left: 60, right: 60 })).bytes);
  r = await runTool('pdf-to-word', [source]);
  const xml = r.ok ? execFileSync('tar', ['-xOf', r.display[0], 'word/document.xml'], { encoding: 'utf8' }).replace(/<[^>]+>/g, ' ') : '';
  check('a PDF with text becomes an editable Word document holding it', r.ok && /\.docx$/.test(r.display[0]) && xml.includes('הוועדה') && xml.includes('4521'), r.error || xml.slice(0, 150));
  check('  and the summary says it is editable and which program did it', /לערוך/.test(r.summary || ''), r.summary);

  const scan = path.join(dir, 'החלטה סרוקה.pdf');
  {
    const png = path.join(dir, 'page.png');
    execFileSync(bin.locate('gs'), ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pnggray', '-r200', '-sOutputFile=' + png, source]);
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(await fsp.readFile(png));
    doc.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    await fsp.writeFile(scan, await doc.save());
  }
  r = await runTool('pdf-to-word', [scan]);
  const scanXml = r.ok ? execFileSync('tar', ['-xOf', r.display[0], 'word/document.xml'], { encoding: 'utf8' }) : '';
  check('a scanned PDF is read with OCR and written to Word, right to left', r.ok && scanXml.includes('הוועדה דנה בערר') && /<w:bidi\/>|<w:bidi /.test(scanXml), r.error || scanXml.slice(0, 120));
  check('  and the summary says it was scanned and to check it', /סרוק/.test(r.summary || ''), r.summary);

  /* ---- with nothing to convert with ---- */
  console.log('\nwith no Office and no LibreOffice');
  office.reset({ office: new Set(), libre: null });
  const listed = await tools.list();
  const tile = listed.find((t) => t.id === 'word-to-pdf');
  check('the tiles say what to install, by name', !tile.available && /Word/.test(tile.reason) && /LibreOffice/.test(tile.reason), tile.reason);
  r = await runTool('word-to-pdf', [docx]);
  check('  and a run says the same instead of failing obscurely', !r.ok && /LibreOffice/.test(r.error), r.error);
  office.reset({ office: new Set(['word']), libre: found.libre });
  check('with Office present, its tools are available even without LibreOffice',
    (await tools.list()).find((t) => t.id === 'word-to-pdf').available);
  office.reset();

  console.log('\nthe Office scripts');
  for (const [name, body] of Object.entries(office.SCRIPTS)) {
    check(`the ${name} script closes its program whatever happens`, name === 'probe' || /finally \{[\s\S]*Quit\(\)/.test(body));
  }
  check('  and takes its paths from the environment, never the command line', Object.values(office.SCRIPTS).every((b) => !/\$args/.test(b)));

  disposeRenderer();
  require('../src/main/engine/ocr').shutdown();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
