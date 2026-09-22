import { cmd } from "./cmd"
import { dim, bold, success, highlight } from "./iris-api"
import { spawn, spawnSync, type ChildProcess } from "child_process"

// ============================================================================
// iris tunnel <port>  —  a PUBLIC url for a local dev server, in one command (#186512)
//
// `iris hive vpn serve` publishes a port to your own tailnet. This is the other
// door: anyone on the internet, for as long as the command runs. That is what you
// want for "show the client the dev build on their phone" and nothing longer.
//
// Mechanism was decided by a spike, not a discussion (2026-09-22): a Bun server with
// HTTP + SSE + a websocket echo, tunnelled, then probed over the public URL. ngrok
// passed all three. cloudflared quick tunnels carry websockets too and need no
// account, so they are the fallback. Tailscale Funnel was ruled out for the default:
// it needs admin-console changes (HTTPS certs + a funnel ACL) before it works at all.
//
// Lifetime: the tunnel IS this process. Ctrl-C, --ttl, or the provider dying tears it
// down, and the URL stops answering. Nothing is left running in the background.
// ============================================================================

export type Provider = "ngrok" | "cloudflared"

const INSTALL: Record<Provider, string> = {
  ngrok: "brew install ngrok && ngrok config add-authtoken <token>   (free account at ngrok.com)",
  cloudflared: "brew install cloudflared   (no account needed)",
}

export type LineResult = { url?: string; error?: string }

// ngrok with `--log stdout --log-format json` writes one JSON object per line. The
// public URL arrives on the "started tunnel" record; failures (auth token missing,
// session limit, bad port) arrive as lvl eror/crit with an `err` field.
export function parseNgrokLine(line: string): LineResult {
  let rec: Record<string, unknown>
  try {
    rec = JSON.parse(line)
  } catch {
    return {}
  }
  if (rec.msg === "started tunnel" && typeof rec.url === "string" && rec.url.startsWith("https://")) {
    return { url: rec.url }
  }
  const lvl = String(rec.lvl ?? "")
  const err = typeof rec.err === "string" ? rec.err : ""
  if ((lvl === "eror" || lvl === "crit") && err && err !== "<nil>") return { error: err }
  return {}
}

// cloudflared prints the quick-tunnel URL inside a banner on stderr, among many other
// URLs (its own docs, the TOS). Only the trycloudflare.com host is the tunnel.
export function parseCloudflaredLine(line: string): LineResult {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  if (m) return { url: m[0] }
  if (/\bERR\b/.test(line) && /failed to (request|unmarshal)|quick tunnel/i.test(line)) return { error: line.trim() }
  return {}
}

// `iris serve` / the desktop sidecar answer /global/health with {healthy:true,...} and,
// on the CLI lineage, have NO auth: publishing one hands the internet an agent that can
// run shell commands on this machine. Recognise that shape and refuse it by default.
export function looksLikeIrisEngine(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { healthy?: unknown }).healthy === true
}

export function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" })
  return r.status === 0 && r.stdout.trim().length > 0
}

export function pickProvider(requested: string, has: (bin: string) => boolean = onPath): Provider | null {
  if (requested === "ngrok" || requested === "cloudflared") return has(requested) ? requested : null
  if (has("ngrok")) return "ngrok"
  if (has("cloudflared")) return "cloudflared"
  return null
}

function launch(provider: Provider, port: number): ChildProcess {
  const target = `http://localhost:${port}`
  if (provider === "ngrok") {
    return spawn("ngrok", ["http", String(port), "--log", "stdout", "--log-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  return spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", target], { stdio: ["ignore", "pipe", "pipe"] })
}

// Resolve with the public URL, or reject with the provider's own words. Reads both
// streams — ngrok logs to stdout, cloudflared to stderr — line by line.
function waitForUrl(child: ChildProcess, provider: Provider, timeoutMs: number): Promise<string> {
  const parse = provider === "ngrok" ? parseNgrokLine : parseCloudflaredLine
  return new Promise((resolve, reject) => {
    let settled = false
    const tail: string[] = []
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () => done(() => reject(new Error(`no public URL from ${provider} within ${timeoutMs / 1000}s\n${tail.join("\n")}`))),
      timeoutMs,
    )
    const feed = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue
        tail.push(line.slice(0, 300))
        if (tail.length > 8) tail.shift()
        const r = parse(line)
        if (r.url) return done(() => resolve(r.url!))
        if (r.error) return done(() => reject(new Error(r.error)))
      }
    }
    child.stdout?.on("data", feed)
    child.stderr?.on("data", feed)
    child.on("error", (e) => done(() => reject(e)))
    child.on("exit", (code) =>
      done(() => reject(new Error(`${provider} exited (code ${code}) before a URL appeared\n${tail.join("\n")}`))),
    )
  })
}

async function probeLocal(port: number): Promise<{ listening: boolean; irisEngine: boolean }> {
  try {
    const r = await fetch(`http://localhost:${port}/global/health`, { signal: AbortSignal.timeout(2000) })
    let body: unknown = null
    try {
      body = await r.json()
    } catch {}
    return { listening: true, irisEngine: looksLikeIrisEngine(body) }
  } catch (e) {
    // A timeout still means something accepted the connection; refused means nothing is there.
    const msg = String((e as Error)?.message ?? e)
    return { listening: /timed? ?out|abort/i.test(msg), irisEngine: false }
  }
}

export const TunnelCommand = cmd({
  command: "tunnel <port>",
  describe: "give a local dev server a public URL until you press Ctrl-C (ngrok or cloudflared)",
  builder: (y) =>
    y
      .positional("port", { type: "number", describe: "the local port to expose, e.g. 3000", demandOption: true })
      .option("provider", {
        type: "string",
        choices: ["auto", "ngrok", "cloudflared"],
        default: "auto",
        describe: "tunnel provider; auto picks ngrok, then cloudflared",
      })
      .option("ttl", { type: "number", describe: "close the tunnel after this many minutes" })
      .option("allow-iris-server", {
        type: "boolean",
        default: false,
        describe: "allow exposing an IRIS engine server (it has no auth — anyone with the URL can drive it)",
      })
      .option("json", { type: "boolean", default: false, describe: "print {url,provider,port} as JSON once up" }),
  async handler(argv) {
    const port = Number(argv.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`${highlight("!")} not a port: ${argv.port}`)
      process.exit(1)
    }

    const local = await probeLocal(port)
    if (!local.listening) {
      console.error(`${highlight("!")} nothing is listening on localhost:${port} — start the dev server first`)
      process.exit(1)
    }
    if (local.irisEngine && !argv["allow-iris-server"]) {
      console.error(`${highlight("!")} ${bold(`localhost:${port} is an IRIS engine server.`)}`)
      console.error(dim("  It has no authentication. A public URL to it lets anyone run agents and shell"))
      console.error(dim("  commands on this machine. Refusing. Override with --allow-iris-server if you mean it."))
      process.exit(1)
    }

    const provider = pickProvider(String(argv.provider))
    if (!provider) {
      console.error(`${highlight("!")} no tunnel provider found${argv.provider === "auto" ? "" : ` (${argv.provider})`}. Install one:`)
      for (const p of Object.keys(INSTALL) as Provider[]) console.error(dim(`  ${p.padEnd(12)} ${INSTALL[p]}`))
      process.exit(1)
    }

    const child = launch(provider, port)
    let closing = false
    const close = (why: string, code = 0) => {
      if (closing) return
      closing = true
      child.kill("SIGTERM")
      if (!argv.json) console.log(`\n${dim(`tunnel closed (${why}) — the URL no longer answers`)}`)
      process.exit(code)
    }
    process.on("SIGINT", () => close("Ctrl-C"))
    process.on("SIGTERM", () => close("terminated"))

    let url: string
    try {
      url = await waitForUrl(child, provider, 30_000)
    } catch (e) {
      child.kill("SIGTERM")
      console.error(`${highlight("!")} ${provider} did not open a tunnel: ${(e as Error).message}`)
      if (provider === "ngrok" && /authtoken|ERR_NGROK_4018/i.test((e as Error).message)) {
        console.error(dim("  ngrok needs an account token once: ngrok config add-authtoken <token>"))
      }
      if (provider === "ngrok" && /ERR_NGROK_108|simultaneous|session limit/i.test((e as Error).message)) {
        console.error(dim("  another ngrok is already running on this account — stop it, or use --provider cloudflared"))
      }
      process.exit(1)
    }

    // The tunnel stays up for as long as the provider does. If it dies, say so and exit
    // rather than leaving a terminal that looks like a live tunnel.
    child.on("exit", (code) => {
      if (!closing) {
        console.error(`\n${highlight("!")} ${provider} exited (code ${code}) — the tunnel is down`)
        closing = true
        process.exit(1)
      }
    })

    // One round-trip out through the provider's edge and back. It proves the URL is
    // live end to end; it does not prove reachability from a different network.
    let reach = "unchecked"
    try {
      const r = await fetch(url, {
        headers: { "ngrok-skip-browser-warning": "1" },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      })
      reach = `HTTP ${r.status}`
      // Vite (5.4.12+/6+) refuses unknown Host headers with a 403, so a stock Vite
      // project tunnels "fine" and serves nothing. Name the fix instead of a bare 403.
      if (r.status === 403 && /Blocked request/i.test(await r.text().catch(() => ""))) {
        reach += ` — the dev server rejected the tunnel's hostname. For Vite set server.allowedHosts: [".${new URL(url).hostname.split(".").slice(-2).join(".")}"]`
      }
    } catch (e) {
      reach = `failed: ${(e as Error).message}`
    }

    const ttl = argv.ttl && argv.ttl > 0 ? Number(argv.ttl) : undefined
    if (ttl) setTimeout(() => close(`--ttl ${ttl}m reached`), ttl * 60_000)

    if (argv.json) {
      console.log(JSON.stringify({ url, provider, port, reach, ttl_minutes: ttl ?? null }))
    } else {
      console.log()
      console.log(`${success("✓")} ${bold(url)}  ${dim(`→ localhost:${port}  via ${provider}`)}`)
      console.log(dim(`  self-check through the public edge: ${reach}`))
      console.log(dim("  websockets and streaming (SSE) pass through."))
      console.log()
      console.log(
        dim(`  Lives until you press Ctrl-C${ttl ? ` or ${ttl} min pass` : ""}. Anyone with the URL can reach this port.`),
      )
      if (provider === "ngrok") {
        console.log(dim("  Free ngrok shows browsers a one-time \"You are about to visit\" page — click Visit Site."))
      }
      if (provider === "cloudflared") {
        console.log(dim("  Quick tunnels are unauthenticated and rate-limited by Cloudflare; fine for a demo."))
      }
    }

    await new Promise(() => {})
  },
})
