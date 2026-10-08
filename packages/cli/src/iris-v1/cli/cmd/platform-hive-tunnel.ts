import { cmd } from "./cmd"
import { bold, dim, highlight, success } from "./iris-api"
import { spawn, spawnSync } from "child_process"
import * as prompts from "./clack"

/**
 * `iris hive tunnel <port>` — a public URL for something running on this machine (#188585).
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
  command: "tunnel <port>",
  describe: "a PUBLIC https URL for a local port — encrypted to this machine, closes when you stop",
  builder: (y) =>
    y
      .positional("port", { describe: "local port to publish, e.g. 3000", type: "number", demandOption: true })
      .option("for", { describe: `close automatically after this long, e.g. 30m, 2h (default ${DEFAULT_FOR})`, type: "string", default: DEFAULT_FOR })
      .option("public-port", { describe: `public https port: ${FUNNEL_PORTS.join(", ")}`, type: "number", default: DEFAULT_PUBLIC_PORT })
      .option("bg", { describe: "keep it open after this command exits (close with --off)", type: "boolean", default: false })
      .option("off", { describe: "close a tunnel opened with --bg", type: "boolean", default: false })
      .option("yes", { describe: "skip the confirmation", type: "boolean", default: false }),
  async handler(argv) {
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
