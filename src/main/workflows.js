'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/*
 * Saved workflows: a name and a list of steps, each a tool and its options. They live in
 * the user's app data folder on this PC and appear as tiles of their own.
 *
 * Which tools can be steps, and where: a step takes PDFs and gives one PDF, except the
 * last, which may split or convert (to Word, images, Markdown, a spreadsheet, a summary,
 * a translation). Merge can only
 * come first, since it is what turns several files into one. Tools that need a person to
 * point at things on a page (organize, crop, redact, sign, edit, forms) are not steps.
 * Passwords are never part of a saved step: they are asked for each time it runs.
 */

const STEP_TOOLS = ['merge', 'rotate', 'compress', 'page-numbers', 'watermark', 'ocr', 'pdfa', 'repair', 'protect', 'unlock'];
// These make something other than one PDF (other formats, or several files), so they end a chain.
const LAST_ONLY = ['split', 'pdf-to-word', 'pdf-to-jpg', 'pdf-to-markdown', 'pdf-to-excel', 'pdf-to-ppt', 'summarize', 'translate'];
const SECRET = /password/i;

let override = null;
function setStoreFile(file) {
  override = file;
}
function storeFile() {
  return override || path.join(app.getPath('userData'), 'workflows.json');
}

let queue = Promise.resolve();
const serial = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

async function list() {
  let raw;
  try {
    raw = await fsp.readFile(storeFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed.workflows || []).filter((w) => w && typeof w.id === 'string' && Array.isArray(w.steps));
  } catch {
    throw new Error('קובץ תהליכי העבודה פגום, ולכן לא נשמר בו דבר. התהליכים לא נמחקו.');
  }
}

async function write(workflows) {
  const file = storeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ version: 1, workflows }, null, 2), 'utf8');
  await fsp.rename(temp, file);
}

/** The reason a list of steps cannot be a workflow, or null. */
function problem(steps) {
  if (!Array.isArray(steps) || !steps.length) return 'הוסף לפחות שלב אחד.';
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i] && steps[i].toolId;
    const last = i === steps.length - 1;
    if (LAST_ONLY.includes(id) && !last) return 'פיצול, או המרה לקובץ שאינו PDF, יכולים להיות רק השלב האחרון.';
    if (id === 'merge' && i !== 0) return 'איחוד יכול להיות רק השלב הראשון.';
    // A locked file cannot be opened by the step after it, and a file must be unlocked
    // before anything else can read it.
    if (id === 'protect' && !last) return 'הגנה בסיסמה יכולה להיות רק השלב האחרון: אחריה אף כלי לא יוכל לפתוח את הקובץ.';
    if (id === 'unlock' && i !== 0) return 'הסרת סיסמה יכולה להיות רק השלב הראשון.';
    // A locked file cannot be opened by the step after it, and a file must be unlocked
    // before anything else can read it.
    if (id === 'protect' && !last) return 'הגנה בסיסמה יכולה להיות רק השלב האחרון: אחריה אף כלי לא יוכל לפתוח את הקובץ.';
    if (id === 'unlock' && i !== 0) return 'הסרת סיסמה יכולה להיות רק השלב הראשון.';
    if (!STEP_TOOLS.includes(id) && !LAST_ONLY.includes(id)) return 'אחד השלבים אינו כלי שאפשר לשרשר.';
  }
  return null;
}

/** Options as saved: passwords left out. */
function stored(steps) {
  return steps.map((s) => ({
    toolId: s.toolId,
    options: Object.fromEntries(Object.entries(s.options || {}).filter(([k]) => !SECRET.test(k))),
  }));
}

function save({ id, name, steps }) {
  return serial(async () => {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('תן שם לתהליך.');
    const why = problem(steps);
    if (why) throw new Error(why);
    const all = await list();
    const entry = { id: id || crypto.randomBytes(6).toString('hex'), name: clean.slice(0, 60), steps: stored(steps), savedAt: new Date().toISOString() };
    const rest = all.filter((w) => w.id !== entry.id);
    await write([...rest, entry]);
    return entry;
  });
}

function remove(id) {
  return serial(async () => {
    await write((await list()).filter((w) => w.id !== id));
    return true;
  });
}

module.exports = { list, save, remove, problem, STEP_TOOLS, LAST_ONLY, setStoreFile, storeFile };
