'use strict';

const { session } = require('electron');

// This app handles medical and legal records. The parts that touch documents may not
// reach the network at all, so outbound traffic is refused at the session layer rather
// than merely avoided in code: a future mistake still cannot send anything anywhere.
//
// data: is required: generated pages are handed to Chromium as data: URLs so that no
// case details are ever written to a temporary file.
const ALLOWED_SCHEMES = new Set(['file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:']);

function isAllowed(url) {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function lockDownNetwork(targetSession = session.defaultSession) {
  targetSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !isAllowed(details.url) })
  );

  targetSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

/*
 * The one exception: checking for and downloading new versions.
 *
 * electron-updater does not use the default session. It opens its own partition,
 * named below, so the rule above never applied to it and it needs a rule of its own.
 * It may speak HTTPS to GitHub's release hosts and nothing else. The feed lives on
 * github.com and the files are handed over from GitHub's asset hosts by redirect.
 *
 * No document, file name, title or history entry ever travels on this session: the
 * updater asks GitHub which version is newest and downloads it, and that is all.
 */
const UPDATER_PARTITION = 'electron-updater';

const UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * A local feed exists only so the Windows CI can prove that an update really installs.
 * It is honoured solely on the loopback address, so it cannot be used to point the
 * updater at another machine.
 */
function loopbackFeed(feedUrl) {
  if (!feedUrl) return null;
  try {
    const feed = new URL(feedUrl);
    const loopback = feed.hostname === '127.0.0.1' || feed.hostname === 'localhost';
    return loopback && feed.protocol === 'http:' ? feed : null;
  } catch {
    return null;
  }
}

function isAllowedForUpdater(url, { testFeed } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  const feed = loopbackFeed(testFeed);
  if (feed && target.origin === feed.origin) return true;

  return target.protocol === 'https:' && UPDATE_HOSTS.has(target.hostname);
}

function lockDownUpdater(targetSession, options = {}) {
  targetSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !isAllowedForUpdater(details.url, options) })
  );
  targetSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

module.exports = {
  lockDownNetwork,
  isAllowed,
  ALLOWED_SCHEMES,
  lockDownUpdater,
  isAllowedForUpdater,
  loopbackFeed,
  UPDATER_PARTITION,
  UPDATE_HOSTS,
};
