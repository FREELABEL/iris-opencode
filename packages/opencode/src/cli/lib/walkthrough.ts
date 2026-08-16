import { transcribeLocal } from "./transcription"
import { irisFetch, IRIS_API } from "../cmd/iris-api"
import { existsSync, readFileSync } from "fs"
import { resolve, extname, basename } from "path"

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

/**
 * Treatments the server will accept for this caller, including their brand's own.
 *
 * `endpoint` is non-null for document-shaped treatments (sop, playbook, article), which are NOT
 * applied by `--treatment` — they are produced by a different POST. The server ships the
 * destination alongside the option precisely so a picker can say where it goes; without it a
 * caller reads `article` off the list, passes `--treatment article`, and gets a 422 for asking
 * a reasonable question of a listed option.
 */
export async function listTreatments(): Promise<Array<{ id: string; label: string; description: string; shape: string; custom: boolean; endpoint: string | null }>> {
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
): Promise<StructuredWalkthrough> {
  const res = await irisFetch(
    "/api/v1/walkthrough/structure",
    {
      method: "POST",
      body: JSON.stringify({ transcript, format, ...(model ? { model } : {}) }),
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
