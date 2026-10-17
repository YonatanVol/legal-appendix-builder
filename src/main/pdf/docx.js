'use strict';

const {
  Document, Packer, Paragraph, TextRun, PageBreak, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType,
} = require('docx');

const { parse, runs } = require('./markdown');

const HEBREW = /[֐-׿]/;
const RTL = /[֐-׿؀-ۿ]/;

/**
 * A Word document from plain text, page by page (OCR). Hebrew paragraphs are set right
 * to left, in David, so the file opens in Word laid out the way the office writes.
 * @param {string[]} pages
 */
async function wordDocument(pages) {
  const children = [];
  pages.forEach((page, i) => {
    const paragraphs = String(page || '').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    paragraphs.forEach((p, k) => {
      const rtl = HEBREW.test(p);
      const r = [new TextRun({ text: p, font: 'David', size: 24, rightToLeft: rtl })];
      if (i > 0 && k === 0) r.unshift(new PageBreak());
      children.push(new Paragraph({ children: r, bidirectional: rtl }));
    });
  });
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

/**
 * A Word document from Claude's Markdown: headings, lists, tables, bold. `rtl` sets the
 * whole document right to left (Hebrew and Arabic); otherwise each paragraph follows
 * its own first letters.
 */
async function wordFromMarkdown(md, { rtl = null, title = '' } = {}) {
  const children = [];
  const dir = (text) => (rtl === null ? RTL.test(text) : rtl);
  const textRuns = (text, size = 24, forceBold = false) => runs(text).map((r) => new TextRun({ text: r.text, bold: forceBold || r.bold, font: 'David', size, rightToLeft: dir(text) }));
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, bidirectional: dir(title), children: textRuns(title, 36, true) }));
  for (const b of parse(md)) {
    if (b.type === 'break') children.push(new Paragraph({ children: [new PageBreak()] }));
    else if (b.type === 'h') {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][b.level - 1];
      children.push(new Paragraph({ heading: level, bidirectional: dir(b.text), children: textRuns(b.text, [32, 28, 26, 24][b.level - 1], true) }));
    } else if (b.type === 'li') children.push(new Paragraph({ bullet: { level: 0 }, bidirectional: dir(b.text), children: textRuns(b.text) }));
    else if (b.type === 'ol') children.push(new Paragraph({ bidirectional: dir(b.text), children: textRuns(`${b.n}. ${b.text}`) }));
    else if (b.type === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      const rows = b.rows.map((r, i) => new TableRow({
        children: Array.from({ length: width }, (_, c) => new TableCell({
          children: [new Paragraph({ bidirectional: dir(r.join(' ')), alignment: dir(r.join(' ')) ? AlignmentType.RIGHT : AlignmentType.LEFT, children: textRuns(r[c] || '', 22, i === 0) })],
        })),
      }));
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, visuallyRightToLeft: rtl === true || RTL.test(b.rows.flat().join(' ')) }));
    } else children.push(new Paragraph({ bidirectional: dir(b.text), children: textRuns(b.text) }));
  }
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

module.exports = { wordDocument, wordFromMarkdown };
