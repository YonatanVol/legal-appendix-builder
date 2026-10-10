'use strict';

const { PDFDocument, degrees, rgb } = require('pdf-lib');

const { renderHtmlToPdf } = require('./render');
const { FONT_FACES, FONT_STACK, escapeHtml } = require('../templates');

/*
 * Putting things on existing pages: page numbers, watermarks, signatures, edits.
 *
 * Two problems are solved here once, for every tool.
 *
 * 1. Where. People say "bottom right", meaning the page as it appears on screen. A
 *    scanned page often carries /Rotate, and its own coordinates then run sideways,
 *    so a position is given in visual coordinates (origin at the visual bottom-left,
 *    in points) and mapped into the page's own space here.
 *
 * 2. How Hebrew is drawn. A PDF library that draws text directly needs the
 *    bidirectional order resolved by hand. Text is instead typeset by Chromium, one
 *    stamp per page of a small PDF, and each stamp is placed as an embedded page.
 *    The bundled David is used because it embeds, so the text stays searchable.
 */

/**
 * The page as it appears, and how to turn a visual point into the page's own one.
 * Based on the crop box, which is what a viewer shows.
 */
function visualFrame(page) {
  const box = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: x0, y: y0, width: w, height: h } = box;
  const sideways = angle === 90 || angle === 270;
  const vw = sideways ? h : w;
  const vh = sideways ? w : h;

  function toUser(vx, vy) {
    switch (angle) {
      case 90: return { x: x0 + w - vy, y: y0 + vx };
      case 180: return { x: x0 + w - vx, y: y0 + h - vy };
      case 270: return { x: x0 + vy, y: y0 + h - vx };
      default: return { x: x0 + vx, y: y0 + vy };
    }
  }

  return { width: vw, height: vh, angle, toUser };
}

/**
 * The bottom-left corner, in the page's own space, at which to draw something of size
 * w x h so that it appears with its bottom-left at (vx, vy) and turned by `turn`
 * degrees counter-clockwise about its centre.
 */
function placement(frame, { vx, vy, w, h, turn = 0 }) {
  const rad = (turn * Math.PI) / 180;
  const cx = vx + w / 2;
  const cy = vy + h / 2;
  // The corner sits half the box away from the centre, turned with it.
  const ox = cx - (Math.cos(rad) * w) / 2 + (Math.sin(rad) * h) / 2;
  const oy = cy - (Math.sin(rad) * w) / 2 - (Math.cos(rad) * h) / 2;
  const { x, y } = frame.toUser(ox, oy);
  return { x, y, rotate: degrees(frame.angle + turn) };
}

/** Visual position of a w x h box for a named spot on the page. */
function spot(frame, position, w, h, margin) {
  const [vert, horiz] = String(position || 'bottom-center').split('-');
  const vx = horiz === 'left' ? margin : horiz === 'right' ? frame.width - margin - w : (frame.width - w) / 2;
  const vy = vert === 'top' ? frame.height - margin - h : vert === 'middle' ? (frame.height - h) / 2 : margin;
  return { vx, vy };
}

function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return { css: `#${(m ? m[1] : '000000').toLowerCase()}`, pdf: rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255) };
}

/**
 * Typeset each string as one line and return them as a PDF, one stamp per page, with
 * the measured width of each. The pages share one size, large enough for the widest;
 * each stamp is later clipped to its own width.
 *
 * @param {string[]} texts
 * @param {{size?: number, color?: string, bold?: boolean}} style  size in points
 */
async function typeset(texts, { size = 12, color = '#000000', bold = false } = {}) {
  const longest = texts.reduce((n, t) => Math.max(n, String(t).length), 1);
  // Generous: a stamp narrower than its page is clipped later, a wider one would wrap.
  const pageWidth = Math.max(72, Math.ceil(longest * size * 0.75 + size * 2));
  const lineHeight = Math.ceil(size * 1.45);
  const pageHeight = Math.max(lineHeight, 18);

  const pages = texts
    .map((t) => `<div class="s"><span dir="auto">${escapeHtml(t)}</span></div>`)
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_FACES}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent; }
  body { font-family: ${FONT_STACK}; font-size: ${size}pt; font-weight: ${bold ? 'bold' : 'normal'};
         color: ${hexColor(color).css}; -webkit-print-color-adjust: exact; }
  .s { width: ${pageWidth}pt; height: ${pageHeight}pt; line-height: ${lineHeight}pt;
       white-space: nowrap; overflow: hidden; break-after: page; text-align: left; direction: ltr; }
  .s:last-child { break-after: auto; }
  .s span { display: inline-block; }
</style></head><body>${pages}</body></html>`;

  // Widths are measured after layout, in points (CSS px are 0.75 pt).
  const script = `document.fonts.ready.then(() => [...document.querySelectorAll('.s span')].map(s => s.getBoundingClientRect().width * 0.75))`;
  const rendered = await renderHtmlToPdf(html, { width: pageWidth, height: pageHeight }, undefined, { script });
  if (rendered.pageCount !== texts.length) {
    throw new Error(`שגיאה פנימית בהכנת הטקסט: ${rendered.pageCount} עמודים במקום ${texts.length}.`);
  }
  const widths = Array.isArray(rendered.scriptResult) ? rendered.scriptResult : texts.map(() => pageWidth);
  return { bytes: rendered.bytes, widths, height: pageHeight, pageWidth };
}

/**
 * Embed typeset stamps into `doc`. Each is clipped to its text, so its width is the
 * text's own and a position like "right" lines up the text's edge, not the page's.
 * @returns {Promise<{page: import('pdf-lib').PDFEmbeddedPage, width: number, height: number}[]>}
 */
async function embedStamps(doc, texts, style) {
  const set = await typeset(texts, style);
  const source = await PDFDocument.load(set.bytes);
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const width = Math.min(set.pageWidth, Math.max(1, Math.ceil(set.widths[i] || set.pageWidth)));
    const embedded = await doc.embedPage(source.getPage(i), {
      left: 0,
      bottom: 0,
      right: width,
      top: set.height,
    });
    out.push({ page: embedded, width, height: set.height });
  }
  return out;
}

/** Draw an embedded page or image at a visual position, with turn and opacity. */
function drawAt(page, item, { vx, vy, w, h, turn = 0, opacity = 1 }) {
  const frame = visualFrame(page);
  const at = placement(frame, { vx, vy, w, h, turn });
  if (item.page) {
    page.drawPage(item.page, { x: at.x, y: at.y, xScale: w / item.width, yScale: h / item.height, rotate: at.rotate, opacity });
  } else {
    page.drawImage(item.image, { x: at.x, y: at.y, width: w, height: h, rotate: at.rotate, opacity });
  }
}

/** A filled rectangle at a visual position, for a white patch behind a stamp. */
function rectAt(page, { vx, vy, w, h, color = rgb(1, 1, 1), opacity = 1 }) {
  const frame = visualFrame(page);
  const at = placement(frame, { vx, vy, w, h });
  page.drawRectangle({ x: at.x, y: at.y, width: w, height: h, rotate: at.rotate, color, opacity });
}

/**
 * Move what was just drawn on `page` underneath its existing content. pdf-lib only
 * appends, so the stream it added last is moved to the front of /Contents. The
 * stream wraps its own drawing in q/Q, so the original content still starts from the
 * default graphics state.
 */
function sendLastDrawingToBack(page) {
  const contents = page.node.Contents();
  if (!contents || typeof contents.size !== 'function' || contents.size() < 2) return;
  const last = contents.get(contents.size() - 1);
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
}

module.exports = {
  visualFrame,
  placement,
  spot,
  hexColor,
  typeset,
  embedStamps,
  drawAt,
  rectAt,
  sendLastDrawingToBack,
};
