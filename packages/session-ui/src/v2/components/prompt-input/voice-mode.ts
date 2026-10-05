/**
 * Which kind of take is running, and where its words go.
 *
 * - quick: inline. The transcript is inserted at the cursor when the take ends.
 * - background: keeps recording while the person works; the corner panel shows it. Its transcript
 *   is held for review — Insert, Copy or Discard — and never reaches the prompt on its own.
 *
 * Kept free of the recorder so the rules can be tested without a microphone. The component maps
 * effects onto the recorder (cancel) and the editor (insert) and the clipboard (copy).
 */
export type VoiceMode = "idle" | "quick" | "background" | "review"
export type PanelState = "hidden" | "open" | "collapsed"
export type VoiceEffect = { type: "insert"; text: string } | { type: "copy"; text: string } | { type: "cancel" }

export type VoiceState = {
  mode: VoiceMode
  panel: PanelState
  /** A finished background transcript awaiting the person's decision. */
  result?: string
  /** One-shot instruction for the component; cleared by the next event. */
  effect?: VoiceEffect
}

export type VoiceEvent =
  /** The mic button or the shortcut. */
  | { type: "mic" }
  /** "Start background recording" from the mic's menu. */
  | { type: "background" }
  /** "Keep recording": hand a running quick take to the background. */
  | { type: "keep" }
  | { type: "transcript"; text: string }
  | { type: "failed" }
  | { type: "insert" }
  | { type: "copy" }
  | { type: "discard" }
  | { type: "noop" }

export const initialVoice: VoiceState = { mode: "idle", panel: "hidden" }

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  const s: VoiceState = { mode: state.mode, panel: state.panel, result: state.result }
  switch (event.type) {
    case "mic":
      if (s.mode === "idle") return { ...s, mode: "quick" }
      if (s.mode === "quick") return s // the recorder stops itself; the transcript event ends the mode
      // background or review: fold and unfold the panel, never a second take
      return { ...s, panel: s.panel === "collapsed" ? "open" : "collapsed" }
    case "background":
      if (s.mode === "idle") return { ...s, mode: "background", panel: "open" }
      if (s.mode === "quick") return { ...s, mode: "background", panel: "open" }
      return s
    case "keep":
      return s.mode === "quick" ? { ...s, mode: "background", panel: "open" } : s
    case "transcript":
      if (s.mode === "background") return { ...s, mode: "review", panel: "open", result: event.text }
      if (s.mode === "review") return s
      return { mode: "idle", panel: "hidden", effect: { type: "insert", text: event.text } }
    case "failed":
      return s.mode === "review" ? s : { mode: "idle", panel: "hidden" }
    case "insert":
      return s.mode === "review" && s.result
        ? { mode: "idle", panel: "hidden", effect: { type: "insert", text: s.result } }
        : s
    case "copy":
      return s.mode === "review" && s.result ? { mode: "idle", panel: "hidden", effect: { type: "copy", text: s.result } } : s
    case "discard":
      if (s.mode === "background") return { mode: "idle", panel: "hidden", effect: { type: "cancel" } }
      if (s.mode === "review") return { mode: "idle", panel: "hidden" }
      return s
    case "noop":
      return s
  }
}
