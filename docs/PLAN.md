# The office PDF suite: plan

Written 2026-10-07. The appendix builder grows into one program that replaces iLovePDF
for the law office of Ron Kalner, six people, each on their own Windows PC.

Decisions taken with Yonatan on 2026-10-07, not to be reopened:

| Question | Decision |
|---|---|
| Where it lives | This app becomes the suite. The appendix builder is one tool in it. One installer, one update link, the existing Windows CI. |
| Office conversions | Microsoft Office installed on the office PCs does the converting, driven in the background. LibreOffice is the fallback when it is installed; otherwise the tool says so. Nothing is bundled. |
| AI tools | Summarizer and Translate use the Claude API with a key the office enters. They stay off until the key exists, and say on screen that the text leaves the PC. |
| Deployment | One self-updating Windows app per PC, like today. No server. |
| Scope | Every iLovePDF tool except the three crossed out: JPG to PDF, HTML to PDF, Compare PDF. |

## Status, 2026-10-10

All eight phases are built, tested and reviewed, as version 2.0.0 on this branch. Where the
build differs from the plan below, it is because the plan's version did not hold up:

- **Crop's "find margins"** reads the drawn pages in the window instead of asking
  Ghostscript, which is instant and needs no file round trip.
- **Scan to PDF** applies the phone's orientation, straightens up to six degrees, and sets
  contrast and black and white. Cropping a photo to the page's corners stays in the
  document scanner app, as the plan said.
- **Redact** rebuilds the whole document through Ghostscript after the marked pages become
  pictures. The plan's per-page approach left recoverable content in the file; three rounds
  of review found the ways. Unmarked pages keep what they show: field values and stamps are
  drawn into the page, and hidden layers stay hidden. "Hidden" means what the screen hid:
  the marked pages are drawn by pdf.js, as the screen drew them, and the unmarked pages
  follow pdf.js's own layer rules, ported line for line. The file is first written afresh
  by qpdf, and pdf-lib reads that copy; then every page of the copy must read to pdf.js
  exactly as the file itself does (the same text, seen or not, the same drawing steps,
  the same picture). That check closes the class of files two readers read differently,
  which review kept finding new members of: comparing the result's look with the screen
  instead missed invisible text and needed masks that an annotation could abuse. Layers are settled once over
  every object in the file rather than followed from each page: five review rounds each
  found another place a hidden drawing could sit. Kept comments carry only plain values,
  and attached files never come across.
- **Sign** refuses a file that is already signed digitally, because rewriting it would break
  that signature; Acrobat Reader appends instead, and the message says so.
- **Workflows**: Merge and Unlock only first; Protect, Split and conversions only last.
- **Not verified on real hardware yet:** Microsoft Office conversions and the office scanner
  (GitHub's Windows machines have neither), and Summarize and Translate with a real key
  (tested against a local stand-in of the API).

## In plain words

Today each person opens a website, uploads a client's document to someone else's server,
and downloads the result. Instead, every PC gets one program with the same grid of tools.
Nothing leaves the PC except the two AI tools, which say so before they run. Each tool is
a short, obvious screen: drop files, set two or three options, press one button, get the
file, and go on to the next tool with the same file if needed.

## The tool grid

Thirty tools, grouped the way iLovePDF groups them, with search at the top.

| Group | Tools |
|---|---|
| Organize | Merge, Split, Organize pages, Rotate, Crop, Remove pages (inside Organize), **Appendix builder** |
| Optimize | Compress, Repair, OCR, PDF/A |
| Convert to PDF | Word, PowerPoint, Excel, Scan to PDF |
| Convert from PDF | PDF to Word, PDF to PowerPoint, PDF to Excel, PDF to JPG, PDF to Markdown |
| Edit | Edit PDF, Page numbers, Watermark, Sign, Redact, PDF Forms |
| Security | Protect, Unlock |
| Intelligence | AI Summarizer, Translate PDF |
| Workflows | Create a workflow, and every saved workflow as its own tile |

## What each tool does and how

The engine column names the piece of software that does the actual work. Three
kinds exist: pure JavaScript (pdf-lib, pdf.js, tesseract.js), two small command-line
programs shipped inside the installer (qpdf, Ghostscript), and programs already on the
office PC (Microsoft Office, a scanner).

| Tool | Engine | Options on screen | Notes |
|---|---|---|---|
| Merge | pdf-lib | Order by drag, thumbnails | Encrypted inputs are refused with the reason and a link to Unlock. |
| Split | pdf-lib | By ranges, every N pages, extract chosen pages, by file size | Page picker with thumbnails and shift/ctrl selection. |
| Organize | pdf-lib | Thumbnails: drag to reorder, delete, rotate, insert pages from another PDF, insert blank | Multi-select with shift and ctrl must work before anything else is built on it. |
| Rotate | pdf-lib | All or selected pages, 90/180/270 | Preview shows the rotated thumbnails. |
| Crop | pdf-lib (crop box) + Ghostscript (auto-detect margins) | Draw a box on a page, apply to this page or all; auto-crop white margins | Crop sets the crop box; the content stays and can be uncropped. |
| Compress | Ghostscript | Three levels, optional grayscale | Shows size before and after per file. Refuses to "compress" a file that would get bigger and keeps the original. |
| Repair | qpdf, then Ghostscript, then pdf-lib | None | Reports what was wrong and what was rewritten. |
| OCR | tesseract.js (Hebrew + English) | Languages, skip pages that already have text | Text layer written in logical order, the lesson learnt in the scanner app. Also exports .txt and .docx. |
| PDF/A | Ghostscript | PDF/A-1b, 2b, 3b | Honest result: "converted", not "validated"; the file's metadata is checked, nothing more. |
| Word / PowerPoint / Excel to PDF | Microsoft Office on the PC, else LibreOffice | None | Done through Office's own "Save as PDF". If neither is installed the tile says so and tells which to install. |
| PDF to Word | Microsoft Word (open PDF, save as .docx), else LibreOffice | Editable text, or page images | Word's PDF import keeps Hebrew text editable; scanned PDFs go through OCR first. |
| PDF to PowerPoint | Ghostscript render + pptxgenjs | One page per slide | Each slide is the page as an image, like iLovePDF. Said on screen. |
| PDF to Excel | pdf.js text positions + table detection + exceljs | One sheet per page or one sheet per table | Scanned PDFs go through OCR first. When no table is found, the text lands in column A, and the result says so. |
| PDF to JPG | Ghostscript | JPG or PNG, 72/150/300 dpi, pages or embedded images | Output is a folder next to the file, or a zip. |
| PDF to Markdown | pdf.js | Headings by font size, lists, images to a folder | |
| Scan to PDF | Windows WIA (the office scanner) + simple photo cleanup | Device, colour/grey/B&W, dpi, OCR afterwards | Phone photos get straighten and contrast; the full photo pipeline stays in the scanner app. |
| Edit PDF | pdf.js (preview) + Chromium overlay (text) + pdf-lib (images, shapes, drawing) | Text, image, rectangle, ellipse, line, arrow, freehand, highlight, whiteout; move, resize, delete, undo | Hebrew text is typeset by Chromium so it never comes out reversed. |
| Page numbers | Chromium overlay + pdf-lib | Position, format ("3", "3 מתוך 10", "עמוד 3"), first number, size, range, margin | Rotation-aware, reused from the appendix builder. |
| Watermark | Chromium overlay + pdf-lib | Text or image, position (grid or tiled), angle, opacity, size, range | |
| Sign | pdf-lib (+ @signpdf for a certificate file) | Draw, type or upload a signature, place and size it, add date and name; initials | Signatures are kept locally per person. A .pfx certificate adds a real digital signature; without one the signature is visual only, and the screen says which. |
| Redact | pdf.js (find) + Ghostscript (rasterize) + pdf-lib | Search text, patterns (ID number, phone, credit card), draw boxes, whole pages; preview; apply | Redacted pages are rasterized so the text is truly gone; metadata and annotations are stripped. Optional OCR of the rest afterwards. |
| PDF Forms | pdf-lib | Detect and fill fields; create text, checkbox, radio, dropdown, signature fields by drawing; flatten | |
| Protect | qpdf | Open password, owner password, AES-256, allow print/copy/edit | |
| Unlock | qpdf | Password if the file needs one | Owner-only restrictions are removed without a password; an open password is asked for. |
| AI Summarizer | pdf.js/OCR text + Claude API | Length, language, focus (facts, dates, parties, amounts) | Off until the key is entered. Says the text leaves the PC. Long documents are summarized in parts, then together. |
| Translate PDF | pdf.js/OCR text + Claude API + Chromium render | Target language | Produces a translated .docx and .pdf; layout is not preserved and the screen says so. |
| Workflows | the tools above, chained | Pick tools in order, fix their options, name it | Every tool's options are plain data so a workflow can store them. |
| Appendix builder | existing | existing | Moves under the grid unchanged. |

## The interface standard

- **Home** is the grid, Hebrew, right to left, with a search box that filters tiles as
  you type and a row of recent files. Every tile has a one-line truthful description.
- **A tool screen** has the same shape everywhere: a drop zone that accepts the file
  types the tool takes (and says which), the list of files with a thumbnail and page
  count, the options for that tool, one primary button, and a result card with Open,
  Show in folder, and "Continue with" the tools that take this output.
- **Progress** appears for anything slower than half a second: a bar, the stage in
  words ("עמוד 12 מתוך 40"), and Esc cancels. A cancelled run leaves no half-written file.
- **Nothing silent.** A disabled button says why next to it. A tool that cannot run on
  this PC (no Office, no scanner, no key) says that on its tile and on its screen, with
  what to do. A failure is a sentence a person can act on, never a stack trace.
- **Output** goes next to the source file as `<name> - <tool>.pdf`, never overwriting;
  a folder can be chosen once per tool and is remembered. Batch runs show each file's
  own status and keep going when one fails.
- **Keyboard**: Esc goes back or cancels; Ctrl+O opens files; Delete removes a selected
  page; shift and ctrl select ranges in every page grid; Ctrl+Z undoes in the editor.
- **Hebrew everywhere**: file names with Latin extensions are isolated so they never
  flip; generated text is typeset by Chromium; OCR writes logical order.
- **Speed**: thumbnails render lazily and stay cached per file; heavy work runs in a
  worker process so the window never freezes; cancelling kills the worker.
- **History** keeps every run (tool, inputs, output, options) so a run can be repeated
  or its output found again. File paths only, never copies of the documents.

## Architecture

```
src/main/
  index.js            start-up, single instance, updater (as today)
  security.js         network: nothing, except the updater session and the AI session
  tools/              one file per tool: { id, accepts, options, run(job, ctx) }
  engine/             pdf-lib helpers, Chromium overlay renderer, qpdf, Ghostscript,
                      Office automation (PowerShell scripts), WIA, tesseract worker
  jobs.js             queue, progress events, cancellation, temp files, output naming
  history.js          runs and arrangements
  settings.js         output folders, signatures, API key (Windows DPAPI-encrypted)
src/worker/           utilityProcess entry for CPU-heavy work (OCR, big pdf-lib jobs)
src/renderer/
  app.js              router: home, tool screens, appendix builder, workflows, settings
  screens/            one file per screen
  pdfjs/              page rendering and thumbnails
vendor/win/           qpdf and Ghostscript, fetched by scripts/fetch-vendor.js with
                      pinned versions and checksums; shipped outside the asar
```

A tool is a function of plain data. `run` receives the input paths, the options object
exactly as the screen produced it, and a context with `progress(fraction, text)`, an
`AbortSignal`, a scratch folder and the output-naming helper. That is what makes
workflows possible: a workflow is a list of `{ tool, options }`.

The renderer is served from `app://` instead of `file://`, as the scanner app does,
because `file://` blocks the Web Worker pdf.js needs for thumbnails.

### Engines and licences

| Engine | Licence | Why this one |
|---|---|---|
| pdf-lib | MIT | Already used; page operations, forms, embedding |
| pdf.js | Apache 2 | Thumbnails, text with positions, find |
| tesseract.js | Apache 2 | OCR with Hebrew, runs without a native module |
| qpdf | Apache 2 | Encryption, decryption, repair, the reference tool for PDF structure |
| Ghostscript | AGPL 3 | Compression, PDF/A, rasterizing, page images; the standard for all four |
| pptxgenjs, exceljs, docx | MIT | Writing Office files |
| Microsoft Office | on the PC | Highest-fidelity Hebrew conversions, nothing to ship |

Ghostscript's AGPL is fine here: the program is used inside one office and its source
is available to that office. It is recorded in the README's licence section.

### Privacy and security, honestly

- Documents never leave the PC. The default session has no network. The updater keeps
  its GitHub-only session. The two AI tools get a third session allowed to reach
  `api.anthropic.com` only, and only when a key is set.
- The API key is stored encrypted with Windows' own user-key store (DPAPI through
  Electron's `safeStorage`). Anyone running code as that Windows user can read it;
  the README says so.
- Office automation runs Word on the PC itself; nothing travels.
- Temporary files live in the app's own temp folder and are deleted when a run ends,
  succeeds or not.
- Redaction rasterizes, so redacted text is gone, not hidden. Metadata, annotations and
  attached files are removed with it; what an annotation shows on an unmarked page is
  drawn into that page.
- What it does not protect against: a compromised PC, a compromised GitHub publishing
  token (see the README), and the AI provider's own handling of the text that is sent.

## Verification

- **Each tool has its own test** on PDFs generated inside the test (pdf-lib and Chromium
  make them), so the suite runs on a fresh clone with no client documents.
- **Each screen has a UI test** that drives the real window: drop, options, run,
  cancel, result, error, disabled explanations.
- **Windows CI** (existing workflow): the installer carries qpdf and Ghostscript and
  they run from the installed location; LibreOffice is installed on the runner to test
  the fallback conversion path; the self-test runs one job of every engine.
- **What CI cannot verify**: Microsoft Office automation (not on GitHub's runners) and
  the scanner. Those are verified on an office PC and reported as such, never implied.
- **Hebrew is measured**: generated text is checked by glyph position, not by eye.
- Every phase ends with an independent review of its diff, fixes, the full suite, and a
  live run.

## Phases

Each phase is a branch that ends merged, green and run on screen.

1. **Foundation.** `app://`, the grid, the tool-screen frame, jobs with progress and
   Esc, thumbnails, output naming, history of runs, settings, the appendix builder moved
   under a tile. Nothing new for the user yet beyond the grid.
2. **Page tools.** Merge, Split, Organize, Rotate, Crop, Page numbers, Watermark,
   PDF to Markdown, Repair (pdf-lib path).
3. **Shipped engines.** qpdf and Ghostscript fetched and packaged; Protect, Unlock,
   Compress, PDF/A, PDF to JPG, PDF to PowerPoint, Repair (full), Crop auto-detect.
4. **Recognition.** OCR, Scan to PDF, Redact, PDF to Excel.
5. **Editing.** PDF Forms, Sign, Edit PDF.
6. **Office.** Word/PowerPoint/Excel to PDF, PDF to Word, LibreOffice fallback,
   detection and explanations.
7. **Intelligence.** Settings for the key, the AI session, Summarizer, Translate.
8. **Workflows**, then the release: version 2.0, What's New, Windows CI green, an
   installer that updates a 1.3.2 copy in place.

## Steps only Yonatan or the office can take

1. Enter the Claude API key on each PC that will use Summarizer and Translate
   (Settings, one field). Until then both tiles say they are off.
2. Confirm Microsoft Office is installed on the six PCs. Without it, install LibreOffice
   on the PCs that need conversions.
3. Try Scan to PDF once on the office scanner; its make and model go into a bug report
   if it fails. GitHub's machines have no scanner.
4. Send the six PCs the one download link (unchanged). Copies of 1.3.2 update themselves.
