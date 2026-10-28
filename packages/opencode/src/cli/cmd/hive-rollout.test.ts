import { describe, expect, test } from "bun:test"
import {
  cliMeets,
  isReady,
  MIN_ROLLOUT_CLI,
  offlineSince,
  orderRollout,
  parseProbe,
  planCounts,
  planRow,
  probeScript,
  requiredCliVersion,
  selectNodes,
  staleDuplicates,
  summarize,
  type FleetNode,
  type PlanRow,
} from "./hive-rollout"
import { rolloutTaskBody } from "./platform-hive-rollout"
import { buildHiveRunBody } from "./hive-run-body"

// #191614 — the pure parts of `iris hive rollout`. The whole flow against fake nodes is in
// hive-rollout.integration.test.ts.

const T = "f".repeat(40)
const O = "0".repeat(40)
const row = (name: string, status: PlanRow["status"], extra: Partial<PlanRow> = {}): PlanRow => ({
  id: `id-${name}`,
  name,
  os: "linux-x64",
  current: O,
  currentSource: "node",
  hubCommit: O,
  target: T,
  cli: "1.5.22",
  cliRequired: "1.5.22",
  cliOk: true,
  localMods: 0,
  kept: 0,
  deps: false,
  status,
  local: false,
  ...extra,
})
const node = (name: string, extra: Partial<FleetNode> = {}): FleetNode => ({ id: `id-${name}`, name, connection_status: "online", ...extra })

describe("CLI version gating", () => {
  test("every node needs at least the CLI running the rollout, never below the first with daemon update", () => {
    expect(requiredCliVersion("1.5.30")).toBe("1.5.30")
    expect(requiredCliVersion("1.5.9")).toBe(MIN_ROLLOUT_CLI)
    expect(requiredCliVersion("local")).toBe(MIN_ROLLOUT_CLI) // a dev build
  })
  test("compares numerically (1.5.9 < 1.5.21), and an unknown version or a missing command fails", () => {
    expect(cliMeets("1.5.9", "1.5.21", true)).toBe(false)
    expect(cliMeets("1.5.21", "1.5.21", true)).toBe(true)
    expect(cliMeets("1.6.0", "1.5.21", true)).toBe(true)
    expect(cliMeets("1.6.0", "1.5.21", false)).toBe(false)
    expect(cliMeets(null, "1.5.21", true)).toBe(false)
    expect(cliMeets("local", "1.5.21", true)).toBe(false)
  })
})

describe("ordering", () => {
  const rows = [row("a", "ready"), row("b", "up-to-date"), row("me", "ready", { local: true }), row("c", "ready-cli"), row("d", "offline")]
  test("the canary is this machine when it is a ready node; the rest follow in list order; only ready rows run", () => {
    const o = orderRollout(rows)
    expect(o.canary?.name).toBe("me")
    expect(o.rest.map((r) => r.name)).toEqual(["a", "c"])
  })
  test("otherwise the first ready node", () => {
    const o = orderRollout(rows.filter((r) => !r.local))
    expect(o.canary?.name).toBe("a")
  })
  test("--canary picks it, and refuses one that is not ready or does not exist", () => {
    expect(orderRollout(rows, "c").canary?.name).toBe("c")
    expect(orderRollout(rows, "b").error).toContain("not ready")
    expect(orderRollout(rows, "zzz").error).toContain("no such node")
  })
  test("a local node that is not ready is not the canary", () => {
    const o = orderRollout([row("me", "needs-force", { local: true }), row("a", "ready")])
    expect(o.canary?.name).toBe("a")
    expect(isReady(row("x", "needs-force"))).toBe(false)
  })
})

describe("selecting nodes", () => {
  const all = [node("office-mac", { id: "01a0aaaa" }), node("office-mac", { id: "01a0bbbb", connection_status: "offline" }), node("build")]
  test("by name (the online record wins a tie), by id, by prefix; unknown names are reported", () => {
    expect(selectNodes(all, ["office-mac"]).nodes.map((n) => n.id)).toEqual(["01a0aaaa"])
    expect(selectNodes(all, ["01a0bbbb"]).nodes.map((n) => n.id)).toEqual(["01a0bbbb"])
    expect(selectNodes(all, ["bui"]).nodes.map((n) => n.name)).toEqual(["build"])
    expect(selectNodes(all, ["nope", "build"]).unknown).toEqual(["nope"])
    expect(selectNodes(all, undefined).nodes.length).toBe(3)
  })
  test("an offline record sharing a name with an online one is a stale duplicate", () => {
    expect([...staleDuplicates(all)]).toEqual(["01a0bbbb"])
  })
})

describe("plan rows", () => {
  const base = { target: T, cliRequired: "1.5.22", local: false, nowMs: Date.parse("2026-10-28T12:00:00Z") }
  test("offline is pending with when it was last seen — never a failure", () => {
    const r = planRow(node("m", { connection_status: "offline", last_heartbeat_at: "2026-10-27T12:00:00Z" }), base)
    expect(r.status).toBe("offline")
    expect(r.detail).toBe("offline since 2026-10-27 12:00 UTC (1d ago)")
    expect(offlineSince(null, 0)).toContain("never")
  })
  test("no answer from an online node = unreachable (pending); a dispatch error says so", () => {
    expect(planRow(node("m"), { ...base, probe: { finished: false, exit_code: null, stdout: "", stderr: "" } }).status).toBe("unreachable")
    expect(planRow(node("m"), { ...base, probe: { finished: false, exit_code: null, stdout: "", stderr: "", error: "HTTP 503" } }).detail).toContain("HTTP 503")
  })
  test("Windows nodes are skipped as unsupported", () => {
    expect(planRow(node("w", { hardware_profile: { os: { label: "win32-x64", platform: "win32" } } }), base).status).toBe("unsupported")
  })
  test("a node with no iris CLI is an error with the fix", () => {
    expect(planRow(node("m"), { ...base, probe: { finished: true, exit_code: 3, stdout: "@@no_iris=1\n", stderr: "" } }).detail).toContain("no iris CLI")
  })
})

describe("what the node said", () => {
  test("parseProbe reads tags and the plan between markers, ignoring noise", () => {
    const p = parseProbe(`@@cli=1.5.22\n@@health_ok=1\n@@health_commit=${T}\n@@has_update=1\n@@dry_rc=0\n@@plan_begin\nnoise {"status":"dry-run","plan":{"current":{}}}\n@@plan_end\n`)
    expect(p).toMatchObject({ cli: "1.5.22", hasUpdate: true, healthOk: true, healthCommit: T, dryRc: 0 })
    expect(p.plan.status).toBe("dry-run")
    expect(parseProbe("@@health_commit=unknown\n").healthCommit).toBeNull()
  })
  test("planCounts: compacted counts win; an old CLI's untracked files count as changes", () => {
    expect(planCounts({ plan: { current: { modified: ["a"], missing: [], untracked: ["u"] }, keptYours: ["u"], untrackedConflicts: [] } })).toEqual({ localMods: 1, kept: 1, keptKnown: true })
    expect(planCounts({ plan: { current: { modified: [], missing: [], untracked: ["u"] } } })).toEqual({ localMods: 1, kept: 0, keptKnown: false })
    expect(planCounts({ plan: { current: { modified: ["a"] }, keptYours: [], _counts: { modified: 300, missing: 0, untrackedConflicts: 2, keptYours: 4 } } })).toEqual({ localMods: 302, kept: 4, keptKnown: true })
  })
  test("probeScript only ever dry-runs, and refuses a ref that is not a commit", () => {
    const s = probeScript(T)
    expect(s).toContain(`daemon update --ref ${T} --dry-run --json`)
    expect(s).not.toContain("--detach-restart --restart-delay")
    expect(s).not.toMatch(/"\$IRIS" update/)
    expect(() => probeScript("main")).toThrow()
  })
})

describe("summary", () => {
  test("the command to finish names pending + failed + not-attempted nodes, and --force ones separately; ambiguous names use the id", () => {
    const plan = [row("a", "ready"), row("dup", "offline", { id: "id-dup-1" }), row("dup", "ready", { id: "id-dup-2" }), row("e", "needs-force")]
    const s = summarize(T, plan, [
      { id: "id-a", name: "a", status: "failed" },
      { id: "id-dup-1", name: "dup", status: "offline" },
      { id: "id-dup-2", name: "dup", status: "updated" },
      { id: "id-e", name: "e", status: "skipped-local-mods" },
    ])
    expect(s.next[0]).toBe(`iris hive rollout --ref ${T} --nodes a,id-dup-1`)
    expect(s.next[1]).toContain(`--nodes e --force`)
    expect(s.summary.updated).toEqual(["dup"])
  })
})

describe("dispatch", () => {
  test("every rollout task is sent with force (a busy node must not refuse the owner's maintenance)", () => {
    expect(rolloutTaskBody(buildHiveRunBody, 1, "n1", "t", "#!/bin/bash", 60).force).toBe(true)
  })
})
