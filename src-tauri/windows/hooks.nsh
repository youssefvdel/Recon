; Recon NSIS hooks — keep the remembered install directory honest.
;
; tauri-bundler writes the install directory to
; HKCU\Software\<publisher>\<product> (default value) and restores it blindly on
; every later install. The uninstaller only removes that value when the user
; ticks "Delete app data", so an uninstalled or moved install could redirect all
; future installs to a dead directory.
;
; Both hooks use only NSIS core commands plus the defines the Tauri template
; already provides at expansion time (SHCTX, MANUKEY, MANUPRODUCTKEY,
; PRODUCTNAME, INSTALLMODE) and the UpdateMode variable declared by the template.

!macro NSIS_HOOK_PREUNINSTALL
  ; A real uninstall forgets the location; an update preserves it for the
  ; installer that runs immediately after this uninstaller.
  ${If} $UpdateMode <> 1
    ; Drop only the remembered path (the key's default value) so the installer
    ; language preference survives, then remove the keys if nothing else is left.
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" ""
    DeleteRegKey /ifempty SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; .onInit restored $INSTDIR from the registry without checking it. The
  ; template has already run SetOutPath on it, so an empty directory means the
  ; remembered path was stale: fall back to the default for this install mode
  ; instead of installing into it.
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend
