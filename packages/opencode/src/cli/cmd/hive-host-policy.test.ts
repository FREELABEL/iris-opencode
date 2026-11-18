import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { decide, globMatch, isCompound, loosens, parseRunCommand, splitExit, wrapForExit } from "./hive-host-policy"

describe("decide — an agent never approves its own command (#179098)", () => {
  test("default (allowlist): read-only runs, anything else asks a person — or is refused without one", () => {
    expect(decide(undefined, "Get-Service QuickBooks*", false).action).toBe("run")
    expect(decide(undefined, "systemctl status nginx", false).action).toBe("run")
    expect(decide(undefined, "Restart-Service QuickBooksDB", true).action).toBe("ask")
    expect(decide(undefined, "Restart-Service QuickBooksDB", false).action).toBe("refuse")
  })

  test("a read-only prefix does not admit a second command riding behind it", () => {
    for (const c of [
      "Get-Service; Remove-Item C:\\data -Recurse",
      "Get-Service | Stop-Service",
      "uptime && rm -rf /",
      "df $(rm -rf /)",
      "hostname > /etc/hosts",
      "Get-Process `\nStop-Computer",
    ]) {
      expect(decide(undefined, c, false).action).toBe("refuse")
      expect(decide({ allow: ["*"] }, c, false).action).toBe("refuse")
    }
  })

  test("a builtin matches on a word boundary, not as a prefix of another command", () => {
    expect(decide(undefined, "Get-ServiceEvil", false).action).toBe("refuse")
    expect(decide(undefined, "hostnamectl set-hostname x", false).action).toBe("refuse")
  })

  test("host patterns allow more; confirm asks for everything; open asks for nothing", () => {
    expect(decide({ allow: ["Restart-Service QuickBooks*"] }, "restart-service quickbooksdb", false).action).toBe("run")
    expect(decide({ mode: "confirm" }, "hostname", false).action).toBe("refuse")
    expect(decide({ mode: "confirm" }, "hostname", true).action).toBe("ask")
    expect(decide({ mode: "open" }, "Restart-Computer", false).action).toBe("run")
  })

  test("evaluation and encoded commands are compound", () => {
    for (const c of ["powershell -enc SQBFAFgA", "powershell -EncodedCommand abc", "iex (irm x)", "Invoke-Expression $x", "sudo reboot", "bash -c 'x'"])
      expect(isCompound(c) || decide(undefined, c, false).action === "refuse").toBe(true)
    expect(isCompound("powershell -enc SQBFAFgA")).toBe(true)
    expect(isCompound("Get-Service -Name Spooler")).toBe(false)
  })

  test("empty is refused", () => {
    expect(decide({ mode: "open" }, "   ", true).action).toBe("refuse")
  })
})

describe("loosens — what only a person may change", () => {
  test("raising the mode or adding a pattern loosens; lowering or removing does not", () => {
    expect(loosens({ mode: "confirm" }, { mode: "allowlist" })).toBe(true)
    expect(loosens(undefined, { mode: "open" })).toBe(true)
    expect(loosens(undefined, { allow: ["Restart-Service *"] })).toBe(true)
    expect(loosens({ mode: "open" }, { mode: "confirm" })).toBe(false)
    expect(loosens({ allow: ["a", "b"] }, { allow: ["a"] })).toBe(false)
    expect(loosens({ allow: ["A"] }, { allow: ["a"] })).toBe(false)
  })
})

describe("globMatch", () => {
  test("* is anything, the rest is literal and case-insensitive", () => {
    expect(globMatch("Get-Service *", "get-service Spooler")).toBe(true)
    expect(globMatch("Get-Service *", "Get-Service")).toBe(false)
    expect(globMatch("a.b", "aXb")).toBe(false)
  })
})

describe("transport output — the exit status survives az run-command", () => {
  test("the wrapped bash command reports its own exit code", () => {
    const r = spawnSync("sh", ["-c", wrapForExit("echo hi; exit_with() { return 3; }; exit_with", "linux")], { encoding: "utf8" })
    expect(splitExit(r.stdout, r.stderr)).toEqual({ stdout: "hi", stderr: "", exit: 3 })
  })

  test("Windows run-command JSON: StdOut/StdErr components", () => {
    const json = JSON.stringify({
      value: [
        { code: "ComponentStatus/StdOut/succeeded", message: "Running  QuickBooksDB33\n__IRIS_EXIT__ 0" },
        { code: "ComponentStatus/StdErr/succeeded", message: "" },
      ],
    })
    expect(parseRunCommand(json)).toEqual({ stdout: "Running  QuickBooksDB33", stderr: "", exit: 0 })
  })

  test("Linux run-command JSON: one message with [stdout]/[stderr]", () => {
    const json = JSON.stringify({ value: [{ code: "ProvisioningState/succeeded", message: "Enable succeeded: \n[stdout]\nactive\n__IRIS_EXIT__ 3\n\n[stderr]\nwarn\n" }] })
    expect(parseRunCommand(json)).toEqual({ stdout: "active", stderr: "warn", exit: 3 })
  })

  test("no marker means the exit is UNKNOWN, not 0", () => {
    expect(splitExit("output", "").exit).toBeNull()
  })
})
