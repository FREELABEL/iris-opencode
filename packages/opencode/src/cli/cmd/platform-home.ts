import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, dim, bold, success, printDivider, writeJson } from "./iris-api"
import {
  BUILTIN_SEQUENCES,
  COLORS,
  matchDevices,
  normalizeScene,
  parseSetArgs,
  stepVerbs,
  summarizeHueResponse,
  toWizParams,
  type HomeDevice,
  type Verbs,
} from "./home-core"
import fs from "fs"
import os from "os"
import path from "path"
import dgram from "dgram"
import { spawn } from "child_process"
import readline from "readline"
import { pathToFileURL } from "url"

// ============================================================================
// `iris home` — smart-home control from the device registry (#185775).
//
// Split of state, deliberately:
//   - the DEVICE REGISTRY (names, rooms, transports) lives in Atlas, dataset `home_devices`,
//     so every surface a client uses sees the same home;
//   - BRIDGE KEYS stay on this machine (~/.iris/home/bridges.json, 0600). A Hue key is a LAN
//     credential that controls the house — it has no business in a cloud record;
//   - a local copy of the registry is cached so turning on a light never needs the internet.
// ============================================================================

const HOME_DIR = process.env.IRIS_HOME_DIR ?? path.join(os.homedir(), ".iris", "home")
const CACHE = path.join(HOME_DIR, "registry.json")
const BRIDGES = path.join(HOME_DIR, "bridges.json")
const SEQUENCES = path.join(HOME_DIR, "sequences.json")
const EFFECTS_DIR = path.join(HOME_DIR, "effects")
const SCHEMA = "home_devices"

type SendResult = { device: string; ok: boolean; note?: string }

function ensureDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.mkdirSync(EFFECTS_DIR, { recursive: true })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeLocal(file: string, value: unknown, mode?: number) {
  ensureDir()
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
  // writeFileSync's mode only applies on create — chmod so an existing file is tightened too.
  if (mode !== undefined) fs.chmodSync(file, mode)
}

const externalId = (d: HomeDevice) => `${d.transport}:${d.ip ?? ""}:${d.id}`

// ── registry ────────────────────────────────────────────────────────────────

type Registry = { devices: HomeDevice[]; source: "atlas" | "cache"; warning?: string }

const CACHE_TTL_MS = 60 * 60 * 1000

async function loadRegistry(opts: { fresh?: boolean } = {}): Promise<Registry> {
  const cached = readJson<{ devices: HomeDevice[] }>(CACHE, { devices: [] }).devices ?? []
  // Lights should answer instantly: a recent cache is used as-is, Atlas is only asked when
  // the cache is stale or the caller wants the authoritative view (list, sync).
  const age = fs.existsSync(CACHE) ? Date.now() - fs.statSync(CACHE).mtimeMs : Infinity
  if (!opts.fresh && cached.length && age < CACHE_TTL_MS) return { devices: cached, source: "cache" }
  try {
    const res = await irisFetch(`/api/v1/atlas/datasets/${SCHEMA}?per_page=200`, { signal: AbortSignal.timeout(4000) })
    if (res.status === 404) return { devices: cached, source: "cache", warning: cached.length ? undefined : "no registry yet" }
    if (!res.ok) return { devices: cached, source: "cache", warning: `Atlas answered ${res.status}; using local cache` }
    const body = (await res.json()) as any
    const rows: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
    const devices = rows.map((r) => r?.data).filter((d) => d?.name && d?.transport) as HomeDevice[]
    // An empty Atlas dataset with a populated cache means records were never synced, not
    // that the house has no lights — keep working from the cache and say so.
    if (!devices.length && cached.length) {
      return { devices: cached, source: "cache", warning: "Atlas registry is empty — run: iris home devices sync" }
    }
    writeLocal(CACHE, { devices })
    return { devices, source: "atlas" }
  } catch (err) {
    return { devices: cached, source: "cache", warning: `Atlas unreachable (${(err as Error).message}); using local cache` }
  }
}

async function ensureSchema(): Promise<boolean> {
  const got = await irisFetch(`/api/v1/atlas/schemas/${SCHEMA}`)
  if (got.ok) return true
  const res = await irisFetch("/api/v1/atlas/schemas", {
    method: "POST",
    body: JSON.stringify({
      name: "Home Devices",
      slug: SCHEMA,
      fields: {
        fields: [
          { key: "name", label: "Name", type: "string", required: true, filterable: true },
          { key: "room", label: "Room", type: "string", filterable: true },
          { key: "transport", label: "Transport", type: "string", filterable: true },
          { key: "id", label: "Device ID", type: "string" },
          { key: "ip", label: "IP", type: "string" },
        ],
      },
    }),
  })
  return res.ok
}

/** Push devices to Atlas. Returns how many landed — callers report that number, not "done". */
async function upsertDevices(devices: HomeDevice[]): Promise<{ synced: number; error?: string }> {
  // The cache is written first: pairing must not be lost because the network blinked.
  const cached = readJson<{ devices: HomeDevice[] }>(CACHE, { devices: [] }).devices ?? []
  const merged = new Map(cached.map((d) => [externalId(d), d]))
  for (const d of devices) merged.set(externalId(d), d)
  writeLocal(CACHE, { devices: [...merged.values()] })
  try {
    if (!(await ensureSchema())) return { synced: 0, error: "could not create Atlas schema (signed in? try: iris auth login)" }
    let synced = 0
    for (const d of devices) {
      const res = await irisFetch(`/api/v1/atlas/datasets/${SCHEMA}/upsert`, {
        method: "POST",
        body: JSON.stringify({ external_id: externalId(d), data: d }),
      })
      if (res.ok) synced++
    }
    return { synced, error: synced < devices.length ? `${devices.length - synced} record(s) rejected by Atlas` : undefined }
  } catch (err) {
    return { synced: 0, error: (err as Error).message }
  }
}

// ── transports ──────────────────────────────────────────────────────────────

function hueKey(ip: string): string | null {
  return readJson<Record<string, { username: string }>>(BRIDGES, {})[ip]?.username ?? null
}

async function hueApi(ip: string, p: string, init: RequestInit = {}): Promise<any> {
  const key = hueKey(ip)
  if (!key) throw new Error(`no key for bridge ${ip} — run: iris home devices pair-hue ${ip}`)
  const res = await fetch(`http://${ip}/api/${key}${p}`, { ...init, signal: AbortSignal.timeout(3000) })
  return res.json()
}

function wizSend(ip: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4")
    const timer = setTimeout(() => { sock.close(); reject(new Error("no reply from bulb (UDP 38899)")) }, 2000)
    sock.on("message", (msg) => { clearTimeout(timer); sock.close(); resolve(JSON.parse(msg.toString())) })
    sock.send(JSON.stringify({ method: "setPilot", params }), 38899, ip, (err) => {
      if (err) { clearTimeout(timer); sock.close(); reject(err) }
    })
  })
}

// Reachability per bridge, read at most every few seconds — an effect loop sending every
// 150ms must not double its bridge traffic just to decorate its output.
const bridgeState = new Map<string, { at: number; lights: any }>()

async function lightsOf(ip: string): Promise<any> {
  const hit = bridgeState.get(ip)
  if (hit && Date.now() - hit.at < 5000) return hit.lights
  const lights = await hueApi(ip, "/lights").catch(() => ({}))
  bridgeState.set(ip, { at: Date.now(), lights })
  return lights
}

async function sendTo(devices: HomeDevice[], verbs: Verbs): Promise<SendResult[]> {
  // Hue ACKs writes to unreachable lights, so reachability is checked to avoid a false ✓.
  const lightState = new Map<string, any>()
  for (const ip of new Set(devices.filter((d) => d.transport === "hue" && d.ip).map((d) => d.ip!))) {
    lightState.set(ip, await lightsOf(ip))
  }
  return Promise.all(
    devices.map(async (d): Promise<SendResult> => {
      try {
        if (d.transport === "hue") {
          if (!d.ip) return { device: d.name, ok: false, note: "no bridge IP in registry" }
          const resp = await hueApi(d.ip, `/lights/${d.id}/state`, { method: "PUT", body: JSON.stringify(verbs) })
          return { device: d.name, ...summarizeHueResponse(resp, lightState.get(d.ip)?.[d.id]?.state?.reachable) }
        }
        if (d.transport === "wiz") {
          const resp = await wizSend(d.ip ?? d.id, toWizParams(verbs))
          return resp?.error ? { device: d.name, ok: false, note: JSON.stringify(resp.error) } : { device: d.name, ok: true }
        }
        return { device: d.name, ok: false, note: `unsupported transport '${d.transport}'` }
      } catch (err) {
        return { device: d.name, ok: false, note: (err as Error).message }
      }
    }),
  )
}

// ── effects ─────────────────────────────────────────────────────────────────

function resolveFile(target: string): string | null {
  for (const p of [target, path.join(EFFECTS_DIR, target)]) if (fs.existsSync(p)) return path.resolve(p)
  return null
}

function sequences(): Record<string, unknown> {
  return { ...BUILTIN_SEQUENCES, ...readJson<Record<string, unknown>>(SEQUENCES, {}) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function playScene(devices: HomeDevice[], raw: unknown, loops: number, onStep: (r: SendResult[]) => void) {
  const scene = normalizeScene(raw)
  for (let n = 0; n < scene.repeat * loops; n++) {
    for (const step of scene.steps) {
      onStep(await sendTo(matchDevices(devices, step.room ?? "all"), stepVerbs(step)))
      await sleep(step.wait ?? 300)
    }
  }
}

// Python effect contract, same as the reference implementation: `def play(ctx)` with
// ctx.send(room, verbs), ctx.sleep(ms), ctx.COLORS, ctx.devices. The Python side only
// describes sends (one JSON line each); this process performs them, so effects never
// see a bridge key.
const PY_RUNNER = `
import json, sys, time, importlib.util
colors = json.loads(sys.argv[2]); devices = json.loads(sys.argv[3])
class Ctx:
    COLORS = colors
    devices = devices
    @staticmethod
    def send(*a):
        room, verbs = a[-2], a[-1]
        print(json.dumps({"room": room, "verbs": verbs}), flush=True)
    @staticmethod
    def sleep(ms): time.sleep(ms / 1000.0)
    @staticmethod
    def all(verbs): Ctx.send("all", verbs)
    @staticmethod
    def load_registry(): return {"devices": devices}
spec = importlib.util.spec_from_file_location("effect", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
if not hasattr(mod, "play"): sys.exit("effect must define play(ctx)")
mod.play(Ctx)
`

async function playPython(devices: HomeDevice[], file: string, onStep: (r: SendResult[]) => void): Promise<number> {
  const child = spawn("python3", ["-c", PY_RUNNER, file, JSON.stringify(COLORS), JSON.stringify(devices)], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  let queue = Promise.resolve()
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: any
    try { msg = JSON.parse(line) } catch { console.log(line); return }
    queue = queue.then(async () => onStep(await sendTo(matchDevices(devices, msg.room), msg.verbs)))
  })
  const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? 1)))
  await queue
  return code
}

async function playModule(devices: HomeDevice[], file: string, onStep: (r: SendResult[]) => void) {
  const mod = await import(pathToFileURL(file).href)
  const play = mod.play ?? mod.default
  if (typeof play !== "function") throw new Error("effect must export play(ctx)")
  await play({
    COLORS,
    devices,
    send: async (room: string, verbs: Verbs) => onStep(await sendTo(matchDevices(devices, room), verbs)),
    sleep,
    all: async (verbs: Verbs) => onStep(await sendTo(devices, verbs)),
  })
}

// ── output ──────────────────────────────────────────────────────────────────

function printResults(results: SendResult[]) {
  for (const r of results) console.log(r.ok ? `  ${success("✓")} ${r.device}` : `  ✗ ${r.device} ${dim("— " + r.note)}`)
}

function registryNotice(reg: Registry) {
  if (reg.warning) console.error(dim(`  ${reg.warning}`))
}

// ── commands ────────────────────────────────────────────────────────────────

async function listDevices(json: boolean) {
  const reg = await loadRegistry({ fresh: true })
  if (!reg.devices.length) {
    if (json) { await writeJson({ devices: [], source: reg.source }); return }
    console.log(`No devices yet. Pair a Hue bridge: ${bold("iris home devices pair-hue")}`)
    return
  }
  const states = new Map<string, any>()
  for (const ip of new Set(reg.devices.filter((d) => d.transport === "hue" && d.ip).map((d) => d.ip!))) {
    states.set(ip, await hueApi(ip, "/lights").catch(() => null))
  }
  const rows = reg.devices.map((d) => {
    const s = d.transport === "hue" ? states.get(d.ip ?? "")?.[d.id]?.state : undefined
    return { ...d, on: s?.on ?? null, reachable: s?.reachable ?? null }
  })
  if (json) { await writeJson({ devices: rows, source: reg.source }); return }
  UI.empty()
  prompts.intro(`◈  Home ${dim(`(${reg.source})`)}`)
  registryNotice(reg)
  printDivider()
  const byRoom = new Map<string, typeof rows>()
  for (const r of rows) byRoom.set(r.room || "—", [...(byRoom.get(r.room || "—") ?? []), r])
  for (const [room, list] of byRoom) {
    console.log(`  ${bold(room)}`)
    for (const r of list) {
      const state = r.reachable === false ? "unreachable" : r.on === null ? "?" : r.on ? "on" : "off"
      console.log(`    ${r.name.padEnd(24)} ${dim(r.transport.padEnd(4))} ${state}`)
    }
  }
  printDivider()
  prompts.outro(dim("iris home <room> <color|on|off|bri N>  ·  iris home run <scene.json|effect.py|sequence>"))
}

async function setState(words: string[], json: boolean) {
  const { room, verbs } = parseSetArgs(words)
  if (!verbs) {
    console.error(`Nothing to do with "${words.join(" ")}". Try: iris home ${room ?? "all"} warm  (colors: ${Object.keys(COLORS).join(", ")})`)
    process.exitCode = 1
    return
  }
  const reg = await loadRegistry()
  registryNotice(reg)
  const targets = matchDevices(reg.devices, room)
  if (!targets.length) {
    const rooms = [...new Set(reg.devices.map((d) => d.room))].join(", ") || "none — pair a bridge first"
    console.error(`No device matches '${room ?? "all"}'. Rooms: ${rooms}`)
    process.exitCode = 1
    return
  }
  const results = await sendTo(targets, verbs)
  if (json) await writeJson({ room, verbs, results })
  else printResults(results)
  if (results.every((r) => !r.ok)) process.exitCode = 1
}

const RunCommand = cmd({
  command: "run <target>",
  aliases: ["play"],
  describe: "play a scene (.json), an effect (.py/.js/.mjs), or a named sequence",
  builder: (y) =>
    y
      .positional("target", { type: "string", demandOption: true })
      .option("loops", { type: "number", default: 1, describe: "repeat the whole scene N times (.json/sequences)" })
      .option("quiet", { type: "boolean", default: false, describe: "only print failures" }),
  async handler(args) {
    const target = String(args.target)
    const reg = await loadRegistry()
    registryNotice(reg)
    if (!reg.devices.length) { console.error("No devices — run: iris home devices pair-hue"); process.exitCode = 1; return }
    let failures = 0
    const onStep = (rs: SendResult[]) => {
      failures += rs.filter((r) => !r.ok).length
      printResults(args.quiet ? rs.filter((r) => !r.ok) : rs)
    }
    try {
      const file = /\.(json|py|js|mjs)$/.test(target) ? resolveFile(target) : null
      if (/\.(json|py|js|mjs)$/.test(target) && !file) throw new Error(`no such file: ${target} (also looked in ${EFFECTS_DIR})`)
      if (file?.endsWith(".json")) await playScene(reg.devices, readJson(file, null), args.loops, onStep)
      else if (file?.endsWith(".py")) { if ((await playPython(reg.devices, file, onStep)) !== 0) process.exitCode = 1 }
      else if (file) await playModule(reg.devices, file, onStep)
      else {
        const seq = sequences()[target]
        if (!seq) throw new Error(`no sequence '${target}'. Have: ${Object.keys(sequences()).join(", ")}`)
        await playScene(reg.devices, seq, args.loops, onStep)
      }
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`)
      process.exitCode = 1
    }
    if (failures) console.error(dim(`  ${failures} send(s) failed`))
  },
})

const SequencesCommand = cmd({
  command: "sequences",
  aliases: ["scenes", "effects"],
  describe: "list named sequences and effect files",
  async handler() {
    const user = readJson<Record<string, unknown>>(SEQUENCES, {})
    console.log(bold("Sequences"))
    for (const name of Object.keys(sequences())) console.log(`  ${name}${name in user ? dim("  (yours)") : ""}`)
    const files = fs.existsSync(EFFECTS_DIR) ? fs.readdirSync(EFFECTS_DIR).filter((f) => /\.(json|py|js|mjs)$/.test(f)) : []
    console.log(bold(`Effects`) + dim(`  ${EFFECTS_DIR}`))
    for (const f of files) console.log(`  ${f}`)
    if (!files.length) console.log(dim("  none — drop a .py with def play(ctx) or a scene .json here"))
  },
})

// ── devices ─────────────────────────────────────────────────────────────────

const DevicesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show the device registry",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    await listDevices(args.json)
  },
})

const PairHueCommand = cmd({
  command: "pair-hue [ip]",
  describe: "pair a Philips Hue bridge (press its link button) and register its lights",
  builder: (y) =>
    y
      .positional("ip", { type: "string", describe: "bridge IP (discovered if omitted)" })
      .option("timeout", { type: "number", default: 30, describe: "seconds to wait for the link button" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Pair Hue bridge")
    let ip = args.ip
    if (!ip) {
      const found = (await fetch("https://discovery.meethue.com", { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json())
        .catch(() => [])) as { internalipaddress: string }[]
      if (!found.length) { prompts.log.error("No bridge discovered. Pass its IP: iris home devices pair-hue 192.168.x.x"); process.exitCode = 1; return }
      ip = found[0].internalipaddress
      prompts.log.info(`Found bridge at ${bold(ip)}${found.length > 1 ? dim(` (+${found.length - 1} more — pass an IP to choose)`) : ""}`)
    }
    if (!hueKey(ip)) {
      prompts.log.step("Press the round link button on top of the bridge…")
      const spinner = prompts.spinner()
      spinner.start("Waiting for link button")
      let username: string | null = null
      for (let t = 0; t < args.timeout && !username; t += 2) {
        const resp = (await fetch(`http://${ip}/api`, {
          method: "POST",
          body: JSON.stringify({ devicetype: `iris#${os.hostname().slice(0, 19)}` }),
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => r.json())
          .catch(() => null)) as any
        username = resp?.[0]?.success?.username ?? null
        if (!username) await sleep(2000)
      }
      if (!username) { spinner.stop("Timed out — link button not pressed", 1); process.exitCode = 1; return }
      writeLocal(BRIDGES, { ...readJson(BRIDGES, {}), [ip]: { username } }, 0o600)
      spinner.stop(`Paired ${dim(`(key saved locally: ${BRIDGES})`)}`)
    } else prompts.log.info("Bridge already paired on this machine")

    const [lights, groups] = await Promise.all([hueApi(ip, "/lights"), hueApi(ip, "/groups").catch(() => ({}))])
    const roomOf = new Map<string, string>()
    for (const g of Object.values<any>(groups ?? {})) {
      if (g?.type === "Room") for (const id of g.lights ?? []) roomOf.set(String(id), String(g.name).toLowerCase())
    }
    const devices: HomeDevice[] = Object.entries<any>(lights ?? {}).map(([id, l]) => ({
      id,
      name: l.name,
      room: roomOf.get(id) ?? String(l.name).split(/\s|-/)[0].toLowerCase(),
      transport: "hue",
      ip,
    }))
    if (!devices.length) { prompts.log.warn("Bridge has no lights"); prompts.outro("Done"); return }
    const { synced, error } = await upsertDevices(devices)
    for (const d of devices) console.log(`  ${d.name.padEnd(24)} ${dim(d.room)}`)
    if (error) prompts.log.warn(`Atlas: ${synced}/${devices.length} synced — ${error}. Saved to local cache; retry with: iris home devices sync`)
    prompts.outro(`${devices.length} light(s) registered${synced === devices.length ? ", synced to Atlas" : ""}. Try: iris home all warm`)
  },
})

const AddWizCommand = cmd({
  command: "add-wiz <ip>",
  describe: "register a WiZ bulb by IP (UDP 38899 — the bulb must be on this network)",
  builder: (y) =>
    y
      .positional("ip", { type: "string", demandOption: true })
      .option("name", { type: "string", demandOption: true })
      .option("room", { type: "string", demandOption: true }),
  async handler(args) {
    const ip = String(args.ip)
    try {
      await wizSend(ip, { state: true })
    } catch (err) {
      console.error(`✗ ${ip}: ${(err as Error).message} — not registered`)
      process.exitCode = 1
      return
    }
    const d: HomeDevice = { id: ip, name: args.name, room: args.room.toLowerCase(), transport: "wiz", ip }
    const { synced, error } = await upsertDevices([d])
    console.log(`${success("✓")} ${d.name} (${d.room})${synced ? " — synced to Atlas" : dim(` — local only: ${error}`)}`)
  },
})

const ImportCommand = cmd({
  command: "import <file>",
  describe: "import a registry.json (e.g. from the irishome prototype)",
  builder: (y) =>
    y
      .positional("file", { type: "string", demandOption: true })
      .option("hue-ip", { type: "string", describe: "bridge IP for hue devices that have none" })
      .option("hue-key", { type: "string", describe: "existing bridge key (saved locally, never uploaded)" }),
  async handler(args) {
    const raw = readJson<{ devices?: any[] }>(String(args.file), {})
    const devices: HomeDevice[] = (raw.devices ?? []).map((d) => ({
      id: String(d.id),
      name: d.name,
      room: String(d.room ?? "").toLowerCase(),
      transport: d.transport,
      ip: d.ip ?? (d.transport === "hue" ? args["hue-ip"] ?? null : null),
    }))
    if (!devices.length) { console.error(`No devices in ${args.file}`); process.exitCode = 1; return }
    const missing = devices.filter((d) => d.transport === "hue" && !d.ip)
    if (missing.length) { console.error(`${missing.length} hue device(s) have no bridge IP — pass --hue-ip`); process.exitCode = 1; return }
    if (args["hue-key"] && args["hue-ip"]) {
      writeLocal(BRIDGES, { ...readJson(BRIDGES, {}), [args["hue-ip"]]: { username: args["hue-key"] } }, 0o600)
    }
    const { synced, error } = await upsertDevices(devices)
    console.log(`${success("✓")} ${devices.length} device(s) imported; ${synced} synced to Atlas${error ? dim(` — ${error}`) : ""}`)
    if (error) process.exitCode = 1
  },
})

const SyncCommand = cmd({
  command: "sync",
  describe: "push the local registry cache to Atlas",
  async handler() {
    const devices = readJson<{ devices: HomeDevice[] }>(CACHE, { devices: [] }).devices ?? []
    if (!devices.length) { console.error("Local cache is empty — nothing to sync"); process.exitCode = 1; return }
    const { synced, error } = await upsertDevices(devices)
    console.log(`${synced}/${devices.length} device(s) synced to Atlas${error ? ` — ${error}` : ""}`)
    if (error) process.exitCode = 1
  },
})

const DevicesCommand = cmd({
  command: "devices",
  describe: "manage the home device registry (pair, add, import, sync)",
  builder: (y) =>
    y.command(DevicesListCommand).command(PairHueCommand).command(AddWizCommand).command(ImportCommand).command(SyncCommand).demandCommand(),
  async handler() {},
})

export const HomeCommand = cmd({
  command: "home [words..]",
  describe: "control smart-home lights — iris home living blue · iris home run party.py",
  builder: (y) =>
    // Room names are free text. Under the global strict() + recommendCommands(), "lights"
    // was answered "Did you mean list?" and "trey" "Did you mean play?" — nothing ran.
    // yargs accepts recommendCommands(false) at runtime; its typings omit the parameter.
    (y as unknown as { recommendCommands(on: boolean): typeof y })
      .recommendCommands(false)
      .command(RunCommand)
      .command(SequencesCommand)
      .command(DevicesCommand)
      .command(cmd({ command: "list", aliases: ["status"], describe: "devices by room with live state", builder: (b) => b.option("json", { type: "boolean", default: false }), handler: (a) => listDevices(a.json) }))
      .positional("words", { type: "string", array: true, describe: "<room> <color|on|off|bri N|#hex>" })
      .option("json", { type: "boolean", default: false })
      .strict(false),
  async handler(args) {
    const words = ((args.words as string[] | undefined) ?? []).map(String)
    if (!words.length) return listDevices(args.json)
    await setState(words, args.json)
  },
})
