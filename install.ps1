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
    $Url = "https://github.com/FREELABEL/iris-opencode/releases/latest/download/$Filename"

    try {
        $LatestResp = Invoke-RestMethod -Uri "https://api.github.com/repos/FREELABEL/iris-opencode/releases/latest" -UseBasicParsing -ErrorAction Stop
        $SpecificVersion = $LatestResp.tag_name -replace "^v", ""
    } catch {
        Write-Host "Failed to fetch version information." -ForegroundColor Red
        Write-Host "Check your internet connection or install a specific version:" -ForegroundColor DarkGray
        Write-Host '  $env:VERSION="1.1.6"; irm https://heyiris.io/install-code.ps1 | iex' -ForegroundColor DarkGray
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

    Copy-Item -Path $Binary.FullName -Destination "$INSTALL_DIR\iris.exe" -Force
} catch {
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
      "url": "https://heyiris.io/mcp",
      "enabled": false
    }
  }
}
'@
    Set-Content -Path $McpConfig -Value $McpJson -Encoding UTF8
    Write-Step "4/5" "MCP Config" "scaffolded"
    Write-Muted "Config at ~\.iris\mcp.json (enable when MCP servers are ready)"
}

# ─── Step 5: Agent Bridge ────────────────────────────────────────────────────

$HasNode = Get-Command node -ErrorAction SilentlyContinue
$HasGit = Get-Command git -ErrorAction SilentlyContinue
$BridgeDir = "$IRIS_DIR\bridge"

if (-not $HasNode) {
    Write-StepSkipped "5/5" "Agent Bridge" "skipped (Node.js not found)"
    Write-Muted "Install Node.js to enable: https://nodejs.org"
} elseif (-not $HasGit) {
    Write-StepSkipped "5/5" "Agent Bridge" "skipped (Git not found)"
    Write-Muted "Install Git to enable: https://git-scm.com"
} else {
    $BridgeUpdated = $false
    if ((Test-Path "$BridgeDir\index.js") -and (Test-Path "$BridgeDir\daemon.js")) {
        Write-Host "      Bridge already installed, updating..." -ForegroundColor DarkGray
        Push-Location $BridgeDir
        git pull --quiet 2>$null
        npm install --production --silent 2>$null
        Pop-Location
        $BridgeUpdated = $true
    } else {
        try {
            git clone --quiet https://github.com/FREELABEL/iris-daemon.git $BridgeDir 2>$null
            Push-Location $BridgeDir
            npm install --production --silent 2>$null
            Pop-Location
        } catch {
            Write-StepSkipped "5/5" "Agent Bridge" "could not download"
            Write-Muted "Try manually: git clone https://github.com/FREELABEL/iris-daemon.git ~\.iris\bridge"
        }
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
    }
}

# ─── iris-login.cmd ──────────────────────────────────────────────────────────

$LoginScript = @'
<# IRIS Login — Windows #>
param(
    [string]$Token = "",
    [string]$UserId = ""
)
$ErrorActionPreference = "Stop"
$IRIS_DIR = "$env:USERPROFILE\.iris"
$SDK_ENV = "$IRIS_DIR\sdk\.env"
$CONFIG_JSON = "$IRIS_DIR\config.json"
$API_BASE = "https://raichu.heyiris.io"

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
            Set-Content -Path $CONFIG_JSON -Value $cfg -Encoding UTF8
            Write-Host "  Machine registered as Hive compute node" -ForegroundColor Green
            return
        }
    } catch {}
    Write-Host "  Hive registration skipped. Try later: iris-daemon register" -ForegroundColor DarkGray
}

# Scripted auth (--Token flag)
if ($Token) {
    New-Item -ItemType Directory -Force -Path "$IRIS_DIR\sdk" | Out-Null
    @"
IRIS_ENV=production
IRIS_API_KEY=$Token
IRIS_USER_ID=$UserId
IRIS_DEFAULT_MODEL=gpt-4o-mini
"@ | Set-Content -Path $SDK_ENV -Encoding UTF8
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
@"
IRIS_ENV=production
IRIS_API_KEY=$SdkToken
IRIS_USER_ID=$LoginUserId
IRIS_DEFAULT_MODEL=gpt-4o-mini
"@ | Set-Content -Path $SDK_ENV -Encoding UTF8

Write-Host "  Authenticated!" -ForegroundColor Green
if ($Dashboard) { Write-Host "  Dashboard: $Dashboard" -ForegroundColor Cyan }

Register-Hive $SdkToken "$LoginUserId"

Write-Host ""
Write-Host "Next: iris-daemon start to join the Hive compute network" -ForegroundColor DarkGray
Write-Host "  Or: iris to start the AI coding agent" -ForegroundColor DarkGray
'@

Set-Content -Path "$INSTALL_DIR\iris-login.ps1" -Value $LoginScript -Encoding UTF8

# Also create a .cmd shim so iris-login works from cmd.exe
$LoginCmdShim = @"
@echo off
powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.iris\bin\iris-login.ps1" %*
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
Write-Host "IRIS Code installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Binary:  $INSTALL_DIR\iris.exe" -ForegroundColor DarkGray
Write-Host "  Version: $SpecificVersion" -ForegroundColor DarkGray
Write-Host ""

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
