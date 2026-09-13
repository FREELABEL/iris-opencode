# IRIS Code Installer for Windows (PowerShell)
# Usage: irm https://heyiris.io/install-code.ps1 | iex

$ErrorActionPreference = "Stop"
$APP = "iris"
$INSTALL_DIR = "$env:USERPROFILE\.iris\bin"
$IRIS_DIR = "$env:USERPROFILE\.iris"

# ─── Parse environment overrides ──────────────────────────────────────────────
$RequestedVersion = if ($env:VERSION) { $env:VERSION } else { "" }
$IrisApiUrl = if ($env:IRIS_API_URL) { $env:IRIS_API_URL } else { "https://freelabel.net" }

# ─── Helper: colored output ──────────────────────────────────────────────────
function Write-Step {
    param([string]$Step, [string]$Name, [string]$Status, [string]$Extra = "")
    Write-Host "[$Step]" -ForegroundColor Green -NoNewline
    Write-Host " $Name " -NoNewline
    Write-Host $Status -ForegroundColor Green -NoNewline
    if ($Extra) { Write-Host " $Extra" -ForegroundColor DarkGray } else { Write-Host "" }
}

function Write-StepSkipped {
    param([string]$Step, [string]$Name, [string]$Reason = "skipped")
    Write-Host "[$Step] $Name ... $Reason" -ForegroundColor DarkGray
}

function Write-Muted {
    param([string]$Message)
    Write-Host "      $Message" -ForegroundColor DarkGray
}

# ─── Install beacon (#179077) ─────────────────────────────────────────────────
# Anonymous, metadata-only, fire-and-forget. Nothing about an install attempt
# reached us before this: the CLI beacon needs a token, and you have no token
# until after iris-login — which is after the install. So a failed install was
# indistinguishable from someone who never tried, and the only reason we knew
# Windows onboarding was broken at all is that a user typed a bug report by hand.
#
# NEVER blocks and NEVER throws. Telemetry that can break an install is worse
# than no telemetry. Opt out entirely with IRIS_TELEMETRY=0.
$script:BeaconUrl = "https://heyiris.io/api/v6/telemetry/install"
$script:InstallerVersion = "2026-08-06"

function Send-InstallBeacon {
    param(
        [string]$EventType,
        [string]$Step = $null,
        [string]$Reason = $null
    )

    if ($env:IRIS_TELEMETRY -in @("0", "off", "false")) { return }

    try {
        $body = @{
            event_type        = $EventType
            os                = "windows"
            arch              = $(if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" })
            installer_version = $script:InstallerVersion
            shell             = "powershell"
            has_git           = [bool](Get-Command git -ErrorAction SilentlyContinue)
            has_node          = [bool](Get-Command node -ErrorAction SilentlyContinue)
        }
        if ($Step)   { $body.step = $Step }
        if ($Reason) { $body.reason = $Reason }

        Invoke-RestMethod -Uri $script:BeaconUrl -Method Post `
            -Body ($body | ConvertTo-Json -Compress) `
            -ContentType "application/json" `
            -TimeoutSec 3 -ErrorAction SilentlyContinue | Out-Null
    } catch {
        # Deliberately silent. A user installing IRIS should never see, or be
        # stopped by, a telemetry failure.
    }
}

# ─── Step 1: Download and install IRIS Code binary ────────────────────────────

Write-Host ""
Write-Host "IRIS Installer" -ForegroundColor Cyan
Write-Host "Code, SDK, Desktop App, Bridge" -ForegroundColor DarkGray
Write-Host ""

# Detect architecture
$Arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else {
    Write-Host "Error: 32-bit Windows is not supported." -ForegroundColor Red
    exit 1
}

$Target = "windows-$Arch"
$Filename = "$APP-$Target.zip"

Send-InstallBeacon -EventType "install_start"

# Determine version and download URL
if ($RequestedVersion) {
    $RequestedVersion = $RequestedVersion -replace "^v", ""
    $SpecificVersion = $RequestedVersion
    $Url = "https://github.com/FREELABEL/iris-opencode/releases/download/v$RequestedVersion/$Filename"

    # Verify release exists
    try {
        $resp = Invoke-WebRequest -Uri "https://github.com/FREELABEL/iris-opencode/releases/tag/v$RequestedVersion" -Method Head -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Host "Error: Release v$RequestedVersion not found" -ForegroundColor Red
        Write-Host "Available releases: https://github.com/FREELABEL/iris-opencode/releases" -ForegroundColor DarkGray
        exit 1
    }
} else {
    # Do NOT use /releases/latest. Two problems, both observed in production:
    #
    #  1. It is REPO-WIDE. This repo publishes two series — v1.3.x (this CLI) and
    #     desktop-v1.18.x (the Tauri app). When a desktop release held the "latest" flag,
    #     /releases/latest returned a tag with zero iris-* binaries and `iris update` broke
    #     for the whole fleet (#182694). The bash installer was fixed for this; this file
    #     was not, so Windows kept the bug.
    #
    #  2. It does not check the release actually CONTAINS the asset. A release is created
    #     before its assets finish uploading, so hitting it mid-publish 404s. A client saw
    #     exactly that today: "iris upgrade 1.3.222 -> 404 Not Found".
    #
    # So: enumerate releases, keep bare vX.Y.Z tags (desktop-v* are excluded by the anchor),
    # skip drafts, and take the newest one that actually HAS this platform's asset.
    try {
        $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/FREELABEL/iris-opencode/releases?per_page=30" -UseBasicParsing -ErrorAction Stop
        $Chosen = $null
        foreach ($r in $Releases) {
            if ($r.draft) { continue }
            if ($r.tag_name -notmatch '^v\d+\.\d+\.\d+$') { continue }
            if (-not ($r.assets | Where-Object { $_.name -eq $Filename })) { continue }
            $Chosen = $r
            break
        }
        if (-not $Chosen) {
            Write-Host "No published release contains $Filename yet." -ForegroundColor Red
            Write-Host "A release may still be uploading — try again shortly." -ForegroundColor DarkGray
            exit 1
        }
        $SpecificVersion = $Chosen.tag_name -replace "^v", ""
        # Pin the URL to the resolved tag rather than /latest/, so the version we announce and
        # the bytes we download can never come from two different releases.
        $Url = "https://github.com/FREELABEL/iris-opencode/releases/download/$($Chosen.tag_name)/$Filename"
    } catch {
        Write-Host "Failed to fetch version information." -ForegroundColor Red
        Write-Host "Check your internet connection or install a specific version:" -ForegroundColor DarkGray
        Write-Host '  $env:VERSION="1.3.223"; irm https://heyiris.io/install-code.ps1 | iex' -ForegroundColor DarkGray
        exit 1
    }
}

# Create install directory
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null

if (Test-Path "$INSTALL_DIR\iris.exe") {
    Write-Host "Updating IRIS Code to $SpecificVersion..." -ForegroundColor DarkGray
} else {
    Write-Host "Installing IRIS Code version: $SpecificVersion" -ForegroundColor DarkGray
}

# Download
$TmpDir = Join-Path $env:TEMP "iris_install_$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$ZipPath = Join-Path $TmpDir $Filename

try {
    Write-Host "Downloading..." -ForegroundColor DarkGray -NoNewline
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
    Write-Host " done." -ForegroundColor Green
} catch {
    Write-Host " failed." -ForegroundColor Red
    Send-InstallBeacon -EventType "install_failed" -Step "download" -Reason "$_"
    Write-Host "Download URL: $Url" -ForegroundColor DarkGray
    Write-Host "Error: $_" -ForegroundColor Red
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    exit 1
}

# Extract
try {
    Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

    # Find the iris binary (could be iris.exe or just iris)
    $Binary = Get-ChildItem -Path $TmpDir -Filter "iris*" -File | Where-Object { $_.Name -match "^iris(\.exe)?$" } | Select-Object -First 1
    if (-not $Binary) {
        Write-Host "Error: iris binary not found in archive." -ForegroundColor Red
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
        exit 1
    }

    # Windows LOCKS a running executable: it cannot be deleted or overwritten. `iris upgrade`
    # shells out to this script FROM iris.exe, so the destination is ALWAYS in use during a
    # self-update and this Copy-Item failed with "being used by another process" — every
    # time, for every Windows user. The upgrade reported failure and left them pinned to
    # whatever version they first installed. Found on a client's machine 2026-08-28, stuck on
    # v1.3.207 while v1.3.220 was current (#182741).
    #
    # The Unix path a few files over already handles this with `rm -f` before the move, which
    # works because unlinking a running binary is legal on POSIX. It is not on Windows.
    # Windows DOES allow RENAMING a running image — the process keeps executing from the
    # renamed file — which frees the name so a fresh binary can be written.
    $Dest = Join-Path $INSTALL_DIR "iris.exe"

    # Sweep leftovers from previous upgrades. These are only deletable once the process that
    # held them has exited, so failures here are expected and must never abort an install.
    Get-ChildItem -Path $INSTALL_DIR -Filter "iris.exe.old-*" -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }

    if (Test-Path $Dest) {
        $StaleName = "iris.exe.old-$(Get-Random)"
        try {
            Rename-Item -Path $Dest -NewName $StaleName -Force -ErrorAction Stop
        } catch {
            Write-Host "Error: could not move the running iris.exe aside: $_" -ForegroundColor Red
            Write-Host "Close any open IRIS windows and run the upgrade again." -ForegroundColor Yellow
            Send-InstallBeacon -EventType "install_failed" -Step "rename_locked_binary" -Reason "$_"
            Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
            exit 1
        }
    }

    Copy-Item -Path $Binary.FullName -Destination $Dest -Force
} catch {
    Send-InstallBeacon -EventType "install_failed" -Step "extract" -Reason "$_"
    Write-Host "Error extracting archive: $_" -ForegroundColor Red
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    exit 1
}

Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

Write-Step "1/5" "IRIS Code" "installed"

# ─── Step 2: SDK (built-in) ──────────────────────────────────────────────────

# Preserve existing .env from previous installs
$SdkDir = "$IRIS_DIR\sdk"
if (-not (Test-Path $SdkDir)) {
    New-Item -ItemType Directory -Force -Path $SdkDir | Out-Null
}
Write-Step "2/5" "IRIS SDK" "built-in" "(no PHP required)"

# ─── Step 3: Desktop App ─────────────────────────────────────────────────────
Write-StepSkipped "3/5" "IRIS App" "skipped (coming soon for Windows)"

# ─── Step 4: MCP Configuration ───────────────────────────────────────────────

$McpConfig = "$IRIS_DIR\mcp.json"
if (Test-Path $McpConfig) {
    Write-Step "4/5" "MCP Config" "already configured"
} else {
    $McpJson = @'
{
  "mcpServers": {
    "iris-local": {
      "_comment": "Local IRIS tools - filesystem, SDK, project setup",
      "command": "iris",
      "args": ["mcp", "serve"],
      "enabled": false
    },
    "iris-platform": {
      "_comment": "Remote IRIS platform - agents, integrations, workflows",
      "type": "remote",
      "url": "https://heyiris.io/api/mcp",
      "enabled": false
    }
  }
}
'@
    Set-Content -Path $McpConfig -Value $McpJson -Encoding UTF8
    Write-Step "4/5" "MCP Config" "scaffolded"
    Write-Muted "Config at ~\.iris\mcp.json (enable when MCP servers are ready)"
}

# ─── Fetching the daemon WITHOUT git ─────────────────────────────────────────
#
# Git was a hard install prerequisite and it was only ever moving bytes:
# `git clone` on first install, `git pull` on update. Nothing read the history,
# nothing used a submodule, nothing needed a working tree. A client without Git
# got Step 5 skipped entirely — no Hive node — for a capability they never used.
#
# GitHub serves the same tree as a zip over plain HTTPS, so the dependency goes.
#
# NOTE Git is still required AT RUNTIME by two features — reference-repo indexing
# and exchange/bounty tasks. Removing it from the installer does not remove it from
# the product; it stops it blocking an install that would otherwise work fine. Those
# two paths name Git themselves when it is missing.
function Install-IrisDaemonSource {
    param(
        [Parameter(Mandatory)][string]$BridgeDir,
        [string]$Url = "https://github.com/FREELABEL/iris-daemon/archive/refs/heads/main.zip"
    )

    $result = [pscustomobject]@{ Ok = $false; Updated = $false; Reason = $null }

    # State that belongs to the MACHINE, not the repo. An update must not eat it.
    # Measured on a real install: .git (from the old clone-based installs),
    # daemon.log, node_modules, test-results.
    $preserve = @('node_modules', 'daemon.log', 'bridge.log', 'test-results', '.git', '.env')

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("iris-daemon-" + [guid]::NewGuid().ToString("N"))
    $zip = "$tmp.zip"
    try {
        New-Item -ItemType Directory -Path $tmp -Force -ErrorAction Stop | Out-Null

        # DOWNLOAD AND EXTRACT TO A TEMP DIR FIRST, then move into place.
        # `git clone` failing halfway left a partial bridge directory behind that the
        # next run treated as installed — "already installed, updating..." over a tree
        # with no daemon.js. Staging means a failed download leaves the existing
        # install exactly as it was.
        $ProgressPreference = 'SilentlyContinue'   # the progress bar makes this ~10x slower
        Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing -ErrorAction Stop
        Expand-Archive -Path $zip -DestinationPath $tmp -Force -ErrorAction Stop

        # GitHub wraps the tree in one directory named <repo>-<branch>.
        $root = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
        if (-not $root) { throw "the archive contained no directory" }

        # Refuse an archive that is not the daemon rather than overwriting a working
        # install with whatever was served. A 200 that returns an error page is still a 200.
        if (-not (Test-Path (Join-Path $root.FullName "daemon.js"))) {
            throw "the downloaded archive has no daemon.js — refusing to overwrite the install"
        }

        $result.Updated = Test-Path (Join-Path $BridgeDir "daemon.js")
        New-Item -ItemType Directory -Path $BridgeDir -Force -ErrorAction Stop | Out-Null

        # Remove only the files the repo owns; leave preserved entries untouched.
        Get-ChildItem -Path $BridgeDir -Force -ErrorAction SilentlyContinue | Where-Object {
            $preserve -notcontains $_.Name
        } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

        Copy-Item -Path (Join-Path $root.FullName "*") -Destination $BridgeDir -Recurse -Force -ErrorAction Stop

        $result.Ok = $true
        return $result
    } catch {
        $result.Reason = $_.Exception.Message
        return $result
    } finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    }
}

# ─── Autostart: keep the node alive across reboots (#184597, FIX 3) ──────────
#
# WHAT WAS WRONG. macOS registers a real LaunchAgent — RunAtLoad so the daemon
# starts at login, KeepAlive so it comes back if it dies. Windows registered
# NOTHING: install.ps1 contained zero references to schtasks, Register-ScheduledTask,
# the Startup folder or the Run key. A Windows node therefore worked until the first
# reboot and was then silently gone, which reads as "the product is flaky" rather
# than "nothing ever asked it to start".
#
# WHY A SCHEDULED TASK AND NOT THE RUN KEY. The Run key is simpler and needs no
# elevation, but it only launches once and never restarts a crashed process — it
# mirrors RunAtLoad and drops KeepAlive. A per-user scheduled task gives both. The
# Run key remains the FALLBACK for machines where the ScheduledTasks module is
# absent, and when it is used the summary says which one you got, because "it will
# restart if it crashes" is a promise the fallback cannot keep.
#
# NEVER ELEVATED. The plist this mirrors carries a comment — "user-level ONLY,
# never /Library/LaunchDaemons" — because a compromised agent should reach no
# further than the user's own home. So: no -RunLevel Highest, no HKLM, no
# system-wide task store. A task that needs admin to install is also a task most
# clients simply will not have, and an installer that demands elevation for an
# optional convenience is one people stop running.
function Register-IrisAutostart {
    param(
        [Parameter(Mandatory)][string]$DaemonCmd,   # full path to iris-daemon.cmd
        [string]$TaskName = "IRIS Hive Node"
    )

    # Returns a result object rather than writing output or throwing: the caller
    # decides how to report, and the FINAL summary needs the reason. Swallowing the
    # failure here is exactly the #184597 shape — a skip nobody hears about.
    $result = [pscustomobject]@{ Ok = $false; Method = $null; Reason = $null }

    if (-not (Test-Path $DaemonCmd)) {
        $result.Reason = "the daemon launcher was not installed, so there is nothing to start"
        return $result
    }

    # 1. Preferred: a per-user scheduled task (at logon + restart on failure).
    if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
        try {
            # Idempotent: re-running the installer must replace, never duplicate.
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

            $action   = New-ScheduledTaskAction -Execute $DaemonCmd -Argument "start"
            $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
            # RestartCount/RestartInterval are the KeepAlive equivalent. StartWhenAvailable
            # covers a machine that was asleep at the scheduled moment.
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                                    -DontStopIfGoingOnBatteries `
                                                    -StartWhenAvailable `
                                                    -RestartCount 3 `
                                                    -RestartInterval (New-TimeSpan -Minutes 1) `
                                                    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
            # -User without -RunLevel Highest => runs as this user, no elevation prompt.
            Register-ScheduledTask -TaskName $TaskName `
                                   -Action $action `
                                   -Trigger $trigger `
                                   -Settings $settings `
                                   -User $env:USERNAME `
                                   -Description "Starts the IRIS Hive compute node at logon and restarts it if it stops." `
                                   -Force -ErrorAction Stop | Out-Null

            $result.Ok = $true
            $result.Method = "scheduled-task"
            return $result
        } catch {
            # Fall through to the Run key. Keep the reason: if the fallback also fails,
            # the user should see why the better option was not used.
            $result.Reason = $_.Exception.Message
        }
    } else {
        $result.Reason = "the ScheduledTasks module is not available"
    }

    # 2. Fallback: HKCU Run key. Starts at logon, does NOT restart on crash.
    try {
        $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
        if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force -ErrorAction Stop | Out-Null }
        Set-ItemProperty -Path $runKey -Name "IRISHiveNode" -Value "`"$DaemonCmd`" start" -ErrorAction Stop
        $result.Ok = $true
        $result.Method = "run-key"
        return $result
    } catch {
        $result.Reason = "$($result.Reason); and the Run key could not be written: $($_.Exception.Message)".TrimStart('; ')
        return $result
    }
}

# ─── Step 5: Agent Bridge ────────────────────────────────────────────────────

$HasNode = Get-Command node -ErrorAction SilentlyContinue
# NOTE: no $HasGit gate any more. Git was only ever used to `clone`/`pull` the daemon;
# the installer now fetches an HTTPS archive, so a machine without Git installs fine.
# (The telemetry beacon still reports has_git — knowing who HAS it is useful, because
# reference-repo indexing and exchange tasks do still need it at runtime.)
$BridgeDir = "$IRIS_DIR\bridge"

# #184597 — remember whether the bridge was skipped, so the FINAL summary can tell the truth.
# Without this the skip was announced once in DarkGray, then the install printed
# "installed successfully!" in green and told the user to run `iris-daemon start` — a command
# that cannot work, because the thing it needs is exactly what was skipped. A client lost two
# hours to that sequence: the installer said it worked, so the missing daemon looked like a
# broken product rather than an unmet prerequisite.
$BridgeSkippedReason = $null
# Same reasoning as above, for autostart: a node that will not come back after a
# reboot must not be reported as a node that will.
$AutostartFailedReason = $null

if (-not $HasNode) {
    Write-StepSkipped "5/5" "Agent Bridge" "skipped (Node.js not found)"
    Send-InstallBeacon -EventType "install_step_skipped" -Step "agent_bridge" -Reason "node_missing"
    Write-Muted "Install Node.js to enable: https://nodejs.org"
    $BridgeSkippedReason = "Node.js is not installed (https://nodejs.org)"
} else {
    # NO GIT. One code path for install and update — the old one had two, and the
    # update branch ran `git pull` inside a directory the install branch had created
    # with `git clone`, so a client whose clone half-failed got "already installed,
    # updating..." forever over a tree with no daemon in it.
    $Fetch = Install-IrisDaemonSource -BridgeDir $BridgeDir
    $BridgeUpdated = $Fetch.Updated
    if (-not $Fetch.Ok) {
        Write-StepSkipped "5/5" "Agent Bridge" "could not download"
        Write-Muted $Fetch.Reason
        $BridgeSkippedReason = "the daemon could not be downloaded ($($Fetch.Reason))"
    } else {
        Push-Location $BridgeDir
        npm install --production --silent 2>$null
        Pop-Location
    }

    if (Test-Path "$BridgeDir\index.js") {
        # Create iris-bridge.cmd wrapper
        $BridgeCmdContent = @"
@echo off
setlocal
set BRIDGE_DIR=%USERPROFILE%\.iris\bridge

if "%1"=="start" (
    start /b node "%BRIDGE_DIR%\index.js" > "%BRIDGE_DIR%\bridge.log" 2>&1
    echo Bridge starting on http://localhost:3200
    goto :eof
)
if "%1"=="stop" (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3200 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
    echo Stopped.
    goto :eof
)
if "%1"=="status" (
    netstat -aon | findstr :3200 | findstr LISTENING >nul 2>&1
    if errorlevel 1 (echo Not running) else (echo Running)
    goto :eof
)
if "%1"=="logs" (
    type "%BRIDGE_DIR%\bridge.log"
    goto :eof
)
echo Usage: iris-bridge {start^|stop^|status^|logs}
"@
        Set-Content -Path "$INSTALL_DIR\iris-bridge.cmd" -Value $BridgeCmdContent -Encoding ASCII

        # Create iris-daemon.cmd wrapper
        $DaemonCmdContent = @"
@echo off
setlocal
set BRIDGE_DIR=%USERPROFILE%\.iris\bridge
set DAEMON_LOG=%BRIDGE_DIR%\daemon.log

if "%1"=="start" (
    start /b node "%BRIDGE_DIR%\daemon.js" > "%DAEMON_LOG%" 2>&1
    echo Hive daemon starting. Your machine is now a compute node.
    goto :eof
)
if "%1"=="stop" (
    for /f "tokens=2" %%a in ('tasklist /fi "windowtitle eq iris-daemon" /fo list ^| findstr PID') do taskkill /PID %%a /F >nul 2>&1
    echo Stopped.
    goto :eof
)
if "%1"=="status" (
    node "%BRIDGE_DIR%\daemon.js" --status 2>nul || echo Not running. Start with: iris-daemon start
    goto :eof
)
if "%1"=="share" (
    node "%BRIDGE_DIR%\daemon.js" --share %2 %3 %4
    goto :eof
)
if "%1"=="unshare" (
    node "%BRIDGE_DIR%\daemon.js" --unshare
    goto :eof
)
if "%1"=="logs" (
    type "%DAEMON_LOG%"
    goto :eof
)
if "%1"=="register" (
    echo Register via: iris-login
    echo Then run: iris-daemon start
    goto :eof
)
echo Usage: iris-daemon {start^|stop^|status^|share^|unshare^|register^|logs}
"@
        Set-Content -Path "$INSTALL_DIR\iris-daemon.cmd" -Value $DaemonCmdContent -Encoding ASCII

        if ($BridgeUpdated) {
            Write-Step "5/5" "Agent Bridge" "updated"
        } else {
            Write-Step "5/5" "Agent Bridge" "installed"
        }
        Write-Muted "Bridge: iris-bridge start|stop|status"
        Write-Muted "Daemon: iris-daemon start|stop|status|register (Hive compute node)"

        # Register autostart so the node survives a reboot (#184597 FIX 3).
        $Autostart = Register-IrisAutostart -DaemonCmd "$INSTALL_DIR\iris-daemon.cmd"
        if ($Autostart.Ok) {
            if ($Autostart.Method -eq 'scheduled-task') {
                Write-Muted "Autostart: registered (starts at logon, restarts if it stops)"
            } else {
                # Say which one you got. "It restarts if it crashes" is a promise the
                # Run key cannot keep, and a summary that implies it would be lying.
                Write-Muted "Autostart: registered via the Run key (starts at logon; will NOT restart if it stops)"
            }
            Send-InstallBeacon -EventType "install_step_ok" -Step "autostart" -Reason $Autostart.Method
        } else {
            $AutostartFailedReason = $Autostart.Reason
            Send-InstallBeacon -EventType "install_step_skipped" -Step "autostart" -Reason "register_failed"
        }
    }
}

# ─── iris-login.cmd ──────────────────────────────────────────────────────────

$LoginScript = @'
<# IRIS Login — Windows #>
param(
    [string]$Token = "",
    [string]$UserId = "",
    [switch]$Help,
    [Parameter(Position=0)][string]$Action = ""
)
$ErrorActionPreference = "Stop"
$IRIS_DIR = "$env:USERPROFILE\.iris"
$SDK_ENV = "$IRIS_DIR\sdk\.env"
$CONFIG_JSON = "$IRIS_DIR\config.json"
$API_BASE = "https://raichu.heyiris.io"

# BOM-free UTF-8 writer (PS 5.1 Set-Content -Encoding UTF8 adds BOM which breaks .env parsing)
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false))
}

if ($Help) { Write-Host "Usage: iris-login [whoami|--Token TOKEN --UserId ID]"; exit 0 }

function Get-JsonField {
    param([string]$Json, [string]$Field)
    try {
        $obj = $Json | ConvertFrom-Json
        $val = $obj.$Field
        if (-not $val -and $obj.data) { $val = $obj.data.$Field }
        return "$val"
    } catch { return "" }
}

function Register-Hive {
    param([string]$AuthToken, [string]$HiveUserId)
    $HostLabel = $env:COMPUTERNAME
    $HasDocker = if (Get-Command docker -ErrorAction SilentlyContinue) { "true" } else { "false" }
    $Body = @{ name = $HostLabel; capabilities = @{ docker = ($HasDocker -eq "true") } } | ConvertTo-Json
    try {
        $resp = Invoke-RestMethod -Uri "$API_BASE/api/v1/hive/register-node" -Method Post `
            -Headers @{ Authorization = "Bearer $AuthToken"; "Content-Type" = "application/json" } `
            -Body $Body -TimeoutSec 10 -ErrorAction Stop
        if ($resp.node_key) {
            New-Item -ItemType Directory -Force -Path $IRIS_DIR | Out-Null
            $cfg = @{ node_api_key = $resp.node_key; user_id = [int]$HiveUserId; api_url = "https://freelabel.net" } | ConvertTo-Json
            Write-Utf8NoBom -Path $CONFIG_JSON -Content $cfg
            Write-Host "  Machine registered as Hive compute node" -ForegroundColor Green
            return
        }
    } catch {}
    Write-Host "  Hive registration skipped. Try later: iris-daemon register" -ForegroundColor DarkGray
}

# ─── whoami subcommand ────────────────────────────────────────────────────
if ($Action -eq "whoami" -or $Action -eq "status") {
    if (-not (Test-Path $SDK_ENV)) {
        Write-Host "Not authenticated. Run iris-login to log in." -ForegroundColor Red; exit 1
    }
    $envToken = (Get-Content $SDK_ENV | Where-Object { $_ -match "^IRIS_API_KEY=" }) -replace "IRIS_API_KEY=", ""
    if (-not $envToken) {
        Write-Host "No token found. Run iris-login to authenticate." -ForegroundColor Red; exit 1
    }
    try {
        $meResp = Invoke-RestMethod -Uri "$API_BASE/api/v1/me" -Method Get `
            -Headers @{ Authorization = "Bearer $envToken"; Accept = "application/json" } `
            -TimeoutSec 10 -ErrorAction Stop
        Write-Host ""
        Write-Host "Authenticated" -ForegroundColor Green
        if ($meResp.data.full_name) { Write-Host "  Name:   $($meResp.data.full_name)" }
        if ($meResp.data.email) { Write-Host "  Email:  $($meResp.data.email)" }
        if ($meResp.data.id) { Write-Host "  ID:     $($meResp.data.id)" }
        Write-Host "  Token:  $($envToken.Substring(0, [Math]::Min(12, $envToken.Length)))..." -ForegroundColor DarkGray
    } catch {
        Write-Host "Token invalid or API unreachable." -ForegroundColor Red
        Write-Host "  Delete ~\.iris\sdk\.env and run iris-login again." -ForegroundColor DarkGray
    }
    exit 0
}

# Scripted auth (--Token flag)
if ($Token) {
    if ($Token.Length -lt 20) {
        Write-Host "Invalid token - must be at least 20 characters." -ForegroundColor Red
        Write-Host "Get your token from: https://web.heyiris.io/settings/api-keys" -ForegroundColor DarkGray
        exit 1
    }
    # Validate token against API
    Write-Host "  Validating token..." -ForegroundColor DarkGray
    try {
        $validateResp = Invoke-RestMethod -Uri "$API_BASE/api/v1/me" -Method Get `
            -Headers @{ Authorization = "Bearer $Token"; Accept = "application/json" } `
            -TimeoutSec 10 -ErrorAction Stop
        $validatedId = $validateResp.data.id
        if (-not $validatedId) { throw "No user ID returned" }
        if (-not $UserId) { $UserId = "$validatedId" }
    } catch {
        Write-Host "Token validation failed - API rejected the token." -ForegroundColor Red
        Write-Host "Check that the token is correct and not expired." -ForegroundColor DarkGray
        exit 1
    }
    New-Item -ItemType Directory -Force -Path "$IRIS_DIR\sdk" | Out-Null
    $envContent = "IRIS_ENV=production`nIRIS_API_KEY=$Token`nIRIS_USER_ID=$UserId`nIRIS_DEFAULT_MODEL=gpt-4o-mini`n"
    Write-Utf8NoBom -Path $SDK_ENV -Content $envContent
    Write-Host "Authenticated via token." -ForegroundColor Green
    Register-Hive $Token $UserId
    exit 0
}

# Already authenticated?
if (Test-Path $SDK_ENV) {
    $existing = (Get-Content $SDK_ENV | Where-Object { $_ -match "^IRIS_API_KEY=" }) -replace "IRIS_API_KEY=", ""
    if ($existing) {
        Write-Host "Already authenticated." -ForegroundColor Green
        Write-Host "Token: $($existing.Substring(0, [Math]::Min(12, $existing.Length)))..." -ForegroundColor DarkGray
        Write-Host "To re-authenticate, delete ~\.iris\sdk\.env and run iris-login again." -ForegroundColor DarkGray
        exit 0
    }
}

# Interactive login
Write-Host ""
Write-Host "IRIS Login" -ForegroundColor Cyan
Write-Host ""
$UserEmail = Read-Host "  Email"
if (-not $UserEmail) { Write-Host "Cancelled." -ForegroundColor DarkGray; exit 0 }
if ($UserEmail -notmatch '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$') {
    Write-Host "  Invalid email format." -ForegroundColor Red; exit 1
}

Write-Host "  Sending verification code..." -ForegroundColor DarkGray
$SendBody = @{
    email = $UserEmail
    method = "with_login_code"
    expiration_minutes = 30
    auto_create = $true
} | ConvertTo-Json

try {
    $sendResp = Invoke-RestMethod -Uri "$API_BASE/api/v1/auth/send-login-code" -Method Post `
        -Headers @{ "Content-Type" = "application/json"; Accept = "application/json" } `
        -Body $SendBody -TimeoutSec 15 -ErrorAction Stop
} catch {
    Write-Host "  Failed to send code. Sign up at: https://web.heyiris.io/login/register" -ForegroundColor Red
    exit 1
}

if ($sendResp.data.new_account -eq $true) {
    Write-Host "  Account created! Check your inbox." -ForegroundColor Green
} else {
    Write-Host "  Code sent! Check your inbox." -ForegroundColor Green
}

$Code = Read-Host "  Enter the 6-digit code"
if (-not $Code) { Write-Host "Cancelled." -ForegroundColor DarkGray; exit 0 }

Write-Host "  Verifying..." -ForegroundColor DarkGray
$LoginBody = @{
    email = $UserEmail
    login_code = $Code
    generate_sdk_token = $true
    sdk_token_name = "IRIS Code CLI"
    sdk_token_expires_days = 365
    generate_dashboard_url = $true
} | ConvertTo-Json

try {
    $loginResp = Invoke-RestMethod -Uri "$API_BASE/api/v1/auth/login-with-code" -Method Post `
        -Headers @{ "Content-Type" = "application/json"; Accept = "application/json" } `
        -Body $LoginBody -TimeoutSec 15 -ErrorAction Stop
} catch {
    Write-Host "  Login failed. Code may have expired - run iris-login to try again." -ForegroundColor Red
    exit 1
}

$SdkToken = $loginResp.data.sdk_token.key
$LoginUserId = $loginResp.data.user.id
$Dashboard = $loginResp.data.dashboard_url

if (-not $SdkToken -or -not $LoginUserId) {
    Write-Host "  Auth succeeded but token wasn't generated. Try again." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path "$IRIS_DIR\sdk" | Out-Null
$envContent = "IRIS_ENV=production`nIRIS_API_KEY=$SdkToken`nIRIS_USER_ID=$LoginUserId`nIRIS_DEFAULT_MODEL=gpt-4o-mini`n"
Write-Utf8NoBom -Path $SDK_ENV -Content $envContent

Write-Host "  Authenticated!" -ForegroundColor Green
if ($Dashboard) { Write-Host "  Dashboard: $Dashboard" -ForegroundColor Cyan }

Register-Hive $SdkToken "$LoginUserId"

Write-Host ""
Write-Host "Next: iris-daemon start to join the Hive compute network" -ForegroundColor DarkGray
Write-Host "  Or: iris to start the AI coding agent" -ForegroundColor DarkGray
'@

# The login implementation lives OUTSIDE the PATH directory, and only the .cmd
# shim is named `iris-login` on PATH. This is deliberate (#179080).
#
# We used to ship BOTH iris-login.ps1 and iris-login.cmd in $INSTALL_DIR. That
# looks redundant-but-harmless and is not: PowerShell resolves .ps1 BEFORE .cmd,
# so `iris-login` always hit the raw script and died under the default execution
# policy ("cannot be loaded because running scripts is disabled on this system")
# — while the .cmd shim that exists precisely to pass -ExecutionPolicy Bypass was
# never reached. The same command worked in cmd.exe, which made it look flaky.
# Keeping the .ps1 off PATH means nothing can shadow the shim.
$LibDir = "$IRIS_DIR\lib"
New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
Set-Content -Path "$LibDir\iris-login.ps1" -Value $LoginScript -Encoding UTF8

# Remove the shadowing copy left by older installers, or the upgrade silently
# keeps the bug: the stale $INSTALL_DIR\iris-login.ps1 still wins name resolution.
if (Test-Path "$INSTALL_DIR\iris-login.ps1") {
    Remove-Item -Force "$INSTALL_DIR\iris-login.ps1" -ErrorAction SilentlyContinue
}

# The only `iris-login` on PATH. Works from both PowerShell and cmd.exe.
$LoginCmdShim = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.iris\lib\iris-login.ps1" %*
"@
Set-Content -Path "$INSTALL_DIR\iris-login.cmd" -Value $LoginCmdShim -Encoding ASCII

# ─── PATH setup ──────────────────────────────────────────────────────────────

# Add to current session
$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
if ($CurrentPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$INSTALL_DIR;$CurrentPath", "Process")
}

# Add to user PATH permanently
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $UserPath) { $UserPath = "" }
if ($UserPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$INSTALL_DIR;$UserPath", "User")
    $PathUpdated = $true
} else {
    $PathUpdated = $false
}

# ─── Final output ────────────────────────────────────────────────────────────

Write-Host ""

# #184597 — a partial install must not report itself as a complete one.
if ($BridgeSkippedReason) {
    Send-InstallBeacon -EventType "install_success_partial" -Step "agent_bridge" -Reason "bridge_skipped"
    Write-Host "IRIS Code installed - but the Agent Bridge was SKIPPED." -ForegroundColor Yellow
} else {
    Send-InstallBeacon -EventType "install_success"
    Write-Host "IRIS Code installed successfully!" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Binary:  $INSTALL_DIR\iris.exe" -ForegroundColor DarkGray
Write-Host "  Version: $SpecificVersion" -ForegroundColor DarkGray
Write-Host ""

if ($BridgeSkippedReason) {
    Write-Host "  The Hive daemon will NOT run on this machine yet." -ForegroundColor Yellow
    Write-Host "  Reason: $BridgeSkippedReason" -ForegroundColor DarkGray
    Write-Host "  Install it, then re-run this installer - or run: iris hive connect" -ForegroundColor DarkGray
    Write-Host ""
}

if ($AutostartFailedReason) {
    Write-Host "  This node will NOT restart automatically after a reboot." -ForegroundColor Yellow
    Write-Host "  Reason: $AutostartFailedReason" -ForegroundColor DarkGray
    Write-Host "  Start it by hand after each reboot with: iris-daemon start" -ForegroundColor DarkGray
    Write-Host ""
}

if ($PathUpdated) {
    Write-Host "  PATH updated. Restart your terminal, then run:" -ForegroundColor DarkGray
} else {
    Write-Host "  Run:" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "    iris-login" -ForegroundColor Cyan -NoNewline
Write-Host "        Authenticate with your IRIS account" -ForegroundColor DarkGray
Write-Host "    iris" -ForegroundColor Cyan -NoNewline
Write-Host "             Start the AI coding agent" -ForegroundColor DarkGray
Write-Host "    iris-daemon start" -ForegroundColor Cyan -NoNewline
Write-Host "  Join the Hive compute network" -ForegroundColor DarkGray
Write-Host ""
