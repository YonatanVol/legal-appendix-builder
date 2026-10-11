'use strict';

/*
 * The options side of each tool screen.
 *
 * A panel is { defaults(), render(container, view), blocked(view), inputs?(view),
 * onEscape?(view) }. `view` carries the files and the options object, and
 * `view.set(key, value)` changes an option and re-checks the run button. Options are
 * plain data on purpose: a repeated run replays exactly this object.
 *
 * Panels build their controls with the helpers in `ui` so every tool looks and
 * behaves alike, and show what will happen before the button is pressed: Split
 * labels each page with the file it will land in, Page numbers and Watermark draw
 * the result over the real first page.
 */

const R = () => window.pageRanges;

const ui = {
  section(container, title, hint) {
    const box = document.createElement('div');
    box.className = 'opt';
    if (title) {
      const h = document.createElement('h3');
      h.className = 'opt-title';
      h.textContent = title;
      box.append(h);
    }
    if (hint) {
      const p = document.createElement('p');
      p.className = 'opt-hint';
      p.textContent = hint;
      box.append(p);
    }
    container.append(box);
    return box;
  },

  field(box, label) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    if (label) {
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = label;
      wrap.append(span);
    }
    box.append(wrap);
    return wrap;
  },

  text(box, { label, value, placeholder, onInput, dir }) {
    const wrap = ui.field(box, label);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    if (dir) input.dir = dir;
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(input);
    return input;
  },

  number(box, { label, value, min, max, step = 1, onInput, suffix }) {
    const wrap = ui.field(box, label);
    const row = document.createElement('span');
    row.className = 'number-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.step = step;
    input.addEventListener('input', () => onInput(input.value === '' ? '' : Number(input.value)));
    row.append(input);
    if (suffix) {
      const s = document.createElement('span');
      s.className = 'suffix';
      s.textContent = suffix;
      row.append(s);
    }
    wrap.append(row);
    return input;
  },

  slider(box, { label, value, min, max, step = 1, onInput, format = (v) => String(v) }) {
    const wrap = ui.field(box, label);
    const row = document.createElement('span');
    row.className = 'slider-row';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    const out = document.createElement('output');
    out.textContent = format(Number(value));
    input.addEventListener('input', () => {
      out.textContent = format(Number(input.value));
      onInput(Number(input.value));
    });
    row.append(input, out);
    wrap.append(row);
    return input;
  },

  check(box, { label, value, onChange, hint }) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    if (hint) wrap.title = hint;
    box.append(wrap);
    return input;
  },

  /** A row of mutually exclusive choices, shown as a segmented control. */
  choice(box, { label, value, choices, onChange, vertical = false }) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    if (label) {
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = label;
      wrap.append(span);
    }
    const row = document.createElement('div');
    row.className = vertical ? 'segmented vertical' : 'segmented';
    row.setAttribute('role', 'radiogroup');
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg' + (c.value === value ? ' on' : '');
      b.dataset.value = String(c.value);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.value === value));
      b.textContent = c.label;
      if (c.title) b.title = c.title;
      b.addEventListener('click', () => {
        row.querySelectorAll('.seg').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
        onChange(c.value);
      });
      row.append(b);
    }
    wrap.append(row);
    box.append(wrap);
    return row;
  },

  button(box, { label, onClick, kind = 'secondary', title, disabled = false }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = kind;
    b.textContent = label;
    if (title) b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    box.append(b);
    return b;
  },

  row(box) {
    const row = document.createElement('div');
    row.className = 'opt-row';
    box.append(row);
    return row;
  },

  note(box, text, kind = '') {
    const p = document.createElement('p');
    p.className = `opt-preview ${kind}`.trim();
    p.textContent = text;
    box.append(p);
    return p;
  },

  /**
   * Where on the page: a small page with a button at each spot. Laid out left to right
   * so "right" is on the right, whatever the page direction.
   */
  position(box, { label, value, rows, onChange, extra }) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    if (label) {
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = label;
      wrap.append(span);
    }
    const NAMES = {
      top: 'למעלה', middle: 'באמצע', bottom: 'למטה',
      left: 'משמאל', center: 'במרכז', right: 'מימין',
    };
    const page = document.createElement('div');
    page.className = `pos-picker rows-${rows.length}`;
    page.setAttribute('role', 'radiogroup');
    const buttons = [];
    for (const vert of rows) {
      for (const horiz of ['left', 'center', 'right']) {
        const id = `${vert}-${horiz}`;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pos' + (id === value ? ' on' : '');
        b.dataset.value = id;
        const name = `${NAMES[vert]} ${NAMES[horiz]}`;
        b.title = name;
        b.setAttribute('aria-label', name);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(id === value));
        b.addEventListener('click', () => {
          buttons.forEach((x) => {
            x.classList.toggle('on', x === b);
            x.setAttribute('aria-checked', String(x === b));
          });
          onChange(id);
        });
        buttons.push(b);
        page.append(b);
      }
    }
    wrap.append(page);
    if (extra) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-single' + (value === extra.value ? ' on' : '');
      b.textContent = extra.label;
      b.addEventListener('click', () => {
        buttons.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(extra.value);
      });
      buttons.push(b);
      wrap.append(b);
    }
    box.append(wrap);
    return page;
  },

  /** A password field with a show/hide button. Never filled in from history. */
  password(box, { label, value, onInput, autofocus = false }) {
    const wrap = ui.field(box, label);
    const row = document.createElement('span');
    row.className = 'password-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.value = value || '';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.dir = 'auto';
    input.addEventListener('input', () => onInput(input.value));
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'ghost small';
    eye.textContent = 'הצג';
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.textContent = show ? 'הסתר' : 'הצג';
    });
    row.append(input, eye);
    wrap.append(row);
    if (autofocus) setTimeout(() => input.focus(), 0);
    return input;
  },

  swatches(box, { label, value, colors, onChange }) {
    const wrap = ui.field(box, label);
    const row = document.createElement('span');
    row.className = 'swatches';
    for (const c of colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (c.value === value ? ' on' : '');
      b.style.background = c.value;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.addEventListener('click', () => {
        row.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
        onChange(c.value);
      });
      row.append(b);
    }
    wrap.append(row);
    return row;
  },
};

/* ---------------- shared pieces ---------------- */

/** Per-tool state that is not an option: grids, undo history, measured sizes. */
const mem = {};

const firstFile = (view) => view.files.find((f) => !f.error) || null;

function pagesOf(file) {
  return Array.from({ length: file.pageCount }, (_, i) => ({ key: `0:${i}`, token: file.token, index: i, turn: 0 }));
}

/** Only sentences written for people reach the screen; anything else is a bug. */
function hebrewOr(err, fallback = 'משהו השתבש בהכנת התצוגה. אפשר עדיין להפעיל את הכלי.') {
  const message = err && err.message ? err.message : String(err);
  if (/[\u0590-\u05FF]/.test(message)) return message;
  console.error('panel:', message);
  return fallback;
}

function rangesError(text, total) {
  try {
    R().parseRanges(text, total);
    return null;
  } catch (err) {
    return hebrewOr(err, 'לא ניתן לקרוא את רשימת העמודים.');
  }
}

/** A Latin measure inside a Hebrew sentence keeps its order: "4.1 MB", not "MB 4.1". */
const ltr = (text) => `\u2066${text}\u2069`;

const pagesWord = (n) => (n === 1 ? 'עמוד אחד' : `${n} עמודים`);
const filesWord = (n) => (n === 1 ? 'קובץ אחד' : `${n} קבצים`);

/** Shown page sizes in points, from pdf.js, once per file. */
async function shownSizes(view, file) {
  const key = `sizes:${file.token}`;
  if (!mem[key]) mem[key] = view.thumbs().then((t) => t.pageSizes(file.token)).catch(() => []);
  return mem[key];
}

/**
 * A page with something drawn over it, for previews. Returns the stage element; the
 * caller positions overlays inside it in fractions of the page.
 */
function previewPage(host, view, file, index, width) {
  const stage = document.createElement('div');
  stage.className = 'preview-stage loading';
  stage.style.width = `${width}px`;
  host.append(stage);
  view.pageThumb(file.token, index, width).then((url) => {
    stage.classList.remove('loading');
    if (!url) return;
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.draggable = false;
    stage.prepend(img);
  });
  return stage;
}

/** A picture the page can read (by its document link) as a data: URL, for embedding. */
async function dataUrlOf(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/**
 * Making a signature: draw it, type it, or take it from a picture. Pictures have their
 * white background made transparent and are cut to the ink, so a photographed
 * signature sits on the page like a pen stroke.
 */
function openSignatureMaker(onSave) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sig-dialog';
  dlg.innerHTML = `
    <h2>חתימה חדשה</h2>
    <div class="segmented sig-tabs" role="tablist">
      <button type="button" class="seg on" data-tab="draw">ציור</button>
      <button type="button" class="seg" data-tab="type">הקלדה</button>
      <button type="button" class="seg" data-tab="image">מתמונה</button>
    </div>
    <div class="sig-pane" data-pane="draw">
      <canvas width="560" height="200" class="sig-canvas"></canvas>
      <div class="opt-row"><button type="button" class="ghost small" data-act="clear">ניקוי</button>
        <span class="swatches"><button type="button" class="swatch on" style="background:#1a1a1a" data-ink="#1a1a1a" title="שחור"></button><button type="button" class="swatch" style="background:#1f3fa8" data-ink="#1f3fa8" title="כחול"></button></span></div>
    </div>
    <div class="sig-pane" data-pane="type" hidden>
      <input type="text" class="sig-typed" dir="auto" placeholder="השם כפי שתרצה שייחתם">
      <canvas width="560" height="160" class="sig-preview"></canvas>
    </div>
    <div class="sig-pane" data-pane="image" hidden>
      <button type="button" class="secondary" data-act="pick">בחירת תמונה של חתימה…</button>
      <canvas width="560" height="200" class="sig-from-image"></canvas>
      <p class="opt-hint">הרקע הלבן מוסר אוטומטית. כדאי לצלם על דף לבן, באור טוב.</p>
    </div>
    <p class="sig-error opt-preview bad"></p>
    <div class="sig-actions"><button type="button" class="primary" data-act="save">שמירה</button><button type="button" class="ghost" data-act="cancel">ביטול</button></div>`;
  document.body.append(dlg);
  const $$ = (sel) => dlg.querySelector(sel);
  let tab = 'draw';
  let ink = '#1a1a1a';
  let drew = false;
  let imageCanvas = null;

  dlg.querySelectorAll('.sig-tabs .seg').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    dlg.querySelectorAll('.sig-tabs .seg').forEach((x) => x.classList.toggle('on', x === b));
    dlg.querySelectorAll('.sig-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  }));

  const pad = $$('.sig-canvas');
  const ctx = pad.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let last = null;
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    last = [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)];
  });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const r = pad.getBoundingClientRect();
    const p = [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)];
    // Faster strokes are thinner, the way ink behaves.
    const speed = Math.hypot(p[0] - last[0], p[1] - last[1]);
    ctx.lineWidth = Math.max(1.4, 4 - speed / 12);
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
    drew = true;
  });
  pad.addEventListener('pointerup', () => { last = null; });
  $$('[data-act="clear"]').addEventListener('click', () => { ctx.clearRect(0, 0, pad.width, pad.height); drew = false; });
  dlg.querySelectorAll('[data-ink]').forEach((b) => b.addEventListener('click', () => {
    ink = b.dataset.ink;
    dlg.querySelectorAll('[data-ink]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  const typed = $$('.sig-typed');
  const preview = $$('.sig-preview');
  const drawTyped = () => {
    const c = preview.getContext('2d');
    c.clearRect(0, 0, preview.width, preview.height);
    c.fillStyle = ink;
    c.font = "italic bold 64px 'David Bundled', David, serif";
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.direction = /[֐-׿]/.test(typed.value) ? 'rtl' : 'ltr';
    c.fillText(typed.value, preview.width / 2, preview.height / 2);
  };
  typed.addEventListener('input', drawTyped);

  $$('[data-act="pick"]').addEventListener('click', async () => {
    const r = await window.shell.pickFiles({ extensions: ['png', 'jpg', 'jpeg'], multiple: false, title: 'תמונה של חתימה' });
    if (!r.ok || r.cancelled || !r.files.length || !r.files[0].token) return;
    const img = new Image();
    img.onload = () => {
      const c = $$('.sig-from-image');
      const scale = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(img, (c.width - img.naturalWidth * scale) / 2, (c.height - img.naturalHeight * scale) / 2, img.naturalWidth * scale, img.naturalHeight * scale);
      const data = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const v = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / 3;
        // Paper fades out smoothly, ink stays.
        data.data[i + 3] = v > 200 ? 0 : v > 140 ? Math.round(((200 - v) / 60) * 255) : 255;
      }
      g.putImageData(data, 0, 0);
      imageCanvas = c;
    };
    img.src = `/doc/${encodeURIComponent(r.files[0].token)}`;
  });

  /** The canvas cut to its ink, as a PNG data URL, or null if it is empty. */
  const trimmed = (canvas) => {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 9;
    out.height = y1 - y0 + 9;
    out.getContext('2d').drawImage(canvas, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };

  const close = () => { dlg.close(); dlg.remove(); };
  $$('[data-act="cancel"]').addEventListener('click', close);
  dlg.addEventListener('cancel', close);
  $$('[data-act="save"]').addEventListener('click', () => {
    let url = null;
    if (tab === 'draw') url = drew ? trimmed(pad) : null;
    else if (tab === 'type') url = typed.value.trim() ? trimmed(preview) : null;
    else url = imageCanvas ? trimmed(imageCanvas) : null;
    if (!url) {
      $$('.sig-error').textContent = tab === 'draw' ? 'צייר חתימה בתיבה.' : tab === 'type' ? 'כתוב את השם.' : 'בחר תמונה של חתימה.';
      return;
    }
    onSave(url, tab);
    close();
  });
  dlg.showModal();
  return dlg;
}

/** Word, PowerPoint and Excel to PDF all look alike: what happens, and with what. */
function officePanel(program, how) {
  return {
    defaults: () => ({}),
    render(container) {
      ui.section(container, 'איך זה עובד', `${how} אם ${program} לא מותקן במחשב, ההמרה נעשית ב-LibreOffice. הקובץ לא יוצא מהמחשב.`);
    },
    blocked: () => null,
  };
}

/** Said plainly before a cloud tool runs: the document leaves the PC. */
function cloudNotice(container, subject = 'הכלי הזה') {
  const p = document.createElement('p');
  p.className = 'cloud-notice';
  p.textContent = `${subject} שולח את המסמך ל-Anthropic, החברה שמפעילה את Claude, ומקבל ממנה את התוצאה. אל תשתמשו בו למסמכים שאסור שיצאו מהמשרד.`;
  container.append(p);
}

/* ---------------- the panels ---------------- */

const panels = {
  merge: {
    defaults: () => ({ outputName: '' }),
    render(container, view) {
      const order = ui.section(container, 'סדר הקבצים',
        'הקבצים יאוחדו בסדר שברשימה. אפשר לגרור שורה כדי להזיז אותה.');
      const row = ui.row(order);
      ui.button(row, { label: 'מיון לפי שם', onClick: () => view.sortFiles('name') });
      ui.button(row, { label: 'היפוך הסדר', onClick: () => view.sortFiles('reverse') });

      const name = ui.section(container, 'שם הקובץ החדש');
      const first = view.files[0];
      ui.text(name, {
        value: view.options.outputName,
        placeholder: first ? `${first.name.replace(/\.pdf$/i, '')} - מאוחד` : 'מאוחד',
        onInput: (v) => view.set('outputName', v),
      });
    },
    blocked(view) {
      if (view.files.length === 1) return 'הוסף עוד קובץ אחד לפחות כדי לאחד.';
      return null;
    },
  },

  split: {
    defaults: () => ({ mode: 'ranges', ranges: '', mergeRanges: false, every: 2, pages: '', extractEach: false, maxMb: 5 }),
    render(container, view) {
      const o = view.options;
      const file = firstFile(view);
      const total = file ? file.pageCount : 0;

      const how = ui.section(container, 'איך לפצל');
      ui.choice(how, {
        value: o.mode,
        vertical: true,
        choices: [
          { value: 'ranges', label: 'לפי טווחי עמודים' },
          { value: 'every', label: 'כל כמה עמודים' },
          { value: 'extract', label: 'חילוץ עמודים נבחרים' },
          { value: 'size', label: 'לפי גודל קובץ' },
        ],
        onChange: (v) => {
          view.set('mode', v);
          view.rerender();
        },
      });

      const box = ui.section(container);
      let preview;
      let grid = null;

      const refresh = () => {
        if (!file) {
          preview.textContent = 'בחר קובץ כדי לראות איך הוא יתחלק.';
          return;
        }
        const plan = splitPlan(o, total);
        preview.textContent = plan.error || plan.text;
        preview.classList.toggle('bad', !!plan.error);
        if (grid && o.mode !== 'extract') grid.setPages((plan.pages || pagesOf(file)).map((p) => ({ ...p, token: file.token })));
      };

      if (o.mode === 'ranges') {
        ui.text(box, {
          label: 'טווחים, מופרדים בפסיק',
          value: o.ranges,
          placeholder: total ? `למשל: 1-3, 4-${Math.max(4, Math.min(total, 9))}, ${Math.min(total, 10)}-` : '1-3, 4-6, 7-',
          dir: 'ltr',
          onInput: (v) => {
            view.set('ranges', v);
            refresh();
          },
        });
        ui.check(box, { label: 'כל הטווחים בקובץ אחד', value: o.mergeRanges, onChange: (v) => { view.set('mergeRanges', v); refresh(); } });
      } else if (o.mode === 'every') {
        ui.number(box, { label: 'קובץ חדש כל', value: o.every, min: 1, suffix: 'עמודים', onInput: (v) => { view.set('every', v); refresh(); } });
      } else if (o.mode === 'extract') {
        const input = ui.text(box, {
          label: 'העמודים לחילוץ',
          value: o.pages,
          placeholder: 'לחץ על עמודים, או כתוב למשל 2, 5-7',
          dir: 'ltr',
          onInput: (v) => {
            view.set('pages', v);
            if (grid && file && !rangesError(v, total)) {
              grid.setSelection(R().indicesOf(R().parseRanges(v, total)).map((i) => `0:${i}`));
            }
            refresh();
          },
        });
        mem.splitInput = input;
        ui.check(box, { label: 'כל עמוד כקובץ נפרד', value: o.extractEach, onChange: (v) => { view.set('extractEach', v); refresh(); } });
      } else {
        ui.number(box, { label: 'גודל מרבי לכל חלק', value: o.maxMb, min: 0.1, step: 0.5, suffix: 'MB', onInput: (v) => { view.set('maxMb', v); refresh(); } });
        if (file) ui.note(box, `גודל הקובץ עכשיו: ${ltr(`${(file.size / 1024 / 1024).toFixed(1)} MB`)}.`, 'muted');
      }

      preview = ui.note(box, '');

      if (file && file.token) {
        const selected = o.mode === 'extract' && o.pages && !rangesError(o.pages, total)
          ? R().indicesOf(R().parseRanges(o.pages, total)).map((i) => `0:${i}`)
          : [];
        grid = new window.PageGrid(view.pagesHost, {
          pages: pagesOf(file),
          select: o.mode === 'extract',
          selected,
          thumb: view.pageThumb,
          onSelect: (pages) => {
            const text = R().rangesText(pages.map((p) => p.index));
            view.set('pages', text);
            if (mem.splitInput) mem.splitInput.value = text;
            refresh();
          },
        });
        mem.splitGrid = grid;
      }
      refresh();
    },
    blocked(view) {
      const file = firstFile(view);
      if (!file) return null;
      return splitPlan(view.options, file.pageCount).error || null;
    },
    onEscape() {
      return mem.splitGrid ? mem.splitGrid.clearSelection() : false;
    },
  },

  organize: {
    defaults: () => ({ pages: [], extra: [] }),
    inputs(view) {
      const file = firstFile(view);
      return [file.path, ...(view.options.extra || [])];
    },
    render(container, view) {
      const file = firstFile(view);
      const help = ui.section(container, 'עבודה עם העמודים',
        'לחיצה בוחרת עמוד, Ctrl מוסיף לבחירה ו-Shift בוחר טווח. גרירה מזיזה את העמודים הנבחרים. Delete מוחק, Ctrl+Z מבטל.');
      if (!file || !file.token) return;

      // Keyed by the file's token, which changes when the file is saved again, so a
      // re-saved letter starts fresh instead of reusing the old page count.
      let st = mem.organize;
      if (!st || st.forToken !== file.token) {
        st = mem.organize = { forToken: file.token, seq: pagesOf(file).map((p) => ({ key: p.key, f: 0, p: p.index, r: 0 })), extra: [], undo: [], nextKey: 0 };
        // A repeated run brings its sequence back.
        if (Array.isArray(view.options.pages) && view.options.pages.length && !(view.options.extra || []).length) {
          st.seq = view.options.pages.map((it, i) => ({ ...it, key: `r:${i}` }));
        }
      }

      const sync = () => {
        view.set('pages', st.seq.map(({ f, p, r, blank, w, h }) => (blank ? { blank: true, w, h } : { f, p, r })));
        view.set('extra', st.extra.map((x) => x.path));
      };
      const tokenOf = (f) => (f === 0 ? file.token : st.extra[f - 1].token);
      const toPages = () => st.seq.map((it) => (it.blank
        ? { key: it.key, blank: true }
        : { key: it.key, token: tokenOf(it.f), index: it.p, turn: it.r, label: it.f ? `מקובץ ${it.f + 1}` : '', tone: it.f }));
      // Undo restores the inserted files with the order: without them, pages taken
      // from another file would point at nothing.
      const save = () => {
        st.undo.push({ seq: st.seq.map((x) => ({ ...x })), extra: st.extra.slice() });
        if (st.undo.length > 100) st.undo.shift();
      };
      const apply = (next) => {
        st.seq = next;
        grid.setPages(toPages());
        sync();
        paint();
      };

      const actions = ui.section(container, 'פעולות על הבחירה');
      const row1 = ui.row(actions);
      const left = ui.button(row1, { label: '⟲ שמאלה', title: 'סיבוב 90 מעלות נגד כיוון השעון', onClick: () => turn(-1) });
      const right = ui.button(row1, { label: '⟳ ימינה', title: 'סיבוב 90 מעלות עם כיוון השעון', onClick: () => turn(1) });
      const del = ui.button(row1, { label: 'מחיקה', title: 'מחיקת העמודים הנבחרים (Delete)', onClick: () => grid.removeSelected() });
      const selNote = ui.note(actions, '', 'muted');

      const add = ui.section(container, 'הוספה');
      const row2 = ui.row(add);
      ui.button(row2, { label: 'עמוד ריק', title: 'אחרי העמוד הנבחר האחרון, או בסוף', onClick: () => insertBlank() });
      ui.button(row2, { label: 'עמודים מקובץ אחר…', onClick: () => insertFile() });

      const undoBox = ui.section(container);
      const row3 = ui.row(undoBox);
      const undo = ui.button(row3, { label: 'ביטול הפעולה האחרונה', kind: 'ghost', onClick: () => undoLast() });
      ui.button(row3, { label: 'חזרה לסדר המקורי', kind: 'ghost', onClick: () => { save(); st.extra = []; apply(pagesOf(file).map((p) => ({ key: `o:${st.nextKey++}`, f: 0, p: p.index, r: 0 }))); } });
      const count = ui.note(undoBox, '', 'muted');

      const grid = new window.PageGrid(view.pagesHost, {
        pages: toPages(),
        reorder: true,
        remove: true,
        thumb: view.pageThumb,
        onChange: (pages) => {
          save();
          const byKey = new Map(st.seq.map((x) => [x.key, x]));
          st.seq = pages.map((p) => byKey.get(p.key));
          sync();
          paint();
        },
        onSelect: () => paint(),
      });
      mem.organizeGrid = grid;

      function paint() {
        const n = grid.selected.size;
        for (const b of [left, right, del]) {
          b.disabled = n === 0;
          b.title = n === 0 ? 'בחר קודם עמודים' : b.title;
        }
        selNote.textContent = n ? `${pagesWord(n)} ${n === 1 ? 'נבחר' : 'נבחרו'}.` : 'לא נבחרו עמודים. לחץ על עמוד כדי לבחור.';
        undo.disabled = st.undo.length === 0;
        const removed = file.pageCount - st.seq.filter((x) => !x.blank && x.f === 0).length;
        count.textContent = `${pagesWord(st.seq.length)} בקובץ החדש${removed > 0 ? `, ${removed === 1 ? 'עמוד אחד הוסר' : `${removed} עמודים הוסרו`}` : ''}.`;
      }

      function turn(dir) {
        save();
        const keys = grid.selected;
        apply(st.seq.map((x) => (keys.has(x.key) && !x.blank ? { ...x, r: (((x.r || 0) + dir) % 4 + 4) % 4 } : x)));
      }

      function insertAt() {
        const keys = grid.selected;
        let at = st.seq.length;
        st.seq.forEach((x, i) => { if (keys.has(x.key)) at = i + 1; });
        return at;
      }

      async function insertBlank() {
        save();
        const sizes = await shownSizes(view, file);
        const at = insertAt();
        const ref = st.seq[Math.max(0, at - 1)];
        const size = ref && !ref.blank && ref.f === 0 && sizes[ref.p] ? sizes[ref.p] : { width: 595.28, height: 841.89 };
        const next = st.seq.slice();
        const key = `b:${st.nextKey++}`;
        next.splice(at, 0, { key, blank: true, w: size.width, h: size.height });
        apply(next);
        grid.setSelection([key]);
      }

      async function insertFile() {
        const r = await view.pick({ extensions: ['pdf'], multiple: false, title: 'עמודים מקובץ אחר' });
        if (!r.ok) return view.error(r.error);
        if (r.cancelled || !r.files.length) return;
        const other = r.files[0];
        if (other.error) return view.error(other.error);
        save();
        st.extra.push({ path: other.path, token: other.token, name: other.name, pageCount: other.pageCount });
        const f = st.extra.length;
        const at = insertAt();
        const added = Array.from({ length: other.pageCount }, (_, i) => ({ key: `x:${st.nextKey++}`, f, p: i, r: 0 }));
        const next = st.seq.slice();
        next.splice(at, 0, ...added);
        apply(next);
        grid.setSelection(added.map((a) => a.key));
        paint();
      }

      function undoLast() {
        const prev = st.undo.pop();
        if (!prev) return;
        st.seq = prev.seq;
        st.extra = prev.extra;
        grid.setPages(toPages());
        sync();
        paint();
      }
      mem.organizeUndo = undoLast;

      sync();
      paint();
    },
    blocked(view) {
      const st = mem.organize;
      const file = firstFile(view);
      if (!file || !st || st.forToken !== file.token) return null;
      if (!st.seq.length) return 'לא נשאר אף עמוד. בטל את המחיקה (Ctrl+Z) או בחר קובץ אחר.';
      const unchanged = st.seq.length === file.pageCount && st.seq.every((x, i) => !x.blank && x.f === 0 && x.p === i && !x.r);
      if (unchanged) return 'עוד לא שונה דבר בסדר העמודים.';
      return null;
    },
    onEscape() {
      return mem.organizeGrid ? mem.organizeGrid.clearSelection() : false;
    },
  },

  rotate: {
    defaults: () => ({ angle: 90, pages: '' }),
    render(container, view) {
      const o = view.options;
      const angle = ui.section(container, 'כיוון הסיבוב');
      ui.choice(angle, {
        value: o.angle,
        choices: [
          { value: 90, label: '⟳ 90° ימינה' },
          { value: 180, label: '180°' },
          { value: 270, label: '⟲ 90° שמאלה' },
        ],
        onChange: (v) => {
          view.set('angle', v);
          refresh();
        },
      });

      const scope = ui.section(container, 'אילו עמודים');
      const note = ui.note(scope, '');
      const file = firstFile(view);
      const single = view.files.length === 1 && file && file.token;
      let grid = null;

      function refresh() {
        if (!single) {
          view.set('pages', '');
          note.textContent = view.files.length > 1
            ? `כל העמודים ב-${filesWord(view.files.length)} יסובבו. לבחירת עמודים מסוימים עבוד על קובץ אחד.`
            : 'כל העמודים יסובבו.';
          return;
        }
        const chosen = grid ? grid.selectedPages().map((p) => p.index) : [];
        view.set('pages', chosen.length ? R().rangesText(chosen) : '');
        note.textContent = chosen.length
          ? `יסובבו ${chosen.length === 1 ? 'עמוד' : 'עמודים'} ${R().rangesText(chosen)}. Esc מבטל את הבחירה.`
          : 'כל העמודים יסובבו. לחיצה על עמודים תסובב רק אותם.';
        if (grid) {
          const turns = o.angle / 90;
          const keys = new Set(chosen.map((i) => `0:${i}`));
          const all = !chosen.length;
          grid.setPages(pagesOf(file).map((p) => ({ ...p, turn: all || keys.has(p.key) ? turns : 0 })));
        }
      }

      if (single && o.forToken !== file.token) {
        // A selection made on another file means nothing on this one.
        if (o.forToken) view.set('pages', '');
        view.set('forToken', file.token);
      }
      if (single) {
        const preselected = o.pages && !rangesError(o.pages, file.pageCount)
          ? R().indicesOf(R().parseRanges(o.pages, file.pageCount)).map((i) => `0:${i}`) : [];
        grid = new window.PageGrid(view.pagesHost, { pages: pagesOf(file), selected: preselected, thumb: view.pageThumb, onSelect: () => refresh() });
        mem.rotateGrid = grid;
      } else {
        mem.rotateGrid = null;
      }
      refresh();
    },
    blocked: () => null,
    onEscape() {
      return mem.rotateGrid ? mem.rotateGrid.clearSelection() : false;
    },
  },

  crop: {
    defaults: () => ({ margins: { top: 0, right: 0, bottom: 0, left: 0 }, scope: 'all', page: 0, pages: '' }),
    render(container, view) {
      const o = view.options;
      const file = firstFile(view);
      const help = ui.section(container, 'מה לשמור',
        'גרור את קצוות המסגרת על העמוד. מה שמחוץ לה יוסתר, אבל לא יימחק.');
      const row = ui.row(help);
      const auto = ui.button(row, { label: 'זיהוי שוליים', title: 'מוצא את השוליים הלבנים בכל העמודים', onClick: () => detect() });
      ui.button(row, { label: 'איפוס', kind: 'ghost', onClick: () => setMargins({ top: 0, right: 0, bottom: 0, left: 0 }) });
      const measures = ui.note(help, '', 'muted');

      const scope = ui.section(container, 'על אילו עמודים');
      ui.choice(scope, {
        value: o.scope,
        choices: [{ value: 'all', label: 'כל העמודים' }, { value: 'page', label: 'העמוד המוצג בלבד' }],
        onChange: (v) => { view.set('scope', v); syncPages(); },
      });

      if (!file || !file.token) return;
      const total = file.pageCount;
      if (o.forToken !== file.token) {
        // A frame drawn on another file is not a frame for this one.
        if (o.forToken) {
          view.set('margins', { top: 0, right: 0, bottom: 0, left: 0 });
          o.page = 0;
        }
        view.set('forToken', file.token);
      }
      if (o.page >= total) o.page = 0;

      const nav = document.createElement('div');
      nav.className = 'crop-nav';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'ghost icon';
      prev.textContent = '›';
      prev.setAttribute('aria-label', 'העמוד הקודם');
      const label = document.createElement('span');
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'ghost icon';
      next.textContent = '‹';
      next.setAttribute('aria-label', 'העמוד הבא');
      nav.append(prev, label, next);
      view.pagesHost.append(nav);

      const holder = document.createElement('div');
      holder.className = 'crop-holder';
      view.pagesHost.append(holder);

      let stage;
      const draw = () => {
        holder.replaceChildren();
        stage = previewPage(holder, view, file, o.page, 460);
        stage.classList.add('crop-stage');
        const box = document.createElement('div');
        box.className = 'crop-box';
        stage.append(box);
        for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
          const handle = document.createElement('span');
          handle.className = `crop-handle h-${h}`;
          handle.dataset.h = h;
          box.append(handle);
        }
        place();
        label.textContent = `עמוד ${o.page + 1} מתוך ${total}`;
        prev.disabled = o.page === 0;
        next.disabled = o.page === total - 1;
        wire(box);
      };
      prev.addEventListener('click', () => { o.page = Math.max(0, o.page - 1); draw(); syncPages(); });
      next.addEventListener('click', () => { o.page = Math.min(total - 1, o.page + 1); draw(); syncPages(); });

      function place() {
        const m = o.margins;
        const box = stage.querySelector('.crop-box');
        box.style.top = `${m.top * 100}%`;
        box.style.bottom = `${m.bottom * 100}%`;
        box.style.left = `${m.left * 100}%`;
        box.style.right = `${m.right * 100}%`;
        shownSizes(view, file).then((sizes) => {
          const s = sizes[o.page];
          if (!s) return;
          const mm = (frac, pts) => Math.round(frac * pts * 25.4 / 72);
          measures.textContent = Object.values(m).every((v) => !v)
            ? 'עוד לא סומן מה לחתוך.'
            : `ייחתכו: למעלה ${mm(m.top, s.height)} מ"מ, למטה ${mm(m.bottom, s.height)} מ"מ, מימין ${mm(m.right, s.width)} מ"מ, משמאל ${mm(m.left, s.width)} מ"מ.`;
        });
      }

      function setMargins(m) {
        const clamp = (v) => Math.max(0, Math.min(0.9, Math.round(v * 1000) / 1000));
        const next = { top: clamp(m.top), right: clamp(m.right), bottom: clamp(m.bottom), left: clamp(m.left) };
        // Never let the box turn inside out: keep at least 5% of the page each way.
        if (next.left + next.right > 0.95) next.right = 0.95 - next.left;
        if (next.top + next.bottom > 0.95) next.bottom = 0.95 - next.top;
        view.set('margins', next);
        o.margins = next;
        place();
      }

      function wire(box) {
        box.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const rect = stage.getBoundingClientRect();
          const start = { x: e.clientX, y: e.clientY, m: { ...o.margins } };
          const handle = e.target.dataset.h || 'move';
          box.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const dx = (ev.clientX - start.x) / rect.width;
            const dy = (ev.clientY - start.y) / rect.height;
            const m = { ...start.m };
            if (handle === 'move') {
              const w = 1 - start.m.left - start.m.right;
              const h = 1 - start.m.top - start.m.bottom;
              m.left = Math.max(0, Math.min(1 - w, start.m.left + dx));
              m.right = 1 - w - m.left;
              m.top = Math.max(0, Math.min(1 - h, start.m.top + dy));
              m.bottom = 1 - h - m.top;
            } else {
              if (handle.includes('n')) m.top = start.m.top + dy;
              if (handle.includes('s')) m.bottom = start.m.bottom - dy;
              if (handle.includes('w')) m.left = start.m.left + dx;
              if (handle.includes('e')) m.right = start.m.right - dx;
            }
            setMargins(m);
          };
          const up = () => {
            box.removeEventListener('pointermove', move);
            box.removeEventListener('pointerup', up);
            box.removeEventListener('pointercancel', up);
          };
          box.addEventListener('pointermove', move);
          box.addEventListener('pointerup', up);
          box.addEventListener('pointercancel', up);
        });
      }

      function syncPages() {
        view.set('pages', o.scope === 'page' ? String(o.page + 1) : '');
      }

      /**
       * The smallest box that holds everything printed, across pages: each sampled
       * page is drawn small and scanned for pixels that are not near white.
       */
      async function detect() {
        auto.disabled = true;
        const original = auto.textContent;
        const thumbs = await view.thumbs();
        const sample = o.scope === 'page'
          ? [o.page]
          : Array.from({ length: Math.min(total, 24) }, (_, i) => Math.floor((i * total) / Math.min(total, 24)));
        const box = { top: 1, right: 1, bottom: 1, left: 1 };
        let found = false;
        for (let k = 0; k < sample.length; k++) {
          auto.textContent = `בודק עמוד ${k + 1} מתוך ${sample.length}…`;
          const canvas = await thumbs.render(file.token, sample[k], 260);
          const m = contentMargins(canvas);
          if (!m) continue;
          found = true;
          for (const side of Object.keys(box)) box[side] = Math.min(box[side], m[side]);
        }
        auto.textContent = original;
        auto.disabled = false;
        if (!found) return view.error('לא נמצא תוכן על העמודים. אין מה לחתוך.');
        const pad = 0.012;
        setMargins({ top: box.top - pad, right: box.right - pad, bottom: box.bottom - pad, left: box.left - pad });
      }

      draw();
      syncPages();
    },
    blocked(view) {
      const m = view.options.margins || {};
      if (!['top', 'right', 'bottom', 'left'].some((k) => m[k] > 0)) {
        return 'סמן מה לשמור: גרור את קצוות המסגרת על העמוד, או לחץ על "זיהוי שוליים".';
      }
      return null;
    },
  },

  'page-numbers': {
    defaults: () => ({ position: 'bottom-center', margin: 'normal', format: 'n', start: 1, pagesMode: 'all', pages: '', size: 11, background: false }),
    render(container, view) {
      const o = view.options;
      const where = ui.section(container, 'מיקום');
      ui.position(where, { value: o.position, rows: ['top', 'bottom'], onChange: (v) => { view.set('position', v); preview(); } });
      ui.choice(where, {
        label: 'מרחק מהקצה',
        value: o.margin,
        choices: [{ value: 'small', label: 'קטן' }, { value: 'normal', label: 'רגיל' }, { value: 'large', label: 'גדול' }],
        onChange: (v) => { view.set('margin', v); preview(); },
      });

      const look = ui.section(container, 'מה ייכתב');
      ui.choice(look, {
        value: o.format,
        vertical: true,
        choices: [
          { value: 'n', label: '3' },
          { value: 'page-n', label: 'עמוד 3' },
          { value: 'n-of', label: '3 מתוך 10' },
          { value: 'page-n-of', label: 'עמוד 3 מתוך 10' },
          { value: 'n-slash', label: '3/10' },
        ],
        onChange: (v) => { view.set('format', v); preview(); },
      });
      ui.number(look, { label: 'המספר הראשון', value: o.start, min: 0, onInput: (v) => { view.set('start', v); preview(); } });
      ui.choice(look, {
        label: 'גודל',
        value: o.size,
        choices: [{ value: 9, label: 'קטן' }, { value: 11, label: 'רגיל' }, { value: 14, label: 'גדול' }],
        onChange: (v) => { view.set('size', v); preview(); },
      });
      ui.check(look, { label: 'רקע לבן מאחורי המספר', value: o.background, hint: 'שומר על המספר קריא מעל שוליים כהים של סריקה', onChange: (v) => { view.set('background', v); preview(); } });

      const which = ui.section(container, 'אילו עמודים');
      ui.choice(which, {
        value: o.pagesMode,
        vertical: true,
        choices: [
          { value: 'all', label: 'כל העמודים' },
          { value: 'skip-first', label: 'בלי העמוד הראשון' },
          { value: 'custom', label: 'עמודים מסוימים' },
        ],
        onChange: (v) => {
          view.set('pagesMode', v);
          view.set('pages', v === 'skip-first' ? '2-' : v === 'all' ? '' : view.options.customPages || '');
          view.rerender();
        },
      });
      if (o.pagesMode === 'custom') {
        ui.text(which, { value: o.pages, placeholder: 'למשל 3-', dir: 'ltr', onInput: (v) => { view.set('pages', v); view.set('customPages', v); preview(); } });
      }
      const err = ui.note(which, '', 'bad');

      const file = firstFile(view);
      let stages = [];
      if (file && file.token) {
        const row = document.createElement('div');
        row.className = 'preview-row';
        view.pagesHost.append(row);
        const shown = Math.min(file.pageCount, 2);
        for (let i = 0; i < shown; i++) stages.push(previewPage(row, view, file, i, 260));
      }

      function preview() {
        const total = file ? file.pageCount : 0;
        const error = o.pages && file ? rangesError(o.pages, total) : null;
        err.textContent = error || '';
        if (!file) return;
        const numbered = error ? [] : o.pages ? R().indicesOf(R().parseRanges(o.pages, total)) : [...Array(total).keys()];
        const last = Number(o.start) + numbered.length - 1;
        shownSizes(view, file).then((sizes) => {
          stages.forEach((stage, i) => {
            stage.querySelectorAll('.stamp').forEach((x) => x.remove());
            const k = numbered.indexOf(i);
            if (k === -1 || !sizes[i]) return;
            const n = Number(o.start) + k;
            const text = { n: `${n}`, 'page-n': `עמוד ${n}`, 'n-of': `${n} מתוך ${last}`, 'page-n-of': `עמוד ${n} מתוך ${last}`, 'n-slash': `${n}/${last}` }[o.format];
            const scale = 260 / sizes[i].width;
            const margin = { small: 18, normal: 30, large: 48 }[o.margin] * scale;
            const [vert, horiz] = o.position.split('-');
            const s = document.createElement('span');
            s.className = 'stamp' + (o.background ? ' backed' : '');
            s.dir = 'auto';
            s.textContent = text;
            s.style.fontSize = `${o.size * scale * 1.333}px`;
            s.style[vert === 'top' ? 'top' : 'bottom'] = `${margin}px`;
            if (horiz === 'center') { s.style.left = '50%'; s.style.transform = 'translateX(-50%)'; }
            else s.style[horiz] = `${margin}px`;
            stage.append(s);
          });
        });
      }
      preview();
    },
    blocked(view) {
      const file = firstFile(view);
      const o = view.options;
      if (o.pagesMode === 'custom' && !String(o.pages || '').trim()) return 'כתוב אילו עמודים למספר.';
      if (file && o.pages) {
        const err = rangesError(o.pages, file.pageCount);
        if (err) return err;
      }
      if (o.start === '' || o.start === null || !Number.isFinite(Number(o.start))) return 'כתוב את המספר הראשון.';
      return null;
    },
  },

  watermark: {
    defaults: () => ({ kind: 'text', text: '', size: 60, color: '#c00000', opacity: 0.25, angle: 45, position: 'middle-center', layer: 'over', pages: '', image: '', imageName: '', imageToken: '', scale: 0.4 }),
    render(container, view) {
      const o = view.options;
      const what = ui.section(container, 'סימן המים');
      ui.choice(what, {
        value: o.kind,
        choices: [{ value: 'text', label: 'טקסט' }, { value: 'image', label: 'תמונה' }],
        onChange: (v) => { view.set('kind', v); view.rerender(); },
      });
      if (o.kind === 'text') {
        ui.text(what, { value: o.text, placeholder: 'למשל: טיוטה, העתק, חסוי', onInput: (v) => { view.set('text', v); preview(); } });
        ui.slider(what, { label: 'גודל', value: o.size, min: 20, max: 160, step: 2, onInput: (v) => { view.set('size', v); preview(); } });
        ui.swatches(what, {
          label: 'צבע',
          value: o.color,
          colors: [
            { value: '#c00000', label: 'אדום' },
            { value: '#7f7f7f', label: 'אפור' },
            { value: '#1f5fbf', label: 'כחול' },
            { value: '#000000', label: 'שחור' },
          ],
          onChange: (v) => { view.set('color', v); preview(); },
        });
      } else {
        const row = ui.row(what);
        ui.button(row, {
          label: o.imageName ? 'החלפת תמונה' : 'בחירת תמונה…',
          onClick: async () => {
            const r = await view.pick({ extensions: ['png', 'jpg', 'jpeg'], multiple: false, title: 'תמונה לסימן המים' });
            if (!r.ok) return view.error(r.error);
            if (r.cancelled || !r.files.length) return;
            view.set('image', r.files[0].path);
            view.set('imageName', r.files[0].name);
            view.set('imageToken', r.files[0].token || '');
            view.rerender();
          },
        });
        if (o.imageName) ui.note(what, o.imageName, 'muted');
        ui.slider(what, { label: 'רוחב', value: Math.round(o.scale * 100), min: 5, max: 100, step: 5, format: (v) => `${v}%`, onInput: (v) => { view.set('scale', v / 100); preview(); } });
      }
      ui.slider(what, { label: 'שקיפות', value: Math.round((1 - o.opacity) * 100), min: 0, max: 95, step: 5, format: (v) => `${v}%`, onInput: (v) => { view.set('opacity', 1 - v / 100); preview(); } });
      ui.choice(what, {
        label: 'זווית',
        value: o.angle,
        choices: [{ value: 0, label: 'ישר' }, { value: 45, label: 'אלכסון ↗' }, { value: -45, label: 'אלכסון ↘' }, { value: 90, label: 'אנכי' }],
        onChange: (v) => { view.set('angle', v); preview(); },
      });

      const where = ui.section(container, 'מיקום');
      ui.position(where, { value: o.position, rows: ['top', 'middle', 'bottom'], extra: { value: 'tile', label: 'פריסה על כל העמוד' }, onChange: (v) => { view.set('position', v); preview(); } });
      ui.choice(where, {
        label: 'שכבה',
        value: o.layer,
        choices: [{ value: 'over', label: 'מעל התוכן' }, { value: 'under', label: 'מתחת לתוכן' }],
        onChange: (v) => { view.set('layer', v); preview(); },
      });
      ui.note(where, 'מתחת לתוכן לא ייראה בעמודים סרוקים, כי הסריקה עצמה היא תמונה שמכסה את כל העמוד.', 'muted');
      ui.text(where, { label: 'עמודים (ריק לכולם)', value: o.pages, placeholder: 'למשל 2-5', dir: 'ltr', onInput: (v) => { view.set('pages', v); } });

      const file = firstFile(view);
      let stage = null;
      if (file && file.token) {
        const row = document.createElement('div');
        row.className = 'preview-row';
        view.pagesHost.append(row);
        stage = previewPage(row, view, file, 0, 340);
      }

      function preview() {
        if (!stage) return;
        stage.querySelectorAll('.mark').forEach((x) => x.remove());
        if (o.kind === 'text' && !o.text.trim()) return;
        if (o.kind === 'image' && !o.imageToken) return;
        shownSizes(view, file).then((sizes) => {
          const s = sizes[0];
          if (!s) return;
          const scale = 340 / s.width;
          const make = () => {
            let el;
            if (o.kind === 'text') {
              el = document.createElement('span');
              el.dir = 'auto';
              el.textContent = o.text;
              el.style.fontSize = `${o.size * scale * 1.333}px`;
              el.style.color = o.color;
            } else {
              el = new Image();
              el.src = `/doc/${encodeURIComponent(o.imageToken)}`;
              el.style.width = `${o.scale * 340}px`;
            }
            el.className = 'mark';
            el.style.opacity = String(o.opacity);
            return el;
          };
          const rot = `rotate(${-o.angle}deg)`;
          if (o.position === 'tile') {
            const layer = document.createElement('div');
            layer.className = 'mark tile-layer';
            for (let i = 0; i < 12; i++) {
              const el = make();
              el.classList.remove('mark');
              el.style.transform = rot;
              layer.append(el);
            }
            stage.append(layer);
            return;
          }
          const el = make();
          const [vert, horiz] = o.position.split('-');
          const m = 36 * scale;
          el.style.position = 'absolute';
          const tx = horiz === 'center' ? '-50%' : '0';
          const ty = vert === 'middle' ? '-50%' : '0';
          if (horiz === 'center') el.style.left = '50%'; else el.style[horiz] = `${m}px`;
          if (vert === 'middle') el.style.top = '50%'; else el.style[vert] = `${m}px`;
          el.style.transform = `translate(${tx}, ${ty}) ${rot}`;
          stage.append(el);
        });
      }
      preview();
    },
    blocked(view) {
      const o = view.options;
      if (o.kind === 'text' && !String(o.text || '').trim()) return 'כתוב את הטקסט של סימן המים.';
      if (o.kind === 'image' && !o.image) return 'בחר תמונה לסימן המים.';
      const file = firstFile(view);
      if (o.pages && file && view.files.length === 1) return rangesError(o.pages, file.pageCount);
      return null;
    },
  },

  'pdf-to-markdown': {
    defaults: () => ({ pageBreaks: false }),
    render(container, view) {
      const box = ui.section(container, 'אפשרויות',
        'כותרות מזוהות לפי גודל האות, רשימות לפי הסימן שבתחילתן, ופסקאות לפי הרווח שבין השורות. עמודים סרוקים צריכים קודם זיהוי טקסט (OCR).');
      ui.check(box, { label: 'קו מפריד בין עמודים', value: view.options.pageBreaks, onChange: (v) => view.set('pageBreaks', v) });
    },
    blocked: () => null,
  },

  protect: {
    defaults: () => ({ password: '', passwordConfirm: '', allowPrint: true, allowCopy: true, allowEdit: false }),
    render(container, view) {
      const o = view.options;
      const box = ui.section(container, 'סיסמה לפתיחת הקובץ', 'מי שאין לו את הסיסמה לא יוכל לפתוח את הקובץ בכלל. ההצפנה היא AES-256.');
      ui.password(box, { label: 'סיסמה', value: o.password, onInput: (v) => view.set('password', v), autofocus: true });
      ui.password(box, { label: 'שוב, לאימות', value: o.passwordConfirm, onInput: (v) => view.set('passwordConfirm', v) });
      ui.note(box, 'שמור את הסיסמה במקום בטוח. אם היא תאבד, אין דרך לפתוח את הקובץ, גם לא בתוכנה הזו.', 'muted');

      const limits = ui.section(container, 'מה מותר למי שפותח', 'ההגבלות נשמרות על ידי תוכנות קריאת PDF. ההגנה האמיתית היא הסיסמה.');
      ui.check(limits, { label: 'הדפסה', value: o.allowPrint, onChange: (v) => view.set('allowPrint', v) });
      ui.check(limits, { label: 'העתקת טקסט', value: o.allowCopy, onChange: (v) => view.set('allowCopy', v) });
      ui.check(limits, { label: 'עריכה', value: o.allowEdit, onChange: (v) => view.set('allowEdit', v) });
    },
    blocked(view) {
      const o = view.options;
      if (!o.password) return 'כתוב סיסמה.';
      if (o.password !== o.passwordConfirm) return o.passwordConfirm ? 'הסיסמאות לא זהות. כתוב אותה שוב לאימות.' : 'כתוב את הסיסמה פעם נוספת, לאימות.';
      return null;
    },
  },

  unlock: {
    defaults: () => ({ password: '' }),
    render(container, view) {
      const box = ui.section(container, 'הסיסמה של הקובץ',
        'אם הקובץ נפתח בלי סיסמה ורק אוסר הדפסה או העתקה, אפשר להשאיר ריק.');
      ui.password(box, { label: 'סיסמה', value: view.options.password, onInput: (v) => view.set('password', v), autofocus: true });
      ui.note(box, 'הכלי מיועד לקבצים שהסיסמה שלהם ידועה לך. הוא לא מנחש סיסמאות.', 'muted');
    },
    blocked: () => null,
  },

  compress: {
    defaults: () => ({ level: 'recommended', gray: false }),
    render(container, view) {
      const box = ui.section(container, 'רמת הכיווץ');
      ui.choice(box, {
        value: view.options.level,
        vertical: true,
        choices: [
          { value: 'recommended', label: 'מומלץ: איכות טובה, קובץ קטן', title: 'תמונות ב-150 DPI. מתאים להגשה ולמייל.' },
          { value: 'strong', label: 'חזק: הקובץ הכי קטן', title: 'תמונות ב-72 DPI. טוב לצפייה במסך, פחות להדפסה.' },
          { value: 'light', label: 'קל: כמעט בלי שינוי באיכות', title: 'תמונות ב-300 DPI. להדפסה.' },
        ],
        onChange: (v) => view.set('level', v),
      });
      ui.check(box, { label: 'גם להפוך לשחור-לבן (גווני אפור)', value: view.options.gray, onChange: (v) => view.set('gray', v) });
      ui.note(box, 'הטקסט נשאר טקסט: אפשר לחפש ולהעתיק ממנו גם אחרי הכיווץ. אם הקובץ כבר קטן ככל האפשר, לא ייווצר עותק.', 'muted');
      const total = view.files.reduce((n, f) => n + (f.size || 0), 0);
      if (total) ui.note(box, `גודל עכשיו: ${ltr(`${(total / 1024 / 1024).toFixed(1)} MB`)}.`, 'muted');
    },
    blocked: () => null,
  },

  pdfa: {
    defaults: () => ({ level: '2b' }),
    render(container, view) {
      const box = ui.section(container, 'גרסת התקן', 'PDF/A הוא תקן לשמירה לטווח ארוך: כל הגופנים בתוך הקובץ, וצבעים מוגדרים.');
      ui.choice(box, {
        value: view.options.level,
        vertical: true,
        choices: [
          { value: '2b', label: 'PDF/A-2b (מומלץ)' },
          { value: '1b', label: 'PDF/A-1b (למערכות ישנות שדורשות אותו)' },
          { value: '3b', label: 'PDF/A-3b' },
        ],
        onChange: (v) => view.set('level', v),
      });
      ui.note(box, 'ההמרה לא נבדקת בכלי אימות רשמי. אם הגורם המקבל דורש אישור תקינות, יש לבדוק את הקובץ בכלי שלו.', 'muted');
    },
    blocked: () => null,
  },

  'pdf-to-jpg': {
    defaults: () => ({ mode: 'pages', format: 'jpg', dpi: 150, pages: '' }),
    render(container, view) {
      const o = view.options;
      const box = ui.section(container, 'מה להוציא');
      ui.choice(box, {
        value: o.mode,
        vertical: true,
        choices: [
          { value: 'pages', label: 'כל עמוד כתמונה' },
          { value: 'images', label: 'התמונות שבתוך הקובץ, כמו שהן' },
        ],
        onChange: (v) => { view.set('mode', v); view.rerender(); },
      });
      if (o.mode === 'pages') {
        const look = ui.section(container, 'איכות');
        ui.choice(look, { label: 'סוג קובץ', value: o.format, choices: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }], onChange: (v) => view.set('format', v) });
        ui.choice(look, {
          label: 'רזולוציה',
          value: o.dpi,
          choices: [{ value: 72, label: 'למסך' }, { value: 150, label: 'רגילה' }, { value: 300, label: 'להדפסה' }],
          onChange: (v) => view.set('dpi', v),
        });
        if (view.files.length === 1) {
          ui.text(look, { label: 'עמודים (ריק לכולם)', value: o.pages, placeholder: 'למשל 1-3', dir: 'ltr', onInput: (v) => view.set('pages', v) });
        }
      } else {
        ui.note(box, 'תמונות שנשמרו כ-JPEG יוצאות בדיוק כפי שהן, בלי איבוד איכות. בסריקות זו בדרך כלל תמונה אחת לכל עמוד.', 'muted');
      }
    },
    blocked(view) {
      const o = view.options;
      const file = firstFile(view);
      if (o.mode === 'pages' && o.pages && file && view.files.length === 1) return rangesError(o.pages, file.pageCount);
      return null;
    },
  },

  'pdf-to-ppt': {
    defaults: () => ({ quality: 'normal' }),
    render(container, view) {
      const box = ui.section(container, 'איך זה נראה',
        'כל עמוד הופך לשקופית, כתמונה של העמוד. השקופיות נראות בדיוק כמו המסמך, אבל אי אפשר לערוך בהן את הטקסט.');
      ui.choice(box, {
        label: 'איכות',
        value: view.options.quality,
        choices: [{ value: 'normal', label: 'רגילה' }, { value: 'high', label: 'גבוהה' }],
        onChange: (v) => view.set('quality', v),
      });
    },
    blocked: () => null,
  },

  ocr: {
    defaults: () => ({ langs: 'heb', alsoWord: false, alsoText: false }),
    render(container, view) {
      const box = ui.section(container, 'שפת המסמך');
      ui.choice(box, {
        value: view.options.langs,
        vertical: true,
        choices: [
          { value: 'heb', label: 'עברית (מספרים וסימנים כלולים)' },
          { value: 'heb+eng', label: 'עברית ואנגלית' },
          { value: 'eng', label: 'אנגלית' },
        ],
        onChange: (v) => view.set('langs', v),
      });
      ui.note(box, 'עברית לבדה מהירה ומדויקת יותר. כדאי להוסיף אנגלית רק כשיש במסמך מילים באנגלית.', 'muted');
      const more = ui.section(container, 'מה עוד לשמור', 'הקובץ נשאר בדיוק כפי שהוא נראה, ומקבל שכבת טקסט שאפשר לחפש בה ולהעתיק ממנה. עמודים שכבר יש בהם טקסט נשארים כמו שהם.');
      ui.check(more, { label: 'גם קובץ Word עם הטקסט', value: view.options.alsoWord, onChange: (v) => view.set('alsoWord', v) });
      ui.check(more, { label: 'גם קובץ טקסט פשוט', value: view.options.alsoText, onChange: (v) => view.set('alsoText', v) });
    },
    blocked: () => null,
  },

  scan: {
    defaults: () => ({ mode: 'gray', enhance: true, straighten: true, pageSize: 'a4', ocr: true, dpi: 300 }),
    render(container, view) {
      const o = view.options;
      const device = ui.section(container, 'מהסורק של המשרד');
      const row = ui.row(device);
      const scanButton = ui.button(row, { label: 'סריקה', kind: 'secondary' });
      const status = ui.note(device, '', 'muted');
      ui.choice(device, {
        label: 'רזולוציה',
        value: o.dpi,
        choices: [{ value: 200, label: 'רגילה' }, { value: 300, label: 'גבוהה' }],
        onChange: (v) => view.set('dpi', v),
      });
      window.api.scanAvailable().then((r) => {
        if (!r.available) {
          scanButton.disabled = true;
          scanButton.title = r.reason;
          status.textContent = r.reason;
        } else {
          status.textContent = 'עם מזין דפים כל הדפים נסרקים ברצף. במשטח זכוכית, כל לחיצה סורקת דף אחד.';
        }
      });
      let off = null;
      scanButton.addEventListener('click', async () => {
        scanButton.disabled = true;
        status.textContent = 'סורק…';
        off = window.api.onScanPage((n) => { status.textContent = `נסרקו ${pagesWord(n)}…`; });
        const r = await window.api.scanAcquire({ dpi: o.dpi, mode: o.mode });
        if (off) off();
        scanButton.disabled = false;
        if (!r.ok) {
          status.textContent = r.error;
          return;
        }
        status.textContent = r.warning || `נסרקו ${pagesWord(r.files.length)}${r.device ? ` מ-${r.device}` : ''}. אפשר לסרוק עוד או להפיק PDF.`;
        window.shell.addFiles(r.files);
      });

      const look = ui.section(container, 'ניקוי התמונה');
      ui.choice(look, {
        value: o.mode,
        choices: [{ value: 'bw', label: 'שחור-לבן' }, { value: 'gray', label: 'גווני אפור' }, { value: 'color', label: 'צבע' }],
        onChange: (v) => view.set('mode', v),
      });
      ui.check(look, { label: 'יישור דף עקום', value: o.straighten, onChange: (v) => view.set('straighten', v) });
      ui.check(look, { label: 'חידוד הניגודיות', value: o.enhance, onChange: (v) => view.set('enhance', v) });
      ui.choice(look, {
        label: 'גודל העמוד',
        value: o.pageSize,
        choices: [{ value: 'a4', label: 'A4' }, { value: 'image', label: 'כגודל התמונה' }],
        onChange: (v) => view.set('pageSize', v),
      });
      ui.check(look, { label: 'זיהוי טקסט, כדי שאפשר יהיה לחפש בקובץ', value: o.ocr, onChange: (v) => view.set('ocr', v) });
      ui.note(look, 'לחיתוך צילום טלפון לפי פינות הדף, השתמש בתוכנת סורק המסמכים. כאן מתקנים כיוון, עקמומיות קלה וניגודיות.', 'muted');
    },
    blocked: (view) => (view.files.length ? null : 'סרוק דפים או גרור תמונות JPG או PNG.'),
  },

  redact: {
    defaults: () => ({ marks: [], ocr: true }),
    render(container, view) {
      const o = view.options;
      const file = firstFile(view);
      const list = ui.section(container, 'מה יושחר');
      const summary = ui.note(list, '');
      const marksBox = document.createElement('ul');
      marksBox.className = 'mark-list';
      list.append(marksBox);
      const clearRow = ui.row(list);
      const clearAll = ui.button(clearRow, { label: 'ניקוי כל הסימונים', kind: 'ghost', onClick: () => setMarks([]) });

      const after = ui.section(container, 'עוד');
      ui.check(after, { label: 'זיהוי הטקסט מחדש, כדי שאפשר יהיה לחפש בעותק', value: o.ocr, onChange: (v) => view.set('ocr', v) });
      ui.note(after, 'כל עמוד בעותק הופך לתמונה של מה שמוצג כאן, ומה שהושחר נמחק באמת: אי אפשר להעתיק אותו, לחפש אותו או לשחזר אותו. שום דבר מהקובץ המקורי שאינו נראה במסך לא עובר לעותק: לא תוכן של הערות, לא שכבות מוסתרות, לא קבצים מצורפים ולא פרטי המסמך.', 'muted');

      if (!file || !file.token) return;
      if (o.forToken && o.forToken !== file.token) o.marks = [];
      view.set('forToken', file.token);
      const total = file.pageCount;
      let pageIndex = 0;
      let found = [];

      // Search bar and page navigation, above the page.
      const bar = document.createElement('div');
      bar.className = 'redact-bar';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'חיפוש טקסט להשחרה';
      const presets = document.createElement('div');
      presets.className = 'redact-presets';
      const PATTERNS = [
        // Israeli ID numbers are nine digits, often written as eight without the leading zero.
        { label: 'מספרי זהות', re: /\b\d{8,9}\b|\b\d{7,8}-\d\b/g },
        { label: 'טלפונים', re: /\b0\d{1,2}-?\d{7}\b|\b0\d{1,2}-\d{3}-?\d{4}\b/g },
        { label: 'דוא"ל', re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g },
        { label: 'כרטיסי אשראי', re: /\b(?:\d[ -]?){12,15}\d\b/g },
      ];
      const markFound = document.createElement('button');
      markFound.type = 'button';
      markFound.className = 'primary small';
      markFound.disabled = true;
      markFound.hidden = true;
      const foundNote = document.createElement('span');
      foundNote.className = 'redact-found';
      bar.append(search);
      for (const pattern of PATTERNS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = pattern.label;
        b.addEventListener('click', () => findAll(pattern.re, pattern.label));
        presets.append(b);
      }
      bar.append(presets, foundNote, markFound);
      view.pagesHost.append(bar);

      const nav = document.createElement('div');
      nav.className = 'crop-nav';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'ghost icon';
      prev.textContent = '›';
      prev.setAttribute('aria-label', 'העמוד הקודם');
      const label = document.createElement('span');
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'ghost icon';
      next.textContent = '‹';
      next.setAttribute('aria-label', 'העמוד הבא');
      nav.append(prev, label, next);
      view.pagesHost.append(nav);
      const hint = document.createElement('p');
      hint.className = 'opt-hint redact-hint';
      hint.textContent = 'גרור על העמוד כדי לסמן אזור להשחרה. לחיצה על סימון מסירה אותו.';
      view.pagesHost.append(hint);

      const holder = document.createElement('div');
      holder.className = 'crop-holder';
      view.pagesHost.append(holder);
      let stage = null;

      const setMarks = (marks) => {
        o.marks = marks;
        view.set('marks', marks);
        paintMarks();
        paintList();
      };

      function draw() {
        holder.replaceChildren();
        stage = previewPage(holder, view, file, pageIndex, 520);
        stage.classList.add('redact-stage');
        label.textContent = `עמוד ${pageIndex + 1} מתוך ${total}`;
        prev.disabled = pageIndex === 0;
        next.disabled = pageIndex === total - 1;
        wireDraw();
        paintMarks();
      }

      function paintMarks() {
        if (!stage) return;
        stage.querySelectorAll('.redact-mark, .redact-hit').forEach((el) => el.remove());
        for (const hit of found.filter((h) => h.page === pageIndex)) {
          const el = box('redact-hit', hit);
          stage.append(el);
        }
        o.marks.forEach((m, k) => {
          if (m.page !== pageIndex) return;
          const el = box('redact-mark', m);
          el.title = 'לחיצה מסירה את הסימון';
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          el.addEventListener('click', () => setMarks(o.marks.filter((_, i) => i !== k)));
          stage.append(el);
        });
      }

      function box(cls, m) {
        const el = document.createElement('div');
        el.className = cls;
        el.style.left = `${m.x * 100}%`;
        el.style.top = `${m.y * 100}%`;
        el.style.width = `${m.w * 100}%`;
        el.style.height = `${m.h * 100}%`;
        return el;
      }

      function paintList() {
        const pages = new Set(o.marks.map((m) => m.page));
        summary.textContent = o.marks.length
          ? `${o.marks.length === 1 ? 'סימון אחד' : `${o.marks.length} סימונים`} ב-${pages.size === 1 ? 'עמוד אחד' : `${pages.size} עמודים`}.`
          : 'עוד לא סומן דבר. גרור על העמוד, או חפש טקסט.';
        clearAll.disabled = !o.marks.length;
        marksBox.replaceChildren();
        [...pages].sort((a, b) => a - b).forEach((p) => {
          const li = document.createElement('li');
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'link';
          const n = o.marks.filter((m) => m.page === p).length;
          go.textContent = `עמוד ${p + 1}: ${n === 1 ? 'סימון אחד' : `${n} סימונים`}`;
          go.addEventListener('click', () => { pageIndex = p; draw(); });
          li.append(go);
          marksBox.append(li);
        });
      }

      function wireDraw() {
        stage.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const rect = stage.getBoundingClientRect();
          const sx = (e.clientX - rect.left) / rect.width;
          const sy = (e.clientY - rect.top) / rect.height;
          const ghost = box('redact-mark drawing', { x: sx, y: sy, w: 0, h: 0 });
          stage.append(ghost);
          try { stage.setPointerCapture(e.pointerId); } catch {}
          let cur = { x: sx, y: sy, w: 0, h: 0 };
          const move = (ev) => {
            const ex = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            const ey = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
            cur = { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
            Object.assign(ghost.style, { left: `${cur.x * 100}%`, top: `${cur.y * 100}%`, width: `${cur.w * 100}%`, height: `${cur.h * 100}%` });
          };
          const up = () => {
            stage.removeEventListener('pointermove', move);
            stage.removeEventListener('pointerup', up);
            ghost.remove();
            if (cur.w > 0.005 && cur.h > 0.004) setMarks([...o.marks, { page: pageIndex, ...cur }]);
          };
          stage.addEventListener('pointermove', move);
          stage.addEventListener('pointerup', up);
        });
      }

      /** Where a match sits inside a run of text, by its share of the characters. */
      // Where a match sits is estimated from its share of the characters, which a
      // proportional font or mixed Hebrew and digits can throw off. So the box reaches a
      // full average character further on each side: covering too much is safe, too
      // little is not.
      function subBox(b, start, end) {
        const len = b.str.length || 1;
        const s = Math.max(0, start - 1);
        const e2 = Math.min(len, end + 1);
        if (b.vertical) return { x: b.x - b.w * 0.1, y: b.y + (b.h * s) / len, w: b.w * 1.2, h: (b.h * (e2 - s)) / len };
        const from = b.rtl ? 1 - e2 / len : s / len;
        return { x: b.x + b.w * from, y: b.y - b.h * 0.1, w: (b.w * (e2 - s)) / len, h: b.h * 1.2 };
      }

      async function findAll(re, what) {
        foundNote.textContent = 'מחפש…';
        markFound.disabled = true;
        const thumbs = await view.thumbs();
        const hits = [];
        for (let p = 0; p < total; p++) {
          const boxes = await thumbs.textBoxes(file.token, p);
          for (const b of boxes) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(b.str))) {
              if (!m[0]) { re.lastIndex++; continue; }
              hits.push({ page: p, ...subBox(b, m.index, m.index + m[0].length), text: m[0] });
              if (!re.global) break;
            }
          }
        }
        found = hits;
        const pages = new Set(hits.map((h) => h.page));
        foundNote.textContent = hits.length
          ? `${hits.length === 1 ? 'נמצאה תוצאה אחת' : `נמצאו ${hits.length} תוצאות`} ל${what} ב-${pages.size === 1 ? 'עמוד אחד' : `${pages.size} עמודים`}.`
          : `לא נמצאו ${what}. בקובץ סרוק בלי טקסט, הפעל קודם זיהוי טקסט (OCR).`;
        markFound.textContent = hits.length === 1 ? 'סמן להשחרה' : `סמן את כל ${hits.length}`;
        markFound.disabled = !hits.length;
        markFound.hidden = !hits.length;
        if (hits.length && !pages.has(pageIndex)) pageIndex = hits[0].page;
        draw();
      }

      markFound.addEventListener('click', () => {
        const pad = 0.002;
        setMarks([...o.marks, ...found.map((h) => ({ page: h.page, x: h.x - pad, y: h.y - pad, w: h.w + pad * 2, h: h.h + pad * 2 }))]);
        found = [];
        foundNote.textContent = '';
        markFound.disabled = true;
        markFound.hidden = true;
        markFound.textContent = '';
        paintMarks();
      });
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !search.value.trim()) return;
        const escaped = search.value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        findAll(new RegExp(escaped, 'gi'), `"${search.value.trim()}"`);
      });
      prev.addEventListener('click', () => { pageIndex = Math.max(0, pageIndex - 1); draw(); });
      next.addEventListener('click', () => { pageIndex = Math.min(total - 1, pageIndex + 1); draw(); });

      mem.redactFind = findAll;
      draw();
      paintList();
    },
    blocked(view) {
      return (view.options.marks || []).length ? null : 'סמן מה להשחיר: גרור על העמוד, או חפש טקסט וסמן את התוצאות.';
    },
  },

  'pdf-to-excel': {
    defaults: () => ({ layout: 'page' }),
    render(container, view) {
      const box = ui.section(container, 'איך לסדר',
        'טבלאות הופכות לשורות ועמודות, ושאר הטקסט נכנס לעמודה הראשונה, כך ששום דבר לא הולך לאיבוד. טבלאות בעברית נשמרות מימין לשמאל.');
      ui.choice(box, {
        value: view.options.layout,
        choices: [{ value: 'page', label: 'גיליון לכל עמוד' }, { value: 'one', label: 'הכל בגיליון אחד' }],
        onChange: (v) => view.set('layout', v),
      });
      ui.note(box, 'עמודים סרוקים עוברים קודם זיהוי טקסט. במקרה כזה כדאי לבדוק את המספרים מול המקור.', 'muted');
    },
    blocked: () => null,
  },

  edit: {
    defaults: () => ({ objects: [] }),
    render(container, view) {
      const file = firstFile(view);
      const help = ui.section(container, 'איך עורכים',
        'בחר כלי בסרגל שמעל העמוד ולחץ או גרור על העמוד. לחיצה כפולה על טקסט עורכת אותו, Delete מוחק את הנבחר, Ctrl+Z מבטל.');
      const count = ui.note(help, '', 'muted');
      ui.note(help, 'מחיקה בלבן רק מכסה במראה: הטקסט שמתחת נשאר בקובץ ואפשר להעתיק אותו. למחיקה אמיתית של מידע רגיש השתמש בכלי "השחרה".', 'muted');
      if (!file || !file.token) return;
      if (view.options.forToken && view.options.forToken !== file.token) view.set('objects', []);
      view.set('forToken', file.token);
      const paint = () => {
        const n = view.options.objects.length;
        count.textContent = n ? `${n === 1 ? 'פריט אחד' : `${n} פריטים`} על העמודים.` : 'עוד לא נוסף דבר.';
      };
      const editor = new window.PageEditor(view.pagesHost, {
        token: file.token,
        pageCount: file.pageCount,
        objects: view.options.objects,
        tools: ['select', 'text', 'image', 'rect', 'ellipse', 'line', 'arrow', 'path', 'highlight', 'whiteout'],
        thumb: view.pageThumb,
        sizes: shownSizes(view, file),
        onChange: (objects) => {
          view.set('objects', objects.map(({ id, ...o }) => o));
          paint();
        },
        pickImage: async () => {
          const r = await view.pick({ extensions: ['png', 'jpg', 'jpeg'], multiple: false, title: 'תמונה להוספה' });
          if (!r.ok || r.cancelled || !r.files.length || !r.files[0].token) return null;
          return dataUrlOf(`/doc/${encodeURIComponent(r.files[0].token)}`);
        },
      });
      mem.editor = editor;
      paint();
    },
    blocked: (view) => ((view.options.objects || []).length ? null : 'הוסף משהו לעמוד: בחר כלי בסרגל ולחץ על העמוד.'),
    onEscape: () => (mem.editor ? mem.editor.escape() : false),
  },

  sign: {
    defaults: () => ({ objects: [], certificate: '', certificateName: '', certPassword: '', name: '' }),
    render(container, view) {
      const o = view.options;
      const file = firstFile(view);
      let current = null; // what a click on the page places

      const mine = ui.section(container, 'החתימות שלי', 'בחר חתימה ולחץ על המקום בעמוד. החתימות נשמרות רק במחשב הזה.');
      const gallery = document.createElement('div');
      gallery.className = 'sig-gallery';
      mine.append(gallery);
      ui.button(mine, { label: 'חתימה חדשה…', onClick: () => openSignatureMaker(async (dataUrl, kind) => {
        const r = await window.api.signaturesSave({ dataUrl, kind });
        if (!r.ok) return view.error(r.error);
        await loadGallery(r.signature.id);
      }) });

      const more = ui.section(container, 'עוד להוסיף');
      ui.text(more, { label: 'שם החותם', value: o.name, placeholder: 'למשל: עו"ד רון קלנר', onInput: (v) => view.set('name', v) });
      const quick = ui.row(more);
      const today = () => {
        const d = new Date();
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      };
      const initials = (name) => name.replace(/עו"ד|עו״ד|ד"ר|ד״ר/g, '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join('.') + '.';
      const choose = (label, make) => ui.button(quick, { label, onClick: () => {
        const item = make();
        if (!item) return view.error('כתוב קודם את שם החותם.');
        current = item;
        placing.textContent = `לחץ על המקום בעמוד כדי להוסיף: ${label}.`;
        if (editor) editor.setTool('place');
      } });
      const textItem = (text) => ({ type: 'text', text, size: 13, color: '#1a1a1a', align: 'right', w: Math.max(0.12, text.length * 0.012), h: 0.022 });
      choose('שם', () => (o.name.trim() ? textItem(o.name.trim()) : null));
      choose('תאריך', () => textItem(today()));
      choose('ראשי תיבות', () => (o.name.trim() ? textItem(initials(o.name)) : null));
      const placing = ui.note(more, '', 'muted');

      const cert = ui.section(container, 'חתימה דיגיטלית (לא חובה)',
        'עם קובץ תעודה (pfx) הקובץ נחתם גם דיגיטלית: Acrobat יראה מי חתם, וכל שינוי אחרי החתימה יבטל אותה. בלי תעודה, החתימה חזותית בלבד.');
      const certRow = ui.row(cert);
      ui.button(certRow, { label: o.certificateName ? 'החלפת תעודה' : 'בחירת קובץ תעודה…', onClick: async () => {
        const r = await view.pick({ extensions: ['pfx', 'p12'], multiple: false, title: 'קובץ תעודה לחתימה דיגיטלית' });
        if (!r.ok || r.cancelled || !r.files.length) return;
        view.set('certificate', r.files[0].path);
        view.set('certificateName', r.files[0].name);
        view.rerender();
      } });
      if (o.certificateName) {
        ui.button(certRow, { label: 'הסרה', kind: 'ghost', onClick: () => { view.set('certificate', ''); view.set('certificateName', ''); view.rerender(); } });
        ui.note(cert, o.certificateName, 'muted');
        ui.password(cert, { label: 'סיסמת התעודה', value: o.certPassword, onInput: (v) => view.set('certPassword', v) });
      }

      async function loadGallery(selectId) {
        const r = await window.api.signaturesList();
        gallery.replaceChildren();
        const list = r.ok ? r.signatures : [];
        if (!list.length) {
          const empty = document.createElement('p');
          empty.className = 'opt-hint';
          empty.textContent = 'עוד אין חתימות שמורות. לחץ "חתימה חדשה" כדי ליצור אחת.';
          gallery.append(empty);
        }
        for (const sig of list) {
          const card = document.createElement('div');
          card.className = 'sig-card';
          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'sig-pick';
          pick.title = 'לחץ ואז לחץ על העמוד';
          const img = new Image();
          img.src = sig.dataUrl;
          img.alt = 'חתימה';
          pick.append(img);
          pick.addEventListener('click', () => {
            gallery.querySelectorAll('.sig-pick').forEach((b) => b.classList.toggle('on', b === pick));
            const probe = new Image();
            probe.onload = () => {
              const w = 0.22;
              const sizes = editor ? editor.pageH / editor.pageW : 1.414;
              current = { type: 'image', src: sig.dataUrl, w, h: (w * probe.naturalHeight / probe.naturalWidth) / sizes };
              placing.textContent = 'לחץ על המקום בעמוד כדי להציב את החתימה. אפשר לגרור ולהגדיל אותה אחר כך.';
              if (editor) editor.setTool('place');
            };
            probe.src = sig.dataUrl;
          });
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'ghost icon remove';
          del.textContent = '✕';
          del.title = 'מחיקת החתימה השמורה';
          del.addEventListener('click', async () => {
            if (!window.confirm('למחוק את החתימה השמורה הזו? חתימות שכבר הוצבו בקבצים לא יושפעו.')) return;
            await window.api.signaturesRemove(sig.id);
            loadGallery();
          });
          card.append(pick, del);
          gallery.append(card);
          if (sig.id === selectId) pick.click();
        }
      }
      loadGallery();

      let editor = null;
      if (file && file.token) {
        if (o.forToken && o.forToken !== file.token) view.set('objects', []);
        view.set('forToken', file.token);
        editor = new window.PageEditor(view.pagesHost, {
          token: file.token,
          pageCount: file.pageCount,
          objects: o.objects,
          tools: ['select'],
          thumb: view.pageThumb,
          sizes: shownSizes(view, file),
          onChange: (objects) => view.set('objects', objects.map(({ id, ...x }) => x)),
          placeItem: () => {
            const item = current;
            editor.setTool('select');
            placing.textContent = '';
            return item;
          },
        });
        mem.editor = editor;
      }
    },
    blocked(view) {
      const o = view.options;
      if (!(o.objects || []).length && !o.certificate) return 'בחר חתימה ולחץ על המקום בעמוד.';
      if (o.certificate && !o.certPassword) return 'כתוב את סיסמת קובץ התעודה.';
      return null;
    },
    onEscape: () => (mem.editor ? mem.editor.escape() : false),
  },

  forms: {
    defaults: () => ({ values: {}, flatten: false, objects: [] }),
    render(container, view) {
      const o = view.options;
      const file = firstFile(view);
      const fieldsBox = ui.section(container, 'שדות הטופס');
      const list = document.createElement('div');
      list.className = 'field-list';
      fieldsBox.append(list);
      const status = ui.note(fieldsBox, 'קורא את הטופס…', 'muted');
      const create = ui.section(container, 'שדות חדשים', 'בחר סוג שדה בסרגל שמעל העמוד וגרור על העמוד כדי למקם אותו.');
      const newList = document.createElement('div');
      newList.className = 'field-list';
      create.append(newList);
      const finish = ui.section(container, 'סיום');
      ui.check(finish, { label: 'השטחה: השדות הופכים לחלק מהעמוד ולא ניתנים לעריכה', value: o.flatten, onChange: (v) => view.set('flatten', v) });

      if (!file || !file.token) return;
      if (o.forToken && o.forToken !== file.token) {
        view.set('values', {});
        view.set('objects', []);
      }
      view.set('forToken', file.token);
      let fields = [];
      const inputs = new Map();

      const syncCreate = () => {
        const made = (o.objects || []).filter((x) => x.type === 'field');
        view.set('create', made.map((x) => ({ type: x.kind === 'checkbox' ? 'checkbox' : x.kind === 'dropdown' ? 'dropdown' : x.kind === 'signature' ? 'signature' : 'text', name: x.name, page: x.page, x: x.x, y: x.y, w: x.w, h: x.h, options: x.options || [], align: 'right' })));
        newList.replaceChildren();
        made.forEach((x) => {
          const row = document.createElement('label');
          row.className = 'field-row';
          const kind = document.createElement('span');
          kind.className = 'field-kind';
          kind.textContent = { text: 'טקסט', checkbox: 'סימון', dropdown: 'רשימה', signature: 'חתימה' }[x.kind] || 'טקסט';
          const name = document.createElement('input');
          name.type = 'text';
          name.value = x.name;
          name.addEventListener('input', () => {
            editor.update(x.id, (obj) => { obj.name = name.value; }, { record: false });
          });
          row.append(kind, name);
          if (x.kind === 'dropdown') {
            const opts = document.createElement('input');
            opts.type = 'text';
            opts.placeholder = 'אפשרויות, מופרדות בפסיק';
            opts.value = (x.options || []).join(', ');
            opts.addEventListener('input', () => editor.update(x.id, (obj) => { obj.options = opts.value.split(',').map((t) => t.trim()).filter(Boolean); }, { record: false }));
            row.append(opts);
          }
          newList.append(row);
        });
      };

      const overlay = (page) => {
        const els = [];
        for (const f of fields) {
          for (const b of f.boxes.filter((bx) => bx.page === page)) {
            const el = document.createElement('div');
            el.className = 'form-box' + (o.values[f.name] !== undefined ? ' filled' : '');
            Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
            el.title = f.name;
            el.addEventListener('pointerdown', (e) => {
              e.stopPropagation();
              const input = inputs.get(f.name);
              if (input) input.focus();
            });
            els.push(el);
          }
        }
        return els;
      };

      const editor = new window.PageEditor(view.pagesHost, {
        token: file.token,
        pageCount: file.pageCount,
        objects: o.objects,
        tools: ['select', 'field-text', 'field-checkbox', 'field-dropdown', 'field-signature'],
        thumb: view.pageThumb,
        sizes: shownSizes(view, file),
        overlay,
        onChange: (objects) => {
          let n = (fields.length || 0) + 1;
          const taken = new Set(fields.map((f) => f.name));
          for (const x of objects) {
            if (x.type === 'field' && !x.name) {
              while (taken.has(`שדה ${n}`)) n++;
              x.name = `שדה ${n}`;
              taken.add(x.name);
            }
          }
          view.set('objects', objects);
          syncCreate();
        },
      });
      mem.editor = editor;

      window.api.formsRead(file.path).then((r) => {
        if (!r.ok) {
          status.textContent = r.error;
          return;
        }
        fields = r.fields;
        status.textContent = fields.length
          ? `${fields.length === 1 ? 'שדה אחד' : `${fields.length} שדות`} בטופס. לחיצה על שדה בעמוד מעבירה אליו.`
          : 'בקובץ הזה אין שדות למילוי. אפשר להוסיף שדות חדשים.';
        list.replaceChildren();
        for (const f of fields) {
          const row = document.createElement('label');
          row.className = 'field-row';
          const name = document.createElement('span');
          name.className = 'field-name';
          name.textContent = f.name;
          row.append(name);
          let input;
          const current = o.values[f.name] !== undefined ? o.values[f.name] : f.value;
          const setValue = (v) => {
            view.set('values', { ...view.options.values, [f.name]: v });
            editor.paint();
          };
          if (f.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = current === true || current === 'true';
            input.addEventListener('change', () => setValue(input.checked));
          } else if (f.type === 'radio' || f.type === 'dropdown' || f.type === 'list') {
            input = document.createElement('select');
            for (const c of ['', ...f.choices]) {
              const opt = document.createElement('option');
              opt.value = c;
              opt.textContent = c || '(ללא בחירה)';
              if (c === current) opt.selected = true;
              input.append(opt);
            }
            input.addEventListener('change', () => setValue(input.value));
          } else if (f.type === 'signature') {
            input = document.createElement('span');
            input.className = 'opt-hint';
            input.textContent = 'שדה חתימה: חתום עליו בכלי "חתימה על PDF".';
          } else {
            input = document.createElement('input');
            input.type = 'text';
            input.dir = 'auto';
            input.value = current || '';
            input.addEventListener('input', () => setValue(input.value));
          }
          if (f.readOnly && input.tagName !== 'SPAN') {
            input.disabled = true;
            input.title = 'השדה הזה נעול לעריכה בטופס עצמו.';
          }
          row.append(input);
          inputs.set(f.name, input);
          list.append(row);
        }
        editor.paint();
        syncCreate();
      });
    },
    blocked(view) {
      const o = view.options;
      const named = (o.create || []).every((c) => String(c.name || '').trim());
      if (!named) return 'לכל שדה חדש צריך שם.';
      if (!Object.keys(o.values || {}).length && !(o.create || []).length && !o.flatten) return 'מלא שדה, הוסף שדה חדש, או סמן השטחה.';
      return null;
    },
    onEscape: () => (mem.editor ? mem.editor.escape() : false),
  },

  'word-to-pdf': officePanel('Word', 'המסמך נפתח ב-Word שמותקן במחשב ונשמר כ-PDF, בדיוק כמו "שמירה בשם" ב-Word עצמו.'),
  'ppt-to-pdf': officePanel('PowerPoint', 'המצגת נפתחת ב-PowerPoint שמותקן במחשב ונשמרת כ-PDF, שקופית בכל עמוד.'),
  'excel-to-pdf': officePanel('Excel', 'הגיליון נפתח ב-Excel שמותקן במחשב ונשמר כ-PDF כפי שהוא מודפס, כל הגיליונות בקובץ.'),
  'pdf-to-word': {
    defaults: () => ({}),
    render(container) {
      ui.section(container, 'איך זה עובד',
        'Word פותח את ה-PDF ובונה ממנו מסמך שאפשר לערוך: פסקאות, טבלאות וכיוון הכתיבה. קובץ סרוק עובר קודם זיהוי טקסט, והמסמך נבנה מהטקסט שזוהה בעיצוב פשוט.');
    },
    blocked: () => null,
  },

  summarize: {
    defaults: () => ({ length: 'standard', language: 'he', focus: ['facts', 'parties', 'dates', 'amounts', 'claims', 'deadlines'] }),
    render(container, view) {
      const o = view.options;
      cloudNotice(container);
      const box = ui.section(container, 'אורך');
      ui.choice(box, {
        value: o.length,
        choices: [{ value: 'short', label: 'קצר' }, { value: 'standard', label: 'רגיל' }, { value: 'detailed', label: 'מפורט' }],
        onChange: (v) => view.set('length', v),
      });
      ui.choice(box, { label: 'שפת הסיכום', value: o.language, choices: [{ value: 'he', label: 'עברית' }, { value: 'en', label: 'אנגלית' }], onChange: (v) => view.set('language', v) });
      const focus = ui.section(container, 'מה לכלול');
      const labels = { facts: 'העובדות', parties: 'הצדדים', dates: 'תאריכים', amounts: 'סכומים', claims: 'הטענות', deadlines: 'מועדים ופעולות נדרשות' };
      for (const [key, label] of Object.entries(labels)) {
        ui.check(focus, {
          label,
          value: o.focus.includes(key),
          onChange: (on) => view.set('focus', on ? [...new Set([...view.options.focus, key])] : view.options.focus.filter((k) => k !== key)),
        });
      }
      ui.note(focus, 'הסיכום נשמר כקובץ Word ליד המסמך.', 'muted');
    },
    blocked: (view) => (view.options.focus.length ? null : 'בחר לפחות נושא אחד לסיכום.'),
  },

  translate: {
    defaults: () => ({ target: 'en' }),
    render(container, view) {
      cloudNotice(container);
      const box = ui.section(container, 'לאיזו שפה');
      ui.choice(box, {
        value: view.options.target,
        vertical: true,
        choices: [
          { value: 'en', label: 'אנגלית' }, { value: 'he', label: 'עברית' }, { value: 'ar', label: 'ערבית' },
          { value: 'ru', label: 'רוסית' }, { value: 'fr', label: 'צרפתית' }, { value: 'es', label: 'ספרדית' },
          { value: 'de', label: 'גרמנית' }, { value: 'am', label: 'אמהרית' },
        ],
        onChange: (v) => view.set('target', v),
      });
      ui.note(box, 'התרגום נשמר כקובץ Word וכ-PDF. כל הטקסט מתורגם, כולל טבלאות וחותמות, אבל העיצוב פשוט מהמקור ולא עמוד מול עמוד.', 'muted');
    },
    blocked: () => null,
  },

  // The panel every saved workflow's tile opens with.
  __workflow: {
    defaults: () => ({ steps: [], name: '', secrets: {} }),
    render(container, view) {
      const meta = window.shell.view.tools.find((t) => t.id === window.shell.view.toolId);
      const wf = meta && meta.workflow;
      if (!wf) return;
      view.set('steps', wf.steps);
      view.set('name', wf.name);
      if (!view.options.secrets) view.set('secrets', {});
      if (wf.steps.some((step) => step.toolId === 'summarize' || step.toolId === 'translate')) cloudNotice(container, 'התהליך הזה');
      const box = ui.section(container, 'השלבים', 'כל קובץ עובר את השלבים לפי הסדר. רק התוצאה האחרונה נשמרת, ליד הקובץ המקורי.');
      const list = document.createElement('ol');
      list.className = 'wf-summary';
      for (const step of wf.steps) {
        const t = window.shell.view.tools.find((x) => x.id === step.toolId);
        const li = document.createElement('li');
        li.textContent = t ? t.name : step.toolId;
        list.append(li);
      }
      box.append(list);
      // Passwords for steps that need one, entered now and never saved.
      wf.steps.forEach((step, k) => {
        if (step.toolId !== 'protect' && step.toolId !== 'unlock') return;
        const s = ui.section(container, step.toolId === 'protect' ? `סיסמה להגנה (שלב ${k + 1})` : `סיסמת הקבצים (שלב ${k + 1})`);
        const set = (key, v) => {
          const all = { ...(view.options.secrets || {}) };
          all[k] = { ...(all[k] || {}), [key]: v };
          view.set('secrets', all);
        };
        ui.password(s, { label: 'סיסמה', value: '', onInput: (v) => set('password', v) });
        if (step.toolId === 'protect') ui.password(s, { label: 'שוב, לאימות', value: '', onInput: (v) => set('passwordConfirm', v) });
      });
      const row = ui.row(ui.section(container));
      ui.button(row, { label: 'עריכת התהליך', onClick: () => window.shell.openBuilder(wf) });
      ui.button(row, { label: 'מחיקה', kind: 'ghost', onClick: async () => {
        if (!window.confirm(`למחוק את התהליך "${wf.name}"? קבצים שכבר נוצרו בו לא יימחקו.`)) return;
        await window.api.workflowsRemove(wf.id);
        await window.shell.refreshTools();
        window.shell.goHome();
      } });
    },
    blocked(view) {
      const steps = view.options.steps || [];
      for (const [k, step] of steps.entries()) {
        const sec = (view.options.secrets || {})[k] || {};
        if (step.toolId === 'protect') {
          if (!sec.password) return `כתוב את הסיסמה להגנה (שלב ${k + 1}).`;
          if (sec.password !== sec.passwordConfirm) return `הסיסמאות של שלב ${k + 1} לא זהות.`;
        }
      }
      if (steps[0] && steps[0].toolId === 'merge' && view.files.length < 2) return 'התהליך מתחיל באיחוד: הוסף לפחות שני קבצים.';
      return null;
    },
  },

  repair: {
    defaults: () => ({}),
    render(container) {
      ui.section(container, 'איך זה עובד',
        'התיקון קורא כל מה שעוד אפשר לקרוא בקובץ ובונה ממנו קובץ חדש ותקין. הקובץ המקורי לא משתנה, והתוצאה תגיד כמה עמודים שוחזרו.');
    },
    blocked: () => null,
  },
};

/** What Split will produce, for the preview line, the page badges, and the button. */
function splitPlan(o, total) {
  const tone = (i) => i;
  const labelled = (groups) => {
    const pages = Array.from({ length: total }, (_, i) => ({ key: `0:${i}`, index: i, turn: 0, dim: true }));
    groups.forEach((indices, g) => indices.forEach((i) => {
      pages[i] = { ...pages[i], dim: false, label: groups.length > 1 ? `קובץ ${g + 1}` : 'בקובץ', tone: tone(g) };
    }));
    return pages;
  };
  try {
    if (o.mode === 'every') {
      const n = Math.floor(Number(o.every));
      if (!Number.isFinite(n) || n < 1) return { error: 'כתוב כל כמה עמודים לפצל, מספר של 1 ומעלה.' };
      if (n >= total) return { error: `בקובץ ${pagesWord(total)}, ולכן חלוקה כל ${n} עמודים תשאיר אותו שלם.` };
      const groups = [];
      for (let s = 0; s < total; s += n) groups.push([...Array(Math.min(n, total - s)).keys()].map((k) => s + k));
      return { text: `ייווצרו ${filesWord(groups.length)}, בתיקייה חדשה ליד המקור.`, pages: labelled(groups) };
    }
    if (o.mode === 'extract') {
      if (!String(o.pages || '').trim()) return { error: 'בחר את העמודים לחילוץ: לחיצה על עמוד, Ctrl להוספה, Shift לטווח.' };
      const idx = R().indicesOf(R().parseRanges(o.pages, total));
      return { text: o.extractEach ? `ייווצרו ${filesWord(idx.length)}, עמוד בכל קובץ.` : `ייווצר קובץ אחד בן ${pagesWord(idx.length)}.` };
    }
    if (o.mode === 'size') {
      const mb = Number(o.maxMb);
      if (!Number.isFinite(mb) || mb <= 0) return { error: 'כתוב גודל מרבי לכל חלק, במגה-בייט.' };
      return { text: `כל חלק יהיה עד ${ltr(`${mb} MB`)}. מספר החלקים ייקבע לפי העמודים.` };
    }
    if (!String(o.ranges || '').trim()) return { error: 'כתוב את הטווחים, למשל 1-3, 4-6. כל טווח יהפוך לקובץ.' };
    const ranges = R().parseRanges(o.ranges, total);
    const groups = ranges.map(({ from, to }) => [...Array(to - from + 1).keys()].map((k) => from - 1 + k));
    if (o.mergeRanges) {
      return { text: `ייווצר קובץ אחד בן ${pagesWord(groups.flat().length)}.`, pages: labelled([groups.flat()]) };
    }
    return {
      text: groups.length === 1
        ? `ייווצר קובץ אחד: עמ' ${R().formatRange(ranges[0])}.`
        : `ייווצרו ${filesWord(groups.length)}: ${ranges.map((r) => `עמ' ${R().formatRange(r)}`).join(', ')}.`,
      pages: labelled(groups),
    };
  } catch (err) {
    return { error: hebrewOr(err, 'לא ניתן לקרוא את רשימת העמודים.') };
  }
}

/** Fractions of white space on each side of a rendered page, or null if it is blank. */
function contentMargins(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = h;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null;
  return { top: top / h, bottom: (h - 1 - bottom) / h, left: left / w, right: (w - 1 - right) / w };
}

// Ctrl+Z in Organize undoes the last change, unless the focus is in a text field.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (!window.shell || window.shell.screen !== 'tool' || window.shell.view.toolId !== 'organize') return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  if (mem.organizeUndo) mem.organizeUndo();
});

window.panels = panels;
window.panelUi = ui;
window.panelHelpers = { splitPlan, contentMargins, mem };
