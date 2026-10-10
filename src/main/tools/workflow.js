'use strict';

const fs = require('fs/promises');
const path = require('path');

const workflows = require('../workflows');

/*
 * Running a workflow: each step is the ordinary tool, given the file the step before
 * made. Files between steps stay in the job's scratch folder and are gone when the run
 * ends; only the last step writes beside the original, named after the workflow, so the
 * result looks as if one tool had made it.
 *
 * Several files go through the chain one by one, unless the first step is Merge, which
 * makes them one.
 *
 * options.name      the workflow's name, used for the result's name
 * options.steps     the steps, as saved
 * options.secrets   { stepIndex: { password, ... } } entered just before running
 */
async function run({ inputs, options = {}, ctx }) {
  const tools = require('./index');
  const steps = Array.isArray(options.steps) ? options.steps : [];
  const why = workflows.problem(steps);
  if (why) throw new Error(why);
  const secrets = options.secrets || {};
  const names = steps.map((s) => (tools.get(s.toolId) || {}).name || s.toolId);
  const label = String(options.name || '').trim();

  for (const [k, step] of steps.entries()) {
    const tool = tools.runnable(step.toolId);
    if (!tool) throw new Error(`השלב "${names[k]}" אינו זמין בגרסה הזו.`);
    if (typeof tool.availability === 'function') {
      const status = await tool.availability({});
      if (status && status.available === false) throw new Error(`השלב "${names[k]}": ${status.reason}`);
    }
  }

  const batches = steps[0].toolId === 'merge' ? [inputs] : inputs.map((f) => [f]);
  const display = [];
  const notes = [];
  for (let b = 0; b < batches.length; b++) {
    let current = batches[b];
    const original = current[0];
    for (let k = 0; k < steps.length; k++) {
      const last = k === steps.length - 1;
      const step = steps[k];
      const tool = tools.runnable(step.toolId);
      const stepDir = path.join(ctx.scratch, `b${b}-s${k}`);
      await fs.mkdir(stepDir, { recursive: true });
      const made = [];
      const inner = {
        ...ctx,
        progress: (fraction, text) => ctx.progress(
          (b + (k + Math.min(1, Math.max(0, Number(fraction) || 0))) / steps.length) / batches.length,
          `${names[k]}${batches.length > 1 ? ` (קובץ ${b + 1} מתוך ${batches.length})` : ''}: ${text || ''}`,
        ),
        async writeOutput(bytes, where) {
          if (last) {
            // The result goes beside the original. A single result takes the workflow's
            // name; a folder of parts or a pair of files keeps the step's own naming.
            const named = where.dir ? where : { ...where, name: undefined, label: label || where.label };
            const out = await ctx.writeOutput(bytes, { ...named, source: original });
            made.push(out);
            return out;
          }
          // Named after the original, so a later step's message names the file the user
          // knows rather than a working copy.
          const base = path.parse(original).name;
          const file = path.join(stepDir, `${made.length ? `${base} (${made.length + 1})` : base}.${where.ext || 'pdf'}`);
          await fs.writeFile(file, bytes);
          made.push(file);
          return file;
        },
        outputFolder: (_source, folderLabel) => ctx.outputFolder(original, label || folderLabel),
      };
      const result = await tool.run({ inputs: current, options: { ...(step.options || {}), ...(secrets[k] || {}) }, ctx: inner });
      ctx.throwIfCancelled();
      if (last) {
        if (!made.length && !(result.display && result.display.length) && current[0] !== original) {
          // The last step rightly made nothing (Compress of a file already as small as it
          // gets), but the steps before it did: their result is the workflow's result.
          made.push(await ctx.writeOutput(await fs.readFile(current[0]), {
            source: original, label: label || names[k - 1], ext: path.extname(current[0]).slice(1) || 'pdf',
          }));
        }
        display.push(...(result.display && result.display.length ? result.display : made));
        if (result.summary) notes.push(result.summary);
        break;
      }
      const next = made.filter((f) => /\.pdf$/i.test(f));
      // A step may rightly make nothing (Compress of a file already as small as it gets);
      // the file goes on to the next step as it was.
      if (next.length) current = next;
    }
  }
  const tail = notes.length === 1 ? ` ${notes[0]}` : '';
  return { summary: `התהליך הסתיים: ${names.join(' ← ')}.${tail}`, display };
}

module.exports = { run };
