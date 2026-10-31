import { describe, expect, test } from "bun:test"
import { discover } from "./platform-hive-enroll"

const DENIED = { ok: false, stdout: "", stderr: "Permission denied (publickey)." }
const OK = (who: string) => ({ ok: true, stdout: `WHOAMI=${who}\nUNAME=Linux x86_64\n`, stderr: "" })
const keyPresent = () => ({ defaultUser: "localme", keyFound: true })

describe("hive discover SSH identity (#187954)", () => {
  test("an explicit --user is the only user tried, and failure does not blame the key", () => {
    const calls: string[] = []
    const result = discover("100.79.222.57", {
      user: "siralexmayo",
      rememberedUser: "someone-else",
      sshContext: keyPresent,
      exec: (target) => (calls.push(target), DENIED),
    })
    expect(calls).toEqual(["siralexmayo@100.79.222.57"])
    expect(result.ssh_users_tried).toEqual(["siralexmayo"])
    expect(result.reason).toContain("refused SSH for every user tried: siralexmayo")
    expect(result.reason).not.toContain("No SSH key")
  })

  test("user@host wins over --user", () => {
    const calls: string[] = []
    const result = discover("mayoalexander@100.79.222.57", {
      user: "wrong-user",
      sshContext: keyPresent,
      exec: (target) => (calls.push(target), OK("mayoalexander")),
    })
    expect(calls).toEqual(["mayoalexander@100.79.222.57"])
    expect(result.ssh_user).toBe("mayoalexander")
  })

  test("a bare address tries the remembered user before the ssh default", () => {
    const calls: string[] = []
    const result = discover("100.79.222.57", {
      rememberedUser: "siralexmayo",
      sshContext: keyPresent,
      exec: (target) => (calls.push(target), target.startsWith("siralexmayo@") ? OK("siralexmayo") : DENIED),
    })
    expect(calls).toEqual(["siralexmayo@100.79.222.57"])
    expect(result.reachable).toBe(true)
    expect(result.ssh_user).toBe("siralexmayo")
  })

  test("a bare address with no memory reports the user the node says it logged in as", () => {
    const result = discover("100.79.222.57", { sshContext: keyPresent, exec: () => OK("siralexmayo") })
    expect(result.ssh_user).toBe("siralexmayo")
  })

  test("when every user is refused, all are named — the reported repro", () => {
    const calls: string[] = []
    const result = discover("100.79.222.57", {
      rememberedUser: "siralexmayo",
      sshContext: keyPresent,
      exec: (target) => (calls.push(target), DENIED),
    })
    expect(calls).toEqual(["siralexmayo@100.79.222.57", "100.79.222.57"])
    expect(result.auth_failed).toBe(true)
    expect(result.reason).toContain("siralexmayo, localme (ssh default)")
  })

  test("an unreachable host stops after one attempt and is not reported as an auth problem", () => {
    const calls: string[] = []
    const result = discover("100.79.222.57", {
      rememberedUser: "siralexmayo",
      sshContext: keyPresent,
      exec: (target) => (calls.push(target), { ok: false, stdout: "", stderr: "ssh: connect to host 100.79.222.57 port 22: Connection timed out" }),
    })
    expect(calls).toHaveLength(1)
    expect(result.auth_failed).toBe(false)
    expect(result.reason).toContain("network problem")
  })

  test("no key on this machine is named as the cause", () => {
    const result = discover("100.79.222.57", {
      sshContext: () => ({ defaultUser: "localme", keyFound: false }),
      exec: () => DENIED,
    })
    expect(result.reason).toContain("No SSH key was found on this machine")
  })
})
