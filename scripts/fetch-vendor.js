'use strict';

/**
 * Fetches the two programs the app ships beside itself on Windows, checks each
 * download against a pinned SHA-256, and unpacks it into vendor/win/, which the
 * installer then carries (see extraResources in electron-builder.yml).
 *
 *   qpdf         Apache 2.0   encryption, decryption, structural repair
 *   Ghostscript  AGPL 3.0     compression, PDF/A, page images
 *
 * A checksum that does not match stops the build: a release host serving a different
 * file is exactly the case this exists to catch.
 *
 * Usage: node scripts/fetch-vendor.js        (Windows, or anywhere 7-Zip is installed)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'vendor', 'cache');
const OUT = path.join(ROOT, 'vendor', 'win');

const PACKAGES = [
  {
    name: 'qpdf',
    version: '12.4.2',
    url: 'https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-msvc64.zip',
    sha256: 'db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d',
    // The zip holds one folder; its bin/ has qpdf.exe, qpdf30.dll and the MSVC runtime.
    unpack: (file, dest) => {
      const tmp = `${dest}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      execFileSync(tar(), ['-xf', file, '-C', tmp]);
      const inner = path.join(tmp, fs.readdirSync(tmp)[0]);
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(path.join(inner, 'bin'), path.join(dest, 'bin'), { recursive: true });
      for (const f of fs.readdirSync(inner)) if (/^(LICENSE|NOTICE|README)/i.test(f)) fs.copyFileSync(path.join(inner, f), path.join(dest, f));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    check: (dest) => fs.existsSync(path.join(dest, 'bin', 'qpdf.exe')),
  },
  {
    name: 'gs',
    version: '10.08.0',
    url: 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080/gs10080w64.exe',
    sha256: '52a91b8bf09298788d7a57b9206127026c23eacd75405f0a131e26dc381dce50',
    // An NSIS installer; 7-Zip reads it as an archive without running it.
    unpack: (file, dest) => {
      const tmp = `${dest}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      execFileSync(sevenZip(), ['x', file, `-o${tmp}`, '-y'], { stdio: 'ignore' });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(path.join(tmp, 'bin'), path.join(dest, 'bin'), { recursive: true });
      fs.cpSync(path.join(tmp, 'lib'), path.join(dest, 'lib'), { recursive: true });
      for (const f of ['LICENSE', 'doc/COPYING']) {
        const src = path.join(tmp, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, path.basename(f)));
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    check: (dest) => fs.existsSync(path.join(dest, 'bin', 'gswin64c.exe')) && fs.existsSync(path.join(dest, 'bin', 'gsdll64.dll')),
  },
];

/** Windows' own bsdtar reads zip files; a GNU tar earlier on PATH (Git's) does not. */
function tar() {
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return 'tar';
}

function sevenZip() {
  const candidates = ['C:\\Program Files\\7-Zip\\7z.exe', '7z', '7zz'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['i'], { stdio: 'ignore' });
      return c;
    } catch {
      // try the next
    }
  }
  throw new Error('7-Zip is needed to unpack the Ghostscript installer. It is preinstalled on GitHub\'s Windows runners.');
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  await fsp.mkdir(CACHE, { recursive: true });
  for (const pkg of PACKAGES) {
    const dest = path.join(OUT, pkg.name);
    const stamp = path.join(dest, '.version');
    if (pkg.check(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === pkg.sha256) {
      console.log(`${pkg.name} ${pkg.version}: present`);
      continue;
    }
    const file = path.join(CACHE, path.basename(new URL(pkg.url).pathname));
    if (!fs.existsSync(file) || sha256(file) !== pkg.sha256) {
      console.log(`${pkg.name} ${pkg.version}: downloading`);
      await download(pkg.url, file);
    }
    const actual = sha256(file);
    if (actual !== pkg.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error(`${pkg.name}: checksum mismatch.\n  expected ${pkg.sha256}\n  got      ${actual}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    pkg.unpack(file, dest);
    if (!pkg.check(dest)) throw new Error(`${pkg.name}: unpacked, but the program is not where it should be.`);
    fs.writeFileSync(stamp, pkg.sha256);
    console.log(`${pkg.name} ${pkg.version}: ready in ${path.relative(ROOT, dest)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { PACKAGES };
