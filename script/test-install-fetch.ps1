# Load Install-IrisDaemonSource FROM install.ps1 — testing a copy proves nothing
# about what ships.
$ps1  = Join-Path (Join-Path $PSScriptRoot "..") "install.ps1"   # 3-arg Join-Path is pwsh 7 only
$text = Get-Content -Raw $ps1
$start = $text.IndexOf("function Install-IrisDaemonSource")
if ($start -lt 0) { "  ✗ Install-IrisDaemonSource not found in install.ps1"; exit 1 }
$rest = $text.Substring($start)
$end  = $rest.IndexOf("`n# ─── Autostart")
if ($end -lt 0) { $end = $rest.Length }
Invoke-Expression $rest.Substring(0, $end)
$pass=0; $fail=0
function check($n,$c){ if($c){"  ✓ $n";$script:pass++}else{"  ✗ $n";$script:fail++} }

$dir = Join-Path ([System.IO.Path]::GetTempPath()) "iris-fetch-test"
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue

"CASE 1 — fresh install, no git anywhere"
$r = Install-IrisDaemonSource -BridgeDir $dir
check "succeeds"                      ($r.Ok -eq $true)
check "reports it was NOT an update"  ($r.Updated -eq $false)
check "daemon.js landed"              (Test-Path (Join-Path $dir "daemon.js"))
check "index.js landed"               (Test-Path (Join-Path $dir "index.js"))
check "package.json landed"           (Test-Path (Join-Path $dir "package.json"))

""
"CASE 2 — update over an existing install, preserving machine state"
# Simulate what a real install has: deps, a log, and a leftover .git from the old
# clone-based installer.
New-Item -ItemType Directory -Path (Join-Path $dir "node_modules") -Force | Out-Null
Set-Content (Join-Path $dir "node_modules/marker.txt") "do not delete me"
Set-Content (Join-Path $dir "daemon.log") "historic log line"
New-Item -ItemType Directory -Path (Join-Path $dir ".git") -Force | Out-Null
Set-Content (Join-Path $dir ".git/HEAD") "ref: refs/heads/main"
Set-Content (Join-Path $dir "stale-source-file.js") "should be removed"

$r2 = Install-IrisDaemonSource -BridgeDir $dir
check "succeeds"                            ($r2.Ok -eq $true)
check "reports it WAS an update"            ($r2.Updated -eq $true)
check "node_modules survived"               (Test-Path (Join-Path $dir "node_modules/marker.txt"))
check "daemon.log survived"                 ((Get-Content (Join-Path $dir "daemon.log")) -eq "historic log line")
check "an old .git is left alone"           (Test-Path (Join-Path $dir ".git/HEAD"))
check "stale repo files ARE cleaned up"     (-not (Test-Path (Join-Path $dir "stale-source-file.js")))
check "daemon.js still present"             (Test-Path (Join-Path $dir "daemon.js"))

""
"CASE 3 — a bad URL must NOT damage a working install"
$before = (Get-ChildItem $dir -Force).Count
$r3 = Install-IrisDaemonSource -BridgeDir $dir -Url "https://github.com/FREELABEL/iris-daemon/archive/refs/heads/does-not-exist.zip"
check "reports failure"                     ($r3.Ok -eq $false)
check "gives a reason"                      (-not [string]::IsNullOrWhiteSpace($r3.Reason))
check "the existing install is intact"      ((Test-Path (Join-Path $dir "daemon.js")) -and (Test-Path (Join-Path $dir "node_modules/marker.txt")))
check "nothing was removed"                 ((Get-ChildItem $dir -Force).Count -eq $before)

""
"CASE 4 — a 200 that is not the daemon is refused"
# A zip that downloads fine but is the wrong thing. Overwriting a working install
# with whatever was served is how a 'successful' update bricks a node.
$r4 = Install-IrisDaemonSource -BridgeDir $dir -Url "https://github.com/FREELABEL/iris-opencode/archive/refs/heads/main.zip"
check "refuses an archive with no daemon.js" ($r4.Ok -eq $false)
check "says why"                             ($r4.Reason -like "*daemon.js*")
check "install still intact"                 (Test-Path (Join-Path $dir "daemon.js"))

Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
""
"── $pass passed · $fail failed ──"
if ($fail -gt 0) { exit 1 }
