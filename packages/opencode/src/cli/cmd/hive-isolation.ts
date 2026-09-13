/**
 * Does this node CONTAIN what it runs?
 *
 * The daemon has always known. `planScriptExecution()` returns mode `sandboxed` or `host`, and
 * the host path is logged — into that machine's own console, where nobody looking at the fleet
 * can see it. So a node running every script directly on the metal rendered identically to one
 * containing them, which is the difference an operator most needs before sending work
 * somewhere, and the one thing the node list did not say.
 *
 * Extracted rather than left inline in the renderer for the same reason `planScriptExecution`
 * was pulled out of the 4,000-line executor: a branch inside a print statement is a branch
 * nobody can test.
 *
 * THREE STATES, NOT TWO. The probe already distinguishes them — `available` is `true`, `false`
 * or `null`, because "the probe broke" is not "the runtime is missing" and an operator sent to
 * fix the wrong one of those loses an afternoon. This is where that distinction was being
 * flattened on its way to the screen.
 */

export type IsolationTone = "ok" | "warn" | "muted"

export interface IsolationLine {
  tone: IsolationTone
  /** The label. Never empty — a blank line reads as a rendering bug, not as an absence. */
  text: string
  /** Supporting detail, shown dim beside the label. */
  detail?: string
}

export interface IsolationProbe {
  available?: boolean | null
  reason?: string | null
  detail?: string | null
}

/**
 * @param probe   node.permissions.isolation, or undefined on a daemon that predates it
 * @param online  whether the node is currently connected
 * @returns the line to print, or null when there is genuinely nothing to say
 */
export function describeIsolation(probe: IsolationProbe | null | undefined, online: boolean): IsolationLine | null {
  if (!probe || typeof probe !== "object") {
    // An OLD daemon is not an unsandboxed one, and must not be drawn as either. Only worth
    // saying at all while the node is online — an offline node's silence explains itself.
    return online
      ? { tone: "muted", text: "sandbox: not reported — this daemon predates the isolation probe" }
      : null
  }

  if (probe.available === true) {
    return { tone: "muted", text: "sandbox:", detail: probe.detail || "available" }
  }

  if (probe.available === false) {
    // Stated, not alarmed. Running unsandboxed on your own laptop is a legitimate choice;
    // an invisible one is how it stops being a choice.
    return {
      tone: "warn",
      text: "sandbox: none — scripts run directly on this machine",
      detail: probe.reason || undefined,
    }
  }

  // null / undefined / anything else: the probe did not answer.
  return { tone: "muted", text: `sandbox: unknown — ${probe.reason || "the probe did not report"}` }
}
