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
# Paths and the scanner's name are read back by Node as UTF-8; the console's old code
# page would garble a Hebrew Windows user name in them.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = $env:OFFICE_SCAN_OUT
$dpi = [int]$env:OFFICE_SCAN_DPI
$intent = [int]$env:OFFICE_SCAN_INTENT
$PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
function Say($kind, $text) { [Console]::Out.WriteLine(($kind + '|' + $text)); [Console]::Out.Flush() }
# PowerShell wraps a failed COM call in its own exception; the scanner's code is on the
# innermost one.
function Code($err) {
  $x = $err.Exception
  while ($x.InnerException) { $x = $x.InnerException }
  return ('{0:X8}' -f $x.HResult)
}
function Prop($props, $id) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p } }
  return $null
}
function SetProp($props, $id, $value) {
  $p = Prop $props $id
  if ($p) { try { $p.Value = $value } catch {} }
}
try {
  $dlg = New-Object -ComObject WIA.CommonDialog
  $dev = $dlg.ShowSelectDevice(1, $false, $true)
} catch {
  $h = Code $_
  if ($h -eq '80210015') { Say 'error' 'NO_DEVICE'; exit 2 }
  if ($h -eq '80210064') { Say 'error' 'CANCELLED'; exit 3 }
  Say 'error' ('SELECT ' + $h); exit 1
}
if (-not $dev) { Say 'error' 'CANCELLED'; exit 3 }
Say 'device' $dev.Properties.Item('Name').Value
# 3087: what the scanner can do (1 feeder, 2 flatbed). 3085: its state (1 paper in the
# feeder). 3088: which one to use. The feeder is used only when it has paper in it, so a
# page left on the glass of a scanner that also has a feeder is still scanned.
$caps = Prop $dev.Properties 3087
$state = Prop $dev.Properties 3085
$feeder = $false
if ($caps -and ($caps.Value -band 1) -and $state -and ($state.Value -band 1)) { $feeder = $true }
# A scanner with a feeder and no glass has nowhere else to scan from, whether or not its
# driver reports paper.
if ($caps -and ($caps.Value -band 1) -and -not ($caps.Value -band 2)) { $feeder = $true }
if ($feeder) {
  SetProp $dev.Properties 3088 1
  SetProp $dev.Properties 3096 1
} elseif ($caps -and ($caps.Value -band 2)) {
  SetProp $dev.Properties 3088 2
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
    $h = Code $_
    if ($h -eq '80210003') { if ($n -gt 0) { break } ; Say 'error' 'PAPER_EMPTY'; exit 4 }
    if ($h -eq '80210064') { if ($n -gt 0) { break } ; Say 'error' 'CANCELLED'; exit 3 }
    if ($h -eq '80210006') { Say 'error' 'BUSY'; exit 5 }
    if ($h -eq '80210002') { Say 'error' 'JAM'; exit 6 }
    Say 'error' ('TRANSFER ' + $h); exit 1
  }
  if (-not $img) { if ($n -gt 0) { break } ; Say 'error' 'CANCELLED'; exit 3 }
  $n++
  $file = Join-Path $out ('page-{0:D3}.png' -f $n)
  if (Test-Path $file) { Remove-Item $file }
  $img.SaveFile($file)
  Say 'page' $n
  if (-not $feeder) { break }
}
Say 'done' $n
`;

const MESSAGES = {
  NO_DEVICE: 'לא נמצא סורק מחובר. בדוק שהסורק דלוק ומחובר למחשב, ושהוא מופיע ב"מדפסות וסורקים" של Windows.',
  CANCELLED: 'הסריקה בוטלה.',
  PAPER_EMPTY: 'אין דפים במזין של הסורק. הנח את הדפים ולחץ שוב על "סריקה".',
  BUSY: 'הסורק תפוס כרגע. המתן רגע ונסה שוב.',
  JAM: 'נייר נתקע בסורק. שחרר אותו והנח את הדפים שלא נסרקו שוב.',
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
  if (signal && signal.aborted) throw new Error(MESSAGES.CANCELLED);
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
          // The script reports the page number; the path is built here, so a Hebrew user
          // name in it never passes through the console at all.
          files.push(path.join(out, `page-${String(Number(value)).padStart(3, '0')}.png`));
          if (onPage) onPage(files.length);
        } else if (kind === 'device') device = value;
        else if (kind === 'error') failure = value;
      }
    });
    const abort = () => child.kill();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.on('error', (err) => reject(new Error(`לא ניתן היה להפעיל את שירות הסריקה של Windows: ${err.message}`)));
    child.on('close', () => {
      if (signal) signal.removeEventListener('abort', abort);
      const end = outcome({ files, device, failure, cancelled: !!(signal && signal.aborted) });
      if (end.error) reject(new Error(end.error));
      else resolve(end);
    });
  });
}

/**
 * How a scan ended, from what the script reported. Pages scanned before a jam, or before
 * the user stopped it, are kept, and the stop is said: never passed off as a complete
 * batch. A scan stopped by the user is said to be stopped, not to have failed.
 * Returns { files, device, warning } or { error }.
 */
function outcome({ files, device, failure, cancelled }) {
  const key = cancelled ? 'CANCELLED' : failure.split(' ')[0];
  const message = MESSAGES[key] || `הסריקה נכשלה (${failure || 'סיבה לא ידועה'}).`;
  if (!files.length) return { error: message };
  const scanned = files.length === 1 ? 'נסרק דף אחד' : `נסרקו ${files.length} דפים`;
  const kept = files.length === 1 ? 'הדף שנסרק נשמר' : 'הדפים שנסרקו נשמרו';
  if (cancelled) return { files, device, warning: `${scanned} ואז הסריקה בוטלה. ${kept}.` };
  return { files, device, warning: failure ? `${scanned} ואז הסריקה נעצרה: ${message}` : '' };
}

module.exports = { acquire, available, outcome, SCANS_ROOT, MESSAGES, SCRIPT };
