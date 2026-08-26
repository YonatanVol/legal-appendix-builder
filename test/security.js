'use strict';

/**
 * Confirms the network lockdown is real, and that it does not break the data: URLs
 * the page generator depends on.
 * Launch with:  npx electron test/security.js
 */

const path = require('path');
const { app, BrowserWindow, net } = require('electron');

const { lockDownNetwork, isAllowed } = require('../src/main/security');
const { buildBundle } = require('../src/main/pdf/assemble');

const FIXTURES = path.join(__dirname, 'fixtures');
const results = [];

function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

app.disableHardwareAcceleration();

// Electron quits by default once every window is closed. This test closes its probe
// window mid-run, so it holds the app open explicitly.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();

  console.log('scheme policy');
  [
    ['https://example.com', false],
    ['http://example.com', false],
    ['ws://example.com', false],
    ['http://127.0.0.1:8080', false],
    ['ftp://example.com', false],
    ['file:///tmp/x.html', true],
    ['data:text/html,hi', true],
  ].forEach(([url, expected]) =>
    check(`${expected ? 'allows' : 'blocks'} ${url}`, isAllowed(url) === expected)
  );

  console.log('\na page cannot reach the network');
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL('data:text/html,<body>x</body>');

  const fetched = await win.webContents.executeJavaScript(
    `fetch('https://example.com').then(() => 'reached').catch(e => 'blocked')`,
    true
  );
  check('fetch to an external host is refused', fetched === 'blocked', fetched);

  const imageLoaded = await win.webContents.executeJavaScript(
    `new Promise(r => { const i = new Image();
       i.onload = () => r('reached'); i.onerror = () => r('blocked');
       i.src = 'https://example.com/x.png'; })`,
    true
  );
  check('an external image is refused', imageLoaded === 'blocked', imageLoaded);
  win.destroy();

  console.log('\nthe generator still works with the lockdown active');
  const result = await buildBundle({
    bodyPath: path.join(FIXTURES, 'body.pdf'),
    appendices: [
      {
        title: 'העתק פרוטוקול ועדת העררים מיום 07/07/26',
        files: [path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf')],
      },
    ],
    outputPath: path.join(__dirname, 'output', 'secured.pdf'),
  });
  check('builds a bundle while locked down', result.totalPages === 17, `${result.totalPages}`);
  check('  contents page still generated', result.tocPage === 8);
  check('  divider still generated', result.appendices[0].dividerPage === 9);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
});
