'use strict';

const { session } = require('electron');

// This app handles medical and legal records. Nothing it touches may leave the
// machine, so outbound traffic is refused at the session layer rather than merely
// avoided in code — a future mistake still cannot exfiltrate anything.
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

module.exports = { lockDownNetwork, isAllowed, ALLOWED_SCHEMES };
