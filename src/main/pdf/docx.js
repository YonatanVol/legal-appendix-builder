'use strict';

const { Document, Packer, Paragraph, TextRun, PageBreak } = require('docx');

const HEBREW = /[֐-׿]/;

/**
 * A Word document from plain text, page by page. Hebrew paragraphs are set right to
 * left, in David, so the file opens in Word already laid out the way the office writes.
 * @param {string[]} pages
 */
async function wordDocument(pages) {
  const children = [];
  pages.forEach((page, i) => {
    const paragraphs = String(page || '').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    paragraphs.forEach((p, k) => {
      const rtl = HEBREW.test(p);
      const runs = [new TextRun({ text: p, font: 'David', size: 24, rightToLeft: rtl })];
      if (i > 0 && k === 0) runs.unshift(new PageBreak());
      children.push(new Paragraph({ children: runs, bidirectional: rtl }));
    });
  });
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { wordDocument };
