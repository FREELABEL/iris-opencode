import { describe, expect, test } from "bun:test"
import { pickUsername, isIpTarget, sshArgs } from "./hive-ssh"

/**
 * `iris hive ssh <node>` (2026-10-03). The first node it was built for, iris-hive-001, logs in
 * as siralexmayo while the Mac dialling it is mayoalexander — so every guess the resolver had
 * failed, and the only party that knew the answer was the node's own daemon.
 */
describe("pickUsername", () => {
  test("a clean answer — what a Linux node returned, measured 2026-10-03", () => {
    expect(pickUsername("siralexmayo")).toBe("siralexmayo")
    expect(pickUsername("siralexmayo\n")).toBe("siralexmayo")
  })

  test("survives the PTY stream a macOS node returns (#182004)", () => {
    const pty = "\x1b[?2004h$ bash /tmp/iris-task.sh\r\n\x1b[?2004l\rmayoalexander\r\n$ exit\r\n"
    expect(pickUsername(pty)).toBe("mayoalexander")
  })

  test("never returns the transport's own words as a user", () => {
    expect(pickUsername("bash\nexit\n")).toBeNull()
  })

  test("nothing usable is null, not a guess", () => {
    expect(pickUsername("")).toBeNull()
    expect(pickUsername("id: cannot find name for user ID 1001")).toBeNull()
  })
})

describe("isIpTarget", () => {
  test("an IP keeps the old meaning: test access", () => {
    expect(isIpTarget("192.168.4.24")).toBe(true)
    expect(isIpTarget(" 100.79.222.57 ")).toBe(true)
  })
  test("a node name — including one with digits — is a node", () => {
    expect(isIpTarget("iris-hive-001")).toBe(false)
    expect(isIpTarget("AlexMaysnow1063")).toBe(false)
    expect(isIpTarget("01a10379")).toBe(false)
  })
})

describe("sshArgs", () => {
  test("interactive: no command, so ssh allocates a terminal itself", () => {
    expect(sshArgs("u@100.79.222.57")).toEqual(["-o", "StrictHostKeyChecking=accept-new", "u@100.79.222.57"])
  })
  test("one command is passed as ONE argument, not split", () => {
    const a = sshArgs("u@h", "df -h /")
    expect(a[a.length - 1]).toBe("df -h /")
    expect(a.length).toBe(4)
  })
  test("never disables host-key checking — a changed key must still be refused", () => {
    expect(sshArgs("u@h").join(" ")).not.toContain("StrictHostKeyChecking=no")
  })
})
