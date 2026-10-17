'use strict';

const { BrowserWindow } = require('electron');

/*
 * Picture work for Scan to PDF and Redact, done by Chromium's canvas in a hidden
 * window: decoding (with the phone's EXIF orientation applied), straightening,
 * contrast, grey and black-and-white, black boxes, and encoding back to JPEG or PNG.
 * Canvas operations are native code, so a 12-megapixel photo takes a fraction of a
 * second where the same loops in plain JavaScript in the main process would freeze
 * the window.
 *
 * The page loads from a data: URL with no Node and no network (the session blocks
 * it), and receives image bytes only through executeJavaScript.
 */

const PAGE = `<!doctype html><meta charset="utf-8"><script>
async function decode(b64, mime) {
  const blob = await (await fetch('data:' + mime + ';base64,' + b64)).blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function canvasOf(w, h) {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

/**
 * The ink and the paper. A page is mostly paper, often with well under 1% ink, so the
 * ink point is the darkest 0.1% and the paper point the 90th percentile; a cut halfway
 * between them separates the two whatever the lighting of the photo.
 */
function levels(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
  const total = data.length / 4;
  const at = (share) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * share) return v; }
    return 255;
  };
  const lo = at(0.001);
  const hi = Math.max(at(0.9), lo + 1);
  return { lo, hi, cut: (lo + hi) / 2, contrast: hi - lo };
}

/**
 * The angle that makes text lines horizontal: the rotation, within +-6 degrees, at
 * which rows of dark pixels are most sharply separated from the white between them.
 */
function skewAngle(bitmap) {
  const scale = Math.min(1, 900 / bitmap.width);
  const [c, ctx] = canvasOf(bitmap.width * scale, bitmap.height * scale);
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const { cut: t, contrast } = levels(data);
  if (contrast < 40) return 0;
  const dark = [];
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    const i = (y * c.width + x) * 4;
    if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < t) dark.push(x, y);
  }
  if (dark.length < 200) return 0;
  let bestAngle = 0, bestScore = -1;
  for (let deg = -6; deg <= 6.001; deg += 0.25) {
    const r = deg * Math.PI / 180, s = Math.sin(r), co = Math.cos(r);
    // Rows are counted in pairs: the points are sampled every second pixel, and single
    // rows would then alternate full and empty at exactly 0 degrees, which always won.
    const rows = new Float64Array(c.height + 10);
    for (let k = 0; k < dark.length; k += 2) {
      const y = Math.floor((dark[k] * s + dark[k + 1] * co) / 2) + (c.height >> 1);
      if (y >= 0 && y < rows.length) rows[y]++;
    }
    let score = 0;
    for (let y = 1; y < rows.length; y++) { const d = rows[y] - rows[y - 1]; score += d * d; }
    if (score > bestScore) { bestScore = score; bestAngle = deg; }
  }
  return bestAngle;
}

async function encode(canvas, kind) {
  const blob = await canvas.convertToBlob(kind === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.88 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Scan cleanup: orientation, straightening, contrast, colour mode. */
window.processScan = async (b64, mime, o) => {
  const bitmap = await decode(b64, mime);
  const angle = o.straighten ? skewAngle(bitmap) : 0;
  // Turning the canvas by the found angle maps each text line onto a horizontal row.
  const r = angle * Math.PI / 180;
  const w = Math.abs(bitmap.width * Math.cos(r)) + Math.abs(bitmap.height * Math.sin(r));
  const h = Math.abs(bitmap.width * Math.sin(r)) + Math.abs(bitmap.height * Math.cos(r));
  const [c, ctx] = canvasOf(angle ? w : bitmap.width, angle ? h : bitmap.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(r);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const { lo, hi, cut, contrast } = levels(d);
  const span = Math.max(1, hi - lo);
  // A blank or near-blank picture is left as it is rather than stretched into noise.
  const stretch = o.enhance && contrast >= 40;
  if (o.mode === 'bw') {
    const t = contrast >= 40 ? cut : 128;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < t ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (o.mode === 'gray' || stretch) {
    for (let i = 0; i < d.length; i += 4) {
      if (o.mode === 'gray') {
        let v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (stretch) v = (v - lo) * 255 / span;
        d[i] = d[i + 1] = d[i + 2] = v;
      } else {
        for (let k = 0; k < 3; k++) d[i + k] = (d[i + k] - lo) * 255 / span;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { b64: await encode(c, o.mode === 'bw' ? 'png' : 'jpeg'), mime: o.mode === 'bw' ? 'image/png' : 'image/jpeg', width: c.width, height: c.height, angle };
};

/** Redaction: solid black boxes over a page image. Boxes are fractions of the image. */
window.blackOut = async (b64, mime, boxes) => {
  const bitmap = await decode(b64, mime);
  const [c, ctx] = canvasOf(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  ctx.fillStyle = '#000';
  for (const b of boxes) ctx.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height);
  return { b64: await encode(c, 'jpeg'), mime: 'image/jpeg', width: c.width, height: c.height };
};
</script>`;

let win = null;

async function page() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, javascript: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  return win;
}

async function call(fn, ...args) {
  const w = await page();
  return w.webContents.executeJavaScript(`window.${fn}(...${JSON.stringify(args)})`, true);
}

/**
 * @param {Buffer} bytes
 * @param {string} mime
 * @param {{mode: 'color'|'gray'|'bw', enhance: boolean, straighten: boolean}} options
 * @returns {Promise<{bytes: Buffer, mime: string, width: number, height: number, angle: number}>}
 */
async function processScan(bytes, mime, options) {
  const r = await call('processScan', bytes.toString('base64'), mime, options);
  return { ...r, bytes: Buffer.from(r.b64, 'base64') };
}

async function blackOut(bytes, mime, boxes) {
  const r = await call('blackOut', bytes.toString('base64'), mime, boxes);
  return { ...r, bytes: Buffer.from(r.b64, 'base64') };
}

function dispose() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { processScan, blackOut, dispose };
