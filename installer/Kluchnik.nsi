Unicode True
!include "x64.nsh"
!include "LogicLib.nsh"
!include "MUI2.nsh"

!ifndef INPUT
  !error "Set INPUT to the installer staging directory."
!endif
!ifndef OUTPUT
  !define OUTPUT "Kluchnik-Setup.exe"
!endif

Name "Ключник"
Caption "Установщик Ключника"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Kluchnik\app"
InstallDirRegKey HKCU "Software\Kluchnik" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "0.2.0.0"
VIAddVersionKey "ProductName" "Ключник"
VIAddVersionKey "FileDescription" "Kluchnik Windows Setup"
VIAddVersionKey "FileVersion" "0.2.0"
VIAddVersionKey "OriginalFilename" "Kluchnik-Setup.exe"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\start.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Открыть Ключник"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Для этой сборки нужна 64-разрядная Windows."
    Abort
  ${EndIf}
FunctionEnd

!macro StopInstalledRuntime
  IfFileExists "$INSTDIR\runtime\node.exe" 0 stop_done
  System::Call 'Kernel32::SetEnvironmentVariableW(w "KLYUCHNIK_INSTALLED_NODE", w "$INSTDIR\runtime\node.exe") i .r4'
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$env:KLYUCHNIK_INSTALLED_NODE }) { exit 1 }"'
  Pop $0
  StrCmp $0 "0" stop_done
  MessageBox MB_ICONSTOP "Закройте запущенный Ключник и повторите операцию."
  Abort
  stop_done:
!macroend

Section "Ключник" SecApp
  !insertmacro StopInstalledRuntime
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "${INPUT}/klyuchnik-wordstat.html"
  File "${INPUT}/klyuchnik-server.mjs"
  File "${INPUT}/klyuchnik-n8n.json"
  File "${INPUT}/n8n-connect.mjs"
  File "${INPUT}/metrika.mjs"
  File "${INPUT}/direct.mjs"
  File "${INPUT}/start.cmd"
  SetOutPath "$INSTDIR\runtime"
  File "${INPUT}/node.exe"
  File "${INPUT}/NODE-LICENSE.txt"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Kluchnik" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik" "DisplayName" "Ключник"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik" "DisplayVersion" "0.2.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik" "NoModify" 1
  CreateDirectory "$SMPROGRAMS\Ключник"
  CreateShortcut "$SMPROGRAMS\Ключник\Ключник.lnk" "$INSTDIR\start.cmd"
SectionEnd

Section "Uninstall"
  !insertmacro StopInstalledRuntime
  SetShellVarContext current
  Delete "$SMPROGRAMS\Ключник\Ключник.lnk"
  RMDir "$SMPROGRAMS\Ключник"
  Delete "$INSTDIR\runtime\node.exe"
  Delete "$INSTDIR\runtime\NODE-LICENSE.txt"
  RMDir "$INSTDIR\runtime"
  Delete "$INSTDIR\klyuchnik-wordstat.html"
  Delete "$INSTDIR\klyuchnik-server.mjs"
  Delete "$INSTDIR\klyuchnik-n8n.json"
  Delete "$INSTDIR\n8n-connect.mjs"
  Delete "$INSTDIR\metrika.mjs"
  Delete "$INSTDIR\direct.mjs"
  Delete "$INSTDIR\start.cmd"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kluchnik"
  DeleteRegKey HKCU "Software\Kluchnik"
SectionEnd
