'use strict';

const fs = require('fs/promises');
const path = require('path');
const { degrees, rgb, BlendMode, LineCapStyle } = require('pdf-lib');

const { visualFrame, embedStamps, drawAt, hexColor } = require('./stamp');

/*
 * What Edit PDF and Sign put on pages, drawn for real into the page content.
 *
 * Every object is placed in fractions of the page as shown, measured from its top-left
 * corner, so the screen and the file agree whatever the page's size or /Rotate:
 *
 *   { type: 'text', page, x, y, w, h, text, size, color, bold, align }
 *   { type: 'image', page, x, y, w, h, src, opacity }      src: a file path or data: URL
 *   { type: 'rect' | 'ellipse', page, x, y, w, h, stroke, fill, width, opacity }
 *   { type: 'line' | 'arrow', page, x1, y1, x2, y2, stroke, width }
 *   { type: 'path', page, points: [[x, y], ...], stroke, width }   freehand
 *   { type: 'highlight', page, x, y, w, h, color }
 *   { type: 'whiteout', page, x, y, w, h }
 *
 * Shapes are drawn as SVG paths from the page's shown top-left corner, turned with the
 * page; text is typeset by Chromium (stamp.js), so Hebrew reads in order.
 */

const TYPES = new Set(['text', 'image', 'rect', 'ellipse', 'line', 'arrow', 'path', 'highlight', 'whiteout']);

function validate(objects, pageCount) {
  if (!Array.isArray(objects)) return [];
  return objects.filter((o) => o && TYPES.has(o.type) && Number.isInteger(o.page) && o.page >= 0 && o.page < pageCount);
}

/** Draw the objects into `doc`. Returns how many were placed. */
async function drawObjects(doc, objects) {
  const list = validate(objects, doc.getPageCount());
  const texts = list.filter((o) => o.type === 'text' && String(o.text || '').trim());

  // All text lines are typeset in one pass per style, which is one Chromium render each.
  const byStyle = new Map();
  for (const o of texts) {
    const key = `${o.size || 14}|${o.color || '#000000'}|${o.bold ? 1 : 0}`;
    if (!byStyle.has(key)) byStyle.set(key, []);
    byStyle.get(key).push(o);
  }
  const stamps = new Map();
  for (const [key, group] of byStyle) {
    const [size, color, bold] = key.split('|');
    const lines = group.flatMap((o) => String(o.text).split('\n'));
    const made = await embedStamps(doc, lines.map((l) => l || ' '), { size: Number(size), color, bold: bold === '1' });
    let k = 0;
    for (const o of group) {
      const count = String(o.text).split('\n').length;
      stamps.set(o, made.slice(k, k + count));
      k += count;
    }
  }

  const images = new Map();
  for (const o of list) {
    if (o.type !== 'image' || images.has(o.src)) continue;
    images.set(o.src, await embedImage(doc, o.src));
  }

  let placed = 0;
  for (const o of list) {
    const page = doc.getPage(o.page);
    const frame = visualFrame(page);
    const W = frame.width;
    const H = frame.height;
    switch (o.type) {
      case 'text': {
        const lines = stamps.get(o) || [];
        const size = Number(o.size) || 14;
        const lineH = size * 1.45;
        lines.forEach((stamp, i) => {
          const boxLeft = o.x * W;
          const boxWidth = (o.w || 0) * W;
          let vx = boxLeft;
          if (o.align === 'right') vx = boxLeft + Math.max(0, boxWidth - stamp.width);
          else if (o.align === 'center') vx = boxLeft + Math.max(0, (boxWidth - stamp.width) / 2);
          const vy = H - (o.y * H + (i + 1) * lineH);
          drawAt(page, stamp, { vx, vy, w: stamp.width, h: stamp.height });
        });
        break;
      }
      case 'image': {
        const item = images.get(o.src);
        drawAt(page, item, { vx: o.x * W, vy: H - (o.y + o.h) * H, w: o.w * W, h: o.h * H, opacity: clampOpacity(o.opacity) });
        break;
      }
      case 'highlight':
        svg(page, frame, rectPath(o, W, H), { fill: o.color || '#ffe066', opacity: 0.4, blend: BlendMode.Multiply });
        break;
      case 'whiteout':
        svg(page, frame, rectPath(o, W, H), { fill: '#ffffff', opacity: 1 });
        break;
      case 'rect':
        svg(page, frame, rectPath(o, W, H), { stroke: o.stroke, fill: o.fill, width: o.width, opacity: o.opacity });
        break;
      case 'ellipse':
        svg(page, frame, ellipsePath(o, W, H), { stroke: o.stroke, fill: o.fill, width: o.width, opacity: o.opacity });
        break;
      case 'line':
      case 'arrow':
        svg(page, frame, linePath(o, W, H), { stroke: o.stroke || '#000000', width: o.width, opacity: o.opacity, round: true });
        break;
      case 'path':
        if (Array.isArray(o.points) && o.points.length > 1) {
          const d = o.points.map(([px, py], i) => `${i ? 'L' : 'M'}${(px * W).toFixed(2)} ${(py * H).toFixed(2)}`).join(' ');
          svg(page, frame, d, { stroke: o.stroke || '#000000', width: o.width, opacity: o.opacity, round: true });
        }
        break;
      default:
        continue;
    }
    placed++;
  }
  return placed;
}

function clampOpacity(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : 1;
}

function rectPath(o, W, H) {
  const x = o.x * W;
  const y = o.y * H;
  const w = o.w * W;
  const h = o.h * H;
  return `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
}

function ellipsePath(o, W, H) {
  const rx = (o.w * W) / 2;
  const ry = (o.h * H) / 2;
  const cx = o.x * W + rx;
  const cy = o.y * H + ry;
  return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

function linePath(o, W, H) {
  const x1 = o.x1 * W;
  const y1 = o.y1 * H;
  const x2 = o.x2 * W;
  const y2 = o.y2 * H;
  let d = `M${x1} ${y1} L${x2} ${y2}`;
  if (o.type === 'arrow') {
    const len = Math.max(8, (Number(o.width) || 2) * 5);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const a1 = angle + Math.PI - 0.45;
    const a2 = angle + Math.PI + 0.45;
    d += ` M${x2 + len * Math.cos(a1)} ${y2 + len * Math.sin(a1)} L${x2} ${y2} L${x2 + len * Math.cos(a2)} ${y2 + len * Math.sin(a2)}`;
  }
  return d;
}

/** An SVG path given in the shown page's points, y down from its top-left corner. */
function svg(page, frame, d, { stroke, fill, width, opacity, blend, round }) {
  const origin = frame.toUser(0, frame.height);
  const op = clampOpacity(opacity === undefined ? 1 : opacity);
  page.drawSvgPath(d, {
    x: origin.x,
    y: origin.y,
    rotate: degrees(frame.angle),
    color: fill ? hexColor(fill).pdf : undefined,
    borderColor: stroke ? hexColor(stroke).pdf : undefined,
    borderWidth: stroke ? Math.max(0.5, Number(width) || 2) : 0,
    opacity: fill ? op : undefined,
    borderOpacity: stroke ? op : undefined,
    borderLineCap: round ? LineCapStyle.Round : undefined,
    blendMode: blend,
  });
}

async function embedImage(doc, src) {
  let bytes;
  if (/^data:image\/(png|jpe?g);base64,/.test(src)) {
    bytes = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
  } else {
    try {
      bytes = await fs.readFile(src);
    } catch {
      throw new Error(`לא ניתן לקרוא את התמונה "${path.basename(String(src))}".`);
    }
  }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) throw new Error('אפשר להוסיף תמונות מסוג PNG או JPG בלבד.');
  const image = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  return { image, width: image.width, height: image.height };
}

module.exports = { drawObjects, validate, embedImage, TYPES };

// Used by the tests and by Forms, which draws its own appearances.
module.exports.rgb = rgb;
