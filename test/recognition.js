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
const pagepicture = require('../src/main/engine/pagepicture');
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

/**
 * A PDF with a secret in every place a PDF can hide one: the page's text, the document
 * details (standard and custom), XMP, an attachment, an outline entry, the structure
 * tree's alternative text, a note on the other page, a link from the other page to the
 * secret one, and a picture shared through the page tree's resources.
 */
async function secretsPdf(file) {
  const { PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  p1.drawText('SECRET-ID-4711', { x: 60, y: 760, size: 18, font });
  p2.drawText('PUBLIC-PAGE-TWO', { x: 60, y: 760, size: 18, font });
  // A form drawn only on page 1, listed in resources every page inherits.
  const xobj = doc.context.stream('BT /F1 12 Tf 60 700 Td (SECRET-XOBJ) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: font.ref } },
  });
  const xref = doc.context.register(xobj);
  doc.catalog.lookup(PDFName.of('Pages')).set(PDFName.of('Resources'), doc.context.obj({ XObject: { Shared: xref }, Font: { F1: font.ref } }));
  p1.pushOperators(...[require('pdf-lib').pushGraphicsState(), require('pdf-lib').drawObject('Shared'), require('pdf-lib').popGraphicsState()]);
  doc.setTitle('SECRET-TITLE');
  doc.getInfoDict().set(PDFName.of('CaseNumber'), PDFString.of('SECRET-INFO'));
  const xmp = doc.context.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>SECRET-XMP</dc:title></x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
  await doc.attach(Buffer.from('SECRET-ATTACH'), 'notes.txt', { mimeType: 'text/plain' });
  const outline = doc.context.register(doc.context.obj({ Title: PDFString.of('SECRET-OUTLINE'), Dest: [p1.ref, PDFName.of('Fit')] }));
  doc.catalog.set(PDFName.of('Outlines'), doc.context.obj({ Type: 'Outlines', First: outline, Last: outline, Count: 1 }));
  const elem = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'P', Pg: p1.ref, ActualText: PDFString.of('SECRET-ALT') }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.obj({ Type: 'StructTreeRoot', K: [elem] }));
  const note = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 40, 40], Contents: PDFString.of('SECRET-NOTE') }));
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 600, 200, 620], Dest: [p1.ref, PDFName.of('Fit')] }));
  p2.node.set(PDFName.of('Annots'), doc.context.obj([note, link]));
  await fsp.writeFile(file, await doc.save({ useObjectStreams: false }));
  return file;
}

/** PDFs built the ways a redacted page's content could ride along on another page. */
async function leakCases(dir) {
  const { PDFDocument, StandardFonts, PDFName, PDFString } = require('pdf-lib');
  const out = [];
  {
    // Shared resources inherited from the page tree; a form used only by page 1; an
    // unused secret form inside a form page 2 does draw; a pattern holding another.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const form = (content, res) => ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: res }));
    const nested = form('BT /F1 12 Tf 50 600 Td (SECRET-NESTED) Tj ET', { Font: { F1: f.ref } });
    const inherited = form('BT /F1 12 Tf 50 600 Td (SECRET-INHERITED) Tj ET', { Font: { F1: f.ref } });
    const used = form('BT /F1 12 Tf 50 650 Td (PUBLIC-FORM) Tj ET', { Font: { F1: f.ref }, XObject: { Sx: nested } });
    const pattern = ctx.register(ctx.flateStream('0 0 10 10 re f', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: { XObject: { Sp: nested } } }));
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    d.catalog.Pages().set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, XObject: { Si: inherited, Cf: used }, Pattern: { P1: pattern } }));
    for (const p of [p0, p1]) p.node.delete(PDFName.of('Resources'));
    p0.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/Si Do')));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/Cf Do /Pattern cs /P1 scn 0 0 50 50 re f')));
    const file = path.join(dir, 'inherited.pdf');
    await fsp.writeFile(file, await d.save());
    out.push({ label: 'inherited, nested and pattern resources', file, clean: true, secrets: ['SECRET-INHERITED', 'SECRET-NESTED'], keep: 'PUBLIC-FORM' });
  }
  {
    // Damaged content on the page that is kept, with the secret inherited beside it.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const secret = ctx.register(ctx.flateStream('BT /F1 12 Tf 50 600 Td (SECRET-DAMAGED) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: { F1: f.ref } } }));
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    d.catalog.Pages().set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, XObject: { Si: secret } }));
    for (const p of [p0, p1]) p.node.delete(PDFName.of('Resources'));
    p0.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/Si Do')));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 12 Tf 50 600 Td (PUBLIC-KEPT) Tj ET (unterminated')));
    const file = path.join(dir, 'damaged.pdf');
    await fsp.writeFile(file, await d.save());
    out.push({ label: 'damaged content on the kept page', file, clean: true, secrets: ['SECRET-DAMAGED'], keep: 'PUBLIC-KEPT' });
  }
  {
    // Keeping annotations: a field with a box on both pages, and a reply to a note on
    // the redacted page.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-WIDGET-PAGE', { x: 50, y: 700, size: 14, font: f });
    p1.drawText('PUBLIC-ANNOTS', { x: 50, y: 700, size: 14, font: f });
    const field = d.getForm().createTextField('name');
    field.setText('x');
    field.addToPage(p0, { x: 50, y: 500 });
    field.addToPage(p1, { x: 50, y: 500 });
    const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], P: p0.ref, Contents: PDFString.of('SECRET-NOTE-ON-1') }));
    const old = p0.node.lookup(PDFName.of('Annots'));
    p0.node.set(PDFName.of('Annots'), d.context.obj([...(old ? old.asArray() : []), note]));
    const reply = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], IRT: note, Contents: PDFString.of('a public reply') }));
    const old1 = p1.node.lookup(PDFName.of('Annots'));
    p1.node.set(PDFName.of('Annots'), d.context.obj([...(old1 ? old1.asArray() : []), reply]));
    const file = path.join(dir, 'annots.pdf');
    await fsp.writeFile(file, await d.save());
    out.push({ label: 'kept annotations pointing back at the redacted page', file, clean: false, secrets: ['SECRET-WIDGET-PAGE', 'SECRET-NOTE-ON-1'], keep: 'PUBLIC-ANNOTS' });
  }
  {
    // Keeping comments: a note whose action jumps to the redacted page, a highlight
    // whose extra data and a square whose attachment both point at it.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-AA-PAGE', { x: 50, y: 700, size: 14, font: f });
    p1.drawText('PUBLIC-AA', { x: 50, y: 700, size: 14, font: f });
    const jump = ctx.obj({ S: 'GoTo', D: [p0.ref, PDFName.of('Fit')] });
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('PUBLIC-NOTE-KEPT'), AA: { O: jump } }));
    const mark = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [50, 690, 200, 720], QuadPoints: [50, 720, 200, 720, 50, 690, 200, 690], ExData: { Type: 'ExData', Subtype: 'Markup3D', Pg: p0.ref } }));
    const box = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [300, 300, 400, 400], FS: { Type: 'Filespec', F: PDFString.of('x'), Page: p0.ref } }));
    p1.node.set(PDFName.of('Annots'), ctx.obj([note, mark, box]));
    const file = path.join(dir, 'actions.pdf');
    await fsp.writeFile(file, await d.save());
    out.push({ label: 'kept comments whose action, data or attachment point at the redacted page', file, clean: false, secrets: ['SECRET-AA-PAGE'], keep: ['PUBLIC-AA', 'PUBLIC-NOTE-KEPT'] });
  }
  {
    // A layer the document keeps hidden, on the page that is kept.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-P0-LAYERS', { x: 50, y: 700, size: 14, font: f });
    const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('notes') }));
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
    p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, Properties: { L1: ocg } }));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 14 Tf 50 700 Td (PUBLIC-LAYERS) Tj ET /OC /L1 BDC BT /F1 14 Tf 50 650 Td (HIDDEN-OCG-P1) Tj ET EMC')));
    const file = path.join(dir, 'layers.pdf');
    await fsp.writeFile(file, await d.save());
    out.push({ label: 'a hidden layer on the kept page stays hidden', file, clean: true, secrets: ['SECRET-P0-LAYERS', 'HIDDEN-OCG-P1'], keep: 'PUBLIC-LAYERS' });
  }
  for (const clean of [true, false]) {
    // Layers that point at the redacted page: a listed layer with an extra key, the page
    // itself in the list, a usage entry, a layer named after what only that page holds,
    // and an unlisted layer used by the kept page.
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-LAYER-PAGE', { x: 50, y: 700, size: 14, font: f });
    const named = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('SECRET-LAYER-NAME'), Extra: p0.ref }));
    const loose = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('SECRET-LOOSE-NAME'), Extra: p0.ref }));
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [named, p0.ref], D: { Order: [named], AS: [{ Event: 'View', OCGs: [named], Category: ['View'], Page: p0.ref }] } }));
    p0.node.normalizedEntries().Resources.set(PDFName.of('Properties'), ctx.obj({ L0: named }));
    p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, Properties: { L1: loose } }));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/OC /L1 BDC BT /F1 14 Tf 50 700 Td (PUBLIC-LAYER-KEPT) Tj ET EMC')));
    const file = path.join(dir, `layers-point-${clean}.pdf`);
    await fsp.writeFile(file, await d.save());
    out.push({ label: `layers pointing at the redacted page, ${clean ? 'removing' : 'keeping'} comments`, file, clean, secrets: ['SECRET-LAYER-PAGE', 'SECRET-LAYER-NAME'], keep: 'PUBLIC-LAYER-KEPT' });
  }
  return out;
}

/**
 * Page 1 holds a secret; page 2 a filled text field with its drawing, a field whose form
 * asks viewers to draw it, a checked box, a stamp whose drawing sits away from the origin
 * (its BBox is offset, so a wrong placement shows), a hidden stamp and a comment.
 */
async function shownPdf(file) {
  const { PDFDocument, StandardFonts, PDFString } = require('pdf-lib');
  // pdf-lib keeps a page's Resources inline; the third page shares the second's below.
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const ctx = d.context;
  const p0 = d.addPage([595, 842]);
  const p1 = d.addPage([595, 842]);
  p0.drawText('SECRET-SHOWN-P0', { x: 50, y: 760, size: 14, font: f });
  p1.drawText('PUBLIC-SHOWN', { x: 50, y: 790, size: 14, font: f });
  const form = d.getForm();
  const filled = form.createTextField('filled');
  filled.addToPage(p1, { x: 50, y: 700, width: 250, height: 24 });
  filled.setText('FILLED-VALUE-P1');
  const box = form.createCheckBox('agree');
  box.addToPage(p1, { x: 50, y: 600, width: 30, height: 30 });
  box.check();
  const late = form.createTextField('late');
  late.addToPage(p1, { x: 320, y: 700, width: 220, height: 24 });
  late.setText('LATE-VALUE');
  form.updateFieldAppearances(f);
  // The second field loses its drawing and the form asks viewers to draw it.
  late.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), ctx.obj(true));
  const look = (body) => ctx.register(ctx.stream(body, { Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], Resources: { Font: { F1: f.ref } } }));
  const stampAp = look('0 g 100 100 100 50 re f 1 g BT /F1 10 Tf 105 120 Td (STAMP-P1) Tj ET');
  const hiddenAp = look('BT /F1 10 Tf 105 120 Td (HIDDEN-STAMP) Tj ET');
  const stampAnnot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 400, 400, 450], AP: { N: stampAp } }));
  const hidden = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 300, 400, 350], F: 2, AP: { N: hiddenAp } }));
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('a comment') }));
  // A password field the form leaves for viewers to draw: never drawn in the clear.
  const secret = form.createTextField('pin');
  secret.addToPage(p1, { x: 320, y: 600, width: 220, height: 24 });
  secret.enablePassword();
  secret.setText('PASSWORDPLAIN');
  secret.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
  // A hidden layer: a drawing placed whole on it, and a stamp whose drawing is on it.
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('internal') }));
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  const onLayer = ctx.register(ctx.stream('BT /F1 10 Tf 50 520 Td (OFFLAYERFORM) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], OC: ocg, Resources: { Font: { F1: f.ref } } }));
  const layerStampAp = ctx.register(ctx.stream('BT /F1 10 Tf 105 120 Td (OFFLAYERSTAMP) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], OC: ocg, Resources: { Font: { F1: f.ref } } }));
  const layerStamp = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 200, 400, 250], AP: { N: layerStampAp } }));
  p1.node.normalizedEntries().Resources.set(PDFName.of('XObject'), ctx.obj({ Hid: onLayer }));
  p1.node.addContentStream(ctx.register(ctx.stream('/Hid Do')));
  // A comment with its own drawing: removed with the comments, never burned into the page.
  const freeAp = look('BT /F1 10 Tf 105 120 Td (COMMENT-TEXT) Tj ET');
  const free = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [300, 100, 400, 150], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('COMMENT-TEXT'), AP: { N: freeAp } }));
  const annots = p1.node.lookup(PDFName.of('Annots'));
  p1.node.set(PDFName.of('Annots'), ctx.obj([...annots.asArray(), stampAnnot, hidden, note, layerStamp, free]));
  // A third page sharing the second's resources, with a stamp of its own.
  const p2 = d.addPage([595, 842]);
  const shared = ctx.register(p1.node.normalizedEntries().Resources);
  p1.node.set(PDFName.of('Resources'), shared);
  p2.node.set(PDFName.of('Resources'), shared);
  const twoAp = look('BT /F1 10 Tf 105 120 Td (STAMPTWO) Tj ET');
  p2.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 400, 400, 450], AP: { N: twoAp } }))]));
  await fsp.writeFile(file, await d.save({ updateFieldAppearances: false }));
  return file;
}

/**
 * Page 1 holds a secret. Page 2 has text typed onto it (a typewriter annotation), a
 * handwritten mark, a stamp, and markers under every kind of layer rule, ordinary and
 * odd (visibility expressions malformed, too short, self-containing, very deep or widely
 * shared; a layer named only in the hidden list); whether each shows is whatever pdf.js
 * shows on screen. Hidden content also sits inside a fill pattern, Type3 letters and a
 * soft mask. Page 3 shares page 2's list of contents.
 */
async function fidelityPdf(file) {
  const { PDFDocument, StandardFonts, PDFString, PDFRef, PDFNull } = require('pdf-lib');
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const ctx = d.context;
  const p0 = d.addPage([595, 842]);
  const p1 = d.addPage([595, 842]);
  const p2 = d.addPage([595, 842]);
  p0.drawText('SECRET-FIDELITY-P0', { x: 50, y: 760, size: 14, font: f });
  d.setTitle('KEPT-TITLE');
  const shownLayer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('shown') }));
  const offLayer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('off') }));
  const strayOff = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('stray') }));
  const viewOff = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('print only'), Usage: { View: { ViewState: 'OFF' } } }));
  const both = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('on and off') }));
  const layerList = ctx.obj([shownLayer, offLayer, viewOff, both]);
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: layerList, D: { ON: [both], OFF: [offLayer, strayOff, both] } }));
  const notShown = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('Not'), shownLayer] }));
  const andShown = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('And'), shownLayer] }));
  const form = (body, extra = {}) => ctx.register(ctx.stream(body, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: f.ref } }, ...extra }));
  const veForm = form('BT /F1 12 Tf 50 560 Td (OC-VE-FORM) Tj ET', { OC: notShown });
  const inPattern = form('BT /F1 12 Tf 2 2 Td (PATTERNHIDDEN) Tj ET', { OC: offLayer });
  const pattern = ctx.register(ctx.stream('/Hf Do', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 40], XStep: 200, YStep: 40, Resources: { XObject: { Hf: inPattern } } }));
  // A rule whose expression contains itself, four times over.
  const loop = ctx.register(ctx.obj([]));
  const loopArray = ctx.lookup(loop);
  for (const x of [PDFName.of('Or'), loop, loop, loop, loop]) loopArray.push(x);
  const cyclic = ctx.register(ctx.obj({ Type: 'OCMD', VE: loop }));
  const malformed = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('Xor'), shownLayer] }));
  const tooShort = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('And')] }));
  // Rules that contain themselves: [/Not self] and [/Or self shown]. And a chain of
  // 20,000 nested rules, deeper than any real file.
  const selfNot = ctx.register(ctx.obj([]));
  ctx.lookup(selfNot).push(PDFName.of('Not'));
  ctx.lookup(selfNot).push(selfNot);
  const selfOr = ctx.register(ctx.obj([]));
  for (const x of [PDFName.of('Or'), selfOr, shownLayer]) ctx.lookup(selfOr).push(x);
  let chain = shownLayer;
  for (let i = 0; i < 20000; i++) chain = ctx.register(ctx.obj([PDFName.of('Not'), chain]));
  // Forty levels of [/And x x] over one shown layer, only quick to work out when shared
  // parts are remembered (2^40 otherwise). And [/Not off shown], with an extra operand.
  let shared = shownLayer;
  for (let i = 0; i < 40; i++) shared = ctx.register(ctx.obj([PDFName.of('And'), shared, shared]));
  const memoRule = ctx.register(ctx.obj({ Type: 'OCMD', VE: shared }));
  const notTwo = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('Not'), offLayer, shownLayer] }));
  // Twelve levels of [/And x] over the hidden layer: pdf.js stops at ten and counts the
  // rest as shown. And an expression naming a layer pdf.js does not know.
  let twelve = offLayer;
  for (let i = 0; i < 12; i++) twelve = ctx.register(ctx.obj([PDFName.of('And'), twelve]));
  const pastTen = ctx.register(ctx.obj({ Type: 'OCMD', VE: twelve }));
  const unknownIn = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('And'), strayOff] }));
  // Values pdf.js resolves before reading: a rule whose /Type is a reference, a layer
  // switched off for viewing through references, a drawing whose /Subtype is a reference.
  const refType = ctx.register(PDFName.of('OCMD'));
  // (Added to the document's list of layers below.)
  const typeByRef = ctx.register(ctx.obj({ Type: refType, OCGs: [offLayer] }));
  const viewRef = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('view by ref'), Usage: { View: { ViewState: ctx.register(PDFName.of('OFF')) } } }));
  layerList.push(viewRef);
  const formSubtype = ctx.register(PDFName.of('Form'));
  // Drawings whose /OC pdf.js cannot read, which it leaves out: a number, null, an
  // array, a stream, a rule with null among its layers, and a name.
  const odd = (marker, oc, y) => [ctx.register(ctx.stream(`BT /F1 12 Tf 50 ${y} Td (${marker}) Tj ET`, { Type: 'XObject', Subtype: formSubtype, BBox: [0, 0, 595, 842], Resources: { Font: { F1: f.ref } }, OC: oc })), marker];
  const oddForms = [
    odd('OC-ODD-NUMBER', 5, 380), odd('OC-ODD-ARRAY', [offLayer], 360),
    odd('OC-ODD-STREAM', ctx.register(ctx.stream('x')), 350), odd('OC-ODD-NAME', PDFName.of('Ve'), 340),
    odd('OC-NAMED-SHOWN', PDFName.of('Vs'), 335),
    // Named only in a /Properties elsewhere (a font's), not where the drawing is drawn.
    odd('OC-NAMED-ELSEWHERE', PDFName.of('Zz'), 325),
    odd('OC-ODD-NULLMEMBER', ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [shownLayer, PDFNull], P: 'AnyOn' })), 330),
    odd('OC-SUBTYPE-REF', offLayer, 320),
  ];
  const nullMember = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [offLayer, PDFNull], P: 'AllOn' }));
  const notSelf = ctx.register(ctx.obj({ Type: 'OCMD', VE: selfNot }));
  const orSelf = ctx.register(ctx.obj({ Type: 'OCMD', VE: selfOr }));
  const deep = ctx.register(ctx.obj({ Type: 'OCMD', VE: chain }));
  // A Type3 font chosen through a graphics state rather than the font resources, whose
  // letter draws a drawing on a hidden layer and marked content on a hidden layer.
  const gsForm = form('BT /F1 12 Tf 0 30 Td (GSTHREEFORMHIDDEN) Tj ET', { OC: offLayer });
  const gsGlyph = ctx.register(ctx.stream('1000 0 d0 /OC /H BDC BT /F1 12 Tf 0 0 Td (GSTHREEMCHIDDEN) Tj ET EMC /Xg Do'));
  const gsType3 = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { a: gsGlyph }, Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('a')] }, FirstChar: 97, LastChar: 97, Widths: [1000],
    Resources: { Font: { F1: f.ref }, Properties: { H: offLayer }, XObject: { Xg: gsForm } },
  }));
  const singleOff = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: offLayer }));
  const singleOn = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: shownLayer }));
  // A Type3 font whose letter draws hidden marked content and a hidden drawing.
  const t3form = form('BT /F1 12 Tf 0 30 Td (TYPETHREEFORMHIDDEN) Tj ET', { OC: offLayer });
  const glyph = ctx.register(ctx.stream('1000 0 d0 /OC /H BDC BT /F1 12 Tf 0 0 Td (TYPETHREEMCHIDDEN) Tj ET EMC /Xh Do'));
  const type3 = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { a: glyph }, Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('a')] }, FirstChar: 97, LastChar: 97, Widths: [1000],
    Resources: { Font: { F1: f.ref }, Properties: { H: offLayer, Zz: shownLayer }, XObject: { Xh: t3form } },
  }));
  // A soft mask whose group draws a drawing on a hidden layer.
  const inMask = form('BT /F1 12 Tf 50 200 Td (SMASKHIDDEN) Tj ET', { OC: offLayer });
  const maskGroup = form('/Hm Do', { Group: { S: 'Transparency', CS: 'DeviceGray' }, Resources: { XObject: { Hm: inMask } } });
  const resources = ctx.register(ctx.obj({
    Font: { F1: f.ref, T3: type3 },
    Properties: { Ve: notShown, Vs: andShown, St: strayOff, Cy: cyclic, Mf: malformed, Ms: tooShort, Ns: notSelf, Os: orSelf, Dp: deep, Mm: memoRule, Nt: notTwo, Uv: viewOff, Bo: both, Pt: pastTen, Uk: unknownIn, Tr: typeByRef, Vr: viewRef, Nm: nullMember, So: singleOff, Sn: singleOn },
    XObject: { Vf: veForm, ...Object.fromEntries(oddForms.map(([form], k) => [`Od${k}`, form])) }, Pattern: { P1: pattern },
    ExtGState: { M1: { Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: maskGroup } }, G3: { Type: 'ExtGState', Font: [gsType3, 12] } },
  }));
  const body = ctx.register(ctx.stream([
    'BT /F1 14 Tf 50 790 Td (PUBLIC-FIDELITY) Tj ET',
    '/OC /Ve BDC BT /F1 12 Tf 50 600 Td (OC-VE-MARKED) Tj ET EMC',
    '/OC /Vs BDC BT /F1 12 Tf 50 620 Td (OC-VE-AND) Tj ET EMC',
    '/OC /St BDC BT /F1 12 Tf 50 580 Td (OC-UNLISTED) Tj ET EMC',
    '/Vf Do',
    '/OC /Cy BDC BT /F1 12 Tf 50 540 Td (OC-CYCLIC) Tj ET EMC',
    '/OC /Mf BDC BT /F1 12 Tf 50 520 Td (OC-MALFORMED) Tj ET EMC',
    '/OC /Ms BDC BT /F1 12 Tf 50 510 Td (OC-SHORTVE) Tj ET EMC',
    '/OC /Ns BDC BT /F1 12 Tf 50 470 Td (OC-NOTSELF) Tj ET EMC',
    '/OC /Mm BDC BT /F1 12 Tf 50 440 Td (OC-MEMO) Tj ET EMC',
    '/OC /Uv BDC BT /F1 12 Tf 50 420 Td (OC-USAGE-VIEWOFF) Tj ET EMC',
    '/OC /Bo BDC BT /F1 12 Tf 50 410 Td (OC-ONOFF) Tj ET EMC',
    '/OC /Pt BDC BT /F1 12 Tf 50 400 Td (OC-PASTTEN) Tj ET EMC',
    '/OC /Uk BDC BT /F1 12 Tf 50 390 Td (OC-UNKNOWNIN) Tj ET EMC',
    '/OC /Tr BDC BT /F1 12 Tf 50 310 Td (OC-TYPE-REF) Tj ET EMC',
    '/OC /Vr BDC BT /F1 12 Tf 50 300 Td (OC-VIEW-REF) Tj ET EMC',
    '/OC /Nm BDC BT /F1 12 Tf 50 290 Td (OC-NULLMEMBER-MARKED) Tj ET EMC',
    ...oddForms.map((_, k) => `/Od${k} Do`),
    '/OC /Nt BDC BT /F1 12 Tf 50 430 Td (OC-NOTTWO) Tj ET EMC',
    '/OC /Os BDC BT /F1 12 Tf 50 460 Td (OC-ORSELF) Tj ET EMC',
    '/OC /Dp BDC BT /F1 12 Tf 50 450 Td (OC-DEEPCHAIN) Tj ET EMC',
    'q /G3 gs BT 50 230 Td (a) Tj ET Q',
    '/OC /So BDC BT /F1 12 Tf 50 500 Td (OC-SINGLEREF-OFF) Tj ET EMC',
    '/OC /Sn BDC BT /F1 12 Tf 50 480 Td (OC-SINGLEREF-ON) Tj ET EMC',
    'BT /T3 12 Tf 50 250 Td (a) Tj ET',
    'q /M1 gs 0 0 1 rg 40 190 300 40 re f Q',
    // Last: pdf.js stops drawing the rest of a page after this pattern, on screen as in
    // the result, so nothing may come after it.
    '/Pattern cs /P1 scn 50 300 200 40 re f',
  ].join('\n'), { OC: offLayer }));
  // (The page's own content carries an /OC too, which viewers ignore: it must stay.)
  const sharedContents = ctx.register(ctx.obj([body]));
  for (const p of [p1, p2]) {
    p.node.set(PDFName.of('Resources'), resources);
    p.node.set(PDFName.of('Contents'), sharedContents);
  }
  const look = (text) => ctx.register(ctx.stream(`BT /F1 10 Tf 105 120 Td (${text}) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], Resources: { Font: { F1: f.ref } } }));
  const annot = (dict) => ctx.register(ctx.obj({ Type: 'Annot', ...dict }));
  p1.node.set(PDFName.of('Annots'), ctx.obj([
    annot({ Subtype: 'FreeText', IT: 'FreeTextTypeWriter', Rect: [50, 400, 250, 430], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('TYPED-ON-PAGE'), AP: { N: look('TYPED-ON-PAGE') } }),
    annot({ Subtype: 'Ink', Rect: [300, 400, 400, 450], InkList: [[300, 400, 400, 450]], AP: { N: look('INK-MARK') } }),
    annot({ Subtype: 'Stamp', Rect: [300, 200, 400, 250], AP: { N: look('STAMPONLYONE') } }),
    // A stamp whose /OC is a rule with null among its layers, which pdf.js leaves out; one
    // whose /OC is a number, which pdf.js ignores; and a stamp whose drawing carries a
    // hidden /OC, which pdf.js ignores for a drawing.
    annot({ Subtype: 'Stamp', Rect: [400, 600, 500, 650], OC: ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [shownLayer, PDFNull] })), AP: { N: look('OC-ANNOT-NULLMEMBER') } }),
    annot({ Subtype: 'Stamp', Rect: [400, 480, 500, 530], OC: 5, AP: { N: look('OC-ANNOT-NUMBER') } }),
    annot({ Subtype: 'Stamp', Rect: [400, 540, 500, 590], AP: { N: ctx.register(ctx.stream('BT /F1 10 Tf 105 120 Td (OC-AP-OWN-OC) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], OC: offLayer, Resources: { Font: { F1: f.ref } } })) } }),
    // A comment on a hidden layer, and one whose /OC is a rule pdf.js cannot read (it
    // leaves the comment out): never shown, so they never come across.
    annot({ Subtype: 'Text', Rect: [10, 10, 30, 30], OC: offLayer, Contents: PDFString.of('HIDDENCOMMENT') }),
    annot({ Subtype: 'Text', Rect: [40, 10, 60, 30], OC: ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [shownLayer, PDFNull] })), Contents: PDFString.of('NULLMEMBERCOMMENT') }),
    // Typed text with no drawing of its own, and typed text whose drawing is missing.
    annot({ Subtype: 'FreeText', IT: 'FreeTextTypeWriter', Rect: [50, 100, 250, 130], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('TYPEDNOAP') }),
    annot({ Subtype: 'FreeText', IT: 'FreeTextTypeWriter', Rect: [50, 60, 250, 90], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('TYPEDDANGLING'), AP: { N: PDFRef.of(99999) } }),
  ]));
  await fsp.writeFile(file, await d.save());
  return file;
}

/**
 * The words pdf.js shows on a page (1-based), as the screen draws it: the text of every
 * text operation that is not inside hidden optional content, annotations included.
 */
async function screenText(file, pageNo) {
  const lib = await text.pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await fsp.readFile(file)), isEvalSupported: false }).promise;
  try {
    const config = await doc.getOptionalContentConfig();
    const page = await doc.getPage(pageNo);
    const ops = await page.getOperatorList({ annotationMode: lib.AnnotationMode.ENABLE });
    const O = lib.OPS;
    const stack = [];
    const words = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === O.beginMarkedContentProps) stack.push(args[0] === 'OC' ? config.isVisible(args[1]) : true);
      else if (fn === O.beginMarkedContent) stack.push(true);
      else if (fn === O.endMarkedContent) stack.pop();
      else if (fn === O.showText && stack.every(Boolean)) {
        words.add(args[0].map((g) => (g && typeof g === 'object' ? g.unicode : '')).join(''));
      }
    }
    return words;
  } finally {
    await doc.destroy();
  }
}

/** Whether a page's text holds `value`, read independently with pdf.js. */
async function valueDrawn(file, page, value) {
  return (await linesOf(file, page)).join(' ').includes(value);
}

/**
 * How dark three areas of a page are, from 0 to 1, rendered at 72 DPI: the stamp's box
 * (300..400 by 400..450), the checkbox (50..80 by 600..630), and the area where the
 * stamp's drawing would land if it were not moved into its box (100..200 by 100..150).
 */
function darkIn(file, page, dir) {
  const out = path.join(dir, `dark-${Math.random().toString(36).slice(2)}.pgm`);
  execFileSync(bin.locate('gs'), ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pgmraw', '-r72', `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${out}`, file]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  // Ghostscript writes a comment line into the header.
  const header = buf.toString('latin1', 0, 200).match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/);
  const [width, height] = [Number(header[1]), Number(header[2])];
  const pixels = buf.subarray(header[0].length);
  const dark = (x0, x1, y0, y1) => {
    let n = 0;
    let black = 0;
    // Inset by two points so edges do not count.
    for (let y = height - y1 + 2; y < height - y0 - 2; y++) {
      for (let x = x0 + 2; x < x1 - 2; x++) {
        n++;
        if (pixels[y * width + x] < 128) black++;
      }
    }
    return Math.round((black / n) * 1000) / 1000;
  };
  return { stamp: dark(300, 400, 400, 450), check: dark(50, 80, 600, 630), origin: dark(100, 200, 100, 150) };
}

/**
 * A PDF written by hand, objects in the order given (the same number may appear twice),
 * with a table of objects pointing at the last copy of each, or the first for `firstOf`.
 */
function rawPdf(objs, { firstOf = [] } = {}) {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const at = {};
  for (const [num, body] of objs) {
    const offset = out.length;
    if (!(num in at) || !firstOf.includes(num)) at[num] = offset;
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const max = Math.max(...objs.map((o) => o[0]));
  const xref = out.length;
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) out += at[n] !== undefined ? `${String(at[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const rawStream = (t) => `<< /Length ${t.length} >>\nstream\n${t}\nendstream`;
const rawPage = (contents) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R >>`;

/** Three files pdf.js and qpdf read differently (built by review; see the test above). */
function crafted() {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const stream = (t, extra = '') => `<< /Length ${t.length}${extra} >>\nstream\n${t}\nendstream`;
  const txt = (w) => stream(`BT /F1 24 Tf 50 700 Td (${w}) Tj ET`);
  const page = (c) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 9 0 R >> >> /Contents ${c} >>`;
  const pad = (n) => String(n).padStart(10, '0');
  const HDR = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const table = (at, max) => {
    let t = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= max; n++) t += at[n] !== undefined ? `${pad(at[n])} 00000 n \n` : '0000000000 65535 f \n';
    return t;
  };
  const obj = (n, body) => `${n} 0 obj\n${body}\nendobj\n`;
  const cases = {};
  {
    const lin = (L) => obj(1, `<< /Linearized 1 /L ${pad(L)} /H [ 1 1 ] /O 4 /E 1 /N 2 /T 1 >>`);
    let s = HDR;
    const at = {};
    at[1] = s.length;
    s += lin(0);
    const firstXrefPos = s.length;
    const FIRSTLEN = table({}, 10).length + 'trailer\n<< /Size 11 /Root 3 0 R >>\n'.length;
    s += ' '.repeat(FIRSTLEN);
    for (const [n, b] of [[3, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>'],
      [4, page('7 0 R')], [5, page('8 0 R')], [7, txt('SECRETPAGEZERO')], [9, font]]) {
      at[n] = s.length;
      s += obj(n, b);
    }
    const pubAt = s.length;
    s += obj(8, txt('PUBLICTWO'));
    const secAt = s.length;
    s += obj(8, txt('SECRETPAGEZERO'));
    const first = table({ ...at, 8: pubAt }, 10) + 'trailer\n<< /Size 11 /Root 3 0 R >>\n';
    s = s.slice(0, firstXrefPos) + first + s.slice(firstXrefPos + FIRSTLEN);
    const mainPos = s.length;
    s += table({ ...at, 8: secAt }, 10) + `trailer\n<< /Size 11 /Root 3 0 R >>\nstartxref\n${mainPos}\n%%EOF\n`;
    cases['linearized, two tables'] = s.replace(lin(0), lin(s.length));
  }
  {
    const lin = (L) => obj(1, `<< /Linearized 1 /L ${pad(L)} /H [ 1 1 ] /O 6 /E 1 /N 2 /T 1 /P 1 >>`);
    let s = HDR;
    const at = {};
    at[1] = s.length;
    s += lin(0);
    for (const [n, b] of [[3, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>'],
      [4, page('7 0 R')], [5, page('7 0 R')], [6, page('8 0 R')], [7, txt('SECRETPAGEZERO')], [8, txt('PUBLICTWO')], [9, font]]) {
      at[n] = s.length;
      s += obj(n, b);
    }
    const x = s.length;
    s += table(at, 9) + `trailer\n<< /Size 10 /Root 3 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    cases['linearized, first page outside the tree'] = s.replace(lin(0), lin(s.length));
  }
  {
    let s = HDR;
    const off = {};
    for (const [n, b] of [[3, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>'],
      [4, page('10 0 R')], [5, page('11 0 R')], [7, txt('SECRETPAGEZERO')], [8, txt('PUBLICTWO')], [9, font]]) {
      off[n] = s.length;
      s += obj(n, b);
    }
    const o0 = '[7 0 R]';
    const o1 = '[8 0 R]';
    const head = `11 0 10 ${o0.length + 1} `;
    const data = head + o0 + ' ' + o1;
    off[12] = s.length;
    s += obj(12, stream(data, ` /Type /ObjStm /N 2 /First ${head.length}`));
    const rows = [];
    for (let n = 0; n <= 13; n++) {
      if (n === 10) rows.push([2, 12, 0]);
      else if (n === 11) rows.push([2, 12, 1]);
      else if (n === 13) rows.push([1, -1, 0]);
      else if (off[n] !== undefined) rows.push([1, off[n], 0]);
      else rows.push([0, 0, 65535]);
    }
    const xpos = s.length;
    rows[13][1] = xpos;
    const bin = Buffer.alloc(rows.length * 7);
    rows.forEach(([t, a, b], i) => {
      bin.writeUInt8(t, i * 7);
      bin.writeUInt32BE(a, i * 7 + 1);
      bin.writeUInt16BE(b, i * 7 + 5);
    });
    s += `13 0 obj\n<< /Type /XRef /Size 14 /W [1 4 2] /Root 3 0 R /Length ${bin.length} >>\nstream\n${bin.toString('latin1')}\nendstream\nendobj\nstartxref\n${xpos}\n%%EOF\n`;
    cases['object stream listed out of order'] = s;
  }
  return Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, Buffer.from(v, 'latin1')]));
}

/** How dark each box [x0, x1, y0, y1] (points) of a page is, from 0 to 1, at 72 DPI. */
function darkAt(file, page, dir, boxes) {
  const out = path.join(dir, `dark-${Math.random().toString(36).slice(2)}.pgm`);
  execFileSync(bin.locate('gs'), ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pgmraw', '-r72', `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${out}`, file]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  const header = buf.toString('latin1', 0, 200).match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/);
  const [width, height] = [Number(header[1]), Number(header[2])];
  const pixels = buf.subarray(header[0].length);
  return boxes.map(([x0, x1, y0, y1]) => {
    let n = 0;
    let black = 0;
    for (let y = height - y1 + 2; y < height - y0 - 2; y++) {
      for (let x = x0 + 2; x < x1 - 2; x++) {
        n++;
        if (pixels[y * width + x] < 128) black++;
      }
    }
    return Math.round((black / n) * 1000) / 1000;
  });
}

/** Every object of a PDF, streams decompressed, as one string. */
function expanded(file, dir) {
  const out = path.join(dir, `expanded-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    execFileSync(bin.locate('qpdf'), ['--qdf', '--object-streams=disable', '--decode-level=all', '--', file, out], { stdio: 'ignore' });
  } catch (err) {
    if (err.status !== 3) throw err;
  }
  const text = fs.readFileSync(out).toString('latin1');
  fs.rmSync(out, { force: true });
  // pdf-lib may write a string as hex; read those too.
  return text + text.replace(/<([0-9A-Fa-f\s]+)>/g, (m, hex) => Buffer.from(hex.replace(/\s/g, ''), 'hex').toString('latin1'));
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

  // A scan with a few typed words (a stamped header) that share a word with the scan's own
  // text: the scan's line must still be searchable whole.
  const stamped = path.join(dir, 'סריקה עם כותרת.pdf');
  {
    const d = await PDFDocument.load(await fsp.readFile(await scannedPdf(path.join(dir, 'tmp-scan.pdf'), png, [0])));
    const [head] = await stamp.embedStamps(d, ['בית משפט השלום'], { size: 12 });
    stamp.drawAt(d.getPage(0), head, { vx: 60, vy: 30, w: head.width, h: head.height });
    await fsp.writeFile(stamped, await d.save());
  }
  r = await runTool('ocr', [stamped], { langs: 'heb' });
  const stampedLines = r.ok && r.display[0] ? await linesOf(r.display[0], 1) : [];
  check('OCR of a scan with a typed header keeps every scanned word, even ones the header shares', stampedLines.includes('בית הדין האזורי לעבודה'), r.error || stampedLines.slice(0, 3).join(' / '));

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

  /* ---- Redact leaves nothing behind, anywhere in the file ---- */
  console.log('\nRedact, byte by byte');
  const hiding = await secretsPdf(path.join(dir, 'מסתור.pdf'));
  r = await runTool('redact', [hiding], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.2 }], clean: true });
  const raw = r.ok ? expanded(r.display[0], dir) : '';
  const left = ['SECRET-ID-4711', 'SECRET-TITLE', 'SECRET-INFO', 'SECRET-XMP', 'SECRET-ATTACH', 'SECRET-OUTLINE', 'SECRET-ALT', 'SECRET-NOTE', 'SECRET-XOBJ']
    .filter((secret) => raw.includes(secret));
  check('no secret survives anywhere in the file: page text, details, XMP, attachment, outline, tags, notes, shared pictures',
    r.ok && raw.length > 0 && left.length === 0, r.error || `still inside: ${left.join(', ')}`);
  check('  while the unmarked page keeps its own text', raw.includes('PUBLIC-PAGE-TWO'));
  r = await runTool('redact', [hiding], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.2 }], clean: true, ocr: true });
  const rawOcr = r.ok ? expanded(r.display[0], dir) : '';
  check('  and the same holds after OCR of the redacted pages', r.ok && !['SECRET-ID-4711', 'SECRET-XOBJ', 'SECRET-NOTE'].some((x) => rawOcr.includes(x)), r.error);

  // The ways a copied page can carry a redacted page's content, each found by review:
  // resources inherited from the page tree, an unused form nested in a used one, a
  // pattern's own resources, damaged content on another page, and (when keeping
  // annotations) a form field or a reply note that points back at the redacted page.
  const cases = await leakCases(dir);
  for (const c of cases) {
    r = await runTool('redact', [c.file], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }], clean: c.clean });
    const rawCase = r.ok ? expanded(r.display[0], dir) : '';
    const leaks = c.secrets.filter((x) => rawCase.includes(x));
    const lost = [].concat(c.keep).filter((x) => !rawCase.includes(x));
    check(`  ${c.label}: nothing of the redacted page survives`, r.ok && leaks.length === 0 && lost.length === 0,
      r.error || `still inside: ${leaks.join(', ')}; lost: ${lost.join(', ')}`);
  }

  r = await runTool('redact', [hiding], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.2 }], clean: false });
  check('keeping comments, an attached file is still left out, and the summary says why',
    r.ok && !expanded(r.display[0], dir).includes('SECRET-ATTACH') && /המצורפים לא הועתקו/.test(r.summary), r.error || r.summary);

  // What an unmarked page shows stays on it: filled fields (with a drawing, and one whose
  // drawing the form left to viewers), a checked box and a stamp, in both modes, each
  // where it was; a hidden stamp is not drawn.
  const shown = await shownPdf(path.join(dir, 'טופס מלא.pdf'));
  const shownScreen = await screenText(shown, 2);
  for (const clean of [true, false]) {
    r = await runTool('redact', [shown], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }], clean });
    const words = r.ok ? (await linesOf(r.display[0], 2)).join(' ') : '';
    const missing = ['FILLED-VALUE-P1', 'STAMP-P1', 'PUBLIC-SHOWN'].filter((x) => !words.includes(x));
    check(`  ${clean ? 'removing' : 'keeping'} comments, the kept page still shows its field values and stamp`, r.ok && missing.length === 0, r.error || `missing: ${missing.join(', ')} in ${words}`);
    const late = r.ok ? await valueDrawn(r.display[0], 2, 'LATE-VALUE') : false;
    check('    a value the form left for viewers to draw is drawn too', late);
    check('    and a hidden stamp stays hidden', r.ok && !words.includes('HIDDEN-STAMP'), words);
    // Read as text, not searched for in the bytes: Chromium writes drawn text as glyph
    // numbers, so a byte search would pass whether or not the password is on the page.
    check('    a password is not drawn in the clear', r.ok && !words.includes('PASSWORDPLAIN') && words.includes('FILLED-VALUE-P1'), words);
    // pdf.js ignores the /OC of an annotation's own drawing, so that stamp shows on screen.
    check('    a drawing on a hidden layer stays hidden; a stamp whose own drawing carries a hidden layer shows, as on screen',
      r.ok && !words.includes('OFFLAYERFORM') && words.includes('OFFLAYERSTAMP') && shownScreen.has('OFFLAYERSTAMP') && !shownScreen.has('OFFLAYERFORM'), words);
    const third = r.ok ? (await linesOf(r.display[0], 3)).join(' ') : '';
    check('    a page sharing its resources with another keeps its own stamp', third.includes('STAMPTWO'), third);
    const freeText = r.ok ? (await linesOf(r.display[0], 2)).join(' ').includes('COMMENT-TEXT') : true;
    check(`    a comment ${clean ? 'is removed, not burned into the page' : 'stays a comment, not burned into the page'}`, r.ok && !freeText);
    const ink = r.ok ? darkIn(r.display[0], 2, dir) : null;
    check('    each drawn where it was: the stamp\'s box and the checked box are dark, the drawing\'s own corner is not',
      ink && ink.stamp > 0.8 && ink.check > 0.05 && ink.origin < 0.01, JSON.stringify(ink));
    const annots = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPage(1).node.lookup(PDFName.of('Annots')) : null;
    check(`    ${clean ? 'no annotation is left' : 'the two comments stay comments, and nothing else stays an annotation'}`,
      clean ? !annots : annots && annots.size() === 2, annots ? `${annots.size()} annotations` : 'none');
  }

  // Harder cases on an unmarked page, found by review: what a viewer hides stays hidden,
  // typed text stays, and a page sharing another's contents gets only its own stamp.
  const fidelity = await fidelityPdf(path.join(dir, 'נאמנות.pdf'));
  const onScreen = await screenText(fidelity, 2);
  // The reading of the screen itself is checked: some markers show and some do not.
  check('  (pdf.js shows some of the markers on the original and hides others)', onScreen.has('OC-VE-AND') && !onScreen.has('OC-VE-MARKED') && !onScreen.has('OC-SINGLEREF-OFF'), [...onScreen].join(' '));
  for (const clean of [true, false]) {
    r = await runTool('redact', [fidelity], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }], clean });
    const raw = r.ok ? expanded(r.display[0], dir) : '';
    const two = r.ok ? (await linesOf(r.display[0], 2)).join(' ') : '';
    const three = r.ok ? (await linesOf(r.display[0], 3)).join(' ') : '';
    const mode = clean ? 'removing' : 'keeping';
    // Judged against pdf.js, which drew the page the user saw: each marker shows in the
    // result exactly when pdf.js shows it on the original. Markers inside a pattern, a
    // Type3 letter or a soft mask, which this reading does not reach, are on a plain hidden
    // layer and must simply be gone.
    const judged = ['PUBLIC-FIDELITY', 'OC-VE-MARKED', 'OC-VE-FORM', 'OC-VE-AND', 'OC-UNLISTED', 'OC-CYCLIC', 'OC-MALFORMED', 'OC-SHORTVE',
      'OC-NOTSELF', 'OC-ORSELF', 'OC-DEEPCHAIN', 'OC-MEMO', 'OC-NOTTWO', 'OC-SINGLEREF-OFF', 'OC-SINGLEREF-ON', 'OC-USAGE-VIEWOFF', 'OC-ONOFF', 'OC-PASTTEN', 'OC-UNKNOWNIN',
      'OC-TYPE-REF', 'OC-VIEW-REF', 'OC-NULLMEMBER-MARKED', 'OC-ODD-NUMBER', 'OC-ODD-ARRAY', 'OC-ODD-STREAM', 'OC-ODD-NAME',
      'OC-ODD-NULLMEMBER', 'OC-SUBTYPE-REF', 'OC-ANNOT-NULLMEMBER', 'OC-AP-OWN-OC', 'OC-ANNOT-NUMBER', 'OC-NAMED-SHOWN', 'OC-NAMED-ELSEWHERE'];
    const differs = judged.filter((x) => raw.includes(x) !== onScreen.has(x));
    const nested = ['PATTERNHIDDEN', 'GSTHREEFORMHIDDEN', 'GSTHREEMCHIDDEN', 'TYPETHREEMCHIDDEN', 'TYPETHREEFORMHIDDEN', 'SMASKHIDDEN', 'HIDDENCOMMENT', 'NULLMEMBERCOMMENT', 'SECRET-FIDELITY-P0']
      .filter((x) => raw.includes(x));
    check(`  ${mode} comments: what shows matches what pdf.js showed on screen, marker by marker; what is hidden inside patterns, Type3 letters, soft masks or a comment stays out; the page's own content stays`,
      r.ok && differs.length === 0 && nested.length === 0 && two.includes('PUBLIC-FIDELITY'), r.error || `differs from the screen: ${differs.join(', ')}; hidden but inside: ${nested.join(', ')}`);
    check('    text typed onto the page stays on it', two.includes('TYPED-ON-PAGE'), two);
    check('    a stamp on a page sharing its contents with another is not drawn on that other page', two.includes('STAMPONLYONE') && !three.includes('STAMPONLYONE'), three);
    if (clean) {
      check('    handwriting, and typed text with no drawing, go with the comments, and the summary names both and how to keep them',
        !two.includes('INK-MARK') && !raw.includes('TYPEDNOAP') && !raw.includes('TYPEDDANGLING') && /כתב יד וגם טקסט שהוקלד על העמוד\. כדי לשמור אותם/.test(r.summary || ''), r.summary);
    } else {
      check('    a handwritten mark, and typed text with no drawing or a missing one, stay comments',
        !two.includes('INK-MARK') && /Ink/.test(raw) && raw.includes('TYPEDNOAP') && raw.includes('TYPEDDANGLING'), two);
    }
    const title = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]), { updateMetadata: false })).getTitle() : null;
    check(`    the title is ${clean ? 'removed' : 'kept'}`, clean ? !title : title === 'KEPT-TITLE', title);
    check('    the result has no list of layers, so no empty or "hidden" layers show in a viewer',
      r.ok && !/\/OCProperties/.test(raw) && !/\/OCG\b/.test(raw), r.error);
  }

  {
    // Every layer starts hidden but the ones listed as shown.
    const { StandardFonts, PDFString } = require('pdf-lib');
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-BASE-P0', { x: 50, y: 700, size: 14, font: f });
    const listedOn = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('on') }));
    const other = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('other') }));
    // (The default given through a reference, which pdf.js resolves.)
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [listedOn, other], D: { BaseState: ctx.register(PDFName.of('OFF')), ON: [listedOn] } }));
    // A layer written in place, in no list: hidden by default here, as in the original.
    p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, Properties: { On: listedOn, Ot: other, Dr: { Type: 'OCG', Name: PDFString.of('direct') } } }));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/OC /On BDC BT /F1 12 Tf 50 700 Td (OC-BASE-ON) Tj ET EMC /OC /Ot BDC BT /F1 12 Tf 50 650 Td (OC-BASE-OTHER) Tj ET EMC /OC /Dr BDC BT /F1 12 Tf 50 600 Td (OC-BASE-DIRECT) Tj ET EMC')));
    // A stamp whose drawing holds hidden content: marked, and a drawing placed whole under
    // a visibility expression. On a page with resources of its own, so only the walk
    // through the stamp's drawing keeps these out.
    const both = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('And'), listedOn, other] }));
    const inner = ctx.register(ctx.stream('BT /F1 10 Tf 105 110 Td (APHIDDENFORM) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], OC: both, Resources: { Font: { F1: f.ref } } }));
    const stampLook = ctx.register(ctx.stream('/OC /Ha BDC BT /F1 10 Tf 105 120 Td (APHIDDENMC) Tj ET EMC /Hx Do BT /F1 10 Tf 105 140 Td (APSHOWN) Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], Resources: { Font: { F1: f.ref }, Properties: { Ha: other }, XObject: { Hx: inner } },
    }));
    p1.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 100, 400, 150], AP: { N: stampLook } }))]));
    const base = path.join(dir, 'base-off.pdf');
    await fsp.writeFile(base, await d.save());
    r = await runTool('redact', [base], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }] });
    const raw = r.ok ? expanded(r.display[0], dir) : '';
    const baseScreen = await screenText(base, 2);
    const baseDiffers = ['OC-BASE-ON', 'OC-BASE-OTHER', 'OC-BASE-DIRECT'].filter((x) => raw.includes(x) !== baseScreen.has(x));
    check('  where layers start hidden, each marker shows exactly as pdf.js shows it (a listed layer, another, one written in place)',
      r.ok && baseDiffers.length === 0 && baseScreen.has('OC-BASE-ON') && !baseScreen.has('OC-BASE-OTHER'), r.error || baseDiffers.join(', '));
    check('  a stamp is drawn into the page without what its drawing hides', r.ok && raw.includes('APSHOWN') && !raw.includes('APHIDDENMC') && !raw.includes('APHIDDENFORM'), r.error);
  }

  {
    // On the page being redacted, a rectangle a viewer hides by a visibility expression,
    // drawn once as a drawing and once as marked content, outside the marked area: it must
    // not be burned into the picture. On the kept page, a rule that is also used as a
    // graphics state with no opacity: what it paints stays invisible.
    const { StandardFonts, PDFString } = require('pdf-lib');
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    const on = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('on') }));
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [on], D: {} }));
    const notOn = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('Not'), on], ca: 0 }));
    const box = ctx.register(ctx.stream('0 g 300 100 100 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], OC: notOn }));
    p0.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, Properties: { H: notOn }, XObject: { B: box } }));
    p0.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 14 Tf 50 760 Td (SECRET-BURN) Tj ET /B Do /OC /H BDC 0 g 300 400 100 50 re f EMC')));
    // Annotations on the redacted page, outside the mark: one on a hidden layer and one
    // for printing only, both hidden on screen; one with no flags, shown on screen.
    const blackBox = () => ctx.register(ctx.stream('0 g 0 0 100 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50] }));
    const off = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('off') }));
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [on, off], D: { OFF: [off] } }));
    const stamp = (rect, extra) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: rect, AP: { N: blackBox() }, ...extra }));
    p0.node.set(PDFName.of('Annots'), ctx.obj([
      stamp([100, 100, 200, 150], { F: 4, OC: off }),
      stamp([100, 200, 200, 250], { F: 36 }),
      stamp([100, 300, 200, 350], { F: 0 }),
    ]));
    p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, ExtGState: { Z: notOn } }));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 14 Tf 50 760 Td (PUBLIC-BURN) Tj ET q /Z gs 0 g 300 400 100 50 re f Q')));
    const burn = path.join(dir, 'burn.pdf');
    await fsp.writeFile(burn, await d.save());
    r = await runTool('redact', [burn], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.1 }] });
    const out0 = r.ok ? darkAt(r.display[0], 1, dir, [[300, 400, 100, 150], [300, 400, 400, 450]]) : null;
    check('  on the redacted page, what a viewer hides is not burned into its picture', out0 && out0.every((x) => x < 0.01), r.error || JSON.stringify(out0));
    const notes = r.ok ? darkAt(r.display[0], 1, dir, [[100, 200, 100, 150], [100, 200, 200, 250], [100, 200, 300, 350]]) : null;
    check('  and its annotations are as on screen: one on a hidden layer and one for printing only are not in the picture, one with no flags is',
      notes && notes[0] < 0.01 && notes[1] < 0.01 && notes[2] > 0.9, r.error || JSON.stringify(notes));
    const out1 = r.ok ? darkAt(r.display[0], 2, dir, [[300, 400, 400, 450]]) : null;
    check('  a rule that is also a graphics state keeps what it paints invisible', out1 && out1[0] < 0.01, r.error || JSON.stringify(out1));
  }
  {
    // A file made so that working out its rules is slow: 20,000 layers, 3,000 rules sharing
    // one expression over all of them that ends in a malformed part, and 3,000 sharing one
    // list of all of them. Redaction must still finish in moments.
    const { StandardFonts } = require('pdf-lib');
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const ctx = d.context;
    const p0 = d.addPage([595, 842]);
    const p1 = d.addPage([595, 842]);
    p0.drawText('SECRET-SLOW', { x: 50, y: 700, size: 14, font: f });
    const many = Array.from({ length: 20000 }, () => ctx.register(ctx.obj({ Type: 'OCG' })));
    d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: many, D: { OFF: many } }));
    const longVe = ctx.register(ctx.obj([PDFName.of('Or'), ...many, ctx.obj([PDFName.of('Xor')])]));
    const longList = ctx.register(ctx.obj(many));
    const props = { };
    for (let i = 0; i < 3000; i++) {
      props[`V${i}`] = ctx.register(ctx.obj({ Type: 'OCMD', VE: longVe }));
      props[`L${i}`] = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: longList, P: 'AllOff' }));
    }
    // A rule no page uses, twenty wide and ten deep over one shared part: 20^10 steps
    // unless shared parts are remembered. (Unused, as pdf.js itself would not finish it.)
    let wide = many[0];
    for (let i = 0; i < 10; i++) wide = ctx.register(ctx.obj([PDFName.of('Or'), ...Array(20).fill(wide)]));
    props.Wide = ctx.register(ctx.obj({ Type: 'OCMD', VE: wide }));
    // An ordinary rule after all of those, which must still be worked out, not given up on.
    const lateOn = ctx.register(ctx.obj({ Type: 'OCG' }));
    props.Late = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: lateOn }));
    p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, Properties: props }));
    p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/OC /V0 BDC BT /F1 12 Tf 50 700 Td (OC-SLOW-VE) Tj ET EMC /OC /L0 BDC BT /F1 12 Tf 50 650 Td (OC-SLOW-ALLOFF) Tj ET EMC /OC /Late BDC BT /F1 12 Tf 50 600 Td (OC-SLOW-LATE) Tj ET EMC')));
    const slow = path.join(dir, 'slow.pdf');
    await fsp.writeFile(slow, await d.save());
    const slowScreen = await screenText(slow, 2);
    const started = Date.now();
    r = await runTool('redact', [slow], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }] });
    const took = Date.now() - started;
    const raw = r.ok ? expanded(r.display[0], dir) : '';
    check('  a file made to be slow to work out is still redacted in moments, and judged right',
      r.ok && took < 15000 && ['OC-SLOW-VE', 'OC-SLOW-ALLOFF', 'OC-SLOW-LATE'].every((x) => raw.includes(x) === slowScreen.has(x)) && slowScreen.has('OC-SLOW-LATE'),
      r.error || `${took} ms; screen: ${[...slowScreen].join(' ')}`);
  }

  {
    // A page in the page tree with no /Type: pdf.js counts it, pdf-lib does not, so the
    // page the user marked on screen is not the page a picture would replace.
    const { StandardFonts } = require('pdf-lib');
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const secret = d.addPage([595, 842]);
    const open = d.addPage([595, 842]);
    secret.drawText('SECRET-MISCOUNT', { x: 50, y: 700, size: 14, font: f });
    open.drawText('PUBLIC-MISCOUNT', { x: 50, y: 700, size: 14, font: f });
    const kids = d.catalog.Pages().lookup(PDFName.of('Kids'));
    const stray = d.context.register(d.context.obj({ Parent: d.catalog.get(PDFName.of('Pages')), MediaBox: [0, 0, 595, 842], Resources: {}, Contents: d.context.register(d.context.stream('')) }));
    kids.insert(0, stray);
    d.catalog.Pages().set(PDFName.of('Count'), d.context.obj(3));
    const miscount = path.join(dir, 'miscount.pdf');
    await fsp.writeFile(miscount, await d.save());
    const before = fs.readdirSync(dir).length;
    r = await runTool('redact', [miscount], { marks: [{ page: 1, x: 0, y: 0, w: 1, h: 1 }] });
    check('  a file whose pages pdf.js and pdf-lib count differently is refused, and nothing is written',
      !r.ok && /אין ודאות איזה עמוד סומן/.test(r.error || '') && fs.readdirSync(dir).length === before, r.error || r.display);
  }
  {
    // A page object written twice, the table of objects pointing at the first copy (as
    // pdf.js reads it) while a reader going through the file in order takes the second,
    // which holds the marked page's content.
    const objs = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'], [3, rawPage(5)], [4, rawPage(6)],
      [5, rawStream('BT /F1 24 Tf 50 700 Td (SECRET-TWICE) Tj ET')], [6, rawStream('BT /F1 24 Tf 50 700 Td (PUBLIC-TWICE) Tj ET')],
      [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], [4, rawPage(5)]];
    const twice = path.join(dir, 'twice.pdf');
    await fsp.writeFile(twice, rawPdf(objs, { firstOf: [4] }));
    r = await runTool('redact', [twice], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
    const raw = r.ok ? expanded(r.display[0], dir) : '';
    check('  a page object written twice: the kept page is the one the screen showed, and the marked text is nowhere',
      r.ok && raw.includes('PUBLIC-TWICE') && !raw.includes('SECRET-TWICE'), r.error || 'secret inside');
    // The same file with its table of objects pointing nowhere useful: refused.
    const broken = rawPdf(objs, { firstOf: [4] });
    const at = broken.lastIndexOf('startxref');
    const damaged = path.join(dir, 'damaged-table.pdf');
    await fsp.writeFile(damaged, Buffer.concat([broken.subarray(0, at), Buffer.from('startxref\n17\n%%EOF\n')]));
    // The same file with its table of objects pointing nowhere useful: qpdf and pdf.js
    // each rebuild it, and the result is made only if it looks as the screen showed it.
    const damagedScreen = await screenText(damaged, 2);
    r = await runTool('redact', [damaged], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
    const damagedOut = r.ok ? await screenText(r.display[0], 2) : new Set();
    check('  a file whose table of objects has to be rebuilt is redacted as the screen showed it, or refused',
      r.ok ? [...damagedScreen].join('|') === [...damagedOut].join('|') && !(r.ok && (await screenText(r.display[0], 1)).size) : /תיקון PDF/.test(r.error || ''), r.error || [...damagedOut].join('|'));
    // A page at the end that pdf.js counts and pdf-lib does not: the counts differ.
    const tail = rawPdf([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'], [3, rawPage(5)],
      [4, rawPage(5).replace('/Type /Page ', '')], [5, rawStream('BT /F1 24 Tf 50 700 Td (TAIL) Tj ET')], [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']]);
    const tailFile = path.join(dir, 'tail.pdf');
    await fsp.writeFile(tailFile, tail);
    r = await runTool('redact', [tailFile], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
    check('  a file whose last page only pdf.js counts is refused', !r.ok && /אין ודאות איזה עמוד סומן/.test(r.error || ''), r.error || 'redacted');
    // Marks made on another version of the file, and on this one.
    r = await runTool('redact', [twice], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }], forToken: 'not-this-version' });
    check('  marks made on another version of the file are refused', !r.ok && /השתנה מאז שסומן/.test(r.error || ''), r.error);
    r = await runTool('redact', [twice], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }], forToken: require('../src/main/docs').register(twice) });
    check('  and marks made on this version are accepted', r.ok, r.error);
  }
  {
    // Two things pdf.js reads differently from the fresh copy qpdf writes: a drawing with
    // /OC null (pdf.js leaves it out; the copy writes it as no /OC, as the specification
    // reads it), and a rule written in place in page content naming a layer by object
    // number (not valid PDF; the copy numbers objects anew). On a kept page each would
    // show what the screen hid, so the result is refused.
    const { StandardFonts, PDFNull } = require('pdf-lib');
    for (const kind of ['null', 'inline']) {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      const ctx = d.context;
      d.addPage([595, 842]).drawText('SECRET-DIFFERS', { x: 50, y: 700, size: 14, font: f });
      const p1 = d.addPage([595, 842]);
      const off = ctx.register(ctx.obj({ Type: 'OCG', Name: require('pdf-lib').PDFString.of('off') }));
      d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [off], D: { OFF: [off] } }));
      const hiddenForm = ctx.register(ctx.stream('BT /F1 24 Tf 50 500 Td (WAS-HIDDEN) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: f.ref } }, OC: PDFNull }));
      p1.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f.ref }, XObject: { H: hiddenForm } }));
      p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(kind === 'null'
        ? 'BT /F1 14 Tf 50 700 Td (PUBLIC-DIFFERS) Tj ET /H Do'
        : `BT /F1 14 Tf 50 700 Td (PUBLIC-DIFFERS) Tj ET /OC << /Type /OCMD /OCGs ${off.objectNumber} 0 R >> BDC BT /F1 24 Tf 50 500 Td (WAS-HIDDEN) Tj ET EMC`)));
      const file = path.join(dir, `differs-${kind}.pdf`);
      await fsp.writeFile(file, await d.save());
      r = await runTool('redact', [file], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
      check(`  ${kind === 'null' ? 'a drawing with /OC null' : 'a rule naming a layer by number inside content'}: the result would not look as the screen did, so it is refused`,
        !r.ok && /עמוד 2 בתוצאה אינו נראה כמו שהוצג במסך/.test(r.error || ''), r.error || 'made');
    }
  }
  {
    // Files that pdf.js and qpdf read differently in ways no check of the file itself
    // catches (found by review): a linearized file with two tables of objects, one whose
    // first page is named outside the page tree, and an object stream whose objects are
    // listed out of order. In each, the copied page 2 would show the marked page's text
    // while the screen showed other text. The final check against the screen refuses them.
    for (const [label, bytes] of Object.entries(crafted())) {
      const file = path.join(dir, `crafted-${label}.pdf`);
      await fsp.writeFile(file, bytes);
      r = await runTool('redact', [file], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
      const raw = r.ok ? expanded(r.display[0], dir) : '';
      check(`  ${label}: refused, or made with no marked text in it`, (!r.ok && /אינו נראה כמו שהוצג במסך|תיקון PDF/.test(r.error || '')) || (r.ok && !raw.includes('SECRETPAGEZERO')),
        r.error || 'secret inside');
    }
  }
  {
    // The picture of a marked page has the size pdf.js shows the page at: turned, with a
    // crop box larger than the page, and in units twice the usual.
    const d = await PDFDocument.create();
    const p0 = d.addPage([400, 600]);
    p0.setRotation(degrees(90));
    const p1 = d.addPage([400, 600]);
    p1.node.set(PDFName.of('CropBox'), d.context.obj([-50, -50, 450, 650]));
    const p2 = d.addPage([400, 600]);
    p2.node.set(PDFName.of('UserUnit'), d.context.obj(2));
    const sized = path.join(dir, 'sizes.pdf');
    await fsp.writeFile(sized, await d.save());
    r = await runTool('redact', [sized], { marks: [0, 1, 2].map((page) => ({ page, x: 0.1, y: 0.1, w: 0.1, h: 0.1 })) });
    const lib = await text.pdfjs();
    const orig = await lib.getDocument({ data: new Uint8Array(await fsp.readFile(sized)), isEvalSupported: false }).promise;
    const want = [];
    for (let i = 1; i <= 3; i++) {
      const v = (await orig.getPage(i)).getViewport({ scale: 1 });
      want.push([Math.round(v.width), Math.round(v.height)]);
    }
    await orig.destroy();
    const got = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPages().map((pg) => pg.getSize()).map((z) => [Math.round(z.width), Math.round(z.height)]) : [];
    check('  each redacted page is the size pdf.js shows it at (turned, larger crop box, larger units)', r.ok && JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
  {
    // Esc while pdf.js is still drawing a page that takes long to draw.
    const d = await PDFDocument.create();
    const ctx = d.context;
    const heavy = ctx.register(ctx.flateStream(Array.from({ length: 200000 }, (_, i) => `${i % 500} ${(i * 7) % 800} 1 1 re f`).join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842] }));
    const p0 = d.addPage([595, 842]);
    d.addPage([595, 842]);
    p0.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { H: heavy } }));
    p0.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(Array.from({ length: 60 }, () => '/H Do').join(' '))));
    const slowPage = path.join(dir, 'slow-page.pdf');
    await fsp.writeFile(slowPage, await d.save());
    let jobId = null;
    let askedAt = 0;
    let started = false;
    const job = jobs.start(tools.runnable('redact'), [slowPage], { marks: [{ page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }, {
      onProgress: (p) => {
        // Progress is sent at most every 33 ms, so the job is caught by its first message;
        // Esc comes three seconds later, well inside the page's drawing (over 20 s here).
        if (!started) {
          started = true;
          setTimeout(() => {
            askedAt = Date.now();
            jobs.cancel(jobId);
          }, 3000);
        }
      },
    });
    jobId = job.id;
    const c = await job.promise;
    const after = askedAt ? Date.now() - askedAt : -1;
    check('  Esc stops a page that is still being drawn, within moments', c.cancelled && after >= 0 && after < 4000, `${c.cancelled ? 'cancelled' : c.error || 'finished'} after ${after} ms`);
    check('    and closes the drawing window, which is the only way to stop pdf.js mid-page', !pagepicture.windowForTest());
    // The drawing window's page dies mid-drawing: the job ends at once, not at the time limit.
    let crashedAt = 0;
    let crashStarted = false;
    const crash = jobs.start(tools.runnable('redact'), [slowPage], { marks: [{ page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }, {
      onProgress: () => {
        if (crashStarted) return;
        crashStarted = true;
        setTimeout(() => {
          const w = pagepicture.windowForTest();
          crashedAt = Date.now();
          if (w) w.webContents.forcefullyCrashRenderer();
        }, 3000);
      },
    });
    const cr = await crash.promise;
    const ended = crashedAt ? Date.now() - crashedAt : -1;
    check('  when the drawing window dies mid-page, the job ends at once with a message', !cr.ok && !cr.cancelled && ended >= 0 && ended < 4000 && /לצייר/.test(cr.error || ''), `${cr.error} after ${ended} ms`);
    r = await runTool('redact', [fidelity], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
    check('    and the next redaction works', r.ok, r.error);
    // A page that takes longer than the time limit (shortened here) gets its own message.
    pagepicture.setPageLimitForTest(1500);
    const timed = await runTool('redact', [slowPage], { marks: [{ page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] });
    pagepicture.setPageLimitForTest(120000);
    check('  a page that takes too long to draw is given up on, saying so', !timed.ok && /לא הסתיים/.test(timed.error || ''), timed.error);
    for (let i = 0; i < 3; i++) await runTool('redact', [fidelity], { marks: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] });
    const w = pagepicture.windowForTest();
    check('  the drawing window keeps no listeners from finished drawings', w && w.webContents.listenerCount('destroyed') <= 1, w ? w.webContents.listenerCount('destroyed') : 'no window');
  }

  /* ---- PDF to Excel ---- */
  console.log('\nPDF to Excel');
  const table = await vectorPdf(path.join(dir, 'טבלה.pdf'), `
    <p>דוח תשלומים לתיק 4521</p>
    <table style="border-collapse:collapse" cellpadding="6">
      <tr><td>תאריך</td><td style="padding-right:40px">תיאור</td><td style="padding-right:40px">סכום</td></tr>
      <tr><td>07/08/2026</td><td style="padding-right:40px">שכר טרחה</td><td style="padding-right:40px">1,250.50</td></tr>
      <tr><td>15/08/2026</td><td style="padding-right:40px">אגרה</td><td style="padding-right:40px">300</td></tr>
      <tr><td>20.08.2026</td><td style="padding-right:40px">צילומים</td><td style="padding-right:40px">12.50</td></tr>
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
  check('  a small amount like 12.50 is a number too, and a dotted date stays a date', JSON.stringify(row(5)) === '["20.08.2026","צילומים",12.5]', JSON.stringify(row(5)));

  // Long descriptions in every row must stay their own column, with the amounts beside.
  const { layout } = require('../src/main/tools/pdf-to-excel');
  const longRows = [0, 1, 2].map((r) => [
    { str: `Consulting services for the month of March 2026 part ${r}`, x: 40, width: 330, y: 100 + r * 20, height: 10, rtl: false },
    { str: `${1250 + r}.00`, x: 450, width: 40, y: 100 + r * 20, height: 10, rtl: false },
  ]).flat();
  const longLayout = layout(longRows);
  check('a two-column table with long descriptions keeps the amounts in their own column, as numbers',
    longLayout.tables === 1 && longLayout.rows.every((row) => row.length === 2 && typeof row[1] === 'number'), JSON.stringify(longLayout.rows[0]));
  const headed = layout([
    { str: 'Payments for case 4521, all amounts in shekels', x: 40, width: 440, y: 80, height: 10, rtl: false },
    ...longRows,
  ]);
  check('  while a heading across the whole table does not merge its columns', headed.rows.slice(-3).every((row) => row.length === 2 && typeof row[1] === 'number'), JSON.stringify(headed.rows));

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
