'use strict';

/**
 * Compare the rebuilt bundle against the reference filing it was derived from.
 * Run test/build-headless.js first.
 *
 * Note on the fixtures: they were cut out of the finished reference, so they still
 * carry the numbers that were printed on it. The rebuilt file therefore shows each
 * body and appendix page's original number *and* the one this app stamps. That is an
 * artifact of testing against a finished document — in real use the pleading is
 * exported from Word without page numbers. The comparison below removes our stamp
 * before matching, which also proves the stamp lands where it should.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REBUILT = path.join(__dirname, 'output', 'rebuilt.pdf');
const FIXTURES = path.join(__dirname, 'fixtures');

// The parts the bundle was built from are the reference. They were cut out of the
// finished filing, so comparing against them tests exactly what comparing against the
// original did — without depending on that file still being on disk.
const SOURCES = {
  body: path.join(FIXTURES, 'body.pdf'),
  a1: path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf'),
  a2: path.join(FIXTURES, '2 - העתק הערר לרבות מסמכים שצורפו.pdf'),
  a3: path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf'),
};

const results = [];

function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function pageText(file, page) {
  return execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-'], {
    encoding: 'utf8',
  });
}

/** [width, height] in points, per page. */
function pageSizes(file, from, to) {
  const out = execFileSync('pdfinfo', ['-f', String(from), '-l', String(to), file], {
    encoding: 'utf8',
  });
  return [...out.matchAll(/Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => ({
    page: Number(m[1]),
    width: Number(m[2]),
    height: Number(m[3]),
  }));
}

/** Embedded fonts reported for a page range. */
function pageFonts(file, from, to) {
  const out = execFileSync(
    'pdffonts',
    ['-f', String(from), '-l', String(to), file],
    { encoding: 'utf8' }
  );
  return out
    .split('\n')
    .slice(2)
    .filter((line) => line.trim())
    .map((line) => ({ name: line.slice(0, 36).trim(), embedded: /\syes\s/.test(line) }));
}

function pageCount(file) {
  return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))[1]);
}

// pdftotext wraps mixed Hebrew/Latin runs in bidi control characters, so "נספח 1"
// comes back as "נספח ‪1‬". They carry no meaning for these comparisons.
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

const normalise = (text) => text.replace(BIDI, '').replace(/\s+/g, ' ').trim();

/**
 * Drop the running number this app stamped. It usually extracts as a standalone
 * token, but on some scans it lands mid-stream, so the last standalone occurrence is
 * removed rather than only a trailing one. On the pleading's first pages Word's own
 * number and ours merge into a single run ("11"), which the fallback handles.
 */
function withoutStamp(text, pageNumber) {
  const stamp = String(pageNumber);
  const clean = normalise(text);

  const token = new RegExp(`(?:^| )${stamp}(?= |$)`, 'g');
  const matches = [...clean.matchAll(token)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const without = clean.slice(0, last.index) + clean.slice(last.index + last[0].length);
    return without.replace(/\s+/g, ' ').trim();
  }

  return clean.endsWith(stamp) ? clean.slice(0, -stamp.length).trim() : clean;
}

if (!fs.existsSync(REBUILT)) {
  console.error('rebuilt.pdf not found — run: npx electron test/build-headless.js');
  process.exit(1);
}

const missing = Object.values(SOURCES).filter((f) => !fs.existsSync(f));
if (missing.length > 0) {
  console.error('fixtures missing — run: npm run split-reference');
  process.exit(1);
}

const APPENDICES = [
  { number: 1, divider: 9, range: '10-17' },
  { number: 2, divider: 18, range: '19-41' },
  { number: 3, divider: 42, range: '43-49' },
];

console.log('structure');
const total = pageCount(REBUILT);
check('total is 49 pages', total === 49, `got ${total}`);

// The generated pages are produced by Chromium, whose page size is expressed in
// inches. Getting those units wrong yields pages thousands of times too large while
// the text still extracts perfectly — so the size is asserted, not assumed.
const sizes = pageSizes(REBUILT, 1, 49);
const body = sizes.find((s) => s.page === 1);
[8, 9, 18, 42].forEach((page) => {
  const generated = sizes.find((s) => s.page === page);
  const close =
    Math.abs(generated.width - body.width) < 2 && Math.abs(generated.height - body.height) < 2;
  check(
    `generated page ${page} is the body's page size`,
    close,
    `${generated.width} x ${generated.height} vs ${body.width} x ${body.height}`
  );
});

// The Hebrew typeface has to be embedded, not drawn as outlines. Windows' own David
// is marked non-embeddable, and Chromium silently converts such text to vector paths:
// the page looks perfect and holds no text at all. Nothing else here would notice.
//
// Helvetica is exempt: it is one of the fourteen standard PDF faces, which every
// reader supplies and which are not embedded by design. It carries the page numbers.
const BASE_14 = /^(Helvetica|Courier|Times|Symbol|ZapfDingbats)/i;

console.log('\ngenerated pages carry real text');
[8, 9, 18, 42].forEach((page) => {
  const fonts = pageFonts(REBUILT, page, page);
  const hebrew = fonts.filter((f) => !BASE_14.test(f.name.replace(/^[A-Z]{6}\+/, '')));
  check(`page ${page} embeds its Hebrew typeface`,
    hebrew.length > 0 && hebrew.every((f) => f.embedded),
    hebrew.length ? hebrew.map((f) => f.name).join(', ') : 'none — the text was outlined');
});
check('the contents page yields extractable text',
  normalise(pageText(REBUILT, 8)).includes('נספחים'));

console.log('\ntable of contents (page 8)');
const toc = normalise(pageText(REBUILT, 8));
check('heading נספחים', toc.includes('נספחים'));
check('heading תוכן עניינים', toc.includes('תוכן עניינים'));
APPENDICES.forEach(({ number, range }) => {
  // The dotted leader is real text set in the same font, and extraction places it
  // between the word and the number — as it does in the reference filing too.
  check(`lists נספח ${number}`, new RegExp(`נספח[\\s.]*${number}`).test(toc));
  check(`  with range עמ' ${range}`, toc.includes(range));
});
check('draws a dotted leader between title and range', /\.{5,}/.test(toc));
check(
  'lists the appendix titles',
  toc.includes('העתק פרוטוקול ועדת העררים') && toc.includes('העתק הערר לרבות מסמכים שצורפו')
);

console.log('\ndivider pages');
APPENDICES.forEach(({ number, divider, range }) => {
  const text = normalise(pageText(REBUILT, divider));
  check(`page ${divider} announces נספח ${number}`, text.includes(`נספח ${number}`));
  check(`  states עמ' ${range}`, text.includes(range));
  check(`  carries the running number ${divider}`, text.endsWith(String(divider)));
});

console.log('\nrunning numbers on generated pages');
check('page 8 is numbered 8', toc.endsWith('8'));

console.log('\nbody text preserved (pages 1-7)');
for (let page = 1; page <= 7; page++) {
  const rebuilt = withoutStamp(pageText(REBUILT, page), page);
  const source = normalise(pageText(SOURCES.body, page));
  check(`page ${page} matches the pleading`, rebuilt === source);
}

console.log('\nappendix content preserved');
[
  { page: 10, source: SOURCES.a1, sourcePage: 1 },
  { page: 17, source: SOURCES.a1, sourcePage: 8 },
  { page: 19, source: SOURCES.a2, sourcePage: 1 },
  { page: 41, source: SOURCES.a2, sourcePage: 23 },
  { page: 43, source: SOURCES.a3, sourcePage: 1 },
  { page: 49, source: SOURCES.a3, sourcePage: 7 },
].forEach(({ page, source, sourcePage }) => {
  const rebuilt = withoutStamp(pageText(REBUILT, page), page);
  const original = normalise(pageText(source, sourcePage));
  check(`page ${page} matches its source page`, rebuilt === original);
});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
