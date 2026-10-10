'use strict';

/*
 * The options side of each tool screen.
 *
 * A panel is { defaults(), render(container, view), blocked(view) }. `view` carries
 * the files and the options object, and `view.set(key, value)` changes an option and
 * re-checks the run button. Options are plain data on purpose: a saved workflow and a
 * repeated run both replay exactly this object.
 *
 * Panels build their DOM with the helpers below so every tool's controls look and
 * behave alike.
 */

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

  text(box, { label, value, placeholder, onInput }) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    if (label) {
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = label;
      wrap.append(span);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(input);
    box.append(wrap);
    return input;
  },

  /** A row of mutually exclusive choices, shown as a segmented control. */
  choice(box, { label, value, choices, onChange }) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    if (label) {
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = label;
      wrap.append(span);
    }
    const row = document.createElement('div');
    row.className = 'segmented';
    row.setAttribute('role', 'radiogroup');
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg' + (c.value === value ? ' on' : '');
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

  button(box, { label, onClick, kind = 'secondary' }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = kind;
    b.textContent = label;
    b.addEventListener('click', onClick);
    box.append(b);
    return b;
  },
};

const panels = {
  merge: {
    defaults: () => ({ outputName: '' }),
    render(container, view) {
      const order = ui.section(container, 'סדר הקבצים',
        'הקבצים יאוחדו בסדר שברשימה. אפשר לגרור שורה כדי להזיז אותה.');
      const row = document.createElement('div');
      row.className = 'opt-row';
      order.append(row);
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
};

window.panels = panels;
window.panelUi = ui;
