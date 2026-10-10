'use strict';

const fs = require('fs/promises');
const path = require('path');

const bin = require('../engine/binaries');
const { stage, scratchPath } = require('../engine/stage');
const { loadPdf } = require('../pdf/inspect');

/**
 * Compress with Ghostscript.
 *
 * options.level  'strong' (images at 72 dpi), 'recommended' (150 dpi), 'light' (300 dpi)
 * options.gray   convert to grayscale as well
 *
 * A file that would come out no smaller (it was already compact, or it is all text)
 * is left alone and the summary says so, instead of handing back a copy that is the
 * same size or larger and calling it compressed.
 */
const LEVELS = {
  strong: '/screen',
  recommended: '/ebook',
  light: '/printer',
};

async function run({ inputs, options = {}, ctx }) {
  const setting = LEVELS[options.level] || LEVELS.recommended;
  const outputs = [];
  const lines = [];
  let before = 0;
  let after = 0;

  for (let i = 0; i < inputs.length; i++) {
    const name = path.basename(inputs[i]);
    const pages = (await loadPdf(inputs[i])).getPageCount();
    const src = await stage(ctx, inputs[i], i);
    const out = scratchPath(ctx, `out-${i}.pdf`);
    const args = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.5',
      `-dPDFSETTINGS=${setting}`,
      '-dDetectDuplicateImages=true',
      '-dCompressFonts=true',
      '-dAutoRotatePages=/None',
    ];
    if (options.gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
    args.push(`-sOutputFile=${out}`, src);

    const result = await bin.run('gs', args, {
      signal: ctx.signal,
      onLine: (line) => {
        const m = /^Page (\d+)/.exec(line);
        if (m) ctx.progress((i + Number(m[1]) / pages) / inputs.length, `"${name}": עמוד ${m[1]} מתוך ${pages}`);
      },
    });
    ctx.throwIfCancelled();
    if (result.code !== 0) throw new Error(`לא ניתן היה לכווץ את "${name}". ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);

    const inSize = (await fs.stat(inputs[i])).size;
    const outSize = (await fs.stat(out)).size;
    before += inSize;
    if (outSize >= inSize * 0.97) {
      after += inSize;
      lines.push(`"${name}" כבר קטן ככל האפשר (${mb(inSize)}), ולכן לא נוצר עותק.`);
      continue;
    }
    after += outSize;
    outputs.push(await ctx.writeOutput(await fs.readFile(out), { source: inputs[i], label: 'מכווץ', ext: 'pdf' }));
    lines.push(`${inputs.length > 1 ? `"${name}": ` : ''}${mb(inSize)} ← ${mb(outSize)}, קטן ב-${Math.round((1 - outSize / inSize) * 100)}%.`);
  }

  if (!outputs.length) {
    return { summary: inputs.length === 1 ? lines[0] : 'כל הקבצים כבר קטנים ככל האפשר. לא נוצרו עותקים.', display: [] };
  }
  const total = inputs.length > 1 ? ` בסך הכל ${mb(before)} ← ${mb(after)}.` : '';
  return { summary: lines.join(' ') + total, display: outputs };
}

/**
 * A size for a Hebrew sentence, wrapped in a left-to-right isolate (U+2066 ... U+2069)
 * so "4.1 MB" keeps its order instead of showing as "MB 4.1".
 */
function mb(bytes) {
  const text = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `\u2066${text}\u2069`;
}

module.exports = { run, availability: () => bin.availability('gs'), mb };
