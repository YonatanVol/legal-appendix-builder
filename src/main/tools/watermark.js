'use strict';

const fs = require('fs/promises');
const path = require('path');

const { loadPdf } = require('../pdf/inspect');
const { visualFrame, spot, embedStamps, drawAt, sendLastDrawingToBack } = require('../pdf/stamp');
const { parseRanges, indicesOf } = require('../../shared/pages');

/**
 * Watermark: text or an image over (or under) the pages.
 *
 * options.kind      'text' | 'image'
 * options.text      the text (Hebrew is typeset correctly)
 * options.image     path of a PNG or JPG
 * options.size      text size in points (default 60)
 * options.scale     image width as a fraction of the page width (default 0.4)
 * options.color     '#rrggbb'
 * options.opacity   0..1 (default 0.25)
 * options.angle     degrees counter-clockwise (default 45)
 * options.position  'middle-center', 'top-left', ... or 'tile' to repeat it over the page
 * options.layer     'over' | 'under'. Under stays behind text, but a scanned page is
 *                   itself one opaque image, so on scans it would not show.
 * options.pages     "" for all, or ranges
 */
async function run({ inputs, options = {}, ctx }) {
  const kind = options.kind === 'image' ? 'image' : 'text';
  const text = String(options.text || '').trim();
  if (kind === 'text' && !text) throw new Error('כתוב את הטקסט של סימן המים.');
  if (kind === 'image' && !options.image) throw new Error('בחר תמונה לסימן המים.');
  const opacity = Math.min(1, Math.max(0.05, Number(options.opacity ?? 0.25)));
  const turn = Number(options.angle ?? 45) || 0;
  const pagesText = String(options.pages || '').trim();

  let imageBytes = null;
  if (kind === 'image') {
    try {
      imageBytes = await fs.readFile(options.image);
    } catch {
      throw new Error(`לא ניתן לקרוא את התמונה "${path.basename(options.image)}".`);
    }
  }

  const outputs = [];
  for (let f = 0; f < inputs.length; f++) {
    const doc = await loadPdf(inputs[f]);
    let item;
    if (kind === 'text') {
      [item] = await embedStamps(doc, [text], { size: Math.min(200, Math.max(8, Number(options.size) || 60)), color: options.color || '#c00000', bold: true });
    } else {
      const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50;
      const isJpg = imageBytes[0] === 0xff && imageBytes[1] === 0xd8;
      if (!isPng && !isJpg) throw new Error('סימן מים מתמונה מקבל קובצי PNG או JPG בלבד.');
      const image = isPng ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
      item = { image, width: image.width, height: image.height };
    }

    const indices = pagesText ? indicesOf(parseRanges(pagesText, doc.getPageCount())) : doc.getPageIndices();
    indices.forEach((pageIndex, k) => {
      const page = doc.getPage(pageIndex);
      const frame = visualFrame(page);
      let w = item.width;
      let h = item.height;
      if (kind === 'image') {
        const scale = Math.min(1, Math.max(0.05, Number(options.scale) || 0.4));
        w = frame.width * scale;
        h = (item.height / item.width) * w;
      }
      if (options.position === 'tile') {
        const stepX = w * 1.6 + 40;
        const stepY = h * 3 + 40;
        let row = 0;
        for (let vy = -h; vy < frame.height + h; vy += stepY, row++) {
          for (let vx = -w + (row % 2) * (stepX / 2); vx < frame.width + w; vx += stepX) {
            drawAt(page, item, { vx, vy, w, h, turn, opacity });
          }
        }
      } else {
        const at = spot(frame, options.position || 'middle-center', w, h, 36);
        drawAt(page, item, { ...at, w, h, turn, opacity });
      }
      if (options.layer === 'under') sendLastDrawingToBack(page);
      if (k % 10 === 0) ctx.progress((f + k / indices.length) / inputs.length, `עמוד ${k + 1} מתוך ${indices.length}`);
    });

    outputs.push(await ctx.writeOutput(await doc.save({ useObjectStreams: true }), {
      source: inputs[f], label: 'סימן מים', ext: 'pdf',
    }));
  }
  return {
    summary: inputs.length === 1 ? 'סימן המים נוסף.' : `סימן המים נוסף ל-${inputs.length} קבצים.`,
    display: outputs,
  };
}

module.exports = { run };
