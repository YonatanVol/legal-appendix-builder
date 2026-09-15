'use strict';

/**
 * The history store and the reopen-for-editing path.
 * Launch with:  npx electron test/history.js
 *
 * The end-to-end cases go through the real IPC handlers from a window with the real
 * preload, so what is exercised is the path the app actually takes, not a
 * reimplementation of it inside the test.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const history = require('../src/main/history');
const { registerIpc } = require('../src/main/ipc');

const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'output');
const BODY = path.join(FIXTURES, 'body.pdf');
const A1 = path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf');
const A3 = path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const pageText = (file, page) =>
  execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-'], {
    encoding: 'utf8',
  })
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim();
const pageCount = (file) =>
  Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))[1]);

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'appendix-history-'));
  // Never touch the real user's history from a test run.
  history.setStoreFile(path.join(scratch, 'history.json'));

  await fsp.mkdir(OUT, { recursive: true });
  registerIpc();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);

  const build = (outputPath, appendices, bodyPath = BODY) =>
    run(`window.api.build(${JSON.stringify({ bodyPath, appendices, outputPath })})`);

  const ARRANGEMENT = [
    { title: 'צו עיקול', files: [A1] },
    { title: 'חוות דעת מעודכנת 2.2.26', files: [A3] },
  ];

  /* ---- a build is recorded ---- */
  console.log('a produced bundle is recorded');
  const firstOut = path.join(OUT, 'history-first.pdf');
  const first = await build(firstOut, ARRANGEMENT);
  check('the build succeeds', first.ok, first.ok ? '' : first.error);
  check('  and reports where it was recorded', !!first.result.historyId);

  let entries = (await run('window.api.historyList()')).entries;
  check('one row exists', entries.length === 1, `${entries.length}`);
  check('  identified by the pleading', entries[0].bodyName === 'body.pdf', entries[0].bodyName);
  check('  keeps the titles in order',
    JSON.stringify(entries[0].appendices.map((a) => a.title)) ===
      JSON.stringify(['צו עיקול', 'חוות דעת מעודכנת 2.2.26']),
    entries[0].appendices.map((a) => a.title).join(' | '));
  check('  keeps the file paths', entries[0].appendices[0].files[0] === A1);
  check('  knows the output still exists', entries[0].outputExists === true);

  /* ---- the strong one: restore and rebuild reproduces the filing ---- */
  console.log('\nreopening and rebuilding reproduces the same filing');
  const restored = (await run(`window.api.historyRestore(${JSON.stringify(entries[0].id)})`)).restored;
  check('the arrangement comes back', restored.appendices.length === 2);
  check('  with the pleading readable', restored.body.missing === false);

  const secondOut = path.join(OUT, 'history-second.pdf');
  const second = await build(
    secondOut,
    restored.appendices.map((a) => ({ title: a.title, files: a.files.map((f) => f.path) }))
  );
  check('the rebuild succeeds', second.ok, second.ok ? '' : second.error);
  check('same number of pages', pageCount(firstOut) === pageCount(secondOut),
    `${pageCount(firstOut)} vs ${pageCount(secondOut)}`);

  const tocPage = first.result.tocPage;
  check('identical table of contents',
    pageText(firstOut, tocPage) === pageText(secondOut, tocPage));
  first.result.appendices.forEach((a) => {
    check(`identical divider for נספח ${a.number}`,
      pageText(firstOut, a.dividerPage) === pageText(secondOut, a.dividerPage));
  });

  /* ---- rebuilding over the same file updates its row ---- */
  console.log('\nrebuilding over the same file updates the row');
  const before = (await run('window.api.historyList()')).entries.find((e) => e.outputPath === firstOut);
  await new Promise((r) => setTimeout(r, 1100)); // savedAt has second resolution
  await build(firstOut, ARRANGEMENT);
  entries = (await run('window.api.historyList()')).entries;

  check('still one row per output file', entries.filter((e) => e.outputPath === firstOut).length === 1);
  const after = entries.find((e) => e.outputPath === firstOut);
  check('  its date moved forward', after.savedAt > before.savedAt, `${before.savedAt} -> ${after.savedAt}`);
  check('saving under a new name adds a row', entries.length === 2, `${entries.length}`);
  check('  newest first', entries[0].outputPath === firstOut, entries[0].outputName);

  /* ---- a corrected letter is re-read, not remembered ---- */
  console.log('\na corrected pleading changes the page counts');
  const longerOut = path.join(OUT, 'history-longer.pdf');
  // Same output path as a previous build, but the pleading swapped for a longer file.
  const swapped = path.join(scratch, 'body.pdf');
  await fsp.copyFile(A1, swapped); // 8 pages, where body.pdf has 7
  await build(longerOut, ARRANGEMENT, swapped);

  const longerEntry = (await run('window.api.historyList()')).entries.find(
    (e) => e.outputPath === longerOut
  );
  const reread = (await run(`window.api.historyRestore(${JSON.stringify(longerEntry.id)})`)).restored;
  check('the pleading is read again rather than recalled',
    reread.body.pageCount === 8, `${reread.body.pageCount} pages`);

  /* ---- a file that moved ---- */
  console.log('\na source file that is no longer there');
  const movable = path.join(scratch, 'movable.pdf');
  await fsp.copyFile(A3, movable);
  const movedOut = path.join(OUT, 'history-moved.pdf');
  await build(movedOut, [{ title: 'נספח שיזוז', files: [movable] }]);
  await fsp.rm(movable);

  const movedEntry = (await run('window.api.historyList()')).entries.find(
    (e) => e.outputPath === movedOut
  );
  const partial = (await run(`window.api.historyRestore(${JSON.stringify(movedEntry.id)})`)).restored;
  check('the missing file is reported as missing', partial.appendices[0].files[0].missing === true);
  check('  under its own name', partial.appendices[0].files[0].name === 'movable.pdf');
  check('  and the rest still restores', partial.body.missing === false && partial.appendices.length === 1);
  check('  the title survives', partial.appendices[0].title === 'נספח שיזוז');

  /* ---- the store survives a damaged file ---- */
  console.log('\na damaged history file');
  const damaged = path.join(scratch, 'damaged.json');
  history.setStoreFile(damaged);
  await fsp.writeFile(damaged, '{ this is not json');
  check('a corrupt file reads as empty', (await history.list()).length === 0);
  await fsp.writeFile(damaged, JSON.stringify({ version: 1, entries: [{ nonsense: true }] }));
  check('entries of the wrong shape are dropped', (await history.list()).length === 0);
  history.setStoreFile(path.join(scratch, 'history.json'));

  /* ---- recording must never break a build ---- */
  console.log('\nrecording cannot fail a build');
  const blocker = path.join(scratch, 'blocker');
  await fsp.writeFile(blocker, 'not a directory');
  history.setStoreFile(path.join(blocker, 'history.json')); // mkdir under a file fails
  const survived = await build(path.join(OUT, 'history-unrecorded.pdf'), ARRANGEMENT);
  check('the build still reports success', survived.ok, survived.ok ? '' : survived.error);
  check('  and admits it was not recorded', survived.result.historyId === null);
  check('  the file is on disk', fs.existsSync(path.join(OUT, 'history-unrecorded.pdf')));
  history.setStoreFile(path.join(scratch, 'history.json'));

  /* ---- a file briefly locked, as Windows antivirus does ---- */
  console.log('\na history file locked for a moment');
  const fspModule = require('fs/promises');
  const realRename = fspModule.rename;
  let refusals = 0;
  fspModule.rename = async (...args) => {
    if (refusals < 2) {
      refusals += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return realRename(...args);
  };
  const lockedSpec = { outputPath: path.join(OUT, 'history-locked.pdf'), bodyPath: BODY, appendices: ARRANGEMENT };
  let recorded = null;
  try {
    recorded = await history.record(lockedSpec, { totalPages: 25, tocPage: 8 });
  } catch (err) {
    recorded = err;
  }
  check('a rename refused twice still records the row', recorded && recorded.id && refusals === 2,
    recorded instanceof Error ? recorded.message : `${refusals} refusals, then saved`);

  fspModule.rename = async () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
  };
  let gaveUp = null;
  try {
    await history.record({ ...lockedSpec, outputPath: path.join(OUT, 'history-stuck.pdf') }, { totalPages: 1, tocPage: 1 });
  } catch (err) {
    gaveUp = err;
  }
  fspModule.rename = realRename;
  check('a rename that never frees gives up rather than hanging', gaveUp && gaveUp.code === 'EBUSY');
  check('  and leaves no temporary file behind',
    !fs.readdirSync(path.dirname(history.storeFile())).some((f) => f.endsWith('.tmp')));
  check('  and the rows already saved are intact',
    (await history.list()).some((e) => e.outputPath === lockedSpec.outputPath));

  /* ---- the same file addressed two ways is one row ---- */
  console.log('\npath handling');
  const odd = path.join(OUT, '.', 'history-first.pdf');
  check('an unnormalised path keys to the same row',
    history.idFor(odd) === history.idFor(firstOut));

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  win.destroy();
  app.exit(failed === 0 ? 0 : 1);
});
