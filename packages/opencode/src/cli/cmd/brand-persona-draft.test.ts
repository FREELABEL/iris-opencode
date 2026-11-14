import { describe, expect, test } from "bun:test"
import { draftPersonaFromVoice, type PersonaDraft } from "./brand-persona-draft"

// IRIS #8's kit as served on 2026-11-05 (design_tokens.brand).
const IRIS = {
  name: "IRIS",
  voice: "Confident, technical but approachable, direct, no fluff. Speaks to founders and operators who build with their hands.",
  tone: "Professional yet bold. We don't sell dreams — we show what the system does. CLI-first, automation-forward.",
  tagline: "AI Business Operations System",
  description: "Multi-agent infrastructure for every business — agents, workflows, pages, outreach, and monetization from one platform.",
}

const ok = (d: ReturnType<typeof draftPersonaFromVoice>): PersonaDraft => {
  if ("error" in d) throw new Error(d.error)
  return d
}

describe("a persona drafted from a brand's voice (#192669)", () => {
  test("IRIS: name, audience, do / don't and sample lines all come from the kit's own words", () => {
    const d = ok(draftPersonaFromVoice(IRIS))
    expect(d.body.name).toBe("IRIS voice")
    expect(d.body.target_demographic).toBe("founders and operators who build with their hands")
    expect(d.body.style_guidelines.do).toEqual([
      "Confident",
      "technical but approachable",
      "direct",
      "Professional yet bold",
      "show what the system does",
      "CLI-first",
      "automation-forward",
    ])
    expect(d.body.style_guidelines.dont).toEqual(["fluff", "sell dreams"])
    expect(d.body.style_guidelines.sample_lines).toEqual([
      "AI Business Operations System",
      "We don't sell dreams — we show what the system does.",
      "Multi-agent infrastructure for every business — agents, workflows, pages, outreach, and monetization from one platform.",
    ])
    expect(d.body.tone).toBe(IRIS.tone)
    expect(d.body.archetype).toBe("brand_voice")
    expect(d.missing).toEqual([])
    expect(d.body.system_prompt).toContain("You write as IRIS.")
    expect(d.body.system_prompt).toContain("Don't: fluff; sell dreams.")
  })

  test("never a default unless asked, and overrides win", () => {
    expect(ok(draftPersonaFromVoice(IRIS)).body.is_default).toBe(false)
    const d = ok(draftPersonaFromVoice(IRIS, { name: "IRIS — release notes", audience: "developers", isDefault: true }))
    expect(d.body.name).toBe("IRIS — release notes")
    expect(d.body.target_demographic).toBe("developers")
    expect(d.body.is_default).toBe(true)
  })

  test("what the kit does not say is left empty and named, not guessed", () => {
    const d = ok(draftPersonaFromVoice({ name: "Acme", voice: "Warm, plain." }))
    expect(d.body.target_demographic).toBeUndefined()
    expect(d.body.style_guidelines.sample_lines).toEqual([])
    expect(d.missing).toEqual(["audience", "sample lines"])
    expect(d.body.style_guidelines.drafted_from).toEqual(["brand.voice"])
  })

  test("no voice and no tone is an error, not an empty persona", () => {
    expect(draftPersonaFromVoice({ name: "Empty", tagline: "x" })).toHaveProperty("error")
  })
})
