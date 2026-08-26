'use strict';

/**
 * Drives the real interface: loads the window, feeds it files through the same code
 * path drag-and-drop uses, and checks what the user would see.
 * Launch with:  npx electron test/ui-smoke.js
 */

const fs = require('fs/promises');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const { registerIpc } = require('../src/main/ipc');

const FIXTURES = path.join(__dirname, 'fixtures');
const SHOT = path.join(__dirname, 'output', 'ui.png');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const FILES = {
  body: path.join(FIXTURES, 'body.pdf'),
  a1: path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf'),
  a2: path.join(FIXTURES, '2 - העתק הערר לרבות מסמכים שצורפו.pdf'),
  a3: path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf'),
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  registerIpc();

  const win = new BrowserWindow({
    width: 1040,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const run = (code) => win.webContents.executeJavaScript(code, true);

  // Same entry point the drop handler uses.
  const state = await run(`(async () => {
    const body = await window.api.inspectFiles([${JSON.stringify(FILES.body)}]);
    setBody(body.files[0]);
    const rest = await window.api.inspectFiles(${JSON.stringify([FILES.a1, FILES.a2, FILES.a3])});
    addAppendicesFromFiles(rest.files);
    await refresh();
    return {
      bodyName: document.getElementById('body-name').textContent,
      bodyPages: document.getElementById('body-pages').textContent,
      summary: document.getElementById('summary').textContent,
      titles: [...document.querySelectorAll('.title-input')].map(i => i.value),
      ranges: [...document.querySelectorAll('.range-tag')].map(e => e.textContent),
      badges: [...document.querySelectorAll('.badge')].map(e => e.textContent),
      buildDisabled: document.getElementById('build').disabled,
      fileRows: document.querySelectorAll('.appendix-files li').length,
    };
  })()`);

  // The version has to be visible somewhere, or there is no way to tell which build
  // is installed once the download filename is gone.
  console.log('build identification');
  const expected = require('../package.json').version;
  const shown = await run(
    `window.api.getVersion().then(r => { document.getElementById('version').textContent = 'גרסה ' + r.version; return document.getElementById('version').textContent; })`
  );
  check('the window shows its version', shown === `גרסה ${expected}`, `"${shown}"`);

  console.log('\ninterface state after loading four files');
  check('shows the pleading file name', state.bodyName === 'body.pdf', state.bodyName);
  check('shows its page count', state.bodyPages === '7 עמודים', state.bodyPages);
  check('numbers the appendices',
    JSON.stringify(state.badges) === JSON.stringify(['נספח 1', 'נספח 2', 'נספח 3']),
    state.badges.join(', '));
  check('suggests titles from the file names',
    state.titles[0] === 'העתק פרוטוקול ועדת העררים מיום 07-07-26', state.titles[0]);
  check('  strips the ordering prefix', state.titles.every((t) => !/^\d/.test(t)));
  check('previews the page ranges before building',
    JSON.stringify(state.ranges) === JSON.stringify(["עמ' 10-17", "עמ' 19-41", "עמ' 43-49"]),
    state.ranges.join(' | '));
  check('summarises the bundle', state.summary.includes('49') && state.summary.includes('8'),
    state.summary);
  check('enables the build button', state.buildDisabled === false);
  check('lists one row per file', state.fileRows === 3, `${state.fileRows}`);

  console.log('\nreordering and validation');
  const after = await run(`(async () => {
    move(0, 1);                       // swap the first two appendices
    await refresh();
    const reordered = {
      titles: [...document.querySelectorAll('.title-input')].map(i => i.value),
      ranges: [...document.querySelectorAll('.range-tag')].map(e => e.textContent),
    };
    state.appendices[0].title = '';   // clear a title
    updateBuildState();
    reordered.blockedOnEmptyTitle = document.getElementById('build').disabled;
    return reordered;
  })()`);

  check('reordering moves the appendix', after.titles[0] === 'העתק הערר לרבות מסמכים שצורפו',
    after.titles[0]);
  check('  and recomputes every range',
    JSON.stringify(after.ranges) === JSON.stringify(["עמ' 10-32", "עמ' 34-41", "עמ' 43-49"]),
    after.ranges.join(' | '));
  check('an empty title blocks the build', after.blockedOnEmptyTitle === true);

  await fs.mkdir(path.dirname(SHOT), { recursive: true });
  await run(`(async () => { state.appendices[0].title = 'העתק הערר לרבות מסמכים שצורפו'; await refresh(); })()`);
  const image = await win.webContents.capturePage();
  await fs.writeFile(SHOT, image.toPNG());
  console.log(`\nscreenshot: ${SHOT}`);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  win.destroy();
  app.exit(failed === 0 ? 0 : 1);
});
