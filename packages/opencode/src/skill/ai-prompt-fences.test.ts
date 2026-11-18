import { describe, expect, test } from "bun:test"
import { aiPromptFrom, parseSteps } from "./executor"

/**
 * #193829 — a prompt that loses its payload still gets an answer.
 *
 * legal-matter-intake's extract step is prose, then an UNTAGGED fence holding the client's
 * words, then a ```json template. The body had every fence stripped and the code is only the
 * first TAGGED fence, so dispatch sent the prose alone: no enquiry, no template. The model
 * answered with an invented empty shape, the next step found no client name, exited 0, and
 * the playbook reported "3 passed" having opened nothing.
 */
const F = "`".repeat(3)
const md = [
  "### step:extract Extract the matter fields",
  "",
  F + "yaml", "mode: prompt", F,
  "",
  "You are a legal intake specialist. Convert this enquiry into a structured intake record.",
  "",
  "ENQUIRY:",
  F, "Maria Fictona was rear-ended on I-35.", F,
  "",
  "Return JSON only:",
  "",
  F + "json", '{ "client": { "name": "" } }', F,
  "",
  "Rules: never invent a fact.",
].join("\n")

describe("a prompt step sends every part the author wrote, in order", () => {
  const [step] = parseSteps(md)
  const sent = aiPromptFrom(step.body, step.code, step.instructions)

  test("the untagged fence's text reaches the prompt (the enquiry)", () => {
    expect(sent).toContain("Maria Fictona was rear-ended on I-35.")
  })
  test("the tagged fence reaches the prompt (the template)", () => {
    expect(sent).toContain('"client": { "name": "" }')
  })
  test("the prose reaches the prompt, before and after the fences, in order", () => {
    const a = sent.indexOf("legal intake specialist"), b = sent.indexOf("Maria"), c = sent.indexOf('"client"'), d = sent.indexOf("never invent")
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a < b && b < c && c < d).toBe(true)
  })
  test("the yaml header is not part of the prompt", () => {
    expect(sent).not.toContain("mode: prompt")
  })
  test("the old two-argument rule alone loses the enquiry — the test bites", () => {
    expect(aiPromptFrom(step.body, step.code)).not.toContain("Maria Fictona")
  })
})

describe("steps that were already right keep the prompt they had", () => {
  test("fence-only step: still the fence", () => {
    const [s] = parseSteps(["### step:a A", "", F + "yaml", "mode: ai", F, "", F + "text", "Reply OK", F].join("\n"))
    expect(aiPromptFrom(s.body, s.code, s.instructions).trim()).toBe("Reply OK")
  })
  test("prose-only step: still the prose", () => {
    const [s] = parseSteps(["### step:a A", "", F + "yaml", "mode: ai", F, "", "Summarise the diff."].join("\n"))
    expect(aiPromptFrom(s.body, s.code, s.instructions).trim()).toBe("Summarise the diff.")
  })
})
