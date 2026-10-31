import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * The real CLI, with a fake `az` on PATH that records every call. Nothing here is a TTY, which is
 * exactly an agent's situation: these prove what an agent can and cannot get run (#179098).
 */
const ENTRY = join(import.meta.dir, "..", "..", "index.ts")
const BOOT = 60_000
let root = ""
let env: Record<string, string> = {}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "host-run-test-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "az"),
    `#!/bin/sh
echo "$@" >> "${join(root, "az.log")}"
case "$*" in
  *"vm show"*) echo Windows;;
  *"run-command invoke"*) printf '{"value":[{"code":"ComponentStatus/StdOut/succeeded","message":"Running  QuickBooksDB33\\\\n__IRIS_EXIT__ 4"},{"code":"ComponentStatus/StdErr/succeeded","message":""}]}';;
  *) exit 0;;
esac
`,
  )
  chmodSync(join(bin, "az"), 0o755)
  env = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    NO_COLOR: "1",
    IRIS_HIVE_HOST_CONFIG: join(root, "hive-host.json"),
    IRIS_HIVE_HOST_AUDIT: join(root, "audit.jsonl"),
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function iris(args: string[]) {
  const r = spawnSync(process.execPath, ["run", ENTRY, "hive", "host", ...args], { encoding: "utf8", timeout: 60_000, env, input: "" })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const azCalls = () => (existsSync(join(root, "az.log")) ? readFileSync(join(root, "az.log"), "utf8").trim().split("\n").filter(Boolean) : [])
const auditLines = () => readFileSync(join(root, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const config = () => JSON.parse(readFileSync(join(root, "hive-host.json"), "utf8"))

describe("hive host run — the policy decides before anything connects", () => {
  test("a command off the allowlist is refused without a terminal, logged, and never reaches the host", () => {
    const r = iris(["run", "qb-host", "-g", "rg-qb", "Restart-Service QuickBooksDB33"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("no one is at a terminal")
    expect(r.out).toContain("iris hive host policy allow qb-host")
    expect(azCalls()).toEqual([])
    expect(auditLines().at(-1)).toMatchObject({ host: "qb-host", decision: "refused", command: "Restart-Service QuickBooksDB33" })
  }, BOOT)

  test("a read-only command runs, prints the output, passes the remote exit code through, and remembers the host", () => {
    const r = iris(["run", "qb-host", "-g", "rg-qb", "Get-Service QuickBooks*"])
    expect(r.out).toContain("Running  QuickBooksDB33")
    expect(r.code).toBe(4)
    const calls = azCalls()
    expect(calls.some((c) => c.includes("vm show") && c.includes("rg-qb"))).toBe(true)
    expect(calls.some((c) => c.includes("RunPowerShellScript") && c.includes("Get-Service QuickBooks*"))).toBe(true)
    expect(config().hosts["qb-host"]).toMatchObject({ via: "az", resource_group: "rg-qb", os: "windows" })
    expect(auditLines().at(-1)).toMatchObject({ decision: "allowed", exit: 4 })
  }, BOOT)

  test("the remembered resource group is reused — no -g the second time", () => {
    const before = azCalls().length
    iris(["run", "qb-host", "hostname"])
    expect(azCalls().length).toBeGreaterThan(before)
  }, BOOT)
})

describe("hive host policy — only a person may loosen it", () => {
  test("allow and set-to-open are refused without a terminal and change nothing", () => {
    const before = JSON.stringify(config())
    expect(iris(["policy", "allow", "qb-host", "Restart-Service *"]).code).toBe(2)
    expect(iris(["policy", "set", "qb-host", "--mode", "open"]).code).toBe(2)
    expect(JSON.stringify(config())).toBe(before)
  }, BOOT)

  test("tightening works from anywhere, and a confirm host refuses even read-only commands", () => {
    expect(iris(["policy", "set", "qb-host", "--mode", "confirm"]).code).toBe(0)
    const before = azCalls().length
    const r = iris(["run", "qb-host", "hostname"])
    expect(r.code).toBe(2)
    expect(azCalls().length).toBe(before)
  }, BOOT)
})
