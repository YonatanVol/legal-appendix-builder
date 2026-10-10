'use strict';

const fs = require('fs/promises');
const path = require('path');
const { protocol } = require('electron');

const docs = require('./docs');

/*
 * The renderer is served from app:// rather than file://. file:// blocks the Web Worker
 * pdf.js needs for thumbnails, blocks ES modules, and gives an opaque origin. The scheme
 * is registered as "standard": without that flag the origin stays opaque and relative
 * URLs misparse, so registering it would buy nothing. This is the same arrangement the
 * scanner app settled on after its own spike.
 */
const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  codeCache: true,
  bypassCSP: false,
  allowServiceWorkers: false,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
};

// 'wasm-unsafe-eval' is needed by pdf.js's image decoders; under a bare script-src
// 'self' Chromium refuses WebAssembly and the only symptom is a console error.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const HOST = 'office';
const ORIGIN = `app://${HOST}`;
const INDEX_URL = `${ORIGIN}/index.html`;

// A document the user has opened is served under this prefix by token, never by path:
// the renderer can only read files the main process has been handed. See docs.js.
const DOC_PREFIX = 'doc';

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: PRIVILEGES }]);
}

/**
 * Serve app://office/<path> from disk.
 *
 * One host with path mounts rather than a host per root, because two hosts under a
 * standard scheme are different origins and the pdf.js worker could not be loaded
 * across them. Files are read through Node's fs, not net.fetch(pathToFileURL()):
 * inside a packaged app the renderer lives in app.asar, which Node sees through and
 * Chromium's file loader does not. That pattern 404s only after packaging.
 *
 * @param {Electron.Session} ses
 * @param {Array<[string, string]>} mounts  URL path prefix -> absolute directory
 */
function registerAppProtocol(ses, mounts) {
  const table = mounts
    .map(([prefix, dir]) => [prefix.replace(/^\/+|\/+$/g, ''), path.resolve(dir)])
    .sort((a, b) => b[0].length - a[0].length);

  ses.protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response('unknown host', { status: 404 });

    // Decode first, or %2e%2e%2f walks out of the root after the check.
    const reqPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    if (reqPath === DOC_PREFIX || reqPath.startsWith(DOC_PREFIX + '/')) {
      return serveDocument(reqPath.slice(DOC_PREFIX.length + 1));
    }

    const mount = table.find(([prefix]) =>
      prefix === '' || reqPath === prefix || reqPath.startsWith(prefix + '/'));
    if (!mount) return new Response('not found', { status: 404 });

    const [prefix, root] = mount;
    const rel = prefix ? reqPath.slice(prefix.length).replace(/^\/+/, '') : reqPath;
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    let body;
    try {
      body = await fs.readFile(abs);
    } catch {
      console.error(`[app://] 404 ${url.pathname} -> ${abs}`);
      return new Response('not found', { status: 404 });
    }

    const ext = path.extname(abs).toLowerCase();
    if (!MIME[ext]) console.error(`[app://] no MIME type for "${ext}" (${url.pathname})`);

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
      },
    });
  });
}

async function serveDocument(token) {
  const filePath = docs.resolve(token);
  if (!filePath) return new Response('unknown document', { status: 404 });
  try {
    const body = await fs.readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(`cannot read document: ${err.message}`, { status: 404 });
  }
}

/** Where the renderer's files are, in development and inside the packaged asar alike. */
function defaultMounts() {
  const root = path.join(__dirname, '..', '..');
  return [
    ['', path.join(root, 'src', 'renderer')],
    ['pdfjs', path.join(root, 'node_modules', 'pdfjs-dist', 'build')],
    ['pdfjs-cmaps', path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps')],
    ['pdfjs-fonts', path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts')],
    ['fonts', path.join(root, 'assets', 'fonts')],
  ];
}

module.exports = {
  registerSchemes,
  registerAppProtocol,
  defaultMounts,
  HOST,
  ORIGIN,
  INDEX_URL,
  DOC_PREFIX,
  CSP,
  MIME,
};
