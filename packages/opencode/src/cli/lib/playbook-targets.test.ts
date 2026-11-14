import { describe, expect, test } from "bun:test"
import { GENERATED_MARKER, detectTargets, isGenerated, parseTargets, resolveTargets, toCursorRule, upsertAgentsBlock, upsertPlaybookSection } from "./playbook-targets"

const replica = `---\nname: "deploy"\ndescription: "Ship it: safely"\n---\n\n${GENERATED_MARKER}\n\n> Run this playbook: \`iris playbook run deploy\`\n# Deploy\n\nDo the thing.\n`

describe("parseTargets", () => {
  test("default is claude only — existing behaviour unchanged", () => {
    expect(parseTargets(undefined)).toEqual(["claude"])
  })
  test("lists and all — gemini is a first-class target (#190526)", () => {
    expect(parseTargets("cursor, agents")).toEqual(["cursor", "agents"])
    expect(parseTargets("gemini")).toEqual(["gemini"])
    expect(parseTargets("all")).toEqual(["claude", "cursor", "agents", "gemini"])
  })
  test("an unknown target is an error, not silently skipped", () => {
    expect(() => parseTargets("cursor,vscode")).toThrow(/vscode/)
  })
})

describe("resolveTargets", () => {
  const opts = { home: "/home/u", cwd: "/repo" }
  test("an explicit target is unchanged and does not probe the disk", () => {
    expect(resolveTargets("gemini", { ...opts, exists: () => false })).toEqual(["gemini"])
  })
  test("auto adds what is installed, and never returns an empty list", () => {
    const exists = (p: string) => p === "/home/u/.codex" || p === "/repo/GEMINI.md"
    expect(resolveTargets("auto", { ...opts, exists })).toEqual(["agents", "gemini"])
    expect(resolveTargets("auto", { ...opts, exists: () => false })).toEqual(["claude"])
  })
  test("auto can be combined with an explicit target without duplicating it", () => {
    const exists = (p: string) => p === "/home/u/.codex"
    expect(resolveTargets("agents,auto", { ...opts, exists })).toEqual(["agents"])
    expect(resolveTargets("claude,auto", { ...opts, exists })).toEqual(["claude", "agents"])
  })
})

describe("detectTargets", () => {
  test("finds home-level Codex and Gemini, project-level Cursor and AGENTS.md", () => {
    const exists = (p: string) =>
      ["/home/u/.codex", "/home/u/.gemini", "/repo/.cursor", "/repo/AGENTS.md"].includes(p)
    expect(detectTargets({ home: "/home/u", cwd: "/repo", exists })).toEqual(["cursor", "agents", "gemini"])
  })
  test("nothing installed still means Claude, the historical default", () => {
    expect(detectTargets({ home: "/home/u", cwd: "/repo", exists: () => false })).toEqual(["claude"])
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

describe("upsertPlaybookSection", () => {
  const deploy = { name: "deploy", description: "Ship it: safely", readPath: "/home/u/.iris/playbooks/deploy/PLAYBOOK.md" }
  test("creates a section that says how to run it and where the full text lives", () => {
    const out = upsertPlaybookSection(null, deploy)
    expect(out).toContain("## Playbook: deploy")
    expect(out).toContain("Ship it: safely")
    expect(out).toContain("iris playbook run deploy")
    expect(out).toContain(deploy.readPath)
  })
  test("a second install is additive — the first playbook is not erased", () => {
    const one = upsertPlaybookSection(null, deploy)
    const two = upsertPlaybookSection(one, { name: "audit", description: "Check it" })
    expect(two).toContain("## Playbook: deploy")
    expect(two).toContain("## Playbook: audit")
  })
  test("re-installing rewrites only its own section, idempotently", () => {
    const one = upsertPlaybookSection("# Mine\n", deploy)
    const twice = upsertPlaybookSection(one, deploy)
    expect(twice).toBe(one)
    expect(twice.startsWith("# Mine")).toBe(true)
  })
  test("a hand-written file keeps everything outside the markers", () => {
    const mine = "# Rules\n\nNever push to main.\n"
    const out = upsertPlaybookSection(mine, deploy)
    expect(out.startsWith(mine.trimEnd())).toBe(true)
  })
})
