// `iris home` — pure logic, split out so it can be tested without a bridge or the network.
// Reference implementation: ~/sites/irishome/home.py (ticket #185775).

export type Transport = "hue" | "wiz"

export interface HomeDevice {
  /** transport-local id: Hue light id, or the Wiz bulb IP */
  id: string
  name: string
  room: string
  transport: Transport
  /** Hue: bridge IP. Wiz: bulb IP. */
  ip?: string | null
}

/** Normalized state change. Values use the Hue ranges (bri/sat 0–254, hue 0–65535, ct mireds). */
export interface Verbs {
  on?: boolean
  bri?: number
  hue?: number
  sat?: number
  ct?: number
  /** Hue fade duration in tenths of a second; other transports ignore it */
  transitiontime?: number
}

export const COLORS: Record<string, Verbs> = {
  purple: { hue: 46920, sat: 254 },
  blue: { hue: 42000, sat: 254 },
  red: { hue: 0, sat: 254 },
  green: { hue: 25500, sat: 254 },
  cyan: { hue: 34000, sat: 254 },
  amber: { hue: 8000, sat: 200 },
  pink: { hue: 55000, sat: 150 },
  orange: { hue: 5000, sat: 254 },
  warm: { ct: 340 },
  white: { ct: 370 },
  bright: { bri: 254 },
  dim: { bri: 80 },
}

/** Words that read naturally ("iris home living lights blue") but carry no meaning. */
const NOISE = new Set(["light", "lights", "lamp", "lamps", "the", "to"])

export function resolveColor(name: string): Verbs | null {
  const key = name.toLowerCase()
  if (COLORS[key]) return { ...COLORS[key] }
  // `#` is required: a bare 6-char word like "bedroom" must stay a room name.
  const m = /^#([0-9a-f]{6})$/i.exec(name)
  if (!m) return null
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return { hue: Math.round(h * 65535), sat: Math.round((max ? d / max : 0) * 254), bri: Math.round(max * 254) }
}

/**
 * Parse free-form words: `living lights blue`, `all warm`, `master off`, `#ff00aa`, `bri 120`.
 * Anything that is not a verb, color, or noise word is the room. Returns null verbs when
 * nothing actionable was said — callers must refuse rather than send an empty state.
 */
export function parseSetArgs(words: string[]): { room: string | null; verbs: Verbs | null } {
  const verbs: Verbs = {}
  const roomParts: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const lw = w.toLowerCase()
    if (NOISE.has(lw)) continue
    if (lw === "on") { verbs.on = true; continue }
    if (lw === "off") { verbs.on = false; continue }
    if ((lw === "bri" || lw === "brightness") && words[i + 1] && /^\d+%?$/.test(words[i + 1])) {
      const raw = words[++i]
      const n = parseInt(raw, 10)
      verbs.bri = clamp(raw.endsWith("%") ? Math.round((n / 100) * 254) : n, 1, 254)
      verbs.on = verbs.on ?? true
      continue
    }
    const color = resolveColor(w)
    if (color) { Object.assign(verbs, color); verbs.on = verbs.on ?? true; continue }
    roomParts.push(w)
  }
  const room = roomParts.length ? roomParts.join(" ") : null
  return { room, verbs: Object.keys(verbs).length ? verbs : null }
}

/**
 * "all"/null → every device. An exact device name targets only that device — otherwise
 * "Living Room" also hits "Living Room - Dome". Then the room field, then a name substring.
 */
export function matchDevices(devices: HomeDevice[], room: string | null): HomeDevice[] {
  if (!room || room.toLowerCase() === "all") return devices
  const t = room.toLowerCase()
  const exact = devices.filter((d) => d.name.toLowerCase() === t)
  if (exact.length) return exact
  return devices.filter((d) => (d.room ?? "").toLowerCase() === t || d.name.toLowerCase().includes(t))
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Hue ranges → Wiz `setPilot` params. */
export function toWizParams(v: Verbs): Record<string, unknown> {
  if (v.on === false) return { state: false }
  const params: Record<string, unknown> = { state: true }
  if (v.bri !== undefined) params.dimming = clamp(Math.round((v.bri / 254) * 100), 10, 100)
  if (v.hue !== undefined) {
    const [r, g, b] = hsvToRgb(v.hue / 65535, (v.sat ?? 254) / 254, 1)
    Object.assign(params, { r, g, b })
  } else if (v.ct !== undefined) {
    params.temp = clamp(Math.round(1_000_000 / v.ct), 2200, 6500)
  }
  return params
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

export interface SceneStep {
  room?: string
  color?: string
  bri?: number
  off?: boolean
  wait?: number
}

export interface Scene {
  steps: SceneStep[]
  repeat: number
}

/**
 * Accepts the prototype's shapes: a bare step array (optionally containing a `{repeat: n}`
 * marker), or `{steps, repeat}`. Throws on a color it does not know, so a typo fails
 * before the lights start moving instead of silently skipping a step.
 */
export function normalizeScene(input: unknown): Scene {
  let steps: any[]
  let repeat = 1
  if (Array.isArray(input)) steps = input
  else if (input && typeof input === "object" && Array.isArray((input as any).steps)) {
    steps = (input as any).steps
    repeat = Number((input as any).repeat ?? 1)
  } else throw new Error("scene must be a step array or {steps: [...]}")
  const marker = steps.find((s) => s && typeof s === "object" && Object.keys(s).length === 1 && "repeat" in s)
  if (marker) repeat = Number(marker.repeat)
  steps = steps.filter((s) => s !== marker)
  if (!steps.length) throw new Error("scene has no steps")
  for (const [i, s] of steps.entries()) {
    if (s.color && !resolveColor(s.color)) throw new Error(`step ${i + 1}: unknown color '${s.color}'`)
  }
  return { steps, repeat: clamp(Number.isFinite(repeat) ? repeat : 1, 1, 1000) }
}

export function stepVerbs(step: SceneStep): Verbs {
  if (step.off) return { on: false }
  const v: Verbs = { on: true, ...(step.color ? resolveColor(step.color) : {}) }
  if (step.bri !== undefined) v.bri = clamp(step.bri, 1, 254)
  return v
}

/** Sequences shipped with the CLI; users add their own in ~/.iris/home/sequences.json. */
export const BUILTIN_SEQUENCES: Record<string, unknown> = {
  pulse: [
    { room: "all", color: "purple", bri: 254, wait: 400 },
    { room: "all", color: "purple", bri: 60, wait: 400 },
    { repeat: 6 },
  ],
  strobe: [
    { room: "all", color: "blue", wait: 100 },
    { room: "all", off: true, wait: 100 },
    { repeat: 10 },
  ],
  rainbow: {
    repeat: 2,
    steps: ["red", "orange", "amber", "green", "cyan", "blue", "purple", "pink"].map((color) => ({ room: "all", color, wait: 250 })),
  },
}

/**
 * Hue answers a PUT with per-attribute success/error entries, and answers SUCCESS for a
 * light that is unreachable — the bridge caches the state. So "accepted" is not "changed":
 * the reachable flag has to be read separately and reported.
 */
export function summarizeHueResponse(resp: unknown, reachable: boolean | undefined): { ok: boolean; note?: string } {
  const entries = Array.isArray(resp) ? resp : []
  const err = entries.find((e: any) => e?.error)
  if (err) return { ok: false, note: (err as any).error?.description ?? "bridge error" }
  if (!entries.length) return { ok: false, note: "empty bridge response" }
  if (reachable === false) return { ok: false, note: "accepted by bridge but light is unreachable (powered off at the switch?)" }
  return { ok: true }
}
