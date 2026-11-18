; NSIS installer hooks — stop the running app before overwriting its files.
;
; Windows will not let you replace a file that is open in a running process. IRIS spawns
; iris-cli.exe as a sidecar and keeps it running for the life of the app, so updating while
; IRIS is open produced:
;
;     Error opening file for writing:
;     C:\Users\<name>\AppData\Local\IRIS\iris-cli.exe
;     Abort / Retry / Ignore
;
; Reported by a client on 2026-09-04, updating with the app open — which is the normal way
; anyone updates anything.
;
; Tauri's own NSIS template offers to close the MAIN binary. It knows nothing about the
; sidecar, so the app could be shut and the update would still fail on iris-cli.exe. That gap
; is the whole reason this file exists.
;
; Why the Ignore button made it worse: choosing Ignore skips only the locked file, so the
; installer completes "successfully" and leaves a NEW IRIS.exe beside an OLD iris-cli.exe.
; A version mismatch between app and sidecar is a far more confusing failure than an install
; that stopped and said why.

; It happened again on 1.18.166 (2026-11-03, #192439), with this file in the installer. The
; first version killed and slept, and never checked that the file was actually free:
;
;   - It killed the sidecar BEFORE the app. The app's engine supervisor respawns a dead engine
;     after one second, so the kill raced a fresh iris-cli.exe that held the file again.
;   - A holder the installer is not allowed to kill (an elevated or other-session process, an
;     antivirus scan) survives taskkill outright, and nothing else was tried.
;
; So: stop the app first, then the sidecar, wait until the file opens for writing, and if
; something still holds it, rename it aside. Windows lets you rename an executable that is
; running (the image is mapped with delete sharing), so the new file always has a free name.

!macro IRIS_KILL_ALL
  ; The app first, so its supervisor is gone before the engine dies — deliberately WITHOUT /T.
  ;
  ; On Windows the updater launches this installer, and depending on how it is spawned the
  ; installer can be a CHILD of IRIS.exe. /T kills the whole tree, so adding it here would
  ; let the installer terminate itself midway through an update and leave a half-written
  ; install directory.
  ;
  ; Two ways to kill, every time (#193840). On 2026-11-18 a client's update failed with this
  ; file in the installer and IRIS.exe + iris-cli.exe still alive behind the error, so the
  ; taskkill calls did not do their job — and their exit codes were Popped and thrown away, so
  ; nobody could say why. Now: Tauri's own plugin (TerminateProcess through the Win32 API, the
  ; same call Tauri's template uses to close the main binary), then taskkill, and every result
  ; goes into the details log the user can screenshot.
  nsis_tauri_utils::KillProcessCurrentUser "IRIS.exe"
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM "IRIS.exe"'
  Pop $0
  DetailPrint "taskkill IRIS.exe -> $0"
  nsExec::ExecToLog 'taskkill /F /IM "IRIS Dev.exe"'
  Pop $0
  ; Then the sidecar, which is a leaf and owns the locked file. /T takes its children too.
  nsis_tauri_utils::KillProcessCurrentUser "iris-cli.exe"
  Pop $0
  DetailPrint "KillProcess iris-cli.exe -> $0"
  nsExec::ExecToLog 'taskkill /F /T /IM "iris-cli.exe"'
  Pop $0
  DetailPrint "taskkill iris-cli.exe -> $0"
!macroend

; Leaves FILE writable, or moved aside so a new copy can be written in its place.
; ID only keeps the labels unique per use.
!macro IRIS_FREE_FILE FILE ID
  StrCpy $1 0
  iris_free_check_${ID}:
    IfFileExists "${FILE}" 0 iris_free_done_${ID}
    ClearErrors
    FileOpen $0 "${FILE}" a
    IfErrors iris_free_locked_${ID}
    FileClose $0
    Goto iris_free_done_${ID}
  iris_free_locked_${ID}:
    ; Windows releases a handle a moment after the process dies, not when it is signalled,
    ; and the holder may have been respawned. Retry for ~10 s before going around it.
    IntCmp $1 20 iris_free_aside_${ID}
    IntOp $1 $1 + 1
    !insertmacro IRIS_KILL_ALL
    Sleep 500
    Goto iris_free_check_${ID}
  iris_free_aside_${ID}:
    System::Call 'kernel32::GetTickCount() i .r0'
    DetailPrint "${FILE} is still in use; moving it aside"
    ClearErrors
    Rename "${FILE}" "${FILE}.$0.old"
    IfErrors 0 iris_free_done_${ID}
    DetailPrint "Could not free ${FILE}"
    ; The rename can fail too: iris-cli.exe is a Bun single-file binary that keeps an open
    ; read handle on ITSELF (to read its embedded bundle), without delete sharing, so a live
    ; copy can be neither written nor renamed (#193840).
    ;
    ; Never fall through to NSIS's own "Error opening file for writing … Abort/Retry/Ignore":
    ; it names no cause, Retry cannot work while the holder lives, and Ignore leaves a new
    ; IRIS.exe beside an old iris-cli.exe. Say what to do instead, and only go on once it is
    ; free. Silent installs (/S) cancel rather than hang on a box nobody can see.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "IRIS is still running in the background, so it can't be updated yet.$\r$\n$\r$\nOpen Task Manager (Ctrl+Shift+Esc), go to Details, and choose End task on every iris-cli.exe and IRIS.exe. Then click Retry." /SD IDCANCEL IDRETRY iris_free_retry_${ID}
    Abort "IRIS was still running, so the update was cancelled. Nothing was changed."
  iris_free_retry_${ID}:
    StrCpy $1 0
    Goto iris_free_check_${ID}
  iris_free_done_${ID}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing IRIS before updating..."
  !insertmacro IRIS_KILL_ALL
  Sleep 500

  ; Copies a previous install moved aside. Any still running stay put until next time.
  Delete "$INSTDIR\*.old"

  !insertmacro IRIS_FREE_FILE "$INSTDIR\iris-cli.exe" cli
  !insertmacro IRIS_FREE_FILE "$INSTDIR\IRIS.exe" app
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same reasoning on the way out: an uninstall that cannot delete a running sidecar leaves
  ; the directory behind and the next install inherits the problem.
  !insertmacro IRIS_KILL_ALL
  Sleep 800
  Delete "$INSTDIR\*.old"
!macroend
