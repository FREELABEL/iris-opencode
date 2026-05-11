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

  // --- Should REJECT: dangerous injection vectors ---

  test("rejects semicolon (command chaining)", () => {
    const result = validateCommand('leads note 21649 "hello; rm -rf /"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects pipe (command chaining)", () => {
    const result = validateCommand('leads note 21649 "hello | cat /etc/passwd"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects backtick (command substitution)", () => {
    const result = validateCommand('leads note 21649 "hello `whoami`"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects redirect <", () => {
    const result = validateCommand('leads note 21649 "hello < /etc/passwd"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects redirect >", () => {
    const result = validateCommand('leads note 21649 "hello > /tmp/pwned"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects backslash (escape sequences)", () => {
    const result = validateCommand('leads note 21649 "hello\\nworld"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
  })

  test("rejects newline in arg", () => {
    const result = validateCommand('leads note 21649 "hello\nworld"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("metacharacter")
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
