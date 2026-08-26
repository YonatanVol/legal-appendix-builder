'use strict';

const state = {
  body: null,          // { path, name, pageCount }
  appendices: [],      // { id, title, files: [{ path, name, pageCount }] }
  building: false,
  lastOutput: null,
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
  veil: $('drag-veil'),
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
  return appendix.files.reduce((sum, f) => sum + f.pageCount, 0);
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
    title.placeholder = 'כותרת הנספח — תופיע בתוכן העניינים ובדף החוצץ';
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

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = file.name;
      name.title = file.path;

      const pages = document.createElement('span');
      pages.className = 'fpages';
      pages.textContent = pageWord(file.pageCount);

      item.append(name, pages);
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

/* ---------------- live layout preview ---------------- */

async function refresh() {
  let ranges = null;

  if (state.body && state.appendices.length > 0) {
    const counts = state.appendices.map(appendixPageCount);
    const response = await window.api.previewLayout(state.body.pageCount, counts);
    if (response.ok && response.layout) {
      ranges = response.layout.appendices;
      const total = response.layout.totalPages;
      el.summary.innerHTML =
        `התיק ייווצר עם <strong>${total}</strong> עמודים · ` +
        `גוף הכתב עמ' <strong>1-${state.body.pageCount}</strong> · ` +
        `תוכן עניינים בעמ' <strong>${response.layout.tocStart}</strong> · ` +
        `<strong>${state.appendices.length}</strong> נספחים`;
    }
  } else if (!state.body) {
    el.summary.textContent = 'בחר כתב תביעה ונספח אחד לפחות.';
  } else {
    el.summary.textContent = 'הוסף נספח אחד לפחות.';
  }

  renderAppendices(ranges);
  updateBuildState();
}

function updateBuildState() {
  const ready =
    !!state.body &&
    state.appendices.length > 0 &&
    state.appendices.every((a) => a.title.trim() && a.files.length > 0);
  el.build.disabled = !ready || state.building;
}

/* ---------------- mutations ---------------- */

function move(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.appendices.length) return;
  const [moved] = state.appendices.splice(index, 1);
  state.appendices.splice(target, 0, moved);
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

function moveFile(appendixIndex, fileIndex, delta) {
  const files = state.appendices[appendixIndex].files;
  const target = fileIndex + delta;
  if (target < 0 || target >= files.length) return;
  const [moved] = files.splice(fileIndex, 1);
  files.splice(target, 0, moved);
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

function removeAppendix(index) {
  state.appendices.splice(index, 1);
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

function removeFile(appendixIndex, fileIndex) {
  const appendix = state.appendices[appendixIndex];
  appendix.files.splice(fileIndex, 1);
  if (appendix.files.length === 0) state.appendices.splice(appendixIndex, 1);
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

/** One appendix per file — the common case; files are merged into one appendix later. */
function addAppendicesFromFiles(files) {
  files.forEach((file) => {
    state.appendices.push({
      id: nextId++,
      title: file.suggestedTitle || '',
      files: [file],
    });
  });
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

async function addFilesToAppendix(index) {
  clearError();
  const response = await window.api.pickAppendixFiles();
  if (!response.ok) return showError(response.error);
  if (response.cancelled) return;
  state.appendices[index].files.push(...response.files);
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

function setBody(file) {
  state.body = file;
  el.bodyName.textContent = file.name;
  el.bodyName.title = file.path;
  el.bodyPages.textContent = pageWord(file.pageCount);
  el.bodyEmpty.classList.add('hidden');
  el.bodyFilled.classList.remove('hidden');
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
}

/* ---------------- wiring ---------------- */

$('body-browse').addEventListener('click', async () => {
  clearError();
  const response = await window.api.pickBody();
  if (!response.ok) return showError(response.error);
  if (!response.cancelled) setBody(response.file);
});

$('body-clear').addEventListener('click', () => {
  state.body = null;
  el.bodyEmpty.classList.remove('hidden');
  el.bodyFilled.classList.add('hidden');
  window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

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

function defaultOutputName() {
  const base = state.body ? state.body.name.replace(/\.pdf$/i, '') : 'תיק';
  return `${base} - עם נספחים.pdf`;
}

window.api.onProgress((stage) => {
  el.progress.textContent = stage;
});

el.build.addEventListener('click', async () => {
  clearError();
  el.result.classList.add('hidden');

  const output = await window.api.pickOutput(defaultOutputName());
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
  const ranges = result.appendices.map((a) => `נספח ${a.number}: עמ' ${a.range}`).join(' · ');
  el.resultTitle.textContent =
    `נוצר תיק בן ${result.totalPages} עמודים · תוכן עניינים בעמ' ${result.tocPage} · ${ranges}`;
  el.result.classList.remove('hidden');
});

$('open-file').addEventListener('click', () => {
  if (state.lastOutput) window.api.openFile(state.lastOutput);
});
$('reveal-file').addEventListener('click', () => {
  if (state.lastOutput) window.api.revealFile(state.lastOutput);
});

window.api.getVersion().then((r) => {
  if (r.ok) $('version').textContent = 'גרסה ' + r.version;
});

refresh();
