'use strict';

/**
 * How to read an update check made against the real GitHub.
 *
 * Before a repository's first release is published, GitHub does not say "no releases".
 * electron-updater reads the release feed (which lists a tag as soon as it is pushed)
 * and then asks /releases/latest for the newest published release. With none published,
 * that redirects to the release list, which has no JSON form, and GitHub answers 406
 * (or 404). The first tag-triggered release run hits exactly this.
 *
 * That answer still proves what the check is for: the installed app's own settings and
 * its network rule got it to this repository on GitHub. So it counts as reached, but
 * only for this repository and only with those statuses. A blocked request, another
 * repository, or any other error is not reached.
 */

function githubReachable(result, { owner, repo }) {
  if (result && result.ok) return { reached: true, why: 'the check succeeded' };

  const update = (result && result.update) || {};
  const error = String(update.error || '');

  if (/No published versions on GitHub/.test(error)) {
    return { reached: true, why: 'GitHub lists no release yet' };
  }

  const latest = `https://github.com/${owner}/${repo}/releases/latest`;
  const noProductionRelease =
    error.includes(`Unable to find latest version on GitHub (${latest})`) &&
    /please ensure a production release exists: HttpError: (404|406)\b/.test(error);
  if (noProductionRelease) {
    return { reached: true, why: 'GitHub has this repository but no published release yet' };
  }

  return { reached: false, why: error.split('\n')[0] || 'no answer recorded' };
}

module.exports = { githubReachable };
