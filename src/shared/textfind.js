'use strict';

/**
 * Shared by the page (served as /shared/textfind.js) and the tests: finding text on a page
 * from its pieces of text and their boxes, for Redact.
 *
 * A PDF does not keep words whole. One ID number can be three pieces ("012", "345", "678")
 * placed side by side, a Hebrew word can be one piece per letter, and the pieces can come
 * in any order. Searching each piece alone misses all of these, silently, and a redaction
 * that misses an ID number is the worst kind of miss. So the pieces on one line are joined
 * (with a space only where there is a real gap), the line is searched, and a match covering
 * several pieces becomes one box over all of them. The line is joined in three orders (as
 * the file lists the pieces, left to right, right to left), since files differ in which
 * one is the reading order; matches found more than once are kept once.
 *
 * A box: { str, x, y, w, h, rtl, vertical }, fractions of the page from its top-left.
 */
(function () {
  /** A share of the piece, by its share of the characters, reaching one character further. */
  function subBox(b, start, end) {
    const len = b.str.length || 1;
    const s = Math.max(0, start - 1);
    const e = Math.min(len, end + 1);
    if (b.vertical) return { x: b.x - b.w * 0.1, y: b.y + (b.h * s) / len, w: b.w * 1.2, h: (b.h * (e - s)) / len };
    const from = b.rtl ? 1 - e / len : s / len;
    return { x: b.x + b.w * from, y: b.y - b.h * 0.1, w: (b.w * (e - s)) / len, h: b.h * 1.2 };
  }

  function union(rects) {
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The pieces grouped into lines: pieces whose middles sit at about the same height. */
  function linesOf(boxes) {
    const lines = [];
    for (const b of boxes) {
      if (!b.str || !b.str.trim()) continue;
      if (b.vertical) {
        lines.push([b]);
        continue;
      }
      const mid = b.y + b.h / 2;
      const line = lines.find((l) => !l[0].vertical && Math.abs(l.mid - mid) < Math.max(l.h, b.h) * 0.45 && Math.max(l.h, b.h) < Math.min(l.h, b.h) * 2.2);
      if (line) {
        line.push(b);
        line.mid = (line.mid * (line.length - 1) + mid) / line.length;
        line.h = Math.max(line.h, b.h);
      } else {
        const fresh = [b];
        fresh.mid = mid;
        fresh.h = b.h;
        lines.push(fresh);
      }
    }
    return lines;
  }

  /** One line joined in one order: its text, and for each character the piece and place. */
  function joined(pieces) {
    let text = '';
    const at = [];
    pieces.forEach((b, i) => {
      if (i > 0) {
        const prev = pieces[i - 1];
        // The gap between the two pieces, whichever side of the other this one lies on.
        const gap = Math.max(b.x - (prev.x + prev.w), prev.x - (b.x + b.w));
        if (gap > Math.max(prev.h, b.h) * 0.25 && !/\s$/.test(text) && !/^\s/.test(b.str)) {
          text += ' ';
          at.push(null);
        }
      }
      for (let k = 0; k < b.str.length; k++) at.push({ box: b, index: k });
      text += b.str;
    });
    return { text, at };
  }

  function overlap(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (ix * iy) / Math.min(a.w * a.h || 1, b.w * b.h || 1);
  }

  /**
   * Every match of `re` on a page, as [{ x, y, w, h, text }]. `re` is a regular expression;
   * a global one finds every match, otherwise the first on each line.
   */
  function findInBoxes(boxes, re) {
    const hits = [];
    for (const line of linesOf(boxes)) {
      const orders = line.length === 1 || line[0].vertical
        ? [line]
        : [line, [...line].sort((a, b) => a.x - b.x), [...line].sort((a, b) => b.x - a.x)];
      for (const pieces of orders) {
        const { text, at } = joined(pieces);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          if (!m[0]) { re.lastIndex++; continue; }
          // The part of each piece the match covers.
          const spans = new Map();
          for (let k = m.index; k < m.index + m[0].length; k++) {
            const c = at[k];
            if (!c) continue;
            const s = spans.get(c.box) || { start: c.index, end: c.index + 1 };
            s.start = Math.min(s.start, c.index);
            s.end = Math.max(s.end, c.index + 1);
            spans.set(c.box, s);
          }
          const rect = union([...spans].map(([b, s]) => subBox(b, s.start, s.end)));
          if (!hits.some((h) => overlap(h, rect) > 0.6)) hits.push({ ...rect, text: m[0] });
          if (!re.global) break;
        }
      }
    }
    return hits;
  }

  const exported = { findInBoxes, subBox, linesOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.textFind = exported;
})();
