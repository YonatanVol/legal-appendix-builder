'use strict';

/**
 * Does the installed program know where its updates come from?
 *   node scripts/check-update-config.js <installed app folder>
 *
 * The installed app finds its releases through resources/app-update.yml, which
 * electron-builder writes from the publish settings. The update tests that install a
 * newer version point the app at a local feed instead, which bypasses this file, so
 * without this check a missing or wrong file would pass every test and ship.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node scripts/check-update-config.js <installed app folder>');
  process.exit(2);
}

const expected = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')).publish;
const file = path.join(folder, 'resources', 'app-update.yml');
const problems = [];

if (!fs.existsSync(file)) {
  problems.push(`${file} does not exist, so the installed app has nowhere to look for updates`);
} else {
  const actual = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  console.log(`app-update.yml: ${JSON.stringify(actual)}`);
  for (const key of ['provider', 'owner', 'repo']) {
    if (actual[key] !== expected[key]) problems.push(`${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(expected[key])}`);
  }
  if (!actual.updaterCacheDirName) problems.push('updaterCacheDirName is missing');
}

if (problems.length) {
  problems.forEach((p) => console.error(`FAIL: ${p}`));
  process.exit(1);
}
console.log(`OK: updates come from ${expected.provider}:${expected.owner}/${expected.repo}`);
