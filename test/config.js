'use strict';

/**
 * Fast checks on configuration that no runtime test exercises until it is too late.
 *   node test/config.js
 *
 * Runs first in the Windows workflow. Each check guards a way the app can work
 * perfectly from source and still fail once it is packaged and in someone's hands.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { builtinModules } = require('module');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

const builder = yaml.load(read('electron-builder.yml'));
const pkg = JSON.parse(read('package.json'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const sources = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));

/* ---- what ships must be able to load ---- */
console.log('everything the app requires at run time ships with it');
// Only "dependencies" are packaged. A module required from src but listed under
// devDependencies works from source and crashes the installed app on its first use.
const builtins = new Set([...builtinModules, 'electron']);
const needed = new Map();
for (const file of sources) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (builtins.has(name)) continue;
    if (!needed.has(name)) needed.set(name, path.relative(ROOT, file));
  }
}
for (const [name, where] of needed) {
  check(`${name} is a shipped dependency`, !!(pkg.dependencies || {})[name], `required by ${where}`);
}
check('the updater is pinned to an exact version',
  /^\d+\.\d+\.\d+$/.test((pkg.dependencies || {})['electron-updater'] || ''),
  (pkg.dependencies || {})['electron-updater']);

/* ---- the installer ---- */
console.log('\nthe installer');
const win = builder.win || {};
const nsis = builder.nsis || {};
const targets = (win.target || []).map((t) => (typeof t === 'string' ? t : t.target));
check('Windows ships as an NSIS installer, never a loose folder or zip',
  targets.length === 1 && targets[0] === 'nsis', targets.join(', '));
check('the program file name is plain ASCII', /^[A-Za-z0-9._-]+$/.test(win.executableName || ''), win.executableName);
check('the installer file name has no spaces or non-ASCII',
  /^[A-Za-z0-9.${}_-]+$/.test(nsis.artifactName || ''), nsis.artifactName);
check('installs for the user alone, with no administrator prompt',
  nsis.oneClick === true && nsis.perMachine === false);
check('uninstalling keeps her history', nsis.deleteAppDataOnUninstall === false);
check('the bundled fonts are packaged', (builder.files || []).some((f) => /assets\/fonts/.test(f)));

// 1.3.0's installer crashed at random with 0xC0000005 before extracting anything:
// electron-builder 25's per-user install code copied a fixed 8192 characters out of the
// short buffer Windows returns for the user's Programs folder, and whether that overread
// hit unmapped memory depended on the heap. electron-builder 26.12 copies it bounded.
const multiUser = read('node_modules/app-builder-lib/templates/nsis/multiUser.nsh');
check('the installer reads the per-user Programs folder with a bounded copy',
  multiUser.includes('lstrcpynW') && !multiUser.includes('(&w${NSIS_MAX_STRLEN} .s)'));

const indexSource = read('src/main/index.js');
const appId = (/const APP_ID = '([^']+)'/.exec(indexSource) || [])[1];
check('the running app identifies itself with the installer\'s app id', appId === builder.appId,
  `${appId} vs ${builder.appId}`);

/* ---- updates ---- */
console.log('\nupdates come from this repository');
const publish = builder.publish || {};
let remote = '';
try {
  remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // not a clone
}
check('updates are published to GitHub', publish.provider === 'github');
if (remote) {
  // The code repository is private, and an app cannot update from a private repository
  // without carrying a credential. Updates must come from a separate, code-free one.
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/.exec(remote);
  check('  from a repository separate from the code',
    m && m[1] === publish.owner && m[2] !== publish.repo, `${publish.owner}/${publish.repo} vs ${remote}`);
}

const workflow = yaml.load(read('.github/workflows/windows.yml'));
const release = workflow.jobs.release || {};
const publishStep = (release.steps || []).find((st) => /releases repository/.test(st.name || '')) || {};
check('releases go to that repository with the release token, not the code repository\'s own',
  String((publishStep.env || {}).GH_TOKEN).includes('secrets.RELEASES_TOKEN') &&
    /--repo "\$OWNER\/\$REPO"/.test(publishStep.run || ''));
check('releases are published only from a version tag',
  String(release.if || '').includes("startsWith(github.ref, 'refs/tags/v')"), release.if);
check('  and only after the Windows install and launch checks pass',
  [].concat(release.needs || []).includes('build-and-verify'));

/* ---- notes for the version being built ---- */
console.log('\nthe version');
const { notesFor } = require('../scripts/release-notes');
const notes = notesFor(pkg.version, read('CHANGELOG.md'));
check(`CHANGELOG.md has notes for ${pkg.version} to show after the update`, !!notes && notes.length > 20,
  notes ? `${notes.length} chars` : 'missing');
check('  and they read like a person wrote them, with no dashes', !!notes && !/[—–]/.test(notes));

/* ---- copy ---- */
console.log('\nHebrew copy');
// Text she reads never uses an em or en dash as punctuation. Hebrew lines only, and
// not comments, so code such as a filename regex is not caught by accident.
const offenders = [];
const scan = (file, lines) =>
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
    if (/[֐-׿]/.test(line) && /[—–]/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
  });
for (const file of [...sources, path.join(ROOT, 'src/renderer/index.html')]) {
  scan(file, fs.readFileSync(file, 'utf8').split('\n'));
}
check('no dashes in text the user reads', offenders.length === 0, offenders.join(', '));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
