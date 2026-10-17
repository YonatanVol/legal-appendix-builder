'use strict';

const fs = require('fs/promises');
const path = require('path');

const office = require('../engine/office');
const bin = require('../engine/binaries');
const { stage } = require('../engine/stage');
const text = require('../pdf/text');
const { ocrFile } = require('./ocr');
const { wordDocument } = require('../pdf/docx');

/**
 * PDF to Word.
 *
 * A PDF with text is opened by Word itself (or LibreOffice), which rebuilds paragraphs,
 * tables and Hebrew direction as an editable document.
 *
 * A scanned PDF has no text for Word to work with, so it is read with OCR first and the
 * Word file is written from the recognised text, right to left, page by page. Its
 * layout is simpler than the scan's, and the summary says so.
 */
async function run({ inputs, ctx }) {
  const display = [];
  const notes = [];
  for (let i = 0; i < inputs.length; i++) {
    const name = path.basename(inputs[i]);
    ctx.progress(i / inputs.length, `בודק את "${name}"…`);
    const pages = await text.documentText(inputs[i]);
    const letters = pages.join('').replace(/\s/g, '').length;
    if (letters < 40 * pages.length * 0.25 && bin.locate('gs')) {
      const read = await ocrFile(inputs[i], { langs: 'heb+eng' }, ctx, (f, label) => ctx.progress((i + f * 0.9) / inputs.length, label));
      const bytes = await wordDocument(read.pages);
      display.push(await ctx.writeOutput(bytes, { source: inputs[i], label: '', ext: 'docx' }));
      notes.push(`${inputs.length > 1 ? `"${name}": ` : ''}הקובץ סרוק, ולכן הטקסט זוהה בזיהוי טקסט ונכתב ל-Word בעיצוב פשוט. כדאי לעבור עליו מול המקור.`);
      continue;
    }
    const staged = path.join(ctx.scratch, await stage(ctx, inputs[i], i));
    const result = await office.convert('word', staged, 'docx', ctx);
    display.push(await ctx.writeOutput(await fs.readFile(result.file), { source: inputs[i], label: '', ext: 'docx' }));
    notes.push(`${inputs.length > 1 ? `"${name}": ` : ''}הומר למסמך Word שאפשר לערוך, בעזרת ${result.engine}.`);
  }
  return { summary: notes.join(' '), display };
}

module.exports = { run, availability: () => office.availability('word') };
