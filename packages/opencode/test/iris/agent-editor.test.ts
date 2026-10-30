import { afterEach, describe, expect, test } from "bun:test"
import { failureReason, fetchModels, fetchToolCatalog, readModels, savePolicy, unwrapRecord } from "../../src/iris/agent-editor"

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
    expect(await fetchToolCatalog()).toEqual({ ok: true, status: 404, data: { available: false, tools: [] } })
  })
  test("the tool catalogue is read from tools, data.tools or data", async () => {
    const tools = [{ name: "websearchtool", effect: "read" }]
    for (const body of [{ tools }, { data: { tools } }, { data: tools }]) {
      answer(200, body)
      expect((await fetchToolCatalog()).data).toEqual({ available: true, tools })
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
})
