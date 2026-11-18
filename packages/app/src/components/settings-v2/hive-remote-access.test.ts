import { describe, expect, test } from "bun:test"
import { remoteAccessView, type RemoteAccessState } from "./hive-remote-access"

// Settings → Hive and Hive › Computers read the switch the same way (epic #192964 W2).
const s = (o: Partial<RemoteAccessState>): RemoteAccessState => ({ measured: true, allow: true, explicit: false, daemon: "online", nodeId: "n1", ...o })

describe("remoteAccessView", () => {
  test("ON and online: other machines can see and reply", () => {
    expect(remoteAccessView(s({}))).toMatchObject({ tone: "on", label: "On", short: "access allowed" })
  })
  test("OFF says scheduled work keeps running — whatever the daemon says", () => {
    const v = remoteAccessView(s({ allow: false, daemon: "online" }))
    expect(v).toMatchObject({ tone: "off", label: "Off" })
    expect(v.description).toContain("scheduled work keeps running")
  })
  test("ON but not online is a warning, never 'On'", () => {
    expect(remoteAccessView(s({ daemon: "not-running", nodeId: null })).label).toBe("Not connected")
    expect(remoteAccessView(s({ daemon: "not-enrolled", nodeId: null })).tone).toBe("warn")
    expect(remoteAccessView(s({ daemon: "not-running", reason: "Allowed, but this computer did not come online" })).description).toContain("did not come online")
  })
  test("unread is unknown, not off", () => {
    expect(remoteAccessView(undefined).label).toBe("Unknown")
    expect(remoteAccessView(undefined, true).label).toBe("Checking…")
    expect(remoteAccessView(s({ measured: false, reason: "boom" })).description).toBe("boom")
  })
})
