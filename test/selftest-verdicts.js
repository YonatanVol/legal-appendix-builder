'use strict';

/**
 * Reading update checks made against the real GitHub.  node test/selftest-verdicts.js
 *
 * The first case is the exact first line recorded by the installed app on Windows during
 * the first v1.3.0 release run, which failed because this reading did not exist yet.
 */

const { githubReachable } = require('../scripts/selftest-verdicts');

const here = { owner: 'YonatanVol', repo: 'legal-appendix-builder' };
const recordedOnWindows = "Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/YonatanVol/legal-appendix-builder/releases/latest), please ensure a production release exists: HttpError: 406 ";

const results = [];
const check = (label, ok, detail = '') => {
  results.push(!!ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};
const verdict = (error, extra = {}) => githubReachable({ ok: false, update: { phase: 'error', error }, ...extra }, here);

console.log('counts as reaching GitHub');
check('the answer the first release run really got: tag pushed, no release published',
  verdict(recordedOnWindows).reached, verdict(recordedOnWindows).why);
check('the same answer as a 404', verdict(recordedOnWindows.replace('HttpError: 406', 'HttpError: 404')).reached);
check('a feed with no entries at all', verdict('No published versions on GitHub').reached);
check('a successful check', githubReachable({ ok: true, update: { phase: 'current', latest: '1.3.0' } }, here).reached);

console.log('\ndoes not');
check('the network rule blocking the request', !verdict('net::ERR_BLOCKED_BY_CLIENT').reached);
check('the same answer about another repository',
  !verdict(recordedOnWindows.replace('YonatanVol/legal-appendix-builder', 'someone/else')).reached);
check('a server error dressed the same way', !verdict(recordedOnWindows.replace('HttpError: 406', 'HttpError: 500')).reached);
check('a missing release feed, as a misspelled repository gives',
  !verdict('HttpError: 404 "method: GET url: https://github.com/YonatanVol/legal-appndix-builder/releases.atom"').reached);
check('no result at all', !githubReachable(null, here).reached);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
