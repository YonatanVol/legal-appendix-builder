; Included by electron-builder into the NSIS installer (UTF-8 with a BOM, for the Hebrew).
;
; From 2.0.0 the app is the office's PDF tools, named "כלי המשרד". Installing over an earlier
; version would otherwise leave its shortcuts, under the old name, beside the new ones.
!macro customInstall
  Delete "$DESKTOP\בונה תיקי נספחים.lnk"
  Delete "$SMPROGRAMS\בונה תיקי נספחים.lnk"
!macroend
