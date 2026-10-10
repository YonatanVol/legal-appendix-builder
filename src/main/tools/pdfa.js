'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const bin = require('../engine/binaries');
const { stage, scratchPath, unpacked } = require('../engine/stage');

const ASSETS = unpacked(path.join(__dirname, '..', '..', '..', 'assets', 'pdfa'));

const LEVELS = {
  '1b': { part: 1, compat: '1.4' },
  '2b': { part: 2, compat: '1.7' },
  '3b': { part: 3, compat: '1.7' },
};

/**
 * PDF to PDF/A, the archiving standard courts and archives ask for.
 *
 * options.level  '2b' (default), '1b' or '3b'
 *
 * Ghostscript converts: fonts embedded, colours given an sRGB output intent, the
 * declaration written into the file's metadata. What it produces is checked here only
 * as far as that declaration and output intent go; it is not run through a formal
 * PDF/A validator, and the summary says "converted", not "certified".
 */
async function run({ inputs, options = {}, ctx }) {
  const level = LEVELS[options.level] ? options.level : '2b';
  const { part, compat } = LEVELS[level];
  const icc = path.join(ASSETS, 'srgb.icc');
  const def = path.join(ASSETS, 'PDFA_def.ps');
  const outputs = [];

  for (let i = 0; i < inputs.length; i++) {
    const name = path.basename(inputs[i]);
    ctx.progress(i / inputs.length, `ממיר את "${name}"…`);
    const src = await stage(ctx, inputs[i], i);
    const out = scratchPath(ctx, `out-${i}.pdf`);
    const result = await bin.run('gs', [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      `--permit-file-read=${icc}`,
      `--permit-file-read=${def}`,
      '-sDEVICE=pdfwrite',
      `-dPDFA=${part}`,
      '-dPDFACompatibilityPolicy=1',
      `-dCompatibilityLevel=${compat}`,
      '-sColorConversionStrategy=RGB',
      '-dAutoRotatePages=/None',
      `-sICCProfile=${icc}`,
      `-sOutputFile=${out}`,
      def,
      src,
    ], { signal: ctx.signal });
    ctx.throwIfCancelled();
    if (result.code !== 0 || /OFFICE-PDFA-ICC-FAILED/.test(result.stdout)) {
      throw new Error(`לא ניתן היה להמיר את "${name}" ל-PDF/A. ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);
    }
    const bytes = await fs.readFile(out);
    if (!(await declares(bytes, part))) {
      throw new Error(`ההמרה של "${name}" לא הסתיימה כמצופה: בקובץ שנוצר חסרה ההצהרה על PDF/A.`);
    }
    outputs.push(await ctx.writeOutput(bytes, { source: inputs[i], label: `PDF-A`, ext: 'pdf' }));
  }
  return {
    summary: `${inputs.length === 1 ? 'הקובץ הומר' : `${inputs.length} קבצים הומרו`} ל-PDF/A-${level}. ההמרה לא נבדקה בכלי אימות רשמי.`,
    display: outputs,
  };
}

/** The file says it is PDF/A of this part, and carries an output intent. */
async function declares(bytes, part) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const intents = doc.catalog.lookup(PDFName.of('OutputIntents'));
  const xmp = bytes.toString('latin1');
  return !!intents && new RegExp(`pdfaid:part(>|=["'])${part}`).test(xmp);
}

module.exports = { run, availability: () => bin.availability('gs'), declares };
