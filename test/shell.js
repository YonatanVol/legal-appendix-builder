'use strict';

/**
 * The tool grid and the shared tool screen, driven in the real window.
 * Launch with:  npx electron test/shell.js
 *
 * Needs no client documents: every PDF is generated here, so this suite runs on a
 * fresh clone. Presses are real pointer sequences on the controls, not direct calls,
 * because a listener that never receives the press is what a direct call cannot see.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { openWindow } = require('./helpers/window');

const { PDFDocument, StandardFonts } = require('pdf-lib');
const { registerIpc } = require('../src/main/ipc');
const runs = require('../src/main/runs');
const jobs = require('../src/main/jobs');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

/** A PDF whose pages all have `width` points, so order can be read back from sizes. */
async function makePdf(file, pages, width, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([width, 800]);
    page.drawText(`${label} page ${i + 1}`, { x: 40, y: 740, size: 24, font });
    page.drawRectangle({ x: 40, y: 80, width: width - 80, height: 600, borderWidth: 2 });
  }
  await fsp.writeFile(file, await doc.save());
  return file;
}

async function pageWidths(file) {
  const doc = await PDFDocument.load(await fsp.readFile(file));
  return doc.getPages().map((p) => Math.round(p.getSize().width));
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-shell-'));
  runs.setStoreFile(path.join(scratch, 'runs.json'));
  require('../src/main/settings').setStoreFile(path.join(scratch, 'settings.json'));
  registerIpc();

  const docs = path.join(scratch, 'מסמכים');
  await fsp.mkdir(docs);
  const A = await makePdf(path.join(docs, 'כתב הגנה.pdf'), 2, 500, 'A');
  const B = await makePdf(path.join(docs, 'נספח ב.pdf'), 3, 520, 'B');
  const C = await makePdf(path.join(docs, 'Exhibit C.pdf'), 1, 540, 'C');
  const D = await makePdf(path.join(docs, 'פרוטוקול מיום 07-07-26.pdf'), 1, 560, 'D');
  const BAD = path.join(docs, 'פגום.pdf');
  await fsp.writeFile(BAD, '%PDF-1.7\nthis is not a pdf at all');
  const TXT = path.join(docs, 'notes.txt');
  await fsp.writeFile(TXT, 'hello');

  const win = await openWindow();
  const errors = win.consoleErrors;

  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = (ms = 120) => run(`new Promise(r => setTimeout(r, ${ms}))`);
  const until = async (code, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await run(code)) return true;
      await settle(60);
    }
    return false;
  };
  const press = (selector) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    if (el.disabled) return 'disabled';
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.click();
    return 'ok';
  })()`);
  const key = (k, extra = {}) => run(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}))`);
  const text = (selector) => run(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
  const hidden = (id) => run(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const describe = (paths) => run(`window.api.describeFiles(${JSON.stringify(paths)}).then(r => r.files)`);

  /* ---- the grid ---- */
  console.log('\nthe grid');
  const grid = await run(`({
    tiles: document.querySelectorAll('.tile').length,
    groups: document.querySelectorAll('.tool-group').length,
    merge: !document.querySelector('.tile[data-tool="merge"]').classList.contains('unavailable'),
    appendix: !document.querySelector('.tile[data-tool="appendix"]').classList.contains('unavailable'),
    ...(() => {
      const t = [...document.querySelectorAll('.tile.unavailable')].find((x) => (x.querySelector('.tile-soon') || {}).textContent === 'בקרוב');
      return { soonId: t ? t.dataset.tool : null, split: t ? t.querySelector('.tile-soon').textContent : '', splitDesc: t ? t.querySelector('.tile-desc').textContent : '' };
    })(),
    firstTile: document.querySelector('.tile').dataset.tool,
    removed: ['jpg-to-pdf', 'html-to-pdf', 'compare'].filter(id => document.querySelector('.tile[data-tool="' + id + '"]')),
    cloud: document.querySelectorAll('.tile .tile-cloud').length,
    screen: document.body.dataset.screen,
    back: document.getElementById('nav-back').classList.contains('hidden'),
  })`);
  check('the home screen shows every tool', grid.tiles === 30, `${grid.tiles} tiles`);
  check('  in eight groups', grid.groups === 8, String(grid.groups));
  check('  without the three tools that were crossed out', grid.removed.length === 0, grid.removed.join(', '));
  check('merge and the appendix builder are available', grid.merge && grid.appendix);
  const soon = grid.soonId;
  if (soon) {
    check('a tool not built yet is marked "soon" on its tile', grid.split === 'בקרוב', `${soon}: ${grid.split}`);
    check('  and still says what it will do', (grid.splitDesc || '').length > 10, grid.splitDesc);
  }
  check('the appendix builder is the first tile', grid.firstTile === 'appendix', grid.firstTile);
  check('the two cloud tools are marked as cloud', grid.cloud === 2, String(grid.cloud));
  check('home has no back button', grid.screen === 'home' && grid.back);
  check('the shared page-range parser loaded', await run(`typeof window.pageRanges === 'object' && typeof window.pageRanges.parseRanges === 'function'`));

  await run(`(() => { const s = document.getElementById('home-search'); s.value = 'כיווץ'; s.dispatchEvent(new Event('input')); })()`);
  const found = await run(`[...document.querySelectorAll('.tile')].map(t => t.dataset.tool)`);
  check('search narrows the grid', found.length === 1 && found[0] === 'compress', found.join(', '));
  await run(`(() => { const s = document.getElementById('home-search'); s.value = 'zzz'; s.dispatchEvent(new Event('input')); })()`);
  check('  and says so when nothing matches', !(await hidden('home-none')));
  await key('Escape');
  check('Esc clears the search', (await run(`document.querySelectorAll('.tile').length`)) === 30);

  /* ---- a tool that is not built yet ---- */
  console.log('\na tool not built yet');
  if (soon) {
    await press(`.tile[data-tool="${soon}"]`);
    check('opens with a notice saying why', !(await hidden('tool-unavailable')) && /עדיין לא זמין/.test(await text('#tool-unavailable')));
    check('  and its button stays disabled with the same reason',
      (await run(`document.getElementById('tool-run').disabled`)) && /עדיין לא זמין/.test(await text('#tool-blocked')));
    await press('#nav-back');
  } else {
    await press('.tile[data-tool="merge"]');
    await press('#nav-back');
  }
  check('the back button returns home', (await run('document.body.dataset.screen')) === 'home');

  /* ---- merge ---- */
  console.log('\nmerge');
  await press('.tile[data-tool="merge"]');
  check('the tool screen opens with its name in the header',
    (await run('document.body.dataset.screen')) === 'tool' && (await text('#screen-name')) === 'איחוד PDF');
  check('nothing chosen: the button is disabled and says why',
    (await run(`document.getElementById('tool-run').disabled`)) && /בחר קבצים/.test(await text('#tool-blocked')));

  await run(`window.shell.addFiles(${JSON.stringify(await describe([A]))})`);
  check('one file: the reason names what is missing', /עוד קובץ/.test(await text('#tool-blocked')), await text('#tool-blocked'));

  await run(`window.shell.addFiles(${JSON.stringify(await describe([B, C, A]))})`);
  const rows = await run(`[...document.querySelectorAll('#tool-file-list .file-row .file-name')].map(n => n.textContent)`);
  check('files are added once each, in the order given', rows.join('|') === 'כתב הגנה.pdf|נספח ב.pdf|Exhibit C.pdf', rows.join(' | '));
  check('  with page counts', /2 עמודים/.test(await text('#tool-file-list .file-row .file-meta')));
  check('  and a count above the list', /3 קבצים · 6 עמודים/.test(await text('#tool-file-count')), await text('#tool-file-count'));
  check('the button is enabled with no reason', !(await run(`document.getElementById('tool-run').disabled`)) && (await text('#tool-blocked')) === '');

  const thumbs = await until(`document.querySelectorAll('#tool-file-list .file-thumb img').length === 3`);
  const thumbSize = await run(`[...document.querySelectorAll('#tool-file-list .file-thumb img')].map(i => i.naturalWidth)`);
  check('every row shows a thumbnail of its first page', thumbs && thumbSize.every((w) => w > 40), thumbSize.join(', '));

  await run(`window.shell.addFiles(${JSON.stringify(await describe([D]))})`);
  const order = await run(`[...document.querySelectorAll('#tool-file-list .file-name')].map(n => {
    const stem = n.querySelector('.name-stem').getBoundingClientRect();
    const ext = n.querySelector('.name-ext').getBoundingClientRect();
    const size = n.parentElement.querySelector('.file-meta bdi[dir=ltr]');
    return { name: n.title, extLeftOfStem: ext.right <= stem.left + 1, extRightOfStem: ext.left >= stem.right - 1, size: size ? size.textContent : '' };
  })`);
  const heb = order.find((o) => o.name.startsWith('פרוטוקול'));
  const lat = order.find((o) => o.name === 'Exhibit C.pdf');
  check('a Hebrew name ending in a date keeps ".pdf" at its end, on the left', heb && heb.extLeftOfStem, JSON.stringify(heb));
  check('a Latin name keeps ".pdf" at its end, on the right', lat && lat.extRightOfStem, JSON.stringify(lat));
  check('a size reads "1 KB", not "KB 1"', order.every((o) => /^\d[\d.]* (KB|MB)$/.test(o.size)), order.map((o) => o.size).join(', '));
  await press('#tool-file-list .file-row:nth-child(4) button[aria-label="הסר מהרשימה"]');

  await press('#tool-file-list .file-row:nth-child(1) button[aria-label="הזז למטה"]');
  const moved = await run(`[...document.querySelectorAll('#tool-file-list .file-name')].map(n => n.textContent)`);
  check('moving a row down changes the order', moved[0] === 'נספח ב.pdf' && moved[1] === 'כתב הגנה.pdf', moved.join(' | '));
  await press('#tool-file-list .file-row:nth-child(2) button[aria-label="הזז למעלה"]');

  await run(`window.shell.addFiles(${JSON.stringify(await describe([TXT]))})`);
  check('a file of the wrong type is refused with the reason', /notes\.txt/.test(await text('#tool-error')) && /PDF/.test(await text('#tool-error')));
  check('  and is not added', (await run(`document.querySelectorAll('#tool-file-list .file-row').length`)) === 3);

  await run(`window.shell.addFiles(${JSON.stringify(await describe([BAD]))})`);
  check('a damaged file is listed with its problem', /פגום/.test(await text('#tool-file-list .file-row.bad .file-error')));
  check('  and blocks the run, naming it', (await run(`document.getElementById('tool-run').disabled`)) && /פגום\.pdf/.test(await text('#tool-blocked')));
  await press('#tool-file-list .file-row.bad button[aria-label="הסר מהרשימה"]');
  check('removing it unblocks the run', !(await run(`document.getElementById('tool-run').disabled`)));

  await press('#tool-run');
  await until(`!document.getElementById('tool-result').classList.contains('hidden') || !document.getElementById('tool-error').classList.contains('hidden')`);
  const expected = path.join(docs, 'כתב הגנה - מאוחד.pdf');
  check('the run finishes with a result card', !(await hidden('tool-result')), await text('#tool-error'));
  check('  saying what was made', /6 עמודים/.test(await text('#tool-result-title')), await text('#tool-result-title'));
  check('the result is next to the first file, named after it', fs.existsSync(expected));
  check('  with every page in the chosen order',
    fs.existsSync(expected) && (await pageWidths(expected)).join(',') === '500,500,520,520,520,540',
    fs.existsSync(expected) ? (await pageWidths(expected)).join(',') : 'missing');
  check('  and it lists the output with open and show buttons',
    (await run(`document.querySelectorAll('#tool-result-outputs li button').length`)) === 2);
  const chips = await run(`[...document.querySelectorAll('#tool-continue-chips .chip')].map(c => c.dataset.tool)`);
  check('the result offers other tools to continue with, not the same one', !(await hidden('tool-continue')) && chips.includes('page-numbers') && !chips.includes('merge'), chips.join(', '));
  await press('#tool-continue-chips .chip[data-tool="page-numbers"]');
  await until(`document.querySelector('#screen-name').textContent === 'מספרי עמודים' && document.querySelectorAll('#tool-file-list .file-row').length === 1`);
  check('  and continuing opens that tool with the result already in it',
    (await text('#screen-name')) === 'מספרי עמודים' && (await run(`document.querySelector('#tool-file-list .file-name').title`)) === 'כתב הגנה - מאוחד.pdf');
  await press('#nav-back');
  await press('.tile[data-tool="merge"]');

  await press('#tool-run');
  await until(`!document.getElementById('tool-result').classList.contains('hidden')`);
  check('running again never overwrites: the second result is numbered',
    fs.existsSync(path.join(docs, 'כתב הגנה - מאוחד (2).pdf')));

  await run(`(() => { const i = document.querySelector('#tool-options input[type=text]'); i.value = 'תיק מאוחד: סופי'; i.dispatchEvent(new Event('input')); })()`);
  await press('#tool-run');
  await until(`!document.getElementById('tool-result').classList.contains('hidden')`);
  check('a chosen name is used, with characters Windows forbids replaced',
    fs.existsSync(path.join(docs, 'תיק מאוחד סופי.pdf')), (await fsp.readdir(docs)).join(', '));
  await run(`(() => { const i = document.querySelector('#tool-options input[type=text]'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

  /* ---- cancelling ---- */
  console.log('\ncancelling');
  const big1 = await makePdf(path.join(docs, 'גדול 1.pdf'), 1200, 500, 'X');
  const big2 = await makePdf(path.join(docs, 'גדול 2.pdf'), 1200, 500, 'Y');
  await press('#tool-clear');
  await run(`window.shell.addFiles(${JSON.stringify(await describe([big1, big2]))})`);
  const before = (await fsp.readdir(docs)).length;
  await run(`window.shell.run(); true`);
  check('while running, a progress bar shows with a cancel button', !(await hidden('tool-progress')));
  check('  the controls are locked', await run(`document.getElementById('tool-file-list').classList.contains('locked')`));
  check('  and Esc does not leave the screen', (await run('document.body.dataset.screen')) === 'tool');
  await key('Escape');
  await until(`!window.shell.busy()`, 30000);
  check('Esc cancels the run and says nothing was saved', /בוטלה/.test(await text('#tool-error')), await text('#tool-error'));
  check('  and no file is left behind', (await fsp.readdir(docs)).length === before, (await fsp.readdir(docs)).join(', '));
  check('  and the screen is usable again', !(await run(`document.getElementById('tool-run').disabled`)));

  /* ---- a one-file tool keeps its file when a wrong one is dropped ---- */
  await run(`window.shell.goHome()`);
  await press('.tile[data-tool="split"]');
  await run(`window.shell.addFiles(${JSON.stringify(await describe([A]))})`);
  await run(`window.shell.addFiles(${JSON.stringify(await describe([TXT]))})`);
  const kept = await run(`[...document.querySelectorAll('#tool-file-list .file-name')].map(n => n.textContent)`);
  check('a file of the wrong type dropped on a one-file tool is refused, and the file already chosen stays',
    kept.length === 1 && kept[0] === path.basename(A) && /notes\.txt/.test(await text('#tool-error')), `${kept.join(' | ')} / ${await text('#tool-error')}`);
  await run(`window.shell.goHome()`);

  /* ---- home again: recent runs and dropped files ---- */
  console.log('\nback home');
  await key('Escape');
  check('Esc returns home when nothing is running', (await run('document.body.dataset.screen')) === 'home');
  await until(`!document.getElementById('recent').classList.contains('hidden')`);
  const recent = await run(`({
    rows: document.querySelectorAll('#recent-list .recent-item').length,
    first: document.querySelector('#recent-list .recent-title').textContent,
    again: [...document.querySelectorAll('#recent-list .recent-item:first-child button')].map(b => b.textContent),
  })`);
  check('recent runs are listed, newest first', recent.rows === 3 && recent.first === 'איחוד PDF', JSON.stringify(recent));
  check('  each can be opened, shown, or run again', ['פתח', 'בתיקייה', 'שוב'].every((l) => recent.again.includes(l)), recent.again.join(', '));
  check('  and the cancelled run is not among them', recent.rows === 3);

  await press('#recent-list .recent-item:nth-child(2) button[title^="פתח את הכלי"]');
  await until(`document.body.dataset.screen === 'tool' && document.querySelectorAll('#tool-file-list .file-row').length === 3 && document.querySelector('#tool-file-list .file-name').textContent === 'כתב הגנה.pdf'`);
  const again = await run(`[...document.querySelectorAll('#tool-file-list .file-name')].map(n => n.textContent)`);
  check('"run again" reopens the tool with the same files', again.length === 3 && again[0] === 'כתב הגנה.pdf', again.join(' | '));
  await key('Escape');

  await run(`window.shell.receiveFiles(${JSON.stringify(await describe([A, B]))})`);
  const pending = await run(`({
    bar: !document.getElementById('home-pending').classList.contains('hidden'),
    text: document.getElementById('home-pending-text').textContent,
    dim: document.querySelector('.tile[data-tool="word-to-pdf"]').classList.contains('dim'),
    merge: document.querySelector('.tile[data-tool="merge"]').classList.contains('dim'),
  })`);
  check('files dropped on home wait for a tool, and the bar says so', pending.bar && /2 קבצים מוכנים/.test(pending.text), pending.text);
  check('  tools that cannot take them are dimmed', pending.dim && !pending.merge);
  await press('.tile[data-tool="word-to-pdf"]');
  check('  and pressing one does nothing', (await run('document.body.dataset.screen')) === 'home');
  await press('.tile[data-tool="merge"]');
  const carried = await run(`[...document.querySelectorAll('#tool-file-list .file-name')].map(n => n.textContent)`);
  check('pressing a tool that can opens it with those files', carried.join('|') === 'כתב הגנה.pdf|נספח ב.pdf', carried.join(' | '));
  await key('Escape');
  check('  and the bar is gone', await hidden('home-pending'));

  /* ---- the appendix builder lives under its tile ---- */
  console.log('\nthe appendix builder');
  await press('.tile[data-tool="appendix"]');
  check('its tile opens its own screen', !(await hidden('screen-appendix')) && (await hidden('screen-tool')));
  check('  with its history tab, which is hidden elsewhere', !(await hidden('history-tab')));
  await key('Escape');
  check('  and Esc returns home', (await run('document.body.dataset.screen')) === 'home' && (await hidden('history-tab')));

  /* ---- what the page may read ---- */
  console.log('\nwhat the page may read');
  const txtToken = await run(`window.api.describeFiles(${JSON.stringify([TXT])}).then(r => r.files[0].token)`);
  check('a file that is not a PDF or picture gets no way to be read back', txtToken === null);
  const bogus = await run(`fetch('/doc/0123456789abcdef0123456789abcdef').then(r => r.status)`);
  check('  and a made-up document link finds nothing', bogus === 404);
  const headers = await run(`window.api.describeFiles(${JSON.stringify([A])}).then(r => fetch('/doc/' + r.files[0].token)).then(r => r.headers.get('content-security-policy') + ' | ' + r.headers.get('x-content-type-options'))`);
  check('  and a real one is served as inert data', /sandbox/.test(headers) && /nosniff/.test(headers), headers);

  /* ---- leaving the appendix builder mid-build ---- */
  await press('.tile[data-tool="appendix"]');
  await run(`state.building = true; updateBuildState(); true`);
  await key('Escape');
  check('while a filing is being built, Esc and Back stay on the screen and say why',
    (await run('document.body.dataset.screen')) === 'appendix' && (await run(`document.getElementById('nav-back').disabled`)) &&
    /אחרי שהתיק/.test(await run(`document.getElementById('nav-back').title`)));
  await run(`state.building = false; updateBuildState(); true`);
  await key('Escape');

  /* ---- the job runner on its own ---- */
  console.log('\nthe job runner');
  const slow = {
    id: 'slow',
    async run({ inputs, ctx }) {
      await ctx.writeOutput(Buffer.from('%PDF-1.7 partial'), { source: inputs[0], label: 'חלקי', ext: 'pdf' });
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        ctx.progress(i / 100, `שלב ${i}`);
      }
      return {};
    },
  };
  const scratchBefore = fs.readdirSync(path.join(os.tmpdir(), 'rotem-office')).length;
  const started = jobs.start(slow, [A], {});
  setTimeout(() => jobs.cancel(started.id), 150);
  const outcome = await started.promise;
  check('a cancelled tool reports cancelled', outcome.cancelled === true && !outcome.ok);
  check('  and what it already wrote is removed', !fs.existsSync(path.join(docs, 'כתב הגנה - חלקי.pdf')));
  check('  and its scratch folder is gone', fs.readdirSync(path.join(os.tmpdir(), 'rotem-office')).length <= scratchBefore);

  const failing = { id: 'failing', async run() { const e = new Error('EACCES: permission denied'); throw e; } };
  const failed = await jobs.start(failing, [A], {}).promise;
  check('a system error becomes a sentence a person can act on', /אין הרשאה/.test(failed.error), failed.error);

  /* ---- what the page itself reported ---- */
  console.log('\nthe page');
  const real = errors.filter((m) => !/update:status/.test(m));
  check('no errors in the page console (CSP, missing files, pdf.js)', real.length === 0, real.slice(0, 3).join(' / '));

  await fsp.rm(scratch, { recursive: true, force: true });
  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
  app.exit(failedCount === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
