import { describe, test, expect } from "bun:test"
import { resolveDefaultAction, HOWTO_SUBCOMMANDS, HowToCommand } from "../src/cli/cmd/platform-howto"

/**
 * `iris how-to` routing (#178285, #178286).
 *
 * Before: a bare `iris how-to` died with "Not enough non-option arguments" and
 * the plural forms were "Unknown command" — a parent command that refused to do
 * the obvious thing with the word users actually reach for.
 */

describe("bare command defaults to list (#178285)", () => {
  test("no topic, no flag → list", () => {
    expect(resolveDefaultAction(undefined, undefined)).toEqual({ action: "list" })
  })

  test("empty and whitespace-only topics are still 'no topic'", () => {
    expect(resolveDefaultAction("", undefined).action).toBe("list")
    expect(resolveDefaultAction("   ", undefined).action).toBe("list")
  })

  test("a non-string topic does not crash the router", () => {
    expect(resolveDefaultAction(42 as unknown, undefined).action).toBe("list")
    expect(resolveDefaultAction(null, undefined).action).toBe("list")
    expect(resolveDefaultAction({}, undefined).action).toBe("list")
  })
})

describe("a bare topic searches (#178286)", () => {
  test("iris how-to hive → search hive", () => {
    expect(resolveDefaultAction("hive", undefined)).toEqual({ action: "search", query: "hive" })
  })

  test("trims the query", () => {
    expect(resolveDefaultAction("  hive  ", undefined)).toEqual({ action: "search", query: "hive" })
  })

  test("multi-word topics survive intact", () => {
    expect(resolveDefaultAction("lead to proposal", undefined)).toEqual({
      action: "search",
      query: "lead to proposal",
    })
  })
})

describe("--search is explicit and wins", () => {
  test("--search x → search x", () => {
    expect(resolveDefaultAction(undefined, "hive")).toEqual({ action: "search", query: "hive" })
  })

  test("--search beats a positional, so a topic can share a subcommand's name", () => {
    // The documented escape hatch: searching for the literal word "list".
    expect(resolveDefaultAction("hive", "list")).toEqual({ action: "search", query: "list" })
  })

  test("an empty --search falls through rather than searching for nothing", () => {
    expect(resolveDefaultAction("hive", "")).toEqual({ action: "search", query: "hive" })
    expect(resolveDefaultAction(undefined, "   ")).toEqual({ action: "list" })
  })
})

describe("subcommands keep precedence", () => {
  test("a subcommand name never becomes a search term", () => {
    // yargs routes these before $0 is reached; this pins the defensive branch so
    // `how-to list` can never silently search for the word "list".
    for (const name of HOWTO_SUBCOMMANDS) {
      expect(resolveDefaultAction(name, undefined).action).toBe("list")
      expect(resolveDefaultAction(name.toUpperCase(), undefined).action).toBe("list")
    }
  })

  test("the precedence list covers every registered subcommand and alias", () => {
    // If someone adds a subcommand and forgets this list, the defensive branch
    // silently stops protecting it. These are the names the root command
    // registers today.
    for (const name of ["list", "view", "search", "add", "remove"]) {
      expect(HOWTO_SUBCOMMANDS).toContain(name)
    }
    for (const alias of ["ls", "read", "show", "find", "grep", "create", "rm", "delete"]) {
      expect(HOWTO_SUBCOMMANDS).toContain(alias)
    }
  })
})

describe("plural aliases (#178285)", () => {
  test("how-tos and howtos both resolve — users reach for the plural", () => {
    const aliases = (HowToCommand as { aliases?: string[] }).aliases ?? []
    expect(aliases).toContain("how-tos")
    expect(aliases).toContain("howtos")
  })

  test("the original aliases still work", () => {
    const aliases = (HowToCommand as { aliases?: string[] }).aliases ?? []
    expect(aliases).toContain("howto")
    expect(aliases).toContain("recipes")
  })

  test("the root command is still how-to", () => {
    expect((HowToCommand as { command?: string }).command).toBe("how-to")
  })
})
