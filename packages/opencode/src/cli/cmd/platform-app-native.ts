// iris app serve --runtime native — the wiring (Windows, macOS, Linux; no Docker, no sh on Windows).
// Pure decisions: apps-native.ts. This file writes files and asks the OS to supervise them.

import { execFile } from "child_process"
import { promisify } from "util"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir, platform as osPlatform, userInfo } from "os"
import { basename, join } from "path"
import type { AppManifest } from "./apps-serve"
import {
  buildLaunchdPlist,
  buildLauncherCmd,
  buildLauncherSh,
  buildSecretsFile,
  buildSystemdUnit,
  buildWindowsTaskXml,
  nativeLayout,
  serviceLabel,
  supervisorFor,
  type NativeRecord,
  type Platform,
} from "./apps-native"

const pexec = promisify(execFile)

export function currentPlatform(): Platform {
  const p = osPlatform()
  return p === "win32" ? "win32" : p === "darwin" ? "darwin" : "linux"
}

async function ok(cmd: string, args: string[], timeout = 15_000): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (e: any) {
    return { code: typeof e?.code === "number" ? e.code : 1, out: `${e?.stdout ?? ""}${e?.stderr ?? e?.message ?? ""}` }
  }
}

export async function hasDockerHere(): Promise<boolean> {
  return (await ok("docker", ["version", "--format", "{{.Server.Version}}"], 8000)).code === 0
}

/** uv on PATH, or where its installer puts it. */
export async function findUv(): Promise<string | null> {
  const p = currentPlatform()
  const candidates = [p === "win32" ? "uv.exe" : "uv",
    join(homedir(), ".local", "bin", p === "win32" ? "uv.exe" : "uv"),
    join(homedir(), ".cargo", "bin", p === "win32" ? "uv.exe" : "uv")]
  for (const c of candidates) {
    const r = await ok(c, ["--version"], 8000)
    if (r.code === 0) {
      if (c.includes("/") || c.includes("\\")) return c
      // Resolve to an absolute path: a service does not inherit the shell's PATH.
      const w = await ok(p === "win32" ? "where" : "sh", p === "win32" ? [c] : ["-c", `command -v ${c}`])
      const first = w.out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      return first || c
    }
  }
  return null
}

export function uvInstallCommand(): { cmd: string; args: string[]; display: string } {
  return currentPlatform() === "win32"
    ? { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"], display: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"' }
    : { cmd: "sh", args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], display: "curl -LsSf https://astral.sh/uv/install.sh | sh" }
}

export async function installUv(): Promise<{ ok: boolean; out: string }> {
  const c = uvInstallCommand()
  const r = await ok(c.cmd, c.args, 180_000)
  return { ok: r.code === 0, out: r.out }
}

/** Owner-only permissions on a file that holds secrets. */
async function lockDown(file: string, p: Platform): Promise<void> {
  if (p === "win32") {
    const user = process.env.USERNAME || userInfo().username
    await ok("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`])
  } else chmodSync(file, 0o600)
}

export interface NativeServeResult {
  ok: boolean
  error?: string
  hint?: string
  exists?: boolean
  supervisor?: NativeRecord["supervisor"]
  home?: string
  logs?: string
}

export async function serveNative(opts: {
  manifest: AppManifest
  folder: string
  filePaths: string[]
  hostPort: number
  uv: string
  replace: boolean
}): Promise<NativeServeResult> {
  const p = currentPlatform()
  const m = opts.manifest
  const l = nativeLayout(homedir(), m.name, p)

  if (existsSync(l.record) && !opts.replace) {
    return { ok: false, exists: true, error: `${m.name} is already served on this machine`, hint: "Replace it: --replace" }
  }

  // Secrets: read the NAMES the manifest declares from the current environment, once.
  const values: Record<string, string> = {}
  const missing = m.secrets.filter((s) => process.env[s] === undefined)
  if (missing.length) return { ok: false, error: `Set these before serving (they are stored for the app, owner-only): ${missing.join(", ")}` }
  for (const s of m.secrets) values[s] = String(process.env[s])
  const secrets = buildSecretsFile(values)
  if (secrets.errors.length) return { ok: false, error: secrets.errors.join("; ") }
  if (p === "win32" && Object.values(values).some((v) => /[!%"]/.test(v))) {
    return { ok: false, error: "A secret value contains ! % or \" — Windows cmd cannot pass those safely yet. Use --runtime docker or change the value." }
  }

  await stopNative(m.name) // idempotent; only matters with --replace

  for (const d of [l.home, l.src, l.logs]) mkdirSync(d, { recursive: true })
  for (const f of readdirSync(l.src)) if (!opts.filePaths.some((fp) => basename(fp) === f)) {
    // A file removed from the folder must not keep running from an old copy.
    try { rmSync(join(l.src, f), { recursive: true, force: true }) } catch {}
  }
  for (const fp of opts.filePaths) copyFileSync(fp, join(l.src, basename(fp)))

  writeFileSync(l.secretsFile, secrets.text, { mode: 0o600 })
  await lockDown(l.secretsFile, p)

  if (p === "win32") writeFileSync(l.launcher, buildLauncherCmd(m, l, opts.hostPort, opts.uv))
  else { writeFileSync(l.launcher, buildLauncherSh(m, l, opts.hostPort, opts.uv)); chmodSync(l.launcher, 0o755) }

  const record: NativeRecord = {
    name: m.name, runtime: "native", port: opts.hostPort, health: m.health, entry: m.entry,
    data_class: m.data_class, supervisor: supervisorFor(p), served_at: new Date().toISOString(),
  }

  // ── hand it to the OS ──
  if (p === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user")
    mkdirSync(dir, { recursive: true })
    const unit = `iris-app-${m.name}.service`
    writeFileSync(join(dir, unit), buildSystemdUnit(m, l))
    const reload = await ok("systemctl", ["--user", "daemon-reload"])
    if (reload.code !== 0) return { ok: false, error: `systemd user services are not available here: ${reload.out.trim().slice(0, 200)}`, hint: "On a server without a login session run: loginctl enable-linger $USER" }
    const start = await ok("systemctl", ["--user", "enable", "--now", unit])
    if (start.code !== 0) return { ok: false, error: `systemctl could not start ${unit}: ${start.out.trim().slice(0, 300)}` }
  } else if (p === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", `${serviceLabel(m.name)}.plist`)
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plist, buildLaunchdPlist(m, l))
    const uid = String(userInfo().uid)
    const boot = await ok("launchctl", ["bootstrap", `gui/${uid}`, plist])
    if (boot.code !== 0) return { ok: false, error: `launchctl could not load ${plist}: ${boot.out.trim().slice(0, 300)}` }
  } else {
    const user = `${process.env.USERDOMAIN ?? ""}${process.env.USERDOMAIN ? "\\" : ""}${process.env.USERNAME ?? userInfo().username}`
    const xmlPath = join(l.home, "task.xml")
    // schtasks /XML requires UTF-16 with a byte-order mark.
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildWindowsTaskXml(m, l, user), "utf16le")]))
    const create = await ok("schtasks", ["/Create", "/TN", `IRIS\\App ${m.name}`, "/XML", xmlPath, "/F"])
    if (create.code !== 0) return { ok: false, error: `Task Scheduler refused the task: ${create.out.trim().slice(0, 300)}` }
    const run = await ok("schtasks", ["/Run", "/TN", `IRIS\\App ${m.name}`])
    if (run.code !== 0) return { ok: false, error: `Task Scheduler could not start it: ${run.out.trim().slice(0, 300)}` }
  }

  writeFileSync(l.record, JSON.stringify(record, null, 2))
  return { ok: true, supervisor: record.supervisor, home: l.home, logs: join(l.logs, "app.log") }
}

/** Stop and unregister a native app (used by --replace; also the basis of a future `iris app stop`). */
export async function stopNative(name: string): Promise<void> {
  const p = currentPlatform()
  if (p === "linux") await ok("systemctl", ["--user", "disable", "--now", `iris-app-${name}.service`])
  else if (p === "darwin") await ok("launchctl", ["bootout", `gui/${userInfo().uid}/${serviceLabel(name)}`])
  else { await ok("schtasks", ["/End", "/TN", `IRIS\\App ${name}`]); await ok("schtasks", ["/Delete", "/TN", `IRIS\\App ${name}`, "/F"]) }
}

/** Probe http://127.0.0.1:<port><path> until 2xx/3xx or time runs out. Done in Node so it works on Windows. */
export async function waitHealthy(port: number, path: string, waitSec: number): Promise<{ ready: boolean; http: number | null; afterSec: number }> {
  const start = Date.now()
  let http: number | null = null
  while ((Date.now() - start) / 1000 < waitSec) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(3000) })
      http = r.status
      if (r.status >= 200 && r.status < 400) return { ready: true, http, afterSec: Math.round((Date.now() - start) / 1000) }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ready: false, http, afterSec: Math.round((Date.now() - start) / 1000) }
}

/** Native apps on THIS machine, from their own records, each probed. */
export async function listNativeHere(): Promise<Array<NativeRecord & { http: number | null; healthy: boolean }>> {
  const root = join(homedir(), ".iris", "apps")
  if (!existsSync(root)) return []
  const out: Array<NativeRecord & { http: number | null; healthy: boolean }> = []
  for (const d of readdirSync(root)) {
    const f = join(root, d, "app.json")
    if (!existsSync(f)) continue
    try {
      const rec = JSON.parse(readFileSync(f, "utf8")) as NativeRecord
      if (rec.runtime !== "native") continue
      let http: number | null = null
      try { http = (await fetch(`http://127.0.0.1:${rec.port}${rec.health || "/"}`, { redirect: "manual", signal: AbortSignal.timeout(3000) })).status } catch {}
      out.push({ ...rec, http, healthy: http !== null && http >= 200 && http < 400 })
    } catch {}
  }
  return out
}
