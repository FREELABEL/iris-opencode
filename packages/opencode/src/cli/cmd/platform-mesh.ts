import { cmd } from "./cmd"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { parse as parseJsonc } from "jsonc-parser"
import { Global } from "../../global"
import {
  MESH_CONSOLE_PORT,
  MESH_DEFAULT_MODEL,
  MESH_PROVIDER_ID,
  applyMeshProvider,
  buildServeArgv,
  findMeshBinary,
  meshConfigState,
  meshPort,
  meshProviderEntry,
  ownerIdFromKeystore,
  phiRefusal,
  probeMesh,
  removeMeshProvider,
  acpMeshDecision,
} from "./mesh-core"

/**
 * `iris mesh` — use a Mesh LLM running on this machine (or inside Buzz desktop) as an IRIS model
 * provider, and provision one here. Epic #187246, slices M1 (+ M4 lives in cli/cmd/acp.ts).
 * The rules are in mesh-core.ts; this file is I/O.
 */

/**
 * The global config file `use`/`off` edit. Config.global() merges config.json, opencode.json and
 * opencode.jsonc from Global.Path.config (xdg config + "opencode"; XDG_CONFIG_HOME relocates it).
 * opencode.json is the one IRIS's own installer writes, so that is the one we edit.
 */
function globalConfigFile() {
  return path.join(Global.Path.config, "opencode.json")
}

function readJsonFile(file: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!fs.existsSync(file)) return { ok: true, value: {} }
  const text = fs.readFileSync(file, "utf8")
  if (!text.trim()) return { ok: true, value: {} }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "top level is not an object" }
    return { ok: true, value: v }
  } catch (e) {
    // Never rewrite a file we could not read — that would clobber whatever made it unparseable.
    return { ok: false, error: (e as Error).message }
  }
}

/** The effective global view of the three files, later files winning per key (as Config.global does). */
function effectiveGlobalConfig(): Record<string, unknown> {
  let out: Record<string, unknown> = {}
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const file = path.join(Global.Path.config, name)
    if (!fs.existsSync(file)) continue
    const v = parseJsonc(fs.readFileSync(file, "utf8"), [], { allowTrailingComma: true })
    if (!v || typeof v !== "object") continue
    const provider = { ...((out.provider as object) ?? {}), ...((v.provider as object) ?? {}) }
    out = { ...out, ...v, provider }
  }
  return out
}

function irisConfig(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".iris", "config.json"), "utf8"))
  } catch {
    return null
  }
}

/**
 * M4 — for `iris acp` (Buzz): probe the loopback mesh once and, if it serves and this is not a PHI
 * context, return an in-memory config overlay that adds provider `mesh` for this session only.
 * Returns null (change nothing) otherwise. Nothing is written to disk.
 */
export async function meshAcpOverlay(): Promise<{ overlay: <T extends Record<string, unknown>>(c: T) => T; reason: string } | { overlay: null; reason: string }> {
  const phi = phiRefusal(process.env, irisConfig())
  if (phi) return { overlay: null, reason: "PHI context" }
  const port = meshPort(process.env)
  const probe = await probeMesh(port)
  if (!probe.serving) return { overlay: null, reason: `mesh not serving: ${probe.reason}` }
  const entry = meshProviderEntry(port, probe.models)
  return {
    reason: `mesh serving ${probe.models.length} model(s)`,
    overlay: (c) => (acpMeshDecision({ probe, phi, config: c }).apply ? applyMeshProvider(c, entry) : c),
  }
}

async function consoleUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${MESH_CONSOLE_PORT}/health`, { signal: AbortSignal.timeout(1500) })
    return r.status === 200
  } catch {
    return false
  }
}

const StatusCommand = cmd({
  command: "status",
  describe: "is a mesh serving on this machine, which models, and is IRIS set to use it",
  builder: (y) => y.option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: async (args) => {
    const port = meshPort(process.env)
    const [probe, consoleOk] = await Promise.all([probeMesh(port), consoleUp()])
    const cfg = meshConfigState(effectiveGlobalConfig())
    const report = {
      api: probe,
      console: { url: `http://127.0.0.1:${MESH_CONSOLE_PORT}`, up: consoleOk },
      configured: { file: globalConfigFile(), ...cfg },
    }
    if (!probe.serving) process.exitCode = 1
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(`${probe.serving ? "✓" : "✗"} mesh API   ${probe.url}  ${probe.serving ? "serving" : `not serving — ${probe.reason}`}`)
    if (probe.serving) for (const m of probe.models) console.log(`    · ${m}`)
    console.log(`${consoleOk ? "✓" : "✗"} console    ${report.console.url}  ${consoleOk ? "up" : "not answering"}`)
    const cfgLine = cfg.offered
      ? `yes — provider "${MESH_PROVIDER_ID}" → ${cfg.baseURL}`
      : cfg.present
        ? `present but filtered out by enabled_providers/disabled_providers`
        : "no"
    console.log(`${cfg.offered ? "✓" : "✗"} IRIS uses it  ${cfgLine}  (${report.configured.file})`)
    if (!probe.serving) console.log("  Start one here with: iris mesh up   (or open Buzz desktop, which embeds one)")
    else if (!cfg.offered) console.log("  Point IRIS at it with: iris mesh use")
  },
})

const UseCommand = cmd({
  command: "use",
  describe: "add the loopback mesh as model provider `mesh` in your global IRIS config",
  builder: (y) =>
    y.option("dry-run", { type: "boolean", default: false, describe: "print the result, write nothing" }),
  handler: async (args) => {
    const phi = phiRefusal(process.env, irisConfig())
    if (phi) {
      console.error(phi)
      process.exitCode = 1
      return
    }
    const port = meshPort(process.env)
    const probe = await probeMesh(port)
    if (!probe.serving) {
      console.error(`Refusing: no mesh is serving at ${probe.url} (${probe.reason}). Start one with: iris mesh up`)
      process.exitCode = 1
      return
    }
    const file = globalConfigFile()
    const current = readJsonFile(file)
    if (!current.ok) {
      console.error(`Refusing to edit ${file}: it does not parse (${current.error}). Fix it by hand first.`)
      process.exitCode = 1
      return
    }
    const entry = meshProviderEntry(port, probe.models)
    const next = applyMeshProvider(current.value, entry)
    const body = JSON.stringify(next, null, 2) + "\n"
    if (args["dry-run"]) {
      console.log(`would write ${file}:`)
      console.log(body)
      return
    }
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    if (before !== body) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
    }
    // Read back: a write that printed success and changed nothing is not a write.
    const back = readJsonFile(file)
    const state = back.ok ? meshConfigState(back.value) : null
    if (!state?.present || state.baseURL !== entry.options.baseURL) {
      console.error(`wrote ${file} but the mesh provider does not read back — check permissions`)
      process.exitCode = 1
      return
    }
    console.log(`${before === body ? "already set" : "added"}: provider "${MESH_PROVIDER_ID}" → ${entry.options.baseURL}  (${file})`)
    console.log(`models: ${Object.keys(entry.models).join(", ")}`)
    if (!meshConfigState(effectiveGlobalConfig()).offered) {
      console.log("warning: another global config file filters it out (enabled_providers/disabled_providers in opencode.jsonc?)")
    }
    console.log(`Pick it with: iris models ${MESH_PROVIDER_ID}   ·   undo with: iris mesh off`)
  },
})

const OffCommand = cmd({
  command: "off",
  describe: "remove the `mesh` provider from your global IRIS config (nothing else changes)",
  handler: async () => {
    const file = globalConfigFile()
    const current = readJsonFile(file)
    if (!current.ok) {
      console.error(`Refusing to edit ${file}: it does not parse (${current.error}).`)
      process.exitCode = 1
      return
    }
    if (!meshConfigState(current.value).present) {
      console.log(`nothing to remove — no "${MESH_PROVIDER_ID}" provider in ${file}`)
      return
    }
    fs.writeFileSync(file, JSON.stringify(removeMeshProvider(current.value), null, 2) + "\n")
    const back = readJsonFile(file)
    if (!back.ok || meshConfigState(back.value).present) {
      console.error(`tried to remove the provider from ${file} but it is still there`)
      process.exitCode = 1
      return
    }
    console.log(`removed provider "${MESH_PROVIDER_ID}" from ${file}`)
  },
})

const irisDir = () => path.join(os.homedir(), ".iris")
const pidFile = () => path.join(irisDir(), "mesh-llm.pid")
const logFile = () => path.join(irisDir(), "logs", "mesh-llm.log")

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(): number | null {
  try {
    const n = Number(fs.readFileSync(pidFile(), "utf8").trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

const UpCommand = cmd({
  command: "up",
  describe: "start an owner-restricted, unpublished mesh on this machine (loopback API)",
  builder: (y) =>
    y
      .option("model", { type: "string", default: MESH_DEFAULT_MODEL, describe: "model to serve" })
      .option("trust-owner", {
        type: "string",
        array: true,
        describe: "additional owner id allowed to join (your own owner id is always trusted)",
      })
      .option("owner-key", { type: "string", describe: "owner keystore (default ~/.mesh-llm/owner-keystore.json)" })
      .option("node-label", { type: "string", describe: "label for this node in the mesh" })
      .option("dry-run", { type: "boolean", default: false, describe: "print the command, start nothing" }),
  handler: async (args) => {
    const phi = phiRefusal(process.env, irisConfig())
    if (phi) {
      console.error(phi)
      process.exitCode = 1
      return
    }
    const bin = findMeshBinary(os.homedir(), fs.existsSync, process.env.PATH)
    if (!bin) {
      console.error("mesh-llm is not installed. Install it with one of:")
      console.error("  curl -fsSL https://raw.githubusercontent.com/Mesh-LLM/mesh-llm/main/install.sh | bash")
      console.error("  brew install Mesh-LLM/tap/mesh-llm")
      console.error("then run: mesh-llm auth init   and again: iris mesh up")
      process.exitCode = 1
      return
    }
    const port = meshPort(process.env)
    const existing = readPid()
    if (existing && alive(existing)) {
      console.log(`already running (pid ${existing}, started by iris mesh up). Check: iris mesh status`)
      return
    }
    const probe = await probeMesh(port)
    if (probe.serving) {
      console.log(`a mesh is already serving on ${probe.url} (Buzz desktop, or one you started). Not starting a second.`)
      return
    }
    const ownerKey = (args["owner-key"] as string | undefined) ?? path.join(os.homedir(), ".mesh-llm", "owner-keystore.json")
    let keystore: unknown = null
    try {
      keystore = JSON.parse(fs.readFileSync(ownerKey, "utf8"))
    } catch {
      console.error(`No owner keystore at ${ownerKey}. Create one with: mesh-llm auth init`)
      console.error("IRIS only starts owner-restricted meshes — an unrestricted one is never the default.")
      process.exitCode = 1
      return
    }
    const self = ownerIdFromKeystore(keystore)
    if (!self) {
      console.error(`${ownerKey} has no owner_id. Re-run: mesh-llm auth init`)
      process.exitCode = 1
      return
    }
    let argv: string[]
    try {
      argv = buildServeArgv({
        bin,
        model: String(args.model),
        port,
        ownerKey,
        trustOwners: [self, ...((args["trust-owner"] as string[] | undefined) ?? [])],
        nodeLabel: args["node-label"] as string | undefined,
      })
    } catch (e) {
      console.error(`Refusing: ${(e as Error).message}`)
      process.exitCode = 1
      return
    }
    if (args["dry-run"]) {
      console.log(argv.join(" "))
      return
    }
    // Privacy default: mesh-llm ships with analytics on and says so on first run. Turn it off the
    // first time IRIS provisions a mesh here; a user who re-enables it later is not overridden.
    const analyticsMarker = path.join(irisDir(), "mesh-llm.analytics-disabled")
    if (!fs.existsSync(analyticsMarker)) {
      const r = Bun.spawnSync([bin, "analytics", "disable"], { stdout: "pipe", stderr: "pipe" })
      if (r.exitCode === 0) {
        fs.mkdirSync(irisDir(), { recursive: true })
        fs.writeFileSync(analyticsMarker, new Date().toISOString() + "\n")
        console.log("mesh-llm analytics turned off (mesh-llm analytics disable) — privacy default for IRIS meshes")
      } else {
        console.log(`warning: could not turn off mesh-llm analytics: ${(r.stderr.toString() || r.stdout.toString()).trim()}`)
      }
    }
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    const out = fs.openSync(logFile(), "a")
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out] })
    child.unref()
    if (!child.pid) {
      console.error("mesh-llm did not start")
      process.exitCode = 1
      return
    }
    fs.writeFileSync(pidFile(), String(child.pid))
    await Bun.sleep(1500)
    if (!alive(child.pid)) {
      fs.rmSync(pidFile(), { force: true })
      console.error(`mesh-llm exited straight away — see ${logFile()}`)
      process.exitCode = 1
      return
    }
    console.log(`started mesh-llm (pid ${child.pid}) serving ${args.model} — owner-restricted, unpublished`)
    console.log(`  API     http://127.0.0.1:${port}/v1   (loading the model can take minutes; check: iris mesh status)`)
    console.log(`  log     ${logFile()}   ← mesh-llm prints the join token here`)
    const invite = path.join(os.homedir(), ".mesh-llm", "invite.token")
    if (fs.existsSync(invite)) console.log(`  invite  ${invite}`)
    console.log("  Joining is limited to trusted owners; add one with: iris mesh up --trust-owner <owner-id>")
    console.log("  Stop with: iris mesh down")
  },
})

const DownCommand = cmd({
  command: "down",
  describe: "stop the mesh that `iris mesh up` started (never touches Buzz's)",
  handler: async () => {
    const pid = readPid()
    if (!pid) {
      console.log("nothing to stop — iris mesh up has not started one")
      return
    }
    if (!alive(pid)) {
      fs.rmSync(pidFile(), { force: true })
      console.log(`not running (stale pid ${pid} cleared)`)
      return
    }
    // A reused pid must not get killed: only stop it if it is still mesh-llm.
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe" })
    if (!ps.stdout.toString().includes("mesh-llm")) {
      fs.rmSync(pidFile(), { force: true })
      console.log(`pid ${pid} is no longer mesh-llm — cleared the pidfile, killed nothing`)
      return
    }
    process.kill(pid, "SIGTERM")
    for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(250)
    if (alive(pid)) {
      console.error(`mesh-llm (pid ${pid}) did not stop after SIGTERM`)
      process.exitCode = 1
      return
    }
    fs.rmSync(pidFile(), { force: true })
    console.log(`stopped mesh-llm (pid ${pid})`)
  },
})

export const MeshCommand = cmd({
  command: "mesh",
  describe: "shared compute — use a local Mesh LLM as a model provider, or start one here",
  builder: (y) =>
    y
      .command(StatusCommand)
      .command(UseCommand)
      .command(OffCommand)
      .command(UpCommand)
      .command(DownCommand)
      .demandCommand(1),
  handler: () => {},
})
