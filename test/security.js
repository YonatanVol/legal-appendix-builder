'use strict';

/**
 * Confirms the network lockdown is real, and that it does not break the data: URLs
 * the page generator depends on.
 * Launch with:  npx electron test/security.js
 */

const http = require('http');
const path = require('path');
const { app, BrowserWindow, net, session } = require('electron');
const {
  lockDownNetwork, isAllowed, lockDownUpdater, isAllowedForUpdater, loopbackFeed, UPDATER_PARTITION,
} = require('../src/main/security');
const { NET_SESSION_NAME } = require('electron-updater/out/electronHttpExecutor');
const { buildBundle } = require('../src/main/pdf/assemble');

const FIXTURES = path.join(__dirname, 'fixtures');
// stdout is buffered under a pipe, so a hang shows nothing. TRACE=<file> mirrors
// progress somewhere readable while the run is still going.
function say(line) {
  console.log(line);
  if (process.env.TRACE) require('fs').appendFileSync(process.env.TRACE, line + '\n');
}

const results = [];

function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  say(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

app.disableHardwareAcceleration();

// Electron quits by default once every window is closed. This test closes its probe
// window mid-run, so it holds the app open explicitly.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();

  say('scheme policy');
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

  say('\na page cannot reach the network');
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

  say('\nthe generator still works with the lockdown active');
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

  /* ---- the updater's own session ---- */
  say('\nthe updater may reach GitHub and nothing else');
  // If electron-updater ever renamed its partition, the rule below would silently
  // attach to a session nobody uses and the updater would be unrestricted.
  check('the rule targets the session electron-updater really uses',
    UPDATER_PARTITION === NET_SESSION_NAME, `${UPDATER_PARTITION} vs ${NET_SESSION_NAME}`);
  check('  and asking for that partition again returns the same session',
    session.fromPartition(UPDATER_PARTITION, { cache: false }) ===
      session.fromPartition(UPDATER_PARTITION, { cache: false }));

  [
    ['https://github.com/YonatanVol/legal-appendix-builder/releases.atom', true],
    ['https://api.github.com/repos/x/y/releases', true],
    ['https://objects.githubusercontent.com/github-production-release-asset/1', true],
    ['https://release-assets.githubusercontent.com/github-production-release-asset/1', true],
    ['http://github.com/insecure', false],
    ['https://github.com.attacker.example/', false],
    ['https://gist.githubusercontent.com/x', false],
    ['https://example.com/', false],
    ['http://127.0.0.1:8321/latest.yml', false],
  ].forEach(([url, expected]) =>
    check(`updater ${expected ? 'may' : 'may not'} reach ${url}`, isAllowedForUpdater(url) === expected)
  );

  check('a loopback test feed is honoured when given',
    isAllowedForUpdater('http://127.0.0.1:8321/latest.yml', { testFeed: 'http://127.0.0.1:8321/' }));
  check('  but only for its own port',
    !isAllowedForUpdater('http://127.0.0.1:9999/', { testFeed: 'http://127.0.0.1:8321/' }));
  check('a test feed on another machine is refused outright',
    loopbackFeed('http://10.0.0.5:8321/') === null && loopbackFeed('https://127.0.0.1/') === null &&
      !isAllowedForUpdater('http://10.0.0.5:8321/x', { testFeed: 'http://10.0.0.5:8321/' }));

  // The rules above are only half of it; the other half is that they are attached.
  const request = (url, targetSession) =>
    new Promise((resolve) => {
      const req = net.request({ url, session: targetSession });
      req.on('response', (res) => { res.on('data', () => {}); res.on('end', () => resolve(`status ${res.statusCode}`)); });
      req.on('error', (err) => resolve(err.message));
      req.end();
    });

  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}/`;

  const updater = session.fromPartition(UPDATER_PARTITION, { cache: false });
  lockDownUpdater(updater);
  const blockedElsewhere = await request('https://example.com/', updater);
  check('a request from the updater session to another host is cancelled',
    /ERR_BLOCKED_BY_CLIENT/.test(blockedElsewhere), blockedElsewhere);
  const blockedLocal = await request(local, updater);
  check('  and it cannot reach a local server without a test feed',
    /ERR_BLOCKED_BY_CLIENT/.test(blockedLocal), blockedLocal);

  const probe = session.fromPartition('security-test-feed', { cache: false });
  lockDownUpdater(probe, { testFeed: local });
  const allowedLocal = await request(local, probe);
  check('with the test feed set, that one local server is reachable', allowedLocal === 'status 200', allowedLocal);
  server.close();

  const documentSide = await request('https://github.com/', session.defaultSession);
  check('the document side still cannot reach GitHub',
    /ERR_BLOCKED_BY_CLIENT/.test(documentSide), documentSide);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
});
