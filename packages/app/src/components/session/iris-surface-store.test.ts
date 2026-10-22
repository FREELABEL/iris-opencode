import { beforeEach, describe, expect, test } from "bun:test"
import {
  MAX_HELD,
  heldPayload,
  holdPayload,
  needsAttention,
  resetSurfaceStore,
  setSurfaceSync,
  surfaceSync,
  syncLabel,
  syncOfPayload,
} from "./iris-surface-store"

// #190231 phase 2: going back to a view draws what the panel held, and every surface says whether
// what is on screen is current.

beforeEach(() => resetSurfaceStore())

describe("held payloads", () => {
  test("a view you had comes back as you left it", () => {
    holdPayload("b|42|atlas|lists|", { lists: [1] })
    expect(heldPayload<any>("b|42|atlas|lists|")).toEqual({ lists: [1] })
    expect(heldPayload<any>("b|42|atlas|schemas|")).toBeUndefined()
  })

  test("bounded: past the limit the least recently used view goes, not the one just read", () => {
    for (let i = 0; i < MAX_HELD; i++) holdPayload(`k${i}`, i)
    heldPayload("k0") // read: now the most recent
    holdPayload("new", "x")
    expect(heldPayload<any>("k0")).toBe(0)
    expect(heldPayload<any>("k1")).toBeUndefined()
    expect(heldPayload<any>("new")).toBe("x")
  })
})

describe("sync state of what is on screen", () => {
  test("a live answer is synced, stamped when it arrived", () => {
    expect(syncOfPayload({ measured: true, __at: 1000 })).toEqual({ state: "synced", at: 1000 })
  })
  test("drawn from what we held, or from the board's copy, or mid-refresh: checking", () => {
    expect(syncOfPayload({ measured: true, __held: true }).state).toBe("checking")
    expect(syncOfPayload({ measured: true, source: "copy" }).state).toBe("checking")
    expect(syncOfPayload({ measured: true, __at: 1 }, true).state).toBe("checking")
  })
  test("offline wins over everything, and carries the copy's age", () => {
    expect(syncOfPayload({ measured: true, source: "copy", offline: true, copiedAt: "2026-10-22T10:00:00Z" }, true)).toEqual({
      state: "offline",
      copiedAt: "2026-10-22T10:00:00Z",
      reason: undefined,
    })
  })
  test("the server answered without data: error — but not while a retry is in flight", () => {
    expect(syncOfPayload({ measured: false, reason: "not signed in" })).toEqual({ state: "error", reason: "not signed in" })
    expect(syncOfPayload({ measured: false }, true).state).toBe("checking")
  })
})

describe("what the chip and the tab strip say", () => {
  const now = Date.parse("2026-10-22T12:00:00Z")
  test("each state in words", () => {
    expect(syncLabel(undefined, now)).toBeNull()
    expect(syncLabel({ state: "checking" }, now)!.text).toBe("Checking…")
    expect(syncLabel({ state: "synced", at: now - 10_000 }, now)!.text).toBe("Synced · just now")
    expect(syncLabel({ state: "synced", at: now - 5 * 60_000 }, now)!.text).toBe("Synced · 5m ago")
    expect(syncLabel({ state: "offline", copiedAt: "2026-10-22T11:48:00Z" }, now)!.text).toBe("Offline · copy from 12m ago")
    expect(syncLabel({ state: "error", reason: "fl-api 403" }, now)!.title).toContain("fl-api 403")
  })
  test("only a tab showing something not current gets a dot", () => {
    setSurfaceSync("atlas", { state: "offline" })
    setSurfaceSync("agents", { state: "synced", at: now })
    setSurfaceSync("pages", { state: "error" })
    expect(needsAttention(surfaceSync("atlas"))).toBe(true)
    expect(needsAttention(surfaceSync("pages"))).toBe(true)
    expect(needsAttention(surfaceSync("agents"))).toBe(false)
    expect(needsAttention(surfaceSync("hive"))).toBe(false)
  })
})
