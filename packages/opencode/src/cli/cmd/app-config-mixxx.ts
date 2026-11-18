/**
 * Mixxx adapter for `iris app-config` (#193298, feature #182011, mapping board #569).
 *
 * What makes a Mixxx setup work on a new machine is three things, and two of them are bound to
 * the machine they were made on:
 *
 *   controllers/*.midi.xml|*.js|*.hid.xml   portable as bytes: carried verbatim, sha256-checked
 *   mixxx.cfg [ControllerPreset]/[Controller] an ABSOLUTE path, keyed by the CoreMIDI port name:
 *                                           carried as the mapping's FILE NAME, rebuilt on apply,
 *                                           and enabled only for a controller that is plugged in
 *   soundconfig.xml                         routing keyed by `portAudioIndex`, which is a position
 *                                           in THIS machine's CoreAudio device list: carried by
 *                                           DEVICE NAME and re-resolved on apply
 *
 * The rest of mixxx.cfg (library paths, skin, window geometry, …) never leaves the machine, and
 * apply merges only the controller keys into the target's mixxx.cfg — it never replaces it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { basename, join, resolve } from "path"
import { sha256, type AppConfigAdapter, type AudioDevice, type Bundle, type Dropped, type Host, type PlanContext, type Problem } from "./app-config-engine"

export const SETUP_FILE = "mixxx-setup.json"
const CONTROLLER_FILE = /^controllers\/([^/\\]+\.(?:midi\.xml|hid\.xml|js))$/
const MAPPING_SUFFIX = /\.(midi\.xml|hid\.xml|js)$/
const CFG = "mixxx.cfg"
const SOUND = "soundconfig.xml"

// ── The setup record ────────────────────────────────────────────────────────────────────────

export interface ControllerEntry {
  /** The mixxx.cfg key: the controller's MIDI name with spaces → `_` ("PIONEER_DDJ-T1"). */
  key: string
  /** The mapping's file name — never its absolute path. */
  mapping: string
  /** "user" = carried in this bundle; "system" = ships inside Mixxx itself. */
  location: "user" | "system"
  enabled: boolean
}

export interface SoundIo {
  tag: "output" | "input"
  attrs: Record<string, string>
}

export interface SoundDeviceEntry {
  name: string
  /** Every SoundDevice attribute except `name` and `portAudioIndex`. */
  attrs: Record<string, string>
  io: SoundIo[]
}

export interface MixxxSetup {
  schema: 1
  controllers: ControllerEntry[]
  sound: { attrs: Record<string, string>; devices: SoundDeviceEntry[] } | null
}

// ── Key sanitization ────────────────────────────────────────────────────────────────────────

/**
 * Mixxx's own rule for turning a controller's name into a mixxx.cfg key: spaces and path
 * separators become `_`. Measured 2026-11-11: CoreMIDI "PIONEER DDJ-T1" → `PIONEER_DDJ-T1`.
 */
export function controllerKey(midiName: string): string {
  return midiName.trim().replace(/[ /\\]/g, "_")
}

// ── mixxx.cfg ───────────────────────────────────────────────────────────────────────────────

/** `[Section]` → { KEY: value }. Mixxx writes `KEY value`, one space, value may contain spaces. */
export function parseMixxxCfg(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let current: Map<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const head = line.match(/^\[(.+)\]$/)
    if (head) {
      current = out.get(head[1]) ?? new Map()
      out.set(head[1], current)
      continue
    }
    if (!current || !line.trim()) continue
    const i = line.indexOf(" ")
    const key = i < 0 ? line : line.slice(0, i)
    if (!current.has(key)) current.set(key, i < 0 ? "" : line.slice(i + 1))
  }
  return out
}

export interface CfgEntry {
  section: string
  key: string
  value: string
}

/**
 * Sets each entry in place and leaves every other byte alone, so a cfg that already holds the
 * entries comes back identical (that is what makes a second apply a no-op). A section is never
 * added twice; a key repeated inside a section, or across a section written twice, keeps only
 * its first line — which is what Mixxx reads.
 */
export function mergeMixxxCfg(text: string | null, entries: CfgEntry[]): string {
  const lines = (text ?? "").split("\n")
  const hadTrailingNewline = text === null || text.endsWith("\n")
  if (text !== null && hadTrailingNewline) lines.pop()
  if (text === null || text === "") lines.length = 0

  const sectionAt = (i: number) => lines[i].replace(/\r$/, "").match(/^\[(.+)\]$/)?.[1]
  const keyOf = (line: string) => {
    const l = line.replace(/\r$/, "")
    const i = l.indexOf(" ")
    return i < 0 ? l : l.slice(0, i)
  }

  for (const e of entries) {
    const want = `${e.key} ${e.value}`
    let section: string | undefined
    let firstHead = -1
    let found = false
    const drop: number[] = []
    for (let i = 0; i < lines.length; i++) {
      const s = sectionAt(i)
      if (s !== undefined) {
        section = s
        if (s === e.section && firstHead < 0) firstHead = i
        continue
      }
      if (section !== e.section || !lines[i].trim() || keyOf(lines[i]) !== e.key) continue
      if (found) drop.push(i)
      else {
        if (lines[i].replace(/\r$/, "") !== want) lines[i] = want
        found = true
      }
    }
    for (const i of drop.reverse()) lines.splice(i, 1)
    if (found) continue
    if (firstHead >= 0) {
      // End of the first copy of the section, before its trailing blank lines.
      let end = firstHead + 1
      while (end < lines.length && sectionAt(end) === undefined) end++
      while (end > firstHead + 1 && !lines[end - 1].trim()) end--
      lines.splice(end, 0, want)
      continue
    }
    if (lines.length && lines[lines.length - 1].trim()) lines.push("")
    lines.push(`[${e.section}]`, want)
  }
  return lines.join("\n") + (lines.length && (hadTrailingNewline || !text) ? "\n" : "")
}

// ── soundconfig.xml ─────────────────────────────────────────────────────────────────────────

const decode = (v: string) =>
  v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
const encode = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2])
  return out
}

export interface ParsedSoundConfig {
  attrs: Record<string, string>
  devices: (SoundDeviceEntry & { portAudioIndex: string | undefined })[]
}

/** Mixxx's soundconfig.xml is flat and machine-written; a regex reader is enough and has no deps. */
export function parseSoundConfig(text: string): ParsedSoundConfig | null {
  const root = text.match(/<SoundManagerConfig\b([^>]*?)\/?>/)
  if (!root) return null
  const devices: ParsedSoundConfig["devices"] = []
  for (const m of text.matchAll(/<SoundDevice\b([^>]*?)(\/>|>([\s\S]*?)<\/SoundDevice>)/g)) {
    const { name, portAudioIndex, ...attrs } = attrsOf(m[1])
    if (name === undefined) continue
    const io: SoundIo[] = []
    for (const c of (m[3] ?? "").matchAll(/<(output|input)\b([^>]*?)\/?>/g)) io.push({ tag: c[1] as SoundIo["tag"], attrs: attrsOf(c[2]) })
    devices.push({ name, portAudioIndex, attrs, io })
  }
  return { attrs: attrsOf(root[1]), devices }
}

const attrString = (a: Record<string, string>) =>
  Object.keys(a)
    .sort()
    .map((k) => ` ${k}="${encode(a[k])}"`)
    .join("")

/** Written the way Mixxx (QDom, indent 1) writes it, attributes in Qt's sorted order. */
export function renderSoundConfig(attrs: Record<string, string>, devices: (SoundDeviceEntry & { portAudioIndex: number })[]): string {
  const out = ["<!DOCTYPE SoundManagerConfig>", `<SoundManagerConfig${attrString(attrs)}>`]
  for (const d of devices) {
    out.push(` <SoundDevice${attrString({ ...d.attrs, name: d.name, portAudioIndex: String(d.portAudioIndex) })}>`)
    for (const c of d.io) out.push(`  <${c.tag}${attrString(c.attrs)}/>`)
    out.push(" </SoundDevice>")
  }
  out.push("</SoundManagerConfig>")
  return out.join("\n") + "\n"
}

/** Order-free form, so a file Mixxx re-wrote in a different device order still counts as equal. */
function soundKey(attrs: Record<string, string>, devices: { name: string; portAudioIndex: string | number | undefined; attrs: Record<string, string>; io: SoundIo[] }[]): string {
  const sortObj = (a: Record<string, string>) => Object.fromEntries(Object.keys(a).sort().map((k) => [k, a[k]]))
  return JSON.stringify({
    attrs: sortObj(attrs),
    devices: devices
      .map((d) => ({
        name: d.name,
        index: String(d.portAudioIndex ?? ""),
        attrs: sortObj(d.attrs),
        io: d.io.map((c) => JSON.stringify([c.tag, sortObj(c.attrs)])).sort(),
      }))
      .sort((a, b) => (a.name + a.index).localeCompare(b.name + b.index)),
  })
}

export interface ResolvedDevice extends SoundDeviceEntry {
  portAudioIndex: number
}

/**
 * The device-name → index step. On macOS PortAudio numbers devices in CoreAudio's
 * kAudioHardwarePropertyDevices order (2026-11-11 on iris-hive-002: Built-in Microphone 0,
 * Built-in Output 1, PIONEER DDJ-T1 2). A name used by two devices takes the first and says so.
 */
export function resolveAudioDevices(
  wanted: SoundDeviceEntry[],
  present: AudioDevice[],
): { resolved: ResolvedDevice[]; missing: string[]; ambiguous: string[] } {
  const resolved: ResolvedDevice[] = []
  const missing: string[] = []
  const ambiguous: string[] = []
  for (const d of wanted) {
    const hits = present.map((p, i) => (p.name === d.name ? i : -1)).filter((i) => i >= 0)
    if (!hits.length) {
      missing.push(d.name)
      continue
    }
    if (hits.length > 1) ambiguous.push(d.name)
    resolved.push({ ...d, portAudioIndex: hits[0] })
  }
  return { resolved, missing, ambiguous }
}

// ── Where Mixxx keeps its profile ───────────────────────────────────────────────────────────

export function sandboxDir(home: string): string {
  return join(home, "Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx")
}

function systemControllersDir(host: Host): string {
  if (host.platform === "darwin") return "/Applications/Mixxx.app/Contents/Resources/controllers"
  if (host.platform === "win32") return join(host.env.ProgramFiles ?? "C:\\Program Files", "Mixxx", "controllers")
  return "/usr/share/mixxx/controllers"
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────

function collect(configDir: string, host: Host): { files: Record<string, string>; dropped: Dropped[]; info: Record<string, unknown> } {
  const files: Record<string, string> = {}
  const dropped: Dropped[] = []
  const ctlDir = join(configDir, "controllers")
  const shas: Record<string, string> = {}
  if (existsSync(ctlDir)) {
    for (const name of readdirSync(ctlDir).sort()) {
      if (!MAPPING_SUFFIX.test(name) || !statSync(join(ctlDir, name)).isFile()) continue
      const bytes = readFileSync(join(ctlDir, name))
      const text = bytes.toString("utf8")
      // The bundle is JSON text: a file that does not survive UTF-8 is left out, not mangled.
      if (sha256(Buffer.from(text, "utf8")) !== sha256(bytes)) {
        dropped.push({ file: `controllers/${name}`, path: "(not UTF-8 text)", reason: "not-portable" })
        continue
      }
      files[`controllers/${name}`] = text
      shas[name] = sha256(bytes)
    }
  }

  const controllers: ControllerEntry[] = []
  const cfgPath = join(configDir, CFG)
  if (existsSync(cfgPath)) {
    const cfg = parseMixxxCfg(readFileSync(cfgPath, "utf8"))
    const presets = cfg.get("ControllerPreset") ?? new Map()
    const enabled = cfg.get("Controller") ?? new Map()
    const userDir = resolve(ctlDir)
    for (const [key, path] of presets) {
      if (!path) continue
      const mapping = basename(path.replace(/\\/g, "/"))
      const inUser = resolve(path).startsWith(userDir + "/") || resolve(path).startsWith(userDir + "\\")
      if (inUser && files[`controllers/${mapping}`] === undefined) {
        dropped.push({ file: CFG, path: `[ControllerPreset] ${key} (mapping file not found)`, reason: "unmapped-path" })
        continue
      }
      controllers.push({ key, mapping, location: inUser ? "user" : "system", enabled: enabled.get(key) === "1" })
    }
  }

  let sound: MixxxSetup["sound"] = null
  const soundPath = join(configDir, SOUND)
  if (existsSync(soundPath)) {
    const parsed = parseSoundConfig(readFileSync(soundPath, "utf8"))
    if (parsed) {
      sound = { attrs: parsed.attrs, devices: parsed.devices.map(({ portAudioIndex: _, ...d }) => d) }
      for (const d of parsed.devices) {
        if (d.portAudioIndex !== undefined) dropped.push({ file: SOUND, path: `SoundDevice "${d.name}" portAudioIndex`, reason: "machine-bound" })
      }
    }
  }

  const setup: MixxxSetup = { schema: 1, controllers, sound }
  files[SETUP_FILE] = JSON.stringify(setup, null, 2) + "\n"
  return {
    files,
    dropped,
    info: {
      controllers: controllers.map((c) => ({ key: c.key, mapping: c.mapping, enabled: c.enabled })),
      mapping_sha256: shas,
      audio_devices: sound?.devices.map((d) => d.name) ?? [],
      platform: host.platform,
    },
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────

export function readSetup(bundle: Bundle): MixxxSetup {
  const text = bundle.files[SETUP_FILE]
  if (text === undefined) throw new Error(`the bundle has no ${SETUP_FILE}`)
  const setup = JSON.parse(text) as MixxxSetup
  if (setup.schema !== 1 || !Array.isArray(setup.controllers)) throw new Error(`unsupported ${SETUP_FILE}; update iris`)
  for (const c of setup.controllers) {
    if (!/^[^\s[\]]+$/.test(c.key) || !MAPPING_SUFFIX.test(c.mapping) || /[/\\]/.test(c.mapping)) {
      throw new Error(`${SETUP_FILE} names a controller entry it may not write: ${JSON.stringify(c.key)}`)
    }
  }
  return setup
}

export interface MixxxPlan {
  files: Record<string, string>
  /** Controllers enabled in the bundle and plugged in here: key → the MIDI name it was found under. */
  enabled: Map<string, string>
  /** Controllers enabled in the bundle but not plugged in here (or MIDI could not be listed). */
  absentControllers: string[]
  audio: ResolvedDevice[]
  absentAudio: string[]
  notes: string[]
}

export function planMixxx(bundle: Bundle, ctx: PlanContext, read: (rel: string) => string | null): MixxxPlan {
  const setup = readSetup(bundle)
  const files: Record<string, string> = {}
  const notes: string[] = []
  for (const rel of Object.keys(bundle.files)) {
    if (CONTROLLER_FILE.test(rel)) files[rel] = bundle.files[rel]
  }

  // Controllers: enable only what CoreMIDI can see right now.
  const midi = ctx.host.midiDevices?.() ?? null
  if (midi === null) notes.push("Could not list MIDI devices here, so no controller was enabled.")
  const byKey = new Map<string, string>()
  for (const name of midi ?? []) if (!byKey.has(controllerKey(name))) byKey.set(controllerKey(name), name)

  const enabled = new Map<string, string>()
  const absentControllers: string[] = []
  const entries: CfgEntry[] = []
  for (const c of setup.controllers) {
    if (!c.enabled) continue
    const midiName = byKey.get(c.key)
    if (midiName === undefined) {
      absentControllers.push(c.key)
      continue
    }
    const dir = c.location === "user" ? join(ctx.configDir, "controllers") : systemControllersDir(ctx.host)
    entries.push({ section: "ControllerPreset", key: c.key, value: join(dir, c.mapping) })
    entries.push({ section: "Controller", key: c.key, value: "1" })
    enabled.set(c.key, midiName)
  }
  if (entries.length) {
    const current = read(CFG)
    const merged = mergeMixxxCfg(current, entries)
    if (merged !== current) files[CFG] = merged
  }

  // Audio: the bundle says which device by NAME; the index is this machine's.
  let audio: ResolvedDevice[] = []
  let absentAudio: string[] = []
  if (setup.sound && setup.sound.devices.length) {
    const present = ctx.host.audioDevices?.() ?? null
    if (present === null) {
      notes.push("Could not list audio devices here, so soundconfig.xml was left as it is.")
      absentAudio = setup.sound.devices.map((d) => d.name)
    } else {
      const r = resolveAudioDevices(setup.sound.devices, present)
      audio = r.resolved
      absentAudio = r.missing
      for (const name of r.ambiguous) notes.push(`Two audio devices are called "${name}"; used the first.`)
      if (audio.length) {
        const current = read(SOUND)
        const parsed = current === null ? null : parseSoundConfig(current)
        const same = parsed !== null && soundKey(parsed.attrs, parsed.devices) === soundKey(setup.sound.attrs, audio)
        if (!same) files[SOUND] = renderSoundConfig(setup.sound.attrs, audio)
      }
    }
  }
  for (const d of audio) notes.push(`Audio: "${d.name}" is device ${d.portAudioIndex} here (${d.io.map((c) => c.attrs.type ?? c.tag).join(", ")}).`)
  return { files, enabled, absentControllers, audio, absentAudio, notes }
}

function isPristine(configDir: string): boolean {
  const ctlDir = join(configDir, "controllers")
  if (existsSync(ctlDir) && readdirSync(ctlDir).some((n) => MAPPING_SUFFIX.test(n))) return false
  const cfgPath = join(configDir, CFG)
  if (!existsSync(cfgPath)) return true
  return (parseMixxxCfg(readFileSync(cfgPath, "utf8")).get("ControllerPreset")?.size ?? 0) === 0
}

const readFrom = (dir: string) => (rel: string) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null)

function plan(bundle: Bundle, ctx: PlanContext) {
  const p = planMixxx(bundle, ctx, readFrom(ctx.configDir))
  return { files: p.files, dropped: [], notes: p.notes }
}

function verify(read: (rel: string) => string | null, bundle: Bundle, ctx: PlanContext): Problem[] {
  const problems: Problem[] = []
  for (const rel of Object.keys(bundle.files)) {
    if (!CONTROLLER_FILE.test(rel)) continue
    const text = read(rel)
    if (text === null || sha256(text) !== bundle.manifest.files[rel].sha256) {
      problems.push({ kind: "read-back", message: `${rel} is not the mapping in the bundle (sha256 differs)` })
    }
  }
  // `read` already shows the result, so planning against it yields what is still missing.
  const p = planMixxx(bundle, ctx, read)
  const cfg = parseMixxxCfg(read(CFG) ?? "")
  for (const key of p.enabled.keys()) {
    if (cfg.get("Controller")?.get(key) !== "1" || !cfg.get("ControllerPreset")?.get(key)) {
      problems.push({ kind: "read-back", message: `mixxx.cfg does not enable ${key}` })
    }
  }
  for (const key of p.absentControllers) {
    problems.push({ kind: "missing-device", message: `controller ${key} is not connected; its mapping is installed but not enabled — plug it in and run apply again` })
  }
  for (const name of p.absentAudio) {
    problems.push({ kind: "missing-device", message: `audio device "${name}" is not connected; its routing was not written` })
  }
  return problems
}

export const MIXXX_PROCESSES = new Set(["mixxx", "mixxx.exe"])

export const mixxxAdapter: AppConfigAdapter = {
  id: "mixxx",
  label: "Mixxx",
  runningReason: "Mixxx rewrites mixxx.cfg and soundconfig.xml when it quits, which would undo this apply.",
  defaultConfigDir(host) {
    if (host.platform === "darwin") {
      const sandboxed = sandboxDir(host.home)
      return existsSync(sandboxed) ? sandboxed : join(host.home, "Library/Application Support/Mixxx")
    }
    if (host.platform === "win32") return join(host.env.LOCALAPPDATA ?? join(host.home, "AppData/Local"), "Mixxx")
    return join(host.home, ".mixxx")
  },
  runningProcess(names) {
    for (const name of names) {
      const base = name.trim().split(/[\\/]/).pop()?.toLowerCase() ?? ""
      if (MIXXX_PROCESSES.has(base)) return base
    }
    return null
  },
  isBundlePath(rel) {
    if (rel === SETUP_FILE) return true
    const name = rel.match(CONTROLLER_FILE)?.[1]
    return name !== undefined && !name.startsWith(".") && !name.includes("\0")
  },
  isPristine,
  collect: (configDir, host) => collect(configDir, host),
  plan,
  verify,
}
