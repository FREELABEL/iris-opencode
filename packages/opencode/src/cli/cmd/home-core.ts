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
  // ADR-04 (#186312). Every value here is what resolveColor() computes for that colour's
  // canonical hex, so the word and the hex agree — `teal` and `#008080` are the same light.
  // Added because an unknown colour does not fail as a colour: it falls through to the room
  // name, matches nothing, and reads to the user as "the lights are broken".
  teal: { hue: 32768, sat: 254 }, // #008080 — exactly half the wheel, between green and cyan
  turquoise: { hue: 31690, sat: 181 }, // #40e0d0
  lime: { hue: 16000, sat: 254 }, // yellow-green; distinct from `green` at 25500
  magenta: { hue: 54613, sat: 254 }, // #ff00ff
  gold: { hue: 9209, sat: 254 }, // #ffd700 — richer than `amber`
  lavender: { hue: 50084, sat: 108 }, // #b57edc — low saturation is the point
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
    // `over <duration>` — ADR-04 (#186312). A fade the BRIDGE performs: the command exits
    // immediately and the bulb keeps changing, so a 30-minute wind-down needs no daemon.
    // A bad duration REFUSES rather than falling through to the room name, because a
    // dropped fade looks exactly like a command that worked.
    if (lw === "over") {
      const ms = words[i + 1] ? parseDuration(words[i + 1]) : null
      if (ms === null) return { room: null, verbs: null }
      verbs.transitiontime = toTransitionTime(ms)
      i++
      continue
    }
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
/**
 * Parse a duration token to MILLISECONDS. ADR-04 (#186312).
 *
 * A bare number stays milliseconds because the shipped scene format already means ms by
 * `wait: 400`. Redefining it would silently reinterpret every scene anyone has written.
 *
 * Returns null rather than guessing: a duration that is quietly wrong does not error, it
 * just makes a fade snap, which reads as "transitions don't work" rather than "bad input".
 */
export function parseDuration(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(token.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  switch ((m[2] ?? "ms").toLowerCase()) {
    case "s":
      return Math.round(n * 1000)
    case "m":
      return Math.round(n * 60_000)
    case "h":
      return Math.round(n * 3_600_000)
    default:
      return Math.round(n)
  }
}

/**
 * Milliseconds → Hue `transitiontime`, which counts TENTHS OF A SECOND.
 *
 * The unit mismatch is the entire reason this exists: handing the bridge milliseconds makes
 * every fade ten times too long and reports no error. The field is a uint16, so a fade over
 * 6553.5s does not fail either — it OVERFLOWS, turning a long sunset into a jump cut.
 * Clamp, never overflow.
 */
export function toTransitionTime(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  // A caller who asked for a fade gets the shortest real one rather than a silent snap.
  return clamp(Math.max(1, Math.round(ms / 100)), 0, 65535)
}

/**
 * Explain a command that produced nothing, by NAMING the word that was not understood.
 *
 * ADR-04 (#186312). Everything unrecognised falls through to the room name by design, so a
 * misspelled or unknown COLOUR becomes a room that matches no devices. The old message —
 * "Nothing to do with 'all teal'" — reports the whole phrase and blames neither word, which
 * is how "teal is not a word I know" reaches a user as "my lights are broken".
 *
 * Only words that are genuinely unrecognised are quoted. A word that means something —
 * a colour, a verb, a number, "all", or any token of a real room name — is never accused.
 */
export function unknownWordHelp(words: string[], rooms: string[]): string {
  // Multi-word rooms ("treyton's room") must not have their parts flagged individually.
  const roomTokens = new Set(
    rooms.flatMap((r) => r.toLowerCase().split(/\s+/)).filter(Boolean),
  )

  const unknown = words.filter((w) => {
    const lw = w.toLowerCase()
    if (NOISE.has(lw)) return false
    if (lw === "all" || lw === "on" || lw === "off") return false
    if (lw === "bri" || lw === "brightness") return false
    if (/^\d+%?$/.test(lw)) return false
    if (resolveColor(w)) return false
    if (roomTokens.has(lw)) return false
    return true
  })

  const colours = Object.keys(COLORS).join(", ")
  const roomList = rooms.length ? rooms.join(", ") : "none — pair a bridge first"

  if (!unknown.length) {
    return `Nothing to change in "${words.join(" ")}". Colours: ${colours}. Rooms: ${roomList}.`
  }

  const named = unknown.map((w) => `'${w}'`).join(", ")
  const isOne = unknown.length === 1
  return (
    `${named} ${isOne ? "is" : "are"} not a colour or a room. ` +
    `Colours: ${colours}, or a hex like #008080. ` +
    `Rooms: ${roomList}.`
  )
}

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
    // A bad fade must fail HERE, at load. Dropped silently it would produce a show that
    // runs, reports success, and simply does not fade — the hardest kind of bug to see.
    if (s.fade !== undefined && typeof s.fade !== "number" && parseDuration(String(s.fade)) === null)
      throw new Error(`step ${i + 1}: unreadable fade '${s.fade}' — try 800, "800ms" or "1.5s"`)
  }
  return { steps, repeat: clamp(Number.isFinite(repeat) ? repeat : 1, 1, 1000) }
}

export function stepVerbs(step: SceneStep): Verbs {
  // ADR-04 (#186312). `fade` is OPTIONAL and absent means snap — the shipped sequences have
  // no fade, and defaulting one would silently change the character of every scene that has
  // already been written. Fading OFF is still a fade: the light dims out instead of cutting.
  const fade = (step as any).fade
  const ms = fade === undefined ? null : typeof fade === "number" ? fade : parseDuration(String(fade))
  const t = ms === null ? undefined : toTransitionTime(ms)

  if (step.off) return t === undefined ? { on: false } : { on: false, transitiontime: t }
  const v: Verbs = { on: true, ...(step.color ? resolveColor(step.color) : {}) }
  // RAW passthrough, for steps written by `save`. Capture stores the bridge's own units
  // rather than a hex round trip, so the runner has to read them back — without this every
  // saved scene would restore brightness and nothing else.
  const raw = step as any
  if (raw.hue !== undefined) v.hue = clamp(Number(raw.hue), 0, 65535)
  if (raw.sat !== undefined) v.sat = clamp(Number(raw.sat), 0, 254)
  if (raw.ct !== undefined) v.ct = Number(raw.ct)
  if (step.bri !== undefined) v.bri = clamp(step.bri, 1, 254)
  if (t !== undefined) v.transitiontime = t
  return v
}

/** Photosensitivity floor, mirrored from home-templates so the shorthand inherits it. */
export const SHORTHAND_MIN_STEP_MS = 100

export type ShorthandMode = "drift" | "pulse" | "strobe"

export interface TimelineStep {
  color?: string
  off?: boolean
  fade: number
  wait: number
}

export interface TimelineScene {
  tracks: Record<string, TimelineStep[]>
  repeat: number
  loop: boolean
  mode: ShorthandMode
}

/**
 * Compile the shorthand timeline language to a scene. ADR-04 (#186312).
 *
 * `@living teal:6s blue:6s @bedroom amber:4s drift loop`
 *
 * Returns NULL when the words contain no `colour:duration` token at all, so plain
 * `iris home all blue` falls through to the existing single-state parser untouched.
 * Throws — never silently drops — on a token that looks like a timeline step and is not
 * readable, because a dropped step produces a show that runs and is quietly wrong.
 *
 * THE MODE WORD, not more punctuation: `teal:6s` is ambiguous on its own (six seconds
 * fading INTO teal, or sitting AT teal?) and those are opposite feels. One word at the end
 * settles it for the whole line, which is also how people say it out loud.
 */
export function compileShorthand(words: string[]): TimelineScene | null {
  if (!words.length) return null
  if (!words.some((w) => /^[^:\s]+:[^:\s]+$/.test(w))) return null

  let mode: ShorthandMode = "drift"
  let repeat = 1
  let loop = false

  const tracks: Record<string, TimelineStep[]> = {}
  let current = "all"
  let roomWords: string[] | null = null

  const flushRoom = () => {
    if (roomWords && roomWords.length) {
      current = roomWords.join(" ").toLowerCase()
      tracks[current] ??= []
    }
    roomWords = null
  }

  for (const w of words) {
    const lw = w.toLowerCase()

    if (lw === "drift" || lw === "pulse" || lw === "strobe") { flushRoom(); mode = lw as ShorthandMode; continue }
    if (lw === "loop") { flushRoom(); loop = true; continue }
    if (/^x\d+$/.test(lw)) { flushRoom(); repeat = clamp(parseInt(lw.slice(1), 10), 1, 1000); continue }

    if (w.startsWith("@")) {
      flushRoom()
      roomWords = [w.slice(1)].filter(Boolean)
      continue
    }

    const m = /^(.+):(.+)$/.exec(w)
    if (m) {
      flushRoom()
      const [, colour, dur] = m
      const ms = parseDuration(dur)
      if (ms === null) throw new Error(`unreadable duration '${dur}' in '${w}' — try 400, 800ms or 1.5s`)
      const isOff = colour.toLowerCase() === "off"
      if (!isOff && !resolveColor(colour)) throw new Error(`unknown colour '${colour}' in '${w}'`)
      tracks[current] ??= []
      tracks[current].push({ ...(isOff ? { off: true } : { color: colour }), fade: 0, wait: ms })
      continue
    }

    // Anything else extends the room name currently being read (multi-word rooms).
    if (roomWords) { roomWords.push(w); continue }
  }
  flushRoom()

  const steps = Object.values(tracks).flat()
  if (!steps.length) return null

  for (const st of steps) {
    // The floor is a CLAMP, not a refusal: the language must be unable to express an
    // unsafe show, rather than validating one after the fact.
    st.wait = Math.max(SHORTHAND_MIN_STEP_MS, st.wait)
    st.fade = mode === "drift" ? st.wait : 0
  }

  return { tracks, repeat, loop, mode }
}

/** One light's live state, as the Hue bridge reports it. */
export interface LightState {
  on?: boolean
  bri?: number
  hue?: number
  sat?: number
  ct?: number
  colormode?: string
}

/**
 * Turn a light's CURRENT state into a scene step — the pure half of `iris home save`.
 *
 * ADR-04 (#186312). Capture beats authoring: people tune a room by eye and then want it
 * back. Stored in the bridge's own units, never via hex, because hex cannot express a white
 * colour temperature at all and loses precision on everything else.
 *
 * THE TRAP: a bulb in `ct` mode still reports hue and sat — stale values from whenever it
 * was last coloured. Saving those restores a completely different light. `colormode` is the
 * only thing that says which pair is real.
 */
export function captureStep(room: string, state: LightState): Record<string, unknown> {
  if (state.on === false) return { room, off: true }

  const step: Record<string, unknown> = { room }
  if (state.colormode === "ct" && state.ct !== undefined) {
    step.ct = state.ct
  } else if (state.hue !== undefined) {
    step.hue = state.hue
    if (state.sat !== undefined) step.sat = state.sat
  } else if (state.ct !== undefined) {
    step.ct = state.ct
  }
  if (state.bri !== undefined) step.bri = state.bri
  return step
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
