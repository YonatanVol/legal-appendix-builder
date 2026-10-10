'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Copy an input into the job's scratch folder under a plain ASCII name.
 *
 * qpdf and Ghostscript are separate programs with their own handling of file names
 * on Windows; a Hebrew folder name or an unusual character is the kind of thing that
 * works on the build machine and fails on a user's. Copying first means they only
 * ever see names like in-0.pdf, and the result is written beside the source by the
 * job runner, which handles names the same way for every tool.
 */
async function stage(ctx, source, n = 0) {
  const target = path.join(ctx.scratch, `in-${n}${path.extname(source).toLowerCase() || '.pdf'}`);
  await fs.copyFile(source, target);
  return target;
}

function scratchPath(ctx, name) {
  return path.join(ctx.scratch, name);
}

/** Where a file inside the app lives on disk, outside app.asar, for external programs. */
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { stage, scratchPath, unpacked };
