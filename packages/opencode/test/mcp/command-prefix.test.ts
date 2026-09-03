import { describe, expect, test } from "bun:test"
import { validateCommand } from "../../src/cli/cmd/mcp-serve"

/**
 * The MCP spawns the iris binary directly with the argv it is handed, so a command
 * string that includes the binary name puts "iris" in argv[0] — where a subcommand
 * belongs — and the call fails with `Unknown command "iris"`.
 *
 * Observed in production 2026-08-17: the model was asked to fetch projects, wrote
 * `iris bloqs list --json` exactly as a human would type it, got that error, and then
 * told the user it could not access the IRIS platform at all. The tool taught the
 * model to report a capability it actually had.
 *
 * These tests pin BOTH forms working, because the alternative is re-teaching an
 * arbitrary convention to every new model — and the default model changed three times
 * in two days.
 */
describe("validateCommand — binary-name prefix", () => {
  test("accepts the bare form the MCP has always wanted", () => {
    const r = validateCommand("bloqs list --json")
    expect(r.error).toBeUndefined()
    expect(r.args).toEqual(["bloqs", "list", "--json"])
  })

  test("accepts the form a model naturally writes, with the binary name", () => {
    const r = validateCommand("iris bloqs list --json")
    expect(r.error).toBeUndefined()
    expect(r.args).toEqual(["bloqs", "list", "--json"])
  })

  test("strips the prefix for a plain two-word command too", () => {
    const r = validateCommand("iris agents list")
    expect(r.error).toBeUndefined()
    expect(r.args).toEqual(["agents", "list"])
  })

  test("stripping does not swallow the real command name", () => {
    // The unknown-command guard is gated on `knownCommands.size > 0`, and the command
    // registry is not loaded in a unit context — so that guard is INERT here and this
    // cannot assert rejection. (Asserting it anyway is how a test claims to cover
    // something it never exercises; the first draft of this file did exactly that.)
    //
    // What IS unconditional, and what actually matters: after stripping, argv[0] must
    // be the user's real subcommand, so whatever validation runs downstream sees the
    // right token rather than "iris".
    expect(validateCommand("iris definitelynotacommand --flag").args[0]).toBe("definitelynotacommand")
    expect(validateCommand("definitelynotacommand --flag").args[0]).toBe("definitelynotacommand")
  })

  test("does not strip a bare `iris` with nothing after it", () => {
    // "iris" alone carries no subcommand; shifting it would leave an empty argv and
    // turn a clear error into a confusing one.
    const r = validateCommand("iris")
    expect(r.args).not.toEqual([])
  })

  test("does not mangle an argument that merely contains the word iris", () => {
    // `iris` appearing as a VALUE must survive — only argv[0] is a binary name.
    const r = validateCommand('bloqs add-item 503 1449 "iris is the product"')
    expect(r.error).toBeUndefined()
    expect(r.args[0]).toBe("bloqs")
    expect(r.args).toContain("iris is the product")
  })

  test("preserves quoted multi-word arguments after stripping", () => {
    const r = validateCommand('iris agents create --name "My Agent" --prompt "do X; then Y"')
    expect(r.error).toBeUndefined()
    expect(r.args[0]).toBe("agents")
    expect(r.args).toContain("My Agent")
    expect(r.args).toContain("do X; then Y")
  })
})
