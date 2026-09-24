import { transcribeLocal, resolveFfmpeg } from "./transcription"
import { irisFetch, IRIS_API } from "../cmd/iris-api"
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { resolve, extname, basename, join, dirname } from "path"
import { tmpdir } from "os"
import { spawnSync } from "child_process"

// ============================================================================
// Shared front half of every "I talked through it, now make me something" command.
//
// `iris playbook draft` and `iris sop draft` differ entirely in what they PRODUCE and not at
// all in how they get the words. Keeping the transcript step here means the glossary lookup,
// the audio/text detection, and the too-short guard have one implementation — the alternative
// is two that agree today and drift by the next change to any of them.
// ============================================================================

const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".aiff", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".webm"])

/** Below this a "walkthrough" is a sentence, and the model will confidently invent a procedure. */
export const MIN_TRANSCRIPT_CHARS = 80

export interface Walkthrough {
  transcript: string
  /** Human-readable provenance, e.g. "spoken walkthrough, onboarding.m4a". Goes in the artifact. */
  source: string
  /** Whether the tenant's vocabulary was applied. Surfaced so the caller can say so. */
  hinted: boolean
}

/**
 * The caller's brand vocabulary, resolved server-side.
 *
 * Never throws and never blocks: no auth, no network, no glossary set — all mean "transcribe
 * unhinted", which is the correct degradation. A missing hint costs accuracy; a thrown error
 * costs the recording.
 */
export async function fetchGlossary(brandId?: number): Promise<string | undefined> {
  try {
    const qs = brandId ? `?brand_id=${brandId}` : ""
    const res = await irisFetch(`/api/v1/transcribe/glossary${qs}`, {}, IRIS_API)
    if (!res.ok) return undefined
    const body = (await res.json()) as any
    const g = body?.data?.glossary
    return typeof g === "string" && g.trim() ? g : undefined
  } catch {
    return undefined
  }
}

export function isAudio(path: string): boolean {
  return AUDIO_EXT.has(extname(path).toLowerCase())
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"])

export function isVideo(path: string): boolean {
  return VIDEO_EXT.has(extname(path).toLowerCase())
}

// ============================================================================
// Keyframes — what the screen showed, for the steps nobody said out loud
//
// Narration-only drafting loses every step done silently (Loom's AI SOPs have the same hole).
// The tools that get this right look at one frame per screen CHANGE, not every frame and not
// the whole file: scene detection picks the moments something happened, and a dozen of those
// at low detail is the entire vision budget for a draft.
// ============================================================================

export interface Keyframe {
  /** Seconds into the recording. */
  t: number
  jpeg: Buffer
  /** Where the command writes it, relative to the drafted document — the SOP links to it. */
  ref: string
}

/** Frames larger than this are skipped rather than sent; the server refuses ~700KB of base64. */
const MAX_FRAME_BYTES = 450_000
// Screen recordings change a little at a time. Measured on a three-screen recording (text on a
// white page): the two real screen changes scored 0.058 and 0.060, an unchanged screen ~0.00005.
// A camera-style 0.2–0.4 threshold registered neither change. 0.02 sits well clear of both.
const SCENE_THRESHOLD = "0.02"
const SCENE_CANDIDATES = 60
const KEYFRAME_TIMEOUT_MS = 10 * 60_000

function runFrames(ffmpeg: string, video: string, dir: string, filter: string, limit: number) {
  const r = spawnSync(
    ffmpeg,
    ["-hide_banner", "-nostats", "-i", video, "-vf", filter, "-fps_mode", "vfr", "-q:v", "6", "-frames:v", String(limit), join(dir, "%03d.jpg")],
    { encoding: "utf8", timeout: KEYFRAME_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  )
  const err = r.stderr ?? ""
  const times = [...err.matchAll(/Parsed_showinfo[^\n]*pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort() : []
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/)
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
  return { times, files, duration, status: r.status, err }
}

/** Spread `max` picks evenly across `n` candidates, always keeping the first and last. */
export function evenlyPick<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs
  if (max <= 1) return xs.slice(0, 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))])
  return [...new Set(out)]
}

/**
 * Up to `max` frames from a video, at the moments the screen changed.
 *
 * Never throws: a draft from the narration alone is still a draft, and losing it because frame
 * extraction failed would be the wrong trade. `note` says why there are fewer frames than asked.
 */
export function extractKeyframes(video: string, max: number): { frames: Keyframe[]; note?: string } {
  if (max <= 0) return { frames: [] }
  const ff = resolveFfmpeg()
  if (!ff.bin) return { frames: [], note: ff.diagnosis || "ffmpeg unavailable — drafted from narration only" }

  const dir = mkdtempSync(join(tmpdir(), "iris-frames-"))
  try {
    // Pass 1: the first frame plus every scene change, capped. showinfo runs before scale so the
    // timestamps are the source's.
    let run = runFrames(ff.bin, video, dir, `select='eq(n\\,0)+gt(scene\\,${SCENE_THRESHOLD})',showinfo,scale='min(1024\\,iw)':-2`, SCENE_CANDIDATES)

    // A screen recording that barely changes (one long form, a terminal) gives almost no scene
    // cuts. Fall back to evenly spaced frames rather than drafting blind.
    if (run.files.length < 3 && run.duration > 0) {
      for (const f of run.files) rmSync(join(dir, f), { force: true })
      const rate = Math.max(max, 1) / run.duration
      run = runFrames(ff.bin, video, dir, `fps=${rate.toFixed(6)},showinfo,scale='min(1024\\,iw)':-2`, max)
    }

    if (run.files.length === 0) {
      return { frames: [], note: `no frames could be read from this video${run.err ? ": " + run.err.trim().split("\n").slice(-1)[0] : ""}` }
    }

    // Drop a frame identical to the one before it. The evenly spaced fallback lands several
    // frames on one unchanged screen, and each duplicate is model input that says nothing new.
    const all: Array<{ t: number; jpeg: Buffer }> = []
    for (const [i, f] of run.files.entries()) {
      const jpeg = readFileSync(join(dir, f))
      if (all.length && all[all.length - 1].jpeg.equals(jpeg)) continue
      all.push({ t: run.times[i] ?? 0, jpeg })
    }
    const used = new Set<string>()
    const frames: Keyframe[] = []
    let skipped = 0
    for (const c of evenlyPick(all, max)) {
      const jpeg = c.jpeg
      if (jpeg.length > MAX_FRAME_BYTES) {
        skipped++
        continue
      }
      let ref = `frames/${String(Math.round(c.t)).padStart(4, "0")}.jpg`
      for (let k = 2; used.has(ref); k++) ref = `frames/${String(Math.round(c.t)).padStart(4, "0")}-${k}.jpg`
      used.add(ref)
      frames.push({ t: Math.round(c.t * 10) / 10, jpeg, ref })
    }
    return { frames, note: skipped ? `${skipped} frame(s) too large to send were skipped` : undefined }
  } catch (e) {
    return { frames: [], note: `frame extraction failed: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/**
 * Turn a path into words.
 *
 * Audio runs on-device — the audio never leaves the machine, which is the posture this product
 * needs for clinical walkthroughs. Only the vocabulary crosses the wire. There is deliberately
 * NO server fallback here: `iris transcribe` owns that chain, and a second copy is a second
 * thing to forget when it changes. A machine without whisper.cpp gets told to use that command.
 */
export async function resolveWalkthrough(
  input: string,
  opts: { brandId?: number; onTranscribeStart?: (hinted: boolean) => void } = {},
): Promise<Walkthrough> {
  const abs = resolve(input)
  if (!existsSync(abs)) throw new Error(`Not found: ${abs}`)

  let transcript: string
  let source: string
  let hinted = false

  if (isAudio(abs)) {
    const glossary = await fetchGlossary(opts.brandId)
    hinted = Boolean(glossary)
    opts.onTranscribeStart?.(hinted)
    try {
      transcript = await transcribeLocal(abs, { prompt: glossary })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`${msg}\nTranscribe it with \`iris transcribe\` first, then pass the .txt here.`)
    }
    source = `spoken walkthrough, ${basename(abs)}`
  } else {
    transcript = readFileSync(abs, "utf8").trim()
    source = `transcript, ${basename(abs)}`
  }

  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error("That transcript is too short to be a walkthrough of anything.")
  }

  return { transcript, source, hinted }
}

/** Hard ceiling the server enforces; asking for more is clamped, not refused. */
export const MAX_FRAMES = 12

/**
 * Frames for a draft, or none. Only a video has a screen to read; `max` 0 opts out.
 * Frames are images of the screen and they go to the drafting model, unlike the audio.
 */
export function framesFor(input: string, max: number): { frames: Keyframe[]; note?: string } {
  if (!(max > 0) || !isVideo(input)) return { frames: [] }
  return extractKeyframes(resolve(input), Math.min(Math.floor(max), MAX_FRAMES))
}

/**
 * Write the frames beside the drafted document and point its image links at them.
 *
 * The server links screens as `frames/<t>.jpg`. A playbook owns its folder, so that is right as
 * is; SOPs share one folder, so each gets `<name>-frames/` and the links are rewritten to match —
 * otherwise the second SOP drafted overwrites the first one's screenshots.
 */
export function writeFrames(frames: Keyframe[], docPath: string, markdown: string, dirName = "frames"): string {
  const base = dirname(docPath)
  for (const f of frames) {
    const out = join(base, f.ref.replace(/^frames\//, `${dirName}/`))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, f.jpeg)
  }
  return dirName === "frames" ? markdown : markdown.split("](frames/").join(`](${dirName}/`)
}

/** Steps the model recovered from the screen alone — the ones a reviewer should check first. */
export function seenOnlyCount(doc: StructuredWalkthrough): number {
  const steps = Array.isArray(doc.structured?.steps) ? doc.structured.steps : []
  return steps.filter((s: any) => s?.seen_only === true).length
}

export interface TreatedTranscript {
  treatment: string
  shape: string
  text: string
  /** The untouched transcript. Always present — a rewrite you cannot compare is one you cannot audit. */
  raw: string
  changed: boolean
  items?: Array<{ title: string; body: string }>
}

/**
 * Apply a named treatment to a transcript.
 *
 * Returns the ORIGINAL on any failure rather than throwing. The words are the valuable part; a
 * tidy-up pass is a convenience on top of them, and losing a recording because the convenience
 * failed would be the worst possible trade. The server takes the same position internally.
 */
export async function treatTranscript(
  transcript: string,
  treatment: string,
  model?: string,
): Promise<TreatedTranscript> {
  const untouched: TreatedTranscript = {
    treatment: "raw",
    shape: "text",
    text: transcript,
    raw: transcript,
    changed: false,
  }

  if (!treatment || treatment === "raw" || !transcript.trim()) return untouched

  try {
    const res = await irisFetch(
      "/api/v1/walkthrough/treat",
      { method: "POST", body: JSON.stringify({ transcript, treatment, ...(model ? { model } : {}) }) },
      IRIS_API,
    )
    if (!res.ok) return untouched
    const data = (await res.json()) as any
    const out = data?.data
    return out?.text ? (out as TreatedTranscript) : untouched
  } catch {
    return untouched
  }
}

/** Treatments the server will accept for this caller, including their brand's own. */
export async function listTreatments(): Promise<Array<{ id: string; label: string; description: string; shape: string; custom: boolean }>> {
  try {
    const res = await irisFetch("/api/v1/walkthrough/treatments", {}, IRIS_API)
    if (!res.ok) return []
    const data = (await res.json()) as any
    const map = data?.data?.treatments ?? {}
    return Object.keys(map).map((id) => ({ id, ...map[id] }))
  } catch {
    return []
  }
}

export interface StructuredWalkthrough {
  format: "sop" | "playbook"
  title: string
  markdown: string
  structured: Record<string, any>
  /** How many frames the server actually used. Absent on servers older than frame support. */
  frames_used?: number
}

/**
 * Turn a transcript into a procedure, server-side.
 *
 * THE PROMPTS DELIBERATELY DO NOT LIVE HERE. They were in this file first; the moment the
 * CardEditor capture tab needed them the choice was to copy them into Vue or move them to the
 * one place both callers already talk to. Copied prompts do not stay equal — somebody improves
 * the SOP wording on one surface and the two quietly produce different documents from the same
 * recording, while both look correct. That is the same failure shape as the glossary resolution
 * having lived in three places, which is why that is single-sourced too.
 *
 * This does not weaken the on-device posture: transcription still runs locally, and the
 * transcript already crossed the wire to a model proxy before this change. Only the audio is
 * privileged, and the audio still never leaves the machine.
 */
export async function structureWalkthrough(
  transcript: string,
  format: "sop" | "playbook",
  model?: string,
  frames: Keyframe[] = [],
): Promise<StructuredWalkthrough> {
  const res = await irisFetch(
    "/api/v1/walkthrough/structure",
    {
      method: "POST",
      body: JSON.stringify({
        transcript,
        format,
        ...(model ? { model } : {}),
        ...(frames.length
          ? { frames: frames.map((f) => ({ t: f.t, image: `data:image/jpeg;base64,${f.jpeg.toString("base64")}`, ref: f.ref })) }
          : {}),
      }),
    },
    IRIS_API,
  )

  if (!res.ok) {
    // The server distinguishes "your input is unusable" (422) from "we could not produce a
    // document" (502), and its message says which. Passing it through beats a status code the
    // reader has to decode.
    const body = await res.text().catch(() => "")
    let message = ""
    try {
      message = JSON.parse(body)?.error ?? ""
    } catch {
      /* non-JSON body — fall back to the status */
    }
    throw new Error(message || `Could not structure the walkthrough (HTTP ${res.status}).`)
  }

  const data = (await res.json()) as any
  const result = data?.data
  if (!result?.markdown) {
    // A 200 with no document is the silent-failure shape: it reads as "your walkthrough had no
    // steps in it" when the truth is that extraction returned nothing.
    throw new Error("Nothing came back. Your transcript is unchanged.")
  }

  return result as StructuredWalkthrough
}
