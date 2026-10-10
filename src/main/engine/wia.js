'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/*
 * The office scanner, through Windows Image Acquisition (WIA), the scanning service
 * every Windows PC has. PowerShell drives it: no driver of ours, nothing installed.
 *
 * With a document feeder it scans until the feeder is empty; on a flatbed it scans one
 * page, and the screen offers to scan the next. Pages are saved as PNG in a private
 * temporary folder and handed to Scan to PDF like any other picture.
 *
 * This cannot be tested on GitHub's machines or a Mac: neither has a scanner. It is
 * verified on an office PC, and the README says so.
 */

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$out = $env:OFFICE_SCAN_OUT
$dpi = [int]$env:OFFICE_SCAN_DPI
$intent = [int]$env:OFFICE_SCAN_INTENT
$PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
function Say($kind, $text) { [Console]::Out.WriteLine(($kind + '|' + $text)); [Console]::Out.Flush() }
function SetProp($props, $id, $value) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { try { $p.Value = $value } catch {} ; return } }
}
try {
  $dlg = New-Object -ComObject WIA.CommonDialog
  $dev = $dlg.ShowSelectDevice(1, $false, $true)
} catch {
  $h = '{0:X8}' -f $_.Exception.HResult
  if ($h -eq '80210015') { Say 'error' 'NO_DEVICE'; exit 2 }
  if ($h -eq '80210064') { Say 'error' 'CANCELLED'; exit 3 }
  Say 'error' ('SELECT ' + $h + ' ' + $_.Exception.Message); exit 1
}
Say 'device' $dev.Properties.Item('Name').Value
$feeder = $false
foreach ($p in $dev.Properties) {
  if ($p.PropertyID -eq 3087 -and ($p.Value -band 1)) { $feeder = $true }
}
if ($feeder) {
  SetProp $dev.Properties 3088 1
  SetProp $dev.Properties 3096 1
}
$item = $dev.Items.Item(1)
SetProp $item.Properties 6146 $intent
SetProp $item.Properties 6147 $dpi
SetProp $item.Properties 6148 $dpi
$n = 0
while ($true) {
  try {
    $img = $dlg.ShowTransfer($item, $PNG, $false)
  } catch {
    $h = '{0:X8}' -f $_.Exception.HResult
    if ($h -eq '80210003' -and $n -gt 0) { break }
    if ($h -eq '80210003') { Say 'error' 'PAPER_EMPTY'; exit 4 }
    if ($h -eq '80210006') { Say 'error' 'BUSY'; exit 5 }
    if ($h -eq '80210064') { break }
    Say 'error' ('TRANSFER ' + $h + ' ' + $_.Exception.Message); exit 1
  }
  $n++
  $file = Join-Path $out ('page-{0:D3}.png' -f $n)
  if (Test-Path $file) { Remove-Item $file }
  $img.SaveFile($file)
  Say 'page' $file
  if (-not $feeder) { break }
}
Say 'done' $n
`;

const MESSAGES = {
  NO_DEVICE: 'לא נמצא סורק מחובר. בדוק שהסורק דלוק ומחובר למחשב, ושהוא מופיע ב"מדפסות וסורקים" של Windows.',
  CANCELLED: 'הסריקה בוטלה.',
  PAPER_EMPTY: 'אין דפים במזין של הסורק. הנח את הדפים ולחץ שוב על "סריקה".',
  BUSY: 'הסורק תפוס כרגע. המתן רגע ונסה שוב.',
};

const SCANS_ROOT = path.join(os.tmpdir(), 'rotem-office-scans');

function available() {
  return process.platform === 'win32'
    ? { available: true }
    : { available: false, reason: 'סריקה מסורק זמינה במחשבי Windows של המשרד.' };
}

/**
 * Scan pages from the office scanner.
 * @param {{dpi?: number, mode?: 'color'|'gray'|'bw', onPage?: Function, signal?: AbortSignal}} options
 * @returns {Promise<{files: string[], device: string}>}
 */
async function acquire({ dpi = 300, mode = 'gray', onPage, signal } = {}) {
  const status = available();
  if (!status.available) throw new Error(status.reason);
  const out = path.join(SCANS_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(out, { recursive: true });
  const intent = { color: 1, gray: 2, bw: 4 }[mode] || 2;
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, OFFICE_SCAN_OUT: out, OFFICE_SCAN_DPI: String(dpi), OFFICE_SCAN_INTENT: String(intent) },
    });
    const files = [];
    let device = '';
    let failure = '';
    let pending = '';
    child.stdout.on('data', (d) => {
      pending += d.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const [kind, ...rest] = line.split('|');
        const value = rest.join('|');
        if (kind === 'page') {
          files.push(value);
          if (onPage) onPage(files.length);
        } else if (kind === 'device') device = value;
        else if (kind === 'error') failure = value;
      }
    });
    const abort = () => child.kill();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => reject(new Error(`לא ניתן היה להפעיל את שירות הסריקה של Windows: ${err.message}`)));
    child.on('close', () => {
      if (signal) signal.removeEventListener('abort', abort);
      if (files.length) return resolve({ files, device });
      const key = failure.split(' ')[0];
      reject(new Error(MESSAGES[key] || `הסריקה נכשלה. ${failure}`.trim()));
    });
  });
}

module.exports = { acquire, available, SCANS_ROOT, MESSAGES };
