'use strict';

/**
 * The page tools' screens, driven in the real window: selection with Ctrl and Shift,
 * Delete and Ctrl+Z, dragging a page to a new place, dragging the crop frame, and
 * each tool's own button. Results are read back from disk.
 * Launch with:  npx electron test/page-panels.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { openWindow } = require('./helpers/window');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const { registerIpc } = require('../src/main/ipc');
const runs = require('../src/main/runs');
const text = require('../src/main/pdf/text');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

/** Pages 500, 510, 520 ... wide, each with a dark box in the middle third. */
async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const w = 500 + i * 10;
    const page = doc.addPage([w, 800]);
    page.drawRectangle({ x: w * 0.25, y: 200, width: w * 0.5, height: 400, color: rgb(0.15, 0.15, 0.15) });
    page.drawText(`Page ${i + 1}`, { x: w * 0.3, y: 640, size: 24, font });
  }
  await fsp.writeFile(file, await doc.save());
  return file;
}
const widths = async (file) => (await PDFDocument.load(await fsp.readFile(file))).getPages().map((p) => Math.round(p.getSize().width));
const rotations = async (file) => (await PDFDocument.load(await fsp.readFile(file))).getPages().map((p) => p.getRotation().angle);

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'page-panels-'));
  runs.setStoreFile(path.join(dir, 'runs.json'));
  registerIpc();
  const eight = await makePdf(path.join(dir, 'שמונה.pdf'), 8);

  const win = await openWindow();
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = (ms = 120) => run(`new Promise(r => setTimeout(r, ${ms}))`);
  const until = async (code, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await run(code)) return true;
      await settle(80);
    }
    return false;
  };
  const text$ = (sel) => run(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  const disabled = (sel) => run(`!!(document.querySelector(${JSON.stringify(sel)}) || {}).disabled`);
  const press = (sel, mods = {}) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ...${JSON.stringify(mods)} };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 'ok';
  })()`);
  const card = (n) => `.page-grid .page-card:nth-child(${n})`;
  const key = (target, k, mods = {}) => run(`document.querySelector(${JSON.stringify(target)}).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...mods })}))`);
  const typeInto = (sel, value) => run(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const open = async (id, files = [eight]) => {
    await run(`window.shell.goHome()`);
    await run(`(async () => { const r = await window.api.describeFiles(${JSON.stringify(files)}); window.shell.open('${id}', { files: r.files }); })()`);
    await until(`document.body.dataset.screen === 'tool'`);
  };
  const runTool = async () => {
    await press('#tool-run');
    await until(`!window.shell.busy() && (!document.getElementById('tool-result').classList.contains('hidden') || !document.getElementById('tool-error').classList.contains('hidden'))`, 60000);
    const error = (await run(`document.getElementById('tool-error').classList.contains('hidden')`)) ? '' : await text$('#tool-error');
    const out = await run(`[...document.querySelectorAll('#tool-result-outputs .out-name')].map(n => n.title)`);
    return { error, out };
  };
  const thumbsDrawn = (n) => until(`document.querySelectorAll('.page-grid .page-inner img').length >= ${n}`);

  /* ---- split ---- */
  console.log('\nsplit');
  await open('split');
  check('the page grid shows every page', (await run(`document.querySelectorAll('.page-grid .page-card').length`)) === 8);
  check('  with thumbnails', await thumbsDrawn(8));
  check('no ranges yet: the button says what to write', (await disabled('#tool-run')) && /כתוב את הטווחים/.test(await text$('#tool-blocked')));
  await typeInto('#tool-options input[type=text]', '1-2, 3-8');
  check('typing ranges previews the files', /ייווצרו 2 קבצים/.test(await text$('#tool-options .opt-preview')), await text$('#tool-options .opt-preview'));
  const badges = await run(`[...document.querySelectorAll('.page-grid .page-badge')].map(b => b.textContent)`);
  check('  and labels each page with its file', badges[0] === 'קובץ 1' && badges[2] === 'קובץ 2' && badges.length === 8, badges.join(','));
  await typeInto('#tool-options input[type=text]', '1-12');
  check('a page beyond the end is explained, in Hebrew, and blocks the run',
    (await disabled('#tool-run')) && /8 עמודים/.test(await text$('#tool-blocked')), await text$('#tool-blocked'));
  await typeInto('#tool-options input[type=text]', '1-2, 3-8');
  let res = await runTool();
  check('running writes the parts into a folder and shows the folder', !res.error && res.out.length === 1 && fs.existsSync(res.out[0]) && fs.statSync(res.out[0]).isDirectory(), res.error || res.out.join());

  await press('#tool-options .seg[data-value="extract"]');
  await until(`document.querySelector('.page-grid')`);
  await press(card(2));
  await press(card(4), { ctrlKey: true });
  await press(card(6), { shiftKey: true, ctrlKey: true });
  const field = await run(`document.querySelector('#tool-options input[type=text]').value`);
  check('clicking, Ctrl+clicking and Shift+clicking pages fills in the page list', field === '2, 4-6', field);
  check('  and selected pages are marked', (await run(`document.querySelectorAll('.page-card.selected').length`)) === 4);
  await typeInto('#tool-options input[type=text]', '1, 8');
  check('typing the list selects those pages in the grid', (await run(`[...document.querySelectorAll('.page-card.selected .page-caption')].map(c => c.textContent).join()`)) === '1,8');
  await key('.page-grid', 'Escape');
  check('Esc clears the selection first, and stays on the screen', (await run('document.body.dataset.screen')) === 'tool' && (await run(`document.querySelectorAll('.page-card.selected').length`)) === 0);
  await press(card(3));
  res = await runTool();
  check('extracting writes one file with that page', !res.error && res.out.length === 1 && (await widths(res.out[0])).join() === '520', res.error || res.out.join());

  /* ---- organize ---- */
  console.log('\norganize');
  await open('organize');
  await thumbsDrawn(8);
  check('nothing changed: the button says so', (await disabled('#tool-run')) && /עוד לא שונה/.test(await text$('#tool-blocked')));
  check('actions on the selection are off until pages are chosen', await disabled('#tool-options button[title^="בחר קודם"]'));
  await press(card(1));
  await press(card(3), { shiftKey: true });
  check('Shift selects the range between', (await run(`document.querySelectorAll('.page-card.selected').length`)) === 3);
  await key('.page-grid', 'Delete');
  check('Delete removes the selected pages', (await run(`document.querySelectorAll('.page-grid .page-card').length`)) === 5);
  check('  and the count says so', /3 עמודים הוסרו/.test(await run(`[...document.querySelectorAll('#tool-options .opt-preview')].map(p => p.textContent).join(' ')`)));
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  check('Ctrl+Z brings them back', (await run(`document.querySelectorAll('.page-grid .page-card').length`)) === 8);

  await press(card(2));
  await run(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent.includes('ימינה')).click()`);
  check('turning a page shows it turned', (await run(`document.querySelector('${card(2)} .page-inner').style.transform`)) === 'rotate(90deg)');

  // Drag page 8 to before page 1: dragstart on 8, dragover and drop on the right half of 1.
  await run(`(() => {
    const cards = document.querySelectorAll('.page-grid .page-card');
    const from = cards[7], to = cards[0];
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = to.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 5, clientY: r.top + 20 };
    to.dispatchEvent(new DragEvent('dragover', at));
    to.dispatchEvent(new DragEvent('drop', at));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  })()`);
  const order = await run(`[...document.querySelectorAll('.page-grid .page-card')].map(c => c.dataset.key.split(':')[1])`);
  check('dragging a page moves it to where it was dropped', order[0] === '7' && order[1] === '0', order.join(','));

  await run(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent === 'עמוד ריק').click()`);
  await until(`document.querySelectorAll('.page-grid .page-card').length === 9`);
  check('a blank page is inserted after the selection (the page just dragged)', (await run(`!!document.querySelector('.page-inner.blank')`)));
  res = await runTool();
  const ow = res.out[0] ? await widths(res.out[0]) : [];
  check('the result has the new order, the blank page, and the turn',
    // 8 dragged first, then the blank page sized like it, then 1, then 2 turned.
    !res.error && ow.join() === '570,570,500,510,520,530,540,550,560' && (await rotations(res.out[0])).join() === '0,0,0,90,0,0,0,0,0',
    res.error || `${ow.join()} / ${(res.out[0] ? await rotations(res.out[0]) : []).join()}`);

  // Undo after "back to the original order" once pages from another file were inserted:
  // the inserted file must come back with the order.
  await open('organize');
  await thumbsDrawn(8);
  const other = await makePdf(path.join(dir, 'אחר.pdf'), 2);
  await run(`window.shell.setPicker(async () => ({ ok: true, files: (await window.api.describeFiles([${JSON.stringify(other)}])).files })); true`);
  // The screen keeps the arrangement left from before, so count from what is there.
  const startCount = await run(`document.querySelectorAll('.page-grid .page-card').length`);
  await press(card(1));
  await run(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent.startsWith('עמודים מקובץ אחר')).click()`);
  await until(`document.querySelectorAll('.page-grid .page-card').length === ${startCount + 2}`);
  await run(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent === 'חזרה לסדר המקורי').click()`);
  await until(`document.querySelectorAll('.page-grid .page-card').length === 8`);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await settle(300);
  const back = await run(`({ cards: document.querySelectorAll('.page-grid .page-card').length, inserted: document.querySelectorAll('.page-badge').length, extra: window.shell.view.perTool.get('organize').options.extra.length })`);
  check('undo after "back to the original order" brings the inserted pages back, working', back.cards === startCount + 2 && back.inserted === 2 && back.extra === 1, JSON.stringify({ ...back, startCount }));
  await run(`window.shell.setPicker((spec) => window.api.pickFiles(spec)); true`);
  check('  with no errors on the way', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 2).join(' / '));

  /* ---- rotate ---- */
  console.log('\nrotate');
  await open('rotate');
  await thumbsDrawn(8);
  check('with nothing chosen, every page will turn', /כל העמודים יסובבו/.test(await text$('#tool-options .opt-preview')));
  await press(card(5));
  check('choosing a page says only it turns', /5/.test(await text$('#tool-options .opt-preview')), await text$('#tool-options .opt-preview'));
  await press('#tool-options .seg[data-value="180"]');
  res = await runTool();
  check('only that page turns, by the chosen angle', !res.error && (await rotations(res.out[0])).join() === '0,0,0,0,180,0,0,0', res.error);

  /* ---- crop ---- */
  console.log('\ncrop');
  await open('crop');
  await until(`document.querySelector('.crop-stage img')`);
  check('nothing marked: the button explains how to mark', (await disabled('#tool-run')) && /גרור את קצוות/.test(await text$('#tool-blocked')));
  const moved = await run(`(() => {
    const stage = document.querySelector('.crop-stage');
    const box = stage.querySelector('.crop-box');
    const handle = box.querySelector('.h-n');
    const r = stage.getBoundingClientRect();
    const o = (y) => ({ bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: r.left + r.width / 2, clientY: y });
    box.setPointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent('pointerdown', o(r.top)));
    box.dispatchEvent(new PointerEvent('pointermove', o(r.top + r.height * 0.1)));
    box.dispatchEvent(new PointerEvent('pointerup', o(r.top + r.height * 0.1)));
    return window.shell.view.perTool.get('crop').options.margins.top;
  })()`);
  check('dragging the top edge down marks the top to cut', Math.abs(moved - 0.1) < 0.01, String(moved));
  await until(`/למעלה \\d+ מ"מ/.test(document.querySelector('#tool-options .opt-preview.muted').textContent)`);
  check('  and the cut is said in millimetres', /למעלה 28 מ"מ/.test(await text$('#tool-options .opt-preview.muted')), await text$('#tool-options .opt-preview.muted'));
  await run(`[...document.querySelectorAll('#tool-options button')].find(b => b.textContent === 'זיהוי שוליים').click()`);
  await until(`window.shell.view.perTool.get('crop').options.margins.left > 0.1`);
  const m = await run(`window.shell.view.perTool.get('crop').options.margins`);
  check('"find margins" finds the white space around the content', m.left > 0.2 && m.left < 0.26 && m.right > 0.2 && m.top > 0.12 && m.bottom > 0.2, JSON.stringify(m));
  res = await runTool();
  const cropped = res.out[0] ? (await PDFDocument.load(await fsp.readFile(res.out[0]))).getPage(0).getCropBox() : null;
  check('the result is cropped to about the content', !res.error && cropped && cropped.width < 300 && cropped.width > 240, res.error || JSON.stringify(cropped));

  /* ---- page numbers ---- */
  console.log('\npage numbers');
  await open('page-numbers');
  await until(`document.querySelector('.preview-stage .stamp')`);
  await press('#tool-options .pos[data-value="top-right"]');
  await press('#tool-options .seg[data-value="page-n-of"]');
  await settle(300);
  check('the preview shows the number as it will be written', (await text$('.preview-stage .stamp')) === 'עמוד 1 מתוך 8', await text$('.preview-stage .stamp'));
  await press('#tool-options .seg[data-value="skip-first"]');
  await until(`document.querySelectorAll('.preview-stage').length === 2`);
  await settle(400);
  const stamps = await run(`[...document.querySelectorAll('.preview-stage')].map(s => (s.querySelector('.stamp') || {}).textContent || '')`);
  check('skipping the first page shows no number on it and 1 on the second', stamps[0] === '' && stamps[1] === 'עמוד 1 מתוך 7', stamps.join(' | '));
  await run(`(() => { const i = document.querySelector('#tool-options input[type=number]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('an empty first number blocks the run, even with pages chosen', (await disabled('#tool-run')) && /המספר הראשון/.test(await text$('#tool-blocked')), await text$('#tool-blocked'));
  await run(`(() => { const i = document.querySelector('#tool-options input[type=number]'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  res = await runTool();
  const lines = res.out[0] ? await (async () => {
    const d = await text.open(res.out[0]);
    const page2 = await text.pageLines(d, 2);
    await d.destroy();
    return page2;
  })() : null;
  const num = lines && lines.lines.find((l) => l.text.startsWith('עמוד'));
  check('the file has it at the top right of the second page', num && num.text === 'עמוד 1 מתוך 7' && num.right / lines.width > 0.85 && num.y / lines.height < 0.1,
    res.error || (num ? `${num.text} ${(num.right / lines.width).toFixed(2)},${(num.y / lines.height).toFixed(2)}` : 'missing'));

  /* ---- watermark ---- */
  console.log('\nwatermark');
  await open('watermark');
  check('empty text: the button asks for it', (await disabled('#tool-run')) && /כתוב את הטקסט/.test(await text$('#tool-blocked')));
  await typeInto('#tool-options input[type=text]', 'חסוי');
  await until(`document.querySelector('.preview-stage .mark')`);
  check('the preview shows the watermark', (await text$('.preview-stage .mark')) === 'חסוי');
  res = await runTool();
  const wl = res.out[0] ? await (async () => {
    const d = await text.open(res.out[0]);
    const p = await text.pageLines(d, 4);
    await d.destroy();
    return p.lines.map((l) => l.text);
  })() : [];
  check('every page carries it', !res.error && wl.includes('חסוי'), res.error || wl.join(' / '));

  /* ---- markdown and repair ---- */
  console.log('\nMarkdown and repair');
  await open('pdf-to-markdown');
  res = await runTool();
  check('PDF to Markdown writes a .md file', !res.error && /\.md$/.test(res.out[0] || ''), res.error);
  await open('repair');
  res = await runTool();
  check('repair writes a repaired copy and says what it found', !res.error && /לא נמצא פגם/.test(await text$('#tool-result-title')), res.error || await text$('#tool-result-title'));

  console.log('\nthe page');
  check('no errors in the page console', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 3).join(' / '));

  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
