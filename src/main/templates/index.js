'use strict';

const fs = require('fs');
const path = require('path');

const { formatRange } = require('../pdf/layout');

// David is the typeface used in the filings themselves, and it is carried with the app
// rather than taken from Windows. The David that ships with Windows is marked
// non-embeddable, so Chromium cannot put it inside the PDF and converts the text to
// vector outlines: the page looks right but holds no text, and nothing on the contents
// or divider pages can be searched, selected or copied. The Culmus build of the same
// typeface has no such restriction. See assets/fonts/README.md.
const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');

function embeddedFace(file, weight) {
  const data = fs.readFileSync(path.join(FONT_DIR, file)).toString('base64');
  return `  @font-face {
    font-family: 'David Bundled';
    font-weight: ${weight};
    font-style: normal;
    src: url(data:font/otf;base64,${data}) format('opentype');
  }`;
}

// Read once, at load: the same bytes go into every page that gets generated.
const FONT_FACES = [
  embeddedFace('DavidCLM-Medium.otf', 'normal'),
  embeddedFace('DavidCLM-Bold.otf', 'bold'),
].join('\n');

// The bundled face is named distinctly so it always wins; the rest is a safety net
// in case the files are ever missing.
const FONT_STACK = `'David Bundled', David, "David CLM", "Times New Roman", serif`;

// Sizes come from the Word documents the layout was modelled on, in points, so they
// carry over one-for-one into the printed page.
const HEADING_PT = 48; // "נספחים" / "תוכן עניינים"
const ROW_PT = 14; // one line per appendix in the table of contents
const DIVIDER_PT = 26; // every line on a divider page

const MM = 72 / 25.4;
// Page margins from the same documents. They are handed to the print engine rather
// than expressed as CSS padding, so they hold on every page of a multi-page contents.
const TOC_MARGINS = { top: 25 * MM, bottom: 25 * MM, left: 25 * MM, right: 25 * MM };
const DIVIDER_MARGINS = { top: 25 * MM, bottom: 25 * MM, left: 32 * MM, right: 32 * MM };

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Long titles shrink so a divider always stays exactly one page. */
function dividerTitleSize(title) {
  const len = String(title).length;
  if (len <= 55) return DIVIDER_PT;
  if (len <= 100) return 22;
  if (len <= 170) return 18;
  return 15;
}

function documentShell(bodyHtml, extraCss) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<style>
${FONT_FACES}
  /* No @page margin rule: it would override the margins the print engine applies,
     which are the ones that hold across a page break. */
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_STACK};
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
  }
${extraCss}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Divider page placed before each appendix. Mirrors "שער 2.docx": everything centred
 * in David at 26pt, with only the "נספח N" line bold and underlined.
 */
function dividerHtml(appendix, title) {
  const size = dividerTitleSize(title);

  const html = documentShell(
    `<div class="sheet">
  <div class="label">נספח ${appendix.number}</div>
  <div class="title">${escapeHtml(title)}</div>
  <div class="range">עמ' ${formatRange(appendix)}</div>
</div>`,
    `  .sheet {
    text-align: center;
    font-size: ${DIVIDER_PT}pt;
    line-height: 1.15;
  }
  .label {
    /* The two blank lines the source document opens with. */
    margin-top: 60pt;
    font-weight: bold;
    text-decoration: underline;
  }
  .title {
    margin-top: 30pt;
    font-size: ${size}pt;
    font-weight: normal;
  }
  .range {
    margin-top: 30pt;
    font-weight: normal;
  }`
  );

  return { html, margins: DIVIDER_MARGINS };
}

/**
 * Script that finishes the table of contents after Chromium has laid it out.
 *
 * A dotted leader has to stretch to whatever space is left on the last line of a
 * title, and CSS has no stretchy box inside a run of text. So the gap is measured and
 * exactly that many periods are inserted — set in the same font as the rest of the
 * line, as the source document has them.
 *
 * This is safe to measure on screen because .sheet is given an explicit width in
 * points: a block with a set width lays out identically whatever the viewport is, so
 * what is measured here is what the print engine will lay out.
 */
const LEADER_SCRIPT = `(async () => {
  await document.fonts.ready;

  const rows = Array.from(document.querySelectorAll('.row'));
  if (rows.length === 0) return { rows: 0, filled: 0, counts: [] };

  // 100 periods rather than one: dividing averages away sub-pixel rounding.
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px';
  probe.textContent = '.'.repeat(100);
  rows[0].appendChild(probe);
  const dotWidth = probe.getBoundingClientRect().width / 100;
  probe.remove();

  if (!(dotWidth > 0)) return { rows: rows.length, dotWidth: 0, filled: 0, counts: [] };

  const SAFETY = 1; // px held back so sub-pixel rounding cannot cause a wrap
  const counts = [];
  let filled = 0;

  for (const row of rows) {
    const dots = row.querySelector('.dots');
    const range = row.querySelector('.range');
    if (!dots || !range) { counts.push(0); continue; }

    dots.textContent = '';

    // Measured with the leader empty, so this is the natural, correct line breaking.
    const height = row.getBoundingClientRect().height;
    const top = Math.round(range.getBoundingClientRect().top);
    // Right-to-left: the range is the last thing on its line, so everything between
    // its left edge and the row's left edge is free. The leader's own margins are
    // already reflected in that position.
    const free = range.getBoundingClientRect().left - row.getBoundingClientRect().left;

    // Math.max guards the near-full line: '.'.repeat(-1) throws.
    let count = Math.max(0, Math.floor((free - SAFETY) / dotWidth));

    if (count > 0) {
      dots.textContent = '.'.repeat(count);
      // Invariant: adding the leader must never make the row taller, and must never
      // push the range onto another line. Back off until that holds.
      while (count > 0) {
        const grew = row.getBoundingClientRect().height > height + 0.5;
        const moved = Math.round(range.getBoundingClientRect().top) !== top;
        if (!grew && !moved) break;
        count -= 1;
        dots.textContent = '.'.repeat(count);
      }
    }

    if (count > 0) filled++;
    counts.push(count);
  }

  return { rows: rows.length, dotWidth, filled, counts };
})()`;

/**
 * Table of contents, modelled on "תוכן עניינים.docx". One line per appendix:
 *   {title} -נספח {N} ......... עמ' {range}
 *
 * The row is ordinary text flow rather than a flex row. A flex row makes the title an
 * atomic item: when its text wraps to a second line the leader and the range stay
 * pinned beside the first line, which is exactly the misalignment this replaced. In
 * normal flow the range simply lands at the end of the last line, wherever that is,
 * and LEADER_SCRIPT fills the gap in front of it.
 */
function tocHtml(layout, titles, pageSize) {
  // Held 1pt short of the printable width so a rounding difference in the margins the
  // print engine applies can never overflow the page.
  const sheetWidth =
    pageSize.width - TOC_MARGINS.left - TOC_MARGINS.right - 1;

  const rows = layout.appendices
    .map(
      (appendix, i) =>
        `  <div class="row"><span class="label">${escapeHtml(titles[i])} -נספח ${
          appendix.number
        }</span><span class="dots"></span><span class="range">עמ' ${formatRange(
          appendix
        )}</span></div>`
    )
    .join('\n');

  const html = documentShell(
    `<div class="sheet">
  <h1>נספחים<br>תוכן עניינים</h1>
${rows}
</div>`,
    `  .sheet {
    width: ${sheetWidth.toFixed(2)}pt;
  }
  h1 {
    font-size: ${HEADING_PT}pt;
    font-weight: bold;
    text-align: center;
    line-height: 1.15;
    /* The source document leaves four blank lines below the heading. */
    margin: 0 0 64pt 0;
  }
  .row {
    display: block;
    font-size: ${ROW_PT}pt;
    font-weight: bold;
    line-height: 18pt;
    margin: 6pt 0;
    /* A wrapped row moves to the next page whole rather than being split. */
    break-inside: avoid;
    /* A single unbroken word cannot be allowed to run past the margin. */
    overflow-wrap: break-word;
  }
  .dots {
    /* Kept on one line: a leader that could break would land on the wrong line. */
    white-space: nowrap;
    margin: 0 4pt;
  }
  .range {
    white-space: nowrap;
  }`
  );

  return { html, margins: TOC_MARGINS, script: LEADER_SCRIPT };
}

module.exports = { dividerHtml, tocHtml, escapeHtml, TOC_MARGINS, DIVIDER_MARGINS };
