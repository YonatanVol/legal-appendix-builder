'use strict';

const fs = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { PDFDocument } = require('pdf-lib');

const imaging = require('../engine/imaging');
const { SCANS_ROOT } = require('../engine/wia');
const { ocrFile } = require('./ocr');
const bin = require('../engine/binaries');

const A4 = { width: 595.28, height: 841.89 };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

/**
 * Scan to PDF: pictures of documents, from the office scanner or a phone, become one
 * clean PDF.
 *
 * options.mode        'gray' (default) | 'color' | 'bw'
 * options.enhance     stretch the contrast so faint print reads (default true)
 * options.straighten  turn a slightly crooked page level (default true)
 * options.pageSize    'a4' (default): each picture fitted on an A4 page; 'image': the
 *                     page takes the picture's own shape
 * options.ocr         make the result searchable (default true)
 *
 * The phone's own orientation is applied. Cropping a photo to the page's corners is
 * what the document scanner app does with its full pipeline; this tool does the
 * cleanup that a flatbed scan or a straight photo needs.
 */
async function run({ inputs, options = {}, ctx }) {
  const o = { mode: 'gray', enhance: true, straighten: true, pageSize: 'a4', ocr: true, ...options };
  const doc = await PDFDocument.create();
  let turned = 0;

  for (let i = 0; i < inputs.length; i++) {
    ctx.progress((i / inputs.length) * (o.ocr ? 0.5 : 0.95), `מעבד תמונה ${i + 1} מתוך ${inputs.length}`);
    const mime = MIME[path.extname(inputs[i]).toLowerCase()];
    if (!mime) throw new Error(`"${path.basename(inputs[i])}" אינה תמונה מסוג JPG או PNG.`);
    const bytes = await fs.readFile(inputs[i]);
    const out = await imaging.processScan(bytes, mime, { mode: o.mode, enhance: !!o.enhance, straighten: !!o.straighten });
    ctx.throwIfCancelled();
    if (Math.abs(out.angle) >= 0.25) turned++;
    // A copy: a small Buffer shares memory with others at an offset that pdf-lib ignores.
    const picture = new Uint8Array(out.bytes);
    const image = out.mime === 'image/png' ? await doc.embedPng(picture) : await doc.embedJpg(picture);
    const landscape = out.width > out.height;
    if (o.pageSize === 'image') {
      // 200 DPI is what phones and scanners deliver for a page; the page takes that size.
      const w = (out.width / 200) * 72;
      const h = (out.height / 200) * 72;
      doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    } else {
      const page = doc.addPage(landscape ? [A4.height, A4.width] : [A4.width, A4.height]);
      const { width: pw, height: ph } = page.getSize();
      const scale = Math.min(pw / out.width, ph / out.height);
      const w = out.width * scale;
      const h = out.height * scale;
      page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }

  let bytes = await doc.save({ useObjectStreams: true });
  let summaryOcr = '';
  if (o.ocr && bin.locate('gs')) {
    const temp = path.join(ctx.scratch, 'scan.pdf');
    await fs.writeFile(temp, bytes);
    const read = await ocrFile(temp, { langs: 'heb+eng' }, ctx, (fraction, label) => ctx.progress(0.5 + fraction * 0.48, label));
    if (read.bytes) bytes = read.bytes;
    summaryOcr = read.read ? ' הטקסט זוהה, ואפשר לחפש בו ולהעתיק ממנו.' : ' לא נמצא טקסט לזהות בתמונות.';
  }

  const fromScanner = inputs.every((p) => path.resolve(p).startsWith(path.resolve(SCANS_ROOT)));
  let outputPath;
  if (fromScanner) {
    // Pages from the scanner live in a temporary folder; the result goes where people look.
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `סריקה ${pad(stamp.getDate())}-${pad(stamp.getMonth() + 1)}-${stamp.getFullYear()} ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}`;
    outputPath = await ctx.writeOutput(bytes, { dir: path.join(app.getPath('documents'), 'סריקות'), name, ext: 'pdf' });
  } else {
    outputPath = await ctx.writeOutput(bytes, { source: inputs[0], label: inputs.length > 1 ? 'סריקה' : '', ext: 'pdf' });
  }
  const pages = inputs.length === 1 ? 'עמוד אחד' : `${inputs.length} עמודים`;
  const level = turned ? ` ${turned === 1 ? 'עמוד אחד יושר' : `${turned} עמודים יושרו`}.` : '';
  return { summary: `נוצר PDF בן ${pages}.${level}${summaryOcr}`, display: [outputPath] };
}

module.exports = { run };
