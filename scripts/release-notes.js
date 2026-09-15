'use strict';

/**
 * Print the user-facing notes for one version from CHANGELOG.md.
 *   node scripts/release-notes.js 1.3.0
 *
 * A section's text up to its first "###" heading is written for the person using the
 * app, and becomes the GitHub release body, which the updater shows her after it
 * installs. Everything from the first "###" on is for whoever maintains the code.
 */

const fs = require('fs');
const path = require('path');

function notesFor(version, changelog) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line) || /^###\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

module.exports = { notesFor };

if (require.main === module) {
  const version = process.argv[2];
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const notes = notesFor(version, changelog);
  if (!notes) {
    console.error(`CHANGELOG.md has no user-facing notes for ${version}`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
}
