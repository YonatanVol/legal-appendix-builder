Tesseract language data, the `4.0.0_best_int` models from the `@tesseract.js-data/heb` and
`@tesseract.js-data/eng` packages (Apache 2.0, from tesseract-ocr/tessdata). They are kept
here, beside the app, so OCR never reaches for tesseract.js's download fallback. The Hebrew
file is the same one the document scanner app ships.
