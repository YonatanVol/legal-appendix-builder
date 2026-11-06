# 2026-10-18: a locked pension statement was called damaged

## The report

A screenshot of the Unlock tool (2.0.0 trial build) with a pension fund's periodic
statement in its file list, the row red, and the message sent with it:

> איך פגום לא הבנתי

The row said the file was damaged or unsupported and suggested Repair. The password was
known; the file opened in an ordinary PDF reader with it.

## What was wrong

The file was sound and locked: RC4 encryption, revision 3, with its objects (the page tree
among them) kept in compressed object streams. Those streams are encrypted too.

- When a file is added to a tool, `describe()` loaded it with pdf-lib, which cannot
  decrypt, and asked for its page count before checking whether it was encrypted.
- With the page tree inside an encrypted object stream, pdf-lib could not find the pages
  and threw. The catch-all turned that into "damaged", so the file never got the
  "protected" label that Unlock accepts.
- A locked file without object streams was read correctly, which is why the existing
  tests (encrypted by qpdf with its defaults) never showed it. Statements from banks and
  pension funds commonly use object streams.
- The Unlock tool itself was never at fault: its own check uses pdf.js, which reports a
  password request, and qpdf decrypts the file. Run directly, it opened the statement
  (4 pages).

## The fix

`describe()` reads `isEncrypted` first, and counts pages only if it can. A locked file
whose pages cannot be counted is listed as protected, its page count unknown until the
password comes off. An unencrypted file that throws is still called damaged.

Found while reviewing the fix: a saved workflow that starts with Unlock refused a locked
file on the screen, since its tile did not say it accepts locked files (the workflow itself
handled them). Its tile now does.

## The test

`test/engine-tools.js` makes a locked file with `--object-streams=generate` in both
encryptions (RC4 revision 3, as in the report, and AES-256), and checks that:

- it is listed as protected, not damaged;
- Unlock opens it with its password, every page there;
- the Unlock screen lists it as protected and lets the run start.

Each test first confirms that pdf-lib cannot count the test file's pages, so the case is
really exercised. `test/workflows.js` opens a saved "unlock, then compress" workflow on the
screen with such a file, types its password and runs it. The three listing checks and the
two workflow checks failed before the fix; the Unlock runs passed both before and
after, which is what showed the fault was in the listing. Verified on the statement itself,
on a private copy that was deleted afterwards: listed as protected, unlocked, and the
unlocked copy listed as a healthy 4-page file.
