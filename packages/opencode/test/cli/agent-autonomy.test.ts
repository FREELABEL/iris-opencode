import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  AUTONOMY_CHOICES,
  AUTONOMY_LEVELS,
  CLI_DEFAULT_AUTONOMY,
  describeAutonomy,
  parseAutonomy,
} from "../../src/cli/cmd/agent-autonomy"

// #187906 — the agent's trust level (config.autonomy). Mirrors fl-iris-api AgentTrustLevel.
describe("agent autonomy (#187906)", () => {
  test("the levels and the CLI default match the server", () => {
    expect([...AUTONOMY_LEVELS]).toEqual(["intern", "specialist", "lead"])
    expect(CLI_DEFAULT_AUTONOMY).toBe("specialist")
    expect([...AUTONOMY_CHOICES]).toEqual(["intern", "specialist", "lead", "none"])
  })

  test("parseAutonomy normalises a level, clears on none/empty, refuses anything else", () => {
    expect(parseAutonomy(" Lead ")).toBe("lead")
    expect(parseAutonomy("none")).toBeNull()
    expect(parseAutonomy("")).toBeNull()
    expect(parseAutonomy(undefined)).toBeNull()
    for (const bad of ["boss", "autonomous", "gated", 3]) {
      expect(() => parseAutonomy(bad)).toThrow(/intern, specialist, lead, none/)
    }
  })

  test("describeAutonomy reads the way the server reads", () => {
    // Missing → not set, which means "as before" — not full trust, not no trust.
    expect(describeAutonomy({}).level).toBeNull()
    expect(describeAutonomy({}).label).toContain("not set")
    expect(describeAutonomy(null).level).toBeNull()
    expect(describeAutonomy(["legacy", "list"]).level).toBeNull()
    expect(describeAutonomy({ autonomy: "Specialist" })).toEqual({
      level: "specialist",
      label: "specialist — works in its own space; holds shared writes, sends and payments",
    })
    expect(describeAutonomy({ autonomy: "lead" }).label).toContain("payments only")
    // Unknown stored value → intern, flagged — never full trust.
    const typo = describeAutonomy({ autonomy: "boss" })
    expect(typo.level).toBe("intern")
    expect(typo.label).toContain("not a level")
  })

  test("agents get / create / update are wired to it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-agents.ts"), "utf8")
    expect(src).toContain('printKV("Autonomy", describeAutonomy(a.config).label)')
    expect(src).toContain("config.autonomy = (args.autonomy as string | undefined) ?? CLI_DEFAULT_AUTONOMY")
    expect(src).toContain("choices: [...AUTONOMY_CHOICES]")
  })
})
