import { productCommand } from "./product-command"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { bold, dim, success, printDivider, writeJson } from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, extname, join, resolve } from "path"
import { resolveFfmpeg, transcribeLocal, transcribeWords, which, type TranscriptWord } from "../lib/transcription"

// ============================================================================
// iris reel — the talking-head lane (Atlas #191299, epic #191300)
//
// IRIS could already render films made in code. It had nothing for the other kind: footage
// of a real person talking to camera. This is that lane, in three verbs, each of which reads
// a file and leaves a file:
//
//   cut       raw takes  → the best take, pauses removed           (ffmpeg silencedetect)
//   captions  a cut      → the same video with word captions burnt (whisper.cpp + libass)
//   covers    a video    → N sharp 1080x1920 cover frames          (ffmpeg + a Laplacian)
//
// Everything runs on this machine with ffmpeg and the on-device whisper.cpp that
// `iris transcribe` already uses. No network, no Remotion, no new dependency.
//
// The decisions (where speech is, which take wins, how words become lines, which frames make
// covers) are pure functions exported below and unit-tested; the handlers only run ffmpeg.
// ============================================================================

// ----------------------------------------------------------------------------
// Pure logic — silence → speech
// ----------------------------------------------------------------------------

export type Span = { start: number; end: number }

/** "Duration: 00:01:15.28" from ffmpeg's banner, in seconds. 0 when absent. */
export function parseDuration(stderr: string): number {
  const m = String(stderr ?? "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** "1080x1920" from the first video stream line. */
export function parseVideoSize(stderr: string): { width: number; height: number } | null {
  for (const line of String(stderr ?? "").split("\n")) {
    if (!/Stream #\d+:\d+.*:\s*Video:/.test(line)) continue
    const m = line.match(/,\s*(\d{2,5})x(\d{2,5})[\s,]/)
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  }
  return null
}

export function hasAudioStream(stderr: string): boolean {
  return /Stream #\d+:\d+.*:\s*Audio:/.test(String(stderr ?? ""))
}

/**
 * Silences out of ffmpeg's silencedetect log. A silence that starts and never ends ran to the
 * end of the file, so it is closed at `duration`. Spans are clamped to [0, duration].
 */
export function parseSilences(stderr: string, duration: number): Span[] {
  const out: Span[] = []
  let open: number | null = null
  for (const line of String(stderr ?? "").split("\n")) {
    const s = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/)
    if (s) {
      open = Math.max(0, Number(s[1]))
      continue
    }
    const e = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/)
    if (e) {
      const end = Number(e[1])
      out.push({ start: open ?? 0, end: duration > 0 ? Math.min(end, duration) : end })
      open = null
    }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration })
  return out
}

/**
 * The speech between the silences, widened by `pad` on each side so the first and last
 * phoneme of a word are not clipped, then merged where the padding made neighbours touch.
 * Fragments shorter than `minSpeech` (a click, a breath) are dropped.
 */
export function speechSegments(silences: Span[], duration: number, pad = 0.08, minSpeech = 0.1): Span[] {
  const raw: Span[] = []
  let cursor = 0
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) raw.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (duration > cursor) raw.push({ start: cursor, end: duration })

  const merged: Span[] = []
  for (const r of raw) {
    if (r.end - r.start < minSpeech) continue
    const seg = { start: Math.max(0, r.start - pad), end: Math.min(duration, r.end + pad) }
    const last = merged[merged.length - 1]
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end)
    else merged.push(seg)
  }
  return merged.map((s) => ({ start: round3(s.start), end: round3(s.end) }))
}

/**
 * The --noise threshold as silencedetect wants it. `--noise -35dB` cannot be typed: the parser
 * reads "-35dB" as four short flags. So a bare magnitude is accepted too — `--noise 35`,
 * `--noise 35dB` and `--noise=-35dB` all mean -35dB. An amplitude ratio (0.01) passes through.
 */
export function normaliseNoise(v: unknown): string {
  const s = String(v ?? "").trim()
  const m = s.match(/^-?(\d+(?:\.\d+)?)\s*(db)?$/i)
  if (m && (m[2] || Number(m[1]) >= 1)) return `-${m[1]}dB`
  return s || "-35dB"
}

/** A pause at least this long counts against a take: it is a lost line, not a breath. */
export const LONG_PAUSE_SECONDS = 1.0
/** Seconds of speech one long pause costs a take's score. */
export const LONG_PAUSE_PENALTY = 1.0

export type TakeStats = {
  file: string
  duration: number
  speech: number
  pauses: number
  longPauses: number
  segments: Span[]
}

/** Interior pauses only — silence before the first word or after the last is not hesitation. */
export function takeStats(file: string, silences: Span[], duration: number, segments: Span[]): TakeStats {
  const interior = silences.filter((s) => s.start > 0.01 && s.end < duration - 0.01)
  return {
    file,
    duration: round3(duration),
    speech: round3(segments.reduce((n, s) => n + (s.end - s.start), 0)),
    pauses: interior.length,
    longPauses: interior.filter((s) => s.end - s.start >= LONG_PAUSE_SECONDS).length,
    segments,
  }
}

/** speech seconds − LONG_PAUSE_PENALTY × long pauses. Higher wins. */
export function takeScore(t: Pick<TakeStats, "speech" | "longPauses">): number {
  return round3(t.speech - LONG_PAUSE_PENALTY * t.longPauses)
}

/** Lower-cased word tokens, punctuation stripped, apostrophes kept ("don't" stays one word). */
export function words(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean)
}

/**
 * What share of the script's words the transcript contains, counting repeats: a script that
 * says "the" six times is only fully covered by a transcript that says it six times. 0..1.
 */
export function scriptCoverage(script: string, transcript: string): number {
  const want = words(script)
  if (want.length === 0) return 0
  const have = new Map<string, number>()
  for (const w of words(transcript)) have.set(w, (have.get(w) ?? 0) + 1)
  let hit = 0
  for (const w of want) {
    const n = have.get(w) ?? 0
    if (n > 0) {
      hit++
      have.set(w, n - 1)
    }
  }
  return round3(hit / want.length)
}

export type TakeVerdict = { index: number; reason: string }

/**
 * The winning take. With script coverage: the highest coverage, ties broken by score. Without:
 * the highest score (speech − 1s per long pause), ties broken by the shorter file.
 */
export function pickBestTake(takes: TakeStats[], coverage?: number[]): TakeVerdict {
  if (takes.length === 0) throw new Error("no takes")
  const order = takes.map((_, i) => i)
  const useCoverage = Array.isArray(coverage) && coverage.length === takes.length
  order.sort((a, b) => {
    if (useCoverage && coverage![b] !== coverage![a]) return coverage![b] - coverage![a]
    const ds = takeScore(takes[b]) - takeScore(takes[a])
    if (ds !== 0) return ds
    return takes[a].duration - takes[b].duration
  })
  const win = order[0]
  const t = takes[win]
  if (takes.length === 1) return { index: win, reason: "only one take" }
  const runner = order[1]
  if (useCoverage) {
    const pct = (x: number) => `${Math.round(x * 100)}%`
    const tie = coverage![win] === coverage![runner]
    return {
      index: win,
      reason: tie
        ? `ties on script coverage (${pct(coverage![win])}) and has the better speech score (${takeScore(t)} vs ${takeScore(takes[runner])})`
        : `covers ${pct(coverage![win])} of the script's words (next best: ${pct(coverage![runner])})`,
    }
  }
  return {
    index: win,
    reason:
      `most usable speech: ${t.speech.toFixed(1)}s with ${t.longPauses} long pause${t.longPauses === 1 ? "" : "s"} ` +
      `(score ${takeScore(t)} vs ${takeScore(takes[runner])} for ${basename(takes[runner].file)})`,
  }
}

/** ffmpeg filter_complex that keeps only `segments` of input 0, audio and video cut together. */
export function cutFilter(segments: Span[], fade = 0.01): string {
  const parts: string[] = []
  const labels: string[] = []
  segments.forEach((s, i) => {
    const len = s.end - s.start
    const f = Math.min(fade, len / 4)
    parts.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`)
    // A 10 ms fade at each joint: a cut through a waveform clicks, a cut through a fade doesn't.
    parts.push(
      `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${round3(f)},afade=t=out:st=${round3(len - f)}:d=${round3(f)}[a${i}]`,
    )
    labels.push(`[v${i}][a${i}]`)
  })
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`)
  return parts.join(";")
}

// ----------------------------------------------------------------------------
// Pure logic — words → caption lines → ASS / SRT
// ----------------------------------------------------------------------------

export type CaptionLine = { start: number; end: number; words: TranscriptWord[] }

/**
 * Short lines of at most `perLine` words. A line also ends early at the end of a sentence or
 * at a gap longer than `maxGap`, so a caption never straddles a pause. Each line is held a
 * moment past its last word (`hold`) but never into the next line.
 */
export function groupWords(input: TranscriptWord[], perLine = 3, maxGap = 0.6, hold = 0.25): CaptionLine[] {
  const n = Math.max(1, Math.floor(perLine))
  const lines: CaptionLine[] = []
  let cur: TranscriptWord[] = []
  const flush = () => {
    if (cur.length) lines.push({ start: cur[0].t0, end: cur[cur.length - 1].t1, words: cur })
    cur = []
  }
  for (let i = 0; i < input.length; i++) {
    const w = input[i]
    const prev = cur[cur.length - 1]
    if (prev && w.t0 - prev.t1 > maxGap) flush()
    cur.push(w)
    if (cur.length >= n || /[.!?]["')\]]?$/.test(w.word)) flush()
  }
  flush()
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]
    const limit = next ? next.start : Infinity
    lines[i].end = round3(Math.min(lines[i].end + hold, limit))
  }
  return lines
}

/** ASS time: h:mm:ss.cc */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`
}

/** SRT time: hh:mm:ss,mmm */
export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`
}

/** Text is literal in ASS except for override braces and backslashes. */
export function assEscape(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ")
}

export type AssOptions = {
  width: number
  height: number
  style?: "pop" | "plain"
  position?: "lower" | "center"
  font?: string
}

/** Where the bottom of a `lower` caption sits, as a share of the height measured from the bottom. */
export const LOWER_SAFE_BOTTOM = 0.24

/** ASS geometry for a frame: kept clear of the bottom ~20% (the reel UI) and the side icons. */
export function assLayout(o: AssOptions) {
  const pos = o.position ?? "lower"
  return {
    fontSize: Math.round(o.height * 0.042),
    outline: Math.max(2, Math.round(o.height * 0.0035)),
    shadow: Math.max(1, Math.round(o.height * 0.0015)),
    marginLR: Math.round(o.width * 0.1),
    // \an2 = bottom-centre with MarginV lifting it off the bottom; \an5 = dead centre.
    alignment: pos === "center" ? 5 : 2,
    marginV: pos === "center" ? 0 : Math.round(o.height * LOWER_SAFE_BOTTOM),
  }
}

/** Highlight colour for the spoken word (ASS is &HAABBGGRR): #FFD400. */
export const POP_COLOUR = "&H0000D4FF&"

/**
 * A complete ASS document. `plain` is one event per line. `pop` is one event per word: the
 * whole line is on screen, and the word being said is drawn in the highlight colour, slightly
 * larger, from its first sound until the next word starts.
 */
export function buildAss(lines: CaptionLine[], o: AssOptions): string {
  const L = assLayout(o)
  const font = o.font ?? "Arial"
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Reel,${font},${L.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${L.outline},${L.shadow},${L.alignment},${L.marginLR},${L.marginLR},${L.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ]
  const events: string[] = []
  const ev = (a: number, b: number, text: string) =>
    events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Reel,,0,0,0,,${text}`)
  for (const line of lines) {
    if (o.style === "plain") {
      ev(line.start, line.end, line.words.map((w) => assEscape(w.word)).join(" "))
      continue
    }
    line.words.forEach((w, i) => {
      const a = i === 0 ? line.start : w.t0
      const b = i + 1 < line.words.length ? line.words[i + 1].t0 : line.end
      if (b <= a) return
      const text = line.words
        .map((x, j) =>
          j === i ? `{\\c${POP_COLOUR}\\fscx108\\fscy108}${assEscape(x.word)}{\\r}` : assEscape(x.word),
        )
        .join(" ")
      ev(a, b, text)
    })
  }
  return [...head, ...events, ""].join("\n")
}

export function buildSrt(lines: CaptionLine[]): string {
  return (
    lines
      .map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.words.map((w) => w.word).join(" ")}\n`)
      .join("\n")
  )
}

// ----------------------------------------------------------------------------
// Pure logic — frames → covers
// ----------------------------------------------------------------------------

/**
 * Sharpness of one 8-bit grayscale frame: the variance of its 4-neighbour Laplacian. A blurred
 * or motion-smeared frame has few hard edges and scores low. Near-black and blown-out frames
 * score 0 — they are sharp only in the sense that noise is.
 */
export function laplacianVariance(px: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3 || px.length < w * h) return 0
  let mean = 0
  for (let i = 0; i < w * h; i++) mean += px[i]
  mean /= w * h
  if (mean < 25 || mean > 235) return 0
  let sum = 0
  let sq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = 4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w]
      sum += v
      sq += v * v
      n++
    }
  }
  const m = sum / n
  return sq / n - m * m
}

export type FrameScore = { t: number; score: number }

/**
 * The `count` sharpest frames, at least `minGap` seconds apart — neighbouring frames of the
 * same sharp moment are one cover, not three. Greedy: best first, skipping anything too close
 * to a frame already taken. Returned in time order.
 */
export function pickSpreadFrames(frames: FrameScore[], count: number, minGap: number): FrameScore[] {
  const chosen: FrameScore[] = []
  for (const f of [...frames].sort((a, b) => b.score - a.score || a.t - b.t)) {
    if (chosen.length >= count) break
    if (chosen.every((c) => Math.abs(c.t - f.t) >= minGap)) chosen.push(f)
  }
  return chosen.sort((a, b) => a.t - b.t)
}

/** Default spacing between covers: a third of an even split, never under a second. */
export function defaultCoverGap(duration: number, count: number): number {
  return Math.max(1, round3(duration / Math.max(1, count) / 3))
}

/** Break a title into lines of at most `maxChars`, on word boundaries. */
export function wrapTitle(text: string, maxChars = 14): string[] {
  const out: string[] = []
  let cur = ""
  for (const w of String(text ?? "").trim().split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w
    else if ((cur + " " + w).length <= maxChars) cur += " " + w
    else {
      out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ----------------------------------------------------------------------------
// ffmpeg plumbing
// ----------------------------------------------------------------------------

export type Ff = { bin: string; env: NodeJS.ProcessEnv }

function requireFfmpeg(): Ff {
  const ff = resolveFfmpeg()
  if (!ff.bin) throw new Error(ff.diagnosis || "ffmpeg is not available")
  return { bin: ff.bin, env: ff.env ? { ...process.env, ...ff.env } : process.env }
}

function runFf(ff: Ff, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const r = spawnSync(ff.bin, ["-hide_banner", "-nostdin", ...args], {
    encoding: "utf8",
    env: ff.env,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 30 * 60 * 1000,
    maxBuffer: 256 * 1024 * 1024,
  })
  return { status: r.status ?? 1, stderr: r.stderr || "", stdout: r.stdout || "" }
}

function fail(stderr: string, what: string): never {
  const tail = stderr.trim().split("\n").slice(-6).join("\n")
  throw new Error(`${what} failed${tail ? `:\n${tail}` : ""}`)
}

/** Probe a file: duration, size, audio — read from ffmpeg's own banner so ffprobe is not needed. */
function probe(ff: Ff, file: string) {
  const r = runFf(ff, ["-i", file], { timeoutMs: 30_000 })
  return { duration: parseDuration(r.stderr), size: parseVideoSize(r.stderr), audio: hasAudioStream(r.stderr), stderr: r.stderr }
}

export type SilenceOptions = { minSilence: number; noise: string; pad: number }

export function analyseTake(ff: Ff, file: string, o: SilenceOptions): TakeStats {
  const r = runFf(ff, ["-i", file, "-vn", "-af", `silencedetect=noise=${o.noise}:d=${o.minSilence}`, "-f", "null", "-"])
  if (r.status !== 0) fail(r.stderr, `silencedetect on ${basename(file)}`)
  if (!hasAudioStream(r.stderr)) throw new Error(`${basename(file)} has no audio track — nothing to cut on`)
  const duration = parseDuration(r.stderr)
  const silences = parseSilences(r.stderr, duration)
  return takeStats(file, silences, duration, speechSegments(silences, duration, o.pad))
}

const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]

export function renderCut(ff: Ff, take: TakeStats, out: string): void {
  if (take.segments.length === 0) throw new Error(`no speech found in ${basename(take.file)} — try a lower --noise (e.g. -45dB)`)
  const r = runFf(ff, ["-y", "-i", take.file, "-filter_complex", cutFilter(take.segments), "-map", "[v]", "-map", "[a]", ...ENCODE, out])
  if (r.status !== 0 || !existsSync(out)) fail(r.stderr, "rendering the cut")
}

function defaultOut(input: string, suffix: string, ext = ".mp4"): string {
  const abs = resolve(input)
  return join(dirname(abs), `${basename(abs, extname(abs))}.${suffix}${ext}`)
}

/** A bold font file for drawtext, which (unlike libass) wants a path. */
function titleFontFile(): string | null {
  if (which("fc-match")) {
    const r = spawnSync("fc-match", ["-f", "%{file}", "Arial:bold"], { encoding: "utf8" })
    const p = (r.stdout || "").trim()
    if (r.status === 0 && p && existsSync(p)) return p
  }
  for (const p of [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

/** drawtext option values: escape the characters its parser treats specially. */
function ffEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
}

// ----------------------------------------------------------------------------
// Output helpers
// ----------------------------------------------------------------------------

function makeSay(json: boolean) {
  return (s = "") => {
    if (!json) console.log(s)
  }
}

async function guard(args: any, title: string, body: (say: (s?: string) => void) => Promise<unknown>) {
  const json = Boolean(args.json)
  if (!json) {
    UI.empty()
    prompts.intro(`◈  reel ${title}`)
  }
  try {
    const result = await body(makeSay(json))
    if (json) await writeJson(result)
    else prompts.outro("Done")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (json) await writeJson({ ok: false, error: msg })
    else {
      prompts.log.error(msg)
      prompts.outro("Failed")
    }
    process.exitCode = 1
  }
}

const fmtS = (n: number) => `${n.toFixed(1)}s`

// ----------------------------------------------------------------------------
// iris reel cut
// ----------------------------------------------------------------------------

const CutCommand = cmd({
  command: "cut <takes..>",
  describe: "pick the best raw take and remove its pauses (H.264/AAC mp4)",
  builder: (y: any) =>
    y
      .positional("takes", { type: "string", array: true, describe: "one or more raw takes of the same script" })
      .option("out", { type: "string", describe: "output file (default: <best-take>.cut.mp4 beside it)" })
      .option("min-silence", { type: "number", default: 0.35, describe: "a quiet stretch at least this long (s) is a pause" })
      .option("noise", { type: "string", default: "-35dB", describe: "below this level counts as silence (35 or --noise=-35dB)" })
      .option("pad", { type: "number", default: 0.08, describe: "seconds kept either side of each speech segment" })
      .option("script", { type: "string", describe: "the script (text file): pick the take that says most of it" })
      .option("dry-run", { type: "boolean", default: false, describe: "analyse and pick, but render nothing" })
      .option("json", { type: "boolean", default: false })
      .epilogue(
        [
          "How the best take is chosen:",
          "  --script given  each take is transcribed on-device (whisper.cpp) and the take whose",
          "                  transcript contains the largest share of the script's words wins;",
          "                  ties go to the better speech score.",
          `  no --script     score = speech seconds − ${LONG_PAUSE_PENALTY}s per long pause (≥ ${LONG_PAUSE_SECONDS}s, not counting`,
          "                  the silence before the first word or after the last). Highest wins;",
          "                  ties go to the shorter take.",
          "",
          "Example:  iris reel cut take1.mov take2.mov --script script.txt --out cut.mp4",
        ].join("\n"),
      ),
  async handler(args: any) {
    await guard(args, "cut", async (say) => {
      const ff = requireFfmpeg()
      const files: string[] = (args.takes as string[]).map((t) => resolve(t))
      for (const f of files) if (!existsSync(f)) throw new Error(`File not found: ${f}`)
      const opts: SilenceOptions = { minSilence: Number(args["min-silence"]), noise: normaliseNoise(args.noise), pad: Number(args.pad) }

      const takes = files.map((f) => analyseTake(ff, f, opts))
      let coverage: number[] | undefined
      if (args.script) {
        const scriptPath = resolve(String(args.script))
        if (!existsSync(scriptPath)) throw new Error(`Script not found: ${scriptPath}`)
        const script = readFileSync(scriptPath, "utf8")
        coverage = []
        for (const t of takes) {
          if (!args.json) say(dim(`  transcribing ${basename(t.file)} on-device…`))
          coverage.push(scriptCoverage(script, await transcribeLocal(t.file)))
        }
      }

      say()
      say(`  ${bold("take".padEnd(28))} ${"length".padStart(8)} ${"speech".padStart(8)} ${"pauses".padStart(7)} ${"long".padStart(5)} ${"score".padStart(7)}${coverage ? "  script" : ""}`)
      printDividerIf(!args.json)
      takes.forEach((t, i) => {
        say(
          `  ${basename(t.file).slice(0, 28).padEnd(28)} ${fmtS(t.duration).padStart(8)} ${fmtS(t.speech).padStart(8)} ` +
            `${String(t.pauses).padStart(7)} ${String(t.longPauses).padStart(5)} ${String(takeScore(t)).padStart(7)}` +
            (coverage ? `  ${String(Math.round(coverage[i] * 100)).padStart(5)}%` : ""),
        )
      })

      const verdict = pickBestTake(takes, coverage)
      const best = takes[verdict.index]
      say()
      say(`  ${success("Best take:")} ${bold(basename(best.file))} — ${verdict.reason}`)

      const out = resolve(args.out ? String(args.out) : defaultOut(best.file, "cut"))
      const report: Record<string, unknown> = {
        ok: true,
        best: best.file,
        reason: verdict.reason,
        takes: takes.map((t, i) => ({ ...t, score: takeScore(t), coverage: coverage?.[i] })),
        out: args["dry-run"] ? null : out,
      }
      if (args["dry-run"]) return report

      mkdirSync(dirname(out), { recursive: true })
      if (!args.json) say(dim(`  rendering ${best.segments.length} segment(s)…`))
      renderCut(ff, best, out)
      const after = probe(ff, out).duration
      say(`  ${success("Cut:")} ${fmtS(best.duration)} → ${bold(fmtS(after))}  (${fmtS(best.duration - after)} of pauses removed)`)
      say(`  ${dim(out)}`)
      return { ...report, before: best.duration, after }
    })
  },
})

function printDividerIf(on: boolean) {
  if (on) printDivider(78)
}

// ----------------------------------------------------------------------------
// iris reel captions
// ----------------------------------------------------------------------------

const CaptionsCommand = cmd({
  command: "captions <video>",
  describe: "burn word-timed captions into a video (on-device whisper.cpp)",
  builder: (y: any) =>
    y
      .positional("video", { type: "string", demandOption: true })
      .option("out", { type: "string", describe: "output file (default: <video>.captioned.mp4)" })
      .option("words-per-line", { type: "number", default: 3 })
      .option("style", { type: "string", choices: ["pop", "plain"], default: "pop", describe: "pop highlights the word being said" })
      .option("position", { type: "string", choices: ["lower", "center"], default: "lower", describe: "lower stays above the bottom ~20% (reel UI)" })
      .option("font", { type: "string", default: "Arial", describe: "font family (libass/fontconfig resolves it)" })
      .option("srt", { type: "boolean", default: false, describe: "also write a sidecar .srt" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    await guard(args, "captions", async (say) => {
      const ff = requireFfmpeg()
      const input = resolve(String(args.video))
      if (!existsSync(input)) throw new Error(`File not found: ${input}`)
      const info = probe(ff, input)
      if (!info.size) throw new Error(`${basename(input)} has no video stream`)
      if (!info.audio) throw new Error(`${basename(input)} has no audio track — nothing to caption`)

      if (!args.json) say(dim("  transcribing on-device (whisper.cpp, word timings)…"))
      const ws = await transcribeWords(input)
      if (ws.length === 0) throw new Error("whisper heard no words in this video")
      const lines = groupWords(ws, Number(args["words-per-line"]))
      const ass = buildAss(lines, {
        width: info.size.width,
        height: info.size.height,
        style: args.style === "plain" ? "plain" : "pop",
        position: args.position === "center" ? "center" : "lower",
        font: String(args.font),
      })

      const out = resolve(args.out ? String(args.out) : defaultOut(input, "captioned"))
      mkdirSync(dirname(out), { recursive: true })
      const assPath = out.replace(/\.[^.\/]+$/, "") + ".ass"
      writeFileSync(assPath, ass)
      let srtPath: string | null = null
      if (args.srt) {
        srtPath = out.replace(/\.[^.\/]+$/, "") + ".srt"
        writeFileSync(srtPath, buildSrt(lines))
      }

      // Run from the .ass file's directory and name it bare: the filter-argument parser has its
      // own escaping for ':' and '\', and a bare name sidesteps all of it.
      if (!args.json) say(dim(`  burning ${lines.length} caption lines…`))
      const r = runFf(ff, ["-y", "-i", input, "-vf", `ass=${basename(assPath)}`, ...ENCODE, out], { cwd: dirname(assPath) })
      if (r.status !== 0 || !existsSync(out)) fail(r.stderr, "burning captions")

      say(`  ${success("Captioned:")} ${bold(String(ws.length))} words in ${bold(String(lines.length))} lines (${args.style}, ${args.position})`)
      say(`  ${dim(out)}`)
      say(`  ${dim(assPath)}`)
      if (srtPath) say(`  ${dim(srtPath)}`)
      return { ok: true, out, ass: assPath, srt: srtPath, words: ws.length, lines: lines.length }
    })
  },
})

// ----------------------------------------------------------------------------
// iris reel covers
// ----------------------------------------------------------------------------

/** Analysis resolution: enough detail to tell sharp from soft, small enough to hold in memory. */
const SAMPLE_W = 270
const SAMPLE_H = 480
/** Cover title type size and line pitch, in 1080x1920 pixels. */
const TITLE_SIZE = 120
const TITLE_LINE = 170

const CoversCommand = cmd({
  command: "covers <video>",
  describe: "pick the sharpest, well-spread frames as 1080x1920 cover JPGs",
  builder: (y: any) =>
    y
      .positional("video", { type: "string", demandOption: true })
      .option("count", { type: "number", default: 3 })
      .option("title", { type: "string", describe: "text drawn large on each cover" })
      .option("out", { type: "string", describe: "output directory (default: <video>-covers/ beside it)" })
      .option("every", { type: "number", default: 0.5, describe: "sample a candidate frame every N seconds" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    await guard(args, "covers", async (say) => {
      const ff = requireFfmpeg()
      const input = resolve(String(args.video))
      if (!existsSync(input)) throw new Error(`File not found: ${input}`)
      const info = probe(ff, input)
      if (!info.size) throw new Error(`${basename(input)} has no video stream`)
      const count = Math.max(1, Math.floor(Number(args.count)))
      const every = Math.max(0.1, Number(args.every))

      const work = mkdtempSync(join(tmpdir(), "iris-reel-covers-"))
      try {
        const rawPath = join(work, "frames.gray")
        const r = runFf(ff, [
          "-i", input, "-an",
          "-vf", `fps=1/${every},scale=${SAMPLE_W}:${SAMPLE_H}:force_original_aspect_ratio=increase,crop=${SAMPLE_W}:${SAMPLE_H},format=gray`,
          "-f", "rawvideo", "-pix_fmt", "gray", rawPath,
        ])
        if (r.status !== 0 || !existsSync(rawPath)) fail(r.stderr, "sampling frames")
        const buf = new Uint8Array(readFileSync(rawPath))
        const frameBytes = SAMPLE_W * SAMPLE_H
        const frames: FrameScore[] = []
        for (let i = 0; (i + 1) * frameBytes <= buf.length; i++) {
          // fps=1/N emits the frame nearest each N-second mark, starting at 0.
          frames.push({ t: round3(i * every), score: round3(laplacianVariance(buf.subarray(i * frameBytes, (i + 1) * frameBytes), SAMPLE_W, SAMPLE_H)) })
        }
        if (frames.length === 0) throw new Error("no frames could be sampled")
        const gap = defaultCoverGap(info.duration || frames.length * every, count)
        const picks = pickSpreadFrames(frames.filter((f) => f.score > 0), count, gap)
        if (picks.length === 0) throw new Error("every sampled frame was black or blown out")

        const outDir = resolve(args.out ? String(args.out) : join(dirname(input), `${basename(input, extname(input))}-covers`))
        mkdirSync(outDir, { recursive: true })

        let titleFilter = ""
        if (args.title) {
          // One drawtext per line, so each line is centred on its own (drawtext centres a
          // multi-line block as a block, leaving short lines hanging left). Each sits on its own
          // translucent band: a cover frame is often busy, and white type on a screen recording
          // is unreadable without one.
          const font = titleFontFile()
          titleFilter = wrapTitle(String(args.title), 14)
            .map((line, i) => {
              const textPath = join(work, `title-${i}.txt`)
              writeFileSync(textPath, line)
              return (
                `,drawtext=textfile='${ffEscape(textPath)}'` +
                (font ? `:fontfile='${ffEscape(font)}'` : "") +
                `:fontsize=${TITLE_SIZE}:fontcolor=white:borderw=6:bordercolor=black@0.9` +
                `:box=1:boxcolor=black@0.55:boxborderw=18` +
                `:x=(w-text_w)/2:y=h*0.1+${i * TITLE_LINE}`
              )
            })
            .join("")
        }

        const written: Array<{ file: string; t: number; sharpness: number }> = []
        for (let i = 0; i < picks.length; i++) {
          const p = picks[i]
          const file = join(outDir, `cover-${i + 1}.jpg`)
          const rr = runFf(ff, [
            "-y", "-ss", String(p.t), "-i", input, "-frames:v", "1",
            "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${titleFilter}`,
            "-q:v", "2", file,
          ])
          if (rr.status !== 0 || !existsSync(file)) fail(rr.stderr, `writing cover at ${p.t}s`)
          written.push({ file, t: p.t, sharpness: p.score })
        }

        say(`  ${dim(`sampled ${frames.length} frames every ${every}s; covers at least ${gap}s apart`)}`)
        for (const w of written) say(`  ${success("cover")} ${bold(fmtS(w.t).padStart(7))}  sharpness ${String(Math.round(w.sharpness)).padStart(6)}  ${dim(w.file)}`)
        if (written.length < count) say(`  ${dim(`only ${written.length} frames were far enough apart; ask for fewer or a shorter --every`)}`)
        return { ok: true, dir: outDir, covers: written, sampled: frames.length, minGap: gap }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    })
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformReelCommand = productCommand({
  name: "reel",
  purpose: "Talking-head reels — cut the best take, burn word captions, pick covers (ffmpeg, on-device)",
  keywords: ["reel", "talking head", "captions", "silence", "jump cut", "cover", "thumbnail", "video"],
  playbooks: ["talking-head-reel"],
  subcommands: [CutCommand, CaptionsCommand, CoversCommand],
})
