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
 * Phase 1 is owner only: nobody else's requests reach your machine.
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
  reachable: boolean
  why?: string
}

const FRESH_MS = 180_000

/** One row per (node, model) from the fleet's node detail. Pure, so it is tested without a fleet. */
export function rowsFromNodes(nodes: any[], now = Date.now()): ModelRow[] {
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
      out.push({ model: m, node: String(n?.name ?? n?.id ?? "?"), serving, reachable: serving && online && !!inf?.url && fresh, why })
    }
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.node.localeCompare(b.node))
}

async function fleet(userId: number): Promise<any[]> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body.nodes || body.data || []
}

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
    const rows = rowsFromNodes(await fleet(userId))
    if (argv.json) return void (await writeJson(rows.map((r) => ({ id: `hive/${r.model}`, ...r }))))
    console.log()
    if (!rows.length) {
      console.log(dim("  None of your machines reports a local model server."))
      console.log(dim("  Install one (e.g. https://ollama.com), pull a model, and it appears here within a minute."))
      return
    }
    for (const r of rows)
      console.log(
        `  ${r.reachable ? success("●") : dim("○")} ${bold(`hive/${r.model}`.padEnd(34))} ${r.node.padEnd(22)} ${r.reachable ? success("serving") : dim(r.why ?? "")}`,
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
  describe: "models your machines serve to your IRIS gateway (hive/<model>) — list, serve on|off, phi-local on|off",
  builder: (yargs) => yargs.command(ListCommand).command(ServeCommand).command(PhiLocalCommand),
  handler: () => {},
})
