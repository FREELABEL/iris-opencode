/**
 * `iris pages serve <slug>` — a Genesis page running on THIS computer, and still running after a
 * reboot (#194212, epic #194199).
 *
 * One folder per page under ~/.iris/served/<slug>/:
 *   site/        the export being served (swapped whole on re-sync, never edited in place)
 *   state.json   slug, port, origin, when it last synced, how it is kept running
 *   start.vbs    Windows only — starts the server with NO console window
 *
 * Kept running by what each OS already uses for this, never by a terminal someone must leave open
 * (the #189085 Heartbeat Console lasted exactly as long as its console window):
 *   macOS   a launchd agent, io.heyiris.page.<slug>
 *   Windows a logon task, "IRIS Page <slug>", running wscript on start.vbs (hidden window)
 *   Linux   a systemd user unit, iris-page-<slug>.service
 *
 * Everything that decides WHAT to write is a pure function below, so it is tested on every OS
 * from any OS; only `install`/`uninstall` touch the machine.
 */
import { execFileSync, spawn, spawnSync } from "child_process"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { homedir, platform as osPlatform } from "os"
import { dirname, join } from "path"
import { selfCommand } from "../hive-relay-ssh"

export interface ServedState {
  slug: string
  port: number
  origin: string
  synced_at: string
  keeper: "launchd" | "schtasks" | "systemd" | "process"
  pid?: number
  /** --public: the Hive relay tunnel name, and the https address it answers on */
  public_name?: string
  public_url?: string
  /** live mode (#194353): the page's binding names; absent = a frozen snapshot */
  live_bindings?: string[]
}

export const servedRoot = (home = homedir()) => join(home, ".iris", "served")
export const servedDir = (slug: string, home = homedir()) => join(servedRoot(home), slug)

/** Slugs are [a-zA-Z0-9_-] on the server; anything else never reaches a plist, a task name or a path. */
export function safeSlug(slug: string): string | null {
  return /^[A-Za-z0-9_-]{1,120}$/.test(slug) ? slug : null
}

/**
 * The same page always gets the same port, so an installed app's address (http://localhost:N/p/x)
 * survives a re-serve. 7400–7899; `taken` lets the caller skip ports already used by other pages.
 */
export function portFor(slug: string, taken: Set<number> = new Set()): number {
  let h = 2166136261
  for (const c of slug) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  for (let i = 0; i < 500; i++) {
    const p = 7400 + ((h + i) % 500)
    if (!taken.has(p)) return p
  }
  return 7400
}

export function readState(slug: string, home = homedir()): ServedState | null {
  try {
    return JSON.parse(readFileSync(join(servedDir(slug, home), "state.json"), "utf8"))
  } catch {
    return null
  }
}

export function writeState(s: ServedState, home = homedir()) {
  mkdirSync(servedDir(s.slug, home), { recursive: true })
  writeFileSync(join(servedDir(s.slug, home), "state.json"), JSON.stringify(s, null, 2) + "\n")
}

export function listServed(home = homedir()): ServedState[] {
  const root = servedRoot(home)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((slug) => readState(slug, home))
    .filter((s): s is ServedState => !!s)
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Put a fresh export in place of the served one. The server resolves files per request against
 * the `site` path, so a rename is the whole swap: no request ever sees half of each.
 */
export function swapSite(dir: string, nextSite: string) {
  const site = join(dir, "site")
  const old = join(dir, "site.old")
  rmSync(old, { recursive: true, force: true })
  if (existsSync(site)) renameSync(site, old)
  renameSync(nextSite, site)
  rmSync(old, { recursive: true, force: true })
}

/**
 * How a service started by the OS re-invokes this CLI. The compiled binary is itself; from source
 * (`bun src/index.ts`) the entry needs the same `--conditions=browser` the dev script passes, or
 * it dies on import — measured: the systemd unit crash-looped on 'react/jsx-dev-runtime'.
 */
export function serviceSelf(self = selfCommand()): string[] {
  const [bin, entry] = self
  return entry && /\.[cm]?tsx?$/.test(entry) ? [bin!, "run", "--conditions=browser", entry] : self
}

/**
 * Where the service runs. A source run must start in the package folder — bun reads bunfig.toml
 * (its preloads) from the working directory, and without it the CLI dies on import the same way.
 * A compiled binary does not care; it gets the home folder.
 */
export function serviceCwd(self = selfCommand(), home = homedir()): string {
  const entry = self[1]
  return entry && /\.[cm]?tsx?$/.test(entry) ? dirname(dirname(entry)) : home
}

// ── what each OS gets ──────────────────────────────────────────────────────────────────────────

/** The command that serves the folder. `self` is how this CLI re-invokes itself (see selfCommand). */
export function serveArgv(self: string[], site: string, port: number, publicName?: string, liveSlug?: string): string[] {
  return [
    ...self, "pages", "serve-edge", site, "--port", String(port),
    ...(publicName ? ["--public-name", publicName] : []),
    // Never both: live forwards with the owner's session, and a public address is the internet.
    ...(liveSlug && !publicName ? ["--live", liveSlug] : []),
  ]
}

/** A tunnel name for a page: lowercase, the relay's alphabet, at most 63 characters. */
export function publicNameFor(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "page"
}

export const launchdLabel = (slug: string) => `io.heyiris.page.${slug}`
export const taskName = (slug: string) => `IRIS Page ${slug}`
export const systemdUnit = (slug: string) => `iris-page-${slug}.service`

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function launchdPlist(slug: string, argv: string[], logFile: string, cwd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(slug)}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`
}

/**
 * Windows: a console program started by a logon task opens a console window, and closing that
 * window stops the page. wscript running a one-line script with window style 0 starts it hidden.
 * Every argument is quoted for the command line ("" escapes a quote inside a VBScript string).
 */
export function windowsStartVbs(argv: string[], cwd: string): string {
  const cmdline = argv.map((a) => `"${a}"`).join(" ")
  const q = (x: string) => x.replace(/"/g, '""')
  // A logon task starts its program ONCE. Run waits (True) and the loop starts the server again if
  // it ever exits — Windows' equivalent of launchd KeepAlive / systemd Restart. `schtasks /End`
  // ends this script, and stopKeeping then ends the server by its port.
  return [
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.CurrentDirectory = "${q(cwd)}"`,
    `Do`,
    `  sh.Run "${q(cmdline)}", 0, True`,
    `  WScript.Sleep 3000`,
    `Loop`,
    ``,
  ].join("\r\n")
}

/** schtasks splits /TR on spaces — the script path is quoted INSIDE the value (#186663 lesson). */
export function schtasksCreate(slug: string, vbsPath: string): string[] {
  return ["/Create", "/TN", taskName(slug), "/TR", `wscript.exe "${vbsPath}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]
}

export function systemdService(slug: string, argv: string[], cwd: string): string {
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)
  return `[Unit]
Description=IRIS page ${slug} (iris pages serve)

[Service]
WorkingDirectory=${q(cwd)}
ExecStart=${argv.map(q).join(" ")}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`
}

// ── touching the machine ───────────────────────────────────────────────────────────────────────

export interface KeepResult {
  keeper: ServedState["keeper"]
  ok: boolean
  detail: string
  pid?: number
}

/**
 * Register the page to start at login AND start it now. Never throws: if the OS refuses, the page
 * is started as a plain background process and the caller says it will NOT come back after a
 * reboot — a page that will not return must never be reported as one that will.
 */
export function keepRunning(
  slug: string,
  site: string,
  port: number,
  opts: { autostart: boolean; home?: string; publicName?: string; liveSlug?: string } = { autostart: true },
): KeepResult {
  const home = opts.home ?? homedir()
  const dir = servedDir(slug, home)
  const argv = serveArgv(serviceSelf(), site, port, opts.publicName, opts.liveSlug)
  const cwd = serviceCwd(selfCommand(), home)
  const log = join(dir, "serve.log")
  const os = osPlatform()

  if (opts.autostart) {
    try {
      if (os === "darwin") {
        const agents = join(home, "Library", "LaunchAgents")
        mkdirSync(agents, { recursive: true })
        const plist = join(agents, `${launchdLabel(slug)}.plist`)
        writeFileSync(plist, launchdPlist(slug, argv, log, cwd))
        const domain = `gui/${process.getuid?.() ?? 501}`
        spawnSync("launchctl", ["bootout", `${domain}/${launchdLabel(slug)}`], { stdio: "ignore" })
        const r = spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "pipe" })
        if (r.status === 0) return { keeper: "launchd", ok: true, detail: plist }
        throw new Error((r.stderr?.toString() || "launchctl bootstrap failed").trim())
      }
      if (os === "win32") {
        const vbs = join(dir, "start.vbs")
        writeFileSync(vbs, windowsStartVbs(argv, cwd))
        execFileSync("schtasks", schtasksCreate(slug, vbs), { stdio: "ignore", timeout: 15000 })
        execFileSync("schtasks", ["/Run", "/TN", taskName(slug)], { stdio: "ignore", timeout: 15000 })
        return { keeper: "schtasks", ok: true, detail: `logon task "${taskName(slug)}"` }
      }
      if (os === "linux") {
        const units = join(home, ".config", "systemd", "user")
        mkdirSync(units, { recursive: true })
        writeFileSync(join(units, systemdUnit(slug)), systemdService(slug, argv, cwd))
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 15000 })
        execFileSync("systemctl", ["--user", "enable", "--now", systemdUnit(slug)], { stdio: "ignore", timeout: 15000 })
        execFileSync("systemctl", ["--user", "restart", systemdUnit(slug)], { stdio: "ignore", timeout: 15000 })
        return { keeper: "systemd", ok: true, detail: systemdUnit(slug) }
      }
    } catch (e: any) {
      const pid = startProcess(argv, log, cwd)
      return { keeper: "process", ok: false, pid, detail: String(e?.message ?? e).split("\n")[0] }
    }
  }
  const pid = startProcess(argv, log, cwd)
  return { keeper: "process", ok: !opts.autostart, pid, detail: "background process (until this computer restarts)" }
}

function startProcess(argv: string[], log: string, cwd: string): number | undefined {
  const fd = openSync(log, "a")
  const [bin, ...rest] = argv
  const child = spawn(bin!, rest, { cwd, detached: true, stdio: ["ignore", fd, fd], windowsHide: true })
  child.unref()
  return child.pid
}

/** Undo keepRunning, whichever way the page was kept. Best effort; reports what it removed. */
export function stopKeeping(s: ServedState, home = homedir()): string[] {
  const done: string[] = []
  const quiet = { stdio: "ignore" as const, timeout: 15000 }
  try {
    if (s.keeper === "launchd") {
      const plist = join(home, "Library", "LaunchAgents", `${launchdLabel(s.slug)}.plist`)
      spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${launchdLabel(s.slug)}`], { stdio: "ignore" })
      rmSync(plist, { force: true })
      done.push(`launchd agent ${launchdLabel(s.slug)}`)
    } else if (s.keeper === "schtasks") {
      try {
        execFileSync("schtasks", ["/End", "/TN", taskName(s.slug)], quiet)
      } catch {}
      execFileSync("schtasks", ["/Delete", "/TN", taskName(s.slug), "/F"], quiet)
      done.push(`logon task "${taskName(s.slug)}"`)
    } else if (s.keeper === "systemd") {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", systemdUnit(s.slug)], quiet)
      } catch {}
      rmSync(join(home, ".config", "systemd", "user", systemdUnit(s.slug)), { force: true })
      done.push(`systemd unit ${systemdUnit(s.slug)}`)
    }
  } catch {}
  if (s.pid) {
    try {
      process.kill(s.pid)
      done.push(`process ${s.pid}`)
    } catch {}
  }
  // Windows: the hidden server outlives `schtasks /End` (wscript exits at once). Find it by port.
  if (osPlatform() === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 10000 })
      const line = out.split(/\r?\n/).find((l) => l.includes(`127.0.0.1:${s.port} `) && /LISTENING/.test(l))
      const pid = line?.trim().split(/\s+/).pop()
      if (pid && /^\d+$/.test(pid)) {
        execFileSync("taskkill", ["/PID", pid, "/F"], quiet)
        done.push(`process ${pid}`)
      }
    } catch {}
  }
  return done
}

/** Is it answering? A HEAD-free GET of the page, short timeout. */
export async function answering(port: number, slug: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/p/${slug}`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}
