'use strict';

const fs = require('fs/promises');
const path = require('path');

const claude = require('../engine/claude');
const text = require('../pdf/text');
const { wordFromMarkdown } = require('../pdf/docx');
const { loadPdf } = require('../pdf/inspect');
const { sendableParts, fits } = require('../pdf/sendable');

/*
 * AI Summarizer: a summary of a document, written by Claude, saved as a Word file.
 *
 * The PDF itself is sent, so Claude reads its layout, tables and scanned pages as well
 * as its text. A file too large to send at once (over the request limit once encoded, or
 * 550 pages) is sent in parts of up to 100 pages, each small enough to send, each part
 * summarised, and the summaries combined. An answer that was cut off is never saved as a
 * summary.
 *
 * The document leaves this PC for Anthropic's servers for this one request; the screen
 * says so before the button is pressed, and the tool is off until a key is entered.
 */

const MAX_PAGES = 550;
const PART_PAGES = 100;

const LENGTH = {
  short: 'עד כחצי עמוד: הנקודות החשובות ביותר בלבד.',
  standard: 'כעמוד אחד.',
  detailed: 'מפורט, כמה עמודים לפי הצורך, בלי להשמיט עובדות מהותיות.',
};

const FOCUS = {
  facts: 'העובדות העיקריות',
  parties: 'הצדדים ותפקידם',
  dates: 'תאריכים ומועדים, בסדר כרונולוגי',
  amounts: 'סכומים, אחוזים ונתונים כספיים',
  claims: 'הטענות והטיעונים של כל צד',
  deadlines: 'מועדים אחרונים ופעולות נדרשות',
};

function systemPrompt({ length, language, focus }) {
  const lang = language === 'en' ? 'English' : 'Hebrew';
  const wanted = (focus && focus.length ? focus : Object.keys(FOCUS)).map((k) => FOCUS[k]).filter(Boolean);
  return [
    'You summarise documents for an Israeli law office: pleadings, decisions, medical opinions, contracts and correspondence.',
    `Write the summary in ${lang}.`,
    `Length: ${LENGTH[length] || LENGTH.standard}`,
    `Cover, each under its own short heading where it applies: ${wanted.join('; ')}.`,
    'Be exact: names, ID numbers, dates, sums and section numbers are written exactly as they appear in the document. Do not add facts, opinions or legal advice that are not in it. If something is unclear or illegible, say so rather than guessing.',
    'Format: Markdown, with "##" headings and "-" bullet points. No introduction and no closing remarks.',
  ].join('\n');
}

async function documentBlock(bytes) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } };
}

/** The answer's text, or, if it was cut off, an error: half a summary is not a summary. */
function whole(r, what) {
  if (r.truncated) throw new Error(`הסיכום של ${what} נקטע באמצע, ולכן לא נשמר. נסה אורך סיכום קצר יותר, או פצל את הקובץ לחלקים.`);
  return r.text;
}

async function run({ inputs, options = {}, ctx }) {
  const source = inputs[0];
  const name = path.basename(source);
  const bytes = await fs.readFile(source);
  const doc = await loadPdf(source);
  const pages = doc.getPageCount();
  const system = systemPrompt(options);

  let markdown;
  if (fits(bytes) && pages <= MAX_PAGES) {
    ctx.progress(0.1, 'שולח ל-Claude ומחכה לסיכום… זה יכול לקחת דקה או שתיים.');
    const r = await claude.ask({ system, content: [await documentBlock(bytes), { type: 'text', text: `סכם את המסמך "${name}".` }], signal: ctx.signal });
    markdown = whole(r, 'המסמך');
  } else {
    const parts = [];
    let n = 0;
    for await (const { from, to, bytes: part } of sendableParts(doc, PART_PAGES, name)) {
      ctx.throwIfCancelled();
      n++;
      ctx.progress(0.05 + (from / pages) * 0.75, `מסכם את עמודים ${from + 1}-${to} מתוך ${pages}…`);
      const r = await claude.ask({ system, content: [await documentBlock(part), { type: 'text', text: `זהו חלק ${n} של המסמך "${name}" (עמודים ${from + 1}-${to}). סכם את החלק הזה.` }], signal: ctx.signal });
      parts.push(`## עמודים ${from + 1}-${to}\n\n${whole(r, `עמודים ${from + 1}-${to}`)}`);
    }
    ctx.progress(0.85, 'מאחד את הסיכומים…');
    const r = await claude.ask({ system, content: [{ type: 'text', text: `אלה סיכומים של חלקי המסמך "${name}", לפי סדר העמודים. כתוב מהם סיכום אחד של המסמך כולו.\n\n${parts.join('\n\n')}` }], signal: ctx.signal });
    markdown = whole(r, 'המסמך כולו');
  }
  ctx.throwIfCancelled();
  if (!markdown.trim()) throw new Error('Claude לא החזיר סיכום. נסה שוב.');

  ctx.progress(0.95, 'שומר את הסיכום…');
  const title = `סיכום: ${name.replace(/\.pdf$/i, '')}`;
  const out = await ctx.writeOutput(await wordFromMarkdown(markdown, { rtl: options.language !== 'en', title }), { source, label: 'סיכום', ext: 'docx' });
  return {
    summary: `הסיכום מוכן, כקובץ Word ליד המקור. הוא נכתב על ידי Claude: כדאי לבדוק שמות, תאריכים וסכומים מול המסמך עצמו.`,
    display: [out],
    text: markdown,
  };
}

module.exports = { run, availability: () => claude.availability(), systemPrompt };
