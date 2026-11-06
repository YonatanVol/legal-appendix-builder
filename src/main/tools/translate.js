'use strict';

const fs = require('fs/promises');
const path = require('path');

const claude = require('../engine/claude');
const { wordFromMarkdown } = require('../pdf/docx');
const { parse, runs } = require('../pdf/markdown');
const { loadPdf } = require('../pdf/inspect');
const { sendableParts } = require('../pdf/sendable');
const { renderHtmlToPdf } = require('../pdf/render');
const { FONT_FACES, FONT_STACK, escapeHtml } = require('../templates');

/*
 * Translate PDF: the document translated by Claude, saved as a Word file and a PDF.
 *
 * The PDF is sent in parts of up to 15 pages, each small enough to send (a part of heavy
 * scans is halved until it is), so even a long document fits and each part's translation
 * is complete. The layout is not kept page for page: the result is
 * the document's text, with its headings, lists and tables, in the other language. The
 * screen says so before the button is pressed.
 */

const LANGUAGES = {
  en: { name: 'English', label: 'אנגלית', rtl: false },
  he: { name: 'Hebrew', label: 'עברית', rtl: true },
  ar: { name: 'Arabic', label: 'ערבית', rtl: true },
  ru: { name: 'Russian', label: 'רוסית', rtl: false },
  fr: { name: 'French', label: 'צרפתית', rtl: false },
  es: { name: 'Spanish', label: 'ספרדית', rtl: false },
  de: { name: 'German', label: 'גרמנית', rtl: false },
  am: { name: 'Amharic', label: 'אמהרית', rtl: false },
};
const PART_PAGES = 15;

function systemPrompt(target) {
  return [
    `Translate the document into ${target.name}, completely and faithfully, for an Israeli law office.`,
    'Translate every part of it in order: headings, body text, tables, footnotes, stamps and handwritten notes you can read. Do not summarise, shorten, explain or add anything.',
    'Names of people and places are transliterated; ID numbers, case numbers, dates, sums and section numbers are kept exactly. Legal terms are rendered with their accepted equivalent in the target language.',
    'If a passage cannot be read, write [illegible] in its place.',
    'Format: Markdown. Use "##" for headings, "-" for lists and pipe tables for tables. Start each page of the original with a line "<!-- page N -->". Output only the translation.',
  ].join('\n');
}

async function run({ inputs, options = {}, ctx }) {
  const target = LANGUAGES[options.target] || LANGUAGES.en;
  const source = inputs[0];
  const name = path.basename(source);
  const doc = await loadPdf(source);
  const pages = doc.getPageCount();
  const chunks = [];
  for await (const { from, to, bytes } of sendableParts(doc, PART_PAGES, name)) {
    ctx.throwIfCancelled();
    ctx.progress(0.05 + (from / pages) * 0.8, `מתרגם את עמודים ${from + 1}-${to} מתוך ${pages}… זה יכול לקחת כמה דקות.`);
    const r = await claude.ask({
      system: systemPrompt(target),
      maxTokens: 64000,
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
        { type: 'text', text: `Translate pages ${from + 1}-${to} of "${name}". The first page of this part is page ${from + 1}.` },
      ],
      signal: ctx.signal,
    });
    if (r.truncated) throw new Error(`התרגום של עמודים ${from + 1}-${to} נקטע באמצע, כנראה כי הם צפופים מאוד. פצל את הקובץ לחלקים קטנים יותר ונסה שוב.`);
    chunks.push(r.text.trim());
  }
  ctx.throwIfCancelled();
  const markdown = chunks.join('\n\n');
  const plain = markdown.replace(/<!--\s*page\s+\d+\s*-->/g, '');

  ctx.progress(0.9, 'שומר את התרגום…');
  const label = `תרגום ל${target.label}`;
  const word = await ctx.writeOutput(await wordFromMarkdown(plain, { rtl: target.rtl }), { source, label, ext: 'docx' });
  const html = htmlFor(markdown, target.rtl);
  const pdf = await renderHtmlToPdf(html, { width: 595.28, height: 841.89 }, { top: 60, bottom: 60, left: 60, right: 60 });
  const pdfOut = await ctx.writeOutput(pdf.bytes, { source, label, ext: 'pdf' });
  return {
    summary: `התרגום ל${target.label} מוכן, כקובץ Word וכ-PDF. הוא נכתב על ידי Claude, והעיצוב פשוט מהמקור: כדאי שמי שקורא את השפה יעבור עליו לפני שימוש.`,
    display: [word, pdfOut],
  };
}

/** The translation as a printable page: each original page starts a new one. */
function htmlFor(markdown, rtl) {
  const inline = (t) => runs(t).map((r) => (r.bold ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text))).join('');
  const sections = markdown.split(/<!--\s*page\s+\d+\s*-->/).map((s) => s.trim()).filter(Boolean);
  const body = sections.map((section) => {
    let html = '';
    let list = null;
    const close = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    for (const b of parse(section)) {
      if (b.type === 'li' || b.type === 'ol') {
        const tag = b.type === 'li' ? 'ul' : 'ol';
        if (list !== tag) { close(); html += `<${tag}>`; list = tag; }
        html += `<li>${inline(b.text)}</li>`;
        continue;
      }
      close();
      if (b.type === 'h') html += `<h${b.level + 1}>${inline(b.text)}</h${b.level + 1}>`;
      else if (b.type === 'table') html += `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('')}</tr>`).join('')}</table>`;
      else if (b.type === 'p') html += `<p>${inline(b.text)}</p>`;
    }
    close();
    return `<section>${html}</section>`;
  }).join('');
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
${FONT_FACES}
  body { font-family: ${FONT_STACK}; font-size: 12.5pt; line-height: 1.5; color: #000; }
  section + section { break-before: page; }
  h2, h3, h4, h5 { margin: 1em 0 .4em; }
  table { border-collapse: collapse; width: 100%; margin: .6em 0; }
  td, th { border: 1px solid #888; padding: 4px 6px; vertical-align: top; }
  p { margin: 0 0 .6em; }
</style></head><body>${body}</body></html>`;
}

module.exports = { run, availability: () => claude.availability(), LANGUAGES, systemPrompt };
