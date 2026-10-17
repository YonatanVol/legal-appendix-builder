'use strict';

/*
 * Tool icons: a white line glyph on a coloured tile, the way the office already knows
 * them from iLovePDF. Each glyph is drawn on a 24x24 grid with a 1.8 stroke.
 */

const GLYPHS = {
  merge: '<path d="M4 5h6v6H4zM14 13h6v6h-6z"/><path d="M10 8h4a2 2 0 0 1 2 2v3M14 16h-4a2 2 0 0 1-2-2v-3"/>',
  split: '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/><path d="M7.5 9v6M16.5 9v6"/>',
  organize: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
  appendix: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 11h7M9 14h7M9 17h4"/><path d="M3 7v14h11" opacity=".7"/>',
  compress: '<path d="M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3"/><path d="M4 12h16"/>',
  repair: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.6-.6-2.5z"/>',
  ocr: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  pdfa: '<path d="M6 3h9l4 4v14H6z"/><path d="M9.5 17l2.5-7 2.5 7M10.4 14.6h3.2"/>',
  word: '<path d="M6 3h9l4 4v14H6z"/><path d="M8.5 11l1.5 6 2-5 2 5 1.5-6"/>',
  ppt: '<path d="M6 3h9l4 4v14H6z"/><path d="M10 17v-6h2.5a1.8 1.8 0 0 1 0 3.6H10"/>',
  excel: '<path d="M6 3h9l4 4v14H6z"/><path d="M9.5 11l5 6M14.5 11l-5 6"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M3 12h18"/>',
  jpg: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  markdown: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 15V9l2.5 3L11 9v6M15.5 9v6M13.5 13l2 2 2-2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  numbers: '<path d="M6 3h9l4 4v14H6z"/><path d="M10 13l2-1.5V18M10 18h4"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  sign: '<path d="M3 17c3-1 4-9 6-9s0 9 2 9 3-5 4-5 1 3 2 3 2-1 3-1"/><path d="M3 21h18"/>',
  redact: '<path d="M6 3h9l4 4v14H6z"/><rect x="8.5" y="10" width="8" height="3" fill="currentColor" stroke="none"/><path d="M8.5 16h5"/>',
  forms: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7.5 9h2M12 9h4.5M7.5 14.5l1.2 1.2 2-2.4M12 15h4.5"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  summarize: '<path d="M4 6h16M4 10h16M4 14h10M4 18h6"/><path d="M18 14l1 2.2 2.2 1-2.2 1L18 20.4l-1-2.2-2.2-1 2.2-1z"/>',
  translate: '<path d="M4 5h8M8 3v2M5.5 5c.8 3.2 3 5.5 6 6.5M10.5 5c-.8 3.5-3.2 6-6 7"/><path d="M13 21l4-9 4 9M14.4 18h5.2"/>',
  workflow: '<circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.2 6h9.6M6.2 8l4.6 8M17.8 8l-4.6 8"/>',
  file: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/>',
};

/** Tile colours by tool, close to the families the office already associates with each. */
const COLORS = {
  merge: '#e5533d', split: '#e5533d', organize: '#e5533d', rotate: '#c2569b', crop: '#c2569b',
  appendix: '#1f5fbf',
  compress: '#4c9a2a', repair: '#4c9a2a', ocr: '#4c9a2a', pdfa: '#3d6fb4',
  'word-to-pdf': '#2b5cb8', 'ppt-to-pdf': '#d0612b', 'excel-to-pdf': '#217346', scan: '#d9832b',
  'pdf-to-word': '#2b5cb8', 'pdf-to-ppt': '#d0612b', 'pdf-to-excel': '#217346', 'pdf-to-jpg': '#c9a227',
  'pdf-to-markdown': '#7b4fd6',
  edit: '#9b4fc9', 'page-numbers': '#9b4fc9', watermark: '#9b4fc9', sign: '#3d6fb4', redact: '#3a3f4a', forms: '#9b4fc9',
  protect: '#3d6fb4', unlock: '#3d6fb4',
  summarize: '#6a4fd6', translate: '#6a4fd6',
  workflow: '#e5533d',
};

function glyph(name) {
  return GLYPHS[name] || GLYPHS.file;
}

/** An inline SVG element for a tool, coloured tile included. */
function toolIcon(tool, size = 40) {
  const wrap = document.createElement('span');
  wrap.className = 'tool-icon';
  wrap.style.setProperty('--tile', COLORS[tool.id] || '#5b6270');
  wrap.style.width = wrap.style.height = `${size}px`;
  wrap.innerHTML =
    `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}" ` +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true">${glyph(tool.icon)}</svg>`;
  return wrap;
}

window.icons = { toolIcon, COLORS };
