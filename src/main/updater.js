'use strict';

const fs = require('fs');
const path = require('path');
const { app, ipcMain, session } = require('electron');

const { lockDownUpdater, loopbackFeed, UPDATER_PARTITION } = require('./security');

/*
 * Automatic updates.
 *
 * Rotem installs once. After that the installed app asks GitHub for a newer release,
 * downloads it in the background, and installs it the next time the program closes.
 * If she wants it sooner there is a restart button, which is refused while a filing
 * is being produced.
 *
 * The updater is the only part of the app allowed onto the network, and only to
 * GitHub over HTTPS: see lockDownUpdater in security.js. The downloaded installer is
 * checked against the SHA-512 published beside it before anything runs. The app is not
 * code-signed, so there is no publisher signature to check as well; the README says
 * plainly what that leaves open.
 */

const FIRST_CHECK_AFTER_MS = 8000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const LOG_LIMIT_BYTES = 256 * 1024;

const status = {
  phase: 'idle', // idle | disabled | checking | current | downloading | ready | error
  version: null,
  percent: null,
  notes: null,
  error: null,
  checkedAt: null,
};

let updater = null;
let windowRef = () => null;
let isBusy = () => false;
let justUpdated = null;
let ipcRegistered = false;

const userFile = (name) => path.join(app.getPath('userData'), name);

function log(line) {
  try {
    const file = userFile('update.log');
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT_BYTES) {
      fs.renameSync(file, `${file}.old`);
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never be the reason an update fails.
  }
}

/**
 * GitHub hands release notes over as HTML, or as a list of per-version entries. They
 * are shown to her as plain text only, never as markup.
 */
function plainNotes(notes) {
  const raw = Array.isArray(notes)
    ? notes.map((entry) => (entry && entry.note) || '').join('\n')
    : String(notes || '');

  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

function publish(patch) {
  // Once an update is waiting, a later background check that fails (say the laptop
  // went offline) must not hide the fact that one is ready to install.
  if (status.phase === 'ready' && patch.phase && patch.phase !== 'ready') {
    Object.assign(status, { checkedAt: patch.checkedAt || status.checkedAt });
  } else {
    Object.assign(status, patch);
  }

  const win = windowRef();
  if (win && !win.isDestroyed()) win.webContents.send('update:status', { ...status });
}

/** The notes of the version that has just been installed, delivered once. */
function takeJustUpdated(currentVersion) {
  try {
    const pending = JSON.parse(fs.readFileSync(userFile('pending-update.json'), 'utf8'));
    if (pending && pending.version === currentVersion) {
      fs.rmSync(userFile('pending-update.json'), { force: true });
      return { version: pending.version, notes: pending.notes || '' };
    }
  } catch {
    // No update was pending, or the note is unreadable; nothing to announce.
  }
  return null;
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('update:status', () => {
    const announce = justUpdated;
    justUpdated = null;
    return { ok: true, status: { ...status }, justUpdated: announce };
  });

  ipcMain.handle('update:install', () => {
    if (!updater || status.phase !== 'ready') {
      return { ok: false, error: 'אין עדכון שמוכן להתקנה.' };
    }
    // Restarting mid-build would kill a filing half written to disk.
    if (isBusy()) {
      return { ok: false, error: 'אפשר להפעיל מחדש אחרי שיצירת התיק תסתיים.' };
    }
    setImmediate(() => updater.quitAndInstall(true, true));
    return { ok: true };
  });
}

/**
 * @param {{getWindow: () => Electron.BrowserWindow|null, isBuilding: () => boolean, version: string}} options
 */
function start({ getWindow = () => null, isBuilding = () => false, version }) {
  windowRef = getWindow;
  isBusy = isBuilding;
  justUpdated = takeJustUpdated(version);
  registerIpc();

  // The CI proves updates install by serving a newer build from this machine. That
  // feed is honoured only in self-test mode and only on the loopback address.
  const selfTest = !!process.env.APPENDIX_BUILDER_SELFTEST;
  const feed = selfTest ? loopbackFeed(process.env.APPENDIX_BUILDER_SELFTEST_UPDATE_FEED) : null;

  const enabled =
    !process.env.APPENDIX_BUILDER_DISABLE_UPDATES &&
    (feed || (!selfTest && app.isPackaged && process.platform === 'win32'));

  if (!enabled) {
    publish({ phase: 'disabled' });
    return null;
  }

  lockDownUpdater(session.fromPartition(UPDATER_PARTITION, { cache: false }), {
    testFeed: feed ? feed.href : null,
  });

  // Required only now: electron-updater reads the app's paths as soon as it loads.
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;

  autoUpdater.logger = {
    info: (m) => log(`info ${m}`),
    warn: (m) => log(`warn ${m}`),
    error: (m) => log(`error ${m}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed.href });

  const now = () => new Date().toISOString();

  autoUpdater.on('checking-for-update', () => publish({ phase: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => publish({ phase: 'current', checkedAt: now() }));
  autoUpdater.on('update-available', (info) =>
    publish({ phase: 'downloading', version: info.version, percent: 0 })
  );
  autoUpdater.on('download-progress', (progress) =>
    publish({ percent: Math.round(progress.percent || 0) })
  );
  autoUpdater.on('update-downloaded', (info) => {
    const notes = plainNotes(info.releaseNotes);
    try {
      fs.writeFileSync(userFile('pending-update.json'), JSON.stringify({ version: info.version, notes }));
    } catch (err) {
      log(`could not remember the pending update: ${err.message}`);
    }
    publish({ phase: 'ready', version: info.version, notes, percent: 100, checkedAt: now() });
  });
  autoUpdater.on('error', (err) => {
    log(`error ${err && err.stack ? err.stack : err}`);
    publish({ phase: 'error', error: String((err && err.message) || err), checkedAt: now() });
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => log(`check failed: ${err.message}`));

  setTimeout(check, feed ? 0 : FIRST_CHECK_AFTER_MS);
  const timer = setInterval(check, CHECK_EVERY_MS);
  if (timer.unref) timer.unref();

  return autoUpdater;
}

/** Test seam: drive the state machine without a real release on GitHub. */
const forTest = {
  setStatus: (patch) => publish(patch),
  setUpdater: (fake) => {
    updater = fake;
  },
  reset: () => {
    Object.assign(status, { phase: 'idle', version: null, percent: null, notes: null, error: null, checkedAt: null });
    updater = null;
  },
};

module.exports = { start, plainNotes, takeJustUpdated, status, forTest };
