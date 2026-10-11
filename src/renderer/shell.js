'use strict';

/*
 * The frame around every tool: the home grid, the shared tool screen, and moving
 * between them. The appendix builder keeps its own screen and code (app.js); this file
 * only shows and hides it.
 */

const shell = (() => {
  const $ = (id) => document.getElementById(id);

  const view = {
    screen: 'home',
    tools: [],
    groups: [],
    toolId: null,
    perTool: new Map(), // toolId -> { files, options }, so going back never loses work
    pending: [],        // files dropped on the home screen, waiting for a tool
    job: null,          // { id, toolId, cancelRequested }
    query: '',
  };

  const KB = 1024;
  function sizeText(bytes) {
    if (!bytes) return '';
    if (bytes < KB * KB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
    return `${(bytes / KB / KB).toFixed(bytes < 10 * KB * KB ? 1 : 0)} MB`;
  }
  const pageWord = (n) => (n === 1 ? 'עמוד אחד' : `${n} עמודים`);

  /*
   * A file name, laid out so it reads correctly in either script. The whole name takes
   * the direction of its first letter, and the extension is isolated as left-to-right.
   * Without this, "פרוטוקול מיום 07-07-26.pdf" shows as "pdf.07-07-26" at the end of a
   * Hebrew line, and a Latin name with a Hebrew suffix scrambles the other way.
   */
  const HEBREW = /[\u0590-\u05FF]/;
  const STRONG = /[A-Za-z\u00C0-\u024F\u0590-\u05FF]/;
  function nameNode(name, className = 'file-name') {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const first = (stem.match(STRONG) || [''])[0];
    const outer = document.createElement('bdi');
    outer.className = className;
    outer.dir = HEBREW.test(first) ? 'rtl' : 'ltr';
    outer.title = name;
    const a = document.createElement('bdi');
    a.className = 'name-stem';
    a.textContent = stem;
    outer.append(a);
    if (ext) {
      const b = document.createElement('bdi');
      b.className = 'name-ext';
      b.dir = 'ltr';
      b.textContent = ext;
      outer.append(b);
    }
    return outer;
  }

  /** "7 עמודים · 147 KB" with the Latin measure kept in its own order. */
  function metaNode(parts, className) {
    const span = document.createElement('span');
    span.className = className;
    parts.filter(Boolean).forEach((part, i) => {
      if (i) span.append(document.createTextNode(' · '));
      const b = document.createElement('bdi');
      if (/^[\d.,]+ (KB|MB)$/.test(part)) b.dir = 'ltr';
      b.textContent = part;
      span.append(b);
    });
    return span;
  }

  function relativeWhen(iso) {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return '';
    const time = when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(when)) / 86400000);
    if (days <= 0) return `היום, ${time}`;
    if (days === 1) return `אתמול, ${time}`;
    if (days < 7) return `לפני ${days} ימים`;
    return when.toLocaleDateString('he-IL');
  }

  const tool = (id) => view.tools.find((t) => t.id === id) || null;
  // A saved workflow's tile shares one panel; every other tool has its own.
  const panelFor = (id) => window.panels[id] || (String(id).startsWith('wf:') ? window.panels.__workflow : null);

  // The file dialog, replaceable in tests: a real dialog would open on screen and wait.
  let picker = (spec) => window.api.pickFiles(spec);
  const NOT_YET = 'הכלי הזה עדיין לא זמין בגרסה הזו.';

  /* ---------------- thumbnails ---------------- */

  // thumbs.mjs is a module and runs after this classic script, so wait for it.
  const thumbsReady = new Promise((resolve) => {
    if (window.thumbs) resolve(window.thumbs);
    else document.addEventListener('thumbs-ready', () => resolve(window.thumbs), { once: true });
  });

  const thumbCache = new Map(); // token -> Promise<dataURL>

  function thumbnail(file, width = 56) {
    if (!file.token || file.error) return Promise.resolve(null);
    // A picture is its own thumbnail.
    if (['jpg', 'jpeg', 'png'].includes(file.ext)) return Promise.resolve(`/doc/${encodeURIComponent(file.token)}`);
    if (file.ext !== 'pdf') return Promise.resolve(null);
    return pageThumb(file.token, 0, width, file.name);
  }

  /** A data URL of one page, `width` CSS pixels wide; cached for the session. */
  function pageThumb(token, index, width, label = '') {
    const key = `${token}:${index}:${width}`;
    if (!thumbCache.has(key)) {
      thumbCache.set(key, thumbsReady
        .then((t) => t.render(token, index, width))
        .then((canvas) => canvas.toDataURL('image/png'))
        .catch((err) => {
          // A missing thumbnail leaves the generic file icon, which is still usable;
          // say why in the console rather than nowhere.
          console.warn(`thumbnail: ${label} page ${index + 1}: ${err && err.message}`);
          thumbCache.delete(key);
          return null;
        }));
    }
    return thumbCache.get(key);
  }

  /* ---------------- moving between screens ---------------- */

  function setHeader(title, sub) {
    $('screen-name').textContent = title;
    $('screen-sub').textContent = sub;
  }

  function show(screen) {
    view.screen = screen;
    for (const section of document.querySelectorAll('main > .screen')) {
      section.classList.toggle('hidden', section.dataset.screen !== screen);
    }
    $('nav-back').classList.toggle('hidden', screen === 'home');
    // The history tab belongs to the appendix builder's own filings.
    $('history-tab').classList.toggle('hidden', screen !== 'appendix');
    document.body.dataset.screen = screen;
    window.scrollTo({ top: 0 });
  }

  /** The back button says why it is waiting rather than ignoring the press. */
  function setBackBlocked(reason) {
    const back = $('nav-back');
    back.disabled = !!reason;
    back.title = reason || 'חזרה (Esc)';
  }

  function goHome() {
    // A run must finish or be cancelled first; so must a filing being built.
    if (view.job) return;
    if (view.screen === 'appendix' && window.appendixBusy && window.appendixBusy()) return;
    view.toolId = null;
    setHeader('כלי המשרד', 'כל כלי ה-PDF של המשרד במקום אחד. הקבצים נשארים במחשב, חוץ מבשני הכלים שמסומנים "בענן".');
    show('home');
    renderHome();
    loadRecent();
    $('home-search').focus();
  }

  /**
   * Open a tool. `files` (already described by the main process) and `options` replace
   * what the screen held; without them the screen comes back as it was left.
   */
  function open(id, { files, options } = {}) {
    const t = tool(id);
    if (!t) return;
    if (t.screen === 'appendix') {
      setHeader(t.name, 'כתב טענות ונספחים לתיק מוגמר עם חוצצים, תוכן עניינים ומספור רץ.');
      show('appendix');
      return;
    }
    if (t.screen === 'workflow') {
      openBuilder(null);
      return;
    }

    view.toolId = id;
    const panel = panelFor(id);
    let state = view.perTool.get(id);
    if (!state) {
      state = { files: [], options: panel ? panel.defaults() : {} };
      view.perTool.set(id, state);
    }
    if (files) state.files = t.multiple ? files.slice() : files.slice(0, 1);
    if (options) state.options = { ...(panel ? panel.defaults() : {}), ...options };

    setHeader(t.name, t.description);
    show('tool');
    clearResult();
    renderTool();
  }

  /* ---------------- home ---------------- */

  function matches(t, q) {
    if (!q) return true;
    return `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(q);
  }

  function accepts(t, files) {
    if (!files.length) return true;
    return files.every((f) => t.accepts.includes(f.ext));
  }

  function renderHome() {
    const q = view.query.trim().toLowerCase();
    const host = $('home-groups');
    host.replaceChildren();
    let shown = 0;

    for (const group of view.groups) {
      const items = view.tools.filter((t) => t.group === group.id && matches(t, q));
      if (!items.length) continue;
      shown += items.length;

      const section = document.createElement('section');
      section.className = 'tool-group';
      const h = document.createElement('h2');
      h.className = 'group-title';
      h.textContent = group.name;
      const grid = document.createElement('div');
      grid.className = 'tool-grid';
      for (const t of items) grid.append(tile(t));
      section.append(h, grid);
      host.append(section);
    }
    $('home-none').classList.toggle('hidden', shown > 0);
    renderPending();
  }

  function tile(t) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.tool = t.id;
    const fits = accepts(t, view.pending);
    if (!t.available) b.classList.add('unavailable');
    if (view.pending.length && !fits) b.classList.add('dim');

    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = t.name;
    const desc = document.createElement('span');
    desc.className = 'tile-desc';
    desc.textContent = t.description;
    const top = document.createElement('span');
    top.className = 'tile-top';
    top.append(window.icons.toolIcon(t, 38));
    if (!t.available) {
      const soon = document.createElement('span');
      soon.className = 'tile-tag tile-soon';
      soon.textContent = t.reason === NOT_YET ? 'בקרוב' : 'לא זמין';
      top.append(soon);
    }
    if (t.cloud) {
      const tag = document.createElement('span');
      tag.className = 'tile-tag tile-cloud';
      tag.textContent = 'בענן';
      tag.title = 'הכלי הזה שולח את טקסט המסמך לשירות בינה מלאכותית. כל שאר הכלים עובדים רק במחשב.';
      top.append(tag);
    }
    b.append(top, name, desc);
    b.title = t.available ? t.description : t.reason;

    b.addEventListener('click', () => {
      if (view.pending.length && !fits) return; // the dimmed tile says why on hover
      const files = view.pending.length ? view.pending : undefined;
      view.pending = [];
      open(t.id, { files });
    });
    if (view.pending.length && !fits) {
      b.title = `${t.name} לא מקבל את סוג הקבצים שגררת.`;
      b.setAttribute('aria-disabled', 'true');
    }
    return b;
  }

  function renderPending() {
    const bar = $('home-pending');
    if (!view.pending.length) {
      bar.classList.add('hidden');
      return;
    }
    const n = view.pending.length;
    $('home-pending-text').textContent =
      `${n === 1 ? `הקובץ "${view.pending[0].name}" מוכן` : `${n} קבצים מוכנים`}. בחר מה לעשות ${n === 1 ? 'איתו' : 'איתם'}:`;
    bar.classList.remove('hidden');
  }

  async function loadRecent() {
    const response = await window.api.runsList();
    const list = $('recent-list');
    list.replaceChildren();
    if (!response.ok || !response.entries.length) {
      $('recent').classList.add('hidden');
      return;
    }
    for (const entry of response.entries.slice(0, 6)) list.append(recentRow(entry));
    $('recent').classList.remove('hidden');
  }

  function recentRow(entry) {
    const t = tool(entry.toolId);
    const li = document.createElement('li');
    li.className = 'recent-item';
    if (t) li.append(window.icons.toolIcon(t, 30));

    const text = document.createElement('div');
    text.className = 'recent-text';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = t ? t.name : entry.toolId;
    const files = document.createElement('span');
    files.className = 'recent-files';
    entry.inputNames.forEach((n, i) => {
      if (i) files.append(document.createTextNode(' · '));
      files.append(nameNode(n, 'recent-name'));
    });
    files.title = entry.inputNames.join('\n');
    text.append(title, files);

    const when = document.createElement('span');
    when.className = 'recent-when';
    when.textContent = relativeWhen(entry.savedAt);

    const actions = document.createElement('div');
    actions.className = 'recent-actions';
    const firstOut = entry.outputs.findIndex((_, i) => entry.outputsExist[i]);
    if (firstOut !== -1) {
      actions.append(smallButton('פתח', 'פתח את התוצאה', () => window.api.openFile(entry.outputs[firstOut])));
      actions.append(smallButton('בתיקייה', 'הצג בתיקייה', () => window.api.revealFile(entry.outputs[firstOut])));
    } else {
      const gone = document.createElement('span');
      gone.className = 'recent-gone';
      gone.textContent = 'התוצאה הוזזה או נמחקה';
      actions.append(gone);
    }
    if (t && t.available && !t.screen) {
      actions.append(smallButton('שוב', 'פתח את הכלי עם אותם קבצים והגדרות', () => repeat(entry)));
    }

    li.append(text, when, actions);
    return li;
  }

  function smallButton(label, title, onClick, kind = 'ghost') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${kind} small`;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  async function repeat(entry) {
    const response = await window.api.describeFiles(entry.inputs);
    if (!response.ok) return;
    open(entry.toolId, { files: response.files, options: entry.options });
  }

  /* ---------------- a tool ---------------- */

  const current = () => view.perTool.get(view.toolId);

  function panelView() {
    const state = current();
    return {
      files: state.files,
      options: state.options,
      set(key, value) {
        state.options[key] = value;
        updateRun();
      },
      sortFiles(how) {
        if (how === 'name') state.files.sort((a, b) => a.name.localeCompare(b.name, 'he', { numeric: true }));
        if (how === 'reverse') state.files.reverse();
        renderFiles();
      },
      rerender: () => renderOptions(),
      pagesHost: $('tool-pages'),
      pageThumb,
      thumbs: () => thumbsReady,
      error: (message) => showError(message),
      clearError: () => clearResult(),
      busy: () => !!view.job,
      describe: async (paths) => {
        const r = await window.api.describeFiles(paths);
        return r.ok ? r.files : [];
      },
      pick: (spec) => picker(spec),
      run: () => run(),
    };
  }

  function renderTool() {
    const t = tool(view.toolId);
    const banner = $('tool-unavailable');
    banner.textContent = t.available ? '' : t.reason;
    banner.classList.toggle('hidden', t.available);
    if (!t.available && t.cloud) {
      // The way out of "off until a key is entered" is one press away.
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'link';
      go.textContent = 'פתיחת ההגדרות';
      go.addEventListener('click', openSettings);
      banner.append(' ', go);
    }

    const kinds = [...new Set(t.accepts.map((e) => (e === 'pdf' ? 'PDF' : e.toUpperCase())))];
    $('tool-drop-title').textContent = t.multiple
      ? `גרור לכאן קבצים (${kinds.slice(0, 4).join(', ')})`
      : `גרור לכאן קובץ (${kinds.slice(0, 4).join(', ')})`;
    $('tool-browse').textContent = t.multiple ? 'בחר קבצים' : 'בחר קובץ';
    $('tool-run').textContent = t.runLabel || t.name;

    renderFiles();
    renderOptions();
  }

  let currentPanelView = null;

  function renderOptions() {
    const host = $('tool-options');
    host.replaceChildren();
    $('tool-pages').replaceChildren();
    const panel = panelFor(view.toolId);
    currentPanelView = panelView();
    if (panel) panel.render(host, currentPanelView);
    updateRun();
  }

  let dragFrom = null;

  function renderFiles() {
    const t = tool(view.toolId);
    const state = current();
    const list = $('tool-file-list');
    list.replaceChildren();

    const any = state.files.length > 0;
    $('tool-drop-empty').classList.toggle('hidden', any);
    $('tool-drop-more').classList.toggle('hidden', !any);
    $('tool-add').classList.toggle('hidden', !t.multiple);
    $('tool-add').textContent = 'הוסף קבצים';
    const pages = state.files.reduce((n, f) => n + (f.pageCount || 0), 0);
    $('tool-file-count').textContent = any
      ? `${state.files.length === 1 ? 'קובץ אחד' : `${state.files.length} קבצים`}${pages ? ` · ${pageWord(pages)}` : ''}`
      : '';

    state.files.forEach((file, index) => {
      const li = document.createElement('li');
      li.className = 'file-row' + (file.error && !(file.encrypted && t.acceptsEncrypted) ? ' bad' : '');
      li.dataset.index = String(index);

      if (t.multiple && state.files.length > 1) {
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          dragFrom = index;
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-row', String(index));
        });
        li.addEventListener('dragend', () => {
          dragFrom = null;
          li.classList.remove('dragging');
          list.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
        });
        li.addEventListener('dragover', (e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          list.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
          li.classList.add('drop-before');
        });
        li.addEventListener('drop', (e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          e.stopPropagation();
          moveFile(dragFrom, index);
        });
      }

      const thumb = document.createElement('div');
      thumb.className = 'file-thumb';
      thumb.append(window.icons.toolIcon({ id: 'file', icon: 'file' }, 28));
      thumbnail(file).then((url) => {
        if (!url) return;
        const img = new Image();
        img.src = url;
        img.alt = '';
        thumb.replaceChildren(img);
      });

      const text = document.createElement('div');
      text.className = 'file-text';
      const name = nameNode(file.name);
      let meta;
      if (file.encrypted && t.acceptsEncrypted) {
        meta = metaNode(['מוגן בסיסמה', sizeText(file.size)], 'file-meta');
      } else if (file.error) {
        meta = document.createElement('span');
        meta.className = 'file-error';
        meta.textContent = file.error;
      } else {
        meta = metaNode([file.pageCount ? pageWord(file.pageCount) : '', sizeText(file.size)], 'file-meta');
      }
      text.append(name, meta);

      const buttons = document.createElement('div');
      buttons.className = 'row-buttons';
      if (t.multiple && state.files.length > 1) {
        buttons.append(
          iconButton('▲', 'הזז למעלה', index === 0, () => moveFile(index, index - 1)),
          iconButton('▼', 'הזז למטה', index === state.files.length - 1, () => moveFile(index, index + 1)),
        );
      }
      buttons.append(iconButton('✕', 'הסר מהרשימה', false, () => removeFile(index), 'remove'));

      const order = document.createElement('span');
      order.className = 'file-order';
      order.textContent = t.multiple && state.files.length > 1 ? String(index + 1) : '';

      li.append(order, thumb, text, buttons);
      list.append(li);
    });
    updateRun();
  }

  function iconButton(glyph, label, disabled, onClick, extra = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ghost icon ${extra}`.trim();
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function moveFile(from, to) {
    const files = current().files;
    if (to < 0 || to >= files.length || from === to) return;
    const [moved] = files.splice(from, 1);
    files.splice(to, 0, moved);
    clearResult();
    renderFiles();
    renderOptions();
  }

  function removeFile(index) {
    current().files.splice(index, 1);
    clearResult();
    renderFiles();
    renderOptions();
  }

  /** Add described files to the open tool, skipping ones already there and wrong types. */
  function addFiles(files) {
    const t = tool(view.toolId);
    const state = current();
    const wrong = files.filter((f) => !t.accepts.includes(f.ext));
    const right = files.filter((f) => t.accepts.includes(f.ext));
    if (!t.multiple) {
      state.files = right.slice(0, 1);
    } else {
      const have = new Set(state.files.map((f) => f.path.toLowerCase()));
      for (const f of right) if (!have.has(f.path.toLowerCase())) state.files.push(f);
    }
    clearResult();
    renderFiles();
    renderOptions();
    if (wrong.length) {
      showError(`${wrong.length === 1 ? `הקובץ "${wrong[0].name}" לא נוסף` : `${wrong.length} קבצים לא נוספו`}: ${t.name} מקבל רק ${t.accepts.map((e) => e.toUpperCase()).join(', ')}.`);
    } else if (!t.multiple && right.length > 1) {
      showError(`${t.name} עובד על קובץ אחד בכל פעם, ולכן נלקח רק "${right[0].name}".`);
    }
  }

  function blockedReason() {
    const t = tool(view.toolId);
    const state = current();
    if (!t.available) return t.reason;
    if (!state.files.length) return t.multiple ? 'בחר קבצים כדי להתחיל.' : 'בחר קובץ כדי להתחיל.';
    // The thumbnails are drawn by pdf.js and the tools read pages with pdf-lib; a file the
    // two count differently waits for Repair (see shownPageCount in pdf/inspect.js).
    const firstStep = t.workflow && t.workflow.steps && t.workflow.steps[0];
    if (t.id !== 'repair' && !(firstStep && firstStep.toolId === 'repair')) {
      const odd = state.files.find((f) => f.pagesAgree === false);
      if (odd) return `בקובץ "${odd.name}" יש עמודים שתוכנות שונות סופרות אחרת, ולכן אי אפשר לעבוד עליו בבטחה. הרץ עליו קודם את "תיקון PDF", ועבוד על הקובץ המתוקן.`;
    }
    // Only Unlock takes a password-protected file; for every other tool it is a problem.
    const bad = state.files.find((f) => f.error && !(f.encrypted && t.acceptsEncrypted));
    if (bad) return `${bad.error} הסר אותו מהרשימה כדי להמשיך.`;
    if (t.min && state.files.length < t.min) {
      const panel = panelFor(view.toolId);
      const said = panel && panel.blocked && panel.blocked(panelView());
      return said || `נדרשים לפחות ${t.min} קבצים.`;
    }
    const panel = panelFor(view.toolId);
    return (panel && panel.blocked && panel.blocked(panelView())) || null;
  }

  function updateRun() {
    if (view.screen !== 'tool' || !view.toolId) return;
    const reason = blockedReason();
    const busy = !!view.job;
    $('tool-run').disabled = !!reason || busy;
    $('tool-blocked').textContent = busy ? '' : reason || '';
    for (const id of ['tool-browse', 'tool-add', 'tool-clear']) $(id).disabled = busy;
    setBackBlocked(busy ? 'אפשר לחזור אחרי שהפעולה תסתיים, או לבטל אותה (Esc).' : '');
    $('tool-options').classList.toggle('locked', busy);
    $('tool-file-list').classList.toggle('locked', busy);
  }

  function showError(message) {
    $('tool-error').textContent = message;
    $('tool-error').classList.remove('hidden');
  }

  function clearResult() {
    $('tool-error').classList.add('hidden');
    $('tool-result').classList.add('hidden');
  }

  /* ---------------- running ---------------- */

  async function run() {
    if (view.job || blockedReason()) return;
    const t = tool(view.toolId);
    const state = current();
    clearResult();

    view.job = { id: null, toolId: t.id, cancelRequested: false };
    setProgress(0, 'מתחיל…');
    $('tool-progress').classList.remove('hidden');
    updateRun();
    if (typeof updateRestartButton === 'function') updateRestartButton();

    const panel = panelFor(t.id);
    const inputs = panel && panel.inputs ? panel.inputs(panelView()) : state.files.map((f) => f.path);
    const response = await window.api.startJob({
      toolId: t.id,
      inputs,
      options: JSON.parse(JSON.stringify(state.options)),
    });

    view.job = null;
    $('tool-progress').classList.add('hidden');
    updateRun();
    if (typeof updateRestartButton === 'function') updateRestartButton();

    if (!response.ok) {
      showError(response.cancelled ? 'הפעולה בוטלה. לא נשמר שום קובץ.' : response.error);
      return;
    }
    showResult(t, response);
  }

  function setProgress(fraction, text) {
    $('tool-progress-fill').style.width = `${Math.round(fraction * 100)}%`;
    if (text) $('tool-progress-text').textContent = text;
  }

  function cancel() {
    if (!view.job) return false;
    view.job.cancelRequested = true;
    $('tool-progress-text').textContent = 'מבטל…';
    if (view.job.id) window.api.cancelJob(view.job.id);
    return true;
  }

  window.api.onJobStarted(({ id, toolId }) => {
    if (!view.job || view.job.toolId !== toolId) return;
    view.job.id = id;
    // Esc may have been pressed before the main process said which job this is.
    if (view.job.cancelRequested) window.api.cancelJob(id);
  });

  window.api.onJobProgress(({ id, fraction, text }) => {
    if (!view.job || (view.job.id && view.job.id !== id) || view.job.cancelRequested) return;
    setProgress(fraction, text);
  });

  const CONTINUE_WITH = ['merge', 'compress', 'page-numbers', 'watermark', 'sign', 'protect', 'ocr', 'split', 'organize', 'rotate'];

  function showResult(t, response) {
    $('tool-result-title').textContent = response.summary || 'הפעולה הסתיימה.';
    const list = $('tool-result-outputs');
    list.replaceChildren();
    const shown = response.display && response.display.length ? response.display : response.outputs;
    for (const out of shown) {
      const li = document.createElement('li');
      const name = nameNode(out.split(/[\\/]/).pop(), 'out-name');
      name.title = out;
      li.append(
        name,
        smallButton('פתח', 'פתח את הקובץ', () => window.api.openFile(out), 'secondary'),
        smallButton('הצג בתיקייה', 'הצג את הקובץ בתיקייה שלו', () => window.api.revealFile(out)),
      );
      list.append(li);
    }

    const pdfs = shown.filter((p) => /\.pdf$/i.test(p));
    const chips = $('tool-continue-chips');
    chips.replaceChildren();
    const next = CONTINUE_WITH.map(tool).filter((x) => x && x.available && x.id !== t.id);
    for (const n of next) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.tool = n.id;
      b.append(window.icons.toolIcon(n, 20), document.createTextNode(n.name));
      b.addEventListener('click', async () => {
        const described = await window.api.describeFiles(pdfs);
        if (described.ok) open(n.id, { files: described.files });
      });
      chips.append(b);
    }
    $('tool-continue').classList.toggle('hidden', !pdfs.length || !next.length);
    $('tool-result').classList.remove('hidden');
  }

  /* ---------------- files in ---------------- */

  async function browse() {
    const t = tool(view.toolId);
    const response = await picker({ extensions: t.accepts, multiple: t.multiple, title: t.name });
    if (!response.ok) return showError(response.error);
    if (!response.cancelled) addFiles(response.files);
  }

  function pathsFrom(event) {
    return Array.from(event.dataTransfer.files)
      .map((file) => window.api.pathForFile(file))
      .filter(Boolean);
  }

  let dragDepth = 0;
  const veil = () => $('drag-veil');
  const isFileDrag = (e) => Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) {
      const t = view.screen === 'tool' ? tool(view.toolId) : null;
      $('drag-veil-text').textContent = view.screen === 'home'
        ? 'שחרר, ואז בחר מה לעשות עם הקבצים'
        : t ? `שחרר כדי להוסיף ל${t.name}` : 'שחרר כדי להוסיף';
      veil().classList.remove('hidden');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      veil().classList.add('hidden');
    }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil().classList.add('hidden');
    if (!isFileDrag(e)) return;
    if (view.job) return;

    if (view.screen === 'appendix') {
      if (typeof handleAppendixDrop === 'function') handleAppendixDrop(e);
      return;
    }

    const paths = pathsFrom(e);
    if (!paths.length) return;
    const response = await window.api.describeFiles(paths);
    if (response.ok) receiveFiles(response.files);
  });

  /** Files arriving by drop: into the open tool, or held on the home screen for a tool. */
  function receiveFiles(files) {
    if (view.screen === 'tool') {
      addFiles(files);
    } else if (view.screen === 'home') {
      view.pending = files;
      renderHome();
    }
  }

  /* ---------------- keys ---------------- */

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // The appendix builder's history drawer closes itself first.
      if (typeof historyView !== 'undefined' && historyView.open) return;
      if (cancel()) {
        e.preventDefault();
        return;
      }
      const panel = view.screen === 'tool' ? panelFor(view.toolId) : null;
      if (panel && panel.onEscape && currentPanelView && panel.onEscape(currentPanelView)) {
        e.preventDefault();
        return;
      }
      if (view.screen === 'home' && view.pending.length) {
        view.pending = [];
        renderHome();
        return;
      }
      if (view.screen === 'home' && view.query) {
        view.query = '';
        $('home-search').value = '';
        renderHome();
        return;
      }
      if (view.screen !== 'home' && !isTyping(e.target)) {
        e.preventDefault();
        goHome();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o' && view.screen === 'tool' && !view.job) {
      e.preventDefault();
      browse();
    }
  });

  function isTyping(target) {
    return target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type !== 'button' && target.value));
  }

  /* ---------------- wiring ---------------- */

  $('nav-back').addEventListener('click', goHome);
  $('nav-settings').addEventListener('click', openSettings);

  /* ---------------- workflow builder ---------------- */

  const builder = { id: null, steps: [] };

  /** Build a new workflow, or edit a saved one (`saved` is its tile's workflow). */
  async function openBuilder(saved) {
    if (view.job) return;
    builder.id = saved ? saved.id : null;
    builder.steps = saved ? saved.steps.map((s) => ({ toolId: s.toolId, options: JSON.parse(JSON.stringify(s.options || {})) })) : [];
    $('wf-name').value = saved ? saved.name : '';
    $('wf-error').textContent = '';
    setHeader(saved ? `עריכת ${saved.name}` : 'תהליך עבודה חדש', 'כמה כלים ברצף, לפעולה אחת שחוזרת על עצמה. התוצאה של כל שלב עוברת לשלב הבא.');
    show('workflow');
    const r = await window.api.workflowsSteps();
    builder.allowed = r.ok ? [...r.steps, ...r.last] : [];
    builder.last = r.ok ? r.last : [];
    const pickTool = $('wf-add-tool');
    pickTool.replaceChildren();
    for (const id of builder.allowed) {
      const t = tool(id);
      if (!t) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.name + (builder.last.includes(id) ? ' (שלב אחרון)' : '');
      pickTool.append(opt);
    }
    renderBuilder();
    $('wf-name').focus();
  }

  function renderBuilder() {
    const host = $('wf-steps');
    host.replaceChildren();
    $('wf-empty').classList.toggle('hidden', builder.steps.length > 0);
    builder.steps.forEach((step, i) => {
      const t = tool(step.toolId);
      const card = document.createElement('section');
      card.className = 'wf-step';
      const head = document.createElement('div');
      head.className = 'wf-step-head';
      const num = document.createElement('span');
      num.className = 'step';
      num.textContent = String(i + 1);
      const name = document.createElement('h3');
      name.textContent = t ? t.name : step.toolId;
      head.append(num, window.icons.toolIcon(t || { id: 'file', icon: 'file' }, 26), name);
      const buttons = document.createElement('div');
      buttons.className = 'row-buttons';
      buttons.append(
        iconButton('▲', 'הזז למעלה', i === 0, () => { builder.steps.splice(i - 1, 0, builder.steps.splice(i, 1)[0]); renderBuilder(); }),
        iconButton('▼', 'הזז למטה', i === builder.steps.length - 1, () => { builder.steps.splice(i + 1, 0, builder.steps.splice(i, 1)[0]); renderBuilder(); }),
        iconButton('✕', 'הסר שלב', false, () => { builder.steps.splice(i, 1); renderBuilder(); }, 'remove'),
      );
      head.append(buttons);
      const body = document.createElement('div');
      body.className = 'wf-step-body tool-options';
      card.append(head, body);
      host.append(card);
      renderStepOptions(step, body);
    });
    const why = problemOf(builder.steps);
    $('wf-error').textContent = builder.steps.length ? why || '' : '';
  }

  /** A step's options, drawn by the tool's own panel, without files or passwords. */
  function renderStepOptions(step, body) {
    body.replaceChildren();
    const panel = panelFor(step.toolId);
    if (!panel) return;
    if (!step.options || !Object.keys(step.options).length) step.options = panel.defaults();
    const stepView = {
      files: [],
      options: step.options,
      set(key, value) { step.options[key] = value; },
      rerender: () => renderStepOptions(step, body),
      pagesHost: document.createElement('div'),
      pageThumb: () => Promise.resolve(null),
      thumbs: () => new Promise(() => {}),
      error: (message) => { $('wf-error').textContent = message; },
      clearError: () => { $('wf-error').textContent = ''; },
      busy: () => false,
      describe: async () => [],
      pick: (spec) => picker(spec),
      sortFiles: () => {},
      run: () => {},
    };
    panel.render(body, stepView);
    // Passwords are asked for each time the workflow runs; they are never saved.
    body.querySelectorAll('input[type=password]').forEach((el) => {
      const field = el.closest('.field');
      if (field) field.remove();
    });
    if (/password/i.test(JSON.stringify(panel.defaults()))) {
      const note = document.createElement('p');
      note.className = 'opt-preview muted';
      note.textContent = 'הסיסמה לא נשמרת בתהליך: היא תתבקש בכל הפעלה.';
      body.prepend(note);
    }
  }

  function problemOf(steps) {
    if (!steps.length) return 'הוסף לפחות שלב אחד.';
    for (let i = 0; i < steps.length; i++) {
      if (builder.last.includes(steps[i].toolId) && i !== steps.length - 1) return 'פיצול, או המרה לקובץ שאינו PDF, יכולים להיות רק השלב האחרון.';
      if (steps[i].toolId === 'merge' && i !== 0) return 'איחוד יכול להיות רק השלב הראשון.';
      if (steps[i].toolId === 'protect' && i !== steps.length - 1) return 'הגנה בסיסמה יכולה להיות רק השלב האחרון: אחריה אף כלי לא יוכל לפתוח את הקובץ.';
      if (steps[i].toolId === 'unlock' && i !== 0) return 'הסרת סיסמה יכולה להיות רק השלב הראשון.';
      if (steps[i].toolId === 'protect' && i !== steps.length - 1) return 'הגנה בסיסמה יכולה להיות רק השלב האחרון: אחריה אף כלי לא יוכל לפתוח את הקובץ.';
      if (steps[i].toolId === 'unlock' && i !== 0) return 'הסרת סיסמה יכולה להיות רק השלב הראשון.';
    }
    return null;
  }

  $('wf-add').addEventListener('click', () => {
    const id = $('wf-add-tool').value;
    const panel = panelFor(id);
    builder.steps.push({ toolId: id, options: panel ? panel.defaults() : {} });
    renderBuilder();
  });
  $('wf-save').addEventListener('click', async () => {
    const name = $('wf-name').value.trim();
    if (!name) {
      $('wf-error').textContent = 'תן שם לתהליך.';
      $('wf-name').focus();
      return;
    }
    const why = problemOf(builder.steps);
    if (why) {
      $('wf-error').textContent = why;
      return;
    }
    const r = await window.api.workflowsSave({ id: builder.id, name, steps: builder.steps });
    if (!r.ok) {
      $('wf-error').textContent = r.error;
      return;
    }
    await refreshTools();
    open(`wf:${r.workflow.id}`);
  });
  $('wf-cancel').addEventListener('click', () => goHome());

  /* ---------------- settings ---------------- */

  async function openSettings() {
    if (view.job) return;
    setHeader('הגדרות', 'מפתח ה-API לכלי הבינה המלאכותית.');
    show('settings');
    $('settings-result').textContent = '';
    $('settings-key').value = '';
    await paintSettings();
  }

  async function paintSettings() {
    const r = await window.api.settingsGet();
    const hint = r.ok && r.apiKeyHint;
    $('settings-status').textContent = hint ? `מפתח שמור: ${hint}. הכלים פעילים.` : 'לא נשמר מפתח. הכלים כבויים.';
    $('settings-status').classList.toggle('on', !!hint);
    $('settings-clear').disabled = !hint;
  }

  async function refreshTools() {
    const response = await window.api.listTools();
    if (response.ok) view.tools = response.tools;
  }

  $('settings-show').addEventListener('click', () => {
    const input = $('settings-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('settings-show').textContent = show ? 'הסתר' : 'הצג';
  });
  $('settings-save').addEventListener('click', async () => {
    const key = $('settings-key').value.trim();
    const result = $('settings-result');
    if (!key) {
      result.textContent = 'הדבק את המפתח בשדה.';
      result.className = 'opt-preview bad';
      return;
    }
    $('settings-save').disabled = true;
    result.textContent = 'בודק את המפתח מול Anthropic…';
    result.className = 'opt-preview';
    const r = await window.api.settingsSetKey(key);
    $('settings-save').disabled = false;
    $('settings-key').value = '';
    if (!r.ok) {
      result.textContent = r.error;
      result.className = 'opt-preview bad';
    } else {
      result.textContent = r.warning || 'המפתח נשמר ונבדק. כלי הסיכום והתרגום פעילים.';
      result.className = r.warning ? 'opt-preview bad' : 'opt-preview good';
    }
    await paintSettings();
    await refreshTools();
  });
  $('settings-clear').addEventListener('click', async () => {
    if (!window.confirm('להסיר את המפתח? כלי הסיכום והתרגום ייכבו.')) return;
    await window.api.settingsClearKey();
    $('settings-result').textContent = 'המפתח הוסר.';
    $('settings-result').className = 'opt-preview';
    await paintSettings();
    await refreshTools();
  });
  $('tool-browse').addEventListener('click', browse);
  $('tool-add').addEventListener('click', browse);
  $('tool-clear').addEventListener('click', () => {
    current().files = [];
    clearResult();
    renderFiles();
    renderOptions();
  });
  $('tool-run').addEventListener('click', run);
  $('tool-cancel').addEventListener('click', cancel);
  $('home-search').addEventListener('input', () => {
    view.query = $('home-search').value;
    renderHome();
  });
  $('home-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = document.querySelector('.tile:not(.dim)');
    if (first) first.click();
  });
  $('home-pending-clear').addEventListener('click', () => {
    view.pending = [];
    renderHome();
  });

  async function start() {
    const response = await window.api.listTools();
    if (response.ok) {
      view.tools = response.tools;
      view.groups = response.groups;
    }
    goHome();
  }

  const ready = start();

  return {
    ready,
    open,
    goHome,
    openSettings,
    openBuilder,
    refreshTools,
    show,
    setBackBlocked,
    setPicker: (fn) => { picker = fn; },
    pickFiles: (spec) => picker(spec),
    run,
    cancel,
    addFiles,
    receiveFiles,
    pageThumb,
    busy: () => !!view.job,
    get screen() { return view.screen; },
    get view() { return view; },
  };
})();

window.shell = shell;
