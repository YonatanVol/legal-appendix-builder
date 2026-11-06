'use strict';

/**
 * Summarize and Translate, against a local stand-in for Anthropic's API on the loopback
 * address. That checks what is actually sent (model, fallback setting, the PDF itself)
 * and what is made of the answer, with no key, no cost and no document leaving the
 * machine. The network fence is checked too: the AI session reaches the API host and
 * nothing else, and the document session still reaches nothing.
 * Launch with:  npx electron test/ai.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, session } = require('electron');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
const { openWindow } = require('./helpers/window');

const results = [];
function check(label, condition, detail = '') {
  results.push({ pass: !!condition });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

/* ---- the stand-in ---- */
const seen = [];
let mode = 'ok';
let delayMs = 0;
let checkDelayMs = 0;
const ANSWER = '## עובדות\n- המערער **איתי ליבן** ערער על החלטת הוועדה מיום 07/07/2026.\n\n## סכומים\n| פריט | סכום |\n|---|---|\n| שכר טרחה | 1,250 |';

function sse(res, text, stop = 'end_turn') {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 40) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: null, explanation: '' } } : {}) }, usage: { output_tokens: 50 } });
  send('message_stop', {});
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const key = req.headers['x-api-key'];
    if (key && key.includes('rejected') && checkDelayMs) {
      const wait = checkDelayMs;
      checkDelayMs = 0;
      return setTimeout(() => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }, wait);
    }
    if (key && key.includes('rejected')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5' }));
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const json = JSON.parse(body);
      seen.push({ headers: req.headers, body: json, size: Buffer.byteLength(body) });
      const doc = json.messages[0].content.find((c) => c.type === 'document');
      const go = () => {
        if (mode === 'refusal') return sse(res, '', 'refusal');
        if (mode === 'max_tokens' || mode === 'model_context_window_exceeded') return sse(res, '## עובדות\n- המערער ערער על', mode);
        if (/^Translate/.test(json.system)) {
          const first = Number((/first page of this part is page (\d+)/.exec(JSON.stringify(json)) || [])[1] || 1);
          return sse(res, `<!-- page ${first} -->\n## Decision\nThe committee accepted the appeal in part on 07/07/2026.\n\n- Fee: 1,250`);
        }
        return sse(res, doc ? ANSWER : `## סיכום משולב\n- ${json.messages[0].content[0].text.length} תווים של סיכומים`);
      };
      return delayMs ? setTimeout(go, delayMs) : go();
    }
    res.writeHead(404);
    res.end();
  });
});

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.OFFICE_AI_TEST_BASE = base;
  // What the SDK would otherwise take from the environment: none of it may be used.
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-from-environment: yes\nx-api-key: key-from-environment\nanthropic-version: 1999-01-01';
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-environment';
  process.env.ANTHROPIC_BASE_URL = 'http://192.0.2.1:9';

  const { lockDownNetwork } = require('../src/main/security');
  lockDownNetwork();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-'));
  const settings = require('../src/main/settings');
  settings.setStoreFile(path.join(dir, 'settings.json'));
  require('../src/main/runs').setStoreFile(path.join(dir, 'runs.json'));
  const jobs = require('../src/main/jobs');
  const tools = require('../src/main/tools');
  const text = require('../src/main/pdf/text');
  const claude = require('../src/main/engine/claude');
  const runTool = (id, inputs, options = {}, hooks) => jobs.start(tools.runnable(id), inputs, options, hooks).promise;

  const pdfOf = async (file, pages) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 18, font });
    await fsp.writeFile(file, await doc.save());
    return file;
  };
  const decision = await pdfOf(path.join(dir, 'החלטה.pdf'), 3);

  /* ---- off until a key ---- */
  console.log('\nthe key');
  let listed = await tools.list();
  const tile = listed.find((t) => t.id === 'summarize');
  check('without a key, both AI tiles are off and say how to turn them on', !tile.available && /בהגדרות/.test(tile.reason) && !listed.find((t) => t.id === 'translate').available, tile.reason);
  let err = null;
  try { await settings.setApiKey('hello'); } catch (e) { err = e; }
  check('something that is not a key is refused, saying what a key looks like', err && /sk-ant-/.test(err.message), err && err.message);
  const realKey = 'sk-ant-api03-TESTKEY0123456789abcdefghijklmnopqrstuv';
  const hint = await settings.setApiKey(realKey);
  const stored = fs.readFileSync(settings.storeFile(), 'utf8');
  check('a key is stored encrypted: the file never holds it in the clear', !stored.includes('TESTKEY0123456789') && hint.endsWith('stuv') && hint.length < 20, hint);
  check('  and it reads back intact', (await settings.getApiKey()) === realKey);
  listed = await tools.list();
  check('with a key, the tiles are on', listed.find((t) => t.id === 'summarize').available && listed.find((t) => t.id === 'translate').available);

  /* ---- summarize ---- */
  console.log('\nSummarize');
  let r = await runTool('summarize', [decision], { length: 'short', language: 'he', focus: ['facts', 'amounts'] });
  const sent = seen[seen.length - 1];
  check('the summary is written as a Word file beside the document', r.ok && r.display[0] === path.join(dir, 'החלטה - סיכום.docx'), r.error || r.display);
  check('the request uses Claude Opus 5.5 with the server-side fallback on', sent && sent.body.model === 'claude-opus-5-5' && sent.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(sent.headers['anthropic-beta'] || ''), sent && `${sent.body.model} ${sent.body.fallbacks} ${sent.headers['anthropic-beta']}`);
  check('  with only the office\'s key: no headers or token taken from the environment, and not sent elsewhere',
    sent && sent.headers['x-api-key'] === realKey && sent.headers['anthropic-version'] === '2023-06-01' && !sent.headers['x-from-environment'] && !sent.headers.authorization, sent && Object.keys(sent.headers).join(','));
  const docBlock = sent && sent.body.messages[0].content.find((c) => c.type === 'document');
  check('  the PDF itself is sent, unchanged', docBlock && Buffer.from(docBlock.source.data, 'base64').equals(await fsp.readFile(decision)));
  check('  and the instructions ask for Hebrew, short, and only the chosen topics', /Hebrew/.test(sent.body.system) && /חצי עמוד/.test(sent.body.system) && /סכומים/.test(sent.body.system) && !/הצדדים ותפקידם/.test(sent.body.system));
  const xml = r.ok ? execFileSync('tar', ['-xOf', r.display[0], 'word/document.xml'], { encoding: 'utf8' }) : '';
  check('the Word file holds the answer with its headings, bold names and table, right to left',
    xml.includes('עובדות') && xml.includes('איתי ליבן') && /<w:b\/>/.test(xml) && /<w:tbl>/.test(xml) && /<w:bidi\/>/.test(xml), xml.slice(0, 120));
  check('  and the summary on screen says to check it against the document', /לבדוק/.test(r.summary || ''), r.summary);

  const big = await pdfOf(path.join(dir, 'ארוך.pdf'), 560);
  const before = seen.length;
  r = await runTool('summarize', [big], {});
  check('a document too long for one request is summarised in parts, then combined', r.ok && seen.length - before === 7, `${seen.length - before} requests: ${r.error || ''}`);

  mode = 'refusal';
  r = await runTool('summarize', [decision], {});
  check('a refusal from every model is said plainly, and nothing is written', !r.ok && /סירב/.test(r.error) && !fs.existsSync(path.join(dir, 'החלטה - סיכום (2).docx')), r.error);
  mode = 'ok';

  for (const stop of ['max_tokens', 'model_context_window_exceeded']) {
    mode = stop;
    r = await runTool('summarize', [decision], {});
    check(`a summary cut off (${stop}) is not saved as a summary, and the screen says it was cut off`,
      !r.ok && /נקטע/.test(r.error || '') && !fs.existsSync(path.join(dir, 'החלטה - סיכום (2).docx')), r.error || r.summary);
    r = await runTool('translate', [decision], { target: 'en' });
    check(`  nor a translation cut off (${stop})`, !r.ok && /נקטע/.test(r.error || '') && !fs.existsSync(path.join(dir, 'החלטה - תרגום לאנגלית.docx')), r.error || r.summary);
  }
  mode = 'ok';
  const partsBefore = seen.length;
  r = await runTool('summarize', [big], {});
  mode = 'max_tokens';
  // (one part cut off in a long document: the whole summary is refused)
  const cutPart = await runTool('summarize', [big], {});
  mode = 'ok';
  check('  and in a long document, a part summary cut off refuses the whole summary', r.ok && !cutPart.ok && /נקטע/.test(cutPart.error || '') && seen.length > partsBefore, cutPart.error);

  // Heavy scans: a request carries the PDF as base64, a third larger, and may be at most
  // 32 MB. Five pages of 5 MB each make a 25 MB file, under 32 MB but not once encoded.
  console.log('\nlarge files');
  const heavy = await PDFDocument.create();
  const noise = (n) => { let x = ''; const chunk = require('crypto').randomBytes(Math.ceil(n * 0.75)).toString('base64'); x = chunk.slice(0, n); return x; };
  for (let i = 0; i < 5; i++) {
    const page = heavy.addPage([595, 842]);
    const fill = heavy.context.register(heavy.context.stream(`% ${noise(5 * 1024 * 1024)}\nBT /F1 18 Tf 60 760 Td (Page ${i + 1}) Tj ET`));
    page.node.set(PDFName.of('Contents'), fill);
  }
  const heavyFile = path.join(dir, 'סריקות כבדות.pdf');
  await fsp.writeFile(heavyFile, await heavy.save({ useObjectStreams: false }));
  const heavySize = fs.statSync(heavyFile).size;
  for (const id of ['summarize', 'translate']) {
    const from = seen.length;
    r = await runTool(id, [heavyFile], { target: 'en' });
    const sentNow = seen.slice(from);
    const docs = sentNow.map((x) => x.body.messages[0].content.find((c) => c.type === 'document')).filter(Boolean);
    let covered = 0;
    for (const d of docs) covered += (await PDFDocument.load(Buffer.from(d.source.data, 'base64'))).getPageCount();
    check(`${id}: a ${Math.round(heavySize / 1048576)} MB file is sent in parts each under 32 MB as sent, covering every page once`,
      r.ok && heavySize > 24 * 1048576 && sentNow.every((x) => x.size <= 32 * 1000 * 1000) && covered === 5 && docs.length > 1,
      `${r.error || ''} sizes ${sentNow.map((x) => Math.round(x.size / 1048576)).join(',')} MB, pages ${covered}`);
  }
  // Two ordinary pages, then one too large to send: found before anything is sent.
  const huge = await PDFDocument.create();
  huge.addPage([595, 842]);
  huge.addPage([595, 842]);
  huge.addPage([595, 842]).node.set(PDFName.of('Contents'), huge.context.register(huge.context.stream(`% ${noise(24 * 1024 * 1024)}`)));
  const hugeFile = path.join(dir, 'עמוד ענק.pdf');
  await fsp.writeFile(hugeFile, await huge.save({ useObjectStreams: false }));
  const beforeHuge = seen.length;
  r = await runTool('summarize', [hugeFile], {});
  check('  a page too large to send is said so, with the way out (compress), before any part is sent', !r.ok && /עמוד 3/.test(r.error || '') && /גדול מדי/.test(r.error || '') && /כיווץ/.test(r.error || '') && seen.length === beforeHuge, `${r.error} (${seen.length - beforeHuge} sent)`);
  const beforeHugeT = seen.length;
  r = await runTool('translate', [hugeFile], { target: 'en' });
  check('  in Translate too', !r.ok && /עמוד 3/.test(r.error || '') && seen.length === beforeHugeT, `${r.error} (${seen.length - beforeHugeT} sent)`);

  delayMs = 4000;
  let jobId = null;
  const slow = jobs.start(tools.runnable('summarize'), [decision], {}, { onProgress: () => { setTimeout(() => jobs.cancel(jobId), 300); } });
  jobId = slow.id;
  r = await slow.promise;
  check('Esc while waiting for Claude cancels the request', r.cancelled === true, r.error);
  delayMs = 0;

  /* ---- translate ---- */
  console.log('\nTranslate');
  const twenty = await pdfOf(path.join(dir, 'עשרים.pdf'), 20);
  const t0 = seen.length;
  r = await runTool('translate', [twenty], { target: 'en' });
  const parts = seen.slice(t0);
  check('the document is sent in parts of up to 15 pages', r.ok && parts.length === 2 &&
    (await PDFDocument.load(Buffer.from(parts[0].body.messages[0].content[0].source.data, 'base64'))).getPageCount() === 15 &&
    (await PDFDocument.load(Buffer.from(parts[1].body.messages[0].content[0].source.data, 'base64'))).getPageCount() === 5, r.error);
  check('  each asking for a complete, faithful translation into the chosen language', parts.every((p) => /into English, completely and faithfully/.test(p.body.system)));
  const outPdf = r.ok && r.display.find((p) => p.endsWith('.pdf'));
  const outText = outPdf ? (await text.documentText(outPdf)) : [];
  check('a Word file and a PDF are written, the PDF reading as English, one section per part', r.ok && r.display.length === 2 && outText.length === 2 &&
    outText[0].includes('The committee accepted the appeal in part on 07/07/2026.'), outText.map((p) => p.slice(0, 40)).join(' | '));
  r = await runTool('translate', [decision], { target: 'he' });
  const heXml = r.ok ? execFileSync('tar', ['-xOf', r.display.find((p) => p.endsWith('.docx')), 'word/document.xml'], { encoding: 'utf8' }) : '';
  check('a translation into Hebrew is set right to left', /<w:bidi\/>/.test(heXml), r.error);

  /* ---- the fence ---- */
  console.log('\nthe network fence');
  const ai = claude.sessionFor();
  const attempt = async (ses, url) => ses.fetch(url).then(() => 'reached').catch(() => 'blocked');
  // Controls: a session with no rule must reach the same places, or a "blocked" below
  // would only mean this machine has no network.
  const open = session.fromPartition('control-no-rules');
  const other = http.createServer((q, s) => s.end('x'));
  await new Promise((res) => other.listen(0, '127.0.0.1', res));
  const otherUrl = `http://127.0.0.1:${other.address().port}/`;
  check('(control) a session without the rule reaches a local address', (await attempt(open, otherUrl)) === 'reached');
  const internet = (await attempt(open, 'https://example.com/')) === 'reached';
  check('the AI session cannot reach another local address than the test stand-in', (await attempt(ai, otherUrl)) === 'blocked');
  if (internet) check('  nor any other host on the internet, which this machine can reach', (await attempt(ai, 'https://example.com/')) === 'blocked');
  else console.log('  (skipped: this machine has no internet, so the internet check would prove nothing)');
  other.close();
  check('  nor Anthropic over plain HTTP', (await attempt(ai, 'http://api.anthropic.com/')) === 'blocked');
  check('the document session still reaches nothing, Anthropic included', (await attempt(session.defaultSession, 'https://api.anthropic.com/v1/models')) === 'blocked');
  const { isAllowedForAi } = require('../src/main/security');
  check('the rule itself allows exactly https://api.anthropic.com', isAllowedForAi('https://api.anthropic.com/v1/messages') && !isAllowedForAi('https://api.anthropic.com.evil.test/') && !isAllowedForAi('https://evil.test/?https://api.anthropic.com'));

  /* ---- the screens ---- */
  console.log('\nthe settings screen');
  await settings.clearApiKey();
  require('../src/main/ipc').registerIpc();
  const win = await openWindow();
  const page = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page(code)) return true;
      await page('new Promise(r => setTimeout(r, 80))');
    }
    return false;
  };
  await page(`(async () => { const r = await window.api.describeFiles(${JSON.stringify([decision])}); window.shell.open('summarize', { files: r.files }); })()`);
  check('the Summarize screen, with no key, says it is off and offers the way to settings',
    await page(`!document.getElementById('tool-unavailable').classList.contains('hidden') && !!document.querySelector('#tool-unavailable button')`));
  check('  and says before anything runs that the document goes to Anthropic', /Anthropic/.test(await page(`document.querySelector('.cloud-notice').textContent`)));
  await page(`document.querySelector('#tool-unavailable button').click()`);
  await until(`document.body.dataset.screen === 'settings'`);
  const typeKey = (k) => page(`(() => { document.getElementById('settings-key').value = ${JSON.stringify(k)}; document.getElementById('settings-save').click(); return true; })()`);
  await typeKey('sk-ant-api03-rejected0000000000000000000000000');
  await until(`/שגוי/.test(document.getElementById('settings-result').textContent)`);
  check('a key Anthropic rejects is not kept, and the screen says why', /שגוי/.test(await page(`document.getElementById('settings-result').textContent`)) && !(await settings.apiKeyHint()));
  await typeKey(realKey);
  await until(`/נשמר ונבדק/.test(document.getElementById('settings-result').textContent)`);
  check('a good key is checked, saved, and shown only as a hint', /stuv/.test(await page(`document.getElementById('settings-status').textContent`)) &&
    !(await page(`document.body.innerText`)).includes('TESTKEY0123456789'));
  check('  and the field is emptied after saving', (await page(`document.getElementById('settings-key').value`)) === '');
  await typeKey('sk-ant-api03-rejected1111111111111111111111111');
  await until(`/שגוי/.test(document.getElementById('settings-result').textContent)`);
  check('a mistyped new key is refused, and the key that worked before stays saved', (await settings.getApiKey()) === realKey && /stuv/.test(await settings.apiKeyHint() || ''), await settings.apiKeyHint());
  // The key removed while a new one is being checked stays removed when the new one is refused.
  checkDelayMs = 1500;
  await page(`document.getElementById('settings-result').textContent = ''`);
  await typeKey('sk-ant-api03-rejected2222222222222222222222222');
  await new Promise((res) => setTimeout(res, 300));
  await settings.clearApiKey();
  await until(`/שגוי/.test(document.getElementById('settings-result').textContent)`);
  check('  a key removed while a new one was being checked stays removed', !(await settings.getApiKey()), await settings.apiKeyHint());
  await typeKey(realKey);
  await until(`/נשמר ונבדק/.test(document.getElementById('settings-result').textContent)`);
  await page(`window.shell.goHome()`);
  check('the AI tiles are on afterwards without a restart', !(await page(`document.querySelector('.tile[data-tool="summarize"]').classList.contains('unavailable')`)));
  const store = fs.existsSync(require('../src/main/runs').storeFile()) ? fs.readFileSync(require('../src/main/runs').storeFile(), 'utf8') : '';
  check('the key never reaches the run history', !store.includes('TESTKEY'));
  check('no errors in the page console', win.consoleErrors.length === 0, win.consoleErrors.slice(0, 3).join(' / '));

  server.close();
  require('../src/main/pdf/render').disposeRenderer();
  await fsp.rm(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
