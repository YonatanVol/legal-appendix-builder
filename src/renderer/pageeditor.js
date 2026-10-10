'use strict';

/*
 * A page with things placed on it: the editor behind Edit PDF, Sign and PDF Forms.
 *
 * Objects are plain data in fractions of the page as shown (see src/main/pdf/draw.js),
 * so what is on the screen is what is drawn into the file. The editor shows one page
 * at a time, at a size that fits, with the objects of that page over it.
 *
 * Tools: select (click to select, drag to move, handles to resize, Delete to remove,
 * double-click text to edit), text, image, rect, ellipse, line, arrow, path (freehand),
 * highlight, whiteout, and "place" for a ready-made item such as a signature. Ctrl+Z
 * and Ctrl+Y undo and redo. Esc leaves text editing, then clears the selection.
 */

const EDITOR_TOOLS = {
  select: { label: 'בחירה והזזה', glyph: '<path d="M5 3l14 8-6 2-3 6z"/>' },
  text: { label: 'טקסט', glyph: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>' },
  image: { label: 'תמונה', glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>' },
  rect: { label: 'מלבן', glyph: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  ellipse: { label: 'עיגול', glyph: '<ellipse cx="12" cy="12" rx="8" ry="6"/>' },
  line: { label: 'קו', glyph: '<path d="M5 19L19 5"/>' },
  arrow: { label: 'חץ', glyph: '<path d="M5 19L19 5M11 5h8v8"/>' },
  path: { label: 'ציור חופשי', glyph: '<path d="M3 17c3-1 4-9 6-9s0 9 2 9 3-5 4-5 1 3 2 3 2-1 3-1"/>' },
  highlight: { label: 'הדגשה', glyph: '<path d="M4 20h16M7 16l9-9 3 3-9 9H7z"/>' },
  whiteout: { label: 'מחיקה בלבן', glyph: '<rect x="4" y="7" width="16" height="10" rx="1"/><path d="M8 12h8" stroke-dasharray="2 2"/>' },
  'field-text': { label: 'שדה טקסט', glyph: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 10v4"/>' },
  'field-checkbox': { label: 'תיבת סימון', glyph: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 12l2 2 4-4"/>' },
  'field-dropdown': { label: 'רשימה נפתחת', glyph: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M14 11l2 2 2-2"/>' },
  'field-signature': { label: 'שדה חתימה', glyph: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M6 14c2-1 3-4 4-4s0 4 1 4 2-2 3-2"/>' },
};

class PageEditor {
  /**
   * @param {HTMLElement} host
   * @param {{token: string, pageCount: number, objects: object[], tools: string[],
   *   thumb: Function, sizes: Promise<{width:number,height:number}[]>, onChange: Function,
   *   placeItem?: () => object|null, pickImage?: () => Promise<string|null>,
   *   overlay?: (page: number) => HTMLElement[], style: object}} options
   */
  constructor(host, options) {
    this.o = options;
    this.objects = options.objects.map((x) => ({ ...x, id: x.id || PageEditor.id() }));
    this.page = 0;
    this.tool = options.tools.includes('select') ? 'select' : options.tools[0];
    this.selected = null;
    this.undoStack = [];
    this.redoStack = [];
    this.style = options.style || { color: '#1a1a1a', size: 14, width: 2, bold: false };

    this.root = document.createElement('div');
    this.root.className = 'page-editor';
    host.append(this.root);

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'editor-toolbar';
    this.root.append(this.toolbar);
    this.buildToolbar();

    this.nav = document.createElement('div');
    this.nav.className = 'crop-nav';
    this.root.append(this.nav);

    this.holder = document.createElement('div');
    this.holder.className = 'crop-holder';
    this.root.append(this.holder);

    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
    this.draw();
  }

  static id() {
    return Math.random().toString(36).slice(2, 10);
  }

  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    this.root.remove();
  }

  /* ---------------- toolbar ---------------- */

  buildToolbar() {
    this.toolbar.replaceChildren();
    const group = document.createElement('div');
    group.className = 'editor-tools';
    for (const id of this.o.tools) {
      const spec = EDITOR_TOOLS[id];
      if (!spec) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'editor-tool' + (this.tool === id ? ' on' : '');
      b.dataset.tool = id;
      b.title = spec.label;
      b.setAttribute('aria-label', spec.label);
      b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${spec.glyph}</svg>`;
      b.addEventListener('click', () => this.setTool(id));
      group.append(b);
    }
    this.toolbar.append(group);

    if (this.o.tools.some((t) => !['select', 'image', 'whiteout'].includes(t))) {
      const colors = document.createElement('div');
      colors.className = 'swatches';
      for (const c of ['#1a1a1a', '#1f5fbf', '#c00000', '#1c6b45', '#ffe066']) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'swatch' + (this.style.color === c ? ' on' : '');
        s.style.background = c;
        s.title = 'צבע';
        s.addEventListener('click', () => {
          this.style.color = c;
          colors.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === s));
          if (this.selected) this.update(this.selected, (o) => {
            if (o.type === 'text') o.color = c;
            else if (o.type === 'highlight') o.color = c;
            else if ('stroke' in o || ['rect', 'ellipse', 'line', 'arrow', 'path'].includes(o.type)) o.stroke = c;
          });
        });
        colors.append(s);
      }
      this.toolbar.append(colors);

      const size = document.createElement('select');
      size.className = 'editor-size';
      size.title = 'גודל אות';
      for (const v of [10, 12, 14, 18, 24, 32]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = `${v}`;
        if (v === this.style.size) opt.selected = true;
        size.append(opt);
      }
      size.addEventListener('change', () => {
        this.style.size = Number(size.value);
        if (this.selected) this.update(this.selected, (o) => { if (o.type === 'text') o.size = this.style.size; });
      });
      this.toolbar.append(size);

      const bold = document.createElement('button');
      bold.type = 'button';
      bold.className = 'editor-tool' + (this.style.bold ? ' on' : '');
      bold.textContent = 'B';
      bold.title = 'מודגש';
      bold.style.fontWeight = '700';
      bold.addEventListener('click', () => {
        this.style.bold = !this.style.bold;
        bold.classList.toggle('on', this.style.bold);
        if (this.selected) this.update(this.selected, (o) => { if (o.type === 'text') o.bold = this.style.bold; });
      });
      this.toolbar.append(bold);
    }

    const spacer = document.createElement('span');
    spacer.className = 'editor-spacer';
    this.toolbar.append(spacer);
    this.undoButton = this.small('בטל', 'ביטול (Ctrl+Z)', () => this.undo());
    this.redoButton = this.small('חזור', 'חזרה (Ctrl+Y)', () => this.redo());
    this.deleteButton = this.small('מחק', 'מחיקת הפריט הנבחר (Delete)', () => this.removeSelected());
    this.toolbar.append(this.undoButton, this.redoButton, this.deleteButton);
    this.paintButtons();
  }

  small(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  paintButtons() {
    if (!this.undoButton) return;
    this.undoButton.disabled = !this.undoStack.length;
    this.redoButton.disabled = !this.redoStack.length;
    this.deleteButton.disabled = !this.selected;
    this.deleteButton.title = this.selected ? 'מחיקת הפריט הנבחר (Delete)' : 'בחר פריט כדי למחוק אותו';
    this.toolbar.querySelectorAll('.editor-tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === this.tool));
  }

  setTool(id) {
    if (id === 'image' && this.o.pickImage) {
      this.o.pickImage().then((src) => {
        if (!src) return;
        this.addImage(src);
      });
      return;
    }
    this.tool = id;
    this.select(null);
    this.paintButtons();
    if (this.stage) this.stage.dataset.tool = id;
  }

  /* ---------------- model ---------------- */

  snapshot() {
    this.undoStack.push(JSON.stringify(this.objects));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  commit() {
    this.o.onChange(this.objects.map((x) => ({ ...x })));
    this.paintButtons();
  }

  add(obj) {
    this.snapshot();
    const o = { ...obj, id: PageEditor.id(), page: this.page };
    this.objects.push(o);
    this.commit();
    this.paint();
    this.select(o.id);
    return o;
  }

  update(id, fn, { record = true } = {}) {
    const o = this.objects.find((x) => x.id === id);
    if (!o) return;
    if (record) this.snapshot();
    fn(o);
    this.commit();
    this.paint();
  }

  removeSelected() {
    if (!this.selected) return;
    this.snapshot();
    this.objects = this.objects.filter((x) => x.id !== this.selected);
    this.selected = null;
    this.commit();
    this.paint();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.objects));
    this.objects = JSON.parse(this.undoStack.pop());
    this.selected = null;
    this.commit();
    this.paint();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.objects));
    this.objects = JSON.parse(this.redoStack.pop());
    this.selected = null;
    this.commit();
    this.paint();
  }

  select(id) {
    this.selected = id;
    if (this.layer) this.layer.querySelectorAll('[data-id]').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
    this.paintButtons();
  }

  addImage(src, { w = 0.3 } = {}) {
    const img = new Image();
    img.onload = () => {
      const ratio = (img.naturalHeight / img.naturalWidth) * (this.pageW / this.pageH);
      this.add({ type: 'image', x: 0.5 - w / 2, y: 0.4, w, h: w * ratio, src });
      this.setTool('select');
    };
    img.src = src;
  }

  /** A ready-made item (a signature, a date) placed with its top-left at (x, y). */
  placeAt(item, x, y) {
    const o = { ...item, x: Math.max(0, Math.min(1 - (item.w || 0.1), x)), y: Math.max(0, Math.min(1 - (item.h || 0.03), y)) };
    return this.add(o);
  }

  /* ---------------- drawing ---------------- */

  async draw() {
    const sizes = await this.o.sizes;
    const size = sizes[this.page] || { width: 595, height: 842 };
    this.pageW = size.width;
    this.pageH = size.height;
    const width = Math.min(720, Math.max(360, this.root.clientWidth - 40 || 640));
    this.scale = width / this.pageW;

    this.nav.replaceChildren();
    const prev = this.navButton('›', 'העמוד הקודם', this.page === 0, () => { this.page--; this.select(null); this.draw(); });
    const label = document.createElement('span');
    label.textContent = `עמוד ${this.page + 1} מתוך ${this.o.pageCount}`;
    const next = this.navButton('‹', 'העמוד הבא', this.page >= this.o.pageCount - 1, () => { this.page++; this.select(null); this.draw(); });
    this.nav.append(prev, label, next);

    this.holder.replaceChildren();
    const stage = document.createElement('div');
    stage.className = 'preview-stage editor-stage loading';
    stage.style.width = `${width}px`;
    stage.style.height = `${width * (this.pageH / this.pageW)}px`;
    stage.dataset.tool = this.tool;
    this.holder.append(stage);
    this.stage = stage;
    this.o.thumb(this.o.token, this.page, width).then((url) => {
      stage.classList.remove('loading');
      if (!url || this.stage !== stage) return;
      const img = new Image();
      img.src = url;
      img.alt = '';
      img.draggable = false;
      img.className = 'editor-page';
      stage.prepend(img);
    });
    this.layer = document.createElement('div');
    this.layer.className = 'editor-layer';
    stage.append(this.layer);
    this.wireStage();
    this.paint();
  }

  navButton(glyph, label, disabled, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost icon';
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /** px for a size in points on this page. */
  px(points) {
    return points * this.scale;
  }

  paint() {
    if (!this.layer) return;
    const editing = this.layer.querySelector('.editing');
    if (editing) return; // never rebuild under the caret
    this.layer.replaceChildren();
    const W = this.stage.clientWidth || parseFloat(this.stage.style.width);
    const H = this.stage.clientHeight || parseFloat(this.stage.style.height);

    if (this.o.overlay) for (const el of this.o.overlay(this.page)) this.layer.append(el);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'editor-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    this.layer.append(svg);

    for (const o of this.objects.filter((x) => x.page === this.page)) {
      if (['line', 'arrow', 'path'].includes(o.type)) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', this.linePath(o, W, H));
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', o.stroke || '#1a1a1a');
        p.setAttribute('stroke-width', this.px(o.width || 2));
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        p.dataset.id = o.id;
        p.classList.add('editor-obj');
        if (o.id === this.selected) p.classList.add('selected');
        // A thick invisible twin makes a thin line easy to grab.
        const hit = p.cloneNode();
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', Math.max(12, this.px(o.width || 2)));
        hit.dataset.id = o.id;
        svg.append(p, hit);
        continue;
      }
      const el = document.createElement('div');
      el.className = `editor-obj obj-${o.type}`;
      el.dataset.id = o.id;
      if (o.id === this.selected) el.classList.add('selected');
      Object.assign(el.style, { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%` });
      if (o.type === 'text') {
        el.dir = 'auto';
        el.textContent = o.text || '';
        Object.assign(el.style, {
          fontSize: `${this.px(o.size || 14)}px`,
          lineHeight: `${this.px((o.size || 14) * 1.45)}px`,
          color: o.color || '#1a1a1a',
          fontWeight: o.bold ? '700' : '400',
          textAlign: o.align === 'center' ? 'center' : o.align === 'left' ? 'left' : 'right',
          height: 'auto',
          minHeight: `${o.h * 100}%`,
        });
        el.addEventListener('dblclick', () => this.editText(el, o));
      } else if (o.type === 'image') {
        const img = new Image();
        img.src = o.src;
        img.draggable = false;
        el.append(img);
        el.style.opacity = String(o.opacity == null ? 1 : o.opacity);
      } else if (o.type === 'rect' || o.type === 'ellipse') {
        el.style.border = `${this.px(o.width || 2)}px solid ${o.stroke || '#1a1a1a'}`;
        if (o.fill) el.style.background = o.fill;
        if (o.type === 'ellipse') el.style.borderRadius = '50%';
      } else if (o.type === 'highlight') {
        el.style.background = o.color || '#ffe066';
      } else if (o.type === 'field') {
        const tag = document.createElement('span');
        tag.className = 'field-tag';
        tag.textContent = o.name || '';
        el.append(tag);
      }
      if (o.id === this.selected && o.type !== 'text') {
        for (const h of ['nw', 'ne', 'sw', 'se']) {
          const handle = document.createElement('span');
          handle.className = `crop-handle h-${h}`;
          handle.dataset.h = h;
          el.append(handle);
        }
      }
      this.layer.append(el);
    }
  }

  linePath(o, W, H) {
    if (o.type === 'path') return (o.points || []).map(([x, y], i) => `${i ? 'L' : 'M'}${x * W} ${y * H}`).join(' ');
    const x1 = o.x1 * W;
    const y1 = o.y1 * H;
    const x2 = o.x2 * W;
    const y2 = o.y2 * H;
    let d = `M${x1} ${y1} L${x2} ${y2}`;
    if (o.type === 'arrow') {
      const len = Math.max(8, this.px(o.width || 2) * 5);
      const a = Math.atan2(y2 - y1, x2 - x1);
      d += ` M${x2 + len * Math.cos(a + Math.PI - 0.45)} ${y2 + len * Math.sin(a + Math.PI - 0.45)} L${x2} ${y2} L${x2 + len * Math.cos(a + Math.PI + 0.45)} ${y2 + len * Math.sin(a + Math.PI + 0.45)}`;
    }
    return d;
  }

  editText(el, o) {
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const done = () => {
      el.removeEventListener('blur', done);
      el.contentEditable = 'false';
      el.classList.remove('editing');
      const value = el.innerText.replace(/\n$/, '');
      const lines = Math.max(1, value.split('\n').length);
      if (!value.trim()) {
        // A text box left empty is taken away as if it had never been made: no undo step
        // that would bring back an empty box.
        if (o._fresh) this.undoStack.pop();
        else this.snapshot();
        this.objects = this.objects.filter((x) => x.id !== o.id);
        this.selected = null;
        this.commit();
      } else if (value !== o.text) {
        // The first text typed into a new box is part of the same step as making it.
        const fresh = o._fresh;
        this.update(o.id, (x) => {
          delete x._fresh;
          x.text = value;
          x.h = (lines * (x.size || 14) * 1.45) / this.pageH;
          const longest = Math.max(...value.split('\n').map((l) => l.length));
          x.w = Math.min(1 - x.x, Math.max(x.w, (longest * (x.size || 14) * 0.6) / this.pageW));
        }, { record: !fresh });
      }
      this.paint();
    };
    el.addEventListener('blur', done);
    this.finishEditing = () => el.blur();
  }

  /* ---------------- pointer ---------------- */

  wireStage() {
    const stage = this.stage;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.editing')) return;
      const rect = stage.getBoundingClientRect();
      const at = (ev) => ({
        x: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
      });
      const start = at(e);
      const target = e.target.closest('[data-id]');
      try { stage.setPointerCapture(e.pointerId); } catch { /* not every target can capture */ }

      if (this.tool === 'place' && this.o.placeItem) {
        const item = this.o.placeItem();
        if (item) this.placeAt(item, start.x - (item.w || 0) / 2, start.y - (item.h || 0) / 2);
        e.preventDefault();
        return;
      }

      if (this.tool === 'select' || target) {
        if (!target) {
          this.select(null);
          return;
        }
        e.preventDefault();
        const id = target.dataset.id;
        this.select(id);
        const o = this.objects.find((x) => x.id === id);
        if (!o) return;
        const handle = e.target.dataset.h;
        const before = JSON.stringify(this.objects);
        let moved = false;
        const orig = JSON.parse(JSON.stringify(o));
        const move = (ev) => {
          const p = at(ev);
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          if (Math.abs(dx) + Math.abs(dy) < 0.002) return;
          moved = true;
          if (['line', 'arrow'].includes(o.type)) {
            Object.assign(o, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
          } else if (o.type === 'path') {
            o.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
          } else if (handle) {
            if (handle.includes('w')) { o.x = Math.min(orig.x + orig.w - 0.01, orig.x + dx); o.w = orig.w + (orig.x - o.x); }
            if (handle.includes('e')) o.w = Math.max(0.01, orig.w + dx);
            if (handle.includes('n')) { o.y = Math.min(orig.y + orig.h - 0.005, orig.y + dy); o.h = orig.h + (orig.y - o.y); }
            if (handle.includes('s')) o.h = Math.max(0.005, orig.h + dy);
            if (o.type === 'image' && orig.w && orig.h) {
              // Pictures keep their shape: the height follows the width.
              o.h = orig.h * (o.w / orig.w);
            }
          } else {
            o.x = Math.max(-orig.w * 0.5, Math.min(1 - orig.w * 0.5, orig.x + dx));
            o.y = Math.max(-orig.h * 0.5, Math.min(1 - orig.h * 0.5, orig.y + dy));
          }
          this.paint();
        };
        const up = () => {
          stage.removeEventListener('pointermove', move);
          stage.removeEventListener('pointerup', up);
          if (moved) {
            this.undoStack.push(before);
            this.redoStack = [];
            this.commit();
          }
        };
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', up);
        return;
      }

      e.preventDefault();
      if (this.tool === 'text') {
        const size = this.style.size;
        const o = this.add({ type: 'text', x: Math.min(start.x, 0.7), y: start.y, w: 0.3, h: (size * 1.45) / this.pageH, text: '', size, color: this.style.color, bold: this.style.bold, align: 'right' });
        o._fresh = true;
        this.setTool('select');
        requestAnimationFrame(() => {
          const el = this.layer.querySelector(`[data-id="${o.id}"]`);
          if (el) this.editText(el, this.objects.find((x) => x.id === o.id));
        });
        return;
      }

      const ghost = this.tool.startsWith('field-')
        ? { type: 'field', kind: this.tool.slice(6), page: this.page, id: 'ghost' }
        : { type: this.tool, page: this.page, id: 'ghost' };
      if (['line', 'arrow'].includes(this.tool)) Object.assign(ghost, { x1: start.x, y1: start.y, x2: start.x, y2: start.y, stroke: this.style.color, width: this.style.width });
      else if (this.tool === 'path') Object.assign(ghost, { points: [[start.x, start.y]], stroke: this.style.color, width: this.style.width });
      else Object.assign(ghost, { x: start.x, y: start.y, w: 0, h: 0, stroke: this.style.color, width: this.style.width, color: this.tool === 'highlight' ? '#ffe066' : undefined });
      this.objects.push(ghost);
      const move = (ev) => {
        const p = at(ev);
        if (['line', 'arrow'].includes(ghost.type)) Object.assign(ghost, { x2: p.x, y2: p.y });
        else if (ghost.type === 'path') ghost.points.push([p.x, p.y]);
        else Object.assign(ghost, { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
        this.paint();
      };
      const up = () => {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        this.objects = this.objects.filter((x) => x !== ghost);
        const big = ['line', 'arrow'].includes(ghost.type)
          ? Math.hypot(ghost.x2 - ghost.x1, ghost.y2 - ghost.y1) > 0.01
          : ghost.type === 'path' ? ghost.points.length > 2 : ghost.w > 0.005 && ghost.h > 0.003;
        if (big) {
          const { id, ...rest } = ghost;
          this.add(rest);
        } else this.paint();
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
    });
  }

  onKey(e) {
    if (!this.root.isConnected) return;
    const typing = e.target && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault();
      this.removeSelected();
    }
  }

  /** For the shell's Esc: leave text editing, then clear the selection. */
  escape() {
    const editing = this.layer && this.layer.querySelector('.editing');
    if (editing) {
      editing.blur();
      return true;
    }
    if (this.selected) {
      this.select(null);
      this.paint();
      return true;
    }
    if (this.tool !== 'select' && this.o.tools.includes('select')) {
      this.setTool('select');
      return true;
    }
    return false;
  }
}

window.PageEditor = PageEditor;
