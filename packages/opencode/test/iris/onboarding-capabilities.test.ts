import { describe, expect, test } from "bun:test"
import { CATALOG, MIN_CONFIDENCE, OFFER, capabilities, intentCapability, parseIntentJson } from "../../src/iris/onboarding-capabilities"

// The shape `iris intent --json` printed on 2026-10-08, banner and all.
const intentOut = (choice: string, confidence: number, commands: string[]) =>
  `\u001b[90m◈ intent\u001b[0m\n${JSON.stringify({ query: "q", choice, confidence, commands, decided_by: "decide:jev" })}\n`

describe("parseIntentJson", () => {
  test("reads choice, confidence and commands through the banner", () => {
    expect(parseIntentJson(intentOut("leads pulse", 0.71, ["iris leads pulse <id>"]))).toEqual({
      choice: "leads pulse",
      confidence: 0.71,
      commands: ["iris leads pulse <id>"],
    })
  })
  test("garbage is null, not a crash", () => {
    expect(parseIntentJson("no json here")).toBeNull()
    expect(parseIntentJson("{ broken")).toBeNull()
  })
})

describe("intentCapability", () => {
  test("a confident pick becomes an option", () => {
    expect(intentCapability("find me leads", { choice: "leads pulse", confidence: 0.71, commands: [] })?.tool).toBe("iris leads pulse")
  })
  test("below MIN_CONFIDENCE it is nothing — measured: 0.47 picked iMessage for an email goal", () => {
    expect(intentCapability("reply to people in my email", { choice: "imessage mentions approve", confidence: 0.47, commands: [] })).toBeNull()
    expect(MIN_CONFIDENCE).toBeGreaterThan(0.47)
  })
})

describe("capabilities", () => {
  const exec = (out: string) => async () => ({ code: 0, stdout: out })

  test("a starter goal is the catalog even when intent is wrong", async () => {
    const r = await capabilities("reply", "Reply to people waiting on me", {
      cli: "/x/iris",
      exec: exec(intentOut("imessage mentions approve", 0.47, ["iris imessage mentions approve <id>"])),
    })
    // The catalog leads; the third is the nearest other goal's, never intent's wrong pick.
    expect(r.capabilities.map((c) => c.id).slice(0, CATALOG.reply.length)).toEqual(CATALOG.reply.map((c) => c.id))
    expect(r.capabilities).toHaveLength(OFFER)
    expect(r.capabilities.some((c) => c.source === "intent")).toBe(false)
    expect(r.capabilities.filter((c) => c.primary).map((c) => c.id)).toEqual(["draft-replies"])
  })

  test("a starter goal gains intent's pick when it is confident and new", async () => {
    const r = await capabilities("admin", "Deal with bills", { cli: "/x/iris", exec: exec(intentOut("ledger reconcile", 0.8, [])) })
    expect(r.capabilities.at(-1)).toMatchObject({ source: "intent", tool: "iris ledger reconcile", primary: false })
  })

  test("own words: intent's confident pick", async () => {
    const r = await capabilities("custom", "book more appointments", { cli: "/x/iris", exec: exec(intentOut("calendar slots", 0.82, [])) })
    expect(r.capabilities).toHaveLength(OFFER)
    expect(r.capabilities[0]).toMatchObject({ source: "intent", tool: "iris calendar slots", primary: true })
    expect(r.capabilities.slice(1).every((c) => !c.primary)).toBe(true)
  })

  test("own words, intent unsure or CLI missing: nothing primary (their words are the answer) — never a wrong tool", async () => {
    const unsure = await capabilities("custom", "book more appointments", { cli: "/x/iris", exec: exec(intentOut("playbook run pathways-navigation", 0.28, [])) })
    expect(unsure.capabilities).toHaveLength(OFFER)
    expect(unsure.capabilities.some((c) => c.primary || c.source === "intent")).toBe(false)
    const noCli = await capabilities("custom", "book more appointments", { cli: null })
    expect(noCli.capabilities.some((c) => c.primary)).toBe(false)
    expect(noCli.intent).toBeNull()
  })

  test("a failed payment is an alert, not a receipt for the books", () => {
    const books = CATALOG.admin.find((c) => c.id === "bills-to-books")!
    const re = new RegExp(`\\b(${books.evidence.pattern})`, "i")
    expect(re.test("Payment failed: autopay for card ending 1180")).toBe(false)
    expect(re.test("Your receipt from Dentrix Cloud")).toBe(true)
    expect(re.test("Payment received from Venue House")).toBe(true)
  })

  test("every catalog tool names something real, and every goal has a primary", () => {
    for (const [goal, caps] of Object.entries(CATALOG)) {
      expect(caps.some((c) => c.primary)).toBe(true)
      for (const c of caps) expect(c.tool.length, `${goal}/${c.id}`).toBeGreaterThan(3)
    }
  })
})
