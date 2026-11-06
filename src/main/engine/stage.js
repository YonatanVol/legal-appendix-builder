'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Copy an input into the job's scratch folder under a plain ASCII name, and return
 * that name relative to the folder.
 *
 * The programs are run with the scratch folder as their working folder and given only
 * these relative names. The scratch folder itself sits under the Windows user's own
 * folder, whose name may be Hebrew, so even it is never passed to them.
 *
 * qpdf and Ghostscript are separate programs with their own handling of file names
 * on Windows; a Hebrew folder name or an unusual character is the kind of thing that
 * works on the build machine and fails on a user's. Copying first means they only
 * ever see names like in-0.pdf, and the result is written beside the source by the
 * job runner, which handles names the same way for every tool.
 */
async function stage(ctx, source, n = 0) {
  const name = `in-${n}${path.extname(source).toLowerCase() || '.pdf'}`;
  await fs.copyFile(source, path.join(ctx.scratch, name));
  return name;
}

function scratchPath(ctx, name) {
  return path.join(ctx.scratch, name);
}

/** Copy a file the app ships (the PDF/A profile) into scratch, by its plain name. */
async function stageAsset(ctx, file) {
  const name = path.basename(file);
  await fs.copyFile(file, path.join(ctx.scratch, name));
  return name;
}

/** Where a file inside the app lives on disk, outside app.asar, for external programs. */
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { stage, stageAsset, scratchPath, unpacked };
