'use strict';

const state = {
  body: null,          // { path, name, pageCount, missing? }
  appendices: [],      // { id, title, files: [{ path, name, pageCount, missing? }] }
  building: false,
  lastOutput: null,
  restoredFrom: null,  // { id, name, outputPath } when reopened from history
};

let nextId = 1;

const $ = (id) => document.getElementById(id);
const el = {
  bodyDrop: $('body-drop'),
  bodyEmpty: $('body-empty'),
  bodyFilled: $('body-filled'),
  bodyName: $('body-name'),
  bodyPages: $('body-pages'),
  appendixEmpty: $('appendix-empty'),
  appendixList: $('appendix-list'),
  summary: $('summary'),
  build: $('build'),
  progress: $('progress'),
  error: $('error'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultHint: $('result-hint'),
  restored: $('restored'),
  restoredText: $('restored-text'),
  veil: $('drag-veil'),
  tab: $('history-tab'),
  count: $('history-count'),
  scrim: $('history-scrim'),
  drawer: $('history-drawer'),
  search: $('history-search'),
  list: $('history-list'),
  emptyNote: $('history-empty'),
  noneNote: $('history-none'),
  errorNote: $('history-error'),
};

const pageWord = (n) => (n === 1 ? 'עמוד אחד' : `${n} עמודים`);

function showError(message) {
  el.error.textContent = message;
  el.error.classList.remove('hidden');
  el.result.classList.add('hidden');
}

function clearError() {
  el.error.classList.add('hidden');
}

/* ---------------- rendering ---------------- */

function appendixPageCount(appendix) {
  return appendix.files.reduce((sum, f) => sum + (f.missing ? 0 : f.pageCount), 0);
}

/** Hebrew does not take "1 קבצים"; the singular has its own wording. */
function missingPhrase(count) {
  return count === 1
    ? 'קובץ אחד לא נמצא במקום שנשמר'
    : `${count} קבצים לא נמצאו במקום שנשמרו`;
}

function missingFileCount() {
  return state.appendices.reduce(
    (n, a) => n + a.files.filter((f) => f.missing).length,
    0
  );
}

function renderAppendices(ranges) {
  el.appendixEmpty.classList.toggle('hidden', state.appendices.length > 0);
  el.appendixList.replaceChildren();

  state.appendices.forEach((appendix, index) => {
    const li = document.createElement('li');
    li.className = 'appendix';

    const top = document.createElement('div');
    top.className = 'appendix-top';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `נספח ${index + 1}`;

    const title = document.createElement('input');
    title.className = 'title-input';
    title.type = 'text';
    title.value = appendix.title;
    title.placeholder = 'כותרת הנספח, תופיע בתוכן העניינים ובדף החוצץ';
    title.addEventListener('input', () => {
      appendix.title = title.value;
      title.classList.toggle('invalid', !title.value.trim());
      updateBuildState();
    });

    const range = document.createElement('span');
    range.className = 'range-tag';
    range.textContent = ranges && ranges[index] ? `עמ' ${ranges[index].range}` : '';

    const buttons = document.createElement('div');
    buttons.className = 'row-buttons';
    buttons.append(
      iconButton('▲', 'העלה', index === 0, () => move(index, -1)),
      iconButton('▼', 'הורד', index === state.appendices.length - 1, () => move(index, 1)),
      iconButton('✕', 'הסר נספח', false, () => removeAppendix(index), 'remove')
    );

    top.append(badge, title, range, buttons);

    const files = document.createElement('ul');
    files.className = 'appendix-files';
    appendix.files.forEach((file, fileIndex) => {
      const item = document.createElement('li');
      if (file.missing) item.classList.add('missing');

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = file.name;
      name.title = file.path;

      const detail = document.createElement('span');
      detail.className = file.missing ? 'missing-note' : 'fpages';
      detail.textContent = file.missing ? 'הקובץ לא נמצא' : pageWord(file.pageCount);

      item.append(name, detail);

      if (file.missing) {
        const locate = document.createElement('button');
        locate.type = 'button';
        locate.className = 'secondary';
        locate.textContent = 'אתר';
        locate.addEventListener('click', () => locateAppendixFile(index, fileIndex));
        item.append(locate);
      }

      if (appendix.files.length > 1) {
        item.append(
          iconButton('▲', 'העלה קובץ', fileIndex === 0, () => moveFile(index, fileIndex, -1)),
          iconButton('▼', 'הורד קובץ', fileIndex === appendix.files.length - 1, () => moveFile(index, fileIndex, 1)),
          iconButton('✕', 'הסר קובץ', false, () => removeFile(index, fileIndex), 'remove')
        );
      }
      files.append(item);
    });

    const actions = document.createElement('div');
    actions.className = 'appendix-actions';
    const addFiles = document.createElement('button');
    addFiles.type = 'button';
    addFiles.className = 'secondary';
    addFiles.textContent = 'הוסף קובץ לנספח זה';
    addFiles.addEventListener('click', () => addFilesToAppendix(index));
    actions.append(addFiles);

    li.append(top, files, actions);
    el.appendixList.append(li);
  });
}

function iconButton(glyph, label, disabled, onClick, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ghost icon ${extraClass}`.trim();
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

/* ---------------- what is stopping the build ---------------- */

/**
 * A disabled button with no reason is a dead end. This is the sentence shown in
 * the summary line whenever the build cannot run, and it names the row at fault.
 */
function blockingReason() {
  if (!state.body) return 'בחר את קובץ כתב התביעה.';
  if (state.body.missing) return 'קובץ כתב התביעה לא נמצא במקום שנשמר. אתר אותו כדי להמשיך.';
  if (state.appendices.length === 0) return 'הוסף נספח אחד לפחות.';

  const emptyIndex = state.appendices.findIndex((a) => a.files.length === 0);
  if (emptyIndex !== -1) return `לנספח ${emptyIndex + 1} לא נבחרו קבצים.`;

  const untitled = state.appendices.findIndex((a) => !a.title.trim());
  if (untitled !== -1) return `חסרה כותרת לנספח ${untitled + 1}.`;

  const missing = missingFileCount();
  if (missing > 0) {
    const how = missing === 1 ? 'אתר אותו כדי להמשיך.' : 'אתר אותם כדי להמשיך.';
    return `${missingPhrase(missing)}. ${how}`;
  }

  return null;
}

/* ---------------- live layout preview ---------------- */

async function refresh() {
  let ranges = null;
  const blocked = blockingReason();

  if (!blocked) {
    const counts = state.appendices.map(appendixPageCount);
    const response = await window.api.previewLayout(state.body.pageCount, counts);
    if (response.ok && response.layout) {
      ranges = response.layout.appendices;
      el.summary.innerHTML =
        `התיק ייווצר עם <strong>${response.layout.totalPages}</strong> עמודים · ` +
        `גוף הכתב עמ' <strong>1-${state.body.pageCount}</strong> · ` +
        `תוכן עניינים בעמ' <strong>${response.layout.tocStart}</strong> · ` +
        `<strong>${state.appendices.length}</strong> נספחים`;
    }
  } else {
    el.summary.textContent = blocked;
  }

  renderAppendices(ranges);
  updateBuildState();
}

function updateBuildState() {
  el.build.disabled = !!blockingReason() || state.building;
}

/* ---------------- mutations ---------------- */

function move(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.appendices.length) return;
  const [moved] = state.appendices.splice(index, 1);
  state.appendices.splice(target, 0, moved);
  refresh();
}

function moveFile(appendixIndex, fileIndex, delta) {
  const files = state.appendices[appendixIndex].files;
  const target = fileIndex + delta;
  if (target < 0 || target >= files.length) return;
  const [moved] = files.splice(fileIndex, 1);
  files.splice(target, 0, moved);
  refresh();
}

function removeAppendix(index) {
  state.appendices.splice(index, 1);
  refresh();
}

function removeFile(appendixIndex, fileIndex) {
  const appendix = state.appendices[appendixIndex];
  appendix.files.splice(fileIndex, 1);
  if (appendix.files.length === 0) state.appendices.splice(appendixIndex, 1);
  refresh();
}

/** One appendix per file, which is the common case; several can be merged after. */
function addAppendicesFromFiles(files) {
  files.forEach((file) => {
    state.appendices.push({
      id: nextId++,
      title: file.suggestedTitle || '',
      files: [file],
    });
  });
  refresh();
}

async function addFilesToAppendix(index) {
  clearError();
  const response = await window.api.pickAppendixFiles();
  if (!response.ok) return showError(response.error);
  if (response.cancelled) return;
  state.appendices[index].files.push(...response.files);
  refresh();
}

async function locateAppendixFile(appendixIndex, fileIndex) {
  clearError();
  const current = state.appendices[appendixIndex].files[fileIndex];
  const response = await window.api.locateFile(current.name);
  if (!response.ok) return showError(response.error);
  if (response.cancelled) return;
  state.appendices[appendixIndex].files[fileIndex] = response.file;
  refresh();
}

function setBody(file) {
  state.body = file;
  el.bodyName.textContent = file.name;
  el.bodyName.title = file.path;
  el.bodyPages.textContent = file.missing ? 'הקובץ לא נמצא' : pageWord(file.pageCount);
  el.bodyFilled.classList.toggle('missing', !!file.missing);
  el.bodyEmpty.classList.add('hidden');
  el.bodyFilled.classList.remove('hidden');
  refresh();
}

function clearBody() {
  state.body = null;
  el.bodyEmpty.classList.remove('hidden');
  el.bodyFilled.classList.add('hidden');
  el.bodyFilled.classList.remove('missing');
}

/* ---------------- wiring ---------------- */

$('body-browse').addEventListener('click', async () => {
  clearError();
  const response = await window.api.pickBody();
  if (!response.ok) return showError(response.error);
  if (!response.cancelled) setBody(response.file);
});

$('body-clear').addEventListener('click', async () => {
  clearError();
  // When the file is missing this button is the way back, so it opens the picker
  // rather than only emptying the slot.
  if (state.body && state.body.missing) {
    const response = await window.api.locateFile(state.body.name);
    if (!response.ok) return showError(response.error);
    if (response.cancelled) return;
    return setBody(response.file);
  }
  clearBody();
  refresh();
});

$('add-appendix').addEventListener('click', async () => {
  clearError();
  const response = await window.api.pickAppendixFiles();
  if (!response.ok) return showError(response.error);
  if (response.cancelled) return;
  addAppendicesFromFiles(response.files);
});

/* ---------------- drag and drop ---------------- */

function pathsFrom(event) {
  return Array.from(event.dataTransfer.files)
    .map((file) => window.api.pathForFile(file))
    .filter((path) => path && path.toLowerCase().endsWith('.pdf'));
}

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (++dragDepth === 1) el.veil.classList.remove('hidden');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.veil.classList.add('hidden');
  }
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  el.veil.classList.add('hidden');
  clearError();

  const paths = pathsFrom(event);
  if (paths.length === 0) return showError('ניתן לגרור קובצי PDF בלבד.');

  const response = await window.api.inspectFiles(paths);
  if (!response.ok) return showError(response.error);

  // Dropping on the pleading zone sets the pleading; anywhere else adds appendices.
  if (el.bodyDrop.contains(event.target) && response.files.length > 0) {
    setBody(response.files[0]);
    if (response.files.length > 1) addAppendicesFromFiles(response.files.slice(1));
  } else {
    addAppendicesFromFiles(response.files);
  }
});

el.bodyDrop.addEventListener('dragenter', () => el.bodyDrop.classList.add('over'));
el.bodyDrop.addEventListener('dragleave', () => el.bodyDrop.classList.remove('over'));
el.bodyDrop.addEventListener('drop', () => el.bodyDrop.classList.remove('over'));

/* ---------------- build ---------------- */

/**
 * A bundle reopened from history saves back over the same file, so correcting a
 * letter replaces the filing instead of leaving a second copy beside it.
 */
function defaultOutputTarget() {
  if (state.restoredFrom && state.restoredFrom.outputPath) return state.restoredFrom.outputPath;
  const base = state.body ? state.body.name.replace(/\.pdf$/i, '') : 'תיק';
  return `${base} - עם נספחים.pdf`;
}

window.api.onProgress((stage) => {
  el.progress.textContent = stage;
});

el.build.addEventListener('click', async () => {
  clearError();
  el.result.classList.add('hidden');

  const output = await window.api.pickOutput(defaultOutputTarget());
  if (!output.ok) return showError(output.error);
  if (output.cancelled) return;

  state.building = true;
  updateBuildState();
  el.progress.textContent = 'מתחיל…';

  const response = await window.api.build({
    bodyPath: state.body.path,
    appendices: state.appendices.map((a) => ({
      title: a.title,
      files: a.files.map((f) => f.path),
    })),
    outputPath: output.path,
  });

  state.building = false;
  el.progress.textContent = '';
  updateBuildState();

  if (!response.ok) return showError(response.error);

  const result = response.result;
  state.lastOutput = result.outputPath;
  // Deliberately not recorded as the save target. That target is only ever set by
  // reopening a case from history, which puts a banner on screen naming it, so the
  // save dialog can never be quietly aimed at a filing the user cannot see it is
  // about to replace.

  const ranges = result.appendices.map((a) => `נספח ${a.number}: עמ' ${a.range}`).join(' · ');
  el.resultTitle.textContent =
    `נוצר תיק בן ${result.totalPages} עמודים · תוכן עניינים בעמ' ${result.tocPage} · ${ranges}`;
  // Only claim it was saved when it actually was.
  el.resultHint.classList.toggle('hidden', !result.historyId);
  el.result.classList.remove('hidden');

  loadHistory();
});

$('open-file').addEventListener('click', () => {
  if (state.lastOutput) window.api.openFile(state.lastOutput);
});
$('reveal-file').addEventListener('click', () => {
  if (state.lastOutput) window.api.revealFile(state.lastOutput);
});
$('result-history').addEventListener('click', () => openDrawer());

/* ---------------- history ---------------- */

const historyView = {
  open: false,
  entries: [],
  query: '',
  restoring: null,
};

const caseName = (fileName) => String(fileName).replace(/\.pdf$/i, '');

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

function matchesQuery(entry, query) {
  if (!query) return true;
  const haystack = [entry.bodyName, entry.outputName, ...entry.appendices.map((a) => a.title)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Refreshing the list is a background concern. It must not report through
 * showError, which hides the result panel: a history read that fails just after a
 * build would make a bundle that is sitting on disk look like a failure.
 */
async function loadHistory() {
  const response = await window.api.historyList();
  if (!response.ok) {
    console.error('history: could not read the list:', response.error);
    if (historyView.open) {
      el.errorNote.textContent = response.error;
      el.errorNote.classList.remove('hidden');
    }
    return;
  }
  el.errorNote.classList.add('hidden');

  historyView.entries = response.entries;
  const count = historyView.entries.length;
  el.count.textContent = String(count);
  el.count.classList.toggle('hidden', count === 0);
  if (historyView.open) renderHistory();
}

function renderHistory() {
  const query = historyView.query.trim().toLowerCase();
  const shown = historyView.entries.filter((entry) => matchesQuery(entry, query));

  $('drawer-search').classList.toggle('hidden', historyView.entries.length === 0);
  el.emptyNote.classList.toggle('hidden', historyView.entries.length > 0);
  el.noneNote.classList.toggle('hidden', !(historyView.entries.length > 0 && shown.length === 0));

  el.list.replaceChildren();
  shown.forEach((entry) => el.list.append(historyRow(entry)));
}

function historyRow(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.dataset.id = entry.id;

  const busy = historyView.restoring === entry.id;
  // Locked while any restore runs, not only this row's, so the list cannot be
  // rewritten underneath an operation that is still in flight.
  const locked = historyView.restoring !== null;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'history-open';
  open.title = entry.outputName;
  open.disabled = locked;

  const top = document.createElement('div');
  top.className = 'hi-top';

  const name = document.createElement('span');
  name.className = 'hi-title';
  name.textContent = caseName(entry.bodyName);

  const when = document.createElement('span');
  when.className = 'hi-when';
  when.textContent = relativeWhen(entry.savedAt);
  top.append(name, when);

  const preview = document.createElement('span');
  preview.className = 'hi-preview';
  preview.textContent = entry.appendices.map((a) => a.title).filter(Boolean).join(' · ');

  const bottom = document.createElement('span');
  bottom.className = 'hi-bottom';

  const meta = document.createElement('span');
  meta.className = busy ? 'hi-loading' : 'hi-meta';
  meta.textContent = busy
    ? 'טוען את התיק…'
    : `${entry.appendices.length} נספחים · ${entry.totalPages} עמודים`;
  bottom.append(meta);

  // Without this a row is just text and nothing says it can be opened.
  if (!busy) {
    const hint = document.createElement('span');
    hint.className = 'hi-hint';
    hint.textContent = 'פתח לעריכה';
    bottom.append(hint);
  }

  open.append(top, preview, bottom);
  open.addEventListener('click', () => restoreEntry(entry));

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  if (entry.outputExists) {
    actions.append(
      iconButton('↗', 'פתח את קובץ ה-PDF', locked, () => window.api.openFile(entry.outputPath))
    );
  }
  actions.append(iconButton('✕', 'מחק מההיסטוריה', locked, () => removeEntry(entry), 'remove'));

  li.append(open, actions);
  return li;
}

function workInProgress() {
  return !!state.body || state.appendices.length > 0;
}

async function restoreEntry(entry) {
  // Set before any await, so a second press while the first is in flight is ignored.
  if (historyView.restoring) return;

  if (workInProgress()) {
    const what = state.appendices.length
      ? `תיק בעבודה עם ${state.appendices.length} נספחים`
      : 'תיק בעבודה';
    const ok = window.confirm(
      `יש כאן ${what}. פתיחת התיק מההיסטוריה תחליף אותו. להמשיך?`
    );
    if (!ok) return;
  }

  historyView.restoring = entry.id;
  renderHistory();

  const response = await window.api.historyRestore(entry.id);
  historyView.restoring = null;

  if (!response.ok) {
    renderHistory();
    closeDrawer();
    return showError(response.error);
  }

  applyRestored(response.restored, entry);
  closeDrawer();
}

function applyRestored(restored, entry) {
  clearError();
  el.result.classList.add('hidden');

  state.appendices = restored.appendices.map((appendix) => ({
    id: nextId++,
    title: appendix.title,
    files: appendix.files,
  }));
  state.lastOutput = null;
  state.restoredFrom = {
    id: restored.id,
    name: entry.bodyName,
    outputPath: restored.outputPath,
  };

  setBody(restored.body);

  const label = escapeHtml(caseName(entry.bodyName));
  const missing = missingFileCount() + (restored.body.missing ? 1 : 0);
  el.restoredText.innerHTML = missing
    ? `נטען מההיסטוריה: <strong>${label}</strong>. ${missingPhrase(missing)}.`
    : `נטען מההיסטוריה: <strong>${label}</strong>`;
  el.restored.classList.remove('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}

async function removeEntry(entry) {
  const ok = window.confirm(
    `למחוק את "${caseName(entry.bodyName)}" מההיסטוריה?\n` +
      'קובץ ה-PDF עצמו לא יימחק, רק הרישום כאן.'
  );
  if (!ok) return;

  const response = await window.api.historyRemove(entry.id);
  if (!response.ok) return showError(response.error);
  if (state.restoredFrom && state.restoredFrom.id === entry.id) state.restoredFrom = null;
  await loadHistory(); // renders on its own while the drawer is open
}

$('restored-new').addEventListener('click', () => {
  clearBody();
  state.appendices = [];
  state.restoredFrom = null;
  state.lastOutput = null;
  el.restored.classList.add('hidden');
  el.result.classList.add('hidden');
  clearError();
  refresh();
});

/* ---------------- drawer ---------------- */

let lastFocus = null;

function openDrawer() {
  if (historyView.open) return;
  historyView.open = true;
  lastFocus = document.activeElement;

  el.drawer.classList.remove('hidden');
  el.scrim.classList.remove('hidden');
  el.tab.setAttribute('aria-expanded', 'true');

  renderHistory();
  el.search.focus();
}

function closeDrawer() {
  if (!historyView.open) return;
  historyView.open = false;

  el.drawer.classList.add('hidden');
  el.scrim.classList.add('hidden');
  el.tab.setAttribute('aria-expanded', 'false');

  // Back to whatever opened it, and to the tab when that is nothing in particular,
  // so closing never drops focus onto the document body.
  const target =
    lastFocus && lastFocus.isConnected && lastFocus !== document.body ? lastFocus : el.tab;
  target.focus();
}

el.tab.addEventListener('click', () => (historyView.open ? closeDrawer() : openDrawer()));
$('history-close').addEventListener('click', () => closeDrawer());
el.scrim.addEventListener('click', () => closeDrawer());

el.search.addEventListener('input', () => {
  historyView.query = el.search.value;
  renderHistory();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && historyView.open) {
    event.preventDefault();
    closeDrawer();
  }
});

/* ---------------- start ---------------- */

window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

loadHistory();
refresh();
