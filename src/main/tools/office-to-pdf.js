'use strict';

const fs = require('fs/promises');
const path = require('path');

const office = require('../engine/office');
const { stage } = require('../engine/stage');
const { strictPages } = require('../engine/verify');

/**
 * Word, PowerPoint and Excel to PDF, through the Office program on the PC (or
 * LibreOffice when Office is not installed). One factory, three tools.
 */
function make(program, noun) {
  async function run({ inputs, ctx }) {
    const display = [];
    let engine = '';
    for (let i = 0; i < inputs.length; i++) {
      const name = path.basename(inputs[i]);
      ctx.progress(i / inputs.length, `ממיר את "${name}"…`);
      const staged = path.join(ctx.scratch, await stage(ctx, inputs[i], i));
      const result = await office.convert(program, staged, 'pdf', ctx);
      engine = result.engine;
      if (!(await strictPages(result.file))) throw new Error(`ההמרה של "${name}" יצרה קובץ שלא נפתח.`);
      display.push(await ctx.writeOutput(await fs.readFile(result.file), { source: inputs[i], label: '', ext: 'pdf' }));
    }
    const what = inputs.length === 1 ? `ה${noun} הומר` : `${inputs.length} קבצים הומרו`;
    return { summary: `${what} ל-PDF בעזרת ${engine}.`, display };
  }
  return { run, availability: () => office.availability(program) };
}

module.exports = { make };
