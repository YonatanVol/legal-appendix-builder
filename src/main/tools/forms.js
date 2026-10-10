'use strict';

const fs = require('fs/promises');
const {
  PDFDocument, PDFName, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  PDFSignature, PDFButton, TextAlignment, degrees,
} = require('pdf-lib');

const { loadPdf } = require('../pdf/inspect');
const { visualFrame, embedStamps } = require('../pdf/stamp');

const HEBREW = /[֐-׿]/;

/**
 * PDF Forms: fill the fields a form has, add new ones, and optionally flatten.
 *
 * options.values   { fieldName: value }: text, true/false for a checkbox, the option
 *                  for a radio group, dropdown or list
 * options.create   [{ type: 'text'|'checkbox'|'dropdown'|'signature', name, page, x, y,
 *                     w, h, options? }]: new fields, in fractions of the page as shown
 * options.flatten  turn the filled fields into ordinary page content
 *
 * Text is drawn by Chromium and used as each field's appearance, so a Hebrew value reads
 * correctly in every viewer: pdf-lib's own appearances use a font with no Hebrew in it.
 */
async function run({ inputs, options = {}, ctx }) {
  const doc = await loadPdf(inputs[0]);
  const form = doc.getForm();
  const values = options.values && typeof options.values === 'object' ? options.values : {};
  const created = Array.isArray(options.create) ? options.create : [];
  ctx.progress(0.1, 'קורא את הטופס…');

  // New fields first, so they can be filled in the same run.
  for (const spec of created) {
    const name = String(spec.name || '').trim();
    if (!name) throw new Error('לשדה חדש חסר שם.');
    if (form.getFieldMaybe(name)) throw new Error(`כבר יש בטופס שדה בשם "${name}". בחר שם אחר.`);
    if (!Number.isInteger(spec.page) || spec.page < 0 || spec.page >= doc.getPageCount()) throw new Error('שדה חדש מסומן על עמוד שאינו קיים.');
    const page = doc.getPage(spec.page);
    const rect = userRect(page, spec);
    // The rectangle is already in the page's own space. pdf-lib turns the rectangle it is
    // given when told the page is turned, so it is set again exactly after placing; the
    // turn itself stays, so the field's text runs the way the page is read.
    const placement = { ...rect, rotate: degrees(visualFrame(page).angle), borderWidth: 1 };
    const place = (field) => {
      field.addToPage(page, placement);
      const widgets = field.acroField.getWidgets();
      widgets[widgets.length - 1].setRectangle(rect);
    };
    if (spec.type === 'checkbox') place(form.createCheckBox(name));
    else if (spec.type === 'dropdown') {
      const field = form.createDropdown(name);
      field.addOptions((spec.options || []).map(String).filter(Boolean));
      place(field);
    } else if (spec.type === 'signature') {
      // pdf-lib has no signature widget of its own; a text field marked for signing is
      // what most viewers offer to sign into.
      place(form.createTextField(name));
    } else {
      const field = form.createTextField(name);
      if (spec.multiline) field.enableMultiline();
      place(field);
      if (spec.align === 'right') field.setAlignment(TextAlignment.Right);
    }
  }

  let filled = 0;
  const textual = [];
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    if (field instanceof PDFTextField) {
      field.setText(String(value ?? ''));
      textual.push(field);
    } else if (field instanceof PDFCheckBox) {
      if (value === true || value === 'true') field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      if (value) field.select(String(value));
    } else if (field instanceof PDFDropdown) {
      if (value) field.select(String(value));
      textual.push(field);
    } else if (field instanceof PDFOptionList) {
      if (value) field.select(String(value));
    } else continue;
    filled++;
  }

  ctx.progress(0.4, 'מצייר את הערכים…');
  await drawAppearances(doc, textual);

  if (options.flatten) {
    form.flatten({ updateFieldAppearances: false });
  } else {
    // Viewers that can, redraw the fields themselves; the appearances above are for those
    // that do not.
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), doc.context.obj(false));
  }

  ctx.progress(0.9, 'שומר…');
  const bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  const out = await ctx.writeOutput(bytes, { source: inputs[0], label: options.flatten ? 'טופס סופי' : 'טופס', ext: 'pdf' });
  const parts = [];
  if (filled) parts.push(filled === 1 ? 'שדה אחד מולא' : `${filled} שדות מולאו`);
  if (created.length) parts.push(created.length === 1 ? 'שדה אחד נוסף' : `${created.length} שדות נוספו`);
  if (!parts.length) parts.push('הטופס נשמר בלי שינויים');
  return { summary: `${parts.join(', ')}.${options.flatten ? ' השדות הפכו לחלק מהעמוד ואי אפשר לערוך אותם עוד.' : ''}`, display: [out] };
}

/** A box in fractions of the shown page, in the page's own coordinates. */
function userRect(page, { x, y, w, h }) {
  const frame = visualFrame(page);
  const a = frame.toUser(x * frame.width, (1 - y - h) * frame.height);
  const b = frame.toUser((x + w) * frame.width, (1 - y) * frame.height);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/**
 * Appearances for text fields and dropdowns: the value typeset by Chromium, embedded once,
 * and drawn inside each widget's box, right-aligned for Hebrew.
 */
async function drawAppearances(doc, fields) {
  const items = [];
  for (const field of fields) {
    const value = field instanceof PDFDropdown ? (field.getSelected()[0] || '') : (field.getText() || '');
    for (const widget of field.acroField.getWidgets()) items.push({ field, widget, value });
  }
  const nonEmpty = items.filter((i) => i.value.trim());
  const stamps = nonEmpty.length ? await embedStamps(doc, nonEmpty.map((i) => i.value.replace(/\n/g, ' ')), { size: 11 }) : [];
  for (const item of items) {
    const rect = item.widget.getRectangle();
    const k = nonEmpty.indexOf(item);
    const ops = [];
    const resources = {};
    if (k !== -1) {
      const stamp = stamps[k];
      const scale = Math.min(1, (rect.width - 4) / stamp.width, (rect.height - 2) / stamp.height);
      const w = stamp.width * scale;
      const h = stamp.height * scale;
      const alignRight = HEBREW.test(item.value) || (item.field instanceof PDFTextField && item.field.getAlignment() === TextAlignment.Right);
      const dx = alignRight ? rect.width - w - 2 : 2;
      const dy = (rect.height - h) / 2;
      resources.XObject = { V: stamp.page.ref };
      ops.push(`q ${scale} 0 0 ${scale} ${dx} ${dy} cm /V Do Q`);
    }
    const stream = doc.context.stream(ops.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, rect.width, rect.height],
      Resources: resources,
    });
    item.widget.setNormalAppearance(doc.context.register(stream));
  }
}

/** The fields of a form, for the screen. Positions are fractions of the page as shown. */
async function readFields(file) {
  const doc = await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true, updateMetadata: false });
  const form = doc.getForm();
  const pages = doc.getPages();
  const refs = pages.map((p) => p.ref.toString());
  const out = [];
  for (const field of form.getFields()) {
    const type = field instanceof PDFTextField ? 'text'
      : field instanceof PDFCheckBox ? 'checkbox'
        : field instanceof PDFRadioGroup ? 'radio'
          : field instanceof PDFDropdown ? 'dropdown'
            : field instanceof PDFOptionList ? 'list'
              : field instanceof PDFSignature ? 'signature'
                : field instanceof PDFButton ? 'button' : 'other';
    if (type === 'button' || type === 'other') continue;
    const widgets = field.acroField.getWidgets();
    const boxes = widgets.map((w) => {
      const pref = w.P();
      let index = pref ? refs.indexOf(pref.toString()) : -1;
      if (index === -1) index = pages.findIndex((p) => (p.node.Annots() ? p.node.Annots().asArray().some((a) => a === w.dict || (a.toString && doc.context.lookup(a) === w.dict)) : false));
      if (index === -1) return null;
      const frame = visualFrame(pages[index]);
      const r = w.getRectangle();
      const corners = [[r.x, r.y], [r.x + r.width, r.y + r.height]].map(([ux, uy]) => toShown(frame, pages[index], ux, uy));
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      return { page: index, x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
    }).filter(Boolean);
    let value = '';
    let choices = [];
    if (type === 'text') value = field.getText() || '';
    else if (type === 'checkbox') value = field.isChecked();
    else if (type === 'radio') { value = field.getSelected() || ''; choices = field.getOptions(); }
    else if (type === 'dropdown' || type === 'list') { value = field.getSelected()[0] || ''; choices = field.getOptions(); }
    out.push({ name: field.getName(), type, value, choices, readOnly: field.isReadOnly(), boxes });
  }
  return out;
}

/** A point in the page's own space, as fractions of the page as shown from its top-left. */
function toShown(frame, page, ux, uy) {
  const box = page.getCropBox();
  const x = ux - box.x;
  const y = uy - box.y;
  let vx;
  let vy;
  switch (frame.angle) {
    case 90: vx = y; vy = box.width - x; break;
    case 180: vx = box.width - x; vy = box.height - y; break;
    case 270: vx = box.height - y; vy = x; break;
    default: vx = x; vy = y;
  }
  return [vx / frame.width, 1 - vy / frame.height];
}

module.exports = { run, readFields, userRect, toShown };
