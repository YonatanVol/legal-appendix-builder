'use strict';

/**
 * Workflows: building, saving, and running chains of tools.
 * Launch with:  npx electron test/workflows.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { openWindow } = require('./helpers/window');

const jobs = require('../src/main/jobs');
const tools = require('../src/main/tools');
const text = require('../src/main/pdf/text');
const bin = require('../src/main/engine/binaries');
const runs = require('../src/main/runs');
const workflows = require('../src/main/workflows');
const { registerIpc } = require('../src/main/ipc');
const { disposeRenderer } = require('../src/main/pdf/render');
const { lockDownNetwork } = require('../src/main/security');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

async function pdfOf(file, pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`${label} ${i + 1}`, { x: 60, y: 600, size: 24, font });
  await fsp.writeFile(file, await doc.save());
  return file;
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workflows-'));
  workflows.setStoreFile(path.join(dir, 'workflows.json'));
  runs.setStoreFile(path.join(dir, 'runs.json'));
  require('../src/main/settings').setStoreFile(path.join(dir, 'settings.json'));
  const a = await pdfOf(path.join(dir, 'מכתב א.pdf'), 2, 'Alpha');
  const b = await pdfOf(path.join(dir, 'מכתב ב.pdf'), 3, 'Beta');

  /* ---- the rules ---- */
  console.log('\nwhat a workflow may be');
  const refused = async (spec) => {
    try {
      await workflows.save(spec);
      return '';
    } catch (err) {
      return err.message;
    }
  };
  check('a workflow needs a name', /שם/.test(await refused({ name: ' ', steps: [{ toolId: 'compress' }] })));
  check('  and at least one step', /שלב/.test(await refused({ name: 'x', steps: [] })));
  check('merge can only come first', /איחוד/.test(await refused({ name: 'x', steps: [{ toolId: 'compress' }, { toolId: 'merge' }] })));
  check('split or a conversion can only come last', /האחרון/.test(await refused({ name: 'x', steps: [{ toolId: 'pdf-to-word' }, { toolId: 'compress' }] })));
  check('protecting with a password can only come last, since nothing after could open the file', /האחרון/.test(await refused({ name: 'x', steps: [{ toolId: 'protect' }, { toolId: 'compress' }] })));
  check('removing a password can only come first', /הראשון/.test(await refused({ name: 'x', steps: [{ toolId: 'compress' }, { toolId: 'unlock' }] })));
  check('a tool that needs pointing at the page is not a step', /לשרשר/.test(await refused({ name: 'x', steps: [{ toolId: 'redact' }] })));

  const send = await workflows.save({
    name: 'מוכן לשליחה',
    steps: [
      { toolId: 'compress', options: { level: 'strong' } },
      { toolId: 'page-numbers', options: { format: 'n', position: 'bottom-center' } },
      { toolId: 'protect', options: { password: 'should-not-be-saved', allowPrint: true } },
    ],
  });
  const saved = fs.readFileSync(workflows.storeFile(), 'utf8');
  check('a saved workflow keeps its steps and options, but never a password', saved.includes('"page-numbers"') && saved.includes('allowPrint') && !saved.includes('should-not-be-saved'));
  const tile = (await tools.list()).find((t) => t.id === `wf:${send.id}`);
  check('it appears as a tile of its own, saying its steps', tile && tile.group === 'workflows' && tile.name === 'מוכן לשליחה' && /כיווץ PDF ← מספרי עמודים ← הגנה בסיסמה/.test(tile.description), tile && tile.description);

  /* ---- running ---- */
  console.log('\nrunning');
  const before = new Set(fs.readdirSync(dir));
  let r = await jobs.start(tools.runnable(`wf:${send.id}`), [a, b], { name: send.name, steps: send.steps, secrets: { 2: { password: 'רון123' } } }).promise;
  const made = fs.readdirSync(dir).filter((n) => !before.has(n));
  check('each file goes through every step, and only the final result is written', r.ok && made.sort().join('|') === 'מכתב א - מוכן לשליחה.pdf|מכתב ב - מוכן לשליחה.pdf', r.error || made.join(' | '));
  const qpdf = bin.locate('qpdf');
  let numbered = '';
  if (r.ok) {
    const open = path.join(dir, 'opened.pdf');
    const needs = (() => { try { execFileSync(qpdf, ['--requires-password', r.display[1]]); return 0; } catch (e) { return e.status; } })();
    check('  the result is protected with the password given at run time', needs === 0);
    execFileSync(qpdf, ['--decrypt', '--password=רון123', '--', r.display[1], open]);
    numbered = (await text.documentText(open)).map((p) => p.replace(/\s+/g, ' ')).join(' | ');
    fs.rmSync(open);
  }
  check('  with page numbers on every page of the file', /Beta 1.*\b1\b.*\|.*Beta 2.*\b2\b.*\|.*Beta 3.*\b3\b/.test(numbered), numbered);
  check('  and the summary names the chain', /כיווץ PDF ← מספרי עמודים ← הגנה בסיסמה/.test(r.summary || ''), r.summary);

  const merged = await workflows.save({ name: 'תיק אחד', steps: [{ toolId: 'merge' }, { toolId: 'page-numbers', options: { format: 'page-n-of' } }] });
  r = await jobs.start(tools.runnable(`wf:${merged.id}`), [a, b], { name: merged.name, steps: merged.steps }).promise;
  const one = r.ok && r.display.length === 1 ? (await PDFDocument.load(await fsp.readFile(r.display[0]))).getPageCount() : 0;
  check('a workflow starting with merge makes one file of all of them', r.ok && one === 5 && path.basename(r.display[0]) === 'מכתב א - תיק אחד.pdf', r.error || r.display);
  check('  and the next step sees that one file: "of 5" on its pages', r.ok && (await text.documentText(r.display[0]))[4].includes('עמוד 5 מתוך 5'));

  const toWord = await workflows.save({ name: 'לוורד', steps: [{ toolId: 'rotate', options: { angle: 180 } }, { toolId: 'pdf-to-markdown' }] });
  r = await jobs.start(tools.runnable(`wf:${toWord.id}`), [a], { name: toWord.name, steps: toWord.steps }).promise;
  check('a conversion as the last step writes its own kind of file', r.ok && /\.md$/.test(r.display[0]) && fs.readFileSync(r.display[0], 'utf8').includes('Alpha 1'), r.error || r.display);

  let jobId = null;
  const beforeCancel = fs.readdirSync(dir).sort().join('|');
  const cancelled = jobs.start(tools.runnable(`wf:${send.id}`), [a, b], { name: send.name, steps: send.steps, secrets: { 2: { password: 'x' } } }, { onProgress: (p) => { if (/מספרי עמודים/.test(p.text)) jobs.cancel(jobId); } });
  jobId = cancelled.id;
  const c = await cancelled.promise;
  check('Esc in the middle of a workflow stops it and leaves nothing behind', c.cancelled && fs.readdirSync(dir).sort().join('|') === beforeCancel);

  /* ---- the screens ---- */
  console.log('\nthe screens');
  registerIpc();
  const win = await openWindow();
  const page = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page(code)) return true;
      await page('new Promise(r => setTimeout(r, 80))');
    }
    return false;
  };
  await page(`window.shell.goHome()`);
  check('the saved workflows are tiles in their group', (await page(`document.querySelectorAll('.tile[data-tool^="wf:"]').length`)) === 3);
  await page(`document.querySelector('.tile[data-tool="workflow"]').click()`);
  await until(`document.body.dataset.screen === 'workflow'`);
  check('"new workflow" opens the builder', (await page(`document.getElementById('screen-name').textContent`)) === 'תהליך עבודה חדש');
  const add = (id) => page(`(() => { const s = document.getElementById('wf-add-tool'); s.value = '${id}'; document.getElementById('wf-add').click(); return document.querySelectorAll('.wf-step').length; })()`);
  await add('pdf-to-word');
  await add('compress');
  check('a conversion placed before another step is pointed out', /האחרון/.test(await page(`document.getElementById('wf-error').textContent`)));
  await page(`document.querySelector('.wf-step:nth-child(1) button[aria-label="הזז למטה"]').click()`);
  check('  and moving it down clears that', (await page(`document.getElementById('wf-error').textContent`)) === '');
  check('each step shows its tool\'s own options', await page(`!!document.querySelector('.wf-step:nth-child(1) .seg[data-value="strong"]')`));
  await page(`document.querySelector('.wf-step:nth-child(1) .seg[data-value="strong"]').click()`);
  await add('protect');
  check('a protect step before a conversion is pointed out', /האחרון/.test(await page(`document.getElementById('wf-error').textContent`)));
  await page(`document.querySelector('.wf-step:nth-child(2) button[aria-label="הסר שלב"]').click()`);
  check('  and removing the conversion clears that', (await page(`document.getElementById('wf-error').textContent`)) === '');
  check('a protect step says its password is asked each time, and has no password field',
    /תתבקש בכל הפעלה/.test(await page(`document.querySelector('.wf-step:nth-child(2)').textContent`)) && !(await page(`!!document.querySelector('.wf-step:nth-child(2) input[type=password]')`)));
  await page(`document.getElementById('wf-save').click()`);
  check('saving without a name asks for one', /שם/.test(await page(`document.getElementById('wf-error').textContent`)));
  await page(`(() => { document.getElementById('wf-name').value = 'דחיסה והגנה'; document.getElementById('wf-save').click(); return true; })()`);
  await until(`document.body.dataset.screen === 'tool' && document.getElementById('screen-name').textContent === 'דחיסה והגנה'`);
  check('saving opens the new workflow, listing its steps', (await page(`[...document.querySelectorAll('.wf-summary li')].map(l => l.textContent).join(',')`)) === 'כיווץ PDF,הגנה בסיסמה');
  const stored = (await workflows.list()).find((w) => w.name === 'דחיסה והגנה');
  check('  saved with the option chosen in the builder', stored && stored.steps[0].options.level === 'strong');
  await page(`(async () => { const r = await window.api.describeFiles(${JSON.stringify([a])}); window.shell.addFiles(r.files); })()`);
  await until(`document.querySelectorAll('#tool-file-list .file-row').length === 1`);
  check('running waits for the protect step\'s password', /סיסמה/.test(await page(`document.getElementById('tool-blocked').textContent`)));
  await page(`(() => { const p = document.querySelectorAll('#tool-options input[type=password]'); p[0].value = 'סיסמה-ייחודית-77'; p[0].dispatchEvent(new Event('input', { bubbles: true })); p[1].value = 'סיסמה-ייחודית-77'; p[1].dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check('  and is ready once it is typed twice', (await page(`document.getElementById('tool-blocked').textContent`)) === '');
  await page(`document.getElementById('tool-run').click()`);
  await until(`!window.shell.busy() && (!document.getElementById('tool-result').classList.contains('hidden') || !document.getElementById('tool-error').classList.contains('hidden'))`, 120000);
  const out = await page(`(document.querySelector('#tool-result-outputs .out-name') || {}).title || document.getElementById('tool-error').textContent`);
  check('running it from the screen writes the result, named after the workflow', /מכתב א - דחיסה והגנה\.pdf$/.test(out), out);
  const history = fs.readFileSync(runs.storeFile(), 'utf8');
  check('  and the run history records it without the password', history.includes('"wf:') && !history.includes('סיסמה-ייחודית-77'));
  check('no errors in the page console', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 3).join(' / '));

  disposeRenderer();
  require('../src/main/engine/ocr').shutdown();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
