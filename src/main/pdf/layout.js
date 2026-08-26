'use strict';

/**
 * Page-range computation for the assembled bundle.
 *
 * Layout:
 *   body            1 .. B
 *   table of contents  B+1 .. B+T
 *   appendix i      divider at start_i (one page)
 *                   content  start_i+1 .. start_i+P_i
 *   where start_1 = B+T+1  and  start_i = start_(i-1) + 1 + P_(i-1)
 *
 * T (the length of the table of contents) depends on the ranges it prints, and the
 * ranges depend on T. Callers resolve that with resolveLayout(), which re-renders
 * until T stops changing.
 */

/**
 * @param {number} bodyPages          pages in the pleading
 * @param {number[]} appendixPages    content pages per appendix, in order
 * @param {number} tocPages           assumed length of the table of contents
 */
function computeLayout(bodyPages, appendixPages, tocPages) {
  if (!Number.isInteger(bodyPages) || bodyPages < 1) {
    throw new Error('bodyPages must be a positive integer');
  }
  if (!Number.isInteger(tocPages) || tocPages < 1) {
    throw new Error('tocPages must be a positive integer');
  }

  const tocStart = bodyPages + 1;
  const appendices = [];
  let cursor = bodyPages + tocPages + 1;

  appendixPages.forEach((pages, i) => {
    if (!Number.isInteger(pages) || pages < 1) {
      throw new Error(`appendix ${i + 1} must have at least one page`);
    }
    appendices.push({
      number: i + 1,
      dividerPage: cursor,
      firstPage: cursor + 1,
      lastPage: cursor + pages,
      pages,
    });
    cursor += 1 + pages;
  });

  return {
    bodyPages,
    tocStart,
    tocPages,
    appendices,
    totalPages: cursor - 1,
  };
}

/** "10-17", or just "10" for a single-page appendix. */
function formatRange(appendix) {
  return appendix.firstPage === appendix.lastPage
    ? String(appendix.firstPage)
    : `${appendix.firstPage}-${appendix.lastPage}`;
}

/**
 * Resolve the layout against a renderer whose output length depends on the layout.
 *
 * @param {number} bodyPages
 * @param {number[]} appendixPages
 * @param {(layout) => Promise<{bytes: Uint8Array, pageCount: number}>} renderToc
 * @returns {Promise<{layout, toc}>}
 */
async function resolveLayout(bodyPages, appendixPages, renderToc) {
  const MAX_ITERATIONS = 5;
  let tocPages = 1;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const layout = computeLayout(bodyPages, appendixPages, tocPages);
    const toc = await renderToc(layout);

    if (toc.pageCount === tocPages) {
      return { layout, toc };
    }
    tocPages = toc.pageCount;
  }

  throw new Error(
    'לא ניתן היה לחשב את מספרי העמודים של תוכן העניינים. נסה לקצר את כותרות הנספחים.'
  );
}

module.exports = { computeLayout, formatRange, resolveLayout };
