import { describe, test, expect } from "bun:test"
import { validateCommand } from "./mcp-serve"

describe("validateCommand", () => {
  // --- Should PASS: safe characters in quoted args ---

  test("ampersand in quoted arg", () => {
    const result = validateCommand('leads note 21649 "R&D partnership meeting"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "R&D partnership meeting"])
  })

  test("dollar sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Deal worth $50k"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Deal worth $50k"])
  })

  test("exclamation mark in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Great news!"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Great news!"])
  })

  test("question mark in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Can we meet tomorrow?"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Can we meet tomorrow?"])
  })

  test("parentheses in quoted arg", () => {
    const result = validateCommand('leads note 21649 "PILMA Summit (May 20-22)"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "PILMA Summit (May 20-22)"])
  })

  test("curly braces in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Vanguard {HCS} partnership"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Vanguard {HCS} partnership"])
  })

  test("hash and at-sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Contact @alex re: issue #42"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Contact @alex re: issue #42"])
  })

  test("percent sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Revenue up 30% this quarter"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Revenue up 30% this quarter"])
  })

  test("all safe special chars combined", () => {
    const result = validateCommand('leads note 21649 "R&D $50k! 30% @alex #42 (yes) {ok}?"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "R&D $50k! 30% @alex #42 (yes) {ok}?"])
  })

  test("em dash and en dash", () => {
    const result = validateCommand('leads note 21649 "Phase 1 — complete, tasks 3\u20135 pending"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("—")
  })

  // --- Shell metacharacters are ALLOWED: args go to Bun.spawn (argv array, no
  //     shell), so ; | ` < > \ and newlines are inert literals, not injection
  //     vectors. Blocking them broke legitimate prose + multi-line prompts. ---

  test("allows semicolon (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "do X; then Y"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toBe("do X; then Y")
  })

  test("allows pipe (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "revenue | margin breakdown"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("|")
  })

  test("allows backtick (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "the `hello` handler"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("`")
  })

  test("allows redirect < >", () => {
    const result = validateCommand('leads note 21649 "compare A < B > C"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("<")
    expect(result.args[3]).toContain(">")
  })

  test("allows backslash", () => {
    const result = validateCommand('leads note 21649 "path C\\\\temp is fine"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("\\")
  })

  test("allows newline in arg (multi-line agent prompt)", () => {
    const result = validateCommand('agents create --prompt "You are a helper.\nRULES:\n- be kind"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("\n")
  })

  // --- Still REJECT: a NUL byte can truncate an argv string at the syscall ---

  test("rejects NUL byte", () => {
    const result = validateCommand('leads note 21649 "hello\0world"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("NUL")
  })

  // --- Parsing edge cases ---

  test("empty command", () => {
    const result = validateCommand("")
    expect(result.error).toBe("Empty command")
  })

  test("whitespace-only command", () => {
    const result = validateCommand("   ")
    expect(result.error).toBe("Empty command")
  })

  test("simple unquoted args", () => {
    const result = validateCommand("leads list --limit 5 --json")
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "list", "--limit", "5", "--json"])
  })

  test("single-quoted string", () => {
    const result = validateCommand("leads note 21649 'single quoted note'")
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "single quoted note"])
  })

  test("mixed quote styles preserves inner quotes", () => {
    const result = validateCommand(`leads note 21649 "double 'inner' quotes"`)
    expect(result.error).toBeUndefined()
    // Inner single quotes inside double-quoted string are literal chars, not delimiters
    expect(result.args[3]).toBe("double 'inner' quotes")
  })
})
