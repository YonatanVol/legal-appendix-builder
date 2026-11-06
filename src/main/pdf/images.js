'use strict';

const zlib = require('zlib');
const { PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef } = require('pdf-lib');

/*
 * The pictures inside a PDF, taken out as they are.
 *
 * Scans are almost always stored as JPEG, and a JPEG image's stream in a PDF is a
 * complete JPEG file: it is written out byte for byte, with no loss. Images stored
 * compressed with Flate in grey or RGB, 8 bits a sample, become PNG. Anything else
 * (fax compression, JBIG2, indexed colour, CMYK) is counted and reported rather
 * than written out wrong.
 */

const asName = (v) => (v && v.asString ? v.asString() : v && v.toString ? v.toString() : '');

function filters(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (!f) return [];
  if (f instanceof PDFArray) return f.asArray().map(asName);
  return [asName(f)];
}

function components(doc, dict) {
  let cs = dict.get(PDFName.of('ColorSpace'));
  if (cs instanceof PDFRef) cs = doc.context.lookup(cs);
  const name = asName(cs);
  if (name === '/DeviceGray' || name === '/CalGray') return 1;
  if (name === '/DeviceRGB' || name === '/CalRGB') return 3;
  if (cs instanceof PDFArray) {
    const kind = asName(cs.get(0));
    if (kind === '/ICCBased') {
      const stream = doc.context.lookup(cs.get(1));
      const n = stream && stream.dict ? stream.dict.get(PDFName.of('N')) : null;
      const count = n ? n.asNumber() : 0;
      return count === 1 || count === 3 ? count : 0;
    }
    if (kind === '/CalRGB') return 3;
    if (kind === '/CalGray') return 1;
  }
  return 0;
}

/** Every image XObject reachable from a page, including inside forms, each once. */
function pageImages(doc, page) {
  const seen = new Set();
  const out = [];
  const walk = (resources) => {
    if (!(resources instanceof PDFDict)) return;
    let xobjects = resources.get(PDFName.of('XObject'));
    if (xobjects instanceof PDFRef) xobjects = doc.context.lookup(xobjects);
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      const ref = value instanceof PDFRef ? value : null;
      const key = ref ? ref.toString() : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const stream = ref ? doc.context.lookup(ref) : value;
      if (!(stream instanceof PDFRawStream)) continue;
      const subtype = asName(stream.dict.get(PDFName.of('Subtype')));
      if (subtype === '/Image') out.push(stream);
      else if (subtype === '/Form') {
        let res = stream.dict.get(PDFName.of('Resources'));
        if (res instanceof PDFRef) res = doc.context.lookup(res);
        walk(res);
      }
    }
  };
  const res = page.node.Resources();
  walk(res);
  return out;
}

/** @returns {{bytes: Buffer, ext: string} | null}  null when the format is not supported */
function extract(doc, stream) {
  const dict = stream.dict;
  const f = filters(dict);
  const raw = Buffer.from(stream.contents);
  if (f.length === 1 && f[0] === '/DCTDecode') return { bytes: raw, ext: 'jpg' };
  if (f.length === 1 && f[0] === '/JPXDecode') return { bytes: raw, ext: 'jp2' };
  if (f.length === 1 && f[0] === '/FlateDecode') {
    const bpc = dict.get(PDFName.of('BitsPerComponent'));
    if (!bpc || bpc.asNumber() !== 8) return null;
    const n = components(doc, dict);
    if (!n) return null;
    const width = dict.get(PDFName.of('Width')).asNumber();
    const height = dict.get(PDFName.of('Height')).asNumber();
    let data;
    try {
      data = zlib.inflateSync(raw);
    } catch {
      return null;
    }
    let parms = dict.get(PDFName.of('DecodeParms'));
    if (parms instanceof PDFRef) parms = doc.context.lookup(parms);
    const predictor = parms instanceof PDFDict && parms.get(PDFName.of('Predictor')) ? parms.get(PDFName.of('Predictor')).asNumber() : 1;
    const rowBytes = width * n;
    let filtered;
    if (predictor >= 10) {
      // PNG predictors: every row already starts with its PNG filter byte.
      filtered = data.subarray(0, (rowBytes + 1) * height);
    } else if (predictor === 1) {
      filtered = Buffer.alloc((rowBytes + 1) * height);
      for (let y = 0; y < height; y++) data.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
    } else {
      return null;
    }
    if (filtered.length < (rowBytes + 1) * height) return null;
    return { bytes: png(width, height, n === 1 ? 0 : 2, filtered), ext: 'png' };
  }
  return null;
}

function png(width, height, colourType, filteredRows) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(filteredRows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

module.exports = { pageImages, extract, png };
