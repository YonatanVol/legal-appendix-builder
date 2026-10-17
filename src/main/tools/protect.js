'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const bin = require('../engine/binaries');
const text = require('../pdf/text');
const { stage, scratchPath } = require('../engine/stage');

/**
 * Protect with a password: AES-256, the strongest encryption PDF has.
 *
 * options.password     needed to open the file
 * options.allowPrint   default true
 * options.allowCopy    default true
 * options.allowEdit    default false
 *
 * Restrictions on printing, copying and editing need an owner password that differs
 * from the opening one, or anyone who can open the file could lift them. When none is
 * given a long random one is made and not kept: nobody can lift the restrictions, which
 * is what was asked for. They are honoured by PDF readers rather than enforced by the
 * encryption itself, and the summary says so.
 */
async function run({ inputs, options = {}, ctx }) {
  const password = String(options.password || '');
  if (!password) throw new Error('כתוב סיסמה לפתיחת הקובץ.');
  const owner = String(options.ownerPassword || '') || crypto.randomBytes(24).toString('base64url');
  const allowPrint = options.allowPrint !== false;
  const allowCopy = options.allowCopy !== false;
  const allowEdit = options.allowEdit === true;

  const outputs = [];
  for (let i = 0; i < inputs.length; i++) {
    const name = path.basename(inputs[i]);
    ctx.progress(i / inputs.length, `מצפין את "${name}"…`);
    await readable(inputs[i]);
    const src = await stage(ctx, inputs[i], i);
    const need = await bin.run('qpdf', ['--requires-password', src], { cwd: ctx.scratch, signal: ctx.signal });
    if (need.code === 0 || need.code === 3) {
      throw new Error(`הקובץ "${name}" כבר מוגן. כדי להחליף סיסמה הסר קודם את הקיימת בכלי "הסרת סיסמה".`);
    }
    const out = `out-${i}.pdf`;
    // The options, passwords among them, go to qpdf through its standard input ("@-"),
    // one per line, so they never sit on a command line another program could read.
    const lines = [
      '--encrypt',
      `--user-password=${password}`,
      `--owner-password=${owner}`,
      '--bits=256',
      `--print=${allowPrint ? 'full' : 'none'}`,
      `--modify=${allowEdit ? 'all' : 'none'}`,
      `--extract=${allowCopy ? 'y' : 'n'}`,
      '--',
      src,
      out,
    ];
    if (lines.some((l) => /[\r\n]/.test(l))) throw new Error('הסיסמה לא יכולה להכיל ירידת שורה.');
    const result = await bin.run('qpdf', ['@-'], { cwd: ctx.scratch, signal: ctx.signal, input: `${lines.join('\n')}\n` });
    ctx.throwIfCancelled();
    if (result.code !== 0 && result.code !== 3) throw new Error(`לא ניתן היה להצפין את "${name}". ${qpdfReason(result.stderr)}`);
    outputs.push(await ctx.writeOutput(await fs.readFile(scratchPath(ctx, out)), { source: inputs[i], label: 'מוגן', ext: 'pdf' }));
  }

  const limits = [!allowPrint && 'הדפסה', !allowCopy && 'העתקת טקסט', !allowEdit && 'עריכה'].filter(Boolean);
  let summary = inputs.length === 1 ? 'הקובץ מוצפן בסיסמה.' : `${inputs.length} קבצים מוצפנים בסיסמה.`;
  if (limits.length) summary += ` חסומים: ${limits.join(', ')}. ההגבלות האלה נשמרות על ידי תוכנות קריאת PDF, והסיסמה עצמה היא ההגנה האמיתית.`;
  summary += ' שמור את הסיסמה במקום בטוח: בלעדיה אי אפשר לפתוח את הקובץ.';
  return { summary, display: outputs };
}

/**
 * qpdf answers "not encrypted" for a file it cannot read at all, so a damaged file is
 * caught here first and called what it is.
 */
async function readable(file) {
  try {
    const doc = await text.open(file);
    await doc.destroy();
  } catch (err) {
    // Asking for a password means the file itself is sound.
    if (err && err.name === 'PasswordException') return;
    throw new Error(`הקובץ "${path.basename(file)}" פגום ולא ניתן לקרוא אותו. אפשר לנסות קודם את "תיקון PDF".`);
  }
}

function qpdfReason(stderr) {
  const line = String(stderr || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line ? `(${line.replace(/^qpdf:\s*/, '')})` : '';
}

module.exports = { run, availability: () => bin.availability('qpdf'), qpdfReason, readable };
