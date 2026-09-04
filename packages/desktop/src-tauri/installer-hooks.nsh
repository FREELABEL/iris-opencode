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

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing IRIS before updating..."

  ; The sidecar first. Killing the app alone can leave this orphaned and still holding its
  ; own file open. /T takes any child processes with it.
  nsExec::Exec 'taskkill /F /T /IM "iris-cli.exe"'
  Pop $0

  ; Then the app itself — deliberately WITHOUT /T.
  ;
  ; On Windows the updater launches this installer, and depending on how it is spawned the
  ; installer can be a CHILD of IRIS.exe. /T kills the whole tree, so adding it here would
  ; let the installer terminate itself midway through an update and leave a half-written
  ; install directory. The sidecar above gets /T because it is a leaf and owns the locked
  ; file; the app does not need it.
  nsExec::Exec 'taskkill /F /IM "IRIS.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "IRIS Dev.exe"'
  Pop $0

  ; Windows releases a file handle a moment after the process dies, not at the instant it is
  ; signalled. Without this pause the very next write can still hit a lock — the same error,
  ; now with a fix in place that appears not to work.
  Sleep 1200
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same reasoning on the way out: an uninstall that cannot delete a running sidecar leaves
  ; the directory behind and the next install inherits the problem.
  nsExec::Exec 'taskkill /F /T /IM "iris-cli.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "IRIS.exe"'
  Pop $0
  Sleep 800
!macroend
