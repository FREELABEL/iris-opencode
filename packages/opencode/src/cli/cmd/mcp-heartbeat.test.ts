import { describe, expect, test } from "bun:test"
import { withProgressHeartbeat } from "./mcp-serve"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("withProgressHeartbeat (#189470)", () => {
  test("beats with the caller's token while the call runs, and stops after", async () => {
    const sent: any[] = []
    const out = await withProgressHeartbeat("tok-1", async (n) => void sent.push(n), async () => {
      await sleep(65)
      return "done"
    }, 20)
    expect(out).toBe("done")
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.every((n) => n.method === "notifications/progress" && n.params.progressToken === "tok-1")).toBe(true)
    expect(sent.map((n) => n.params.progress)).toEqual(sent.map((_, i) => i + 1))
    const after = sent.length
    await sleep(50)
    expect(sent.length).toBe(after)
  })

  test("sends nothing when the client did not ask for progress", async () => {
    const sent: any[] = []
    await withProgressHeartbeat(undefined, async (n) => void sent.push(n), () => sleep(50), 10)
    expect(sent.length).toBe(0)
  })

  test("stops beating when the call throws", async () => {
    const sent: any[] = []
    await expect(
      withProgressHeartbeat(7, async (n) => void sent.push(n), async () => {
        await sleep(30)
        throw new Error("boom")
      }, 10),
    ).rejects.toThrow("boom")
    const after = sent.length
    await sleep(40)
    expect(sent.length).toBe(after)
  })
})
