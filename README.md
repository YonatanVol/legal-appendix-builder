# Office PDF tools (כלי המשרד)

A Windows desktop app that replaces iLovePDF for a six-person Israeli law office: thirty
PDF tools behind one home screen, in Hebrew, working on the PC itself. It grew out of the
office's appendix builder, which is now one of its tools and works exactly as before.
[README בעברית](README.he.md).

## The tools

| Group | Tools |
|---|---|
| Organize | Appendix builder, Merge, Split, Organize pages, Rotate, Crop |
| Optimize | Compress, Repair, OCR (Hebrew and English), PDF/A |
| To PDF | Word, PowerPoint, Excel, Scan (office scanner or phone photos) |
| From PDF | Word, PowerPoint, Excel, JPG, Markdown |
| Edit | Edit PDF, Page numbers, Watermark, Sign (with an optional .pfx digital signature), Redact, Forms |
| Security | Protect, Unlock |
| AI | Summarize, Translate (Claude; off until a key is entered) |
| Workflows | Chains of tools saved as tiles of their own |

Every tool has the same screen: drop or pick files, thumbnails, the tool's options with a
preview of the result where there is one, one button, progress with Esc to cancel, and a
result card that opens the file, shows it in its folder, or continues with another tool.
Results go beside the source, as `<name> - <what>.pdf`, and never over an existing file.

## Where documents go

Documents never leave the PC, with two exceptions, each in a network session of its own
whose only permitted destination is enforced by a rule on that session:

- **Updates** may reach GitHub's release hosts over HTTPS. No document travels this way.
- **Summarize and Translate** may reach `api.anthropic.com` over HTTPS, and only after the
  office has entered an API key, and only when one of those two tools is run. The screen
  says before the button is pressed that the document goes to Anthropic.

The session that handles documents reaches nothing. `test/security.js` and `test/ai.js`
prove each rule against a control session that does reach the same addresses, so a
"blocked" result means the rule worked, not that the machine was offline.

The Claude API key is stored encrypted with Windows' protection for the signed-in user
(DPAPI, through Electron's safeStorage), shown only as a hint, and never sent to the page
or written to the run history. That keeps it from other users of the PC and from a copied
file; a program already running as the same Windows user can still ask Windows to decrypt
it, as this app does.

Passwords (Protect, Unlock, a certificate's) reach qpdf through its standard input, never a
command line, and are never recorded. Saved signatures are pictures in the app's data
folder on this PC.

## The engines

| Engine | Used for | Licence | How it ships |
|---|---|---|---|
| pdf-lib | Page operations, forms, drawing | MIT | Inside the app |
| pdf.js | Thumbnails, text with positions | Apache 2.0 | Inside the app |
| Chromium (Electron) | Hebrew text typeset onto pages, image work | BSD | The app itself |
| qpdf 12.4.2 | Encryption, decryption, repair | Apache 2.0 | Beside the app, checksum-pinned |
| Ghostscript 10.08.0 | Compression, PDF/A, page images, OCR input | AGPL 3.0 | Beside the app, checksum-pinned |
| Tesseract (tesseract.js 7) | OCR, Hebrew and English | Apache 2.0 | Inside the app, language data included |
| Microsoft Office | Word, Excel, PowerPoint conversions | | Already on the PC |
| LibreOffice | The same, when Office is missing | MPL 2.0 | Not shipped; used if installed |
| Claude Opus 5.5 | Summaries and translations | | Anthropic's API, with the office's key |

Ghostscript is AGPL: the app is used within one office, and its source is available to
that office. `scripts/fetch-vendor.js` downloads qpdf and Ghostscript for the Windows build
and refuses a file whose SHA-256 differs from the one pinned in it.

## What is verified where

- **Here, on every change:** 21 test suites, from the tool grid to each tool's output read
  back independently (pdf.js, qpdf, OpenSSL, exceljs, pixels drawn by Ghostscript).
- **On Windows, in GitHub Actions:** the installer is built, installed the way a user
  installs it, and the installed program runs its self-test, which includes a job through
  every engine (pdf.js, Chromium stamping, qpdf, Ghostscript, PDF/A, OCR from inside the
  package). The PowerShell scripts for Office and the scanner are parsed by Windows'
  PowerShell parser.
- **Only on an office PC:** Microsoft Office conversions and the office scanner. GitHub's
  machines have neither. The LibreOffice route of the same tools is tested here.
- **Not yet with a real key:** Summarize and Translate are tested against a local stand-in
  for Anthropic's API, which checks exactly what is sent. Their first live run is the
  office's.

## The appendix builder

The sections below describe the appendix builder, the app's first tool, and then the
installing, updating and release process, which is the same for the whole app.

### The problem

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

The suites, all run by `npm test`:

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
| `test:shell` | The tool grid and the shared tool screen in the real window: search, coming-soon tiles, drop and reorder, run, cancel, results, continuing into another tool, recent runs, what the page may read |
| `test:page-tools` | Split, Organize, Rotate, Crop, Page numbers, Watermark, Markdown and Repair, each output read back: order, rotation, crop boxes, where stamped Hebrew lands on pages turned every way |
| `test:page-panels` | The same tools' screens: Explorer-style selection, drag to reorder, Delete and Ctrl+Z, the crop frame and margin detection, live previews |
| `test:engine-tools` | Protect, Unlock, Compress, PDF/A, PDF to JPG and PowerPoint, Repair with qpdf and Ghostscript; passwords never on a command line; a Hebrew temp folder |
| `test:recognition` | OCR on pages turned every way, Scan to PDF, Redact (files hiding a secret every way review found, each checked to come out as one picture per page with no trace of it), PDF to Excel |
| `test:editing` | Edit PDF checked by pixels on turned pages, signatures verified with OpenSSL, forms filled, created and flattened |
| `test:office` | Word, PowerPoint and Excel to PDF and PDF to Word, through LibreOffice |
| `test:ai` | Summarize and Translate against a local stand-in for the API, the key store, and the network fence |
| `test:workflows` | Building, saving and running chains of tools, passwords asked for at run time |

## Installing

Download the installer from this link, which never changes and always serves the newest
release: <https://github.com/YonatanVol/appendix-builder-releases/releases/latest/download/AppendixBuilder-Setup.exe>. Then double-click it. It installs for the current user only, with no administrator
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

On a Mac, `run.command` does the same with a double-click in Finder: it installs what is
missing the first time and opens the app as a Mac app of its own, so its Terminal window can
be closed. To keep it in the Dock or on the Desktop, use an alias of it (it runs the code in
its own folder).

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
| `scripts/` | Windows package check, self-test runner, local update feed, release notes, vendor fetch, PowerShell syntax check |
| `src/main/tools/` | One module per tool: `run({ inputs, options, ctx })`, and the registry (`index.js`) |
| `src/main/jobs.js` | Running a tool: progress, Esc, scratch folders, results written beside the source under names claimed atomically |
| `src/main/engine/` | qpdf and Ghostscript (`binaries.js`), OCR process, image work, Office and scanner scripts, Claude |
| `src/main/pdf/stamp.js` | Placing things on pages by where they appear, on pages of any rotation; Hebrew typeset by Chromium |
| `src/main/pdf/text.js` | Reading text with positions, ordered by Unicode bidirectional rules |
| `src/main/protocol.js` | Serving the page on app://office, and documents by token only |
| `src/renderer/shell.js` | The home grid, the shared tool screen, settings, the workflow builder |
| `src/renderer/panels.js` | Each tool's options and previews |
| `src/renderer/pagegrid.js`, `pageeditor.js` | The page grid and the page editor |

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

## Things that cost real time, in the suite

- **pdf-lib keeps every object it read.** Removing a page and saving leaves the page,
  its fonts and its text in the file, unreferenced and invisible. Redaction therefore
  builds a new document holding only pictures of the pages.
- **qpdf's `--remove-unreferenced-resources` does nothing** unless pages are being selected
  with `--pages`. A test that hides content in inherited resources is what showed it.
- **A top-level `const api` in a page script collides with `window.api`** from the preload
  bridge, and the whole script silently fails to load. Shared scripts declare nothing at
  the top level.
- **pdf.js gives a Latin run inside a Hebrew line in visual order**, so a sentence's full
  stop arrives glued to the front of an English word, and a date split into two runs comes
  back scrambled. `text.js` orders runs and punctuation by the Unicode bidirectional rules.
- **pdf.js 6 needs a newer Chromium than Electron 33 has** (`Uint8Array.toHex`); 4.10 is
  pinned.
- **Ghostscript turns pure junk into a blank page and reports success**, and qpdf writes a
  cut-off file back without its catalogue. Results are accepted only when a strict reader
  opens them with the expected pages.

## Licence

The code is MIT (see [LICENSE](LICENSE)). The engines it ships or uses are listed with their
licences under [The engines](#the-engines); `assets/tessdata/` and `assets/pdfa/` say where
their files come from.

`assets/fonts/` contains the David typeface from the Culmus project, under GPL v2 with
the font exception: embedding it in a document does not place that document under the
GPL. See `assets/fonts/LICENSE-culmus.txt`.
