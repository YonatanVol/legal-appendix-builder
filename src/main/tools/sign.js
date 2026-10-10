'use strict';

const fs = require('fs/promises');
const path = require('path');

const { loadPdf } = require('../pdf/inspect');
const { drawObjects } = require('../pdf/draw');

/**
 * Sign: put a signature, a name, a date and initials on the pages, and, when a
 * certificate file is given, sign the file digitally as well.
 *
 * options.objects        what is placed on the pages (see pdf/draw.js); a signature is
 *                        an image object
 * options.certificate    path to a .pfx / .p12 file, optional
 * options.certPassword   its password (never recorded)
 *
 * The two are different things and the summary says which was done. A picture of a
 * signature shows who agreed; a digital signature also proves the file has not changed
 * since, and any change after it breaks the signature visibly in Acrobat.
 */
async function run({ inputs, options = {}, ctx }) {
  // A file that is already signed digitally (by a court, the other side, a colleague)
  // would have that signature broken: Acrobat appends a new signature to the end of the
  // file, while this tool writes the file anew. So it says so, and how to sign instead.
  const original = await fs.readFile(inputs[0]);
  if (/\/ByteRange\s*\[/.test(original.toString('latin1'))) {
    throw new Error(`הקובץ "${path.basename(inputs[0])}" כבר חתום חתימה דיגיטלית. חתימה כאן הייתה מבטלת את החתימה הקיימת, ולכן היא לא נעשתה. כדי להוסיף חתימה בלי לפגוע בקיימת, חתום ב-Adobe Acrobat Reader ("מילוי וחתימה").`);
  }
  const doc = await loadPdf(inputs[0]);
  ctx.progress(0.2, 'מציב את החתימה…');
  const placed = await drawObjects(doc, options.objects || []);
  if (!placed && !options.certificate) throw new Error('לא הוצבה חתימה. בחר חתימה ולחץ על המקום בעמוד.');

  let bytes;
  let digital = false;
  if (options.certificate) {
    bytes = await signDigitally(doc, options.certificate, options.certPassword || '', ctx);
    digital = true;
  } else {
    bytes = await doc.save({ useObjectStreams: true });
  }
  const out = await ctx.writeOutput(bytes, { source: inputs[0], label: 'חתום', ext: 'pdf' });
  const visible = placed ? `${placed === 1 ? 'פריט אחד הוצב' : `${placed} פריטים הוצבו`} על העמודים.` : '';
  const how = digital
    ? ' הקובץ חתום גם חתימה דיגיטלית: Acrobat יראה מי חתם, וכל שינוי אחרי החתימה יסמן אותה כלא תקפה.'
    : ' זו חתימה חזותית בלבד: היא מראה מי חתם, אבל אינה מגינה על הקובץ משינויים. לחתימה דיגיטלית צריך קובץ תעודה (pfx).';
  return { summary: `${visible}${how}`.trim(), display: [out] };
}

async function signDigitally(doc, certificate, password, ctx) {
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
  const { P12Signer } = require('@signpdf/signer-p12');
  const signpdf = require('@signpdf/signpdf').default;

  let p12;
  try {
    p12 = await fs.readFile(certificate);
  } catch {
    throw new Error(`לא ניתן לקרוא את קובץ התעודה "${path.basename(certificate)}".`);
  }
  ctx.progress(0.6, 'חותם חתימה דיגיטלית…');
  // The signing library replaces an indirect /Fields array with a new one holding only
  // the signature, which would drop every existing form field; a direct copy keeps them.
  const { PDFName } = require('pdf-lib');
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro && acro.get && acro.get(PDFName.of('Fields'))) {
    acro.set(PDFName.of('Fields'), acro.lookup(PDFName.of('Fields')));
  }
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: 'Signed',
    contactInfo: '',
    name: '',
    location: '',
    signatureLength: 16384,
    appName: 'Office PDF tools',
  });
  // The signature covers the file's bytes, so the placeholder has to be findable in
  // them: no compressed object streams.
  const unsigned = Buffer.from(await doc.save({ useObjectStreams: false }));
  try {
    return await signpdf.sign(unsigned, new P12Signer(p12, { passphrase: password }));
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/password|mac|decrypt|Invalid/i.test(msg)) throw new Error('הסיסמה של קובץ התעודה שגויה, או שהקובץ אינו תעודה תקינה.');
    throw new Error(`החתימה הדיגיטלית נכשלה: ${msg}`);
  }
}

module.exports = { run };
