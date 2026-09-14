# Unit tests for Register-IrisAutostart (#184597 FIX 3), run under pwsh on ANY
# platform with the Windows-only cmdlets mocked. This cannot prove the task appears in Task Scheduler — only a
# Windows box can — but it DOES prove the control flow, the never-elevate rule, and
# that a failure is reported rather than swallowed, which is the defect class that
# caused #184597 in the first place.
# Load Register-IrisAutostart FROM install.ps1 itself — testing a copy proves nothing
# about what ships. Everything after the function is dropped so the installer does not run.
$ps1  = Join-Path (Join-Path $PSScriptRoot "..") "install.ps1"   # 3-arg Join-Path is pwsh 7 only
$text = Get-Content -Raw $ps1
$start = $text.IndexOf("function Register-IrisAutostart")
if ($start -lt 0) { "  ✗ Register-IrisAutostart not found in install.ps1"; exit 1 }
$rest  = $text.Substring($start)
$end   = $rest.IndexOf("`n# ─── Step 5")
if ($end -lt 0) { $end = $rest.Length }
Invoke-Expression $rest.Substring(0, $end)

$script:calls = @{}
$pass = 0; $fail = 0
function check($name, $cond) {
  if ($cond) { "  ✓ $name"; $script:pass++ } else { "  ✗ $name"; $script:fail++ }
}

# ── Case 1: the happy path — a scheduled task is registered ──────────────────
# $RunLevel is DECLARED on purpose, and [CmdletBinding()] makes an undeclared
# parameter an error instead of silent $args. Without both, `-RunLevel Highest`
# vanished into $args, $PSBoundParameters never saw it, and the "NEVER requests
# elevation" assertion passed against a version that DID request elevation. The
# test could not fail, which is worse than not having it.
function Register-ScheduledTask { [CmdletBinding()] param($TaskName,$Action,$Trigger,$Settings,$User,$Description,$RunLevel,[switch]$Force)
  $script:calls['register'] = $PSBoundParameters; return @{} }
function Unregister-ScheduledTask { param($TaskName,$Confirm,$ErrorAction) $script:calls['unregister'] = $true }
function New-ScheduledTaskAction { param($Execute,$Argument) $script:calls['action'] = $PSBoundParameters; return "action" }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) $script:calls['trigger'] = $PSBoundParameters; return "trigger" }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$RestartCount,$RestartInterval,$ExecutionTimeLimit)
  $script:calls['settings'] = $PSBoundParameters; return "settings" }

$daemon = "/tmp/fake-iris-daemon.cmd"; Set-Content $daemon "rem"
$r = Register-IrisAutostart -DaemonCmd $daemon

"CASE 1 — scheduled task available"
check "registers successfully"            ($r.Ok -eq $true)
check "reports method 'scheduled-task'"   ($r.Method -eq 'scheduled-task')
check "unregisters first (idempotent)"    ($script:calls['unregister'] -eq $true)
check "launches the daemon with 'start'"  ($script:calls['action'].Argument -eq 'start')
check "triggers AtLogOn"                  ($script:calls['trigger'].AtLogOn.IsPresent)
check "restarts on failure (KeepAlive)"   ($script:calls['settings'].RestartCount -eq 3)
# The security property the macOS plist spells out in a comment.
check "the mock was actually called"      ($null -ne $script:calls['register'])
check "NEVER requests elevation"          ($null -ne $script:calls['register'] -and -not $script:calls['register'].ContainsKey('RunLevel'))
check "scoped to the current user"        ($script:calls['register'].User -eq $env:USERNAME)

# ── Case 2: the task API fails → Run-key fallback, and it SAYS so ────────────
$script:calls = @{}
function Register-ScheduledTask { throw "Access is denied. (0x80070005)" }
$fellBack = $null
function Test-Path { param($Path,$ErrorAction) if ("$Path".StartsWith("HKCU:")) { return $true } return (Microsoft.PowerShell.Management\Test-Path $Path) }
function Set-ItemProperty { param($Path,$Name,$Value,$ErrorAction) $script:calls['runkey'] = $PSBoundParameters }
$r2 = Register-IrisAutostart -DaemonCmd $daemon

""
"CASE 2 — task API denied, falls back to the Run key"
check "still succeeds"                        ($r2.Ok -eq $true)
check "reports the WEAKER method honestly"    ($r2.Method -eq 'run-key')
check "writes to HKCU, never HKLM"            ($script:calls['runkey'].Path -like 'HKCU:*')
check "command includes 'start'"              ("$($script:calls['runkey'].Value)" -like '*start*')

# ── Case 3: nothing to start → refuses, with a reason ────────────────────────
$r3 = Register-IrisAutostart -DaemonCmd "/tmp/does-not-exist-at-all.cmd"
""
"CASE 3 — daemon launcher missing"
check "does not claim success"            ($r3.Ok -eq $false)
check "gives a reason"                    (-not [string]::IsNullOrWhiteSpace($r3.Reason))
check "reason names the actual cause"     ($r3.Reason -like '*nothing to start*')

# ── Case 4: everything fails → must NOT report success ───────────────────────
$script:calls = @{}
function Register-ScheduledTask { throw "task store unavailable" }
function Set-ItemProperty { throw "registry is read-only" }
$r4 = Register-IrisAutostart -DaemonCmd $daemon
""
"CASE 4 — both mechanisms fail"
check "reports failure, not success"      ($r4.Ok -eq $false)
check "reason mentions the Run key too"   ($r4.Reason -like '*Run key*')

""
"── $pass passed · $fail failed ──"
if ($fail -gt 0) { exit 1 }
