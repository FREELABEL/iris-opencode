import { cmd } from "./cmd"
import * as prompts from "./clack"
import { requireAuth, requireUserId, writeJson, dim, bold, success, warn, highlight, irisFetch } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { startRelayTunnelBg, stopRelayTunnelBg } from "./platform-hive-tunnel"
import { validTunnelName } from "./platform-hive-relay"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, hostname } from "os"
import { join } from "path"

/**
 * `iris hive models` — the models your machines can serve to your own IRIS gateway (#191176).
 *
 * A machine running Ollama / vLLM / llama-server / LM Studio already reports its models on every
 * heartbeat. `serve on` lets the gateway use them: it switches on the daemon's inference endpoint
 * (~/.iris/inference.json, re-read every 15 s) and opens a Hive relay tunnel to it. The endpoint
 * answers only requests IRIS signed for your account, for one model, once — so the public URL is
 * not an open model server. Then `hive/<model>` works anywhere IRIS takes a model: the CLI,
 * Desktop, agents, the OpenAI-compatible API — at $0, on your hardware.
 *
 * Owner only by default: nobody else's requests reach your machine. `share on <connection>` lets
 * one connected person use them as `hive/@<you>/<model>` (#192752).
 */

export const DEFAULT_INFERENCE_PORT = 3290

export interface InferenceSettings {
  enabled: boolean
  port: number
  url: string | null
  max_concurrent: number
  max_tokens: number
  models: string[] | null
  /** The model to use when a request must stay on your machines (PHI with phi-local on). */
  default_model: string | null
}

export const settingsPath = (home = homedir()) => join(home, ".iris", "inference.json")

export function readSettings(home = homedir()): InferenceSettings {
  const d: InferenceSettings = { enabled: false, port: DEFAULT_INFERENCE_PORT, url: null, max_concurrent: 2, max_tokens: 8192, models: null, default_model: null }
  try {
    return { ...d, ...JSON.parse(readFileSync(settingsPath(home), "utf8")) }
  } catch {
    return d
  }
}

export function writeSettings(s: InferenceSettings, home = homedir()) {
  mkdirSync(join(home, ".iris"), { recursive: true, mode: 0o700 })
  writeFileSync(settingsPath(home), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
}

/** This machine's tunnel name for its models: `<hostname>-ai`, made into a valid label. */
export function servingTunnelName(host = hostname()): string {
  const base = host
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 59)
    .replace(/-+$/, "")
  return `${base || "hive"}-ai`
}

export interface ModelRow {
  model: string
  node: string
  serving: boolean
  /** True only after a real check through the tunnel succeeded, never from the machine's report. */
  reachable: boolean
  why?: string
  state?: string
  checked_at?: string | null
  model_server_tested?: boolean
}

/** One machine, checked by the server through its tunnel: GET /api/v6/nodes/inference-status (#192146). */
export interface InferenceCheck {
  node_id: string
  state: string
  ok: boolean
  reason: string
  checked_at: string | null
  model_server_tested: boolean
}

const FRESH_MS = 180_000

/**
 * One row per (node, model) from the fleet's node detail. Pure, so it is tested without a fleet.
 *
 * A heartbeat is the machine's opinion of itself: it cannot see its own tunnel from outside. So a
 * row is reachable only when `checks` holds a passing check for that machine. Without one it says
 * so, rather than repeating the report as fact.
 */
export function rowsFromNodes(nodes: any[], now = Date.now(), checks?: InferenceCheck[] | null): ModelRow[] {
  const out: ModelRow[] = []
  for (const n of nodes) {
    const llm = n?.local_llm
    const inf = n?.inference
    const online = n?.connection_status === "online" || n?.connection_status === "busy"
    const fresh = inf?.updated_at ? now - Date.parse(inf.updated_at) < FRESH_MS : false
    const served = new Set<string>(Array.isArray(inf?.models) ? inf.models : [])
    for (const m of Array.isArray(llm?.models) ? llm.models : []) {
      const serving = inf?.enabled === true && served.has(m)
      let why: string | undefined
      if (!serving) why = inf?.enabled === true ? "excluded in ~/.iris/inference.json" : "not served (iris hive models serve on)"
      else if (!online) why = "machine offline"
      else if (!inf?.url) why = "no tunnel URL yet"
      else if (!fresh) why = "report is stale"
      const check = checks?.find((c) => String(c.node_id) === String(n?.id))
      const reported = serving && online && !!inf?.url && fresh
      if (reported && !check) why = "reported by the machine, not tested"
      else if (reported && check && !check.ok) why = `${check.state}: ${check.reason}`
      else if (reported && check && !check.model_server_tested) why = check.reason
      out.push({
        model: m,
        node: String(n?.name ?? n?.id ?? "?"),
        serving,
        reachable: reported && check?.ok === true,
        why,
        ...(reported && check ? { state: check.state, checked_at: check.checked_at, model_server_tested: check.model_server_tested } : {}),
      })
    }
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.node.localeCompare(b.node))
}

export async function fleet(userId: number): Promise<any[]> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body.nodes || body.data || []
}

/** Each serving machine, checked through its tunnel. null when the server cannot say (it is older, or unreachable). */
export async function inferenceChecks(userId: number): Promise<InferenceCheck[] | null> {
  try {
    const res = await hiveFetch(`/api/v6/nodes/inference-status?user_id=${userId}`)
    if (!res.ok) return null
    const body: any = await res.json().catch(() => null)
    return Array.isArray(body?.data) ? body.data : null
  } catch {
    return null
  }
}

/** "checked 12s ago", for a row the server tested. */
export function checkedAgo(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : NaN
  if (Number.isNaN(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `checked ${s}s ago` : `checked ${Math.round(s / 60)}m ago`
}

/**
 * Sharing your machines' models with someone you are connected to (#192752, phase 2).
 *
 * Directional: each person shares THEIR OWN machines. The server keeps the list on the connection
 * (permissions.inference_sharers) and only lets you add or remove yourself. The person you share
 * with uses `hive/@<your user id>/<model>` — and can be read by you, so they are told so.
 */
export const INFERENCE_SHARERS = "inference_sharers"

export interface ShareState {
  id: string
  peer: string
  peerUserId: number | null
  active: boolean
  iShare: boolean
  theyShare: boolean
}

/** Pure: who shares with whom on each connection, from `GET /api/v6/nodes/connections`. */
export function shareStates(conns: any[], me: number): ShareState[] {
  return conns.map((c) => {
    const sharers = (Array.isArray(c?.permissions?.[INFERENCE_SHARERS]) ? c.permissions[INFERENCE_SHARERS] : []).map(Number)
    const peerUserId = c?.peer_user_id != null ? Number(c.peer_user_id) : null
    return {
      id: String(c?.id ?? ""),
      peer: String(c?.peer_name ?? (peerUserId != null ? `user ${peerUserId}` : "pending invite")),
      peerUserId,
      active: c?.status === "active" && peerUserId != null,
      iShare: sharers.includes(me),
      theyShare: peerUserId != null && sharers.includes(peerUserId),
    }
  })
}

/** Pure: the connection a person means, by full id, unique id prefix, or peer name. */
export function pickConnection(states: ShareState[], ref: string): ShareState | { error: string } {
  const r = ref.trim().toLowerCase()
  const hits = states.filter((s) => s.id.toLowerCase() === r || s.id.toLowerCase().startsWith(r) || s.peer.toLowerCase() === r)
  if (hits.length === 1) return hits[0]
  if (!hits.length) return { error: `no connection matches "${ref}" — see them with: iris hive models share` }
  return { error: `"${ref}" matches ${hits.length} connections — use more of the id` }
}

/** Models other people share with you, from the gateway's model list (entries carrying `shared_by`). */
export async function sharedWithMe(): Promise<any[]> {
  try {
    const res = await hiveFetch(`/api/v6/openai/models`)
    if (!res.ok) return []
    const body: any = await res.json().catch(() => null)
    return (Array.isArray(body?.data) ? body.data : []).filter((m: any) => m?.shared_by != null)
  } catch {
    return []
  }
}

async function connections(userId: number): Promise<any[]> {
  const res = await hiveFetch(`/api/v6/nodes/connections?user_id=${userId}`)
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || body?.message || `HTTP ${res.status}`)
  return body.connections || []
}

const ShareCommand = cmd({
  command: "share [state] [connection]",
  describe: "share this account's serving machines with someone you are connected to (on), stop (off), or see who shares what",
  builder: (yargs) =>
    yargs
      .positional("state", { type: "string", choices: ["on", "off"] })
      .positional("connection", { type: "string", describe: "connection id (or its start), or the person's name" })
      .option("yes", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" })
      .example("$0 hive models share", "who you share with, and who shares with you")
      .example("$0 hive models share on 01a1b2", "let that person run models on your serving machines")
      .example('$0 run -m iris/hive/@<their user id>/llama3.2:3b "…"', "use a model someone shares with you"),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const states = shareStates(await connections(userId), userId)

    if (!argv.state) {
      const shared = await sharedWithMe()
      if (argv.json) return void (await writeJson({ connections: states, shared_with_you: shared }))
      console.log()
      if (!states.length) {
        console.log(dim("  No connections yet. Invite someone: iris hive invite   ·   accept one: iris hive accept <code>"))
        return
      }
      for (const s of states)
        console.log(
          `  ${s.active ? success("●") : dim("○")} ${bold(s.peer.padEnd(24))} ${dim(s.id.slice(0, 8))}  you share: ${s.iShare ? success("on") : dim("off")}   they share: ${s.theyShare ? success("on") : dim("off")}${s.active ? "" : dim("  (not active)")}`,
        )
      console.log()
      if (shared.length) {
        console.log(bold("  Shared with you"))
        for (const m of shared) console.log(`    ${bold(String(m.id).replace(/^iris\//, ""))}  ${dim(String(m.name ?? ""))}`)
        console.log(dim(`  Use one: iris run -m <id> "…"   ·   the owner can read what you send`))
      } else console.log(dim("  Nobody is sharing a serving machine with you right now."))
      return
    }

    const pick = pickConnection(states, String(argv.connection ?? ""))
    if ("error" in pick) {
      console.log(`\n${highlight("✗")} ${argv.connection ? pick.error : "say which connection — see them with: iris hive models share"}`)
      process.exitCode = 1
      return
    }
    const share = argv.state === "on"
    if (share && !argv.yes) {
      console.log()
      console.log(`${highlight("!")} ${bold(`${pick.peer} will be able to run models on your serving machines.`)}`)
      console.log(dim("  You can read every prompt they send, and it runs at your electricity. Patient data is refused on shared machines."))
      const ok = await prompts.confirm({ message: `Share with ${pick.peer}?`, initialValue: true })
      if (ok !== true) return void console.log(dim("\n  Not shared."))
    }
    const res = await hiveFetch(`/api/v6/nodes/connections/${pick.id}/inference?user_id=${userId}`, {
      method: "POST",
      body: JSON.stringify({ share }),
    })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const why = res.status === 404 ? "this IRIS server does not support sharing yet (it needs #192752 deployed)" : body?.message || body?.error || `HTTP ${res.status}`
      console.log(`\n${highlight("✗")} could not change sharing: ${why}`)
      process.exitCode = 1
      return
    }
    if (!share) return void console.log(`\n${success("✓")} ${pick.peer} can no longer run models on your machines`)
    console.log(`\n${success("●")} shared with ${bold(pick.peer)}`)
    console.log(dim(`  They use: iris run -m iris/hive/@${userId}/<model> "…"   ·   see what you serve: iris hive models`))
    if (!readSettings().enabled) console.log(warn("  ! this machine is not serving. Start: ") + bold("iris hive models serve on"))
  },
})

const ListCommand = cmd({
  command: "$0",
  describe: "the models your machines can serve to your IRIS gateway, and whether each is reachable now",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" })
      .example("$0 hive models", "what your machines serve")
      .example("$0 hive models serve on", "let your gateway use this machine's models")
      .example('$0 run -m iris/hive/qwen3:14b "…"', "use one — anywhere IRIS takes a model"),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const [nodes, checks] = await Promise.all([fleet(userId), inferenceChecks(userId)])
    const rows = rowsFromNodes(nodes, Date.now(), checks)
    if (argv.json) return void (await writeJson(rows.map((r) => ({ id: `hive/${r.model}`, ...r }))))
    console.log()
    if (!rows.length) {
      console.log(dim("  None of your machines reports a local model server."))
      console.log(dim("  Install one (e.g. https://ollama.com), pull a model, and it appears here within a minute."))
      return
    }
    for (const r of rows)
      console.log(
        `  ${r.reachable ? success("●") : dim("○")} ${bold(`hive/${r.model}`.padEnd(34))} ${r.node.padEnd(22)} ${r.reachable ? `${success("serving")} ${dim([checkedAgo(r.checked_at), r.why].filter(Boolean).join(" · "))}` : dim([r.why, checkedAgo(r.checked_at)].filter(Boolean).join(" · "))}`,
      )
    const local = readSettings()
    console.log()
    console.log(
      dim(
        local.enabled
          ? `  This machine is serving${local.url ? ` at ${local.url}` : ""}. Stop: iris hive models serve off`
          : "  This machine is not serving. Start: iris hive models serve on",
      ),
    )
    const shared = await sharedWithMe()
    if (shared.length) {
      console.log()
      console.log(bold("  Shared with you"))
      for (const m of shared) console.log(`    ${bold(String(m.id).replace(/^iris\//, "").padEnd(34))} ${dim(String(m.name ?? ""))}`)
    }
    console.log(dim("  Share yours with someone you are connected to: iris hive models share"))
  },
})

const ServeCommand = cmd({
  command: "serve <state>",
  describe: "let your IRIS gateway use this machine's models (on), or stop (off)",
  builder: (yargs) =>
    yargs
      .positional("state", { type: "string", choices: ["on", "off", "status"], demandOption: true })
      .option("port", { type: "number", describe: "local port for the inference endpoint", default: DEFAULT_INFERENCE_PORT })
      .option("name", { type: "string", describe: "tunnel name (default: <this machine>-ai)" })
      .option("max-concurrent", { type: "number", describe: "requests at once before answering busy", default: 2 })
      .option("models", { type: "string", describe: "only these models, comma-separated (default: all)" })
      .option("default", { type: "string", describe: "the model to use when patient data must stay on your machines (see: iris hive models phi-local)" })
      .option("yes", { type: "boolean", default: false }),
  async handler(argv) {
    const s = readSettings()
    const name = String(argv.name || servingTunnelName())
    if (argv.state === "status") {
      console.log(`\n  ${s.enabled ? success("● serving") : dim("○ not serving")}${s.url ? `  ${s.url}` : ""}  ${dim(settingsPath())}`)
      return
    }
    if (argv.state === "off") {
      writeSettings({ ...s, enabled: false })
      const closed = stopRelayTunnelBg(name)
      console.log(`\n${success("✓")} this machine no longer serves its models${closed ? dim(` — tunnel ${name} closed`) : ""}`)
      console.log(dim("  The gateway stops routing here on the next heartbeat (within a minute)."))
      return
    }

    await requireAuth()
    if (!validTunnelName(name)) {
      console.log(`\n${highlight("✗")} "${name}" is not a valid tunnel name — pass one with --name`)
      process.exitCode = 1
      return
    }
    if (!argv.yes) {
      console.log()
      console.log(`${highlight("!")} ${bold("This machine's models will be reachable by your IRIS gateway")} through a public Hive relay URL.`)
      console.log(dim("  It answers only requests IRIS signed for YOUR account, one model, once. Nobody else's requests reach it."))
      console.log(dim(`  It runs on this machine's ${existsSync("/usr/local/bin/ollama") ? "Ollama" : "model server"}, at your electricity — at most ${argv["max-concurrent"]} at a time.`))
      const ok = await prompts.confirm({ message: "Serve them?", initialValue: true })
      if (ok !== true) {
        console.log(dim("\n  Not started."))
        return
      }
    }
    const port = Number(argv.port)
    const models = argv.models ? String(argv.models).split(",").map((m) => m.trim()).filter(Boolean) : null
    // The endpoint first, so the tunnel's own reachability check finds something listening.
    const default_model = argv.default ? String(argv.default) : s.default_model
    writeSettings({ ...s, enabled: true, port, max_concurrent: Number(argv["max-concurrent"]) || 2, models, url: s.url, default_model })
    const t = await startRelayTunnelBg(name, port)
    if (!t.ok) {
      console.log(`\n${highlight("✗")} the endpoint is on, but the tunnel did not open: ${t.error}`)
      console.log(dim("  The gateway cannot reach this machine until it does. Retry: iris hive models serve on"))
      process.exitCode = 1
      return
    }
    writeSettings({ ...readSettings(), url: t.url })
    console.log(`\n${success("●")} serving at ${bold(t.url)}${t.already ? dim(" (tunnel was already open)") : ""}`)
    console.log(dim("  The daemon picks this up within 15 s and reports it on its next heartbeat."))
    console.log(dim("  Then: iris hive models   ·   use one: --model hive/<model>   ·   stop: iris hive models serve off"))
  },
})

/**
 * `iris hive models phi-local on|off|status` — patient data never leaves your machines.
 *
 * Sets your account's `phi_local_only` flag. With it on, a request that carries PHI runs on one
 * of your machines (the model you asked for if a machine serves it, else that machine's
 * --default), and is refused — never sent to a cloud model — when none is serving. Requests
 * without PHI are unaffected. For clinics that must keep patient data on their own hardware.
 */
const PhiLocalCommand = cmd({
  command: "phi-local <state>",
  describe: "keep patient data on your own machines: PHI requests run locally, or are refused — never sent to a cloud model",
  builder: (yargs) =>
    yargs
      .positional("state", { type: "string", choices: ["on", "off", "status"], demandOption: true })
      .option("user-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const path = `/api/v1/feature-configurations/flags/user/${userId}`
    if (argv.state === "status") {
      const r = await irisFetch(path)
      const body: any = await r.json().catch(() => ({}))
      // fl-api answers {data: {<flag>: <decoded value>}} — FeatureFlag::getFlagsForScope.
      const v = body?.data?.phi_local_only
      const on = v === true || v === "enabled"
      console.log(`\n  ${on ? success("● on") : dim("○ off")}  patient data ${on ? "stays on your machines" : "may go to cloud models (subject to the PHI provider registry)"}`)
      return
    }
    const r = await irisFetch(path, { method: "PUT", body: JSON.stringify({ flags: { phi_local_only: argv.state === "on" ? "enabled" : "disabled" } }) })
    const body: any = await r.json().catch(() => ({}))
    if (!r.ok || body?.success === false) {
      console.log(`\n${highlight("✗")} could not change it: ${body?.error || `HTTP ${r.status}`}`)
      process.exitCode = 1
      return
    }
    if (argv.state === "off") {
      console.log(`\n${success("✓")} off — patient data may go to cloud models again, subject to the PHI provider registry`)
      return
    }
    console.log(`\n${success("●")} on — requests carrying patient data now run on your own machines, or are refused`)
    const local = readSettings()
    if (!local.enabled || !local.default_model)
      console.log(warn("  ! set a default model on a serving machine, or PHI requests will be refused: ") + bold("iris hive models serve on --default <model>"))
    console.log(dim("  Takes effect within a minute."))
  },
})

export const HiveModelsCommand = cmd({
  command: "models",
  describe: "models your machines serve to your IRIS gateway (hive/<model>) — list, serve on|off, share, phi-local on|off",
  builder: (yargs) => yargs.command(ListCommand).command(ServeCommand).command(ShareCommand).command(PhiLocalCommand),
  handler: () => {},
})
