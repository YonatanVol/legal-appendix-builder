'use strict';

/**
 * Cut the reference filing back into the parts it was assembled from, so the app can
 * be asked to rebuild it and the result compared against the original.
 *
 *   body        pages 1-7
 *   appendix 1  pages 10-17   (divider on 9)
 *   appendix 2  pages 19-41   (divider on 18)
 *   appendix 3  pages 43-49   (divider on 42)
 */

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REFERENCE = process.argv[2];

if (!REFERENCE) {
  console.error('usage: node test/split-reference.js <path to the reference filing>');
  console.error('The filing is a real client document and is not part of this repository.');
  process.exit(1);
}

const OUT = path.join(__dirname, 'fixtures');

const PARTS = [
  { file: 'body.pdf', from: 1, to: 7 },
  { file: '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf', from: 10, to: 17 },
  { file: '2 - העתק הערר לרבות מסמכים שצורפו.pdf', from: 19, to: 41 },
  { file: '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf', from: 43, to: 49 },
];

async function main() {
  const source = await PDFDocument.load(await fs.readFile(REFERENCE), { ignoreEncryption: true });
  console.log(`reference: ${source.getPageCount()} pages`);

  await fs.mkdir(OUT, { recursive: true });

  for (const part of PARTS) {
    const doc = await PDFDocument.create();
    const indices = [];
    for (let p = part.from; p <= part.to; p++) indices.push(p - 1);

    const pages = await doc.copyPages(source, indices);
    pages.forEach((page) => doc.addPage(page));
    await fs.writeFile(path.join(OUT, part.file), await doc.save());

    console.log(`  ${part.file} — ${doc.getPageCount()} pages (${part.from}-${part.to})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
