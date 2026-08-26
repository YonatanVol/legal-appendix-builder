# Bundled typeface

`DavidCLM-Medium.otf` and `DavidCLM-Bold.otf` are the David typeface from the
[Culmus project](https://culmus.sourceforge.io/) (release 0.133).

They are bundled rather than relying on the David that ships with Windows, because
that one carries an embedding restriction: Chromium is not permitted to place it
inside the PDF, so it converts the text to vector outlines instead. The pages then
look right but hold no text — nothing in the table of contents or on a divider page
can be searched, selected or copied. These files have `fsType = 0`, so they embed
normally and the text stays text.

Bundling also means the generated pages render identically on any machine, which is
what lets the tests on a development machine stand for what ships.

Licence: GPL v2 with the font exception (see `LICENSE-culmus.txt`) — embedding the
font in a document does not place that document under the GPL.
