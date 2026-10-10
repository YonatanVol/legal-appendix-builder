'use strict';

/**
 * Edit PDF, Sign and PDF Forms. Shapes are checked by drawing the result with
 * Ghostscript and reading the pixels where each object should be, on pages turned
 * every way; text by where pdf.js finds it; the digital signature with OpenSSL.
 * Launch with:  npx electron test/editing.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, nativeImage } = require('electron');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const { openWindow } = require('./helpers/window');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const text = require('../src/main/pdf/text');
const bin = require('../src/main/engine/binaries');
const runs = require('../src/main/runs');
const signatures = require('../src/main/signatures');
const { readFields } = require('../src/main/tools/forms');
const { registerIpc } = require('../src/main/ipc');
const { disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}
const runTool = (id, inputs, options = {}) => jobs.start(tools.runnable(id), inputs, options).promise;

/** The shown page as pixels: returns (fx, fy) -> [r, g, b] for fractions from the top-left. */
function pixels(file, page, dir) {
  const png = path.join(dir, `px-${Math.random().toString(36).slice(2)}.png`);
  execFileSync(bin.locate('gs'), ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r50', '-dUseCropBox',
    `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${png}`, file]);
  const img = nativeImage.createFromPath(png);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  fs.rmSync(png, { force: true });
  return (fx, fy) => {
    const x = Math.min(width - 1, Math.round(fx * width));
    const y = Math.min(height - 1, Math.round(fy * height));
    const i = (y * width + x) * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i]]; // BGRA
  };
}
const isRed = ([r, g, b]) => r > 160 && g < 90 && b < 90;
const isWhite = ([r, g, b]) => r > 235 && g > 235 && b > 235;
const isDark = ([r, g, b]) => r < 120 && g < 120 && b < 120;

async function pagesPdf(file, rotations) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rot of rotations) {
    const page = doc.addPage([500, 700]);
    // Black text along the top of the page as shown, so whiteout has something to cover.
    page.setRotation(degrees(rot));
    page.drawText('UNDER', { x: 20, y: 20, size: 1, font });
  }
  await fsp.writeFile(file, await doc.save());
  return file;
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'editing-'));
  runs.setStoreFile(path.join(dir, 'runs.json'));
  signatures.setStoreFile(path.join(dir, 'signatures.json'));

  /* ---- drawing, on pages turned every way ---- */
  console.log('\nEdit PDF');
  const turned = await pagesPdf(path.join(dir, 'מסובב.pdf'), [0, 90, 180, 270]);
  const objects = [];
  for (let p = 0; p < 4; p++) {
    objects.push(
      { type: 'rect', page: p, x: 0.1, y: 0.1, w: 0.2, h: 0.1, stroke: '#c00000', fill: '#c00000', width: 2 },
      { type: 'line', page: p, x1: 0.6, y1: 0.8, x2: 0.9, y2: 0.8, stroke: '#c00000', width: 6 },
      { type: 'text', page: p, x: 0.5, y: 0.5, w: 0.4, h: 0.04, text: 'נחתם היום 07/10/2026', size: 14, color: '#000000', align: 'right' },
    );
  }
  let r = await runTool('edit', [turned], { objects });
  check('the edit runs and says how much was added', r.ok && /12 פריטים/.test(r.summary), r.error || r.summary);
  for (let p = 1; p <= 4; p++) {
    const px = r.ok ? pixels(r.display[0], p, dir) : () => [0, 0, 0];
    check(`page turned ${(p - 1) * 90}: the red box is at the top left as shown, and nowhere else`,
      isRed(px(0.2, 0.15)) && !isRed(px(0.8, 0.15)) && !isRed(px(0.2, 0.85)), JSON.stringify([px(0.2, 0.15), px(0.8, 0.85)]));
    check(`  the line runs where it was drawn`, isRed(px(0.75, 0.8)) && !isRed(px(0.75, 0.6)));
    const doc = r.ok ? await text.open(r.display[0]) : null;
    const { lines, width, height } = doc ? await text.pageLines(doc, p) : { lines: [] };
    if (doc) await doc.destroy();
    const line = lines.find((l) => l.text.includes('נחתם'));
    check(`  the Hebrew text reads in order, right-aligned in its box`,
      line && line.text === 'נחתם היום 07/10/2026' && Math.abs(line.right / width - 0.9) < 0.03 && Math.abs(line.y / height - 0.53) < 0.03,
      line ? `${line.text} right=${(line.right / width).toFixed(2)} y=${(line.y / height).toFixed(2)}` : lines.map((l) => l.text).join(' / '));
  }

  const plain = await pagesPdf(path.join(dir, 'רגיל.pdf'), [0]);
  const tiny = nativeImage.createFromBitmap(Buffer.alloc(40 * 40 * 4, 0).fill(255, 0).map((v, i) => (i % 4 === 2 ? 220 : i % 4 === 3 ? 255 : 30)), { width: 40, height: 40 });
  r = await runTool('edit', [plain], {
    objects: [
      { type: 'image', page: 0, x: 0.6, y: 0.6, w: 0.2, h: 0.2, src: `data:image/png;base64,${tiny.toPNG().toString('base64')}` },
      { type: 'highlight', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.05, color: '#ffe066' },
      { type: 'rect', page: 0, x: 0.1, y: 0.7, w: 0.2, h: 0.1, fill: '#000000', stroke: '#000000' },
      { type: 'whiteout', page: 0, x: 0.05, y: 0.65, w: 0.3, h: 0.2 },
      { type: 'path', page: 0, points: [[0.5, 0.1], [0.6, 0.2], [0.7, 0.1]], stroke: '#c00000', width: 5 },
    ],
  });
  const px = r.ok ? pixels(r.display[0], 1, dir) : () => [0, 0, 0];
  const [ir, , ib] = px(0.7, 0.7);
  check('a picture is placed where it was put', ir > 150 && ib < 90, JSON.stringify(px(0.7, 0.7)));
  check('a highlight tints without hiding', (() => { const [hr, hg, hb] = px(0.25, 0.425); return hr > 230 && hg > 200 && hb < 200; })(), JSON.stringify(px(0.25, 0.425)));
  check('white-out covers what is under it', isWhite(px(0.2, 0.75)), JSON.stringify(px(0.2, 0.75)));
  check('a freehand stroke is drawn along its points', isRed(px(0.6, 0.2)));
  r = await runTool('edit', [plain], { objects: [] });
  check('nothing to add is refused with how to add', !r.ok && /בחר כלי/.test(r.error), r.error);

  /* ---- sign ---- */
  console.log('\nSign');
  const contract = await pagesPdf(path.join(dir, 'הסכם.pdf'), [0, 0]);
  const sig = `data:image/png;base64,${tiny.toPNG().toString('base64')}`;
  r = await runTool('sign', [contract], { objects: [{ type: 'image', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.08, src: sig }] });
  check('a visual signature is placed, and the summary says it is visual only', r.ok && /חזותית בלבד/.test(r.summary), r.error || r.summary);

  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const p12 = path.join(dir, 'רון.p12');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=Ron Kalner Test'], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'pass:secret123', ...(opensslLegacy() ? ['-legacy'] : [])], { stdio: 'ignore' });
  r = await runTool('sign', [contract], { objects: [{ type: 'image', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.08, src: sig }], certificate: p12, certPassword: 'secret123' });
  check('with a certificate the file is signed digitally, and the summary says so', r.ok && /דיגיטלית/.test(r.summary), r.error || r.summary);
  if (r.ok) {
    const signed = await fsp.readFile(r.display[0]);
    const verdict = verifySignature(signed, cert, dir);
    check('  the signature verifies with OpenSSL against the certificate, over the whole file but itself', verdict.ok, verdict.detail);
    const tampered = Buffer.from(signed);
    const at = tampered.indexOf(Buffer.from('/Type /Page'));
    tampered[at + 2] = 0x58;
    check('  and fails once a single byte of the file changes', !verifySignature(tampered, cert, dir).ok);
  }
  r = await runTool('sign', [contract], { objects: [{ type: 'image', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.08, src: sig }], certificate: p12, certPassword: 'wrong' });
  check('a wrong certificate password says so', !r.ok && /סיסמה/.test(r.error), r.error);
  const signedOnce = (await runTool('sign', [contract], { objects: [], certificate: p12, certPassword: 'secret123' })).display[0];
  r = await runTool('sign', [signedOnce], { objects: [{ type: 'image', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.08, src: sig }] });
  check('a file already signed digitally is not re-signed, which would break the first signature, and the reason is said', !r.ok && /כבר חתום/.test(r.error), r.error);

  /* ---- forms ---- */
  console.log('\nPDF Forms');
  const formFile = path.join(dir, 'טופס.pdf');
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const form = doc.getForm();
    form.createTextField('name').addToPage(page, { x: 300, y: 700, width: 220, height: 24 });
    form.createCheckBox('agree').addToPage(page, { x: 60, y: 700, width: 16, height: 16 });
    const city = form.createDropdown('city');
    city.addOptions(['חיפה', 'תל אביב']);
    city.addToPage(page, { x: 300, y: 640, width: 220, height: 24 });
    await fsp.writeFile(formFile, await doc.save());
  }
  // Signing a form keeps its fields (the signing library used to drop an indirect list).
  r = await runTool('sign', [formFile], { objects: [], certificate: p12, certPassword: 'secret123' });
  const signedForm = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getForm().getFields().map((f) => f.getName()) : [];
  check('signing a form digitally keeps every one of its fields', ['name', 'agree', 'city'].every((n) => signedForm.includes(n)), signedForm.join(', '));

  const fields = await readFields(formFile);
  const nameField = fields.find((f) => f.name === 'name');
  check('the form\'s fields are read with their types and places', fields.length === 3 && nameField && nameField.type === 'text' &&
    Math.abs(nameField.boxes[0].x - 300 / 595) < 0.01 && Math.abs(nameField.boxes[0].y - (842 - 724) / 842) < 0.01,
    JSON.stringify(fields.map((f) => [f.name, f.type, f.boxes[0] && f.boxes[0].y.toFixed(3)])));
  check('  with the choices of a dropdown', fields.find((f) => f.name === 'city').choices.join() === 'חיפה,תל אביב');
  r = await runTool('forms', [formFile], { values: { name: 'רון קלנר', agree: true, city: 'חיפה' } });
  const filled = r.ok ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getForm() : null;
  check('the values are filled in', filled && filled.getTextField('name').getText() === 'רון קלנר' && filled.getCheckBox('agree').isChecked() && filled.getDropdown('city').getSelected()[0] === 'חיפה', r.error);
  // A field's look is its own small drawing (an annotation appearance), which text
  // extraction does not read; Ghostscript draws it, so the pixels inside the box tell.
  const fpx = r.ok ? pixels(r.display[0], 1, dir) : () => [255, 255, 255];
  const inked = (x0, x1, y) => { for (let x = x0; x <= x1; x += 0.004) if (isDark(fpx(x, y))) return true; return false; };
  check('  and each value is drawn inside its own box, so viewers that do not draw fields still show it',
    inked(0.51, 0.87, (842 - 712) / 842) && inked(0.51, 0.87, (842 - 652) / 842));
  const look = r.ok ? await appearanceText(r.display[0], 'name') : '';
  check('  the drawn Hebrew value reads in order', look === 'רון קלנר', look);
  r = await runTool('forms', [formFile], { values: { name: 'רון קלנר' }, flatten: true });
  const flat = r.ok ? await PDFDocument.load(await fsp.readFile(r.display[0])) : null;
  check('flattening turns the fields into page content', flat && flat.getForm().getFields().length === 0 && (await text.documentText(r.display[0]))[0].includes('רון קלנר'), r.error);
  // A form that asks viewers to draw its fields, with a value already in one of them:
  // filling another must not leave the first blank.
  const asking = path.join(dir, 'טופס שמבקש ציור.pdf');
  {
    const doc = await PDFDocument.load(await fsp.readFile(formFile));
    const form = doc.getForm();
    form.getDropdown('city').select('חיפה');
    form.acroForm.dict.set(require('pdf-lib').PDFName.of('NeedAppearances'), doc.context.obj(true));
    // No drawing for the city yet, as a form filled elsewhere and saved that way would have.
    form.getDropdown('city').acroField.getWidgets()[0].dict.delete(require('pdf-lib').PDFName.of('AP'));
    await fsp.writeFile(asking, await doc.save({ updateFieldAppearances: false }));
  }
  r = await runTool('forms', [asking], { values: { name: 'רון' } });
  const apx = r.ok ? pixels(r.display[0], 1, dir) : () => [255, 255, 255];
  const cityInked = (() => { for (let x = 0.51; x <= 0.87; x += 0.004) if (isDark(apx(x, (842 - 652) / 842))) return true; return false; })();
  check('a value that was already in a field is still shown after another field is filled', r.ok && cityInked, r.error);
  r = await runTool('forms', [asking], { values: { name: 'רון' }, flatten: true });
  check('  and flattening such a form works', r.ok && (await text.documentText(r.display[0]))[0].includes('חיפה'), r.error);

  const rotatedForm = await pagesPdf(path.join(dir, 'טופס מסובב.pdf'), [90]);
  r = await runTool('forms', [rotatedForm], { create: [{ type: 'text', name: 'שם מלא', page: 0, x: 0.2, y: 0.3, w: 0.4, h: 0.05 }] });
  const back = r.ok ? (await readFields(r.display[0]))[0] : null;
  check('a new field on a turned page lands where it was drawn on the shown page', back && back.name === 'שם מלא' &&
    Math.abs(back.boxes[0].x - 0.2) < 0.01 && Math.abs(back.boxes[0].y - 0.3) < 0.01 && Math.abs(back.boxes[0].w - 0.4) < 0.01,
    back ? JSON.stringify(back.boxes[0]) : r.error);
  // On a turned page a filled value must read upright: its ink runs across the field,
  // not down it.
  r = await runTool('forms', [r.display[0]], { values: { 'שם מלא': 'רון קלנר עורך דין' } });
  const rpx = r.ok ? pixels(r.display[0], 1, dir) : () => [255, 255, 255];
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (let x = 0.2; x <= 0.6; x += 0.003) {
    for (let y = 0.3; y <= 0.35; y += 0.002) {
      if (isDark(rpx(x, y))) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
  }
  check('a value in a field on a turned page is drawn upright, running along the field', r.ok && maxX > minX && (maxX - minX) > 3 * (maxY - minY), `${(maxX - minX).toFixed(3)} wide, ${(maxY - minY).toFixed(3)} tall`);

  r = await runTool('forms', [formFile], { create: [{ type: 'text', name: 'name', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
  check('a new field with a taken name is refused, naming it', !r.ok && /name/.test(r.error), r.error);

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
    await until(`document.querySelector('.editor-stage img')`);
  };
  // Like a person, the test first scrolls the spot into view below the sticky tool bar.
  const drag = (from, to) => page(`(() => {
    const stage = document.querySelector('.editor-stage');
    const bar = document.querySelector('.editor-toolbar').getBoundingClientRect();
    const before = stage.getBoundingClientRect();
    window.scrollBy(0, before.top + before.height * ${from[1]} - bar.bottom - 120);
    const r = stage.getBoundingClientRect();
    const o = (p) => ({ bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: r.left + r.width * p[0], clientY: r.top + r.height * p[1] });
    stage.setPointerCapture = () => {};
    const target = document.elementFromPoint(o(${JSON.stringify(from)}).clientX, o(${JSON.stringify(from)}).clientY) || stage;
    target.dispatchEvent(new PointerEvent('pointerdown', o(${JSON.stringify(from)})));
    stage.dispatchEvent(new PointerEvent('pointermove', o(${JSON.stringify(to)})));
    stage.dispatchEvent(new PointerEvent('pointerup', o(${JSON.stringify(to)})));
    return true;
  })()`);
  const objectsNow = () => page(`window.shell.view.perTool.get(window.shell.view.toolId).options.objects`);

  await openTool('edit', [plain]);
  check('Edit: nothing added yet, and the button says how to start', /בחר כלי/.test(await page(`document.getElementById('tool-blocked').textContent`)));
  await page(`document.querySelector('.editor-tool[data-tool="rect"]').click()`);
  await drag([0.1, 0.1], [0.3, 0.2]);
  let objs = await objectsNow();
  check('  dragging with the rectangle tool draws a rectangle there', objs.length === 1 && objs[0].type === 'rect' && Math.abs(objs[0].x - 0.1) < 0.01 && Math.abs(objs[0].w - 0.2) < 0.01, JSON.stringify(objs));
  await page(`document.querySelector('.editor-tool[data-tool="text"]').click()`);
  await drag([0.5, 0.5], [0.5, 0.5]);
  await until(`document.querySelector('.obj-text.editing')`);
  // A hidden window has no keyboard focus, so the typed text is set directly and the
  // editor's own "done editing" handler is run the way a click elsewhere runs it.
  await page(`(() => { const el = document.querySelector('.obj-text.editing'); el.textContent = 'שלום עולם'; el.dispatchEvent(new FocusEvent('blur')); return true; })()`);
  objs = await objectsNow();
  check('  clicking with the text tool and typing adds Hebrew text', objs.some((o) => o.type === 'text' && o.text === 'שלום עולם'), JSON.stringify(objs.map((o) => o.type + ':' + (o.text || ''))));
  // A text box left empty disappears without leaving an undo step behind.
  const stepsBefore = await page(`window.panelHelpers.mem.editor.undoStack.length`);
  await page(`document.querySelector('.editor-tool[data-tool="text"]').click()`);
  await drag([0.5, 0.7], [0.5, 0.7]);
  await until(`document.querySelector('.obj-text.editing')`);
  await page(`(() => { const el = document.querySelector('.obj-text.editing'); el.dispatchEvent(new FocusEvent('blur')); return true; })()`);
  check('  a text box left empty disappears, leaving no undo step', (await page(`window.panelHelpers.mem.editor.undoStack.length`)) === stepsBefore &&
    !(await objectsNow()).some((o) => o.type === 'text' && !o.text));
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  check('  Ctrl+Z takes the last change back', (await objectsNow()).every((o) => o.text !== 'שלום עולם'));
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
  check('  Ctrl+Y puts it back', (await objectsNow()).some((o) => o.text === 'שלום עולם'));
  await drag([0.2, 0.15], [0.4, 0.35]);
  objs = await objectsNow();
  const movedRect = objs.find((o) => o.type === 'rect');
  check('  dragging an object moves it', Math.abs(movedRect.x - 0.3) < 0.02 && Math.abs(movedRect.y - 0.3) < 0.02, JSON.stringify(movedRect));
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  check('  Delete removes the selected object', !(await objectsNow()).some((o) => o.type === 'rect'));
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && !document.getElementById('tool-result').classList.contains('hidden')`, 30000);
  const editedOut = await page(`document.querySelector('#tool-result-outputs .out-name').title`);
  check('  running it writes the text into the file', (await text.documentText(editedOut))[0].includes('שלום עולם'));

  await openTool('sign', [contract]);
  check('Sign: with no saved signature, the gallery says how to make one', /עוד אין חתימות/.test(await page(`document.querySelector('.sig-gallery').textContent`)));
  await page(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent.startsWith('חתימה חדשה')).click()`);
  await until(`document.querySelector('.sig-dialog[open]')`);
  await page(`(() => {
    const c = document.querySelector('.sig-canvas');
    const r = c.getBoundingClientRect();
    const o = (x, y) => ({ bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: r.left + r.width * x, clientY: r.top + r.height * y });
    c.setPointerCapture = () => {};
    c.dispatchEvent(new PointerEvent('pointerdown', o(0.1, 0.5)));
    for (let i = 1; i <= 20; i++) c.dispatchEvent(new PointerEvent('pointermove', o(0.1 + i * 0.04, 0.5 + Math.sin(i) * 0.2)));
    c.dispatchEvent(new PointerEvent('pointerup', o(0.9, 0.5)));
    document.querySelector('.sig-dialog [data-act="save"]').click();
    return true;
  })()`);
  await until(`document.querySelector('.sig-pick.on')`);
  const stored = await signatures.list();
  check('  drawing a signature saves it on this PC and selects it', stored.length === 1 && /^data:image\/png/.test(stored[0].dataUrl));
  await drag([0.6, 0.8], [0.6, 0.8]);
  objs = await objectsNow();
  check('  clicking the page places it there', objs.length === 1 && objs[0].type === 'image' && Math.abs(objs[0].x + objs[0].w / 2 - 0.6) < 0.02, JSON.stringify(objs.map((o) => [o.type, o.x && o.x.toFixed(2)])));
  await page(`(() => { const i = document.querySelector('#tool-options input[type=text]'); i.value = 'עו"ד רון קלנר'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent === 'תאריך').click()`);
  await drag([0.3, 0.9], [0.3, 0.9]);
  objs = await objectsNow();
  const dateObj = objs.find((o) => o.type === 'text');
  check('  "date" places today\'s date', dateObj && /^\d\d\/\d\d\/\d{4}$/.test(dateObj.text), JSON.stringify(dateObj));
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && !document.getElementById('tool-result').classList.contains('hidden')`, 30000);
  check('  signing from the screen writes a visual signature', /חזותית/.test(await page(`document.getElementById('tool-result-title').textContent`)));
  const history = fs.readFileSync(runs.storeFile(), 'utf8');
  check('  and the signature picture is not kept in the run history', history.includes('"sign"') && !/data:image\/png;base64/.test(history));

  await Promise.all([signatures.save({ dataUrl: sig, kind: 'draw' }), signatures.save({ dataUrl: sig, kind: 'type' })]);
  check('two signatures saved at the same moment are both kept', (await signatures.list()).length === 3);
  fs.writeFileSync(signatures.storeFile(), '{ broken');
  let lost = null;
  try { await signatures.save({ dataUrl: sig, kind: 'draw' }); } catch (e) { lost = e; }
  check('a damaged signature file is reported, never overwritten with nothing', lost && /פגום/.test(lost.message) && fs.readFileSync(signatures.storeFile(), 'utf8') === '{ broken');

  await openTool('forms', [formFile]);
  await until(`document.querySelectorAll('#tool-options .field-row').length === 3`);
  check('Forms: every field is listed to fill', (await page(`document.querySelectorAll('#tool-options .field-row').length`)) === 3);
  check('  and outlined on the page', (await page(`document.querySelectorAll('.form-box').length`)) === 3);
  await page(`(() => {
    const rows = [...document.querySelectorAll('#tool-options .field-row')];
    const byName = (n) => rows.find((r) => r.querySelector('.field-name').textContent === n);
    const t = byName('name').querySelector('input'); t.value = 'רותם'; t.dispatchEvent(new Event('input', { bubbles: true }));
    const c = byName('agree').querySelector('input'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    const s = byName('city').querySelector('select'); s.value = 'תל אביב'; s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await page(`document.querySelector('.editor-tool[data-tool="field-text"]').click()`);
  await drag([0.1, 0.5], [0.4, 0.55]);
  check('  drawing with the field tool adds a named field to the list', (await page(`document.querySelectorAll('#tool-options .field-list')[1].querySelectorAll('.field-row').length`)) === 1);
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && !document.getElementById('tool-result').classList.contains('hidden')`, 30000);
  const formOut = await page(`document.querySelector('#tool-result-outputs .out-name').title`);
  const fo = (await PDFDocument.load(await fsp.readFile(formOut))).getForm();
  check('  running it fills the values and adds the field', fo.getTextField('name').getText() === 'רותם' && fo.getCheckBox('agree').isChecked() &&
    fo.getDropdown('city').getSelected()[0] === 'תל אביב' && fo.getFields().length === 4);
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

/** The text a field's own drawing holds, read by drawing it alone on a page. */
async function appearanceText(file, name) {
  const doc = await PDFDocument.load(await fsp.readFile(file));
  const widget = doc.getForm().getTextField(name).acroField.getWidgets()[0];
  const ap = widget.getNormalAppearance();
  const out = await PDFDocument.create();
  const page = out.addPage([400, 100]);
  const [embedded] = await out.embedPdf(await (async () => {
    // Put the appearance on a page of its own by copying it into a one-page document.
    const one = await PDFDocument.create();
    const p = one.addPage([400, 100]);
    const copied = one.context.register(await copyObject(doc, one, ap));
    p.node.set(require('pdf-lib').PDFName.of('Resources'), one.context.obj({ XObject: { A: copied } }));
    p.pushOperators(require('pdf-lib').drawObject('A'));
    return one.save();
  })());
  page.drawPage(embedded);
  const tmp = path.join(os.tmpdir(), `ap-${Date.now()}.pdf`);
  await fsp.writeFile(tmp, await out.save());
  const words = (await text.documentText(tmp))[0].trim();
  await fsp.rm(tmp, { force: true });
  return words;
}

async function copyObject(from, to, obj) {
  const { PDFObjectCopier } = require('pdf-lib');
  return PDFObjectCopier.for(from.context, to.context).copy(from.context.lookup(obj));
}

/** OpenSSL 3 needs -legacy to write a .p12 that older readers (and node-forge) accept. */
function opensslLegacy() {
  try {
    return /OpenSSL 3/.test(execFileSync('openssl', ['version'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

/** Cut the signed bytes and the PKCS#7 signature out of the file and verify with OpenSSL. */
function verifySignature(bytes, certFile, dir) {
  const s = bytes.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(s);
  if (!m) return { ok: false, detail: 'no /ByteRange' };
  const [a, b, c, d] = m.slice(1).map(Number);
  if (c + d !== bytes.length) return { ok: false, detail: 'the signature does not cover the whole file' };
  const signed = Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);
  if (a !== 0) return { ok: false, detail: 'the signed range does not start at the beginning of the file' };
  // The signature is padded with zeros; its own length is in its DER header.
  const padded = Buffer.from(s.slice(a + b + 1, c - 1), 'hex');
  const len = padded[1] & 0x80 ? padded.subarray(2, 2 + (padded[1] & 0x7f)).reduce((n, x) => n * 256 + x, 0) + 2 + (padded[1] & 0x7f) : padded[1] + 2;
  const der = padded.subarray(0, len);
  const content = path.join(dir, 'signed.bin');
  const sig = path.join(dir, 'sig.der');
  fs.writeFileSync(content, signed);
  fs.writeFileSync(sig, der);
  try {
    execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER', '-in', sig, '-content', content, '-certfile', certFile, '-CAfile', certFile, '-out', path.join(dir, 'verified.bin')], { stdio: 'pipe' });
    return { ok: true, detail: '' };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message).split('\n')[0] };
  }
}
