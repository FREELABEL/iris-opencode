import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { formatPlanTable, formatReport, runRollout } from "./hive-rollout"
import { dryPlan, fakeFleet, OLD, TARGET, type FakeFleet, type FakeSpec } from "./hive-rollout.fake-fleet"

// #191614 — `iris hive rollout` end to end against FAKE nodes: the generated scripts run under
// bash against a fake HOME per node (fake `iris`, fake /health via curl, real last.json), the Hive
// dispatch is a function, the hub list is computed from the fakes. No network, no real node.

let fleet: FakeFleet | null = null
afterEach(() => fleet?.cleanup())
const mk = (specs: FakeSpec[], o?: Parameters<typeof fakeFleet>[1]) => (fleet = fakeFleet(specs, o))
const statusOf = (r: Awaited<ReturnType<typeof runRollout>>, name: string) => r.results.find((x) => x.name === name)?.status
const rowOf = (r: Awaited<ReturnType<typeof runRollout>>, name: string) => r.plan.find((x) => x.name === name)!

/** The fleet from the 2026-10-28 hand rollout, generalised: every case it hit. */
function mixedFleet(): FakeSpec[] {
  return [
    { name: "office-mac", plan: dryPlan({ kept: ["som/save-instagram-session.spec.ts"] }), kept: ["som/save-instagram-session.spec.ts"] },
    { name: "build-box", os: "linux-x64", cli: "1.5.10", hasUpdate: false, cliAfter: "1.5.22", hasUpdateAfter: true, planAfterCli: dryPlan({ deps: true }) },
    { name: "studio", health: TARGET, plan: dryPlan({ from: TARGET, upToDate: true }) },
    { name: "edited", plan: dryPlan({ modified: ["lib/a.js"] }) },
    { name: "travel-mac", online: false, lastHeartbeat: "2026-10-20T14:03:00Z" },
    { name: "office-mac", id: "stale-office", online: false, lastHeartbeat: "2026-09-13T23:48:37Z" },
    { name: "front-desk", os: "win32-x64" },
  ]
}

describe("iris hive rollout — against fake nodes", () => {
  test("--dry-run: one table, every status, and NOTHING changes on any node", async () => {
    const f = mk(mixedFleet(), { localName: "office-mac" })
    const r = await runRollout(f.deps, { ref: "main", dryRun: true })
    const table = formatPlanTable({ rows: r.plan, target: r.target, canary: r.plan.find((x) => x.id === r.canary) })
    console.log(["", `  target: ${r.target}  (main)`, ...table].join("\n"))
    expect(rowOf(r, "build-box").status).toBe("ready-cli")
    expect(r.plan.find((x) => x.id === "node-0-office-mac")!.status).toBe("ready")
    expect(r.plan.find((x) => x.id === "node-0-office-mac")!.kept).toBe(1)
    expect(rowOf(r, "studio").status).toBe("up-to-date")
    expect(rowOf(r, "edited").status).toBe("needs-force")
    expect(rowOf(r, "edited").localMods).toBe(1)
    expect(rowOf(r, "travel-mac").status).toBe("offline")
    expect(rowOf(r, "travel-mac").detail).toContain("offline since 2026-10-20 14:03 UTC")
    expect(r.plan.find((x) => x.id === "stale-office")!.status).toBe("duplicate")
    expect(rowOf(r, "front-desk").status).toBe("unsupported")
    expect(r.canary).toBe("node-0-office-mac") // the machine running the command
    // nothing but read-only calls reached any node
    for (const n of ["office-mac", "build-box", "studio", "edited"]) {
      for (const c of f.calls(n)) expect(c).toMatch(/^(--version|daemon update --help|daemon update --ref [0-9a-f]{40} --dry-run --json)$/)
    }
    expect(f.dispatched.some((d) => /--detach-restart --restart-delay|iris" update/.test(d.script))).toBe(false)
    expect(existsSync(join(f.home("office-mac"), ".iris/daemon-update/last.json"))).toBe(false)
    expect(table.join("\n")).toContain("office-mac (you) [canary]")
  }, 60000)

  test("execute: canary first, then one at a time; the old CLI is updated first; files you added are kept; offline is pending", async () => {
    const f = mk(mixedFleet(), { localName: "office-mac" })
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(r.ok).toBe(true)
    expect(statusOf(r, "build-box")).toBe("updated")
    expect(r.results.find((x) => x.id === "node-0-office-mac")!.status).toBe("updated")
    expect(r.results.find((x) => x.id === "node-0-office-mac")!.kept).toEqual(["som/save-instagram-session.spec.ts"])
    expect(r.results.find((x) => x.name === "build-box")!.cliUpdated).toEqual({ from: "1.5.10", to: "1.5.22" })
    expect(statusOf(r, "studio")).toBe("current")
    expect(statusOf(r, "edited")).toBe("skipped-local-mods")
    expect(statusOf(r, "travel-mac")).toBe("offline")
    // order: the canary's update was dispatched before anyone else's
    const updates = f.dispatched.filter((d) => d.script.includes("--detach-restart --restart-delay")).map((d) => d.node)
    expect(updates).toEqual(["office-mac", "build-box"])
    // every node reports the target on its own /health
    expect(readFileSync(join(f.home("build-box"), "fake/health"), "utf8").trim()).toBe(TARGET)
    // `iris update` ran BEFORE build-box's daemon update
    const calls = f.calls("build-box")
    expect(calls.indexOf("update")).toBeGreaterThan(-1)
    expect(calls.indexOf("update")).toBeLessThan(calls.findIndex((c) => c.includes("--detach-restart")))
    // the edited node was never touched
    expect(f.calls("edited").some((c) => c.includes("--detach-restart"))).toBe(false)
    // the summary says how to finish
    expect(r.next[0]).toBe(`iris hive rollout --ref ${TARGET} --nodes travel-mac`)
    expect(r.next[1]).toContain("--nodes edited --force")
    const text = formatReport(r).join("\n")
    expect(text).toContain("kept 1 file(s) you added: som/save-instagram-session.spec.ts")
    expect(text).toContain("CLI 1.5.10 → 1.5.22")
  }, 60000)

  test("stops at the first failure: a rollback on node 2 leaves node 3 untouched", async () => {
    const f = mk([{ name: "a" }, { name: "b", behavior: "rolled-back" }, { name: "c" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(r.ok).toBe(false)
    expect(statusOf(r, "a")).toBe("updated")
    expect(statusOf(r, "b")).toBe("failed")
    expect(r.results.find((x) => x.name === "b")!.detail).toContain("rolled-back")
    expect(statusOf(r, "c")).toBe("not-attempted")
    expect(f.calls("c").some((c) => c.includes("--detach-restart"))).toBe(false)
    expect(r.stoppedAt).toBe("b")
    expect(r.next[0]).toBe(`iris hive rollout --ref ${TARGET} --nodes b,c`)
  }, 60000)

  test("--keep-going continues past a failure", async () => {
    const f = mk([{ name: "a" }, { name: "b", behavior: "rolled-back" }, { name: "c" }])
    const r = await runRollout(f.deps, { ref: "main", keepGoing: true, pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "b")).toBe("failed")
    expect(statusOf(r, "c")).toBe("updated")
  }, 60000)

  test("a failed canary stops everything, even with --keep-going", async () => {
    const f = mk([{ name: "a" }, { name: "b", behavior: "rolled-back" }, { name: "c" }])
    const r = await runRollout(f.deps, { ref: "main", canary: "b", keepGoing: true, pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "b")).toBe("failed")
    expect(statusOf(r, "a")).toBe("not-attempted")
    expect(statusOf(r, "c")).toBe("not-attempted")
  }, 60000)

  test("a helper that dies is a failure, not a pending success", async () => {
    const f = mk([{ name: "a", behavior: "helper-dies" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.5, waitSec: 20 })
    expect(statusOf(r, "a")).toBe("failed")
    expect(r.results[0].detail).toContain("HELPER DIED")
    expect(statusOf(r, "b")).toBe("not-attempted")
  }, 60000)

  test("#191641: verified by asking the node — a lagging hub list does not fail (or fake) the result", async () => {
    const f = mk([{ name: "mac", hubLags: true }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "mac")).toBe("updated")
    expect(r.results[0].hubSays).toBe(OLD)
    expect(formatReport(r).join("\n")).toContain("the hub's list still says ccd10f8")
  }, 60000)

  test("the plan reads the node's own /health, not the hub, for the current commit", async () => {
    const f = mk([{ name: "mac", health: TARGET, hubLags: true, plan: dryPlan({ from: TARGET, upToDate: true }) }])
    const r = await runRollout(f.deps, { ref: "main", dryRun: true })
    expect(r.plan[0].current).toBe(TARGET)
    expect(r.plan[0].currentSource).toBe("node")
    expect(r.plan[0].status).toBe("up-to-date")
    expect(formatPlanTable({ rows: r.plan, target: r.target }).join("\n")).toContain("(hub: ccd10f8)")
  }, 60000)

  test("a node that drops off the network mid-update is pending, not a failure, and the rollout continues", async () => {
    const f = mk([{ name: "a" }, { name: "bisnow", dropsDuringUpdate: true }, { name: "c" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "bisnow")).toBe("offline")
    expect(statusOf(r, "c")).toBe("updated")
    expect(r.ok).toBe(true)
    expect(r.next[0]).toBe(`iris hive rollout --ref ${TARGET} --nodes bisnow`)
  }, 60000)

  test("the update task's output cut off before 'restart-scheduled' is NOT a failure — the node is asked, and it says updated (AlexMaysnow1063, 2026-10-28)", async () => {
    const f = mk([{ name: "bisnow", truncateUpdateStdout: true }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "bisnow")).toBe("updated")
    expect(statusOf(r, "b")).toBe("updated")
  }, 60000)

  test("output cut off AND the update really did not happen is still a failure (verification decides, it does not assume)", async () => {
    const f = mk([{ name: "bisnow", truncateUpdateStdout: true, behavior: "helper-dies" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 3 })
    expect(statusOf(r, "bisnow")).toBe("failed")
    expect(statusOf(r, "b")).toBe("not-attempted")
  }, 60000)

  test("the hub refusing to dispatch the update (node just went offline) is pending, not a failure", async () => {
    const f = mk([{ name: "a" }, { name: "gone", dispatchFailsDuringUpdate: true }, { name: "c" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "gone")).toBe("offline")
    expect(r.results.find((x) => x.name === "gone")!.detail).toContain("could not dispatch")
    expect(statusOf(r, "c")).toBe("updated")
  }, 60000)

  test("the helper saying 'updated' is not enough: if the node's /health still reports the old commit, it fails", async () => {
    const f = mk([{ name: "a", behavior: "updated-but-old-running" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 3 })
    expect(statusOf(r, "a")).toBe("failed")
    expect(r.results[0].detail).toContain("/health reports ccd10f8")
    expect(statusOf(r, "b")).toBe("not-attempted")
  }, 60000)

  test("a node already at the target with added files (old CLI) is up to date and never updated", async () => {
    const f = mk([
      { name: "hive-001", cli: "1.5.21", health: TARGET, plan: dryPlan({ from: TARGET, untracked: ["som/send-approved-replies.spec.ts", "som/atlas/note.md"], oldCli: true }) },
      { name: "b" },
    ])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(rowOf(r, "hive-001").status).toBe("up-to-date")
    expect(statusOf(r, "hive-001")).toBe("current")
    expect(f.calls("hive-001").some((c) => c.includes("--detach-restart") || c === "update")).toBe(false)
    expect(statusOf(r, "b")).toBe("updated")
  }, 60000)

  test("an online node that never answers the plan is pending: unreachable", async () => {
    const f = mk([{ name: "a" }, { name: "ghost", unreachable: true }])
    const r = await runRollout(f.deps, { ref: "main", dryRun: true })
    expect(rowOf(r, "ghost").status).toBe("unreachable")
  }, 60000)

  test("CLI gating: an iris update that does not reach the required version fails the node and stops", async () => {
    const f = mk([{ name: "a", cli: "1.5.10", hasUpdate: false, cliAfter: "1.5.15" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "a")).toBe("failed")
    expect(r.results[0].detail).toContain("needs ≥ 1.5.22")
    expect(f.calls("a").some((c) => c.includes("--detach-restart"))).toBe(false)
    expect(statusOf(r, "b")).toBe("not-attempted")
  }, 60000)

  test("a node whose CLI is older than this one updates its CLI even when it already has daemon update", async () => {
    const f = mk([{ name: "a", cli: "1.5.21", cliAfter: "1.5.22" }], { localCli: "1.5.22" })
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(r.plan[0].status).toBe("ready-cli")
    expect(statusOf(r, "a")).toBe("updated")
    expect(f.calls("a")).toContain("update")
  }, 60000)

  test("an older CLI that would block on files you added is re-planned after its update — not sent to --force", async () => {
    const f = mk([
      {
        name: "a",
        cli: "1.5.21",
        cliAfter: "1.5.22",
        plan: dryPlan({ untracked: ["notes/mine.md"], oldCli: true }),
        planAfterCli: dryPlan({ kept: ["notes/mine.md"] }),
        kept: ["notes/mine.md"],
      },
    ])
    const r = await runRollout(f.deps, { ref: "main", pollSec: 0.1, waitSec: 20 })
    expect(r.plan[0].status).toBe("ready-cli")
    expect(statusOf(r, "a")).toBe("updated")
    expect(r.results[0].kept).toEqual(["notes/mine.md"])
    expect(f.calls("a").some((c) => c.includes("--force"))).toBe(false)
  }, 60000)

  test("--force passes --force to the node's daemon update for installs with local edits", async () => {
    const f = mk([{ name: "edited", plan: dryPlan({ modified: ["lib/a.js"] }) }])
    const r = await runRollout(f.deps, { ref: "main", force: true, pollSec: 0.1, waitSec: 20 })
    expect(statusOf(r, "edited")).toBe("updated")
    expect(f.calls("edited").some((c) => c.includes("--detach-restart") && c.includes("--force"))).toBe(true)
  }, 60000)

  test("not confirmed: nothing is dispatched beyond the read-only plan", async () => {
    const f = mk([{ name: "a" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", confirm: async () => false })
    expect(r.aborted).toContain("not confirmed")
    expect(f.dispatched.every((d) => d.title.includes("plan"))).toBe(true)
  }, 60000)

  test("--nodes picks by name or id; an unknown name aborts before anything runs", async () => {
    const f = mk([{ name: "a" }, { name: "b" }])
    const r = await runRollout(f.deps, { ref: "main", nodes: ["b"], dryRun: true })
    expect(r.plan.map((x) => x.name)).toEqual(["b"])
    const bad = await runRollout(f.deps, { ref: "main", nodes: ["nope"] })
    expect(bad.aborted).toContain("no node matching: nope")
    expect(f.dispatched.length).toBe(1) // only b's plan from the first call
  }, 60000)

  test("--parallel 2 after the canary still updates everyone and stops scheduling after a failure", async () => {
    const f = mk([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }])
    const r = await runRollout(f.deps, { ref: "main", parallel: 2, pollSec: 0.1, waitSec: 20 })
    expect(r.results.every((x) => x.status === "updated")).toBe(true)
  }, 60000)

  test("a big drift (more files than travel back) is compacted on the node, not misread as a failure", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `lib/file-${i}.js`)
    const f = mk([{ name: "a", plan: dryPlan({ modified: many }) }])
    const r = await runRollout(f.deps, { ref: "main", dryRun: true })
    expect(r.plan[0].status).toBe("needs-force")
    expect(r.plan[0].localMods).toBe(300)
  }, 60000)
})
