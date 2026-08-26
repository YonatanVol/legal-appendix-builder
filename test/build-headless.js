'use strict';

/**
 * Runs the real assembly pipeline without the UI, so the output can be diffed
 * against the reference filing. Launch with:  npx electron test/build-headless.js
 */

const path = require('path');
const { app } = require('electron');

const { buildBundle } = require('../src/main/pdf/assemble');

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output', 'rebuilt.pdf');

const SPEC = {
  bodyPath: path.join(FIXTURES, 'body.pdf'),
  appendices: [
    {
      title: 'העתק פרוטוקול ועדת העררים מיום 07/07/26',
      files: [path.join(FIXTURES, '1 - העתק פרוטוקול ועדת העררים מיום 07-07-26.pdf')],
    },
    {
      title: 'העתק הערר לרבות מסמכים שצורפו',
      files: [path.join(FIXTURES, '2 - העתק הערר לרבות מסמכים שצורפו.pdf')],
    },
    {
      title: 'פרוטוקול ועדה מיום 26/03/26 והודעת ביטוח לאומי מיום 27/03/26',
      files: [path.join(FIXTURES, '3 - פרוטוקול ועדה מיום 26-03-26 והודעת ביטוח לאומי.pdf')],
    },
  ],
  outputPath: OUTPUT,
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    await require('fs/promises').mkdir(path.dirname(OUTPUT), { recursive: true });
    const result = await buildBundle(SPEC, (stage) => console.log('  ' + stage));

    console.log('\nbuilt:', result.outputPath);
    console.log('total pages:', result.totalPages);
    console.log('toc page:', result.tocPage, `(${result.tocPages} page(s))`);
    result.appendices.forEach((a) =>
      console.log(`  נספח ${a.number}: divider ${a.dividerPage}, עמ' ${a.range}`)
    );
    app.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    app.exit(1);
  }
});
