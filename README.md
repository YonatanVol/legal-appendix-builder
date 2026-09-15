# Legal Appendix Builder

A Windows desktop app that assembles a legal filing: it takes the pleading and the
exhibit PDFs and produces one court-ready document, with a divider page before each
exhibit, a generated table of contents, and continuous page numbering across the whole
bundle.

Built for an Israeli law practice, so the interface and the generated pages are in
Hebrew. [README בעברית](README.he.md).

Documents never leave the machine. The app handles medical records, so the part that
touches documents has no network access at all, blocked at the session layer rather than
merely avoided in code. The single exception is the updater, which may reach GitHub's
release hosts over HTTPS and nothing else. See [Updates and what they change](#updates-and-what-they-change).

## The problem

Assembling a filing by hand is mechanical and brittle. The pleading is merged with the
scanned exhibits, a divider page is inserted before each one, a contents page lists the
page range of every exhibit, and the whole bundle is numbered. Add or remove a single
document and **every range and every number shifts**, so the contents page and all the
divider pages have to be redone.

```
pages 1..B      the pleading
page  B+1       נספחים / תוכן עניינים   (contents; more than one page if there are many)
                for each exhibit:
                  one divider page   "נספח N" / title / "עמ' X-Y"
                  the exhibit's pages
```

Numbering runs 1..N across **every** page, including the generated ones and the scans.
A divider page is not counted inside the range of the exhibit it introduces.

## What is interesting here

**Chromium is used as a typesetter.** The generated pages mix Hebrew with Latin digits
and dates (`עמ' 10-17`, `07/07/26`). A PDF library that draws text directly needs the
bidirectional ordering resolved by hand, and mistakes there are only visible to the eye.
So divider and contents pages are authored as HTML and printed through Chromium, which
resolves the ordering correctly and makes a dotted leader a single CSS rule.

**The contents page is a fixed point.** It prints the page ranges, and its own length
shifts them. `computeLayout` is resolved against the renderer, re-rendering until the
contents page stops changing length. See [`src/main/pdf/layout.js`](src/main/pdf/layout.js).

**Dot leaders are measured, not guessed.** CSS has no stretchy box inside a run of text,
so the gap left on the last line of a wrapped title is measured after layout and exactly
that many periods are inserted. For the measurement to be valid, the sheet is given an
explicit width in points equal to the printable width: a block with a set width lays out
identically whatever the viewport is, so what is measured on screen is what the print
engine lays out. An invariant then holds the result: adding a leader must never make a
row taller or push the range onto another line, and the count is reduced until that is
true.

**The typeface is bundled deliberately.** The David that ships with Windows is marked
non-embeddable, so Chromium cannot place it in the PDF and converts the text to vector
outlines. The page then looks perfect and contains no text at all: nothing on the
contents or divider pages can be searched, selected or copied, which matters for a court
filing. The Culmus build of the same typeface embeds normally, and a test now asserts
that the Hebrew face is embedded.

## Reopening a filing

Every bundle that is produced is recorded, and a side tab lists them. Opening one puts
the edit screen back the way it was, so correcting a letter means swapping one file and
rebuilding rather than reselecting everything and retyping every title.

Only the arrangement is stored: which files, in what order, under what titles. The
documents stay where they are. They are medical records, and copying them into the app's
own folder would be both a privacy cost and hundreds of megabytes per case. What was lost
after a build was never the files.

Two details carry most of the weight:

- **Files are read again on every reopen** rather than trusting the page counts that were
  stored. A corrected letter is a different length, and stale counts would put every range
  in the table of contents quietly wrong.
- **A file that has moved does not fail the reopen.** It comes back marked as missing with
  a button to locate it, the rest of the arrangement loads, and the build stays blocked
  until it is found, with the summary line saying so.

The record lives in the user's own application data folder and holds file paths and
appendix titles, which name clients. That is the same exposure as the documents
themselves, the network lockdown covers it, and each row can be deleted.

## Testing against a known-correct answer

The suite rebuilds a real 49-page filing that was actually submitted. It is split back
into its parts, the app reassembles them, and the result is compared against the
original: page count, every range, page sizes, and the text of the body and exhibit
pages, page by page.

That document is a client record and **is not in this repository**, so `test/fixtures/`
is empty on a fresh clone and the suite will not run without it. Point
`npm run split-reference` at a comparable filing to regenerate the fixtures.

160 checks across six suites:

| Suite | Covers |
|---|---|
| `test:build` + `test:verify` | Full rebuild of the reference filing and comparison against it, including font embedding |
| `test:edge` | Page rotation in all four orientations, an exhibit spanning several files, 26 exhibits overflowing the contents onto a second page, a title wrapping to two lines and its leader, margin overrun, and rejected input |
| `test:ui` | The interface itself: suggested titles, live range preview, reordering, build gating |
| `test:history` | Recording, reopening, rebuilding over the same file, a corrected pleading, a file that moved, a damaged store, and a store that cannot be written |
| `test:history-ui` | The drawer, driven with real pointer sequences: opening, search, escape and focus, reopening a case, a missing file, and two presses landing at once |
| `test:config` | Configuration a runtime test would only catch too late: every runtime module ships, the installer and app agree on the app id, releases come only from tags, no dashes in Hebrew copy |
| `test:updater-ui` | The update notices, the restart button, and the main process refusing to restart during a real build |
| `test:security` | Both network rules are real and attached to the sessions actually used, and neither breaks page generation |
| `test:selftest` | The app's own self-test, run from source; the Windows workflow runs the same one against the installed program |

## Installing

Download `AppendixBuilder-Setup-<version>.exe` from the
[latest release](https://github.com/YonatanVol/appendix-builder-releases/releases/latest)
and double-click it. It installs for the current user only, with no administrator
prompt, opens the app, and adds a desktop and Start-menu shortcut.

The app is not code-signed, so the first time Windows shows *"Windows protected your
PC"*. Choose **More info** and then **Run anyway**. Updates do not show this again.

Version 1.2.0 shipped as a zip instead, and it failed on the first real machine with
*"ffmpeg.dll was not found"*: the exe loads that DLL at start-up and had been run
without the files beside it. Installers replace zips for that reason.

## Updates and what they change

Installed copies update themselves. About eight seconds after start, and every four
hours after that, the app asks GitHub for a newer release. A newer version downloads in
the background and installs the next time the app closes. A notice offers to restart
now instead, and that restart is refused while a filing is being written. After an
update the app says which version it now is and shows the release notes.

An auto-updater runs code fetched from the internet, so it is worth being exact about
what protects it:

- **Only GitHub, only HTTPS.** electron-updater uses its own session, separate from the
  one documents are handled in. `src/main/security.js` restricts that session to
  GitHub's release hosts; the document session keeps no network access. `test/security.js`
  proves both rules are attached to the sessions actually used.
- **A checksum, not a signature.** Each installer is checked against the SHA-512
  published beside it in `latest.yml`. That catches a corrupted or altered download.
  Both files come from the same release, though, so it does not help if the release
  itself is replaced, and because the app is unsigned there is no publisher signature
  to check as well.
- **So publishing rights are the key.** Anyone who can publish to the releases repository
  (through the GitHub account, the `RELEASES_TOKEN` secret, or a `v*` tag on this
  repository) can ship code that runs on the user's machine with access to her client
  files. Keep two-factor authentication on the account, keep that token scoped to the
  releases repository alone, and restrict who can create tags. A code-signing certificate
  would add the missing signature check and remove the SmartScreen warning on first install.

**Where updates come from.** This repository, with the source, is private. Installers and
update files are published to a separate public repository,
[`appendix-builder-releases`](https://github.com/YonatanVol/appendix-builder-releases),
which holds no code. An installed app cannot update from a private repository without
carrying a credential that anyone holding the installer could extract, so it reads the
public one and carries none. Keeping the source private has a natural limit: an Electron
installer contains the app's JavaScript.

The updater writes to `update.log` in the app's data folder
(`%APPDATA%\rotem-office`). Setting `APPENDIX_BUILDER_DISABLE_UPDATES=1` turns
updates off.

## Building and releasing

```bash
npm install
npm start          # run the app
npm test           # run every local suite
```

**Windows builds happen on Windows**, in `.github/workflows/windows.yml`, on every push.
This Mac can no longer build for Windows at all: electron-builder's Wine and `makensis`
are Intel binaries, and macOS 27 has no Rosetta. The workflow:

1. builds the installer and checks, from the exe's import table, that every DLL it loads
   at start-up sits beside it (`scripts/check-win-package.js`);
2. installs it silently, the way a user installs it, and checks the installed folder the
   same way;
3. launches the installed program in self-test mode, where it opens its window, produces
   a filing through the build button's own path, confirms the generated pages carry
   embedded text, and records and reopens it from history (`src/main/selftest.js`);
4. launches it twice and checks the second launch hands over to the open window;
5. checks that the installed program's own update settings (`resources/app-update.yml`)
   point at this repository, and that with them it reaches the real GitHub through its
   network rule. The update test below uses a local feed, which bypasses those settings;
6. proves updates end to end: a tampered update is refused, a genuine one downloads and
   installs, and the updated program still passes its self-test.

After each release, and weekly, a further job installs the published release and asks the
real GitHub for updates through the same rule. If GitHub changes the hosts it serves
downloads from, that job fails and GitHub emails the repository owner, instead of
installed copies silently never updating.

**One-time setup, and once a year after.** Publishing needs a token that can write to the
releases repository and nothing else:

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Name it `appendix-builder releases`, set an expiration (a year at most), and under
   **Repository access** choose **Only select repositories** and pick `appendix-builder-releases`.
3. Under **Permissions**, set **Contents** to **Read and write**. Nothing else.
4. Generate it, then store it as a secret of this repository (it asks for the value and
   does not echo it):
   `gh secret set RELEASES_TOKEN --repo YonatanVol/legal-appendix-builder`

The weekly check fails, and GitHub emails you, when the token expires or loses access.

The pipeline runs for `main`, for version tags and for pull requests, not for every branch:
Actions minutes are metered for private repositories, and Windows minutes count double.

To release, add the version's notes to [CHANGELOG.md](CHANGELOG.md) first. The text
before a version's first `###` heading is what the user sees after updating; the
workflow refuses to release a version without it. Then:

```bash
npm version minor        # or patch: commits and creates the tag v1.4.0
git push --follow-tags   # the workflow verifies it on Windows, then publishes it
```

Installed copies pick the release up at their next check. The version appears in the
window title, in the app header, and in the installer's file name.

## Layout of the code

| Path | Role |
|---|---|
| `src/main/pdf/layout.js` | Page-range arithmetic and the fixed-point resolution of the contents page |
| `src/main/pdf/render.js` | HTML to PDF through Chromium's print engine |
| `src/main/pdf/assemble.js` | Merging, and rotation-aware page numbering |
| `src/main/pdf/inspect.js` | Reading and validating input PDFs |
| `src/main/templates/` | The divider and contents pages as HTML, and the leader measurement |
| `src/main/security.js` | The network lockdown, and the updater's narrower exception |
| `src/main/updater.js` | Checking, downloading and installing updates |
| `src/main/selftest.js` | The self-test the Windows workflow runs inside the installed program |
| `src/main/window.js` | The one window, shared by the app and the self-test |
| `scripts/` | Windows package check, self-test runner, local update feed, release notes |

## Things that cost real time

- **`printToPDF` takes `pageSize` in inches.** Getting the unit wrong produces pages
  thousands of times too large while the text still extracts perfectly, so every
  text-based test passes. `test/verify.js` asserts the page size for that reason.
- **Creating and destroying a window per page fails on the second page**, sometimes
  taking the process with it. `render.js` keeps one hidden window and reuses it.
- **A build that works on the development machine is not an install that works.** The
  first person to install 1.2.0 never saw a window. Every test had run from source on a
  Mac; nothing had ever launched the program on Windows. The workflow now installs and
  runs it there before anything is released.
- **Page margins must be given to `printToPDF`, not written as CSS padding.** Padding on
  a block spanning several pages is laid down only at the start and end of the flow, so
  a contents page running onto a second page is cut off at the bottom. For the same
  reason the templates carry no `@page { margin }` rule, because it would override the margins
  the engine is given.

## Licence

The code is MIT (see [LICENSE](LICENSE)).

`assets/fonts/` contains the David typeface from the Culmus project, under GPL v2 with
the font exception: embedding it in a document does not place that document under the
GPL. See `assets/fonts/LICENSE-culmus.txt`.
