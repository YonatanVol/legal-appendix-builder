'use strict';

const fs = require('fs');
const path = require('path');
const {
  beginText, endText, setTextRenderingMode, TextRenderingMode,
  setFontAndSize, setCharacterSqueeze, showText, setTextMatrix,
  pushGraphicsState, popGraphicsState,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const { visualFrame } = require('./stamp');

const FONT = path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'DavidCLM-Medium.otf');

/**
 * Words below this confidence are left out. A wrong word in the text layer is worse
 * than a missing one: it sends a search to the wrong page and pollutes copied text.
 */
const MIN_CONFIDENCE = 45;

/** Hebrew points are dropped from the text layer only, so a search without them still matches. */
const COMBINING = /[֑-ׇ׳״]/g;

let fontBytes = null;
const loadFont = () => (fontBytes = fontBytes || fs.readFileSync(FONT));

/**
 * Put an invisible, searchable text layer on a page, word by word, over where each word
 * was seen on the page image.
 *
 * This is the document scanner app's method, measured there across pdf.js, poppler
 * and macOS PDFKit: Hebrew in logical order, each word placed absolutely. Tesseract's
 * own PDF output reads backwards in two of those three. Here it also handles pages
 * turned by /Rotate: positions are found in the page as shown and mapped into the
 * page's own space, and the text runs in the shown direction.
 *
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage} page
 * @param {{words: Array}} ocr      word boxes in pixels of the page image
 * @param {{width: number, height: number, dpi: number}} image  the image the boxes refer to
 * @returns {Promise<number>} words placed
 */
async function stampTextLayer(doc, page, ocr, image) {
  const words = (ocr.words || []).filter((w) => w.text && w.text.trim() && (w.confidence == null || w.confidence >= MIN_CONFIDENCE));
  if (!words.length) return 0;

  if (!doc.__fontkit) {
    doc.registerFontkit(fontkit);
    doc.__fontkit = true;
  }
  const font = doc.__ocrFont || (doc.__ocrFont = await doc.embedFont(loadFont(), { subset: true }));
  const fontKey = page.node.newFontDictionary(font.name, font.ref);

  const frame = visualFrame(page);
  const sx = frame.width / image.width;
  const sy = frame.height / image.height;
  const rad = (frame.angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));

  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let placed = 0;
  for (const w of words) {
    const text = w.text.replace(COMBINING, '').trim();
    if (!text) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    const left = x0 * sx;
    const width = (x1 - x0) * sx;
    const bottom = (image.height - y1) * sy;
    const height = (y1 - y0) * sy;
    if (width <= 0 || height <= 0) continue;

    let encoded;
    try {
      encoded = font.encodeText(text);
    } catch {
      continue; // a character the font cannot draw: skip the word, not the page
    }
    const size = Math.max(1, height * 0.85);
    const natural = font.widthOfTextAtSize(text, size);
    const squeeze = natural > 0 ? Math.max(1, Math.min(1000, (width / natural) * 100)) : 100;
    const at = frame.toUser(left, bottom);
    ops.push(
      setFontAndSize(fontKey, size),
      setCharacterSqueeze(squeeze),
      // Absolute for every word: relative moves drift down a long page.
      setTextMatrix(cos, sin, -sin, cos, at.x, at.y),
      showText(encoded),
    );
    placed++;
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
  return placed;
}

module.exports = { stampTextLayer, MIN_CONFIDENCE };
