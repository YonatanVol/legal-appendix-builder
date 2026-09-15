'use strict';

/**
 * Launch a program in self-test mode and turn its verdict into an exit code.
 *
 *   node scripts/run-selftest.js <result.json> [--env KEY=VALUE ...] [--expect update-rejected] -- <program> [args...]
 *
 * Used by the Windows CI on the installed app, and locally as
 *   node scripts/run-selftest.js out.json -- node_modules/.bin/electron .
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TIME_LIMIT_MS = 240000;

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 1 || split === argv.length - 1) {
  console.error('usage: node scripts/run-selftest.js <result.json> [--env K=V] [--expect update-rejected] -- <program> [args...]');
  process.exit(2);
}

const resultPath = path.resolve(argv[0]);
const options = argv.slice(1, split);
const [program, ...programArgs] = argv.slice(split + 1);

const env = { ...process.env, APPENDIX_BUILDER_SELFTEST: resultPath };
let expect = 'pass';
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--env') {
    const [key, ...rest] = options[++i].split('=');
    env[key] = rest.join('=');
  } else if (options[i] === '--expect') {
    expect = options[++i];
  }
}

fs.rmSync(resultPath, { force: true });
console.log(`launching ${program} ${programArgs.join(' ')}`.trim());

const child = spawn(program, programArgs, { env, stdio: 'inherit', windowsHide: false });
const timer = setTimeout(() => {
  console.error(`FAIL: no exit after ${TIME_LIMIT_MS / 1000}s`);
  child.kill();
}, TIME_LIMIT_MS);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`FAIL: could not start the program: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  console.log(`program exited with code ${code}${signal ? ` (${signal})` : ''}`);

  // A program that never started, like one missing ffmpeg.dll, writes nothing at all.
  if (!fs.existsSync(resultPath)) {
    console.error('FAIL: the program wrote no result, so it never got as far as running');
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  console.log(`version ${result.version} on ${result.platform}/${result.arch}, packaged=${result.packaged}, ${result.durationMs}ms`);
  for (const c of result.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  }

  if (expect === 'update-rejected') {
    const u = result.update || {};
    const rejected = u.phase === 'error' && /sha512|checksum|mismatch/i.test(u.error || '');
    console.log(rejected ? 'OK: the tampered update was refused' : `FAIL: expected the tampered update to be refused, got ${JSON.stringify(u)}`);
    process.exit(rejected ? 0 : 1);
  }

  process.exit(result.ok && code === 0 ? 0 : 1);
});
