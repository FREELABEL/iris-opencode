import { afterEach, describe, expect, test } from "bun:test"
process.env.IRIS_USER_ID = "7"
import {
  failureReason,
  fetchModels,
  fetchToolCatalog,
  mergeConfig,
  readModels,
  saveAgent,
  savePolicy,
  saveTools,
  unwrapRecord,
} from "../../src/iris/agent-editor"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
function answer(status: number, body: unknown, seen?: { url: string; init?: RequestInit }[]) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    seen?.push({ url: String(url), init })
    return new Response(body === undefined ? "" : JSON.stringify(body), { status })
  }) as typeof fetch
}

describe("agent editor sidecar (#191840)", () => {
  test("a missing tool catalogue is a fact about the server, not an error", async () => {
    answer(404, { message: "Not Found" })
    expect(await fetchToolCatalog()).toEqual({ ok: true, status: 404, data: { available: false, catalog: null } })
  })
  test("the tool catalogue is passed through whole (fl-iris-api #253 shape), wrapped or not", async () => {
    const catalog = { version: 1, defaults: ["executeWebSearch"], tools: [{ id: "executeWebSearch", effect: "read" }] }
    for (const body of [catalog, { data: catalog }]) {
      answer(200, body)
      expect((await fetchToolCatalog()).data).toEqual({ available: true, catalog })
    }
  })
  test("a catalogue that fails for another reason is reported as a failure", async () => {
    answer(500, { message: "boom" })
    expect(await fetchToolCatalog()).toMatchObject({ ok: false, status: 500, reason: "boom" })
  })
  test("models: only what the manifest says it will serve, as the chat picker does", () => {
    const models = readModels({
      data: [
        { id: "iris/kimi-k2.6", name: "Kimi K2.6", available: true, reasoning: true, limits: { context: 262144 } },
        { id: "iris/gpt-5-nano", name: "GPT-5 nano", available: false },
        { id: "iris/hy3", available: true, tool_calling: false },
      ],
    })
    expect(models).toEqual([
      { id: "iris/kimi-k2.6", name: "Kimi K2.6", reasoning: true, toolCalling: true, context: 262144 },
      { id: "iris/hy3", name: "hy3", reasoning: false, toolCalling: false, context: null },
    ])
  })
  test("a manifest that cannot be read says so", async () => {
    answer(503, {})
    expect(await fetchModels()).toMatchObject({ ok: false, status: 503 })
  })
  test("policy saves send {policy} — null clears it", async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    answer(200, { ok: true, policy: null }, seen)
    await savePolicy(42, undefined)
    expect(seen[0].url).toEndWith("/api/v1/agents/42/policy")
    expect(seen[0].init?.method).toBe("PUT")
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ policy: null })
  })
  test("a 422 keeps its field errors and says the most specific thing", async () => {
    answer(422, { error: "quiet_hours.start must be HH:MM (24-hour).", field: "policy" })
    expect(await savePolicy(42, { quiet_hours: { start: "9", end: "10" } })).toMatchObject({
      ok: false,
      status: 422,
      reason: "quiet_hours.start must be HH:MM (24-hour).",
    })
    expect(failureReason(422, { errors: { name: ["The name field is required."] } })).toBe("name: The name field is required.")
    expect(failureReason(409, { error: "duplicate_name", message: 'An agent named "A" already exists' })).toBe(
      'An agent named "A" already exists',
    )
    expect(failureReason(500, undefined)).toBe("HTTP 500")
  })
  test("fl-api records are unwrapped from data and data.data", () => {
    expect(unwrapRecord({ data: { id: 1 } })).toEqual({ id: 1 })
    expect(unwrapRecord({ data: { data: { id: 2 } } })).toEqual({ id: 2 })
    expect(unwrapRecord({ id: 3 })).toEqual({ id: 3 })
  })

  // Saving Personality or Model must never erase tools, policy or autonomy (#191840): fl-api
  // replaces the whole config column on update.
  test("an update sends no config unless it patches one, and a patch merges into a FRESH read", async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const stored = { model: "gpt-4o-mini", tools: ["executeWebSearch"], policy: { denied_tools: ["publish_*"] }, autonomy: "lead" }
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      if (!init?.method || init.method === "GET") return new Response(JSON.stringify({ data: { id: 9, config: stored } }))
      return new Response(JSON.stringify({ data: { id: 9 } }))
    }) as typeof fetch

    await saveAgent(9, { name: "Renamed", config: { tools: [] } })
    const personality = JSON.parse(String(seen.at(-1)!.init!.body))
    expect(seen.at(-1)!.init!.method).toBe("PUT")
    expect(personality).toEqual({ name: "Renamed" })

    seen.length = 0
    await saveAgent(9, {}, { model: "iris/kimi-k2.6", temperature: 0.3 })
    expect(seen.map((x) => x.init?.method ?? "GET")).toEqual(["GET", "PUT"])
    expect(JSON.parse(String(seen[1].init!.body)).config).toEqual({ ...stored, model: "iris/kimi-k2.6", temperature: 0.3 })
  })
  test("a create keeps its config — that is where the explicit tool list goes", async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    answer(201, { data: { id: 10 } }, seen)
    const r = await saveAgent(undefined, { name: "New", config: { tools: ["agent_memory"] } })
    expect(r).toMatchObject({ ok: true, data: { id: 10 } })
    expect(seen[0].url).toEndWith("/api/v1/users/7/bloqs/agents")
    expect(JSON.parse(String(seen[0].init!.body)).config).toEqual({ tools: ["agent_memory"] })
  })
  test("tools go to iris-api /tools; only a 404 falls back to a merged fl-api patch", async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      if (String(url).endsWith("/tools")) return new Response("{}", { status: 404 })
      if (!init?.method) return new Response(JSON.stringify({ data: { id: 9, config: { policy: { x: 1 } } } }))
      return new Response(JSON.stringify({ data: { id: 9 } }))
    }) as typeof fetch
    const r = await saveTools(9, ["executeWebSearch"])
    expect(r).toMatchObject({ ok: true, data: { via: "fl-api" } })
    expect(JSON.parse(String(seen.at(-1)!.init!.body)).config).toEqual({ policy: { x: 1 }, tools: ["executeWebSearch"] })

    answer(422, { error: "Not a tool an agent can be given: x.", field: "tools", unknown: ["x"] })
    expect(await saveTools(9, ["x"])).toMatchObject({ ok: false, status: 422, reason: "Not a tool an agent can be given: x." })
  })
  test("mergeConfig reads a JSON-string config and never returns an array", () => {
    expect(mergeConfig('{"a":1}', { b: 2 })).toEqual({ a: 1, b: 2 })
    expect(mergeConfig([1], { b: 2 })).toEqual({ b: 2 })
    expect(mergeConfig("nope", { b: 2 })).toEqual({ b: 2 })
  })
})
