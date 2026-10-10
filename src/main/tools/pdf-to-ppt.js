'use strict';

const fs = require('fs/promises');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

const bin = require('../engine/binaries');
const { stage } = require('../engine/stage');
const { loadPdf } = require('../pdf/inspect');

/**
 * PDF to PowerPoint: each page becomes a slide, as a picture of the page.
 *
 * That is what a PDF holds, positioned marks rather than text boxes, and it is what
 * iLovePDF produces as well. The slides look exactly like the pages; their text cannot
 * be edited, and the summary says so.
 *
 * options.quality  'normal' (150 dpi) | 'high' (220 dpi)
 */
async function run({ inputs, options = {}, ctx }) {
  const dpi = options.quality === 'high' ? 220 : 150;
  const outputs = [];
  let slides = 0;
  for (let f = 0; f < inputs.length; f++) {
    const name = path.basename(inputs[f]);
    const doc = await loadPdf(inputs[f]);
    const sizes = doc.getPages().map((p) => {
      const { width, height } = p.getCropBox();
      const turned = p.getRotation().angle % 180 !== 0;
      return turned ? { width: height, height: width } : { width, height };
    });
    const src = await stage(ctx, inputs[f], f);
    const pattern = path.join(ctx.scratch, `s${f}-%05d.jpg`);
    const result = await bin.run('gs', [
      '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=jpeg', `-r${dpi}`, '-dJPEGQ=88',
      '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dUseCropBox', `-sOutputFile=${pattern}`, src,
    ], {
      signal: ctx.signal,
      onLine: (line) => {
        const m = /^Page (\d+)/.exec(line);
        if (m) ctx.progress(((f + Number(m[1]) / sizes.length) / inputs.length) * 0.9, `"${name}": עמוד ${m[1]} מתוך ${sizes.length}`);
      },
    });
    ctx.throwIfCancelled();
    if (result.code !== 0) throw new Error(`לא ניתן היה לקרוא את "${name}". ייתכן שהקובץ פגום; אפשר לנסות קודם את "תיקון PDF".`);

    // The slide takes the first page's shape; other pages are fitted inside it.
    const W = sizes[0].width / 72;
    const H = sizes[0].height / 72;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'PAGE', width: W, height: H });
    pptx.layout = 'PAGE';
    for (let i = 0; i < sizes.length; i++) {
      const jpg = await fs.readFile(path.join(ctx.scratch, `s${f}-${String(i + 1).padStart(5, '0')}.jpg`));
      const scale = Math.min(W / (sizes[i].width / 72), H / (sizes[i].height / 72));
      const w = (sizes[i].width / 72) * scale;
      const h = (sizes[i].height / 72) * scale;
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addImage({ data: `image/jpeg;base64,${jpg.toString('base64')}`, x: (W - w) / 2, y: (H - h) / 2, w, h });
    }
    ctx.progress(((f + 1) / inputs.length), 'שומר את המצגת…');
    const bytes = await pptx.write({ outputType: 'nodebuffer' });
    outputs.push(await ctx.writeOutput(bytes, { source: inputs[f], label: '', ext: 'pptx' }));
    slides += sizes.length;
  }
  return {
    summary: `נוצרה מצגת עם ${slides === 1 ? 'שקופית אחת' : `${slides} שקופיות`}, עמוד בכל שקופית. השקופיות נראות בדיוק כמו העמודים, אבל הטקסט בהן הוא חלק מהתמונה ולא ניתן לעריכה.`,
    display: outputs,
  };
}

module.exports = { run, availability: () => bin.availability('gs') };
