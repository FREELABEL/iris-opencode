import { cmd } from "./cmd"
import * as prompts from "./clack"
import { requireAuth, writeJson, dim, bold, success, warn, highlight } from "./iris-api"
import { startRelayTunnelBg, stopRelayTunnelBg } from "./platform-hive-tunnel"
import { runningPid, validTunnelName } from "./platform-hive-relay"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, hostname } from "os"
import { join } from "path"

/**
 * `iris hive phone on|off|status` — IRIS on the owner's iPhone reaches IRIS Desktop on this
 * machine (#194511, ADR-03 "Sign in with IRIS, choose a machine").
 *
 *   phone ──https──▶ <name>.t.heyiris.io (Hive relay) ──▶ the daemon's phone endpoint on 127.0.0.1:3291
 *         ──▶ IRIS Desktop's engine
 *
 * The daemon (iris-daemon#120, daemon/phone-endpoint.js) serves the endpoint while
 * ~/.iris/phone.json says `enabled: true`, and refuses every request without an hp1 token the
 * platform signed for this node. The platform (fl-iris-api#471) issues those tokens only when this
 * node's heartbeat says `phone.url` is https://<name>.t.heyiris.io and the owner holds `<name>`.
 *
 * Copied from `iris hive models serve on` (#191176, #192752): reserve the name, open the relay
 * tunnel to the local port, then record node path + tunnel in the settings file so the daemon's
 * tunnel-keepalive.js restarts it. `off` keeps the name, so `on` reuses it (and its certificate).
 */

export const DEFAULT_PHONE_PORT = 3291

export interface PhoneTunnel {
  name: string
  runner: string
  zones: string[]
}

/** ~/.iris/phone.json, the shape daemon/phone-endpoint.js `readSettings` and tunnel-keepalive.js read. */
export interface PhoneSettings {
  enabled: boolean
  port: number
  url: string | null
  /** The Node (≥ 20) the tunnel was started with. */
  node?: string | null
  /** Written only once `on` opened the tunnel. Kept by `off` (enabled false stops the keep-alive). */
  tunnel?: PhoneTunnel | null
}

export const phoneSettingsPath = (home = homedir()) => join(home, ".iris", "phone.json")

/** Read the way the daemon reads it: missing or unreadable is off, a bad port is 3291, a non-https URL is none. */
export function readPhoneSettings(home = homedir()): PhoneSettings {
  const d: PhoneSettings = { enabled: false, port: DEFAULT_PHONE_PORT, url: null }
  try {
    const raw = JSON.parse(readFileSync(phoneSettingsPath(home), "utf8"))
    const s: PhoneSettings = { ...d, ...raw }
    s.enabled = raw.enabled === true
    s.port = validPhonePort(s.port) ? s.port : DEFAULT_PHONE_PORT
    s.url = typeof s.url === "string" && /^https:\/\//.test(s.url) ? s.url.replace(/\/+$/, "") : null
    return s
  } catch {
    return d
  }
}

export function writePhoneSettings(s: PhoneSettings, home = homedir()) {
  mkdirSync(join(home, ".iris"), { recursive: true, mode: 0o700 })
  writeFileSync(phoneSettingsPath(home), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
}

/** The range the daemon accepts; anything else it silently replaces with 3291. */
export function validPhonePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) > 1024 && (port as number) < 65536
}

/** This machine's phone tunnel name: `<node name>-phone`, made into a valid relay label. */
export function phoneTunnelName(nodeName: string): string {
  const base = String(nodeName || "")
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "")
  return `${base || "hive"}-phone`
}

/** The name `on` uses: --name, else the one this machine already holds for its phone, else derived. */
export function chooseTunnelName(o: { flag?: string; settings: PhoneSettings; nodeName: string }): string {
  if (o.flag) return String(o.flag).toLowerCase()
  if (o.settings.tunnel?.name) return o.settings.tunnel.name
  return phoneTunnelName(o.nodeName)
}

/** "Allow access to this computer" (IRIS Desktop → Settings → Hive). Absent or unreadable = on, as the daemon reads it. */
export function remoteAccessAllowed(home = homedir()): boolean {
  let raw: string
  try {
    raw = readFileSync(join(home, ".iris", "remote-access.json"), "utf8")
  } catch {
    return true
  }
  try {
    return JSON.parse(raw).allow !== false
  } catch {
    return true
  }
}

const pidAlive = (pid: unknown): boolean => {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

/** Whether IRIS Desktop's engine is up here: ~/.iris/desktop-engine.json with a port, a password and a live pid. */
export function desktopEngineRunning(home = homedir(), alive: (pid: unknown) => boolean = pidAlive): boolean {
  let data: any
  try {
    data = JSON.parse(readFileSync(join(home, ".iris", "desktop-engine.json"), "utf8"))
  } catch {
    return false
  }
  return (Array.isArray(data) ? data : [data]).some(
    (e) => e && Number(e.port) > 0 && typeof e.password === "string" && e.password && (e.pid === undefined || alive(e.pid)),
  )
}

/** Why `on` must not go ahead, or null. Remote access first: it is the owner's own switch. */
export function phoneOnRefusal(o: { remoteAccess: boolean; daemonRunning: boolean }): string | null {
  if (!o.remoteAccess)
    return 'Remote access to this computer is off (IRIS Desktop → Settings → Hive → "Allow access to this computer"). Turn it on there first.'
  if (!o.daemonRunning) return "The IRIS daemon is not running on this machine, so nothing would answer the phone. Start it: iris-daemon start"
  return null
}

/** Step 1 of `on`: the endpoint on, no tunnel record yet, so the daemon cannot start a second copy meanwhile. */
export function settingsForOn(prev: PhoneSettings, port: number): PhoneSettings {
  return { ...prev, enabled: true, port, tunnel: null }
}

/** Step 2 of `on`, once the tunnel is open: what the daemon reports and restarts from. */
export function settingsAfterTunnel(prev: PhoneSettings, t: { url: string; node: string; name: string; runner: string; zones: string[] }): PhoneSettings {
  return { ...prev, enabled: true, url: t.url, node: t.node, tunnel: { name: t.name, runner: t.runner, zones: t.zones } }
}

/** `off`: the switch off (the daemon stops serving and stops restarting), the name and URL kept for the next `on`. */
export function settingsForOff(prev: PhoneSettings): PhoneSettings {
  return { ...prev, enabled: false }
}

const daemonBase = () => `http://127.0.0.1:${process.env.A2A_PORT || "3200"}`

async function getJson(url: string, ms = 2000): Promise<{ ok: boolean; json: any }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return { ok: res.ok, json: await res.json().catch(() => null) }
  } catch {
    return { ok: false, json: null }
  }
}

/** The running daemon, from its /health (or a live ~/.iris/daemon.pid when /health is not reachable). */
async function localDaemon(home = homedir()): Promise<{ running: boolean; nodeName: string | null }> {
  for (const p of ["/health", "/daemon/health"]) {
    const r = await getJson(daemonBase() + p)
    if (r.ok) return { running: true, nodeName: r.json?.daemon?.node_name || r.json?.node_name || null }
  }
  let pid: string | null = null
  try {
    pid = readFileSync(join(home, ".iris", "daemon.pid"), "utf8").trim()
  } catch {}
  return { running: !!pid && pidAlive(pid), nodeName: null }
}

/** Whether the daemon's phone endpoint answers on this port right now. */
async function endpointServing(port: number): Promise<boolean> {
  const r = await getJson(`http://127.0.0.1:${port}/__iris/healthz`)
  return r.ok && r.json?.ok === true
}

const machineName = (daemonName: string | null) => daemonName || process.env.NODE_NAME || hostname().replace(/\.local$/, "")

async function phoneStatus(home = homedir()) {
  const s = readPhoneSettings(home)
  const daemon = await localDaemon(home)
  const name = s.tunnel?.name ?? null
  return {
    enabled: s.enabled,
    port: s.port,
    url: s.url,
    tunnel_name: name,
    tunnel_running: !!(name && runningPid(home, name)),
    daemon_running: daemon.running,
    serving: s.enabled ? await endpointServing(s.port) : false,
    desktop_running: desktopEngineRunning(home),
    remote_access: remoteAccessAllowed(home),
    machine: machineName(daemon.nodeName),
    settings: phoneSettingsPath(home),
  }
}

export const HivePhoneCommand = cmd({
  command: "phone [state]",
  describe: "let IRIS on your iPhone reach IRIS Desktop on this machine — on, off, status",
  builder: (yargs) =>
    yargs
      .positional("state", { type: "string", choices: ["on", "off", "status"], default: "status" })
      .option("port", { type: "number", describe: "local port for the daemon's phone endpoint", default: DEFAULT_PHONE_PORT })
      .option("name", { type: "string", describe: "tunnel name (default: the one this machine holds, else <this machine>-phone)" })
      .option("yes", { type: "boolean", default: false, describe: "do not ask before turning it on" })
      .option("json", { type: "boolean", default: false })
      .example("$0 hive phone on", "IRIS on your iPhone can reach this machine while IRIS Desktop is open")
      .example("$0 hive phone status", "is it on, at which URL, and is the daemon serving it")
      .example("$0 hive phone off", "stop; the name is kept for next time"),
  async handler(argv) {
    const home = homedir()
    const json = argv.json === true
    const fail = async (message: string, extra: Record<string, unknown> = {}) => {
      process.exitCode = 1
      if (json) return void (await writeJson({ ok: false, error: message, ...extra }))
      console.log(`\n${highlight("✗")} ${message}`)
    }

    if (argv.state === "status") {
      const st = await phoneStatus(home)
      if (json) return void (await writeJson(st))
      console.log()
      console.log(`  ${st.enabled ? success("● on") : dim("○ off")}${st.url ? `  ${bold(st.url)}` : ""}  ${dim(st.settings)}`)
      const row = (label: string, ok: boolean, text: string) => console.log(`    ${dim(label.padEnd(16))} ${ok ? success(text) : text}`)
      row("daemon", st.daemon_running, st.daemon_running ? "running" : "NOT running (start: iris-daemon start)")
      if (st.enabled) {
        row("endpoint", st.serving, st.serving ? `serving on 127.0.0.1:${st.port}` : `not answering on 127.0.0.1:${st.port} (the daemon picks up a change within 15 s; an older daemon has no phone endpoint: iris daemon update)`)
        row("tunnel", st.tunnel_running, st.tunnel_name ? (st.tunnel_running ? `${st.tunnel_name} open` : `${st.tunnel_name} not running (the daemon restarts it; or: iris hive phone on)`) : "none yet (iris hive phone on)")
      }
      row("IRIS Desktop", st.desktop_running, st.desktop_running ? "open" : "not open — the phone reaches this machine only while IRIS Desktop is open")
      if (!st.remote_access) console.log(warn('    ! "Allow access to this computer" is off — the phone is refused until it is on (IRIS Desktop → Settings → Hive)'))
      console.log(dim(st.enabled ? "\n  Stop: iris hive phone off" : "\n  Start: iris hive phone on"))
      return
    }

    const s = readPhoneSettings(home)

    if (argv.state === "off") {
      // Off first: the daemon must never restart what the owner just stopped. The name stays.
      writePhoneSettings(settingsForOff(s), home)
      const name = s.tunnel?.name
      const closed = name ? stopRelayTunnelBg(name) : false
      if (json) return void (await writeJson({ ok: true, enabled: false, tunnel_name: name ?? null, tunnel_closed: closed }))
      console.log(`\n${success("✓")} IRIS on your iPhone can no longer reach this machine${closed ? dim(` — tunnel ${name} closed`) : ""}`)
      console.log(dim("  Your phone stops seeing it on the next heartbeat (within a minute). Turn it back on: iris hive phone on"))
      return
    }

    const port = Number(argv.port)
    if (!validPhonePort(port)) return fail(`--port must be a whole number from 1025 to 65535, not "${argv.port}"`)
    const daemon = await localDaemon(home)
    const refused = phoneOnRefusal({ remoteAccess: remoteAccessAllowed(home), daemonRunning: daemon.running })
    if (refused) return fail(refused)
    if (!(await requireAuth())) return
    const machine = machineName(daemon.nodeName)
    const name = chooseTunnelName({ flag: argv.name as string | undefined, settings: s, nodeName: machine })
    if (!validTunnelName(name)) return fail(`"${name}" is not a valid tunnel name — pass one with --name`)

    if (!argv.yes) {
      if (json) return fail("pass --yes with --json: turning phone access on asks first")
      console.log()
      console.log(`${highlight("!")} ${bold(`IRIS on your iPhone will be able to reach ${machine}`)} through a public Hive relay URL.`)
      console.log(dim("  It answers only requests carrying a token IRIS issued to YOUR account for this machine."))
      console.log(dim("  Through it, your phone can do what IRIS Desktop on this machine can do, while Desktop is open."))
      const ok = await prompts.confirm({ message: "Turn it on?", initialValue: true })
      if (ok !== true) return void console.log(dim("\n  Not started."))
    }

    // The endpoint first, so the tunnel's own reachability check finds something listening.
    writePhoneSettings(settingsForOn(s, port), home)
    const t = await startRelayTunnelBg(name, port)
    if (!t.ok) {
      // Back to how it was: off, with the name it held, so a retry reuses it.
      writePhoneSettings({ ...s, enabled: false }, home)
      return fail(`the tunnel did not open: ${t.error}`, { tunnel_name: name })
    }
    const next = settingsAfterTunnel(readPhoneSettings(home), { ...t, name })
    writePhoneSettings(next, home)
    const desktop = desktopEngineRunning(home)
    if (json) return void (await writeJson({ ok: true, enabled: true, port, url: t.url, tunnel_name: name, already: t.already, machine, desktop_running: desktop }))
    console.log(`\n${success("●")} IRIS on your iPhone can now reach ${bold(machine)} while IRIS Desktop is open`)
    console.log(dim(`  ${t.url}${t.already ? " (tunnel was already open)" : ""} → the daemon's phone endpoint on 127.0.0.1:${port}`))
    console.log(dim(`  The daemon picks this up within 15 s, tells IRIS on its next heartbeat, and restarts the tunnel with ${t.node} if it stops.`))
    if (!desktop) console.log(warn("  ! IRIS Desktop is not open on this machine. Open it, then choose this machine in IRIS on your iPhone."))
    else console.log(dim("  Next: open IRIS on your iPhone, sign in, and choose this machine."))
    console.log(dim("  Check: iris hive phone status   ·   stop: iris hive phone off"))
  },
})
