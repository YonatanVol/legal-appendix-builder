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
 * handwritten mark, a stamp, and content a viewer hides in three harder ways: a rule
 * with a visibility expression, a layer named only in the hidden list, and a fill pattern
 * that draws a drawing on a hidden layer. Page 3 shares page 2's list of contents.
 */
async function fidelityPdf(file) {
  const { PDFDocument, StandardFonts, PDFString } = require('pdf-lib');
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const ctx = d.context;
  const p0 = d.addPage([595, 842]);
  const p1 = d.addPage([595, 842]);
  const p2 = d.addPage([595, 842]);
  p0.drawText('SECRET-FIDELITY-P0', { x: 50, y: 760, size: 14, font: f });
  const shownLayer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('shown') }));
  const offLayer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('off') }));
  const strayOff = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('stray') }));
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [shownLayer, offLayer], D: { OFF: [offLayer, strayOff] } }));
  const notShown = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('Not'), shownLayer] }));
  const andShown = ctx.register(ctx.obj({ Type: 'OCMD', VE: [PDFName.of('And'), shownLayer] }));
  const form = (body, extra = {}) => ctx.register(ctx.stream(body, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: f.ref } }, ...extra }));
  const veForm = form('BT /F1 12 Tf 50 560 Td (VEHIDDEN-FORM) Tj ET', { OC: notShown });
  const inPattern = form('BT /F1 12 Tf 2 2 Td (PATTERNHIDDEN) Tj ET', { OC: offLayer });
  const pattern = ctx.register(ctx.stream('/Hf Do', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 40], XStep: 200, YStep: 40, Resources: { XObject: { Hf: inPattern } } }));
  const resources = ctx.register(ctx.obj({ Font: { F1: f.ref }, Properties: { Ve: notShown, Vs: andShown, St: strayOff }, XObject: { Vf: veForm }, Pattern: { P1: pattern } }));
  const body = ctx.register(ctx.stream([
    'BT /F1 14 Tf 50 790 Td (PUBLIC-FIDELITY) Tj ET',
    '/OC /Ve BDC BT /F1 12 Tf 50 600 Td (VEHIDDEN-MARKED) Tj ET EMC',
    '/OC /Vs BDC BT /F1 12 Tf 50 620 Td (VE-SHOWN) Tj ET EMC',
    '/OC /St BDC BT /F1 12 Tf 50 580 Td (UNLISTEDHIDDEN) Tj ET EMC',
    '/Vf Do',
    '/Pattern cs /P1 scn 50 300 200 40 re f',
  ].join('\n')));
  const shared = ctx.register(ctx.obj([body]));
  for (const p of [p1, p2]) {
    p.node.set(PDFName.of('Resources'), resources);
    p.node.set(PDFName.of('Contents'), shared);
  }
  const look = (text) => ctx.register(ctx.stream(`BT /F1 10 Tf 105 120 Td (${text}) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [100, 100, 200, 150], Resources: { Font: { F1: f.ref } } }));
  const annot = (dict) => ctx.register(ctx.obj({ Type: 'Annot', ...dict }));
  p1.node.set(PDFName.of('Annots'), ctx.obj([
    annot({ Subtype: 'FreeText', IT: 'FreeTextTypeWriter', Rect: [50, 400, 250, 430], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('TYPED-ON-PAGE'), AP: { N: look('TYPED-ON-PAGE') } }),
    annot({ Subtype: 'Ink', Rect: [300, 400, 400, 450], InkList: [[300, 400, 400, 450]], AP: { N: look('INK-MARK') } }),
    annot({ Subtype: 'Stamp', Rect: [300, 200, 400, 250], AP: { N: look('STAMPONLYONE') } }),
  ]));
  await fsp.writeFile(file, await d.save());
  return file;
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
    check('    a drawing or a stamp on a hidden layer stays hidden', r.ok && !words.includes('OFFLAYERFORM') && !words.includes('OFFLAYERSTAMP'), words);
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
  for (const clean of [true, false]) {
    r = await runTool('redact', [fidelity], { marks: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.9 }], clean });
    const raw = r.ok ? expanded(r.display[0], dir) : '';
    const two = r.ok ? (await linesOf(r.display[0], 2)).join(' ') : '';
    const three = r.ok ? (await linesOf(r.display[0], 3)).join(' ') : '';
    const mode = clean ? 'removing' : 'keeping';
    const shownHidden = ['VEHIDDEN-MARKED', 'VEHIDDEN-FORM', 'UNLISTEDHIDDEN', 'PATTERNHIDDEN', 'SECRET-FIDELITY-P0'].filter((x) => raw.includes(x));
    check(`  ${mode} comments: content hidden by a visibility rule, an unlisted hidden layer or inside a pattern stays out`,
      r.ok && shownHidden.length === 0 && two.includes('PUBLIC-FIDELITY') && two.includes('VE-SHOWN'), r.error || `in the file: ${shownHidden.join(', ')}; page 2: ${two}`);
    check('    text typed onto the page stays on it', two.includes('TYPED-ON-PAGE'), two);
    check('    a stamp on a page sharing its contents with another is not drawn on that other page', two.includes('STAMPONLYONE') && !three.includes('STAMPONLYONE'), three);
    if (clean) {
      check('    a handwritten mark goes with the comments, and the summary says how to keep it',
        !two.includes('INK-MARK') && /סימון אחד בכתב יד/.test(r.summary || ''), r.summary);
    } else {
      check('    a handwritten mark stays a comment', !two.includes('INK-MARK') && /Ink/.test(raw), two);
    }
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
