import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  fetchDaemonPermissions,
  classifyPermissions,
  isTccDenial,
  fdaFixLines,
  mayPromptForFix,
  renderTccBlindSpot,
  type DaemonPermissions,
} from "./daemon-permissions"
import { blindSpotLines, blindSpotsJson, tccBlindSpots } from "./platform-pulse-check"
import type { SourceSweep } from "./pulse-check-sweep"

// =============================================================================
// `iris pulse check` and `iris mail search` printed the daemon's raw 503 for a Full Disk
// Access refusal and stopped there. The reader learned WHAT was wrong and not which program
// to approve — and the obvious guess (their terminal) cannot work, because launchd starts
// the daemon. These tests pin the classification and that the fix names the binary.
// =============================================================================

const BIN = "/Users/someone/.nvm/versions/node/v22.23.2/bin/node"
const RAW_503 =
  'Apple Mail search returned 503: {"error":"No permission to read Mail — the iris daemon has no Full Disk Access (the DAEMON\'s own grant, not your terminal\'s)"}'

function body(process: boolean | null, fresh: boolean | null, restart = false) {
  return {
    platform: "darwin",
    binary: BIN,
    pinned: BIN,
    launchd: true,
    process: { available: process, reason: "x" },
    fresh: { available: fresh, reason: "y" },
    restart_needed: restart,
    fix: { command: "iris-daemon grant-access", settings_url: "x-apple.systempreferences:test" },
  }
}

/** A fetch that answers by path. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname
    const r = routes[path]
    if (!r) return new Response("not found", { status: 404 })
    return r()
  }) as any
}

const base = {
  bridgeUrl: "http://127.0.0.1:3200",
  bridgeKey: "k",
  locateBinary: () => BIN,
  grantAccessSupported: () => true,
}

describe("classifyPermissions", () => {
  test("running process can read → granted", () => {
    expect(classifyPermissions(body(true, true)).state).toBe("granted")
  })
  test("both refused → denied", () => {
    expect(classifyPermissions(body(false, false)).state).toBe("denied")
  })
  test("fresh granted, running not → restart_needed (even if the flag is missing)", () => {
    expect(classifyPermissions(body(false, true, true)).state).toBe("restart_needed")
    expect(classifyPermissions(body(false, true, false)).state).toBe("restart_needed")
  })
  test("no answer → unknown, never granted", () => {
    expect(classifyPermissions(body(null, null)).state).toBe("unknown")
    expect(classifyPermissions(null).state).toBe("unknown")
  })
})

describe("fetchDaemonPermissions", () => {
  test("200 denied carries the daemon's binary", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: fakeFetch({ "/daemon/permissions": () => Response.json(body(false, false)) }),
    })
    expect(p.state).toBe("denied")
    expect(p.binary).toBe(BIN)
    expect(p.command).toBe("iris-daemon grant-access")
  })

  test("200 restart_needed points at a restart", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: fakeFetch({ "/daemon/permissions": () => Response.json(body(false, true, true)) }),
    })
    expect(p.state).toBe("restart_needed")
    expect(p.command).toBe("iris-daemon restart")
  })

  test("200 granted", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: fakeFetch({ "/daemon/permissions": () => Response.json(body(true, true)) }),
    })
    expect(p.state).toBe("granted")
    expect(fdaFixLines(p)).toEqual([])
  })

  test("404 with /daemon/health answering → old_daemon, binary found locally", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: fakeFetch({ "/daemon/health": () => Response.json({ ok: true }) }),
    })
    expect(p.state).toBe("old_daemon")
    expect(p.binary).toBe(BIN)
  })

  test("404 with /daemon/health also 404 → daemon_starting, not old_daemon", async () => {
    const p = await fetchDaemonPermissions({ ...base, fetchImpl: fakeFetch({}) })
    expect(p.state).toBe("daemon_starting")
  })

  test("starting daemon is retried until its routes mount", async () => {
    let calls = 0
    const p = await fetchDaemonPermissions({
      ...base,
      waitForStartMs: 10_000,
      sleep: async () => {},
      fetchImpl: fakeFetch({
        "/daemon/permissions": () => (++calls < 3 ? new Response("", { status: 404 }) : Response.json(body(false, false))),
      }),
    })
    expect(p.state).toBe("denied")
    expect(calls).toBe(3)
  })

  test("connection refused → daemon_down, never throws", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: (async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
      }) as any,
    })
    expect(p.state).toBe("daemon_down")
  })

  test("timeout → unknown (the daemon is up but did not answer)", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      timeoutMs: 50,
      fetchImpl: ((_u: string, init: any) =>
        new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) as any,
    })
    expect(p.state).toBe("unknown")
  })

  test("401 → unknown with a token reason", async () => {
    const p = await fetchDaemonPermissions({
      ...base,
      fetchImpl: fakeFetch({ "/daemon/permissions": () => new Response("", { status: 401 }) }),
    })
    expect(p.state).toBe("unknown")
    expect(p.reason).toContain("bridge-token")
  })
})

describe("isTccDenial", () => {
  test("matches the daemon's mail refusal and sqlite3's", () => {
    expect(isTccDenial(RAW_503)).toBe(true)
    expect(isTccDenial("Error: unable to open database: authorization denied")).toBe(true)
    expect(isTccDenial("Full Disk Access required — System Settings › …")).toBe(true)
  })
  test("does not match an ordinary failure", () => {
    expect(isTccDenial("IRIS bridge not reachable at http://127.0.0.1:3200")).toBe(false)
    expect(isTccDenial("Apple Mail search returned 500: Command failed")).toBe(false)
    expect(isTccDenial(undefined)).toBe(false)
  })
})

function perms(over: Partial<DaemonPermissions>): DaemonPermissions {
  return {
    state: "denied",
    binary: BIN,
    reason: "r",
    command: "iris-daemon grant-access",
    settingsUrl: "s",
    grantAccessSupported: true,
    ...over,
  }
}

describe("fdaFixLines", () => {
  test("denied names the command AND the exact file", () => {
    const lines = fdaFixLines(perms({}))
    expect(lines.join("\n")).toContain("iris-daemon grant-access")
    expect(lines.join("\n")).toContain(BIN)
    expect(lines.length).toBeLessThanOrEqual(3)
  })
  test("restart pending says restart, not grant", () => {
    expect(fdaFixLines(perms({ state: "restart_needed" }))).toEqual(["granted — restart pending: iris-daemon restart"])
  })
  test("old daemon without grant-access never names a verb it lacks as the fix", () => {
    const lines = fdaFixLines(perms({ state: "old_daemon", grantAccessSupported: false }))
    expect(lines[0]).not.toContain("grant-access")
    expect(lines.join("\n")).toContain(BIN)
    expect(lines.join("\n")).toContain("iris node install")
  })
})

describe("pulse blind spot", () => {
  const mail: SourceSweep = { source: "email", searched: false, unavailableReason: RAW_503, hits: 0, items: [] }
  const imsg: SourceSweep = {
    source: "imessage",
    searched: false,
    unavailableReason: "Full Disk Access required — System Settings › Privacy & Security › Full Disk Access, then restart the terminal",
    hits: 0,
    items: [],
  }
  const down: SourceSweep = { source: "email", searched: false, unavailableReason: "IRIS bridge not reachable", hits: 0, items: [] }

  // The detailed fix (exact file, grant-access) is OPERATOR-only: for a client it would mean
  // approving a stock `node` binary for Full Disk Access (client-ready gate, 2026-10-04).
  const prevOp = process.env.IRIS_OPERATOR
  beforeEach(() => { process.env.IRIS_OPERATOR = "1" })
  afterEach(() => { if (prevOp === undefined) delete process.env.IRIS_OPERATOR; else process.env.IRIS_OPERATOR = prevOp })

  test("CLIENT: one calm line — no file path, no program name, no command", () => {
    delete process.env.IRIS_OPERATOR
    for (const [label, sweep] of [["Apple Mail", mail], ["iMessage", imsg]] as const) {
      const out = blindSpotLines(label.padEnd(12), sweep, perms({})).join("\n")
      expect(out).toContain("isn't connected to IRIS on this Mac yet")
      expect(out).not.toContain(BIN)
      expect(out).not.toContain("node")
      expect(out).not.toContain("grant-access")
      expect(out).not.toContain("Full Disk Access")
      expect(out).not.toContain("503")
    }
  })

  test("Mail refusal renders the fix, not the raw 503", () => {
    const out = blindSpotLines("Apple Mail".padEnd(12), mail, perms({})).join("\n")
    expect(out).toContain("isn't allowed to read Mail")
    expect(out).toContain("fix once: iris-daemon grant-access")
    expect(out).toContain(BIN)
    expect(out).not.toContain("503")
  })

  test("restart pending renders as such", () => {
    const out = blindSpotLines("Apple Mail".padEnd(12), mail, perms({ state: "restart_needed" })).join("\n")
    expect(out).toContain("restart pending: iris-daemon restart")
  })

  test("Messages is the TERMINAL's grant — never offered the daemon's fix", () => {
    const out = blindSpotLines("iMessage".padEnd(12), imsg, perms({})).join("\n")
    expect(out).toContain("this terminal")
    expect(out).not.toContain("grant-access")
  })

  test("a non-TCC blind spot keeps the plain 'not searched' line", () => {
    const out = blindSpotLines("Apple Mail".padEnd(12), down, perms({})).join("\n")
    expect(out).toContain("not searched")
    expect(tccBlindSpots([down])).toHaveLength(0)
  })

  test("--json carries a machine-readable fix", () => {
    const gmailDown: SourceSweep = { ...down, source: "gmail" }
    const js = blindSpotsJson([mail, imsg, gmailDown], perms({}))
    expect(js.find((b) => b.source === "email" && b.full_disk_access)?.fix).toMatchObject({
      process: "daemon",
      command: "iris-daemon grant-access",
      binary: BIN,
    })
    expect(js.find((b) => b.source === "imessage")?.fix).toMatchObject({ process: "terminal" })
    expect(js.find((b) => b.source === "gmail")?.fix).toBeNull()
  })

  test("renderTccBlindSpot for the daemon without permissions still names the command", () => {
    expect(renderTccBlindSpot("Mail", "daemon", null).fix[0]).toContain("iris-daemon grant-access")
  })
})

describe("mayPromptForFix", () => {
  const tty = { stdinTTY: true, stdoutTTY: true, env: { IRIS_OPERATOR: "1" } as Record<string, string> }
  test("interactive terminal, operator → may ask", () => {
    expect(mayPromptForFix(tty)).toBe(true)
  })
  test("a CLIENT is never prompted to approve node", () => {
    expect(mayPromptForFix({ ...tty, env: {} })).toBe(false)
  })
  test("never under --json", () => {
    expect(mayPromptForFix({ ...tty, json: true })).toBe(false)
  })
  test("never when stdout or stdin is not a TTY", () => {
    expect(mayPromptForFix({ ...tty, stdoutTTY: false })).toBe(false)
    expect(mayPromptForFix({ ...tty, stdinTTY: false })).toBe(false)
  })
  test("never in CI", () => {
    expect(mayPromptForFix({ ...tty, env: { IRIS_OPERATOR: "1", CI: "true" } })).toBe(false)
    expect(mayPromptForFix({ ...tty, env: { IRIS_OPERATOR: "1", CI: "false" } })).toBe(true)
  })
})
