'use strict';

/**
 * Renders assets/icon.html to assets/icon.png, which electron-builder turns into the
 * Windows .ico at package time. Run with:  npx electron assets/make-icon.js
 */

const fs = require('fs/promises');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZE = 512;
const OUT = path.join(__dirname, 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    useContentSize: true,
    frame: false,
    // Without these the capture comes back opaque and the rounded corners become a
    // white square once Windows draws the icon.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadFile(path.join(__dirname, 'icon.html'));
  const image = await win.webContents.capturePage();
  await fs.writeFile(OUT, image.toPNG());

  const { width, height } = image.getSize();
  console.log(`wrote ${OUT} — ${width}x${height}`);
  win.destroy();
  app.exit(width >= 256 && height >= 256 ? 0 : 1);
});
