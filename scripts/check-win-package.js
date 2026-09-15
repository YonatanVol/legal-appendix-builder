'use strict';

/**
 * Can the Windows program actually start from this folder?
 *
 *   node scripts/check-win-package.js <folder containing the installed or unpacked app>
 *
 * The first person to install the app got "ffmpeg.dll was not found" before a window
 * ever appeared. The exe imports that DLL at load time, so Windows refuses to run it
 * unless the file sits in the same folder. Every test until then ran from source on a
 * Mac, so nothing had ever checked the one thing that failed.
 *
 * This reads the exe's import table and requires every DLL that is not part of Windows
 * itself to be present beside it. It fails on exactly the layout she ended up with.
 */

const fs = require('fs');
const path = require('path');

// DLLs Windows supplies. Anything an Electron exe imports that is not on this list
// ships with the app and must be next to the exe.
const SYSTEM_DLLS = new Set([
  'advapi32.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcrypt.dll', 'comctl32.dll',
  'comdlg32.dll', 'crypt32.dll', 'd3d11.dll', 'dbghelp.dll', 'dhcpcsvc.dll', 'dwmapi.dll',
  'dwrite.dll', 'dxgi.dll', 'gdi32.dll', 'iphlpapi.dll', 'kernel32.dll', 'msimg32.dll',
  'ncrypt.dll', 'ntdll.dll', 'ole32.dll', 'oleacc.dll', 'oleaut32.dll', 'powrprof.dll',
  'psapi.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll', 'user32.dll',
  'userenv.dll', 'uxtheme.dll', 'version.dll', 'winhttp.dll', 'winmm.dll', 'winspool.drv',
  'wintrust.dll', 'ws2_32.dll', 'wtsapi32.dll',
]);

function importedDlls(exePath) {
  const d = fs.readFileSync(exePath);
  if (d.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${exePath} is not a Windows executable`);

  const pe = d.readUInt32LE(0x3c);
  if (d.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${exePath} has no PE header`);

  const sectionCount = d.readUInt16LE(pe + 6);
  const optionalSize = d.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const is64 = d.readUInt16LE(optional) === 0x20b;
  const importRva = d.readUInt32LE(optional + (is64 ? 112 : 96) + 8);

  const sections = [];
  for (let i = 0, s = optional + optionalSize; i < sectionCount; i++, s += 40) {
    sections.push({
      va: d.readUInt32LE(s + 12),
      size: Math.max(d.readUInt32LE(s + 8), d.readUInt32LE(s + 16)),
      raw: d.readUInt32LE(s + 20),
    });
  }
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
    return rva - s.va + s.raw;
  };

  const names = [];
  for (let o = offset(importRva); ; o += 20) {
    const nameRva = d.readUInt32LE(o + 12);
    if (nameRva === 0) break;
    const n = offset(nameRva);
    names.push(d.toString('latin1', n, d.indexOf(0, n)));
  }
  return names;
}

function checkFolder(folder) {
  const exes = fs.readdirSync(folder).filter((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f));
  if (exes.length === 0) return { ok: false, problems: [`no program .exe in ${folder}`] };

  const present = new Set(fs.readdirSync(folder).map((f) => f.toLowerCase()));
  const problems = [];
  const report = [];

  for (const exe of exes) {
    const needed = importedDlls(path.join(folder, exe))
      .map((n) => n.toLowerCase())
      .filter((n) => !SYSTEM_DLLS.has(n));
    report.push({ exe, appLocalDlls: needed });
    for (const dll of needed) {
      if (!present.has(dll)) problems.push(`${exe} needs ${dll} beside it, and it is not there`);
    }
  }

  // Chromium also loads these at start-up; without them the window never draws.
  for (const required of ['resources/app.asar', 'icudtl.dat', 'v8_context_snapshot.bin', 'resources.pak']) {
    if (!fs.existsSync(path.join(folder, required))) problems.push(`missing ${required}`);
  }

  return { ok: problems.length === 0, problems, report };
}

module.exports = { importedDlls, checkFolder, SYSTEM_DLLS };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node scripts/check-win-package.js <app folder>');
    process.exit(2);
  }
  const result = checkFolder(folder);
  for (const r of result.report || []) {
    console.log(`${r.exe} loads at start-up: ${r.appLocalDlls.join(', ') || '(system DLLs only)'}`);
  }
  if (result.ok) {
    console.log('OK: the program can start from this folder');
  } else {
    result.problems.forEach((p) => console.error(`FAIL: ${p}`));
  }
  process.exit(result.ok ? 0 : 1);
}
