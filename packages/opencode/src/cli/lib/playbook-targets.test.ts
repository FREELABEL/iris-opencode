import { describe, expect, test } from "bun:test"
import { GENERATED_MARKER, isGenerated, parseTargets, toCursorRule, upsertAgentsBlock } from "./playbook-targets"

const replica = `---\nname: "deploy"\ndescription: "Ship it: safely"\n---\n\n${GENERATED_MARKER}\n\n> Run this playbook: \`iris playbook run deploy\`\n# Deploy\n\nDo the thing.\n`

describe("parseTargets", () => {
  test("default is claude only — existing behaviour unchanged", () => {
    expect(parseTargets(undefined)).toEqual(["claude"])
  })
  test("lists and all", () => {
    expect(parseTargets("cursor, agents")).toEqual(["cursor", "agents"])
    expect(parseTargets("all")).toEqual(["claude", "cursor", "agents"])
  })
  test("an unknown target is an error, not silently skipped", () => {
    expect(() => parseTargets("cursor,vscode")).toThrow(/vscode/)
  })
})

describe("toCursorRule", () => {
  const rule = toCursorRule(replica, "Ship it: safely")
  test("is an agent-requested Cursor rule with a YAML-safe description", () => {
    expect(rule.startsWith('---\ndescription: "Ship it: safely"\nalwaysApply: false\n---\n')).toBe(true)
  })
  test("carries the playbook body once, and none of the Claude frontmatter", () => {
    expect(rule).toContain("Do the thing.")
    expect(rule).not.toContain('name: "deploy"')
    expect(rule.split(GENERATED_MARKER).length).toBe(2)
  })
})

describe("isGenerated", () => {
  test("never overwrites a hand-written rule", () => {
    expect(isGenerated(null)).toBe(true)
    expect(isGenerated(`x ${GENERATED_MARKER}`)).toBe(true)
    expect(isGenerated("---\ndescription: mine\n---\nmy rule")).toBe(false)
  })
})

describe("upsertAgentsBlock", () => {
  const entries = [{ name: "zeta", description: "last" }, { name: "alpha", description: "first\nline" }]
  test("creates the block in a repo with no AGENTS.md", () => {
    const out = upsertAgentsBlock(null, entries)
    expect(out.indexOf("**alpha**")).toBeLessThan(out.indexOf("**zeta**"))
    expect(out).toContain("- **alpha** — first line")
  })
  test("appends to a hand-written AGENTS.md without touching it", () => {
    const mine = "# Rules\n\nNever push to main.\n"
    const out = upsertAgentsBlock(mine, entries)
    expect(out.startsWith(mine.trimEnd())).toBe(true)
  })
  test("re-running replaces only its own block — idempotent, hand-written text kept on both sides", () => {
    const once = upsertAgentsBlock("# Top\n", entries) + "\n# Bottom\n"
    const twice = upsertAgentsBlock(once, [{ name: "only", description: "one" }])
    expect(twice).toContain("# Top")
    expect(twice).toContain("# Bottom")
    expect(twice).toContain("**only**")
    expect(twice).not.toContain("**zeta**")
    expect(upsertAgentsBlock(twice, [{ name: "only", description: "one" }])).toBe(twice)
  })
})
