'use strict';

const text = require('../pdf/text');

/**
 * PDF to Markdown: headings from type size, lists from their markers, paragraphs from
 * the space between lines. Hebrew lines are read right to left.
 *
 * options.pageBreaks  a "---" line between pages (default false)
 *
 * A scanned page has no text to read; such pages are counted and the summary says
 * to run OCR first, instead of producing an empty file that looks like success.
 */
async function run({ inputs, options = {}, ctx }) {
  const outputs = [];
  let scanned = 0;
  let pagesTotal = 0;

  for (let f = 0; f < inputs.length; f++) {
    const doc = await text.open(inputs[f]);
    const blocks = [];
    try {
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        ctx.progress((f + p / doc.numPages) / inputs.length, `עמוד ${p} מתוך ${doc.numPages}`);
        pages.push(await text.pageLines(doc, p));
      }
      pagesTotal += pages.length;

      const heights = pages.flatMap((pg) => pg.lines.map((l) => Math.round(l.height * 2) / 2)).sort((a, b) => a - b);
      const body = heights.length ? heights[Math.floor(heights.length / 2)] : 12;

      pages.forEach((pg, i) => {
        if (!pg.lines.length) scanned++;
        if (i && options.pageBreaks) blocks.push('---');
        let para = [];
        let prev = null;
        let inItem = false; // the last block is a list item that may still wrap
        const flush = () => {
          if (para.length) blocks.push(para.join(' '));
          para = [];
          inItem = false;
        };
        for (const line of pg.lines) {
          const ratio = line.height / body;
          const heading = ratio >= 1.6 ? '#' : ratio >= 1.3 ? '##' : line.bold && line.text.length < 80 && ratio >= 1 ? '###' : '';
          // Word exports its bullets as Symbol and Wingdings glyphs in the private-use
          // area; with no Unicode mapping they arrive as control characters instead.
          const bullet = /^[•·▪●◦○■□\-*–\uE000-\uF8FF\u0000-\u0008]\s*/.exec(line.text);
          const numbered = /^\(?\d{1,3}[.)]\s+/.exec(line.text);
          const gap = prev ? line.y - prev.y - prev.height : 0;

          if (heading) {
            flush();
            blocks.push(`${heading} ${escape(line.text)}`);
          } else if (bullet) {
            flush();
            blocks.push(`- ${escape(line.text.slice(bullet[0].length))}`);
            inItem = true;
          } else if (numbered) {
            flush();
            blocks.push(`${numbered[0].replace(/[()\s]/g, '').replace(/\)$/, '.')} ${escape(line.text.slice(numbered[0].length))}`);
            inItem = true;
          } else if (inItem && prev && gap <= prev.height * 0.9) {
            // A list item that wraps onto the next line is still the same item.
            blocks[blocks.length - 1] += ` ${escape(line.text)}`;
          } else {
            if (prev && gap > prev.height * 0.9) flush();
            para.push(escape(line.text));
          }
          prev = line;
        }
        flush();
      });
    } finally {
      await doc.destroy();
    }

    const markdown = joinBlocks(blocks) + '\n';
    outputs.push(await ctx.writeOutput(Buffer.from(markdown, 'utf8'), { source: inputs[f], label: '', ext: 'md' }));
  }

  let summary = inputs.length === 1 ? 'נוצר קובץ Markdown.' : `נוצרו ${inputs.length} קובצי Markdown.`;
  if (scanned === pagesTotal && pagesTotal) {
    summary = 'לא נמצא טקסט בקובץ: נראה שהוא סרוק. הפעל קודם זיהוי טקסט (OCR) ואז המר שוב.';
  } else if (scanned) {
    summary += ` ${scanned === 1 ? 'בעמוד אחד' : `ב-${scanned} עמודים`} לא נמצא טקסט, כנראה סריקה. זיהוי טקסט (OCR) יוסיף אותו.`;
  }
  return { summary, display: outputs };
}

/** List items stay together; everything else is separated by a blank line. */
function joinBlocks(blocks) {
  let out = '';
  blocks.forEach((b, i) => {
    if (i) {
      const listPair = /^(- |\d+\. )/.test(b) && /^(- |\d+\. )/.test(blocks[i - 1]);
      out += listPair ? '\n' : '\n\n';
    }
    out += b;
  });
  return out;
}

/** Only what would otherwise change meaning in Markdown. */
function escape(s) {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(#+)\s/, '\\$1 ');
}

module.exports = { run };
