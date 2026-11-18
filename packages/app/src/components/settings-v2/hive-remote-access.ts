/**
 * "Allow access to this computer" (epic #192964 W2): the state the engine reports at
 * GET /iris/hive/remote-access, and the one-line reading of it that Settings → Hive and
 * Hive › Computers both show. Pure, so the words are tested without a browser.
 */
export interface RemoteAccessState {
  measured: boolean
  reason?: string
  allow: boolean
  explicit: boolean
  daemon: "online" | "not-enrolled" | "not-running"
  nodeId: string | null
}

export type Tone = "on" | "off" | "warn" | "unknown"

export function remoteAccessView(s: RemoteAccessState | undefined, loading = false): { tone: Tone; label: string; short: string; description: string } {
  if (!s) {
    return loading
      ? { tone: "off", label: "Checking…", short: "checking…", description: "Reading this computer's Hive switch." }
      : { tone: "unknown", label: "Unknown", short: "unknown", description: "IRIS couldn't read this computer's Hive switch." }
  }
  if (!s.measured) return { tone: "unknown", label: "Unknown", short: "unknown", description: s.reason ?? "IRIS couldn't read this computer's Hive switch." }
  if (!s.allow) {
    return {
      tone: "off",
      label: "Off", short: "access off",
      description:
        "Other machines in your Hive can't see this computer or send to its sessions. Its own scheduled work keeps running.",
    }
  }
  if (s.daemon === "online") {
    return {
      tone: "on",
      label: "On", short: "access allowed",
      description: "Your other machines and your phone can see this computer's sessions and reply to them.",
    }
  }
  return {
    tone: "warn",
    label: "Not connected", short: "allowed, not connected",
    description:
      s.reason ??
      (s.daemon === "not-running"
        ? "Allowed, but this computer's Hive daemon isn't running. Turn the switch off and on to start it."
        : "Allowed, but this computer hasn't joined your Hive yet. Turn the switch off and on to connect it."),
  }
}
