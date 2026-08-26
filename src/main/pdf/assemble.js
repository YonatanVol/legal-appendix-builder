'use strict';

const fs = require('fs/promises');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const { loadPdf, inspect } = require('./inspect');
const { resolveLayout, formatRange } = require('./layout');
const { renderHtmlToPdf } = require('./render');
const { dividerHtml, tocHtml } = require('../templates');

const NUMBER_FONT_SIZE = 11;
const NUMBER_BOTTOM_MARGIN = 24; // points from the visual bottom edge

/**
 * Where to draw the running page number, in unrotated user space.
 *
 * A scanned page may carry /Rotate. getSize() reports the mediabox and ignores it,
 * so "bottom centre" has to be expressed in the page's own coordinates and the text
 * counter-rotated, or the number lands on an edge and reads sideways.
 */
function bottomCentre(page) {
  const { width: w, height: h } = page.getSize();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const vy = NUMBER_BOTTOM_MARGIN;

  switch (angle) {
    case 90: {
      // Visual size is (h, w); visual x runs along user y, visual y along -user x.
      const vx = h / 2;
      return { x: w - vy, y: vx, angle: 90, dir: [0, 1], up: [-1, 0] };
    }
    case 180: {
      const vx = w / 2;
      return { x: w - vx, y: h - vy, angle: 180, dir: [-1, 0], up: [0, -1] };
    }
    case 270: {
      const vx = h / 2;
      return { x: vy, y: h - vx, angle: 270, dir: [0, -1], up: [1, 0] };
    }
    default: {
      const vx = w / 2;
      return { x: vx, y: vy, angle: 0, dir: [1, 0], up: [0, 1] };
    }
  }
}

/** Draw the running number, on an opaque patch so it stays legible over a scan. */
function stampPageNumber(page, pageNumber, font) {
  const text = String(pageNumber);
  const textWidth = font.widthOfTextAtSize(text, NUMBER_FONT_SIZE);
  const spot = bottomCentre(page);
  const [dx, dy] = spot.dir;
  const [ux, uy] = spot.up;

  const padX = 5;
  const padY = 3;
  const halfW = textWidth / 2 + padX;
  const descent = NUMBER_FONT_SIZE * 0.3 + padY;

  // Rectangle origin is its bottom-left corner in the text's own rotated frame.
  page.drawRectangle({
    x: spot.x - dx * halfW - ux * descent,
    y: spot.y - dy * halfW - uy * descent,
    width: textWidth + padX * 2,
    height: NUMBER_FONT_SIZE * 1.3 + padY * 2,
    rotate: degrees(spot.angle),
    color: rgb(1, 1, 1),
  });

  page.drawText(text, {
    x: spot.x - dx * (textWidth / 2),
    y: spot.y - dy * (textWidth / 2),
    size: NUMBER_FONT_SIZE,
    font,
    rotate: degrees(spot.angle),
    color: rgb(0, 0, 0),
  });
}

async function copyAll(target, sourceDoc) {
  const pages = await target.copyPages(sourceDoc, sourceDoc.getPageIndices());
  pages.forEach((page) => target.addPage(page));
}

/**
 * Build the complete bundle.
 *
 * @param {object} spec
 * @param {string} spec.bodyPath              the pleading, as PDF
 * @param {{title: string, files: string[]}[]} spec.appendices  each may span several files
 * @param {string} spec.outputPath
 * @param {(stage: string) => void} [onProgress]
 */
async function buildBundle({ bodyPath, appendices, outputPath }, onProgress = () => {}) {
  if (!bodyPath) throw new Error('לא נבחר קובץ של כתב התביעה.');
  if (!appendices || appendices.length === 0) throw new Error('לא נוספו נספחים.');

  appendices.forEach((appendix, i) => {
    if (!appendix.files || appendix.files.length === 0) {
      throw new Error(`לנספח ${i + 1} לא נבחרו קבצים.`);
    }
    if (!appendix.title || !appendix.title.trim()) {
      throw new Error(`לנספח ${i + 1} חסרה כותרת.`);
    }
  });

  onProgress('בודק את הקבצים…');

  const bodyInfo = await inspect(bodyPath);
  const bodyDoc = await loadPdf(bodyPath);

  // Load every appendix file up front, so a bad file fails before any work is done.
  const appendixDocs = [];
  for (const appendix of appendices) {
    const docs = [];
    for (const file of appendix.files) {
      docs.push(await loadPdf(file));
    }
    appendixDocs.push(docs);
  }

  const appendixPageCounts = appendixDocs.map((docs) =>
    docs.reduce((sum, doc) => sum + doc.getPageCount(), 0)
  );
  const titles = appendices.map((a) => a.title.trim());
  const pageSize = bodyInfo.pageSize;

  onProgress('בונה את תוכן העניינים…');

  // The table of contents prints the ranges, and its own length shifts them.
  const { layout, toc } = await resolveLayout(
    bodyDoc.getPageCount(),
    appendixPageCounts,
    (candidate) => {
      const { html, margins, script } = tocHtml(candidate, titles, pageSize);
      return renderHtmlToPdf(html, pageSize, margins, { script });
    }
  );

  onProgress('מייצר דפי חוצץ…');

  const dividers = [];
  for (let i = 0; i < layout.appendices.length; i++) {
    const { html, margins } = dividerHtml(layout.appendices[i], titles[i]);
    const rendered = await renderHtmlToPdf(html, pageSize, margins);
    if (rendered.pageCount !== 1) {
      throw new Error(
        `הכותרת של נספח ${i + 1} ארוכה מדי עבור דף חוצץ אחד. קצר אותה ונסה שוב.`
      );
    }
    dividers.push(rendered);
  }

  onProgress('מאחד את הקבצים…');

  const output = await PDFDocument.create();
  await copyAll(output, bodyDoc);
  await copyAll(output, await PDFDocument.load(toc.bytes));

  for (let i = 0; i < appendices.length; i++) {
    await copyAll(output, await PDFDocument.load(dividers[i].bytes));
    for (const doc of appendixDocs[i]) {
      await copyAll(output, doc);
    }
  }

  if (output.getPageCount() !== layout.totalPages) {
    throw new Error(
      `שגיאה פנימית: נוצרו ${output.getPageCount()} עמודים במקום ${layout.totalPages}.`
    );
  }

  onProgress('ממספר עמודים…');

  const font = await output.embedFont(StandardFonts.Helvetica);
  output.getPages().forEach((page, i) => stampPageNumber(page, i + 1, font));

  onProgress('שומר…');
  await fs.writeFile(outputPath, await output.save());

  return {
    outputPath,
    totalPages: layout.totalPages,
    tocPage: layout.tocStart,
    tocPages: layout.tocPages,
    appendices: layout.appendices.map((a, i) => ({
      number: a.number,
      title: titles[i],
      dividerPage: a.dividerPage,
      range: formatRange(a),
    })),
  };
}

module.exports = { buildBundle, stampPageNumber, bottomCentre };
