// ============================================================================
// The decisions `iris transcribe` makes about whether it succeeded.
//
// This file imports NOTHING on purpose. Every one of these was a silent failure in
// production first, and a silent failure is exactly what you cannot test through a
// spinner, a network call and a filesystem write. Keeping them pure means the guard
// can be proven to fire, rather than assumed to.
//
// #183797 — a YouTube URL returned HTTP 200 with an empty transcript. The command read
//   `tool.ok` as success, printed an empty string, never wrote --output, and exited 0.
// #183796 — a treatment the server rejected (422) fell back to the untouched transcript,
//   which is the RIGHT trade, and then said "Saved" without mentioning it. The fallback
//   is not the bug; the silence is.
// ============================================================================

export type ServerVerdict =
  | { kind: "finish"; text: string }
  | { kind: "fallback"; reason: string }

/**
 * Decide whether a server transcription result is actually a transcript.
 *
 * `ok` only means the request completed. The whole class of bug here is treating the
 * transport's verdict as the content's verdict, so the text is checked separately and a
 * blank one is a fallback — never a finish.
 */
export function serverTranscriptVerdict(tool: {
  ok: boolean
  data?: { text?: string | null } | null
}): ServerVerdict {
  if (!tool.ok) return { kind: "fallback", reason: "the server transcription call did not succeed" }
  const text = tool.data?.text
  if (typeof text !== "string" || !text.trim()) {
    return {
      kind: "fallback",
      reason: "the server returned success but no transcript text (no captions, a bot check, or an unsupported source)",
    }
  }
  return { kind: "finish", text }
}

/**
 * A filename for a transcript of `source`, which may be a URL or a local path.
 *
 * The server URL paths had no local file to take a basename from, which is how --output
 * came to be ignored entirely on them. The identifying part of the URL is kept so two
 * videos from the same host do not overwrite each other.
 *
 * The result is joined onto a caller-supplied directory, so it must never be able to
 * escape one: no separators, no parent references, no percent-encoding left intact.
 */
export function transcriptFileName(source: string): string {
  const raw = (source ?? "").trim()
  let stem = ""

  const youtube = raw.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)
  const social = raw.match(/(?:instagram\.com|tiktok\.com|x\.com|twitter\.com|threads\.net|facebook\.com)\/(?:[^/?#]+\/)*?(?:reel|reels|p|video|status)\/([A-Za-z0-9_-]{4,})/i)

  if (youtube) {
    stem = youtube[1]
  } else if (social) {
    stem = social[1]
  } else if (/^https?:\/\//i.test(raw)) {
    // Anything else on the web: host plus the last meaningful path segment, query dropped.
    const withoutScheme = raw.replace(/^https?:\/\//i, "")
    const [hostAndPath] = withoutScheme.split(/[?#]/)
    const parts = hostAndPath.split("/").filter((p) => p && p !== "." && p !== "..")
    stem = parts.slice(0, 1).concat(parts.slice(-1)).join("-")
  } else {
    // A local path: the basename without its extension.
    const [pathOnly] = raw.split(/[?#]/)
    const base = pathOnly.split(/[/\\]/).filter(Boolean).pop() ?? ""
    stem = base.replace(/\.[^.]*$/, "")
  }

  // Decode first so an encoded separator cannot survive, then allow only safe characters.
  // Everything else collapses to a hyphen, which makes ".." impossible by construction.
  let safe = stem
  try {
    safe = decodeURIComponent(stem)
  } catch {
    /* a malformed escape is not worth failing a filename over */
  }
  safe = safe
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)

  return `${safe || "transcript"}-transcript.txt`
}

/**
 * The line to print when a treatment was asked for and the text came back unchanged.
 *
 * Returning the original on failure is deliberate — losing a recording because a tidy-up
 * pass failed would be a far worse trade. But an unannounced fallback is indistinguishable
 * from "your recording was already tidy", and the reader acts on a document that is not
 * the one they asked for.
 */
export function treatmentWarning(requested: string | undefined, changed: boolean): string | null {
  if (!requested || requested === "raw") return null
  if (changed) return null
  return `The '${requested}' treatment did not run — the transcript below is the untouched original. Re-run with --print-logs to see why.`
}

/**
 * Treatments that are produced by /walkthrough/structure, not /walkthrough/treat.
 *
 * `--list-treatments` advertises these alongside the others, but /treat rejects them with a 422
 * (#183796). They are not unsupported — they have their own endpoint, the one `iris playbook
 * draft` and `iris sop draft` already use, and it works. Routing them there is the fix.
 *
 * `article` is deliberately NOT in this list. It 422s the same way, but no endpoint produces it,
 * so sending it to /structure would trade a visible failure for a confusing one.
 */
export const STRUCTURED_TREATMENTS = ["sop", "playbook"] as const

export function isStructuredTreatment(treatment: string | undefined): boolean {
  return !!treatment && (STRUCTURED_TREATMENTS as readonly string[]).includes(treatment)
}
