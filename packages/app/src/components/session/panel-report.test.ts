import { describe, expect, test } from "bun:test"
import { alternateLoopback, deliverReport } from "./panel-report"

// #191506 — a panel answer the engine never got read, to the agent, as "the user is not looking".

type Call = { url: string; body: string }
function recorder(answers: Array<"ok" | "500" | "throw" | "hang">) {
  const calls: Call[] = []
  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) })
    const a = answers[calls.length - 1] ?? "ok"
    if (a === "ok") return Promise.resolve(new Response("{}", { status: 200 }))
    if (a === "500") return Promise.resolve(new Response("bad", { status: 500 }))
    if (a === "throw") return Promise.reject(new TypeError("Load failed"))
    // Queued behind the webview's per-host connection limit: never completes until aborted.
    return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe("deliverReport", () => {
  test("one POST when the engine takes it", async () => {
    const r = recorder(["ok"])
    expect(await deliverReport(r.fetch, "http://127.0.0.1:52562/", { session: "s", ack: "pc_1" })).toBe(true)
    expect(r.calls.map((c) => c.url)).toEqual(["http://127.0.0.1:52562/iris/panel/state"])
    expect(JSON.parse(r.calls[0].body)).toEqual({ session: "s", ack: "pc_1" })
  })

  test("a refused answer (non-2xx) is sent again — it used to be dropped without a look at the status", async () => {
    const r = recorder(["500", "ok"])
    expect(await deliverReport(r.fetch, "http://127.0.0.1:52562", { ack: "pc_1" })).toBe(true)
    expect(r.calls).toHaveLength(2)
  })

  test("a request stuck in the queue is abandoned and re-sent by the engine's OTHER loopback name", async () => {
    const r = recorder(["hang", "ok"])
    expect(await deliverReport(r.fetch, "http://127.0.0.1:52562", { ack: "pc_1" }, { attemptMs: 30 })).toBe(true)
    expect(r.calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:52562/iris/panel/state",
      "http://localhost:52562/iris/panel/state",
    ])
  })

  test("gives up after the attempts, and says so", async () => {
    const r = recorder(["throw", "throw", "throw", "ok"])
    expect(await deliverReport(r.fetch, "http://127.0.0.1:1", {}, { attemptMs: 30 })).toBe(false)
    expect(r.calls).toHaveLength(3)
  })
})

describe("alternateLoopback", () => {
  test("swaps the two loopback spellings, keeps the port, leaves other hosts alone", () => {
    expect(alternateLoopback("http://127.0.0.1:52562")).toBe("http://localhost:52562")
    expect(alternateLoopback("http://localhost:52562/")).toBe("http://127.0.0.1:52562")
    expect(alternateLoopback("https://example.com")).toBeUndefined()
    expect(alternateLoopback("not a url")).toBeUndefined()
  })
})
