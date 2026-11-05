'use strict';

const fs = require('fs/promises');
const path = require('path');

const bin = require('../engine/binaries');

/*
 * Files locked only against printing or copying.
 *
 * A PDF can be encrypted with no password needed to open it, only an owner's password that
 * asks readers not to print, copy or change it. Banks and pension funds send most of their
 * statements this way. Every reader opens them; pdf-lib, which most tools use, cannot,
 * since it does not decrypt. So for such a file a tool works on an opened copy (qpdf
 * removes the restriction, no password needed), and the result says the copy was saved
 * without it. A file that needs a password to open is not touched here: that is Unlock's.
 */

/**
 * True if the staged file `name` (a plain name in `cwd`) is encrypted but opens without a
 * password. qpdf is given plain names only: on Windows it cannot take a path with Hebrew in
 * it on its command line, so files are copied into the job's folder first, as the tools do.
 */
async function restrictedOnly(name, cwd, signal) {
  if (!bin.locate('qpdf')) return false;
  // 0: a password is needed to open it; 2: not encrypted; 3: encrypted, opens without one.
  const r = await bin.run('qpdf', ['--requires-password', name], { cwd, signal });
  return r.code === 3;
}

/**
 * Opened copies of the restricted-only files among `inputs`, in the job's scratch folder,
 * each under its own name so what the tool says names the file the user chose.
 * Returns { inputs, original, lifted }: the paths to give the tool, a map from a copy back
 * to the file it was made from, and how many files were opened.
 */
async function openRestricted(inputs, scratch, signal) {
  const opened = [];
  const original = new Map();
  for (let i = 0; i < inputs.length; i++) {
    const file = inputs[i];
    const staged = `rs-${i}.pdf`;
    if (!/\.pdf$/i.test(file) || !(await fs.copyFile(file, path.join(scratch, staged)).then(() => true, () => false)) ||
      !(await restrictedOnly(staged, scratch, signal))) {
      await fs.rm(path.join(scratch, staged), { force: true });
      opened.push(file);
      continue;
    }
    const plain = `rs-${i}-open.pdf`;
    const r = await bin.run('qpdf', ['--decrypt', '--', staged, plain], { cwd: scratch, signal });
    await fs.rm(path.join(scratch, staged), { force: true });
    // 3: done, with warnings qpdf repaired on the way.
    if ((r.code !== 0 && r.code !== 3) || !(await fs.stat(path.join(scratch, plain)).catch(() => null))) {
      throw new Error(`הקובץ "${path.basename(file)}" נעול להדפסה והעתקה, ולא ניתן היה לפתוח עותק שלו. אפשר לנסות קודם את "הסרת סיסמה".`);
    }
    // Under the file's own name, so the tool's messages and results name it.
    const dir = path.join(scratch, `opened-${i}`);
    await fs.mkdir(dir, { recursive: true });
    const copy = path.join(dir, path.basename(file));
    await fs.rename(path.join(scratch, plain), copy);
    opened.push(copy);
    original.set(copy, file);
  }
  return { inputs: opened, original, lifted: original.size };
}

/** The sentence a result adds when files were opened for it. */
function liftedNote(count) {
  if (!count) return '';
  return count === 1
    ? ' הקובץ היה נעול להדפסה והעתקה בלבד, ולכן העותק נשמר בלי ההגבלה.'
    : ` ${count} מהקבצים היו נעולים להדפסה והעתקה בלבד, ולכן העותקים נשמרו בלי ההגבלה.`;
}

module.exports = { restrictedOnly, openRestricted, liftedNote };
