import { describe, expect, test } from "bun:test"
import snapshot from "./snapshot"
import { baseModelID, mergeDetails, modelDetails, priceLevel, speedLevel, type DetailsDoc, type ModelFacts } from "./model-details"

const doc = snapshot as unknown as DetailsDoc

const iris = (id: string, extra: Partial<ModelFacts> = {}): ModelFacts => ({
  id,
  name: id,
  providerID: "iris",
  providerName: "IRIS",
  cost: { input: 0.15, output: 0.6 },
  context: 1_000_000,
  ...extra,
})

describe("model details", () => {
  test("a tier reports the model it runs on, with that model's scores", () => {
    const d = modelDetails(doc, iris("iris-ai"))
    expect(d.goodFor.length).toBeGreaterThan(0)
    expect(d.runsOn).toBeTruthy()
    expect(d.publicScore?.smarts).toBe(doc.public![doc.aliases!["deepseek-v4.1-flash"]].smarts)
    expect(d.iris?.accuracy).toBe(doc.iris_bench!["deepseek-v4.1-flash"].accuracy)
  })

  test("a model with no published score gets none — never a guess", () => {
    const d = modelDetails(doc, iris("not-a-real-model-xyz"))
    expect(d.publicScore).toBeUndefined()
    expect(d.iris).toBeUndefined()
    expect(d.goodFor).toEqual([])
    expect(d.speed).toBeUndefined()
  })

  test("route variants share the base model's facts", () => {
    expect(baseModelID("iris/gpt-6-luna-or")).toBe("gpt-6-luna")
    expect(baseModelID("gpt-6-luna-zen")).toBe("gpt-6-luna")
    expect(modelDetails(doc, iris("gpt-6-luna-or")).publicScore).toEqual(modelDetails(doc, iris("gpt-6-luna")).publicScore)
  })

  test("a connected provider's model is matched by name", () => {
    const anthropic = Object.entries(doc.public!).find(([, v]) => v.maker === "Anthropic")
    expect(anthropic).toBeTruthy()
    const [, entry] = anthropic!
    const d = modelDetails(doc, { id: "some-provider-id", name: entry.name, providerID: "anthropic", providerName: "Anthropic" })
    expect(d.publicScore?.smarts).toBe(entry.smarts)
  })

  test("usage is IRIS's own, so it is only shown for IRIS models", () => {
    const live = mergeDetails(doc, {
      sources: { usage: { window_days: 30, as_of: "2026-11-26" } },
      usage: { "gpt-6-luna": { share: 0.2, rank: 1, success: 0.99 } },
    })
    expect(modelDetails(live, iris("gpt-6-luna")).usage?.share).toBe(0.2)
    expect(modelDetails(live, { ...iris("gpt-6-luna"), providerID: "openai" }).usage).toBeUndefined()
    // The bundled snapshot carries no usage: offline, the pane shows none rather than stale numbers.
    expect(modelDetails(doc, iris("gpt-6-luna")).usage).toBeUndefined()
  })

  test("live details override the snapshot per model and keep the rest", () => {
    const live = mergeDetails(doc, { models: { "gpt-6-luna": { good_for: ["Live"] } } })
    expect(modelDetails(live, iris("gpt-6-luna")).goodFor).toEqual(["Live"])
    expect(modelDetails(live, iris("glm-5.3-flash")).goodFor).toEqual(doc.models["glm-5.3-flash"].good_for!)
    expect(mergeDetails(doc, undefined)).toBe(doc)
  })

  test("our own timing decides speed when we have it, not a public tokens-per-second figure", () => {
    // DeepSeek streams fast in public but took ~43 s an answer on our test: it must not read "Fast".
    const d = modelDetails(doc, iris("iris-ai"))
    expect(d.speedBasis?.kind).toBe("iris")
    expect(d.speed).toBe("low")
    expect(d.runsOn).not.toMatch(/\d{4}$/)
    const live = mergeDetails(doc, {
      sources: { usage: { window_days: 30, as_of: "2026-11-26" } },
      usage: { "iris-ai": { seconds: 5 } },
    })
    expect(modelDetails(live, iris("iris-ai")).speed).toBe("high")
    // No measurement of ours: the public figure is all there is.
    expect(modelDetails(doc, iris("gemini-4-hydrogen")).speedBasis?.kind).toBe("public")
  })

  test("plain levels for price and speed", () => {
    expect(priceLevel(0.5)).toBe("low")
    expect(priceLevel(4.8)).toBe("medium")
    expect(priceLevel(20)).toBe("high")
    expect(speedLevel(300)).toBe("high")
    expect(speedLevel(80)).toBe("medium")
    expect(speedLevel(30)).toBe("low")
    expect(modelDetails(doc, iris("free", { cost: { input: 0, output: 0 } })).price?.free).toBe(true)
  })

  test("the snapshot only claims what it can source", () => {
    expect(doc.sources.public?.url).toMatch(/^https:\/\//)
    expect(doc.sources.iris?.url).toMatch(/^https:\/\//)
    for (const [id, entry] of Object.entries(doc.public!)) {
      if (entry.rank !== undefined) expect(entry.smarts, id).toBeDefined()
    }
  })
})
