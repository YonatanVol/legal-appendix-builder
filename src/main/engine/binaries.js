'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/*
 * The two programs the app runs beside itself: qpdf and Ghostscript.
 *
 * On Windows they ship inside the installer (resources/vendor), fetched and checked
 * by scripts/fetch-vendor.js. During development on a Mac they come from Homebrew.
 * An environment variable can point at either explicitly.
 *
 * They are run with an argument array, never through a shell, so a file name with
 * quotes, spaces or Hebrew cannot be read as a command.
 */

const ROOT = path.join(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';

const LAYOUT = {
  qpdf: { env: 'OFFICE_QPDF', win: ['qpdf', 'bin', 'qpdf.exe'], path: [isWin ? 'qpdf.exe' : 'qpdf'] },
  gs: { env: 'OFFICE_GS', win: ['gs', 'bin', 'gswin64c.exe'], path: isWin ? ['gswin64c.exe'] : ['gs'] },
};

const found = new Map();

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where the program is, or null. Looked up once. */
function locate(name) {
  if (found.has(name)) return found.get(name);
  const spec = LAYOUT[name];
  const tries = [];
  if (process.env[spec.env]) tries.push(process.env[spec.env]);
  if (process.resourcesPath) tries.push(path.join(process.resourcesPath, 'vendor', ...spec.win));
  tries.push(path.join(ROOT, 'vendor', 'win', ...spec.win));
  // An app opened from Finder or the Start menu gets a short PATH, so the usual
  // install places are tried as well.
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) for (const exe of spec.path) if (dir) tries.push(path.join(dir, exe));
  const hit = tries.find((p) => (isWin || !p.endsWith('.exe')) && exists(p)) || null;
  found.set(name, hit);
  return hit;
}

/** For tests that need to pretend a program is missing. */
function forget() {
  found.clear();
}

const MISSING = {
  qpdf: 'רכיב ההצפנה (qpdf) חסר בהתקנה הזו. התקנה מחדש של התוכנה תחזיר אותו.',
  gs: 'רכיב העיבוד (Ghostscript) חסר בהתקנה הזו. התקנה מחדש של התוכנה תחזיר אותו.',
};

function availability(...names) {
  for (const n of names) if (!locate(n)) return { available: false, reason: MISSING[n] };
  return { available: true };
}

/**
 * Run a program. Resolves with its exit code and output; rejects only when it could
 * not be started. `signal` stops it; `onLine` sees each line it prints.
 */
function run(name, args, { signal, onLine, cwd } = {}) {
  const bin = locate(name);
  if (!bin) return Promise.reject(new Error(MISSING[name]));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const feed = (chunk) => {
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach((l) => onLine(l));
    };
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      feed(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      feed(s);
    });
    const abort = () => child.kill();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.on('error', (err) => reject(new Error(`לא ניתן היה להפעיל את ${name}: ${err.message}`)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr, killed: !!(signal && signal.aborted) });
    });
  });
}

module.exports = { locate, availability, run, forget, MISSING };
