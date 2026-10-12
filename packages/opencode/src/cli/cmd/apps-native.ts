// ── iris app serve --runtime native — no Docker (the pure half) ────────────────────────────
//
// Clients do not have Docker, and should not need it (Alex, 2026-10-12). Every machine already
// has the two things a served app needs:
//   * a Python runtime manager: `uv` — one binary, no admin, Windows/macOS/Linux; it fetches the
//     right Python and builds the app's own environment from requirements.txt;
//   * a supervisor: the operating system — launchd (macOS, how the IRIS bridge itself runs),
//     a systemd user unit (Linux), Task Scheduler at logon (Windows). None needs admin.
//
// What native CANNOT give, said plainly: the app runs as the user. There is no container wall.
// What it does give, by construction:
//   * the user's IRIS login is never in the app's environment — only PORT, HOST, and the
//     secrets the manifest names (stored per app, owner-only file permissions);
//   * it binds 127.0.0.1 (HOST is set; lint refuses 0.0.0.0);
//   * its own folder, its own environment, its own logs;
//   * restart on crash with backoff, start at login;
//   * a memory and process cap where the OS has one (systemd); none on Windows yet.
// data_class: phi and third-party code still require --runtime docker (#189083).

import type { AppManifest } from "./apps-serve"

export type Platform = "darwin" | "linux" | "win32"

export interface NativeLayout {
  /** ~/.iris/apps/<name> */
  home: string
  /** where the app's files are copied */
  src: string
  logs: string
  secretsFile: string
  launcher: string
  record: string
}

export function nativeLayout(userHome: string, name: string, platform: Platform): NativeLayout {
  const sep = platform === "win32" ? "\\" : "/"
  const j = (...p: string[]) => p.join(sep)
  const home = j(userHome, ".iris", "apps", name)
  return {
    home,
    src: j(home, "src"),
    logs: j(home, "logs"),
    secretsFile: j(home, "secrets.env"),
    launcher: j(home, platform === "win32" ? "run.cmd" : "run.sh"),
    record: j(home, "app.json"),
  }
}

export function serviceLabel(name: string): string {
  return `io.heyiris.app.${name}`
}

/** KEY=value lines; values are validated so a launcher can source them safely. */
export function buildSecretsFile(values: Record<string, string>): { text: string; errors: string[] } {
  const errors: string[] = []
  const lines: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k)) { errors.push(`secret name ${k} is not UPPER_SNAKE`); continue }
    if (/[\r\n\0]/.test(v)) { errors.push(`secret ${k} contains a newline`); continue }
    lines.push(`${k}=${v}`)
  }
  return { text: lines.join("\n") + (lines.length ? "\n" : ""), errors }
}

function shq(s: string | number): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * POSIX launcher. `env -i` starts from an EMPTY environment — this is the line that keeps the
 * user's IRIS login (and every other credential in their shell) out of the app. Secrets are read
 * as data, line by line, never `source`d, so a value cannot run code.
 */
export function buildLauncherSh(m: AppManifest, l: NativeLayout, hostPort: number, uv: string): string {
  const req = `${l.src}/requirements.txt`
  return [
    "#!/bin/sh",
    `# IRIS app ${m.name} — written by iris app serve --runtime native. Do not edit; re-run serve.`,
    "set -u",
    `cd ${shq(l.src)} || exit 1`,
    `set -- PATH=/usr/local/bin:/usr/bin:/bin HOME=${shq(l.home)} UV_CACHE_DIR=${shq(l.home + "/.uv-cache")} PORT=${hostPort} HOST=127.0.0.1 PYTHONUNBUFFERED=1`,
    `if [ -f ${shq(l.secretsFile)} ]; then`,
    `  while IFS= read -r line || [ -n "$line" ]; do case "$line" in [A-Z]*=*) set -- "$@" "$line";; esac; done < ${shq(l.secretsFile)}`,
    "fi",
    `if [ -f ${shq(req)} ]; then`,
    `  exec env -i "$@" ${shq(uv)} run --no-project --python 3.12 --with-requirements ${shq(req)} python ${shq(m.entry)}`,
    "fi",
    `exec env -i "$@" ${shq(uv)} run --no-project --python 3.12 python ${shq(m.entry)}`,
    "",
  ].join("\n")
}

/**
 * Windows launcher (cmd). cmd cannot start from an empty environment, so it clears the variables
 * that carry IRIS and cloud credentials by name, then sets only what the app is allowed. It also
 * owns the restart loop: Task Scheduler starts it at logon; the loop restarts the app on exit
 * with a 5 s pause, and the pause doubles (to 5 min) while it keeps dying.
 */
export function buildLauncherCmd(m: AppManifest, l: NativeLayout, hostPort: number, uv: string): string {
  const q = (s: string) => `"${s.replace(/"/g, "")}"`
  return [
    "@echo off",
    `REM IRIS app ${m.name} - written by iris app serve --runtime native. Do not edit; re-run serve.`,
    "setlocal EnableExtensions EnableDelayedExpansion",
    `cd /d ${q(l.src)} || exit /b 1`,
    // Credentials the user's environment may hold. Cleared, not inherited.
    'for %%V in (IRIS_API_KEY IRIS_TOKEN IRIS_API_TOKEN FL_API_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY GITHUB_TOKEN GH_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AZURE_CLIENT_SECRET GOOGLE_APPLICATION_CREDENTIALS NPM_TOKEN) do set "%%V="',
    `set "HOME=${l.home.replace(/"/g, "")}"`,
    `set "UV_CACHE_DIR=${l.home.replace(/"/g, "")}\\.uv-cache"`,
    `set "PORT=${hostPort}"`,
    'set "HOST=127.0.0.1"',
    'set "PYTHONUNBUFFERED=1"',
    `if exist ${q(l.secretsFile)} for /f "usebackq tokens=1,* delims==" %%A in (${q(l.secretsFile)}) do set "%%A=%%B"`,
    "set WAIT=5",
    ":loop",
    `if exist requirements.txt (${q(uv)} run --no-project --python 3.12 --with-requirements requirements.txt python ${q(m.entry)}) else (${q(uv)} run --no-project --python 3.12 python ${q(m.entry)})`,
    `echo [%date% %time%] ${m.name} exited with !errorlevel!, restarting in !WAIT!s`,
    "timeout /t !WAIT! /nobreak >nul",
    "set /a WAIT=WAIT*2",
    "if !WAIT! gtr 300 set WAIT=300",
    "goto loop",
    "",
  ].join("\r\n")
}

/** systemd user unit. The OS restarts it, caps it, and starts it at login. */
export function buildSystemdUnit(m: AppManifest, l: NativeLayout): string {
  return [
    "[Unit]",
    `Description=IRIS app ${m.name}`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=/bin/sh ${l.launcher}`,
    "Restart=on-failure",
    "RestartSec=5",
    "StartLimitIntervalSec=0",
    `StandardOutput=append:${l.logs}/app.log`,
    `StandardError=append:${l.logs}/app.log`,
    "NoNewPrivileges=yes",
    "MemoryMax=512M",
    "TasksMax=256",
    "PrivateTmp=yes",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** launchd agent (macOS). KeepAlive restarts on a crash; ThrottleInterval spaces restarts. */
export function buildLaunchdPlist(m: AppManifest, l: NativeLayout): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEsc(serviceLabel(m.name))}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xmlEsc(l.launcher)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WorkingDirectory</key><string>${xmlEsc(l.src)}</string>
  <key>StandardOutPath</key><string>${xmlEsc(l.logs)}/app.log</string>
  <key>StandardErrorPath</key><string>${xmlEsc(l.logs)}/app.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>SoftResourceLimits</key><dict><key>NumberOfProcesses</key><integer>256</integer></dict>
</dict>
</plist>
`
}

/**
 * Windows Task Scheduler definition: at this user's logon, least privilege, no time limit, and
 * its own restart-on-failure on top of the launcher's loop. Hidden window; logs via redirection.
 */
export function buildWindowsTaskXml(m: AppManifest, l: NativeLayout, userId: string): string {
  const cmdline = `/c ""${l.launcher}" >> "${l.logs}\\app.log" 2>&1"`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>IRIS app ${xmlEsc(m.name)} (iris app serve --runtime native)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEsc(userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEsc(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>${xmlEsc(cmdline)}</Arguments><WorkingDirectory>${xmlEsc(l.src)}</WorkingDirectory></Exec></Actions>
</Task>
`
}

/** What `list --hive` reads for native apps — the machine's own record of what it serves. */
export interface NativeRecord {
  name: string
  runtime: "native"
  port: number
  health: string
  entry: string
  data_class: string
  supervisor: "launchd" | "systemd" | "schtasks"
  served_at: string
}

export function supervisorFor(platform: Platform): NativeRecord["supervisor"] {
  return platform === "darwin" ? "launchd" : platform === "win32" ? "schtasks" : "systemd"
}

/**
 * Which runtime to use. Explicit wins. `auto` prefers Docker when present (stronger isolation),
 * else native. Patient data never goes native.
 */
export function chooseRuntime(requested: string | undefined, hasDocker: boolean, dataClass: string): { runtime: "docker" | "native" } | { error: string } {
  const r = (requested ?? "auto").toLowerCase()
  if (!["auto", "docker", "native"].includes(r)) return { error: `--runtime must be auto, docker or native` }
  if (dataClass === "phi" && r !== "docker") return { error: "data_class: phi needs container isolation (--runtime docker) on a BAA-covered machine — native runs as the user" }
  if (r === "docker") return hasDocker ? { runtime: "docker" } : { error: "--runtime docker, but this machine has no Docker. Use --runtime native, or install Docker Desktop." }
  if (r === "native") return { runtime: "native" }
  return { runtime: hasDocker ? "docker" : "native" }
}
