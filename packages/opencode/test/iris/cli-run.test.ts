import { describe, expect, test } from "bun:test"
import { classifyIrisArgv, cleanOutput, refuseIrisArgv, runIrisArgv, subcommandPath } from "../../src/iris/cli-run"

type Call = { file: string; args: string[] }
const stub = (out = { code: 0, stdout: "ok\n", stderr: "" }) => {
  const calls: Call[] = []
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args })
    return { ...out, truncated: false, timedOut: false }
  }
  return { calls, exec }
}

describe("classifyIrisArgv (#194581)", () => {
  test("clear reads", () => {
    for (const line of [
      ["leads", "list"],
      ["leads", "get", "32345"],
      ["bloqs", "show", "952", "--json"],
      ["hive", "sessions"],
      ["drives", "list", "--json"],
      ["iris", "pages", "search", "pricing"],
      ["integrations", "status"],
      ["whoami"],
      ["status"],
      ["version"],
    ])
      expect(classifyIrisArgv(line)).toBe("read")
  })

  test("writes, and anything not clearly a read", () => {
    for (const line of [
      ["drives", "scan", "/Volumes/Footage"],
      ["hive", "connect"],
      ["auth", "login"],
      ["leads", "update", "1", "--status", "Won"],
      ["bloqs", "create-list", "952", "Call today"],
      ["pages", "publish", "home"],
      ["leads"], // a bare noun: not clearly a read
      ["playbook", "run", "this-week"],
      ["leads", "search", "update"], // a write word anywhere in the path: ask first
      // A read-looking noun with a verb that changes something after it: the verb position decides.
      ["status", "raise", "Checkout is down"],
      ["hive", "tasks", "dispatch", "42"],
      ...["resolve", "toggle", "rerun", "retry", "promote", "enrich", "score", "remind", "recover", "verify", "claim", "submit", "generate", "flush", "prune", "dispatch"].flatMap((v) =>
        ["status", "tasks", "sessions", "peers", "machines", "nodes", "logs", "history"].map((noun) => ["hive", noun, v]),
      ),
      ["status", "raise"],
      ["leads", "list", "purge"],
    ])
      expect(classifyIrisArgv(line)).toBe("write")
  })

  test("--help only reads, even on a write command", () => {
    expect(classifyIrisArgv(["drives", "scan", "--help"])).toBe("read")
    expect(classifyIrisArgv(["hive", "connect", "-h"])).toBe("read")
  })

  test("the subcommand path stops at a flag or a value", () => {
    expect(subcommandPath(["leads", "get", "32345", "list"])).toEqual(["leads", "get"])
    expect(subcommandPath(["drives", "scan", "/Volumes/X"])).toEqual(["drives", "scan"])
    expect(subcommandPath(["bloqs", "--json", "list"])).toEqual(["bloqs"])
  })
})

describe("refuseIrisArgv", () => {
  test("empty, non-text, NUL, oversized", () => {
    expect(refuseIrisArgv([])).toBeTruthy()
    expect(refuseIrisArgv(["iris"])).toBeTruthy()
    expect(refuseIrisArgv(["leads", 5 as any])).toBeTruthy()
    expect(refuseIrisArgv(["leads", "a\0b"])).toBeTruthy()
    expect(refuseIrisArgv(["x".repeat(5000)])).toBeTruthy()
    expect(refuseIrisArgv(Array(65).fill("list"))).toBeTruthy()
  })

  test("servers, UIs and the CLI replacing itself are never run from a button", () => {
    for (const top of ["serve", "web", "tui", "upgrade", "uninstall"]) expect(refuseIrisArgv([top])).toContain(top)
    expect(refuseIrisArgv(["leads", "list"])).toBeUndefined()
  })
})

describe("runIrisArgv", () => {
  test("a read runs at once, as argv, on the CLI only", async () => {
    const s = stub()
    const r = await runIrisArgv({ argv: ["iris", "leads", "list", "--json"] }, { cli: "/home/x/.iris/bin/iris", exec: s.exec })
    expect(r).toMatchObject({ ran: true, kind: "read", code: 0, stdout: "ok\n" })
    expect(s.calls).toEqual([{ file: "/home/x/.iris/bin/iris", args: ["leads", "list", "--json"] }])
  })

  test("an unconfirmed write does not run", async () => {
    const s = stub()
    const r = await runIrisArgv({ argv: ["hive", "connect"] }, { cli: "/bin/iris", exec: s.exec })
    expect(r).toEqual({ ran: false, kind: "write", needsConfirm: true })
    expect(s.calls).toHaveLength(0)
    const r2 = await runIrisArgv({ argv: ["hive", "connect"], confirmed: "yes" as any }, { cli: "/bin/iris", exec: s.exec })
    expect(r2.ran).toBe(false)
    expect(s.calls).toHaveLength(0)
  })

  test("a write that only LOOKS like a read does not run unconfirmed", async () => {
    const s = stub()
    for (const argv of [["status", "raise", "Checkout is down"], ["hive", "tasks", "dispatch", "42"]]) {
      const r = await runIrisArgv({ argv }, { cli: "/bin/iris", exec: s.exec })
      expect(r).toEqual({ ran: false, kind: "write", needsConfirm: true })
    }
    expect(s.calls).toHaveLength(0)
  })

  test("a confirmed write runs", async () => {
    const s = stub()
    const r = await runIrisArgv({ argv: ["drives", "scan", "/Volumes/A B"], confirmed: true }, { cli: "/bin/iris", exec: s.exec })
    expect(r).toMatchObject({ ran: true, kind: "write" })
    expect(s.calls[0]!.args).toEqual(["drives", "scan", "/Volumes/A B"])
  })

  test("shell characters stay inside one argument", async () => {
    const s = stub()
    await runIrisArgv({ argv: ["leads", "search", "x; rm -rf ~ && $(id)"] }, { cli: "/bin/iris", exec: s.exec })
    expect(s.calls[0]!.args).toEqual(["leads", "search", "x; rm -rf ~ && $(id)"])
  })

  test("a refused command does not run, even confirmed", async () => {
    const s = stub()
    const r = await runIrisArgv({ argv: ["serve", "--port", "1"], confirmed: true }, { cli: "/bin/iris", exec: s.exec })
    expect(r.ran).toBe(false)
    expect(r.refused).toBeTruthy()
    expect(s.calls).toHaveLength(0)
  })

  test("no CLI installed is said, not an empty success", async () => {
    const r = await runIrisArgv({ argv: ["leads", "list"] }, { cli: null })
    expect(r.ran).toBe(false)
    expect(r.refused).toContain("not installed")
  })

  test("a failure keeps its exit code and stderr, without colour codes", async () => {
    const s = stub({ code: 2, stdout: "", stderr: "\u001b[31mNot signed in\u001b[0m\r\n" })
    const r = await runIrisArgv({ argv: ["leads", "list"] }, { cli: "/bin/iris", exec: s.exec })
    expect(r).toMatchObject({ ran: true, code: 2, stderr: "Not signed in\n" })
    expect(cleanOutput("\u001b[1mbold\u001b[22m")).toBe("bold")
  })
})
