import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  TIERS,
  tierRank,
  isOpen,
  isWidening,
  confirmWiden,
  confirmOverwrite,
  consequenceLines,
  type Tier,
} from "./exposure-gate"

/**
 * #182344 / #182345 — the direction of the guard.
 *
 * `genesis visibility` shipped with its confirmation on the RESTRICTING branch:
 *
 *     const restricting = mode !== "public" && reachFor(current.mode).slug
 *     if (restricting) { warn; confirm }
 *
 * So closing a door asked, and opening one did not. That is inverted against
 * consequence — narrowing is recoverable, widening is not.
 *
 * The tests below exist to make re-inverting it FAIL rather than ship. If someone
 * later "simplifies" the gate and narrowing starts prompting, or widening stops,
 * this file goes red.
 *
 * All of these run with no TTY (bun test), which is why the widening cases assert
 * `needs-force` — that is the agent path, and it is the one that has to refuse.
 */

// The gate reads isNonInteractive(), which honours these. Tests own them explicitly
// rather than depending on how the runner happens to be invoked.
const ENV = "IRIS_NON_INTERACTIVE"
let saved: string | undefined
beforeEach(() => {
  saved = process.env[ENV]
  process.env[ENV] = "1"
})
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

const req = (from: Tier | null, to: Tier, extra: Record<string, unknown> = {}) => ({
  noun: "page",
  name: "some-slug",
  from,
  to,
  ...extra,
})

describe("the ladder", () => {
  test("is ordered least reachable to most", () => {
    expect([...TIERS]).toEqual(["private", "team", "gated", "unlisted", "public"])
    expect(tierRank("private")).toBeLessThan(tierRank("team"))
    expect(tierRank("team")).toBeLessThan(tierRank("gated"))
    expect(tierRank("gated")).toBeLessThan(tierRank("unlisted"))
    expect(tierRank("unlisted")).toBeLessThan(tierRank("public"))
  })

  test("the open line sits between gated and unlisted — identity vs a bare URL", () => {
    expect(isOpen("private")).toBe(false)
    expect(isOpen("team")).toBe(false)
    expect(isOpen("gated")).toBe(false)
    expect(isOpen("unlisted")).toBe(true)
    expect(isOpen("public")).toBe(true)
  })

  test("an unknown current tier is treated as private, so we err toward asking", () => {
    expect(isWidening(null, "gated")).toBe(true)
    expect(isWidening(undefined, "team")).toBe(true)
  })
})

describe("NARROWING never asks", () => {
  // If any of these start prompting, the guard has been re-inverted.
  const narrowings: Array<[Tier, Tier]> = [
    ["public", "unlisted"],
    ["public", "gated"],
    ["public", "private"],
    ["unlisted", "gated"],
    ["unlisted", "private"],
    ["gated", "team"],
    ["team", "private"],
  ]

  for (const [from, to] of narrowings) {
    test(`${from} → ${to} proceeds with no prompt and no force`, async () => {
      expect(isWidening(from, to)).toBe(false)
      const v = await confirmWiden(req(from, to))
      expect(v).toEqual({ ok: true, prompted: false })
    })
  }

  test("a no-op is not a widening", async () => {
    const v = await confirmWiden(req("public", "public"))
    expect(v).toEqual({ ok: true, prompted: false })
  })
})

describe("WIDENING always confirms", () => {
  const widenings: Array<[Tier, Tier]> = [
    ["private", "team"],
    ["private", "gated"],
    ["private", "unlisted"],
    ["private", "public"],
    ["team", "gated"],
    ["gated", "unlisted"],
    ["unlisted", "public"],
  ]

  for (const [from, to] of widenings) {
    test(`${from} → ${to} refuses without a terminal`, async () => {
      expect(isWidening(from, to)).toBe(true)
      const v = await confirmWiden(req(from, to))
      expect(v).toEqual({ ok: false, reason: "needs-force" })
    })
  }

  test("--force is what gets you through, and it is explicit", async () => {
    const v = await confirmWiden(req("private", "public", { force: true }))
    expect(v).toEqual({ ok: true, prompted: false })
  })

  test("a legacy --yes still counts as consent", async () => {
    const v = await confirmWiden(req("private", "public", { yes: true }))
    expect(v.ok).toBe(true)
  })

  test("no terminal is a REFUSAL, not a skip — the agent path is the hard one", async () => {
    // The original bug was `if (!args.yes && !isNonInteractive())`, which let a
    // headless caller straight through. Pin the opposite.
    const v = await confirmWiden(req("private", "public"))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe("needs-force")
  })
})

describe("the consequence is stated in plain language", () => {
  test("public names the open internet and the fact it cannot be undone", () => {
    const l = consequenceLines(req("private", "public")).join(" ")
    expect(l).toContain("open internet")
    expect(l).toMatch(/does not un-send/i)
  })

  test("unlisted is honest that a link is not protection", () => {
    const l = consequenceLines(req("private", "unlisted")).join(" ")
    expect(l).toMatch(/NOT protected/i)
  })

  test("gated does not claim internet exposure it does not cause", () => {
    const l = consequenceLines(req("private", "gated")).join(" ")
    expect(l).not.toContain("open internet")
  })

  test("the urls that become reachable are named, not summarised", () => {
    const l = consequenceLines(req("private", "public", { urls: ["https://x/p/a"] }))
    expect(l.some((s) => s.includes("https://x/p/a"))).toBe(true)
  })
})

describe("overwrite blast radius — the other axis", () => {
  test("nothing uses it, nothing to warn about", async () => {
    const v = await confirmOverwrite({ noun: "component", name: "c", usageCount: 0 })
    expect(v).toEqual({ ok: true, prompted: false })
  })

  test("pages depend on it → refuses without a terminal", async () => {
    const v = await confirmOverwrite({
      noun: "component",
      name: "session-list",
      usageCount: 2,
      usedBy: ["atlas-console", "workspace"],
    })
    expect(v).toEqual({ ok: false, reason: "needs-force" })
  })

  test("--force carries through here too", async () => {
    const v = await confirmOverwrite({ noun: "component", name: "c", usageCount: 9, force: true })
    expect(v.ok).toBe(true)
  })
})
