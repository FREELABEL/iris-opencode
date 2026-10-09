import { cmd } from "./cmd"
import { bold, dim, highlight, success, warn, resolveToken } from "./iris-api"
import { spawn, spawnSync } from "child_process"
import * as prompts from "./clack"
import { homedir, hostname } from "os"
import { join } from "path"
import { mkdirSync, openSync, writeFileSync, rmSync } from "fs"
import { hiveFetch } from "./platform-hive-nodes"
import { probeLocal, runThirdPartyTunnel } from "./tunnel"
import {
  RELAY_ZONE,
  defaultTunnelName,
  validTunnelName,
  parseRunnerLine,
  findRunner,
  findNode,
  runningPid,
  explainTunnelApiError,
} from "./platform-hive-relay"

/**
 * `iris hive tunnel <port>` — a public URL for something running on this machine (#188585).
 *
 * TWO PROVIDERS. The default, `hive`, is ours: https://<name>.t.heyiris.io through the Hive relay
 * on iris-hive-001, which routes by hostname and never holds the certificate (this machine gets
 * its own, through the relay — see platform-hive-relay.ts). `--provider tailscale` is the Funnel
 * path described below, kept for machines already set up for it.
 *
 * The ask: opentunnel (dax, 2026-10-07) — "public urls for anything running on your machine;
 * e2e encrypted, the relay can't see it". Built into Hive rather than waiting on opencode
 * upstream, because many Hive machines run the raw IRIS CLI and there is no upstream-merge
 * process for this fork.
 *
 * It does not write a relay. Tailscale Funnel already is one: the public hostname is the
 * machine's own *.ts.net name, TLS terminates ON this machine with its own certificate, and the
 * relay forwards encrypted bytes it cannot read. Every Hive node already runs Tailscale.
 *
 * `iris hive vpn serve` says "funnel would publish to the public internet — do not". That was the
 * right default for serve, and it stays. This is the deliberate, separate door, so it is shaped
 * around the risk:
 *   - FOREGROUND by default: the URL exists while this command runs. Ctrl-C closes it.
 *   - `--for 30m` closes it on a timer. `--bg` keeps it open past the command — and says so.
 *   - The Hive bridge port is refused outright: it executes commands for whoever holds its key.
 *   - An explicit yes, naming the port and "anyone on the internet", before anything opens.
 *   - Port 8443 by default, so it never replaces a tailnet-only `serve` mapping on 443.
 */

export const FUNNEL_PORTS = [443, 8443, 10000]
export const DEFAULT_PUBLIC_PORT = 8443
const DEFAULT_FOR = "1h"

/** Ports that must never be public, with the reason. */
export function refusedPort(port: number, env: Record<string, string | undefined> = process.env): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `${port} is not a port`
  const bridge = new Set([3200, Number(env.BRIDGE_PORT || 0), Number(env.A2A_PORT || 0)].filter(Boolean))
  if (bridge.has(port)) return `port ${port} is the Hive bridge — it runs commands for whoever holds its key. It is never published.`
  return null
}

export function parseFor(s: string | undefined): number | null {
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(String(s ?? "").trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || "m").toLowerCase()
  const ms = n * (unit === "h" ? 3_600_000 : unit === "s" ? 1000 : 60_000)
  return ms > 0 && ms <= 24 * 3_600_000 ? ms : null
}

export function funnelArgs(localPort: number, publicPort: number, bg: boolean): string[] {
  return ["funnel", ...(bg ? ["--bg"] : []), `--https=${publicPort}`, String(localPort)]
}

/** What a funnel failure means, in words that say what to do. */
export function explainFunnelError(stderr: string): string | null {
  const e = String(stderr || "")
  if (/funnel.*(not (enabled|allowed)|requires)|nodeAttr|attribute/i.test(e))
    return "Funnel is not allowed for this machine. In the Tailscale admin console → Access controls, add the `funnel` node attribute for it (Tailscale's own prompt in the error above links to the exact page)."
  if (/HTTPS|cert/i.test(e)) return "HTTPS certificates are off for this tailnet: Tailscale admin → DNS → enable MagicDNS, then HTTPS Certificates."
  if (/not.*logged|NeedsLogin/i.test(e)) return "This machine is not on the tailnet yet — run: iris hive vpn up"
  return null
}

function tailscale(): string | null {
  for (const b of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const r = spawnSync(b, ["version"], { stdio: "ignore" })
    if (r.status === 0) return b
  }
  return null
}

function selfInfo(ts: string): { dns: string | null; certs: boolean } {
  const r = spawnSync(ts, ["status", "--json"], { encoding: "utf8", timeout: 10_000 })
  try {
    const st = JSON.parse(r.stdout)
    return { dns: String(st?.Self?.DNSName || "").replace(/\.$/, "") || null, certs: Array.isArray(st?.CertDomains) && st.CertDomains.length > 0 }
  } catch {
    return { dns: null, certs: false }
  }
}

export const HiveTunnelCommand = cmd({
  command: "tunnel [port]",
  describe: "a PUBLIC https URL for a local port — encrypted to this machine, closes when you stop",
  builder: (y) =>
    y
      .positional("port", { describe: "local port to publish, e.g. 3000", type: "number" })
      .option("provider", { describe: "hive (ours: <name>.t.heyiris.io) · tailscale (Funnel) · ngrok · cloudflared", type: "string", choices: ["hive", "tailscale", "ngrok", "cloudflared"], default: "hive" })
      .option("allow-iris-server", { describe: "allow publishing an IRIS engine server (it has no auth)", type: "boolean", default: false })
      .option("name", { describe: `hive: the name in https://<name>.${RELAY_ZONE} (default: this machine + port)`, type: "string" })
      .option("list", { describe: "hive: the tunnel names you hold, and which are running", type: "boolean", default: false })
      .option("release", { describe: "hive: give a name back so someone else can use it", type: "string" })
      .option("staging", { describe: "hive: test certificates (not trusted by browsers)", type: "boolean", default: false, hidden: true })
      .option("for", { describe: `close automatically after this long, e.g. 30m, 2h (default ${DEFAULT_FOR})`, type: "string", default: DEFAULT_FOR })
      .option("public-port", { describe: `public https port: ${FUNNEL_PORTS.join(", ")}`, type: "number", default: DEFAULT_PUBLIC_PORT })
      .option("bg", { describe: "keep it open after this command exits (close with --off)", type: "boolean", default: false })
      .option("off", { describe: "close a tunnel opened with --bg (hive: with --name, or the port's default name)", type: "boolean", default: false })
      .option("yes", { describe: "skip the confirmation", type: "boolean", default: false })
      .example("iris hive tunnel 3000", `https://<this-machine>-3000.${RELAY_ZONE} until Ctrl-C (1 h max by default)`)
      .example("iris hive tunnel 3000 --name demo --for 2h", `https://demo.${RELAY_ZONE} for two hours`)
      .example("iris hive tunnel 3000 --name demo --bg", "keep it open in the background; close with --off --name demo")
      .example("iris hive tunnel --list", "the names you hold")
      .example("iris hive tunnel 3000 --provider tailscale", "the same, through Tailscale Funnel instead")
      .example("iris hive tunnel 3000 --provider cloudflared", "or through a third party: ngrok / cloudflared"),
  async handler(argv) {
    if (argv.provider === "ngrok" || argv.provider === "cloudflared") {
      const ms = parseFor(argv.for as string)
      return runThirdPartyTunnel({ port: Number(argv.port), provider: String(argv.provider), ttl: ms ? Math.ceil(ms / 60000) : undefined, "allow-iris-server": argv["allow-iris-server"] as boolean })
    }
    if (argv.provider !== "tailscale") return runHive(argv)
    if (argv.port === undefined) {
      console.log(`\n${highlight("✗")} which local port? e.g. iris hive tunnel 3000 --provider tailscale`)
      process.exitCode = 1
      return
    }
    const port = Number(argv.port)
    const publicPort = Number(argv["public-port"])
    const fail = (m: string) => {
      console.log()
      console.log(`${highlight("✗")} ${m}`)
      process.exitCode = 1
    }
    const ts = tailscale()
    if (!ts) return fail(`Tailscale is not installed — run ${bold("iris hive vpn install")}`)
    if (!FUNNEL_PORTS.includes(publicPort)) return fail(`--public-port must be one of ${FUNNEL_PORTS.join(", ")} (Funnel's allowed ports)`)

    if (argv.off) {
      const r = spawnSync(ts, ["funnel", `--https=${publicPort}`, "off"], { encoding: "utf8", timeout: 20_000 })
      if (r.status !== 0) return fail((r.stderr || "").trim() || "could not close it")
      console.log(`\n${success("✓")} public tunnel on :${publicPort} closed`)
      return
    }

    const refused = refusedPort(port)
    if (refused) return fail(refused)
    const ms = parseFor(argv.for as string)
    if (!ms) return fail(`--for must look like 30m, 2h or 90s (max 24h), not "${argv.for}"`)

    const me = selfInfo(ts)
    if (!me.certs) return fail(explainFunnelError("HTTPS cert")!)
    const url = me.dns ? `https://${me.dns}${publicPort === 443 ? "" : `:${publicPort}`}` : "(this machine's ts.net name)"

    if (!argv.yes) {
      console.log()
      console.log(`${highlight("!")} ${bold(`localhost:${port} will be reachable by ANYONE on the internet`)} at ${url}`)
      console.log(dim(`  for ${argv.bg ? "as long as you leave it (--bg)" : argv.for}. Traffic is encrypted to this machine; the relay cannot read it.`))
      const ok = await prompts.confirm({ message: "Open it?", initialValue: false })
      if (ok !== true) return fail("Not opened.")
    }

    if (argv.bg) {
      const r = spawnSync(ts, funnelArgs(port, publicPort, true), { encoding: "utf8", timeout: 30_000 })
      if (r.status !== 0) {
        const err = (r.stderr || "").trim()
        return fail(`${err || "tailscale funnel did not respond"}${explainFunnelError(err) ? `\n  ${explainFunnelError(err)}` : ""}`)
      }
      console.log(`\n${success("✓")} ${bold(url)} → localhost:${port}`)
      console.log(dim(`  OPEN until you close it:  iris hive tunnel ${port} --off --public-port ${publicPort}`))
      return
    }

    // Foreground: the tunnel is the child process. It ends when we end — Ctrl-C, timer, or exit.
    const child = spawn(ts, funnelArgs(port, publicPort, false), { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (d) => { stderr += String(d) })
    child.stdout.on("data", () => {})
    const close = (why: string) => {
      if (child.exitCode === null) child.kill("SIGINT")
      console.log(`\n${success("✓")} tunnel closed (${why}) — ${url} no longer answers`)
    }
    const exited: Promise<number> = new Promise((r) => child.on("exit", (c) => r(c ?? 0)))
    // Announce the URL only once the tunnel has survived a moment: a funnel that is refused exits
    // at once, and printing "● live" before the refusal is a green light over a closed door.
    const early = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 2500))])
    if (early !== null) {
      const err = stderr.trim()
      return fail(`${err.split("\n").slice(-3).join("\n  ") || "tailscale funnel exited"}${explainFunnelError(err) ? `\n  ${explainFunnelError(err)}` : ""}`)
    }
    const timer = setTimeout(() => close(`after ${argv.for}`), ms)
    process.once("SIGINT", () => { clearTimeout(timer); close("Ctrl-C") })
    console.log(`\n${success("●")} ${bold(url)} → localhost:${port}`)
    console.log(dim(`  public for ${argv.for} or until Ctrl-C`))
    const code = await exited
    clearTimeout(timer)
    if (code !== 0 && stderr.trim()) {
      const err = stderr.trim()
      return fail(`${err.split("\n").slice(-3).join("\n  ")}${explainFunnelError(err) ? `\n  ${explainFunnelError(err)}` : ""}`)
    }
  },
})

// ─── provider: hive ─────────────────────────────────────────────────────────────────────────────

async function runHive(argv: any) {
  const home = homedir()
  const fail = (m: string) => {
    console.log()
    console.log(`${highlight("✗")} ${m}`)
    process.exitCode = 1
  }
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await hiveFetch(`/api/v6/nodes/tunnels${path}`, { method, body: body ? JSON.stringify(body) : undefined })
    const json: any = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, json }
  }
  if (!(await resolveToken())) return fail("Sign in to IRIS first: iris auth login")

  if (argv.list) {
    const r = await api("GET", "")
    if (!r.ok) return fail(explainTunnelApiError(r.status, r.json))
    const rows: any[] = r.json?.data || []
    console.log()
    if (!rows.length) return console.log(dim(`  No tunnel names yet. Open one: iris hive tunnel 3000`))
    for (const t of rows) {
      const pid = runningPid(home, t.name)
      console.log(`  ${pid ? success("●") : dim("○")} ${bold(t.url)}${pid ? dim(`  running in the background (pid ${pid})`) : ""}`)
    }
    return
  }

  if (argv.release) {
    const name = String(argv.release).toLowerCase()
    const r = await api("DELETE", `/${encodeURIComponent(name)}`)
    if (!r.ok) return fail(explainTunnelApiError(r.status, r.json))
    rmSync(join(home, ".iris", "tunnels", name), { recursive: true, force: true })
    console.log(`\n${success("✓")} released ${bold(name)} — its certificate and key on this machine are deleted`)
    return
  }

  const port = Number(argv.port)
  const name = String(argv.name || (Number.isFinite(port) && port > 0 ? defaultTunnelName(hostname(), port) : "")).toLowerCase()

  if (argv.off) {
    if (!name) return fail("which tunnel? iris hive tunnel --off --name <name>")
    const pid = runningPid(home, name)
    if (!pid) return fail(`no background tunnel named ${name} is running here`)
    process.kill(pid, "SIGTERM")
    rmSync(join(home, ".iris", "tunnels", name, "tunnel.pid"), { force: true })
    console.log(`\n${success("✓")} closed — https://${name}.${RELAY_ZONE} no longer answers`)
    return
  }

  if (argv.port === undefined) return fail("which local port? e.g. iris hive tunnel 3000")
  const refused = refusedPort(port)
  if (refused) return fail(refused)
  if (!validTunnelName(name)) return fail("--name is 1–63 lowercase letters, digits and dashes (not starting or ending with a dash)")
  const ms = parseFor(argv.for as string)
  if (!ms) return fail(`--for must look like 30m, 2h or 90s (max 24h), not "${argv.for}"`)
  if (runningPid(home, name)) return fail(`${name} is already open in the background — close it first: iris hive tunnel --off --name ${name}`)
  // From `iris tunnel` (#188653): say "nothing is running there" now, not after a public URL that
  // answers 502 — and never publish an IRIS engine server, which has no authentication.
  const local = await probeLocal(port)
  if (!local.listening) return fail(`nothing is listening on localhost:${port} — start it first`)
  if (local.irisEngine && !argv["allow-iris-server"])
    return fail(`localhost:${port} is an IRIS engine server. It has no authentication — a public URL lets anyone run agents and shell commands here. Refusing (override: --allow-iris-server).`)

  const runner = findRunner(home)
  if (!runner) return fail("This machine's Hive bridge predates Hive tunnels. Update it: iris bridge install")
  const node = findNode(home)
  if (!node) return fail("Hive tunnels need Node.js 18 or newer on this machine (the Hive bridge uses it too): https://nodejs.org")

  // Reserve the name BEFORE asking for a yes, so "taken" or "reserved" is said now, not after.
  const claim = await api("POST", "", { name })
  if (!claim.ok) return fail(explainTunnelApiError(claim.status, claim.json))
  const url = String(claim.json?.data?.url || `https://${name}.${RELAY_ZONE}`)

  if (!argv.yes) {
    console.log()
    console.log(`${highlight("!")} ${bold(`localhost:${port} will be reachable by ANYONE on the internet`)} at ${url}`)
    console.log(dim(`  for ${argv.bg ? "as long as you leave it (--bg)" : argv.for}. Encrypted to this machine — the relay cannot read it.`))
    const ok = await prompts.confirm({ message: "Open it?", initialValue: false })
    if (ok !== true) return fail("Not opened.")
  }

  const env = { ...process.env, IRIS_API_BASE: process.env.IRIS_API_URL ?? "https://freelabel.net", IRIS_API_KEY: await resolveToken() }
  const args = [runner, "--name", name, "--port", String(port), ...(argv.staging ? ["--staging"] : [])]
  const dir = join(home, ".iris", "tunnels", name + (argv.staging ? ".staging" : ""))

  if (argv.bg) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const log = openSync(join(dir, "tunnel.log"), "a", 0o600)
    const child = spawn(node, args, { env, detached: true, stdio: ["ignore", log, log] })
    child.unref()
    writeFileSync(join(home, ".iris", "tunnels", name, "tunnel.pid"), String(child.pid), { mode: 0o600 })
    console.log(`\n${success("●")} ${bold(url)} → localhost:${port}`)
    console.log(dim(`  OPEN until you close it:  iris hive tunnel --off --name ${name}`))
    console.log(dim(`  first time for this name? its certificate takes ~30 s — log: ${join(dir, "tunnel.log")}`))
    return
  }

  const child = spawn(node, ["--no-warnings", ...args, "--for-ms", String(ms)], { env, stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (d) => { stderr += String(d) })
  let announced = false
  let buf = ""
  const announce = () => {
    if (announced) return
    announced = true
    console.log(`\n${success("●")} ${bold(url)} → localhost:${port}`)
    console.log(dim(`  public for ${argv.for} or until Ctrl-C`))
  }
  child.stdout.on("data", (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const ev = parseRunnerLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (!ev) continue
      if (ev.event === "ready" && ev.certificate === "saved") announce()
      else if (ev.event === "ready" && ev.certificate === "requesting") console.log(dim(`\n  getting a certificate for ${url} — first time for this name, about 30 s…`))
      else if (ev.event === "cert") announce()
      else if (ev.event === "down") console.log(warn("  ◌ relay connection dropped — reconnecting…"))
      else if (ev.event === "error" && ev.final) console.log(`\n${highlight("✗")} ${ev.message}`)
      else if (ev.event === "error") console.log(warn(`  ! ${ev.message}${ev.retryInMinutes ? ` — retrying in ${ev.retryInMinutes} min` : ""}`))
    }
  })
  process.once("SIGINT", () => child.kill("SIGINT"))
  const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? 0)))
  if (code !== 0) {
    process.exitCode = 1
    if (stderr.trim()) console.log(dim(stderr.trim().split("\n").slice(-3).join("\n")))
    return
  }
  console.log(`\n${success("✓")} tunnel closed — ${url} no longer answers`)
}
