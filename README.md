# Legal Appendix Builder

A local Windows desktop app that assembles a legal filing: it takes the pleading and the
exhibit PDFs and produces one court-ready document — a divider page before each exhibit,
a generated table of contents, and continuous page numbering across the whole bundle.

Built for an Israeli law practice, so the interface and the generated pages are in
Hebrew. [README בעברית](README.he.md).

Everything runs on the machine. The app handles medical records, so outbound network
access is blocked at the session layer rather than merely avoided in code.

## The problem

Assembling a filing by hand is mechanical and brittle. The pleading is merged with the
scanned exhibits, a divider page is inserted before each one, a contents page lists the
page range of every exhibit, and the whole bundle is numbered. Add or remove a single
document and **every range and every number shifts**, so the contents page and all the
divider pages have to be redone.

```
pages 1..B      the pleading
page  B+1       נספחים – תוכן עניינים   (contents; more than one page if there are many)
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
contents page stops changing length — see [`src/main/pdf/layout.js`](src/main/pdf/layout.js).

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
outlines. The page then looks perfect and contains no text at all — nothing on the
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
| `test:security` | The network lockdown is real, and does not break page generation |

## Running it

```bash
npm install
npm start          # run the app
npm test           # run every suite
npm run build:win  # package for Windows -> dist/
```

Packaging targets `zip`, which builds from macOS without Wine, unlike the NSIS
installer targets.

### Releases

Raise the version before packaging, or the new build silently replaces the previous
download and the two cannot be told apart:

```bash
npm version patch   # bug fix
npm version minor   # feature or visible change
npm run build:win
```

The version comes from `package.json` and appears in the window title, in the app
header, and in the artifact filename. See [CHANGELOG.md](CHANGELOG.md).

## Layout of the code

| Path | Role |
|---|---|
| `src/main/pdf/layout.js` | Page-range arithmetic and the fixed-point resolution of the contents page |
| `src/main/pdf/render.js` | HTML to PDF through Chromium's print engine |
| `src/main/pdf/assemble.js` | Merging, and rotation-aware page numbering |
| `src/main/pdf/inspect.js` | Reading and validating input PDFs |
| `src/main/templates/` | The divider and contents pages as HTML, and the leader measurement |
| `src/main/security.js` | The network lockdown |

## Three things that cost real time

- **`printToPDF` takes `pageSize` in inches.** Getting the unit wrong produces pages
  thousands of times too large while the text still extracts perfectly, so every
  text-based test passes. `test/verify.js` asserts the page size for that reason.
- **Creating and destroying a window per page fails on the second page**, sometimes
  taking the process with it. `render.js` keeps one hidden window and reuses it.
- **Page margins must be given to `printToPDF`, not written as CSS padding.** Padding on
  a block spanning several pages is laid down only at the start and end of the flow, so
  a contents page running onto a second page is cut off at the bottom. For the same
  reason the templates carry no `@page { margin }` rule — it would override the margins
  the engine is given.

## Licence

The code is MIT (see [LICENSE](LICENSE)).

`assets/fonts/` contains the David typeface from the Culmus project, under GPL v2 with
the font exception — embedding it in a document does not place that document under the
GPL. See `assets/fonts/LICENSE-culmus.txt`.
