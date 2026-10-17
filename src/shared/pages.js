'use strict';

/**
 * Shared by the main process and the page (served as /shared/pages.js), so what the
 * screen previews is exactly what the tool will do.
 *
 * Page ranges as people type them: "1-3, 5, 8-". Numbers are 1-based, as printed on
 * the page; an open end ("8-") runs to the last page. En dashes and Hebrew commas are
 * accepted, because that is what Word and the keyboard produce.
 */

// Wrapped so that in the page it adds one name, pageRanges, and nothing else to the
// global scope: a top-level declaration that collides with window.api stops the whole
// script from loading.
(function () {
  /**
   * @param {string} text
   * @param {number} total  pages in the document
   * @returns {{from: number, to: number}[]}  1-based, inclusive, in the order typed
   */
  function parseRanges(text, total) {
    const cleaned = String(text || '')
      .replace(/[–—−]/g, '-')
      .replace(/[،׳;]/g, ',')
      .replace(/\s+/g, '');
    if (!cleaned) throw new Error('לא נכתבו עמודים.');

    const ranges = [];
    for (const part of cleaned.split(',')) {
      if (!part) continue;
      const m = /^(\d+)?(-)?(\d+)?$/.exec(part);
      if (!m || (!m[1] && !m[3])) throw new Error(`"${part}" אינו מספר עמוד או טווח. כתוב למשל 1-3, 5, 8-.`);
      const from = m[1] ? Number(m[1]) : 1;
      const to = m[2] ? (m[3] ? Number(m[3]) : total) : from;
      if (from < 1 || to < 1) throw new Error('מספרי העמודים מתחילים ב-1.');
      if (from > total || to > total) {
        throw new Error(`בקובץ יש ${total} עמודים, ולכן אין עמוד ${Math.max(from, to)}.`);
      }
      if (from > to) throw new Error(`בטווח ${from}-${to} המספר הראשון גדול מהשני.`);
      ranges.push({ from, to });
    }
    if (!ranges.length) throw new Error('לא נכתבו עמודים.');
    return ranges;
  }

  /** The 0-based indices a set of ranges covers, each once, in document order. */
  function indicesOf(ranges) {
    const set = new Set();
    for (const { from, to } of ranges) for (let p = from; p <= to; p++) set.add(p - 1);
    return [...set].sort((a, b) => a - b);
  }

  /** The shortest text for a set of 0-based indices: [0,1,2,6] -> "1-3, 7". */
  function rangesText(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i];
      while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
      parts.push(start === sorted[i] ? `${start + 1}` : `${start + 1}-${sorted[i] + 1}`);
    }
    return parts.join(', ');
  }

  const formatRange = ({ from, to }) => (from === to ? `${from}` : `${from}-${to}`);

  const exported = { parseRanges, indicesOf, rangesText, formatRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.pageRanges = exported;
})();
