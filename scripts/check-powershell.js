'use strict';

/**
 * Parses every PowerShell script the app runs (the Office conversions and the scanner)
 * with PowerShell's own parser, and fails on any syntax error.
 *
 * Those scripts drive Microsoft Office and the office scanner, neither of which exists on
 * GitHub's Windows machines, so they cannot be run there. A syntax error is the one
 * failure that can be caught without them, and it would otherwise surface only on an
 * office PC. Runs in the Windows workflow; elsewhere it says it was skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const office = require('../src/main/engine/office');
const wia = require('../src/main/engine/wia');

const scripts = { ...office.SCRIPTS, scanner: wia.SCRIPT };

function shell() {
  for (const exe of ['powershell.exe', 'pwsh']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'ignore' });
      return exe;
    } catch {
      // try the next
    }
  }
  return null;
}

const exe = shell();
if (!exe) {
  console.log('PowerShell is not installed here; the scripts are parsed in the Windows workflow.');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-check-'));
let failed = 0;
for (const [name, body] of Object.entries(scripts)) {
  const file = path.join(dir, `${name}.ps1`);
  fs.writeFileSync(file, `﻿${body}`, 'utf8');
  const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }`;
  try {
    execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', check], { stdio: 'pipe' });
    console.log(`  PASS  ${name}: parses`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${String(err.stdout || err.message).trim()}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
