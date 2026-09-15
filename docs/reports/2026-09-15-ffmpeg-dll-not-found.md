# 2026-09-15: the program never opened on the first real install

## The report

A photo of a Windows error dialog, and the message sent with it:

> הורדתי כמו שצריך, עשיתי שהווינדואוס יקבל בכל זאת.. ואז זה הוריד ושניה לפני שנפתח זה הציג את החלון הזה

The dialog:

> **בונה תיקי נספחים.exe - System Error**
> The code execution cannot proceed because ffmpeg.dll was not found. Reinstalling the
> program may fix this problem.

The download was `AppendixBuilder-1.2.0-win-x64.zip`.

## What was wrong

The zip was intact: `ffmpeg.dll` sat beside the exe at its root. The exe itself was run
without its folder.

- The exe's import table lists `ffmpeg.dll` first, and it is the only DLL it loads at
  start-up that is not part of Windows. The Windows loader therefore refuses to start
  the process unless that file is in the same folder, and names exactly that file.
- The zip was flat: eighteen loose files and one large exe that looks like "the
  program". In Windows Explorer an exe can be double-clicked while still inside the zip,
  and Explorer copies out only that file to a temporary folder and runs it. "It
  downloaded, and a second before it opened" matches that: the second "download" is
  Explorer extracting the one file.
- Copying just the exe to the desktop, or being sent just the exe, fails the same way.

Nothing had caught this because every test ran from source on a Mac. No test had ever
launched the program on Windows.

Two further problems surfaced while fixing it:

- The Mac could no longer build for Windows at all. electron-builder runs `rcedit` through
  Wine and ships a `makensis` for macOS, and both are Intel binaries. After the upgrade to
  macOS 27 there is no Rosetta, so both fail with "bad CPU type".
- The David typeface check from 1.1.0 had only ever run on a Mac, where the bundled font
  is the one used. Whether the generated pages embed text on Windows had never been seen.

## What changed (1.3.0)

- Windows ships as a single per-user NSIS installer. There is no folder to separate.
- Builds run on Windows in `.github/workflows/windows.yml`. The installer is installed
  silently, the installed program is launched in self-test mode and produces a filing,
  and updates are proven end to end, before any release.
- The app updates itself from GitHub Releases, so a future fix reaches the installed copy
  without another download.

## What covers it now

| Check | What it would have caught |
|---|---|
| `scripts/check-win-package.js` | Reads the exe's import table and requires every non-system DLL beside it. Run against the exe alone, it fails with `needs ffmpeg.dll beside it`, the exact layout of this report. |
| Windows workflow: install, then check the installed folder | The installer placing the program without its DLLs. |
| Windows workflow: launch the installed program in self-test mode | Any failure to start at all: a program that never runs writes no result, and the step fails. |
| Self-test: generated pages hold an embedded font | Text turned into outlines on Windows, checked on Windows for the first time. |
| `test/config.js` | Shipping a loose folder or zip again, or a runtime module left out of the package. |

## Verified on Windows

From the first workflow run on the fix, on `windows-latest`:

- installer built natively, 79.4 MB, installed silently to `%LOCALAPPDATA%\Programs\rotem-office`
- `AppendixBuilder.exe loads at start-up: ffmpeg.dll`, `OK: the program can start from this folder`
- installed program: window loaded, 10-page filing produced, fonts embedded on every generated
  page, history recorded and reopened, document side blocked from the network
- a second launch exited and handed over to the open window
- a tampered update was refused with `sha512 checksum mismatch`, and the installed version stayed 1.3.0
- a genuine update to 99.0.0 downloaded, installed, and passed the same self-test

## The first release attempt

The first v1.3.0 tag run was stopped by its own pre-release check, and nothing was
published. Pushing the tag lists it in GitHub's release feed at once, while
`/releases/latest` has no published release to point to, so GitHub answers 406. The
check read that as "GitHub unreachable". It was confirmed benign by requesting the same
page from repositories that do have releases, which return the release as JSON, and
`scripts/selftest-verdicts.js` now accepts that one answer, for this repository only.
`test/selftest-verdicts.js` uses the exact text recorded on Windows.

## The installer crashed on some first installs (fixed in 1.3.1)

After 1.3.0 was published, the post-release job installed the published installer on a fresh
Windows machine and it exited `0xC0000005`, although the same bytes had installed cleanly on
the build machine. It was never sent to anyone.

A stress run of 20 installs on each of three machines reproduced it: two machines never
crashed, the third crashed on its first four installs and not after. Every Windows crash
report named `System.dll`, exception `0xc0000005`, at the same offset.

electron-builder 25.1.8's per-user template looks up the user's Programs folder and copies a
fixed 8192 characters from a buffer sized to the path, an overread whose effect depends on the
heap. It runs only when no earlier install is recorded, so it hits exactly a first install on
a clean machine, and never an update. electron-builder 26.12 fixed it upstream (PR #9769);
1.3.1 uses 26.15.3. `test/config.js` checks the template's bounded copy, and the workflow now
does 15 clean installs, uninstalling completely between them, on every run.
