import { describe, expect, test } from "bun:test"
import { buildScript, jsTemplate, scopedTools, slugify } from "./platform-workflows-export"

/**
 * The generated file's whole promise is that it RUNS. A prompt is arbitrary user text and
 * goes inside a template literal, so a stray backtick or ${ would close the literal early
 * and emit a file that looks fine and does not parse.
 */
describe("jsTemplate", () => {
  test("escapes a backtick so the literal cannot be closed early", () => {
    expect(jsTemplate("run `ls` now")).toBe("`run \\`ls\\` now`")
  })
  test("escapes ${ so nothing interpolates", () => {
    expect(jsTemplate("cost is ${total}")).toBe("`cost is \\${total}`")
  })
  test("escapes backslashes before anything else", () => {
    expect(jsTemplate("a\\b")).toBe("`a\\\\b`")
  })
})

describe("buildScript", () => {
  const base = { id: 1, name: "My Flow", description: "d", execution_mode: "agentic" }

  test("emits one phase and one agent call per step, in order", () => {
    const { code } = buildScript({ ...base, steps: [
      { name: "Second", order: 2, prompt: "two" },
      { name: "First", order: 1, prompt: "one" },
    ]})
    expect(code.indexOf('phase("First")')).toBeLessThan(code.indexOf('phase("Second")'))
    expect(code).toContain("const step1 = await agent(")
    expect(code).toContain("const step2 = await agent(")
    expect(code).toContain("return { step1, step2 }")
  })

  test("a stepless agentic workflow still produces a runnable single-agent script", () => {
    const { code } = buildScript({ ...base, steps: [], agent_prompt: "do the thing" })
    expect(code).toContain('phase("Run")')
    expect(code).toContain("return { result }")
  })

  test("script_content is commented, never wrapped in agent()", () => {
    const { code, untranslated } = buildScript({ ...base, execution_mode: "code", script_content: "rm -rf /tmp/x", steps: [] })
    expect(code).toContain("/* Original script_content")
    expect(code).not.toContain("agent(`rm -rf")
    expect(untranslated.some((u) => u.startsWith("script_content"))).toBe(true)
  })

  test("names what did not survive rather than dropping it quietly", () => {
    const { untranslated } = buildScript({ ...base, steps: [], require_human_approval: true, allowed_tools: ["a", "b"], max_iterations: 7 })
    expect(untranslated.join(" ")).toContain("require_human_approval")
    expect(untranslated.join(" ")).toContain("allowed_tools")
    expect(untranslated.join(" ")).toContain("max_iterations=7")
  })

  test("a clean workflow reports nothing untranslated", () => {
    expect(buildScript({ ...base, steps: [{ name: "s", order: 1, prompt: "p" }] }).untranslated).toEqual([])
  })

  test("a prompt full of backticks still yields a parseable body", () => {
    const { code } = buildScript({ ...base, steps: [{ name: "s", order: 1, prompt: "use `cmd` and ${x}" }] })
    const body = code.slice(code.indexOf("phase("))
    expect(() => new Function(`return (async () => {\n${body}\n})`)).not.toThrow()
  })
})

describe("scopedTools", () => {
  test("merges every storage location, dedupes, sorts", () => {
    expect(scopedTools({ allowed_tools: ["b"], settings: { allowed_tools: ["a"] }, agent_config: { tools: [{ type: "c" }] } })).toEqual(["a", "b", "c"])
  })
  test("empty when nothing is scoped", () => {
    expect(scopedTools({})).toEqual([])
  })
})

describe("slugify", () => {
  test("handles em-dashes and punctuation", () => {
    expect(slugify("Good Deals — Daily Deal Aggregator")).toBe("good-deals-daily-deal-aggregator")
  })
  test("never returns empty", () => {
    expect(slugify("!!!")).toBe("workflow")
  })
})
