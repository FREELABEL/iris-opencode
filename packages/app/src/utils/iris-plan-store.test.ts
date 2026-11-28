import { describe, expect, test } from "bun:test"
import { irisPlan, refreshIrisPlan, watchIrisPlan } from "./iris-plan-store"

describe("one shared /iris/plan read (epic #194525)", () => {
  test("every caller shares one fetcher; a failed read keeps the last answer", async () => {
    let calls = 0
    let fail = false
    const paths: string[] = []
    const fetcher = async (path: string) => {
      calls++
      paths.push(path)
      if (fail) throw new Error("sidecar restarting")
      return new Response(JSON.stringify({ measured: true, fraction: 0.5 }))
    }
    expect(irisPlan()).toBeUndefined()
    watchIrisPlan(fetcher)
    watchIrisPlan(async () => {
      throw new Error("a second poller must never start")
    })
    await refreshIrisPlan()
    expect(irisPlan()).toEqual({ measured: true, fraction: 0.5 })
    expect(paths.every((p) => p === "/iris/plan")).toBe(true) // never /iris/allowance
    fail = true
    await refreshIrisPlan()
    expect(irisPlan()).toEqual({ measured: true, fraction: 0.5 })
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
