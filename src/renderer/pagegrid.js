'use strict';

/*
 * A grid of page thumbnails, used by every tool that works on pages.
 *
 * Selection works the way it does in Explorer, and it has to work before anything is
 * built on it: a click selects one page, Ctrl+click adds or removes one, Shift+click
 * selects the range from the last page clicked, Ctrl+A selects all, Esc clears.
 * With `reorder` on, pages are dragged to a new place (all selected pages move
 * together); with `remove` on, Delete removes the selection.
 *
 * Pages are { key, token, index, turn, blank?, w?, h?, label? }: `turn` is quarter
 * turns clockwise shown on the thumbnail, `label` an optional badge such as a part
 * number. The grid never changes the array it was given; it calls onChange with a
 * new one.
 */

class PageGrid {
  /**
   * @param {HTMLElement} host
   * @param {{pages: object[], select?: boolean, reorder?: boolean, remove?: boolean,
   *   width?: number, thumb: Function, onChange?: Function, onSelect?: Function,
   *   caption?: Function}} options
   */
  constructor(host, options) {
    this.host = host;
    this.opts = { select: true, reorder: false, remove: false, width: 118, ...options };
    this.pages = options.pages.slice();
    this.selected = new Set(options.selected || []);
    this.anchor = null;
    this.dragKeys = null;

    this.el = document.createElement('div');
    this.el.className = 'page-grid';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'listbox');
    this.el.setAttribute('aria-multiselectable', 'true');
    this.el.style.setProperty('--thumb', `${this.opts.width}px`);
    host.append(this.el);

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer.unobserve(entry.target);
        this.draw(entry.target);
      }
    }, { root: null, rootMargin: '300px' });

    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  setPages(pages, { keepSelection = true } = {}) {
    this.pages = pages.slice();
    const keys = new Set(this.pages.map((p) => p.key));
    if (keepSelection) this.selected = new Set([...this.selected].filter((k) => keys.has(k)));
    else this.selected.clear();
    this.render();
  }

  setSelection(keys) {
    this.selected = new Set(keys);
    this.paintSelection();
  }

  selectedPages() {
    return this.pages.filter((p) => this.selected.has(p.key));
  }

  clearSelection() {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.paintSelection();
    this.emitSelect();
    return true;
  }

  render() {
    this.observer.disconnect();
    this.el.replaceChildren();
    this.pages.forEach((page, position) => this.el.append(this.card(page, position)));
    this.paintSelection();
  }

  card(page, position) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.key = page.key;
    card.setAttribute('role', 'option');

    const box = document.createElement('div');
    box.className = 'page-box';
    const inner = document.createElement('div');
    inner.className = 'page-inner';
    inner.style.transform = `rotate(${(page.turn || 0) * 90}deg)`;
    if (page.blank) {
      inner.classList.add('blank');
      inner.textContent = 'עמוד ריק';
    } else {
      inner.classList.add('loading');
    }
    box.append(inner);

    const caption = document.createElement('div');
    caption.className = 'page-caption';
    caption.textContent = this.opts.caption ? this.opts.caption(page, position) : String(position + 1);

    if (page.label) {
      const badge = document.createElement('span');
      badge.className = 'page-badge';
      badge.textContent = page.label;
      if (page.tone !== undefined) badge.dataset.tone = String(page.tone % 6);
      card.append(badge);
    }
    if (page.dim) card.classList.add('dim');

    card.append(box, caption);

    if (this.opts.select) {
      card.addEventListener('click', (e) => this.onClick(e, page.key));
    }

    if (this.opts.reorder) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        if (!this.selected.has(page.key)) {
          this.selected = new Set([page.key]);
          this.anchor = page.key;
          this.paintSelection();
          this.emitSelect();
        }
        this.dragKeys = new Set(this.selected);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-page', page.key);
        this.el.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        this.dragKeys = null;
        this.el.classList.remove('dragging');
        this.clearMarks();
      });
      card.addEventListener('dragover', (e) => {
        if (!this.dragKeys) return;
        e.preventDefault();
        e.stopPropagation();
        this.clearMarks();
        card.classList.add(this.isBefore(e, card) ? 'mark-before' : 'mark-after');
      });
      card.addEventListener('drop', (e) => {
        if (!this.dragKeys) return;
        e.preventDefault();
        e.stopPropagation();
        this.moveTo(page.key, this.isBefore(e, card));
      });
    }

    if (!page.blank) this.observer.observe(card);
    return card;
  }

  /** The grid runs right to left, so the start of a card is its right half. */
  isBefore(e, card) {
    const r = card.getBoundingClientRect();
    const rtl = getComputedStyle(this.el).direction === 'rtl';
    return rtl ? e.clientX > r.left + r.width / 2 : e.clientX < r.left + r.width / 2;
  }

  clearMarks() {
    this.el.querySelectorAll('.mark-before, .mark-after').forEach((c) => c.classList.remove('mark-before', 'mark-after'));
  }

  async draw(card) {
    const page = this.pages.find((p) => p.key === card.dataset.key);
    if (!page || page.blank) return;
    const url = await this.opts.thumb(page.token, page.index, this.opts.width);
    const inner = card.querySelector('.page-inner');
    if (!inner) return;
    inner.classList.remove('loading');
    if (!url) {
      inner.classList.add('failed');
      inner.textContent = 'אין תצוגה';
      return;
    }
    const img = new Image();
    img.src = url;
    img.alt = `עמוד ${page.index + 1}`;
    img.draggable = false;
    inner.replaceChildren(img);
  }

  onClick(e, key) {
    const keys = this.pages.map((p) => p.key);
    if (e.shiftKey && this.anchor && keys.includes(this.anchor)) {
      const a = keys.indexOf(this.anchor);
      const b = keys.indexOf(key);
      const range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
      if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
      range.forEach((k) => this.selected.add(k));
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.anchor = key;
    } else {
      this.selected = new Set([key]);
      this.anchor = key;
    }
    this.el.focus({ preventScroll: true });
    this.paintSelection();
    this.emitSelect();
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a' && this.opts.select) {
      e.preventDefault();
      this.selected = new Set(this.pages.map((p) => p.key));
      this.paintSelection();
      this.emitSelect();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.opts.remove && this.selected.size) {
      e.preventDefault();
      this.removeSelected();
    }
  }

  removeSelected() {
    if (!this.selected.size) return;
    const next = this.pages.filter((p) => !this.selected.has(p.key));
    this.selected.clear();
    this.change(next);
  }

  /** Move the dragged pages to just before or after `targetKey`, keeping their order. */
  moveTo(targetKey, before) {
    const moving = this.pages.filter((p) => this.dragKeys.has(p.key));
    if (this.dragKeys.has(targetKey)) {
      this.clearMarks();
      return;
    }
    const rest = this.pages.filter((p) => !this.dragKeys.has(p.key));
    const at = rest.findIndex((p) => p.key === targetKey) + (before ? 0 : 1);
    rest.splice(at, 0, ...moving);
    this.dragKeys = null;
    this.change(rest);
  }

  change(next) {
    this.pages = next;
    this.render();
    if (this.opts.onChange) this.opts.onChange(next.slice());
    this.emitSelect();
  }

  paintSelection() {
    for (const card of this.el.children) {
      const on = this.selected.has(card.dataset.key);
      card.classList.toggle('selected', on);
      card.setAttribute('aria-selected', String(on));
    }
  }

  emitSelect() {
    if (this.opts.onSelect) this.opts.onSelect(this.selectedPages());
  }

  destroy() {
    this.observer.disconnect();
    this.el.remove();
  }
}

window.PageGrid = PageGrid;
