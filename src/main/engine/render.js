'use strict';

const fs = require('fs');
const path = require('path');

const bin = require('./binaries');

/**
 * Draw pages as images with Ghostscript, as they appear: turned by their /Rotate and
 * cut to their crop box. Returns one file per requested page, in the order asked.
 *
 * @param {object} ctx       the job context (scratch folder, signal, progress)
 * @param {string} src       a staged PDF (ASCII path in scratch)
 * @param {number[]} indices 0-based pages
 * @param {{dpi?: number, device?: string, ext?: string, tag?: string, onPage?: Function}} [opts]
 */
async function renderPages(ctx, src, indices, { dpi = 300, device = 'png16m', ext = 'png', tag = 'r', onPage } = {}) {
  if (!indices.length) return [];
  const pattern = `${tag}-%05d.${ext}`;
  const args = [
    '-dNOPAUSE', '-dBATCH', '-dSAFER', `-sDEVICE=${device}`, `-r${dpi}`,
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dUseCropBox',
    `-sPageList=${indices.map((i) => i + 1).join(',')}`,
    `-sOutputFile=${pattern}`,
  ];
  if (device === 'jpeg') args.push('-dJPEGQ=90');
  args.push(src);
  const result = await bin.run('gs', args, {
    cwd: ctx.scratch,
    signal: ctx.signal,
    onLine: (line) => {
      const m = /^Page (\d+)/.exec(line);
      if (m && onPage) onPage(Number(m[1]) - 1);
    },
  });
  ctx.throwIfCancelled();
  if (result.code !== 0) throw new Error('לא ניתן היה לצייר את העמודים. ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".');
  const files = indices.map((_, k) => path.join(ctx.scratch, `${tag}-${String(k + 1).padStart(5, '0')}.${ext}`));
  const missing = files.findIndex((f) => !fs.existsSync(f));
  if (missing !== -1) throw new Error(`לא ניתן היה לצייר את עמוד ${indices[missing] + 1}. ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);
  return files;
}

module.exports = { renderPages };
