// How a document is opened with pdf.js, shared by the screen (thumbs.mjs) and Redact's
// page pictures (page-picture.mjs): a redacted page must be drawn exactly as the screen
// drew it when it was marked, so both open documents the same way, from one place.
//
// Documents are read by token from app://office/doc/<token>: the page never sees a path
// and can only read files the main process has been handed.

export function documentParams(token) {
  return {
    url: `/doc/${encodeURIComponent(token)}`,
    cMapUrl: '/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs-fonts/',
    // No network, no eval: the document is ours and the fonts are bundled.
    isEvalSupported: false,
    // The handler serves whole files; asking for ranges would only add round trips.
    disableRange: true,
    disableStream: true,
  };
}
