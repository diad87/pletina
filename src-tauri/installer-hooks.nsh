; Musify pasó a llamarse Pletina (0.6.0). El identificador no cambia (dev.musify.desktop), así que
; la biblioteca sigue en su sitio; lo que cambia es la carpeta del programa, los accesos directos y
; la entrada de «Aplicaciones instaladas». Al instalar Pletina donde había un Musify, este se
; desinstala en silencio (sin borrar los datos) y sus accesos directos pasan a llamarse Pletina,
; también cuando instala la actualización automática, que normalmente no crea accesos directos.

!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Musify"

Var OldStartMenuShortcut
Var OldDesktopShortcut

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldStartMenuShortcut 0
  StrCpy $OldDesktopShortcut 0
  Push $R8
  Push $R9

  ReadRegStr $R8 HKCU "${OLD_UNINSTKEY}" "InstallLocation"
  ${If} $R8 != ""
    ; Se guarda entre comillas.
    StrCpy $R9 $R8 1
    ${If} $R9 == '"'
      StrCpy $R8 $R8 "" 1
      StrCpy $R8 $R8 -1
    ${EndIf}

    !insertmacro IsShortcutTarget "$SMPROGRAMS\Musify.lnk" "$R8\${MAINBINARYNAME}.exe"
    Pop $OldStartMenuShortcut
    !insertmacro IsShortcutTarget "$DESKTOP\Musify.lnk" "$R8\${MAINBINARYNAME}.exe"
    Pop $OldDesktopShortcut

    ${If} ${FileExists} "$R8\uninstall.exe"
      DetailPrint "Quitando Musify (ahora se llama Pletina)"
      ; Con _? espera a que acabe y no se copia a una carpeta temporal, pero entonces no se borra solo.
      ExecWait '"$R8\uninstall.exe" /S _?=$R8'
      Delete "$R8\uninstall.exe"
      RMDir "$R8"
    ${EndIf}
    DeleteRegKey HKCU "Software\musify\Musify"
    DeleteRegKey /ifempty HKCU "Software\musify"
  ${EndIf}

  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldStartMenuShortcut = 1
  ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $OldDesktopShortcut = 1
  ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend
