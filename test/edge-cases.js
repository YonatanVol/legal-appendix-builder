'use strict';

/**
 * Edge cases that the reference rebuild does not exercise.
 * Launch with:  npx electron test/edge-cases.js
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { PDFDocument, degrees } = require('pdf-lib');

const { buildBundle } = require('../src/main/pdf/assemble');
const { computeLayout, formatRange } = require('../src/main/pdf/layout');
const { inspect } = require('../src/main/pdf/inspect');

const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'output');
const SMALL = path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf');
const BODY = path.join(FIXTURES, 'body.pdf');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const pageText = (file, page) =>
  execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-'], {
    encoding: 'utf8',
  });
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const norm = (t) => t.replace(BIDI, '').replace(/\s+/g, ' ').trim();

/** Every word on a page with its position, via pdftotext's bounding-box output. */
function pageWords(file, page) {
  const xml = execFileSync(
    'pdftotext',
    ['-bbox', '-f', String(page), '-l', String(page), file, '-'],
    { encoding: 'utf8' }
  );
  return [...xml.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g
  )].map((m) => ({
    xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: m[5],
  }));
}

/** Words sharing a baseline, as rendered lines. */
function pageLines(words) {
  const byLine = new Map();
  for (const w of words) {
    const key = Math.round(w.yMin);
    // Tolerate a point of jitter between words on the same line.
    const found = [...byLine.keys()].find((k) => Math.abs(k - key) <= 2);
    const k = found === undefined ? key : found;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(w);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, ws]) => ({ y, words: ws, text: ws.map((w) => w.text).join(' ') }));
}

const lineWith = (lines, needle) => lines.findIndex((l) => l.text.includes(needle));
const dotsOn = (line) =>
  Math.max(0, ...line.words.filter((w) => /^\.+$/.test(w.text)).map((w) => w.text.length));



async function expectFailure(label, spec, fragment) {
  try {
    await buildBundle(spec);
    check(label, false, 'expected an error, got none');
  } catch (err) {
    check(label, err.message.includes(fragment), err.message.slice(0, 90));
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  /* ---- rotated pages ---- */
  console.log('rotated appendix pages');
  const rotatedPath = path.join(OUT, 'rotated.pdf');
  {
    const source = await PDFDocument.load(await fs.readFile(SMALL));
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(source, source.getPageIndices());
    // One page at each rotation, so every branch of the placement maths runs.
    const angles = [0, 90, 180, 270];
    pages.forEach((page, i) => {
      page.setRotation(degrees(angles[i % angles.length]));
      doc.addPage(page);
    });
    await fs.writeFile(rotatedPath, await doc.save());
  }

  const rotatedOut = path.join(OUT, 'edge-rotated.pdf');
  const rotatedResult = await buildBundle({
    bodyPath: BODY,
    appendices: [{ title: 'נספח עם עמודים מסובבים', files: [rotatedPath] }],
    outputPath: rotatedOut,
  });
  check('builds with rotated pages', rotatedResult.totalPages === 7 + 1 + 1 + 7,
    `${rotatedResult.totalPages} pages`);
  // Each rotated page must still receive its number.
  let numbered = 0;
  for (let page = 10; page <= 16; page++) {
    if (norm(pageText(rotatedOut, page)).includes(String(page))) numbered++;
  }
  check('every rotated page carries its running number', numbered === 7, `${numbered}/7`);

  /* ---- an appendix made of several files ---- */
  console.log('\nappendix spanning several files');
  const multiOut = path.join(OUT, 'edge-multi.pdf');
  const multiResult = await buildBundle({
    bodyPath: BODY,
    appendices: [
      {
        title: 'העתק הערר לרבות המסמכים שצורפו',
        files: [SMALL, SMALL, SMALL],
      },
    ],
    outputPath: multiOut,
  });
  check('three files merge into one appendix', multiResult.appendices.length === 1);
  check('  with one divider page', multiResult.appendices[0].dividerPage === 9);
  check('  spanning all their pages', multiResult.appendices[0].range === '10-30',
    multiResult.appendices[0].range);
  check('  total is 7 + 1 + 1 + 21', multiResult.totalPages === 30, `${multiResult.totalPages}`);

  /* ---- enough appendices to push the contents onto a second page ---- */
  console.log('\ncontents overflowing to a second page');
  const many = Array.from({ length: 26 }, (_, i) => ({
    title:
      `העתק פרוטוקול ועדה רפואית לעררים מיום ${String((i % 28) + 1).padStart(2, '0')}/07/26 ` +
      'לרבות כלל המסמכים הרפואיים שצורפו לו ונדונו בפני הוועדה',
    files: [SMALL],
  }));
  const manyOut = path.join(OUT, 'edge-many.pdf');
  const manyResult = await buildBundle({
    bodyPath: BODY,
    appendices: many,
    outputPath: manyOut,
  });
  check('contents grew past one page', manyResult.tocPages > 1, `${manyResult.tocPages} pages`);
  // With a T-page contents, appendix 1's divider sits at 7 + T + 1.
  check('  ranges account for the longer contents',
    manyResult.appendices[0].dividerPage === 7 + manyResult.tocPages + 1,
    `divider on ${manyResult.appendices[0].dividerPage}`);
  const expectedTotal = 7 + manyResult.tocPages + many.length * (1 + 7);
  check('  total page count is consistent', manyResult.totalPages === expectedTotal,
    `${manyResult.totalPages} vs ${expectedTotal}`);
  check('  last appendix range is correct',
    manyResult.appendices[25].range ===
      `${expectedTotal - 6}-${expectedTotal}`,
    manyResult.appendices[25].range);

  /* ---- dotted leaders on wrapped titles ---- */
  console.log('\ndotted leaders in the table of contents');
  const leadersOut = path.join(OUT, 'edge-leaders.pdf');
  // The Latin markers are landmarks: Hebrew comes out of pdftotext in visual order,
  // and these do not, so a line can be identified without guessing at that.
  const SHORT_TITLE = 'BBB כותרת קצרה';
  const LONG_TITLE =
    'AAA העתק מכתב הדרישה להשלמת מסמכים מחברת הביטוח, מכתב השלמת מסמכים ואישור מסירה ZZZ';

  const leaders = await buildBundle({
    bodyPath: BODY,
    appendices: [
      { title: SHORT_TITLE, files: [SMALL] },
      { title: LONG_TITLE, files: [SMALL] },
    ],
    outputPath: leadersOut,
  });

  const lines = pageLines(pageWords(leadersOut, leaders.tocPage));
  const shortRange = leaders.appendices[0].range;
  const longRange = leaders.appendices[1].range;

  const shortMarker = lineWith(lines, 'BBB');
  const shortRangeLine = lineWith(lines, shortRange);
  check('a title that fits stays on one line', shortMarker === shortRangeLine,
    `marker line ${shortMarker}, range line ${shortRangeLine}`);
  check('  and its leader is drawn', dotsOn(lines[shortRangeLine]) >= 10,
    `${dotsOn(lines[shortRangeLine])} dots`);

  const longStart = lineWith(lines, 'AAA');
  const longEnd = lineWith(lines, 'ZZZ');
  const longRangeLine = lineWith(lines, longRange);
  check('a long title wraps to a second line', longEnd > longStart,
    `starts on line ${longStart}, ends on line ${longEnd}`);
  // The defect being guarded against: the range used to be stranded beside the
  // title's FIRST line with a single dot, while the title ran on below it.
  check('  the range sits on the title\'s last line', longRangeLine === longEnd,
    `range on line ${longRangeLine}, title ends on line ${longEnd}`);
  check('  not beside its first line', longRangeLine !== longStart);
  check('  and the leader fills that line', dotsOn(lines[longRangeLine]) >= 10,
    `${dotsOn(lines[longRangeLine])} dots`);

  /* ---- nothing escapes the margins ---- */
  console.log('\nleaders stay inside the margins');
  const MM = 72 / 25.4;
  const pageW = 595.32;
  const leftLimit = 25 * MM - 2;
  const rightLimit = pageW - 25 * MM + 2;
  const allWords = pageWords(leadersOut, leaders.tocPage);
  const outside = allWords.filter((w) => w.xMin < leftLimit || w.xMax > rightLimit);
  check('no text crosses the page margins', outside.length === 0,
    outside.length ? `${outside.length} words, e.g. "${outside[0].text}"` : '');

  // A leader that overshot would run under the range rather than stopping short of it.
  const overlaps = lines.filter((line) => {
    const dot = line.words.find((w) => /^\.+$/.test(w.text));
    const other = line.words.filter((w) => !/^\.+$/.test(w.text));
    return dot && other.some((w) => w.xMin < dot.xMax - 0.5 && w.xMax > dot.xMin + 0.5);
  });
  check('no leader overlaps the text around it', overlaps.length === 0,
    overlaps.length ? `${overlaps.length} line(s)` : '');

  /* ---- rejected input ---- */
  console.log('\nrejected input');
  const notPdf = path.join(OUT, 'not-a-pdf.pdf');
  await fs.writeFile(notPdf, 'this is plain text, not a PDF');
  const emptyFile = path.join(OUT, 'empty.pdf');
  await fs.writeFile(emptyFile, '');
  const truncated = path.join(OUT, 'truncated.pdf');
  await fs.writeFile(truncated, (await fs.readFile(SMALL)).subarray(0, 900));

  const base = { bodyPath: BODY, outputPath: path.join(OUT, 'edge-reject.pdf') };
  await expectFailure('rejects a file that is not a PDF',
    { ...base, appendices: [{ title: 'x', files: [notPdf] }] }, 'אינו קובץ PDF תקין');
  await expectFailure('rejects an empty file',
    { ...base, appendices: [{ title: 'x', files: [emptyFile] }] }, 'ריק');
  await expectFailure('rejects a truncated file',
    { ...base, appendices: [{ title: 'x', files: [truncated] }] }, 'פגום');
  await expectFailure('rejects a missing file',
    { ...base, appendices: [{ title: 'x', files: [path.join(OUT, 'nope.pdf')] }] }, 'לא ניתן לקרוא');
  await expectFailure('rejects an appendix with no title',
    { ...base, appendices: [{ title: '   ', files: [SMALL] }] }, 'חסרה כותרת');
  await expectFailure('rejects an appendix with no files',
    { ...base, appendices: [{ title: 'x', files: [] }] }, 'לא נבחרו קבצים');
  await expectFailure('rejects a bundle with no appendices',
    { ...base, appendices: [] }, 'לא נוספו נספחים');

  /* ---- layout maths ---- */
  console.log('\nlayout maths');
  const single = computeLayout(1, [1], 1);
  check('single-page appendix prints one number, not a range',
    formatRange(single.appendices[0]) === '4', formatRange(single.appendices[0]));
  check('  divider precedes it', single.appendices[0].dividerPage === 3);
  try {
    computeLayout(7, [0], 1);
    check('rejects a zero-page appendix', false);
  } catch (err) {
    check('rejects a zero-page appendix', err.message.includes('at least one page'));
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}

app.disableHardwareAcceleration();
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('\nUNEXPECTED FAILURE:', err.message);
    console.error(err.stack);
    app.exit(1);
  })
);
