/**
 * OBS Studio adapter for `iris app-config` (#191960).
 *
 * A copy of OBS's config does not survive a new machine: encoder, canvas and device fields are
 * hardware-bound, sources hold absolute paths, third-party plugins fail silently, and secrets
 * sit in plain text. So this reads an ALLOWLIST of files and works out, per field, what to keep,
 * rewrite or drop. Anything not listed never leaves the machine.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { redactSecrets } from "../../util/redact-secrets"
import { mapPath, type AppConfigAdapter, type Bundle, type Dropped, type Host, type PlanContext, type Problem } from "./app-config-engine"

const REDACTED = "REDACTED"
const WS_CONFIG = "plugin_config/obs-websocket/config.json"
const SCENE_PATH = /^basic\/scenes\/([^/\\]+\.json)$/
const PROFILE_PATH = /^basic\/profiles\/([^/\\]+)\/(basic\.ini|service\.json)$/

// ── Fields that belong to the machine, not the person ───────────────────────────────────────

/** Taken from the target (or OBS's own defaults) rather than from the bundle. */
const HARDWARE_INI: Record<string, string[]> = {
  Video: ["BaseCX", "BaseCY", "OutputCX", "OutputCY", "ColorFormat", "ColorSpace", "ColorRange", "SdrWhiteLevel", "HdrNominalPeakLevel"],
  SimpleOutput: ["StreamEncoder", "RecEncoder", "StreamAudioEncoder", "RecAudioEncoder"],
  AdvOut: ["Encoder", "RecEncoder", "AudioEncoder", "RecAudioEncoder", "FFVEncoder", "FFVEncoderId", "FFAEncoder", "FFAEncoderId"],
  Audio: ["MonitoringDeviceId", "MonitoringDeviceName"],
}
/** Absolute paths outside any source: rewritten by --map-media, otherwise dropped. */
const PATH_INI: Record<string, string[]> = {
  SimpleOutput: ["FilePath"],
  AdvOut: ["RecFilePath", "FFFilePath"],
}
const DEVICE_KEYS = new Set([
  "device", "device_id", "device_name", "video_device_id", "audio_device_id", "monitor", "monitor_id",
  "monitor_wgc", "display", "display_uuid", "window", "capture_window",
])
const CAPTURE_SOURCE = /capture|dshow|v4l2|pulse|wasapi|alsa|jack|coreaudio|xshm|xcomposite|pipewire|decklink/

// ── Secrets ─────────────────────────────────────────────────────────────────────────────────

const SECRET_KEY = /pass(word|wd|phrase|key)|secret|token|stream_?key|api_?key|credential|oauth|bearer|private_?key|auth_?key|cookie/i
/** Whole profile sections holding service logins (Token, RefreshToken and so on). */
const AUTH_SECTIONS = new Set(["Auth", "Twitch", "YouTube", "Restream", "Trovo", "Kick"])
/** service.json is an allowlist: a credential field added by a later OBS stays out by default. */
const SERVICE_KEEP = new Set(["service", "server", "protocol", "bwtest", "stream_key_link", "more_info_link", "multitrack_video_name"])

function isSecretField(key: string, value: unknown): boolean {
  if (key === "key" && typeof value === "string") return !value.startsWith("OBS_KEY")
  if (value === null || typeof value === "boolean" || typeof value === "number") return false
  return SECRET_KEY.test(key)
}

function isSecretIni(section: string, key: string): boolean {
  return AUTH_SECTIONS.has(section) || SECRET_KEY.test(key) || key === "FFURL"
}

const NETWORK_URL = /^(https?|rtmps?|srt|rist|wss?):\/\//i
const SECRET_PARAM = /pass|secret|token|key|auth|sig|session|code/i
/** A long opaque path segment is how alert-box and ingest URLs carry their credential. */
const isOpaque = (segment: string) =>
  /^[A-Za-z0-9_-]{20,}$/.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)

/** Returns the URL with credentials removed, or the original string untouched. */
export function scrubUrl(value: string): string {
  if (!NETWORK_URL.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return REDACTED
  }
  let dirty = false
  if (url.username || url.password) {
    url.username = ""
    url.password = ""
    dirty = true
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) {
      url.searchParams.set(name, REDACTED)
      dirty = true
    }
  }
  const segments = url.pathname.split("/")
  if (segments.some(isOpaque)) {
    url.pathname = segments.map((s) => (isOpaque(s) ? REDACTED : s)).join("/")
    dirty = true
  }
  return dirty ? url.toString() : value
}

// ── INI, edited line by line so everything else stays byte-identical ────────────────────────

const SECTION_LINE = /^\s*\[([^\]]+)\]\s*$/

function iniEntries(text: string): { section: string; key: string; value: string }[] {
  const out: { section: string; key: string; value: string }[] = []
  let section = ""
  for (const line of text.split(/\r?\n/)) {
    const header = line.replace(/^\uFEFF/, "").match(SECTION_LINE)
    if (header) {
      section = header[1]
      continue
    }
    const eq = line.indexOf("=")
    if (eq > 0) out.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
  }
  return out
}

function iniGet(text: string, section: string, key: string): string | undefined {
  return iniEntries(text).find((e) => e.section === section && e.key === key)?.value
}

function iniFilter(text: string, keep: (section: string, key: string, value: string) => boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  let section = ""
  const lines = text.split(/\r?\n/).filter((line) => {
    const header = line.replace(/^\uFEFF/, "").match(SECTION_LINE)
    if (header) {
      section = header[1]
      return true
    }
    const eq = line.indexOf("=")
    return eq <= 0 || keep(section, line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  })
  return lines.join(eol)
}

/** Replaces a key, or adds it directly under its section, creating the section if needed. */
function iniSet(text: string, section: string, key: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.length ? text.split(/\r?\n/) : []
  let current = ""
  let headerAt = -1
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].replace(/^\uFEFF/, "").match(SECTION_LINE)
    if (header) {
      current = header[1]
      if (current === section && headerAt < 0) headerAt = i
      continue
    }
    const eq = lines[i].indexOf("=")
    if (current === section && eq > 0 && lines[i].slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`
      return lines.join(eol)
    }
  }
  if (headerAt >= 0) {
    lines.splice(headerAt + 1, 0, `${key}=${value}`)
    return lines.join(eol)
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (lines.length) lines.push("")
  lines.push(`[${section}]`, `${key}=${value}`, "")
  return lines.join(eol)
}

// ── Scene JSON ──────────────────────────────────────────────────────────────────────────────

type Scrubbed = { reason: Dropped["reason"]; path: string }

/** Removes secrets and device bindings in place, reporting field names and never values. */
function scrubNode(node: any, path: string, opts: { secrets: boolean }, out: Scrubbed[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => scrubNode(child, `${path}[${i}]`, opts, out))
    return
  }
  if (!node || typeof node !== "object") return
  if (typeof node.id === "string" && node.settings && typeof node.settings === "object" && CAPTURE_SOURCE.test(node.id)) {
    for (const key of Object.keys(node.settings)) {
      if (DEVICE_KEYS.has(key) && node.settings[key] !== "default" && node.settings[key] !== "") {
        delete node.settings[key]
        out.push({ reason: "machine-bound", path: `${path}.settings.${key}` })
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "hotkeys") continue
    const value = node[key]
    const here = path ? `${path}.${key}` : key
    if (opts.secrets && isSecretField(key, value)) {
      if (value !== "") out.push({ reason: "secret", path: here })
      delete node[key]
    } else if (opts.secrets && typeof value === "string") {
      const clean = scrubUrl(value)
      if (clean !== value) {
        node[key] = clean
        out.push({ reason: "secret", path: here })
      }
    } else {
      scrubNode(value, here, opts, out)
    }
  }
}

const ABSOLUTE_PATH = /^(file:\/\/\/?|[A-Za-z]:[\\/]|\\\\|\/[^\s/*])/
/** Free text and code, where a leading slash means nothing. */
const NOT_PATHS = new Set(["text", "css", "hotkeys"])

function pathsIn(node: any, out: string[]): void {
  if (typeof node === "string") {
    if (ABSOLUTE_PATH.test(node) && !node.startsWith("/dev/") && !node.includes("\n")) out.push(node)
  } else if (Array.isArray(node)) {
    for (const child of node) pathsIn(child, out)
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (!NOT_PATHS.has(key)) pathsIn(value, out)
    }
  }
}

/** Sources, transitions and scripts, each with the paths it needs to load. */
function sceneReferences(scene: any): { name: string; paths: string[] }[] {
  const refs: { name: string; paths: string[] }[] = []
  for (const list of [scene?.sources, scene?.transitions]) {
    for (const s of Array.isArray(list) ? list : []) {
      const paths: string[] = []
      pathsIn(s?.settings, paths)
      for (const f of Array.isArray(s?.filters) ? s.filters : []) pathsIn(f?.settings, paths)
      refs.push({ name: String(s?.name ?? s?.id ?? "?"), paths })
    }
  }
  for (const script of scriptEntries(scene)) refs.push({ name: `script ${script}`, paths: [script] })
  return refs
}

function scriptEntries(scene: any): string[] {
  const scripts = scene?.modules?.["scripts-tool"]
  return (Array.isArray(scripts) ? scripts : []).map((s: any) => s?.path).filter((p: any) => typeof p === "string")
}

function mapStrings(node: any, ctx: PlanContext): any {
  if (typeof node === "string") return mapPath(node, ctx.maps) ?? node
  if (Array.isArray(node)) return node.map((child) => mapStrings(child, ctx))
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, NOT_PATHS.has(k) ? v : mapStrings(v, ctx)]),
    )
  }
  return node
}

// ── Plugins ─────────────────────────────────────────────────────────────────────────────────

const BUILTIN_COMMON = new Set([
  "scene", "group", "image_source", "color_source", "slideshow", "browser_source", "ffmpeg_source", "vlc_source",
  "audio_line", "cut_transition", "fade_transition", "swipe_transition", "slide_transition", "obs_stinger_transition",
  "fade_to_color_transition", "wipe_transition", "color_filter", "color_key_filter", "chroma_key_filter", "crop_filter",
  "gain_filter", "noise_gate_filter", "noise_suppress_filter", "compressor_filter", "expander_filter",
  "upward_compressor_filter", "limiter_filter", "mask_filter", "scale_filter", "scroll_filter", "sharpness_filter",
  "gpu_delay", "async_delay_filter", "vst_filter", "invert_polarity_filter", "luma_key_filter", "hdr_tonemap_filter",
  "basic_eq_filter",
])
const BUILTIN_BY_OS: Record<string, Set<string>> = {
  darwin: new Set(["coreaudio_input_capture", "coreaudio_output_capture", "av_capture_input", "macos-avcapture", "macos-avcapture-fast", "screen_capture", "display_capture", "window_capture", "syphon-input", "sck_audio_capture", "text_ft2_source", "decklink-input"]),
  win32: new Set(["wasapi_input_capture", "wasapi_output_capture", "wasapi_process_output_capture", "dshow_input", "monitor_capture", "window_capture", "game_capture", "text_gdiplus", "decklink-input"]),
  linux: new Set(["pulse_input_capture", "pulse_output_capture", "alsa_input_capture", "jack_output_capture", "v4l2_input", "xshm_input", "xcomposite_input", "pipewire-desktop-capture-source", "pipewire-screen-capture-source", "pipewire-window-capture-source", "text_ft2_source", "decklink-input"]),
}

const baseId = (id: string) => id.replace(/_v\d+$/, "")

function isBuiltin(id: string, platform: string): boolean {
  const base = baseId(id)
  return BUILTIN_COMMON.has(base) || !!BUILTIN_BY_OS[platform]?.has(base)
}

function kindsIn(scene: any): { id: string; source: string }[] {
  const out: { id: string; source: string }[] = []
  for (const s of Array.isArray(scene?.sources) ? scene.sources : []) {
    if (typeof s?.id === "string") out.push({ id: s.id, source: String(s.name ?? s.id) })
    for (const f of Array.isArray(s?.filters) ? s.filters : []) {
      if (typeof f?.id === "string") out.push({ id: f.id, source: `${s?.name ?? "?"} / filter ${f.name ?? f.id}` })
    }
  }
  for (const t of Array.isArray(scene?.transitions) ? scene.transitions : []) {
    if (typeof t?.id === "string") out.push({ id: t.id, source: `transition ${t.name ?? t.id}` })
  }
  return out
}

function pluginDirs(host: Host, configDir: string): string[] {
  const dirs = [join(configDir, "plugins")]
  if (host.platform === "win32") dirs.push("C:/ProgramData/obs-studio/plugins", "C:/Program Files/obs-studio/obs-plugins/64bit")
  if (host.platform === "linux") {
    dirs.push("/usr/lib/obs-plugins", "/usr/lib/x86_64-linux-gnu/obs-plugins", "/usr/local/lib/obs-plugins")
  }
  return dirs
}

function installedPlugins(host: Host, configDir: string): string[] {
  const names = new Set<string>()
  for (const dir of pluginDirs(host, configDir)) {
    try {
      for (const entry of readdirSync(dir)) names.add(entry.replace(/\.(plugin|dll|so)$/i, ""))
    } catch {
      /* absent is the normal case */
    }
  }
  return [...names].sort()
}

/**
 * A scene names a source kind, not the plugin providing it, and nothing on disk maps one to the
 * other without running OBS. So a name match is a best guess, and no match is reported: a
 * false alarm costs a glance, a silent gap costs a broken show.
 */
function pluginLooksInstalled(id: string, installed: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const wanted = norm(baseId(id))
  return wanted.length >= 4 && installed.some((p) => {
    const have = norm(p)
    return have.length >= 4 && (have.includes(wanted) || wanted.includes(have))
  })
}

// ── Reading the source machine ──────────────────────────────────────────────────────────────

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function encoderClass(encoder: string | undefined): string {
  if (!encoder) return "unknown"
  const e = encoder.toLowerCase()
  if (e.includes("x264")) return "software-x264"
  if (e.includes("nvenc")) return "nvenc"
  if (e.includes("apple") || e.includes("videotoolbox")) return "videotoolbox"
  if (e.includes("qsv") || e.includes("quicksync")) return "quicksync"
  if (e.includes("amd") || e.includes("amf")) return "amf"
  if (e.includes("vaapi")) return "vaapi"
  return "other"
}

/** OBS stores its version as major<<24 | minor<<16 | patch. */
function decodeVersion(raw: string | undefined): string | null {
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n <= 0) return null
  return `${n >>> 24}.${(n >>> 16) & 0xff}.${n & 0xffff}`
}

function collect(configDir: string, host: Host, opts: { includeSecrets: boolean }) {
  const scrubSecrets = !opts.includeSecrets
  const files: Record<string, string> = {}
  const dropped: Dropped[] = []
  const known = new Set<string>()
  const remember = (v: unknown) => {
    if (typeof v === "string" && v.length >= 6) known.add(v)
  }
  const read = (rel: string) => readFileSync(join(configDir, rel), "utf8")
  const exists = (rel: string) => existsSync(join(configDir, rel))

  // The app-wide inis hold window geometry and the renderer, and older OBS keeps the websocket
  // password there. They are never bundled; apply writes only the pointers below.
  let active: Record<string, string | undefined> = {}
  let version: string | null = null
  for (const rel of ["user.ini", "global.ini"]) {
    if (!exists(rel)) continue
    const text = read(rel)
    for (const e of iniEntries(text)) {
      if (isSecretIni(e.section, e.key) && e.value) {
        remember(e.value)
        dropped.push({ file: rel, path: `${e.section}.${e.key}`, reason: "secret" })
      }
    }
    dropped.push({ file: rel, path: "*", reason: "machine-bound" })
    version ??= decodeVersion(iniGet(text, "General", "LastVersion"))
    if (!active.profile && iniGet(text, "Basic", "Profile")) {
      active = {
        profile: iniGet(text, "Basic", "Profile"),
        profileDir: iniGet(text, "Basic", "ProfileDir"),
        collection: iniGet(text, "Basic", "SceneCollection"),
        collectionFile: iniGet(text, "Basic", "SceneCollectionFile"),
      }
    }
  }

  if (exists(WS_CONFIG)) {
    if (opts.includeSecrets) {
      files[WS_CONFIG] = read(WS_CONFIG)
    } else {
      // Left out whole: auth_required and server_enabled without their password could open the
      // socket on the target, and the target's own settings are the safe ones to keep.
      try {
        const ws = JSON.parse(read(WS_CONFIG))
        remember(ws?.server_password)
        if (ws?.server_password) dropped.push({ file: WS_CONFIG, path: "server_password", reason: "secret" })
      } catch {
        /* it was never going to be bundled */
      }
      dropped.push({ file: WS_CONFIG, path: "*", reason: "not-portable" })
    }
  }

  let canvas: Record<string, string | undefined> = {}
  let encoder: string | undefined
  const profiles = listDir(join(configDir, "basic/profiles")).filter((p) => statSync(join(configDir, "basic/profiles", p)).isDirectory())
  for (const profile of profiles) {
    const iniRel = `basic/profiles/${profile}/basic.ini`
    if (exists(iniRel)) {
      const text = read(iniRel)
      if (profile === active.profileDir || !canvas.base) {
        canvas = {
          base: `${iniGet(text, "Video", "BaseCX")}x${iniGet(text, "Video", "BaseCY")}`,
          output: `${iniGet(text, "Video", "OutputCX")}x${iniGet(text, "Video", "OutputCY")}`,
        }
        encoder = iniGet(text, "AdvOut", "Encoder") ?? iniGet(text, "SimpleOutput", "StreamEncoder")
      }
      files[iniRel] = iniFilter(text, (section, key, value) => {
        if (HARDWARE_INI[section]?.includes(key)) {
          if (value) dropped.push({ file: iniRel, path: `${section}.${key}`, reason: "machine-bound" })
          return false
        }
        if (scrubSecrets && isSecretIni(section, key)) {
          remember(value)
          if (value) dropped.push({ file: iniRel, path: `${section}.${key}`, reason: "secret" })
          return false
        }
        return true
      })
    }
    for (const name of ["streamEncoder.json", "recordEncoder.json"]) {
      if (exists(`basic/profiles/${profile}/${name}`)) dropped.push({ file: `basic/profiles/${profile}/${name}`, path: "*", reason: "machine-bound" })
    }
    const serviceRel = `basic/profiles/${profile}/service.json`
    if (!exists(serviceRel)) continue
    if (opts.includeSecrets) {
      files[serviceRel] = read(serviceRel)
      continue
    }
    let service: any
    try {
      service = JSON.parse(read(serviceRel))
    } catch {
      dropped.push({ file: serviceRel, path: "*", reason: "not-portable" })
      continue
    }
    const settings: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(service?.settings ?? {})) {
      if (SERVICE_KEEP.has(key)) {
        settings[key] = typeof value === "string" ? scrubUrl(value) : value
        if (settings[key] !== value) dropped.push({ file: serviceRel, path: `settings.${key}`, reason: "secret" })
      } else {
        remember(value)
        if (value !== "" && value !== false && value !== null) dropped.push({ file: serviceRel, path: `settings.${key}`, reason: "secret" })
      }
    }
    files[serviceRel] = JSON.stringify({ type: service?.type, settings }, null, 4)
  }

  const required = new Map<string, string>()
  const media = new Set<string>()
  const audio: { source: string; kind: string }[] = []
  for (const name of listDir(join(configDir, "basic/scenes"))) {
    const rel = `basic/scenes/${name}`
    if (!name.endsWith(".json")) continue
    let scene: any
    try {
      scene = JSON.parse(read(rel))
    } catch {
      // Unreadable means unscannable, and unscannable does not leave the machine.
      dropped.push({ file: rel, path: "*", reason: "not-portable" })
      continue
    }
    const scrubbed: Scrubbed[] = []
    scrubNode(scene, "", { secrets: scrubSecrets }, scrubbed)
    for (const s of scrubbed) dropped.push({ file: rel, path: s.path, reason: s.reason })
    files[rel] = JSON.stringify(scene, null, 4)
    for (const k of kindsIn(scene)) if (!isBuiltin(k.id, host.platform)) required.set(baseId(k.id), k.source)
    for (const ref of sceneReferences(scene)) for (const p of ref.paths) media.add(p)
    for (const s of Array.isArray(scene?.sources) ? scene.sources : []) {
      if (/audio|pulse|wasapi|coreaudio|alsa|jack/.test(String(s?.id))) audio.push({ source: String(s?.name), kind: String(s?.id) })
    }
  }

  // Last line of defence: a known secret pasted somewhere the field rules do not look (a browser
  // source's custom CSS, say), and anything with a credential's shape. Exact values shorter than
  // six characters are skipped because replacing them would corrupt unrelated text.
  const needles = [...known].flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
  const sweep = (text: string) => {
    if (!scrubSecrets) return text
    for (const needle of needles) text = text.split(needle).join(REDACTED)
    return redactSecrets(text)
  }
  for (const rel of Object.keys(files)) {
    const clean = sweep(files[rel])
    if (clean !== files[rel]) {
      files[rel] = clean
      dropped.push({ file: rel, path: "(value matching a known or credential-shaped secret)", reason: "secret" })
    }
  }

  const info = {
    obsVersion: version,
    encoderClass: encoderClass(encoder),
    display: canvas,
    audio,
    active,
    media: [...media].sort(),
    plugins: { required: [...required.keys()].sort(), installed: installedPlugins(host, configDir) },
  }
  return { files, dropped, info: JSON.parse(sweep(JSON.stringify(info))) as Record<string, unknown> }
}

// ── Writing the target machine ──────────────────────────────────────────────────────────────

function isPristine(configDir: string): boolean {
  const basic = join(configDir, "basic")
  if (!existsSync(basic)) return true
  const profiles = listDir(join(basic, "profiles"))
  const scenes = listDir(join(basic, "scenes")).filter((n) => !n.endsWith(".bak"))
  if (profiles.some((p) => p !== "Untitled") || scenes.some((s) => s !== "Untitled.json")) return false
  try {
    for (const name of scenes) {
      const scene = JSON.parse(readFileSync(join(basic, "scenes", name), "utf8"))
      for (const s of scene?.sources ?? []) {
        if (s?.id !== "scene" || (s?.settings?.items?.length ?? 0) > 0) return false
      }
    }
    const service = join(basic, "profiles/Untitled/service.json")
    if (existsSync(service) && JSON.parse(readFileSync(service, "utf8"))?.settings?.key) return false
  } catch {
    return false
  }
  return true
}

function plan(bundle: Bundle, ctx: PlanContext) {
  const files: Record<string, string> = {}
  const dropped: Dropped[] = bundle.manifest.dropped.map((d) => ({ ...d }))
  const notes: string[] = []
  const existing = (rel: string) => {
    const p = join(ctx.configDir, rel)
    return existsSync(p) ? readFileSync(p, "utf8") : null
  }
  const droppedFrom = (rel: string, reasons: Dropped["reason"][]) =>
    bundle.manifest.dropped.filter((d) => d.file === rel && reasons.includes(d.reason))
  const scripts = new Set<string>()

  for (const [rel, original] of Object.entries(bundle.files)) {
    let text = original
    if (SCENE_PATH.test(rel)) {
      const scene = JSON.parse(text)
      if (ctx.maps.length) text = JSON.stringify(mapStrings(scene, ctx), null, 4)
      for (const s of scriptEntries(JSON.parse(text))) scripts.add(s)
    } else if (rel.endsWith("/basic.ini")) {
      const carry = droppedFrom(rel, ["machine-bound", "secret"]).map((d) => d.path)
      text = iniFilter(text, (section, key, value) => {
        if (!PATH_INI[section]?.includes(key) || !value) return true
        if (mapPath(value, ctx.maps)) return true
        dropped.push({ file: rel, path: `${section}.${key}`, reason: "unmapped-path" })
        carry.push(`${section}.${key}`)
        return false
      })
      for (const [section, keys] of Object.entries(PATH_INI)) {
        for (const key of keys) {
          const mapped = mapPath(iniGet(text, section, key) ?? "", ctx.maps)
          if (mapped) text = iniSet(text, section, key, mapped)
        }
      }
      // Each machine keeps its own encoder, canvas, devices, login and recording folder.
      const current = existing(rel)
      if (current !== null) {
        for (const path of carry) {
          const dot = path.indexOf(".")
          const value = iniGet(current, path.slice(0, dot), path.slice(dot + 1))
          if (value !== undefined) text = iniSet(text, path.slice(0, dot), path.slice(dot + 1), value)
        }
      }
    } else if (rel.endsWith("/service.json")) {
      const current = existing(rel)
      const wanted = droppedFrom(rel, ["secret"]).map((d) => d.path.replace(/^settings\./, ""))
      if (current !== null && wanted.length) {
        try {
          const had = JSON.parse(current)?.settings ?? {}
          const service = JSON.parse(text)
          const kept = wanted.filter((k) => had[k] !== undefined && had[k] !== "")
          for (const k of kept) service.settings[k] = had[k]
          if (kept.length) {
            text = JSON.stringify(service, null, 4)
            notes.push(`${rel}: kept this machine's own ${kept.join(", ")}`)
          }
        } catch {
          /* an unreadable target file is replaced; the backup holds it */
        }
      }
    }
    files[rel] = text
  }

  // Point OBS at the restored profile and collection. OBS 31+ reads these from user.ini.
  const active = (bundle.manifest.info?.active ?? {}) as Record<string, string | undefined>
  if (active.profile) {
    const rel = existing("user.ini") !== null ? "user.ini" : existing("global.ini") !== null ? "global.ini" : "user.ini"
    let text = existing(rel) ?? ""
    const pointers: [string, string | undefined][] = [
      ["Profile", active.profile],
      ["ProfileDir", active.profileDir],
      ["SceneCollection", active.collection],
      ["SceneCollectionFile", active.collectionFile],
    ]
    // The manifest is untrusted input: a newline here would inject ini lines.
    for (const [key, value] of pointers) if (value && !/[\r\n]/.test(value)) text = iniSet(text, "Basic", key, value)
    files[rel] = text
  }

  if (scripts.size) notes.push(`this pack loads ${scripts.size} script(s) when OBS opens it; apply packs only from people you trust: ${[...scripts].join(", ")}`)
  if (bundle.manifest.containsSecrets) notes.push("WARNING: this bundle was exported with --include-secrets and carries credentials.")
  return { files, dropped, notes }
}

function verify(read: (rel: string) => string | null, bundle: Bundle, ctx: PlanContext): Problem[] {
  const problems: Problem[] = []
  const installed = installedPlugins(ctx.host, ctx.configDir)
  const seen = new Set<string>()
  const once = (p: Problem) => {
    if (!seen.has(p.message)) {
      seen.add(p.message)
      problems.push(p)
    }
  }
  for (const rel of Object.keys(bundle.files)) {
    const match = rel.match(SCENE_PATH)
    if (!match) continue
    const text = read(rel)
    if (text === null) {
      once({ kind: "read-back", message: `${rel} is not on disk` })
      continue
    }
    let scene: any
    try {
      scene = JSON.parse(text)
    } catch {
      once({ kind: "read-back", message: `${rel} is not valid JSON` })
      continue
    }
    const collection = match[1].replace(/\.json$/, "")
    for (const ref of sceneReferences(scene)) {
      for (const raw of ref.paths) {
        let path = raw
        const url = raw.match(/^file:\/\/\/?/i)?.[0]
        if (url) {
          path = raw.slice(url.length)
          try {
            path = decodeURI(path)
          } catch {
            /* check it as written */
          }
          if (!/^[A-Za-z]:/.test(path)) path = "/" + path
        }
        if (!existsSync(path)) once({ kind: "missing-path", message: `${collection} / ${ref.name}: ${path}` })
      }
    }
    for (const k of kindsIn(scene)) {
      if (isBuiltin(k.id, ctx.host.platform) || pluginLooksInstalled(k.id, installed)) continue
      once({ kind: "missing-plugin", message: `${baseId(k.id)} (used by ${collection} / ${k.source}) is not built into OBS on ${ctx.host.platform}, and no installed plugin matches it` })
    }
  }
  return problems
}

const OBS_PROCESSES = new Set(["obs", "obs64", "obs64.exe", "obs32", "obs32.exe", "obs-studio", "obs.bin"])

export const obsAdapter: AppConfigAdapter = {
  id: "obs",
  label: "OBS",
  runningReason: "OBS rewrites its config when it exits, which would undo this apply.",
  defaultConfigDir(host) {
    if (host.platform === "darwin") return join(host.home, "Library/Application Support/obs-studio")
    if (host.platform === "win32") return join(host.env.APPDATA ?? join(host.home, "AppData/Roaming"), "obs-studio")
    const native = join(host.env.XDG_CONFIG_HOME ?? join(host.home, ".config"), "obs-studio")
    const flatpak = join(host.home, ".var/app/com.obsproject.Studio/config/obs-studio")
    return !existsSync(native) && existsSync(flatpak) ? flatpak : native
  },
  runningProcess(names) {
    for (const name of names) {
      const base = name.trim().split(/[\\/]/).pop()?.toLowerCase() ?? ""
      if (OBS_PROCESSES.has(base)) return base
    }
    return null
  },
  isBundlePath(rel) {
    const inner = rel.match(SCENE_PATH)?.[1] ?? rel.match(PROFILE_PATH)?.[1]
    if (rel === WS_CONFIG) return true
    return inner !== undefined && inner !== "." && inner !== ".." && !inner.includes("\0")
  },
  isPristine,
  collect,
  plan,
  verify,
}
