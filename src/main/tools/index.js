'use strict';

/**
 * The tool grid. Every tool the program offers is listed here with what the home
 * screen shows for it, what files it takes, and which module runs it. A tool whose
 * module is not there yet is shown disabled, with a true sentence saying so.
 *
 * Groups follow iLovePDF's own, which the office already knows.
 */

const PDF = ['pdf'];
// Pictures the app can read itself. Phone photos arrive as JPEG; scanners save PNG.
const IMAGES = ['jpg', 'jpeg', 'png'];

const GROUPS = [
  { id: 'organize', name: 'סידור' },
  { id: 'optimize', name: 'שיפור' },
  { id: 'to-pdf', name: 'המרה ל-PDF' },
  { id: 'from-pdf', name: 'המרה מ-PDF' },
  { id: 'edit', name: 'עריכה' },
  { id: 'security', name: 'אבטחה' },
  { id: 'ai', name: 'בינה מלאכותית' },
  { id: 'workflows', name: 'תהליכי עבודה' },
];

const TOOLS = [
  { id: 'appendix', group: 'organize', name: 'בונה תיקי נספחים', description: 'כתב טענות ונספחים לתיק אחד עם חוצצים, תוכן עניינים ומספור רץ.', accepts: PDF, multiple: true, icon: 'appendix', screen: 'appendix' },
  { id: 'merge', group: 'organize', name: 'איחוד PDF', description: 'כמה קבצים לקובץ אחד, בסדר שתבחר.', accepts: PDF, multiple: true, min: 2, icon: 'merge' },
  { id: 'split', group: 'organize', name: 'פיצול PDF', description: 'חלוקה לפי טווחי עמודים, כל כמה עמודים, או חילוץ עמודים נבחרים.', accepts: PDF, multiple: false, icon: 'split' },
  { id: 'organize', group: 'organize', name: 'סידור עמודים', description: 'גרירה לסידור מחדש, מחיקה, סיבוב והוספת עמודים מקובץ אחר.', accepts: PDF, multiple: false, icon: 'organize' },
  { id: 'rotate', group: 'organize', name: 'סיבוב PDF', description: 'סיבוב כל העמודים או עמודים נבחרים.', accepts: PDF, multiple: true, icon: 'rotate' },
  { id: 'crop', group: 'organize', name: 'חיתוך PDF', description: 'חיתוך שוליים בעמוד אחד או בכולם, גם אוטומטית.', accepts: PDF, multiple: false, icon: 'crop' },

  { id: 'compress', group: 'optimize', name: 'כיווץ PDF', description: 'קובץ קטן יותר, באיכות שתבחר. מציג את הגודל לפני ואחרי.', accepts: PDF, multiple: true, icon: 'compress' },
  { id: 'repair', group: 'optimize', name: 'תיקון PDF', description: 'שחזור קובץ פגום שלא נפתח או נפתח עם שגיאות.', accepts: PDF, multiple: true, icon: 'repair' },
  { id: 'ocr', group: 'optimize', name: 'זיהוי טקסט (OCR)', description: 'הופך סריקה לקובץ שאפשר לחפש בו ולהעתיק ממנו, בעברית ובאנגלית.', accepts: PDF, multiple: true, icon: 'ocr' },
  { id: 'pdfa', group: 'optimize', name: 'PDF ל-PDF/A', description: 'המרה לתקן הארכיון לשמירה ארוכת טווח.', accepts: PDF, multiple: true, icon: 'pdfa' },

  { id: 'word-to-pdf', group: 'to-pdf', name: 'Word ל-PDF', description: 'מסמכי DOC ו-DOCX לקובצי PDF, דרך ה-Word שמותקן במחשב.', accepts: ['doc', 'docx', 'rtf', 'odt'], multiple: true, icon: 'word' },
  { id: 'ppt-to-pdf', group: 'to-pdf', name: 'PowerPoint ל-PDF', description: 'מצגות PPT ו-PPTX לקובצי PDF.', accepts: ['ppt', 'pptx', 'odp'], multiple: true, icon: 'ppt' },
  { id: 'excel-to-pdf', group: 'to-pdf', name: 'Excel ל-PDF', description: 'גיליונות XLS ו-XLSX לקובצי PDF.', accepts: ['xls', 'xlsx', 'ods', 'csv'], multiple: true, icon: 'excel' },
  { id: 'scan', group: 'to-pdf', name: 'סריקה ל-PDF', description: 'סריקה מהסורק של המשרד, או ניקוי של צילומי מסמכים, ישר ל-PDF.', accepts: IMAGES, multiple: true, icon: 'scan' },

  { id: 'pdf-to-word', group: 'from-pdf', name: 'PDF ל-Word', description: 'קובץ DOCX שאפשר לערוך, דרך ה-Word שמותקן במחשב.', accepts: PDF, multiple: true, icon: 'word' },
  { id: 'pdf-to-ppt', group: 'from-pdf', name: 'PDF ל-PowerPoint', description: 'כל עמוד הופך לשקופית.', accepts: PDF, multiple: true, icon: 'ppt' },
  { id: 'pdf-to-excel', group: 'from-pdf', name: 'PDF ל-Excel', description: 'טבלאות מתוך ה-PDF לגיליון אלקטרוני.', accepts: PDF, multiple: true, icon: 'excel' },
  { id: 'pdf-to-jpg', group: 'from-pdf', name: 'PDF ל-JPG', description: 'כל עמוד לתמונה, או חילוץ התמונות שבתוך הקובץ.', accepts: PDF, multiple: true, icon: 'jpg' },
  { id: 'pdf-to-markdown', group: 'from-pdf', name: 'PDF ל-Markdown', description: 'טקסט עם כותרות ורשימות, לשימוש במסמכים ובכלי בינה מלאכותית.', accepts: PDF, multiple: true, icon: 'markdown' },

  { id: 'edit', group: 'edit', name: 'עריכת PDF', description: 'הוספת טקסט, תמונות, צורות וסימונים על העמודים.', accepts: PDF, multiple: false, icon: 'edit' },
  { id: 'page-numbers', group: 'edit', name: 'מספרי עמודים', description: 'מספור בכל מקום ובכל פורמט, כולל "עמוד 3 מתוך 10".', accepts: PDF, multiple: true, icon: 'numbers' },
  { id: 'watermark', group: 'edit', name: 'סימן מים', description: 'טקסט או תמונה מעל העמודים, בזווית ובשקיפות שתבחר.', accepts: PDF, multiple: true, icon: 'watermark' },
  { id: 'sign', group: 'edit', name: 'חתימה על PDF', description: 'חתימה מצוירת, מוקלדת או מתמונה, במקום שתבחר.', accepts: PDF, multiple: false, icon: 'sign' },
  { id: 'redact', group: 'edit', name: 'השחרה', description: 'מחיקה אמיתית של טקסט ואזורים רגישים, לא רק הסתרה.', accepts: PDF, multiple: false, icon: 'redact' },
  { id: 'forms', group: 'edit', name: 'טפסים', description: 'מילוי שדות בטופס קיים, או יצירת שדות חדשים.', accepts: PDF, multiple: false, icon: 'forms' },

  { id: 'protect', group: 'security', name: 'הגנה בסיסמה', description: 'הצפנה עם סיסמה לפתיחה, והגבלת הדפסה והעתקה.', accepts: PDF, multiple: true, icon: 'lock' },
  { id: 'unlock', group: 'security', name: 'הסרת סיסמה', description: 'הסרת ההגנה מקובץ שהסיסמה שלו ידועה לך.', accepts: PDF, multiple: true, icon: 'unlock', acceptsEncrypted: true },

  { id: 'summarize', group: 'ai', name: 'סיכום מסמך', description: 'סיכום בעברית של המסמך: עובדות, צדדים, תאריכים וסכומים.', accepts: PDF, multiple: false, icon: 'summarize', cloud: true },
  { id: 'translate', group: 'ai', name: 'תרגום PDF', description: 'תרגום המסמך לשפה אחרת, כקובץ Word ו-PDF.', accepts: PDF, multiple: false, icon: 'translate', cloud: true },

  { id: 'workflow', group: 'workflows', name: 'תהליך עבודה חדש', description: 'שרשור של כמה כלים לפעולה אחת שחוזרת על עצמה.', accepts: PDF, multiple: true, icon: 'workflow', screen: 'workflow' },
];

// Tools with their own screen rather than the shared one, once that screen exists.
const SCREENS_BUILT = new Set(['appendix', 'workflow']);

const modules = new Map();

function implementation(id) {
  if (modules.has(id)) return modules.get(id);
  let mod = null;
  try {
    mod = require(`./${id}`);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(`/${id}'`)) throw err;
    mod = null;
  }
  modules.set(id, mod);
  return mod;
}

function get(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

/** Runnable tool: metadata plus its run(). Null when the module is not there yet. */
function runnable(id) {
  // A saved workflow runs through the workflow runner; its steps arrive in the options.
  if (/^wf:[0-9a-f]+$/.test(String(id))) {
    return { id, name: 'תהליך עבודה', accepts: PDF, multiple: true, run: require('./workflow').run };
  }
  const meta = get(id);
  if (!meta) return null;
  const mod = implementation(id);
  return mod && typeof mod.run === 'function' ? { ...meta, run: mod.run } : null;
}

/**
 * What the home screen shows. `available` is false with a reason for tools whose
 * engine is missing on this PC, or whose module does not exist yet.
 */
async function list(env = {}) {
  const result = [];
  for (const meta of TOOLS) {
    let available = true;
    let reason = '';
    // One tool that fails to load, or to check what it needs, is shown as unavailable; it
    // never takes the other tiles with it.
    try {
      const mod = meta.screen ? null : implementation(meta.id);
      if (meta.screen && !SCREENS_BUILT.has(meta.screen)) {
        available = false;
        reason = 'הכלי הזה עדיין לא זמין בגרסה הזו.';
      } else if (!meta.screen && !mod) {
        available = false;
        reason = 'הכלי הזה עדיין לא זמין בגרסה הזו.';
      } else if (mod && typeof mod.availability === 'function') {
        const status = await mod.availability(env);
        available = status.available;
        reason = status.reason || '';
      }
    } catch (err) {
      console.error(`[tools] "${meta.id}" could not be checked:`, err);
      available = false;
      reason = 'הכלי הזה לא נטען כראוי. סגור את התוכנה ופתח אותה שוב; אם זה חוזר, התקנה מחדש תפתור את זה.';
    }
    result.push({ ...meta, available, reason });
  }
  // Each saved workflow is a tile of its own, beside "new workflow".
  let saved = [];
  try {
    saved = await require('../workflows').list();
  } catch {
    saved = [];
  }
  for (const w of saved) {
    const names = w.steps.map((s) => (get(s.toolId) || {}).name || s.toolId);
    result.push({
      id: `wf:${w.id}`,
      group: 'workflows',
      name: w.name,
      description: names.join(' ← '),
      accepts: PDF,
      multiple: true,
      icon: 'workflow',
      // A workflow that starts by removing a password takes locked files, as Unlock does.
      acceptsEncrypted: (w.steps[0] || {}).toolId === 'unlock',
      available: true,
      reason: '',
      workflow: { id: w.id, name: w.name, steps: w.steps },
    });
  }
  return result;
}

module.exports = { TOOLS, GROUPS, get, runnable, list };
