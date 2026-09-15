'use strict';

/**
 * The self-test's update scenario when handing over to the installer fails.
 * Launch with:  npx electron test/selftest-install-failure.js
 *
 * On Windows this path cannot be forced on purpose, so the updater is replaced with a
 * stand-in that downloads "successfully" and then refuses to install, the way it would
 * if antivirus took the downloaded installer away. The run must record the failure and
 * exit promptly, not leave an ok result behind and hang.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');

const mode = process.argv[2];

if (mode === 'child') {
  const updaterPath = require.resolve('../src/main/updater');
  const fake = new EventEmitter();
  fake.quitAndInstall = () => {
    if (process.env.FAIL_AS === 'event') {
      setTimeout(() => fake.emit('error', new Error('spawn EPERM: installer removed')), 50);
    } else {
      throw new Error('ENOENT: the downloaded installer is gone');
    }
  };
  require.cache[updaterPath] = {
    id: updaterPath, filename: updaterPath, loaded: true,
    exports: {
      start: () => {
        setTimeout(() => fake.emit('update-downloaded', { version: '99.0.0' }), 50);
        return fake;
      },
    },
  };
  require('../src/main/selftest').run();
} else {
  const { spawn } = require('child_process');
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push(!!ok);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  };

  const scenario = (failAs) =>
    new Promise((resolve) => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-install-')), 'result.json');
      const started = Date.now();
      const child = spawn(process.execPath, [__filename, 'child'], {
        env: {
          ...process.env,
          FAIL_AS: failAs,
          APPENDIX_BUILDER_SELFTEST: out,
          APPENDIX_BUILDER_SELFTEST_UPDATE_FEED: 'http://127.0.0.1:1/',
        },
        stdio: 'ignore',
      });
      const timer = setTimeout(() => child.kill(), 20000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
        resolve({ code, seconds: (Date.now() - started) / 1000, result });
      });
    });

  app.whenReady().then(async () => {
    for (const failAs of ['throw', 'event']) {
      console.log(`\nthe installer hand-over fails by ${failAs === 'throw' ? 'throwing' : 'an error event'}`);
      const { code, seconds, result } = await scenario(failAs);
      check('the run exits promptly instead of hanging', code !== null && seconds < 15, `${seconds.toFixed(1)}s, code ${code}`);
      check('  with a failing exit code', code === 1, `code ${code}`);
      check('  and the result says it failed', result && result.ok === false, result ? `ok=${result.ok}` : 'no result');
      check('  naming the step', result && result.checks.some((c) => c.name === 'the installer was started' && !c.ok));
      check('  after recording the verified download', result && result.checks.some((c) => /downloaded and verified/.test(c.name) && c.ok));
    }
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    app.exit(failed === 0 ? 0 : 1);
  });
}
