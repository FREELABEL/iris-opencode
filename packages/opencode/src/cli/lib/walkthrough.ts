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

/**
 * Ask a nano model for JSON and get an object back, or throw.
 *
 * Shared because the failure mode is shared: a model that returns prose around its JSON, or
 * nothing usable, must not be reported as a successful empty artifact.
 */
export async function extractJson<T>(system: string, user: string, model: string, maxTokens = 3000): Promise<T> {
  const res = await irisFetch(
    "/api/v6/openai/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
    },
    IRIS_API,
  )

  if (!res.ok) {
    throw new Error(`Generation failed (HTTP ${res.status}). ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  let content = String(data?.choices?.[0]?.message?.content ?? "").trim()
  const m = content.match(/\{[\s\S]*\}/)
  if (m) content = m[0]

  try {
    return JSON.parse(content) as T
  } catch {
    throw new Error("The model did not return a usable result. Your transcript is still saved.")
  }
}
