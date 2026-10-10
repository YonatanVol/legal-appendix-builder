'use strict';

const fs = require('fs/promises');
const path = require('path');

const bin = require('../engine/binaries');
const { stage, scratchPath } = require('../engine/stage');
const { qpdfReason, readable } = require('./protect');

/**
 * Remove the password from a PDF whose password is known.
 *
 * options.password   the password to open it; not needed when the file opens freely
 *                    and only restricts printing or copying.
 */
async function run({ inputs, options = {}, ctx }) {
  const password = String(options.password || '');
  const outputs = [];
  const notes = [];
  for (let i = 0; i < inputs.length; i++) {
    const name = path.basename(inputs[i]);
    ctx.progress(i / inputs.length, `פותח את "${name}"…`);
    await readable(inputs[i]);
    const src = await stage(ctx, inputs[i], i);

    // 0: a password is needed to open it; 3: encrypted, opens without one; 2: not encrypted.
    const need = await bin.run('qpdf', ['--requires-password', src], { cwd: ctx.scratch, signal: ctx.signal });
    if (need.code === 2) throw new Error(`הקובץ "${name}" אינו מוגן בסיסמה. אין מה להסיר.`);
    if (need.code === 0 && !password) throw new Error(`הקובץ "${name}" נעול בסיסמה לפתיחה. כתוב אותה כדי להסיר אותה.`);

    const out = `out-${i}.pdf`;
    // The password reaches qpdf through its standard input, never the command line.
    const args = ['--decrypt'];
    if (password) args.push('--password-file=-');
    args.push('--', src, out);
    const result = await bin.run('qpdf', args, { cwd: ctx.scratch, signal: ctx.signal, input: password ? `${password}\n` : null });
    ctx.throwIfCancelled();
    if (result.code === 2 && /invalid password/i.test(result.stderr)) {
      throw new Error(`הסיסמה של "${name}" שגויה. בדוק אותיות גדולות וקטנות ואת שפת המקלדת.`);
    }
    if (result.code !== 0 && result.code !== 3) throw new Error(`לא ניתן היה לפתוח את "${name}". ${qpdfReason(result.stderr)}`);
    outputs.push(await ctx.writeOutput(await fs.readFile(scratchPath(ctx, out)), { source: inputs[i], label: 'ללא סיסמה', ext: 'pdf' }));
    notes.push(need.code === 3 ? 'ההגבלות על הדפסה והעתקה הוסרו' : 'הסיסמה הוסרה');
  }
  const same = notes.every((n) => n === notes[0]);
  return {
    summary: inputs.length === 1 ? `${notes[0]}.` : same ? `${notes[0]} מ-${inputs.length} קבצים.` : `הוסרו הסיסמאות וההגבלות מ-${inputs.length} קבצים.`,
    display: outputs,
  };
}

module.exports = { run, availability: () => bin.availability('qpdf') };
