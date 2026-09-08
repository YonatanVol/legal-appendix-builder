'use strict';

/**
 * The history drawer, driven the way a person drives it.
 * Launch with:  npx electron test/history-ui.js
 *
 * Every control is worked with a real pointer sequence rather than a direct call to
 * the handler, because a listener that never receives the press is exactly the class
 * of defect a direct call cannot see.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const history = require('../src/main/history');
const { registerIpc } = require('../src/main/ipc');

const FIXTURES = path.join(__dirname, 'fixtures');
const BODY = path.join(FIXTURES, 'body.pdf');
const A1 = path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf');
const A3 = path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf');

// stdout is buffered when this runs under a pipe, so a hang shows nothing at all.
// TRACE=<file> mirrors progress somewhere that can be read while it is still running.
const TRACE = process.env.TRACE;
function say(line) {
  console.log(line);
  if (TRACE) require('fs').appendFileSync(TRACE, line + '\n');
}

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  say(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'appendix-drawer-'));
  const store = path.join(scratch, 'history.json');
  history.setStoreFile(store);

  await fsp.writeFile(store, JSON.stringify({
    version: 1,
    entries: [
      {
        id: 'aaa111', outputPath: path.join(scratch, 'tik-a.pdf'), outputName: 'tik-a.pdf',
        savedAt: iso(0), bodyPath: BODY, bodyName: 'תגובה לבקשת האיש.pdf',
        appendices: [
          { title: 'צו עיקול', files: [A1] },
          { title: 'חוות דעת מעודכנת 2.2.26', files: [A3] },
        ],
        totalPages: 25, tocPage: 8,
      },
      {
        id: 'bbb222', outputPath: path.join(scratch, 'tik-b.pdf'), outputName: 'tik-b.pdf',
        savedAt: iso(1), bodyPath: BODY, bodyName: 'כתב ערעור.pdf',
        appendices: [{ title: 'תדפיסי חשבון בנק', files: [A3] }],
        totalPages: 16, tocPage: 8,
      },
      {
        id: 'ccc333', outputPath: path.join(scratch, 'tik-c.pdf'), outputName: 'tik-c.pdf',
        savedAt: iso(3), bodyPath: BODY, bodyName: 'תיק עם קובץ חסר.pdf',
        appendices: [{ title: 'מסמך שנעלם', files: [path.join(scratch, 'gone.pdf')] }],
        totalPages: 12, tocPage: 8,
      },
    ],
  }));

  registerIpc();

  const win = new BrowserWindow({
    width: 1040, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);

  // A real press: pointerdown, pointerup, then click. Calling .click() alone would
  // skip the pointer phase entirely.
  const PRESS = `(selector, index) => {
    const list = document.querySelectorAll(selector);
    const el = index === undefined ? list[0] : list[index];
    if (!el) return 'missing';
    const opts = { bubbles: true, cancelable: true, composed: true,
                   pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'pressed';
  }`;
  const press = (selector, index) =>
    run(`(${PRESS})(${JSON.stringify(selector)}, ${index === undefined ? 'undefined' : index})`);

  const settle = () => run('new Promise(r => setTimeout(r, 120))');
  const hidden = (id) => run(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);

  await settle();

  /* ---- the tab ---- */
  say('the side tab');
  check('the count badge shows how many are saved',
    (await run(`document.getElementById('history-count').textContent`)) === '3');
  check('the drawer starts closed', await hidden('history-drawer'));

  check('pressing the tab opens it', (await press('#history-tab')) === 'pressed');
  await settle();
  check('  the drawer is showing', !(await hidden('history-drawer')));
  check('  the scrim is showing', !(await hidden('history-scrim')));
  check('  focus moved into the drawer',
    (await run(`document.activeElement.id`)) === 'history-search');
  check('  and it is announced as a dialog',
    (await run(`document.getElementById('history-drawer').getAttribute('aria-modal')`)) === 'true');

  /* ---- what a row says ---- */
  say('\nwhat a row shows');
  const rows = await run(`[...document.querySelectorAll('.history-item')].map(li => ({
    title: li.querySelector('.hi-title').textContent,
    when: li.querySelector('.hi-when').textContent,
    preview: li.querySelector('.hi-preview').textContent,
    meta: li.querySelector('.hi-meta').textContent,
  }))`);
  check('every saved bundle is listed', rows.length === 3, `${rows.length}`);
  check('a row is named after the pleading, not the output file',
    rows[0].title === 'תגובה לבקשת האיש', rows[0].title);
  check('the date is relative', rows[0].when.startsWith('היום') && rows[1].when.startsWith('אתמול'),
    `${rows[0].when} / ${rows[1].when}`);
  check('older than a week counts days', rows[2].when === 'לפני 3 ימים', rows[2].when);
  check('the appendix titles preview the case',
    rows[0].preview === 'צו עיקול · חוות דעת מעודכנת 2.2.26', rows[0].preview);
  check('the counts are shown', rows[0].meta === '2 נספחים · 25 עמודים', rows[0].meta);

  /* ---- search ---- */
  say('\nsearch');
  await run(`(() => { const s = document.getElementById('history-search');
    s.value = 'תדפיסי'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
  let visible = await run(`document.querySelectorAll('.history-item').length`);
  check('an appendix title finds its case', visible === 1, `${visible} rows`);

  await run(`(() => { const s = document.getElementById('history-search');
    s.value = 'שאיננו קיים'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
  check('a search with no match says so', !(await hidden('history-none')));

  await run(`(() => { const s = document.getElementById('history-search');
    s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();

  /* ---- esc ---- */
  say('\nkeyboard');
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await settle();
  check('esc closes the drawer', await hidden('history-drawer'));
  check('  and focus returns to the tab',
    (await run(`document.activeElement.id`)) === 'history-tab', await run(`document.activeElement.id`));

  /* ---- reopening a case ---- */
  say('\nreopening a case');
  await press('#history-tab');
  await settle();
  check('pressing a row restores it', (await press('.history-open', 0)) === 'pressed');
  await run('new Promise(r => setTimeout(r, 900))');

  check('the drawer closed itself', await hidden('history-drawer'));
  check('the pleading is loaded',
    (await run(`document.getElementById('body-name').textContent`)) === 'body.pdf');
  const titles = await run(`[...document.querySelectorAll('.title-input')].map(i => i.value)`);
  check('the titles came back in order',
    JSON.stringify(titles) === JSON.stringify(['צו עיקול', 'חוות דעת מעודכנת 2.2.26']),
    titles.join(' | '));
  const ranges = await run(`[...document.querySelectorAll('.range-tag')].map(e => e.textContent)`);
  check('the page ranges were recomputed, not recalled',
    JSON.stringify(ranges) === JSON.stringify(["עמ' 10-17", "עמ' 19-25"]), ranges.join(' | '));
  check('a banner says where it came from',
    !(await hidden('restored')) &&
      (await run(`document.getElementById('restored-text').textContent`)).includes('תגובה לבקשת האיש'));
  check('the build button is enabled',
    (await run(`document.getElementById('build').disabled`)) === false);

  // Correcting a filing should replace it, not leave a second copy beside it.
  check('rebuilding saves back over the same file',
    (await run('defaultOutputTarget()')) === path.join(scratch, 'tik-a.pdf'),
    await run('defaultOutputTarget()'));

  // And the reverse: the save target is only ever armed by a reopen, which puts the
  // banner on screen. Otherwise a later, unrelated case could be saved over this one
  // with nothing on screen to say so.
  await press('#restored-new');
  await settle();
  check('starting a new case disarms it',
    (await run('state.restoredFrom === null')) === true);
  check('  and the banner goes away', await hidden('restored'));
  check('  the name then comes from the pleading',
    (await run('defaultOutputTarget()')) === 'תיק - עם נספחים.pdf',
    await run('defaultOutputTarget()'));

  /* ---- a case with a file that is gone ---- */
  say('\na case whose file has gone');
  await run(`(() => { window.confirm = () => true; return 'ok'; })()`); // work is in progress now
  await press('#history-tab');
  await settle();
  await press('.history-open', 2);
  await run('new Promise(r => setTimeout(r, 900))');

  check('the missing file is marked in its row',
    (await run(`document.querySelectorAll('.appendix-files li.missing').length`)) === 1);
  check('the build is blocked',
    (await run(`document.getElementById('build').disabled`)) === true);
  const summary = await run(`document.getElementById('summary').textContent`);
  check('  and the summary says why', summary.includes('לא נמצא'), summary);
  check('  there is a button to find it',
    (await run(`[...document.querySelectorAll('.appendix-files li.missing button')]
       .some(b => b.textContent === 'אתר')`)) === true);

  /* ---- declining the overwrite keeps the work ---- */
  say('\ndeclining to replace work in progress');
  await run(`(() => { window.confirm = () => false; return 'ok'; })()`);
  await press('#history-tab');
  await settle();
  await press('.history-open', 1);
  await run('new Promise(r => setTimeout(r, 400))');
  const stillTitles = await run(`[...document.querySelectorAll('.title-input')].map(i => i.value)`);
  check('the arrangement on screen is untouched',
    JSON.stringify(stillTitles) === JSON.stringify(['מסמך שנעלם']), stillTitles.join(' | '));

  /* ---- two fast presses ---- */
  // Asserting which case ends up loaded would be asserting the outcome of a race:
  // without the guard both restores run and whichever resolves last wins, so that
  // assertion passes or fails by timing. What is deterministic is the mechanism, so
  // that is what is checked: a second press must not start a second restore.
  say('\ntwo fast presses while one is loading');
  await run(`(() => { window.confirm = () => true; return 'ok'; })()`);
  await press('#history-tab');
  await settle();

  await press('.history-open', 0);
  const midFlight = await run(`({
    restoring: historyView.restoring,
    allDisabled: [...document.querySelectorAll('.history-open')].every(b => b.disabled),
    loadingShown: !!document.querySelector('.hi-loading'),
  })`);
  check('the row reports itself as loading', midFlight.loadingShown);
  check('  every row is locked while it loads', midFlight.allDisabled);
  check('  a restore is marked in flight', midFlight.restoring === 'aaa111', midFlight.restoring);

  await press('.history-open', 1);
  const afterSecond = await run('historyView.restoring');
  check('a second press starts nothing new', afterSecond === 'aaa111', String(afterSecond));

  await run('new Promise(r => setTimeout(r, 1400))');
  const landed = await run(`[...document.querySelectorAll('.title-input')].map(i => i.value)`);
  check('  the case pressed first is the one that loads',
    JSON.stringify(landed) === JSON.stringify(['צו עיקול', 'חוות דעת מעודכנת 2.2.26']),
    landed.join(' | '));
  check('  and the guard is released afterwards',
    (await run('historyView.restoring === null')) === true);

  const failed = results.filter((r) => !r.pass).length;
  say(`\n${results.length - failed}/${results.length} checks passed`);
  win.destroy();
  app.exit(failed === 0 ? 0 : 1);
});
