'use strict';

/**
 * Finding text across the pieces a PDF splits it into (src/shared/textfind.js), as Redact
 * searches a page. Plain Node: the pieces and their boxes are given directly.
 *   node test/textfind.js
 */

const { findInBoxes } = require('../src/shared/textfind');

const results = [];
function check(label, condition, detail = '') {
  results.push(!!condition);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

const ID = /\b\d{8,9}\b|\b\d{7,8}-\d\b/g;
const piece = (str, x, w, y = 0.1, rtl = false) => ({ str, x, y, w, h: 0.02, rtl, vertical: false });

let hits = findInBoxes([piece('ת"ז', 0.6, 0.03, 0.1, true), piece('012', 0.40, 0.03), piece('345', 0.43, 0.03), piece('678', 0.46, 0.03)], ID);
check('an ID number in three touching pieces is found whole, once', hits.length === 1 && hits[0].text === '012345678', JSON.stringify(hits.map((h) => h.text)));
check('  and its box covers all three pieces', hits[0] && hits[0].x <= 0.40 && hits[0].x + hits[0].w >= 0.49, JSON.stringify(hits[0]));

hits = findInBoxes([piece('678', 0.46, 0.03), piece('012', 0.40, 0.03), piece('345', 0.43, 0.03)], ID);
check('pieces listed out of order are joined in the order they sit on the page', hits.length === 1 && hits[0].text === '012345678', JSON.stringify(hits.map((h) => h.text)));

hits = findInBoxes([piece('0123', 0.10, 0.04), piece('45678', 0.50, 0.05)], ID);
check('two numbers far apart on a line are not joined into one', hits.length === 0, JSON.stringify(hits.map((h) => h.text)));

hits = findInBoxes([piece('012', 0.40, 0.03, 0.1), piece('345678', 0.43, 0.06, 0.3)], ID);
check('pieces on different lines are not joined', hits.length === 0, JSON.stringify(hits.map((h) => h.text)));

const letter = (c, x) => piece(c, x, 0.01, 0.3, true);
hits = findInBoxes([letter('ה', 0.13), letter('נ', 0.12), letter('ל', 0.11), letter('ט', 0.10)], /הנלט/g);
check('a Hebrew word drawn one letter per piece is found', hits.length === 1, JSON.stringify(hits.map((h) => h.text)));

hits = findInBoxes([letter('ט', 0.10), letter('ל', 0.11), letter('נ', 0.12), letter('ה', 0.13)], /הנלט/g);
check('  also when the file lists its letters left to right', hits.length === 1, JSON.stringify(hits.map((h) => h.text)));

hits = findInBoxes([piece('ת"ז 012345678 וגם 87654321', 0.1, 0.6)], ID);
check('matches inside one piece are still found, each once', hits.length === 2, JSON.stringify(hits.map((h) => h.text)));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
