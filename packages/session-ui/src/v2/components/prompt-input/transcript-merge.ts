/**
 * The words of a live dictation take, as the streaming engine reports them.
 *
 * xAI streaming STT (via the IRIS STT relay) speaks in three kinds of event, measured on the wire
 * on 2026-10-15 (#189543):
 *
 *   partial      is_final=false            the segment in progress, restated in full every time
 *   final        is_final=true             a segment is locked
 *   turn         is_final=speech_final=true the speaker paused: the WHOLE turn is restated — every
 *                                          final since the last turn, joined, in one event
 *
 * A one-segment phrase therefore arrives as   final "I need to build a shopping list."
 *                                             turn  "I need to build a shopping list."
 * and a longer one as  final A · final B · turn "A B".  Appending every final put each phrase on
 * screen twice. The turn is the authoritative text for its segments, so it REPLACES them.
 *
 * Text is never compared. "No, no." is real speech, and saying the same sentence twice is two
 * turns — both kept. Only the event kinds decide what replaces what.
 */
export type LiveTranscript = {
  /** Turns the engine has closed. Never rewritten. */
  committed: string[]
  /** Segments locked inside the turn still being spoken; the turn event replaces them. */
  segments: string[]
  /** The segment being heard right now; the next partial or final replaces it. */
  interim: string
}

export type LiveTranscriptEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string; turn?: boolean }

export const emptyTranscript: LiveTranscript = { committed: [], segments: [], interim: "" }

export function mergeTranscript(state: LiveTranscript, event: LiveTranscriptEvent): LiveTranscript {
  if (event.type === "partial") return { ...state, interim: event.text }
  if (event.turn) {
    // The turn restates its segments: it takes their place, it does not follow them.
    const text = event.text.trim() ? [event.text] : state.segments
    return { committed: [...state.committed, ...text], segments: [], interim: "" }
  }
  return { ...state, segments: [...state.segments, event.text], interim: "" }
}

/** Everything locked so far — what the engine will not take back. */
export function lockedText(state: LiveTranscript): string {
  return tidy([...state.committed, ...state.segments])
}

/** What to show: locked words, then the words still being heard. */
export function transcriptText(state: LiveTranscript): string {
  return tidy([...state.committed, ...state.segments, state.interim])
}

function tidy(parts: string[]) {
  return parts.join(" ").replace(/\s+/g, " ").trim()
}
