'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

/*
 * Converting Office documents, with the programs already on the PC.
 *
 * Microsoft Office first: Word, Excel and PowerPoint do their own "Save as PDF", and
 * Word opens a PDF as an editable document, which is the best Hebrew fidelity there is.
 * They are driven through Windows' automation interface (COM) by PowerShell, invisibly,
 * one document at a time, and closed afterwards even when something fails.
 *
 * LibreOffice is the fallback when Office is not installed. Its own copy settings live
 * in the job's scratch folder, so it never disturbs a LibreOffice the user has open.
 *
 * Neither ships with the app. GitHub's Windows machines have no Microsoft Office, so the
 * Office path is verified on an office PC; the README says so.
 */

const isWin = process.platform === 'win32';

// One script per program. Paths arrive in environment variables (Unicode on Windows),
// never on a command line, and the program is quit in `finally` so a failure cannot
// leave an invisible Word running.
const SCRIPTS = {
  word: String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$app = $null; $doc = $null
try {
  # Which Word is this script's own, so a cancelled conversion can stop it: the one that
  # was not running a moment before, and only when exactly one appeared. It is stopped only
  # while it is still hidden, so a window the user opens meanwhile is never closed.
  $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = New-Object -ComObject Word.Application
  $mine = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($mine.Count -eq 1) { [Console]::Out.WriteLine('pid|' + $mine[0].Id + '|WINWORD') }
  $app.Visible = $false
  $app.DisplayAlerts = 0
  $app.AutomationSecurity = 3
  # Open: FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
  $doc = $app.Documents.Open($env:OFFICE_IN, $false, $true, $false)
  if ($env:OFFICE_TO -eq 'docx') { $doc.SaveAs2($env:OFFICE_OUT, 16) } else { $doc.ExportAsFixedFormat($env:OFFICE_OUT, 17) }
  [Console]::Out.WriteLine('ok')
} catch {
  $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }
  [Console]::Out.WriteLine('error|' + ('{0:X8}' -f $x.HResult) + ' ' + $x.Message)
  exit 1
} finally {
  if ($doc) { try { $doc.Close($false) } catch {} }
  if ($app) { try { $app.Quit() ; [Console]::Out.WriteLine('quit|') } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
`,
  excel: String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$app = $null; $book = $null
try {
  # Which Excel is this script's own, so a cancelled conversion can stop it: the one that
  # was not running a moment before, and only when exactly one appeared. It is stopped only
  # while it is still hidden, so a window the user opens meanwhile is never closed.
  $before = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = New-Object -ComObject Excel.Application
  $mine = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($mine.Count -eq 1) { [Console]::Out.WriteLine('pid|' + $mine[0].Id + '|EXCEL') }
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.AutomationSecurity = 3
  # Open: FileName, UpdateLinks (0 = never), ReadOnly
  $book = $app.Workbooks.Open($env:OFFICE_IN, 0, $true)
  # 0 = xlTypePDF; every sheet, as printed
  $book.ExportAsFixedFormat(0, $env:OFFICE_OUT)
  [Console]::Out.WriteLine('ok')
} catch {
  $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }
  [Console]::Out.WriteLine('error|' + ('{0:X8}' -f $x.HResult) + ' ' + $x.Message)
  exit 1
} finally {
  if ($book) { try { $book.Close($false) } catch {} }
  if ($app) { try { $app.Quit() ; [Console]::Out.WriteLine('quit|') } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
`,
  powerpoint: String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$app = $null; $pres = $null
try {
  # Which PowerPoint is this script's own, so a cancelled conversion can stop it: the one that
  # was not running a moment before, and only when exactly one appeared. It is stopped only
  # while it is still hidden, so a window the user opens meanwhile is never closed.
  $before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = New-Object -ComObject PowerPoint.Application
  $mine = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($mine.Count -eq 1) { [Console]::Out.WriteLine('pid|' + $mine[0].Id + '|POWERPNT') }
  $app.AutomationSecurity = 3
  # Open: FileName, ReadOnly, Untitled, WithWindow (false: no window at all)
  $pres = $app.Presentations.Open($env:OFFICE_IN, -1, 0, 0)
  # 32 = ppSaveAsPDF
  $pres.SaveAs($env:OFFICE_OUT, 32)
  [Console]::Out.WriteLine('ok')
} catch {
  $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }
  [Console]::Out.WriteLine('error|' + ('{0:X8}' -f $x.HResult) + ' ' + $x.Message)
  exit 1
} finally {
  if ($pres) { try { $pres.Close() } catch {} }
  if ($app) { try { $app.Quit() ; [Console]::Out.WriteLine('quit|') } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
`,
  probe: String.raw`
foreach ($id in 'Word.Application', 'Excel.Application', 'PowerPoint.Application') {
  if ([type]::GetTypeFromProgID($id)) { [Console]::Out.WriteLine($id) }
}
`,
};

const PROGRAM = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' };
const TIME_LIMIT_MS = 5 * 60 * 1000;

/**
 * Run a script in PowerShell. Resolves with its exit code (null when it was stopped) and
 * what it printed. A script that starts an Office program prints "pid|N|NAME" for it, and
 * "quit|" once it has quit it; stopping the script (Esc, or the time limit) in between
 * stops that program too, since quitting it is left to the script's `finally`, which a
 * stopped script never reaches. `host` and `stopProgram` replace PowerShell and the
 * Windows stop in tests.
 */
function powershell(script, env, { signal, timeout = TIME_LIMIT_MS, host, stopProgram = stopHiddenOffice } = {}) {
  if (signal && signal.aborted) return Promise.resolve({ code: null, out: '' });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const [command, args] = host || ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    let pending = '';
    let program = null;
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      pending += s;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = /^pid\|(\d+)\|(\w+)$/.exec(line.trim());
        if (m) program = { pid: Number(m[1]), name: m[2] };
        if (line.trim() === 'quit|') program = null;
      }
    });
    const stop = () => {
      child.kill();
      if (program) stopProgram(program.pid, program.name);
    };
    const timer = setTimeout(stop, timeout);
    if (signal) signal.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({ code, out });
    });
  });
}

/**
 * Stops the Office program a stopped conversion left behind: only while it is still that
 * program, and still hidden. If the user has opened a document in it meanwhile, it has a
 * window, and it is theirs now; it is left alone.
 */
function hiddenStopScript(pid, name) {
  return `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq '${String(name).replace(/[^A-Z]/g, '')}' -and $p.MainWindowHandle -eq 0) { Stop-Process -Id ${Number(pid)} -Force }`;
}

function stopHiddenOffice(pid, name) {
  const script = hiddenStopScript(pid, name);
  try {
    const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } catch {
    // no PowerShell: nothing more can be done
  }
}

let found = null;

/** Which Office programs the PC has, and LibreOffice's program if it is installed. */
async function detect() {
  if (found) return found;
  const office = new Set();
  if (isWin) {
    try {
      const r = await powershell(SCRIPTS.probe, {}, { timeout: 30000 });
      for (const line of r.out.split(/\r?\n/)) {
        const m = /^(Word|Excel|PowerPoint)\.Application$/.exec(line.trim());
        if (m) office.add(m[1].toLowerCase());
      }
    } catch {
      // no PowerShell: treated as no Office
    }
  }
  found = { office, libre: findLibre() };
  return found;
}

function findLibre() {
  const tries = [];
  if (process.env.OFFICE_LIBREOFFICE) tries.push(process.env.OFFICE_LIBREOFFICE);
  if (isWin) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      tries.push(path.join(base, 'LibreOffice', 'program', 'soffice.exe'));
    }
  } else {
    tries.push('/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/usr/bin/soffice');
  }
  return tries.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

/** For tests: forget what was found, or pretend Office is or is not there. */
function reset(value = null) {
  found = value;
}

/**
 * Whether a conversion can run here, and if not, a sentence saying what to install.
 * @param {'word'|'excel'|'powerpoint'} program
 */
async function availability(program) {
  const { office, libre } = await detect();
  if (office.has(program) || libre) return { available: true };
  return {
    available: false,
    reason: `לא נמצא במחשב הזה ${PROGRAM[program]} של Microsoft Office, וגם לא LibreOffice. ההמרה נעשית בתוכנות האלה, ולכן צריך להתקין אחת מהן.`,
  };
}

/**
 * Convert one file. `input` is a staged file in scratch; returns the written file.
 * @param {'word'|'excel'|'powerpoint'} program  which Office program reads the input
 * @param {'pdf'|'docx'} to
 */
async function convert(program, input, to, ctx) {
  const { office, libre } = await detect();
  const out = path.join(ctx.scratch, `converted-${path.basename(input, path.extname(input))}.${to}`);
  if (office.has(program)) {
    const r = await powershell(SCRIPTS[program], { OFFICE_IN: input, OFFICE_OUT: out, OFFICE_TO: to }, { signal: ctx.signal });
    ctx.throwIfCancelled();
    if (r.code === 0 && fs.existsSync(out)) return { file: out, engine: PROGRAM[program] };
    // A program that showed a window of its own meanwhile (a sign-in or start-up question)
    // is not stopped, since it can no longer be told apart from one the user opened.
    if (r.code === null) throw new Error(`${PROGRAM[program]} לא סיים את ההמרה תוך חמש דקות, ולכן היא הופסקה. אם נשאר חלון של ${PROGRAM[program]} פתוח עם שאלה, ענה עליה או סגור אותו. אם המסמך גדול מאוד, נסה לפתוח אותו ב-${PROGRAM[program]} ולשמור כ-PDF ידנית.`);
    const failure = r.out.split(/\r?\n/).find((line) => line.startsWith('error|')) || '';
    const detail = failure.slice('error|'.length).trim();
    if (!libre) throw new Error(`${PROGRAM[program]} לא הצליח להמיר את הקובץ.${/password|סיסמ/i.test(detail) ? ' הקובץ מוגן בסיסמה.' : ''}`);
    // Office failed on this file; LibreOffice may still read it.
  }
  if (!libre) throw new Error((await availability(program)).reason);
  return { file: await viaLibre(libre, input, to, ctx), engine: 'LibreOffice' };
}

async function viaLibre(soffice, input, to, ctx) {
  const profile = path.join(ctx.scratch, 'lo-profile');
  await fsp.mkdir(profile, { recursive: true });
  const outDir = path.join(ctx.scratch, 'lo-out');
  await fsp.mkdir(outDir, { recursive: true });
  const args = [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless', '--norestore', '--nolockcheck', '--nodefault',
  ];
  if (to === 'docx' && /\.pdf$/i.test(input)) args.push('--infilter=writer_pdf_import', '--convert-to', 'docx:MS Word 2007 XML');
  else args.push('--convert-to', to);
  args.push('--outdir', outDir, input);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(soffice, args, { windowsHide: true, stdio: 'ignore' });
    const stop = () => child.kill();
    const timer = setTimeout(stop, TIME_LIMIT_MS);
    ctx.signal.addEventListener('abort', stop, { once: true });
    child.on('error', reject);
    child.on('close', (c) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', stop);
      resolve(c);
    });
  });
  ctx.throwIfCancelled();
  const made = path.join(outDir, `${path.basename(input, path.extname(input))}.${to}`);
  if (code !== 0 || !fs.existsSync(made)) throw new Error('LibreOffice לא הצליח להמיר את הקובץ. ייתכן שהוא פגום או מוגן בסיסמה.');
  return made;
}

module.exports = { powershell, hiddenStopScript, detect, availability, convert, reset, SCRIPTS, PROGRAM };
