/**
 * Following a session's reply from another machine (`iris hive ask`, #190671).
 *
 * The cloud reads a session's transcript off the machine that holds it, a page at a time. A reply
 * is the run of messages AFTER the one we sent; while the model writes, its text part grows in
 * place, so each poll prints only what was added since the last one. Pure, so the shapes that went
 * wrong can be pinned without a fleet.
 */

export type TranscriptMessage = {
  role?: string
  type?: string
  text?: string
  tool?: string
  file_path?: string | null
  command?: string | null
}

export type FollowState = {
  /** What has been printed for each message after the anchor, by position. */
  printed: string[]
  /** True once the message we sent has been seen in the transcript. */
  anchored: boolean
  /** True once at least one assistant text has appeared after the anchor. */
  answered: boolean
  /** The after-anchor snapshot last time, to tell "still writing" from "done". */
  last: string
}

export const newFollowState = (): FollowState => ({ printed: [], anchored: false, answered: false, last: "" })

/**
 * The index of the message we sent: the LAST user text containing it. Last, because the same words
 * may have been sent before; the bridge prefixes `[via iris · host]`, hence contains, not equals.
 */
export function anchorIndex(messages: TranscriptMessage[], sent: string): number {
  const needle = sent.trim().slice(0, 200)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && m.type === "text" && typeof m.text === "string" && m.text.includes(needle)) return i
  }
  return -1
}

function toolLine(m: TranscriptMessage): string {
  const what = m.command || m.file_path || ""
  return `· ${m.tool || "tool"}${what ? " " + what : ""}`
}

/**
 * One poll. Returns the text to print (may be empty) and whether the reply has settled: it has an
 * answer and nothing changed since the previous poll. The caller decides how many quiet polls make
 * "done" — a model pausing on a slow tool looks identical to a model that finished.
 */
export function followStep(state: FollowState, messages: TranscriptMessage[], sent: string): { out: string; changed: boolean } {
  const a = anchorIndex(messages, sent)
  if (a < 0) return { out: "", changed: false }
  state.anchored = true
  const after = messages.slice(a + 1)
  let out = ""
  after.forEach((m, i) => {
    const had = state.printed[i] ?? ""
    if (m.type === "tool_use") {
      if (!had) {
        out += (out.endsWith("\n") || out === "" ? "" : "\n") + toolLine(m) + "\n"
        state.printed[i] = toolLine(m)
      }
      return
    }
    if (m.type !== "text" || typeof m.text !== "string") return
    if (m.role === "assistant" && m.text.trim()) state.answered = true
    const prefix = m.role === "user" ? "\n› " : ""
    if (!had) {
      out += prefix + m.text
      state.printed[i] = m.text
    } else if (m.text.startsWith(had)) {
      out += m.text.slice(had.length)
      state.printed[i] = m.text
    } else if (m.text !== had) {
      // Rewritten rather than appended (the reader got a fresh page) — say so, then reprint.
      out += "\n" + prefix + m.text
      state.printed[i] = m.text
    }
  })
  const snap = JSON.stringify(after)
  const changed = snap !== state.last
  state.last = snap
  return { out, changed }
}
