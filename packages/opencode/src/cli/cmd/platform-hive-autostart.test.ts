import { describe, expect, test } from "bun:test"
import { autostartDecision, schtasksCreateArgs, schtasksQueryArgs, AUTOSTART_TASK } from "./platform-hive-autostart"

/**
 * Windows autostart for a node enrolled by `iris hive connect` (#186663).
 *
 * The installer registers a logon task, but only inside the branch that installs the daemon —
 * which it skips when Node.js is absent. So the common order (install CLI → discover Node is
 * missing → install Node → `iris hive connect`) produced a working node with no autostart, and
 * it stopped being a node at the next reboot with nothing said. Autostart has to follow the
 * thing that makes a machine a node, not the installer branch that happened to run.
 */
describe("autostartDecision — who registers, and who is told why not", () => {
  test("registers on Windows once the daemon launcher exists", () => {
    const d = autostartDecision({ platform: "win32", daemonCmd: "C:\\Users\\x\\.iris\\bin\\iris-daemon.cmd" })
    expect(d.action).toBe("register")
  })

  // macOS and Linux keep their own mechanism (launchd / the installer's own path). Claiming a
  // Windows task on them would be a no-op reported as success.
  test("skips off Windows, and says that is why", () => {
    for (const p of ["darwin", "linux"]) {
      const d = autostartDecision({ platform: p, daemonCmd: "/Users/x/.iris/bin/iris-daemon" })
      expect(d.action).toBe("skip")
      expect(d.reason).toMatch(/windows/i)
    }
  })

  /**
   * The case that produced the bug. There is genuinely nothing to register — but this must be a
   * REPORTED skip, not a silent one: a machine that will not come back after a reboot must never
   * be reported as one that will (#184597).
   */
  test("skips with a reason when there is no daemon launcher to start", () => {
    const d = autostartDecision({ platform: "win32", daemonCmd: null })
    expect(d.action).toBe("skip")
    expect(d.reason).toMatch(/daemon/i)
    expect(d.reason).toMatch(/not installed|nothing to start/i)
  })
})

describe("schtasks arguments — what actually reaches Windows", () => {
  const CMD = "C:\\Users\\eboba\\.iris\\bin\\iris-daemon.cmd"

  test("creates an at-logon task that starts the daemon", () => {
    const a = schtasksCreateArgs(CMD)
    expect(a[0]).toBe("/Create")
    expect(a).toContain("/TN")
    expect(a[a.indexOf("/TN") + 1]).toBe(AUTOSTART_TASK)
    expect(a).toContain("/SC")
    expect(a[a.indexOf("/SC") + 1]).toBe("ONLOGON")
    // Re-running `hive connect` must replace the task, never stack duplicates.
    expect(a).toContain("/F")
  })

  /**
   * The path contains spaces on most real machines ("C:\Users\First Last\..."), and schtasks
   * splits /TR on them unless the program is quoted INSIDE the value. Unquoted, the task
   * registers happily and then fails at every logon — a success that is not one.
   */
  test("quotes the daemon path inside /TR, with its argument outside the quotes", () => {
    const a = schtasksCreateArgs("C:\\Users\\First Last\\.iris\\bin\\iris-daemon.cmd")
    const tr = a[a.indexOf("/TR") + 1]
    expect(tr).toBe('"C:\\Users\\First Last\\.iris\\bin\\iris-daemon.cmd" start')
  })

  test("runs at the user's own level — no elevation prompt at logon", () => {
    const a = schtasksCreateArgs(CMD)
    expect(a[a.indexOf("/RL") + 1]).toBe("LIMITED")
  })

  test("query asks for the same task name the create writes", () => {
    expect(schtasksQueryArgs()).toEqual(["/Query", "/TN", AUTOSTART_TASK])
  })

  // The installer registers "IRIS Hive Node". A second name would leave two tasks racing to
  // start the same daemon after every logon.
  test("uses the name the installer already registers", () => {
    expect(AUTOSTART_TASK).toBe("IRIS Hive Node")
  })
})
