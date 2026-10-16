#!/bin/bash
# Opens "כלי המשרד" on this Mac, from the code in this folder. Double-click it in Finder.
#
# The first time, it installs what the app needs (npm ci); after that it opens at once.
# The app is opened as a Mac app of its own, so this Terminal window can be closed.
# On a Mac, conversions use LibreOffice and the PDF engines come from Homebrew (qpdf,
# ghostscript, tesseract); scanning works only on the office's Windows PCs.

cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  echo "Press any key to close."
  read -r -n 1
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "Node.js is not installed. Install it from https://nodejs.org and try again."

ELECTRON_APP="node_modules/electron/dist/Electron.app"
if [ ! -d "$ELECTRON_APP" ]; then
  echo "First run: installing what the app needs. This takes a minute or two..."
  npm ci || fail "Installing failed (see above)."
fi

for tool in qpdf gs tesseract; do
  command -v "$tool" >/dev/null 2>&1 || echo "Note: $tool is not installed (brew install $tool); the tools that use it will say so."
done

echo "Opening כלי המשרד..."
open -n "$ELECTRON_APP" --args "$PWD" || fail "The app did not open."
