'use strict';

/*
 * Self-test mode, used by the Windows CI against the installed program.
 *
 *   APPENDIX_BUILDER_SELFTEST=<result.json>  AppendixBuilder.exe
 *
 * The first person to install the app never saw a window, and every test until then
 * had run from source on a Mac. This makes the program that is actually installed on
 * a real Windows machine start, open its window, produce a filing through the same IPC
 * path as the build button, and write down what it found.
 *
 * With APPENDIX_BUILDER_SELFTEST_UPDATE_FEED=http://127.0.0.1:<port>/ it instead proves
 * an update: finds a newer build on that local feed, downloads it, and installs it.
 *
 * With APPENDIX_BUILDER_SELFTEST_UPDATE_CHECK=github it asks the real GitHub for the
 * newest release, through the same network rule the installed app uses, and installs
 * nothing. That is how a change to GitHub's download hosts gets noticed.
 *
 * Nothing here touches her real history: the store is pointed at a scratch folder.
 * The mode only writes to the path it was given and reaches no network the normal app
 * cannot; anyone able to set this variable for her process could already do more.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { PDFDocument, PDFName, PDFDict, rgb } = require('pdf-lib');

const { version } = require('../../package.json');

const TIME_LIMIT_MS = 180000;

function run() {
  const resultPath = path.resolve(process.env.APPENDIX_BUILDER_SELFTEST);
  const started = Date.now();
  const checks = [];
  let finished = false;
  let extra = {};

  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail: String(detail) });
    return !!ok;
  };

  const write = () => {
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    const result = {
      ok,
      version,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      executable: process.execPath,
      durationMs: Date.now() - started,
      checks,
      ...extra,
    };
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    return ok;
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    let ok = false;
    try {
      ok = write();
    } catch {
      ok = false;
    }
    app.exit(ok ? 0 : 1);
  };

  const fatal = (label) => (err) => {
    check(label, false, err && err.stack ? err.stack : err);
    finish();
  };
  process.on('uncaughtException', fatal('no uncaught exception'));
  process.on('unhandledRejection', fatal('no unhandled rejection'));

  setTimeout(() => {
    check(`finished within ${TIME_LIMIT_MS / 1000}s`, false);
    finish();
  }, TIME_LIMIT_MS).unref();

  app.on('window-all-closed', () => {});

  app
    .whenReady()
    .then(() => {
      if (process.env.APPENDIX_BUILDER_SELFTEST_UPDATE_FEED) return updateScenario();
      if (process.env.APPENDIX_BUILDER_SELFTEST_UPDATE_CHECK === 'github') return liveCheckScenario();
      return filingScenario();
    })
    .catch(fatal('the self-test ran to completion'));

  /* ---------------------------------------------------------------- filing ---- */

  async function filingScenario() {
    const history = require('./history');
    const { registerIpc } = require('./ipc');
    const { lockDownNetwork } = require('./security');
    const { createWindow } = require('./window');
    const updater = require('./updater');

    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'appendix-selftest-'));
    history.setStoreFile(path.join(scratch, 'history.json'));

    lockDownNetwork();
    registerIpc();
    updater.start({ version }); // registers its IPC; disabled in this mode

    const win = createWindow({ show: false, quitOnClose: false });
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
    });
    const page = (code) => win.webContents.executeJavaScript(code, true);

    check('the program started and its window loaded', true, process.execPath);

    const ui = await page(`({
      build: !!document.getElementById('build'),
      history: !!document.getElementById('history-tab'),
      scriptRan: typeof refresh === 'function',
    })`);
    check('the interface is complete', ui.build && ui.history && ui.scriptRan, JSON.stringify(ui));

    const shownVersion = await page(`new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        const text = document.getElementById('version').textContent;
        if (text || Date.now() - started > 5000) return resolve(text);
        setTimeout(poll, 100);
      };
      poll();
    })`);
    check('the window shows the installed version', shownVersion.includes(version), shownVersion);

    // Documents made on the spot: the real client filings are not part of the repository.
    const makePdf = async (name, pages) => {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pages; i++) {
        const p = doc.addPage([595.28, 841.89]);
        p.drawRectangle({ x: 60, y: 700 - i * 40, width: 300, height: 20, color: rgb(0.2, 0.2, 0.2) });
      }
      const file = path.join(scratch, name);
      await fsp.writeFile(file, await doc.save());
      return file;
    };

    const body = await makePdf('body.pdf', 3);
    const a1 = await makePdf('a1.pdf', 2);
    const a2 = await makePdf('a2.pdf', 1);
    const a3 = await makePdf('a3.pdf', 1);
    const output = path.join(scratch, 'filing.pdf');

    const spec = {
      bodyPath: body,
      appendices: [
        { title: 'צו עיקול', files: [a1] },
        {
          title: 'העתק מכתב הדרישה להשלמת מסמכים מחברת הביטוח, מכתב השלמת מסמכים ואישור מסירה',
          files: [a2, a3],
        },
      ],
      outputPath: output,
    };

    const built = await page(`window.api.build(${JSON.stringify(spec)})`);
    if (!check('a filing is produced through the build button\'s own path', built.ok, built.error || '')) {
      return finish();
    }

    const r = built.result;
    // 3 body + 1 contents + (divider + 2) + (divider + 2)
    check('the filing has the expected pages', r.totalPages === 10, `${r.totalPages} pages`);
    check('the file is on disk', fs.existsSync(output));

    // Windows' own David cannot be embedded, and text set in it was silently turned into
    // outlines that look right and hold no text. The generated pages must carry a font.
    const doc = await PDFDocument.load(await fsp.readFile(output));
    const generated = [r.tocPage, ...r.appendices.map((a) => a.dividerPage)];
    for (const number of generated) {
      const resources = doc.getPage(number - 1).node.Resources();
      const fonts = resources && resources.lookupMaybe(PDFName.of('Font'), PDFDict);
      const count = fonts ? fonts.keys().length : 0;
      check(`page ${number} holds real, embedded text`, count > 0, `${count} font(s)`);
    }

    check('the filing was recorded in history', !!r.historyId, r.historyId || 'not recorded');
    const listed = await page(`window.api.historyList()`);
    check('  and it is listed', listed.ok && listed.entries.length === 1, JSON.stringify(listed.entries && listed.entries.length));

    if (r.historyId) {
      const restored = await page(`window.api.historyRestore(${JSON.stringify(r.historyId)})`);
      check(
        '  and reopening it reads every file again',
        restored.ok && restored.restored.body.pageCount === 3 && restored.restored.appendices[1].files.length === 2,
        restored.ok ? '' : restored.error
      );
    }

    const blocked = await page(
      `fetch('https://github.com/').then(() => 'reached').catch(() => 'blocked')`
    );
    check('the document side still cannot reach the network', blocked === 'blocked', blocked);

    win.destroy();
    finish();
  }

  /* ------------------------------------------------------------ live check ---- */

  async function liveCheckScenario() {
    const updater = require('./updater').start({ version });
    if (!check('the updater started against GitHub', !!updater)) return finish();

    const outcome = await new Promise((resolve) => {
      updater.once('update-not-available', (info) => resolve({ phase: 'current', latest: info && info.version }));
      updater.once('update-available', (info) => resolve({ phase: 'available', latest: info.version }));
      updater.once('error', (err) => resolve({ phase: 'error', error: String((err && err.message) || err) }));
    });

    extra = { update: { from: version, ...outcome } };
    check(
      'GitHub answered through the updater\'s network rule',
      outcome.phase !== 'error',
      outcome.error || `newest published: ${outcome.latest}`
    );
    finish();
  }

  /* ---------------------------------------------------------------- update ---- */

  async function updateScenario() {
    const updater = require('./updater').start({ version });
    if (!check('the updater accepted the loopback test feed', !!updater)) return finish();

    const outcome = await new Promise((resolve) => {
      updater.once('update-downloaded', (info) => resolve({ phase: 'downloaded', version: info.version }));
      updater.once('update-not-available', () => resolve({ phase: 'current' }));
      updater.once('error', (err) => resolve({ phase: 'error', error: String((err && err.message) || err) }));
    });

    extra = { update: { from: version, ...outcome } };
    const downloaded = check(
      'a newer version was found, downloaded and verified',
      outcome.phase === 'downloaded',
      outcome.error || outcome.version || outcome.phase
    );

    if (!downloaded) return finish();

    finished = true;
    write();
    // Silent install, and do not relaunch: the CI checks the installed files afterwards.
    updater.quitAndInstall(true, false);
  }
}


module.exports = { run };
