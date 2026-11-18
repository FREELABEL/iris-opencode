import { describe, expect, test } from "bun:test"
import { merge3, planPull, planPush, recordState, type Base, type Change, type LocalRecord } from "./atlas-dataset-sync"

const base = (id: number, revision: number, data: Record<string, unknown>, status = "active"): Base => ({ id, revision, status, data })
const local = (id: number | null, data: Record<string, unknown>, file = `${id}.json`, status = "active"): LocalRecord => ({ id, file, status, data })
const change = (id: number, revision: number, data: Record<string, unknown> | null, status = "active"): Change =>
  data === null ? { id, revision, deleted: true } : { id, revision, deleted: false, status, data }

describe("merge3 — field by field", () => {
  test("each side's change to a different field is kept", () => {
    const r = merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })
    expect(r.merged).toEqual({ a: 2, b: 3 })
    expect(r.conflicts).toEqual([])
  })
  test("the same change on both sides is not a conflict", () => {
    expect(merge3({ a: 1 }, { a: 2 }, { a: 2 }).conflicts).toEqual([])
  })
  test("different changes to the same field: local kept, field named", () => {
    const r = merge3({ a: 1 }, { a: 2 }, { a: 3 })
    expect(r.merged).toEqual({ a: 2 })
    expect(r.conflicts).toEqual(["a"])
  })
  test("a field removed on one side and untouched on the other is removed", () => {
    expect(merge3({ a: 1, b: 1 }, { a: 1 }, { a: 1, b: 1 }).merged).toEqual({ a: 1 })
    expect(merge3({ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1 }).merged).toEqual({ a: 1 })
  })
  test("nested values compare by content, not key order", () => {
    expect(merge3({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } }, { o: { x: 1, y: 2 } }).conflicts).toEqual([])
  })
})

describe("recordState", () => {
  test("names every state a copy can be in", () => {
    expect(recordState(local(null, { a: 1 }, "new-1.json"), undefined)).toBe("local-only")
    expect(recordState(local(1, { a: 1 }), base(1, 2, { a: 1 }))).toBe("synced")
    expect(recordState(local(1, { a: 9 }), base(1, 2, { a: 1 }))).toBe("modified")
    expect(recordState(undefined, base(1, 2, { a: 1 }))).toBe("deleted-locally")
    expect(recordState(local(1, { a: 1 }), base(1, 2, { a: 1 }), 3)).toBe("behind")
    expect(recordState(local(1, { a: 9 }), base(1, 2, { a: 1 }), 3)).toBe("diverged")
  })
})

describe("planPull", () => {
  test("a new record is written; an untouched one is replaced; one already held is skipped", () => {
    const plan = planPull(
      [change(1, 1, { a: 1 }), change(2, 5, { a: 5 }), change(3, 2, { a: 2 })],
      [local(2, { a: 4 }), local(3, { a: 2 })],
      [base(2, 4, { a: 4 }), base(3, 2, { a: 2 })],
    )
    expect(plan.map((p) => [p.id, p.action])).toEqual([[1, "write"], [2, "write"], [3, "skip"]])
  })

  test("a record edited locally is MERGED, not overwritten", () => {
    const [p] = planPull([change(2, 5, { a: 1, b: 9 })], [local(2, { a: 7, b: 1 })], [base(2, 4, { a: 1, b: 1 })])
    if (p.action !== "merge") throw new Error(`expected merge, got ${p.action}`)
    expect(p.local).toEqual({ a: 7, b: 9 })
    expect(p.base?.revision).toBe(5)
    expect(p.conflicts).toEqual([])
  })

  test("a conflicting field keeps the local value and is reported", () => {
    const [p] = planPull([change(2, 5, { a: 3 })], [local(2, { a: 2 })], [base(2, 4, { a: 1 })])
    if (p.action !== "merge") throw new Error(`expected merge, got ${p.action}`)
    expect(p.local).toEqual({ a: 2 })
    expect(p.conflicts).toEqual(["a"])
  })

  test("deleted on the server: an untouched copy is removed, an edited one is kept and flagged", () => {
    const clean = planPull([change(2, 5, null)], [local(2, { a: 1 })], [base(2, 4, { a: 1 })])
    expect(clean[0].action).toBe("remove")
    const edited = planPull([change(2, 5, null)], [local(2, { a: 9 })], [base(2, 4, { a: 1 })])
    expect(edited[0].action).toBe("keep-deleted-remotely")
  })

  test("a repeated change (same revision) does nothing — the feed may repeat", () => {
    const plan = planPull([change(2, 4, { a: 1 }), change(2, 4, { a: 1 })], [local(2, { a: 1 })], [base(2, 4, { a: 1 })])
    expect(plan.every((p) => p.action === "skip")).toBe(true)
  })
})

describe("planPush", () => {
  test("new records are created; edits carry their base revision; synced ones are left alone", () => {
    const plan = planPush(
      [local(null, { a: 1 }, "new-x.json"), local(2, { a: 9 }), local(3, { a: 3 })],
      [base(2, 4, { a: 1 }), base(3, 7, { a: 3 })],
      { prune: false, conflicted: [] },
    )
    expect(plan).toEqual([
      { action: "create", file: "new-x.json", data: { a: 1 } },
      { action: "update", id: 2, file: "2.json", data: { a: 9 }, status: "active", baseRevision: 4 },
    ])
  })

  test("absence is not deletion — a missing file is deleted only with --prune", () => {
    expect(planPush([], [base(5, 1, { a: 1 })], { prune: false, conflicted: [] })).toEqual([])
    expect(planPush([], [base(5, 1, { a: 1 })], { prune: true, conflicted: [] })).toEqual([{ action: "delete", id: 5, baseRevision: 1 }])
  })

  test("a record with an unresolved conflict is not pushed", () => {
    const plan = planPush([local(2, { a: 9 })], [base(2, 4, { a: 1 })], { prune: false, conflicted: [2] })
    expect(plan).toEqual([{ action: "blocked", id: 2, reason: "unresolved conflict" }])
  })
})
