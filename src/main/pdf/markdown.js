'use strict';

/*
 * The little Markdown Claude answers in, read into blocks for Word and PDF: headings,
 * bullet and numbered lists, simple pipe tables, bold, and paragraphs. Anything else is
 * kept as plain text rather than guessed at.
 */

function parse(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ').trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^-{3,}$/.test(t) || /^—page—$/.test(t)) { flush(); blocks.push({ type: 'break' }); continue; }
    let m = /^(#{1,4})\s+(.*)$/.exec(t);
    if (m) { flush(); blocks.push({ type: 'h', level: m[1].length, text: m[2].trim() }); continue; }
    m = /^[-*•]\s+(.*)$/.exec(t);
    if (m) { flush(); blocks.push({ type: 'li', text: m[1].trim() }); continue; }
    m = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (m) { flush(); blocks.push({ type: 'ol', n: Number(m[1]), text: m[2].trim() }); continue; }
    if (/^\|.*\|$/.test(t)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/** Text with **bold** marks as runs: [{text, bold}]. */
function runs(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.length ? out : [{ text, bold: false }];
}

module.exports = { parse, runs };
