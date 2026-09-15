'use strict';

/**
 * The update notices and the restart button.
 * Launch with:  npx electron test/updater-ui.js
 *
 * No real release is involved: the main process's own state machine is driven through
 * its test seam, and the page is worked with real pointer presses. Downloading and
 * installing a genuine update is proven on Windows by .github/workflows/windows.yml.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURES = path.join(__dirname, 'fixtures');
const { version } = require('../package.json');

function say(line) {
  console.log(line);
  if (process.env.TRACE) fs.appendFileSync(process.env.TRACE, line + '\n');
}
const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  say(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'appendix-updater-'));
  app.setPath('userData', scratch);

  const history = require('../src/main/history');
  history.setStoreFile(path.join(scratch, 'history.json'));
  const { registerIpc, isBuilding } = require('../src/main/ipc');
  const updater = require('../src/main/updater');

  /* ---- what the main process keeps and cleans ---- */
  say('notes from GitHub');
  const cleaned = updater.plainNotes(
    '<h2>1.3.1</h2><p>תיקון קטן</p><script>alert(1)</script><ul><li>שורה א</li><li>שורה ב</li></ul>'
  );
  check('release notes are reduced to plain text', !/[<>]/.test(cleaned) && !/alert/.test(cleaned), JSON.stringify(cleaned));
  check('  keeping their lines', /תיקון קטן/.test(cleaned) && /שורה א\s*\n\s*שורה ב/.test(cleaned));

  const pendingFile = path.join(scratch, 'pending-update.json');
  await fsp.writeFile(pendingFile, JSON.stringify({ version: '8.0.0', notes: 'not yet' }));
  check('an update that has not installed yet is not announced', updater.takeJustUpdated(version) === null);
  check('  and is remembered for when it does', fs.existsSync(pendingFile));

  await fsp.writeFile(pendingFile, JSON.stringify({ version, notes: 'התוכנה מתעדכנת לבד\nופותחת מהר יותר' }));

  registerIpc();
  let win = null;
  updater.start({ getWindow: () => win, isBuilding, version });
  check('the pending note is consumed once the version matches', !fs.existsSync(pendingFile));

  win = new BrowserWindow({
    width: 1040, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = (ms = 150) => run(`new Promise(r => setTimeout(r, ${ms}))`);
  const hidden = (id) => run(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const press = (selector) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    el.focus();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'pressed';
  })()`);
  await settle(400);

  /* ---- after an update ---- */
  say('\nthe first launch after an update');
  check('says which version it now is', !(await hidden('update-done')) &&
    (await run(`document.getElementById('update-done-text').textContent`)) === `התוכנה עודכנה לגרסה ${version}.`);
  check('  offers what changed', !(await hidden('update-done-notes')) &&
    (await run(`document.getElementById('update-done-notes-text').textContent`)).includes('ופותחת מהר יותר'));
  await press('#update-done-close');
  await settle();
  check('  and can be dismissed', await hidden('update-done'));

  await run(`(() => { announceUpdate({ version: '1.0.1', notes: '<img src=x onerror="window.__owned=1"><b>bold</b>' }); return 'ok'; })()`);
  await settle();
  check('notes are shown as text, never as markup',
    (await run(`!document.querySelector('#update-done-notes-text *') && !window.__owned`)) === true);
  await press('#update-done-close');

  /* ---- an update waiting ---- */
  say('\nan update waiting to install');
  check('nothing is shown while there is nothing to install', await hidden('update-ready'));

  updater.forTest.setStatus({ phase: 'ready', version: '9.9.9' });
  await settle();
  check('a waiting update is announced', !(await hidden('update-ready')));
  check('  in plain words', (await run(`document.getElementById('update-ready-text').textContent`)) ===
    'גרסה 9.9.9 מוכנה. היא תותקן אוטומטית בסגירת התוכנה.');
  check('  and the version badge explains it on hover',
    (await run(`document.getElementById('version').title`)) === 'גרסה 9.9.9 מוכנה להתקנה');

  updater.forTest.setStatus({ phase: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
  await settle();
  check('a later failed check while offline does not hide it', !(await hidden('update-ready')));

  /* ---- restarting ---- */
  say('\nrestarting to install');
  const calls = [];
  updater.forTest.setUpdater({ quitAndInstall: (...args) => calls.push(args) });
  await press('#update-restart');
  await settle(200);
  check('pressing restart installs silently and reopens the program',
    calls.length === 1 && calls[0][0] === true && calls[0][1] === true, JSON.stringify(calls));
  check('  without an error', await hidden('error'));

  say('\nnever in the middle of a filing');
  await run(`(() => { state.building = true; updateBuildState(); return 'ok'; })()`);
  check('the button is disabled while a filing is written', (await run(`document.getElementById('update-restart').disabled`)) === true);
  check('  and says why', (await run(`document.getElementById('update-restart').title`)) === 'אפשר להפעיל מחדש אחרי שיצירת התיק תסתיים');
  await run(`(() => { state.building = false; updateBuildState(); return 'ok'; })()`);

  // The button is only the visible half. The main process must refuse on its own, so a
  // real build is started through IPC and the install requested while it runs.
  const spec = {
    bodyPath: path.join(FIXTURES, 'body.pdf'),
    appendices: [{ title: 'צו עיקול', files: [path.join(FIXTURES, '2 - העתק הערר לרבות מסמכים שצורפו.pdf')] }],
    outputPath: path.join(scratch, 'mid-build.pdf'),
  };
  await run(`(() => { window.__build = window.api.build(${JSON.stringify(spec)}); return 'started'; })()`);
  let sawBuilding = false;
  for (let i = 0; i < 40 && !sawBuilding; i++) {
    sawBuilding = isBuilding();
    if (!sawBuilding) await new Promise((r) => setTimeout(r, 25));
  }
  const refused = await run(`window.api.installUpdate()`);
  check('the main process sees the build in progress', sawBuilding);
  check('  and refuses to restart during it', refused.ok === false && /יצירת התיק/.test(refused.error), JSON.stringify(refused));
  check('  so nothing was installed', calls.length === 1, `${calls.length} calls`);
  const finishedBuild = await run(`window.__build`);
  check('  and the filing completes', finishedBuild.ok === true && fs.existsSync(spec.outputPath));
  check('  after which the flag is released', isBuilding() === false);

  updater.forTest.reset();
  const nothing = await run(`window.api.installUpdate()`);
  check('with no update waiting, restart is refused honestly', nothing.ok === false && /אין עדכון/.test(nothing.error), nothing.error);

  const failed = results.filter((r) => !r.pass).length;
  say(`\n${results.length - failed}/${results.length} checks passed`);
  win.destroy();
  app.exit(failed === 0 ? 0 : 1);
});
