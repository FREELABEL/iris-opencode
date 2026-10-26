import { describe, expect, test } from "bun:test"
import { discover } from "./platform-hive-enroll"

describe("hive discover SSH identity", () => {
  test("uses an explicit remote user for a bare target", () => {
    const calls: string[] = []
    const result = discover("100.79.222.57", {
      user: "siralexmayo",
      exec: (target) => {
        calls.push(target)
        return { ok: false, stdout: "", stderr: "Permission denied (publickey)" }
      },
    })
    expect(result.ssh_user).toBe("siralexmayo")
    expect(calls).toEqual(["siralexmayo@100.79.222.57"])
    expect(result.reason).toContain("does not prove that no usable key exists")
  })

  test("preserves an explicit user@host target over the optional user", () => {
    const calls: string[] = []
    const result = discover("mayoalexander@100.79.222.57", {
      user: "wrong-user",
      exec: (target) => {
        calls.push(target)
        return { ok: true, stdout: "UNAME=Linux x86_64\n", stderr: "" }
      },
    })
    expect(result.ssh_user).toBe("mayoalexander")
    expect(calls).toEqual(["mayoalexander@100.79.222.57"])
  })
})
