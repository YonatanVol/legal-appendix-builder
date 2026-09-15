'use strict';

/**
 * Serve a folder on the loopback address, for the CI's update test.
 *   node scripts/serve-dir.js <folder> <port>
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8321);

http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(root, name);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      console.log(`404 ${req.method} ${req.url}`);
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    console.log(`200 ${req.method} ${req.url} (${size} bytes)`);
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
