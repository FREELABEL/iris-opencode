import { describe, expect, test } from "bun:test"
import { buildCommandReport, commandHead, redact, tailLines } from "./bug-report"

describe("redact", () => {
  test.each([
    ["curl -H 'Authorization: Bearer abc.def.ghi123456'", "abc.def.ghi123456"],
    ["OPENAI_API_KEY=sk-proj-abcdefghijklmnop iris run", "sk-proj-abcdefghijklmnop"],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstu", "ghp_abcdefghijklmnopqrstu"],
    ["iris login --token supersecretvalue123", "supersecretvalue123"],
    ["git clone https://user:hunter2@github.com/x/y", "hunter2"],
    ["node_live_abcdef123456 heartbeat", "node_live_abcdef123456"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "eyJhbGciOiJIUzI1NiJ9"],
    ["xoxb-1234567890-abcdefghij slack", "xoxb-1234567890-abcdefghij"],
  ])("removes the secret in %s", (input, secret) => {
    expect(redact(input)).not.toContain(secret)
  })

  test("leaves ordinary commands alone", () => {
    expect(redact("grep -rn foo src/ && bun test")).toBe("grep -rn foo src/ && bun test")
  })
})

describe("commandHead", () => {
  test("names the tool, never its arguments", () => {
    expect(commandHead("iris agents list --json")).toBe("iris agents")
    expect(commandHead("mkdir -p ~/.config/opencode/agents")).toBe("mkdir")
    expect(commandHead("API_KEY=x bun test src")).toBe("bun test")
    expect(commandHead("   ")).toBe("command")
  })
})

describe("buildCommandReport", () => {
  test("titles by the command head and keeps only the last 40 lines of output", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const r = buildCommandReport({ tool: "bash", command: "iris agents list --json", error: "exit 1", output }, "1.18.test")
    expect(r.title).toBe("Desktop: `iris agents` failed (exit 1)")
    expect(r.description).toContain("line 99")
    expect(r.description).not.toContain("line 59\n")
    expect(r.description).toContain("1.18.test")
  })

  test("scrubs secrets from every field it sends", () => {
    const r = buildCommandReport({ tool: "bash", command: "TOKEN=abc123secret iris x", error: "exit 2", output: "Bearer abcdefghijklmnopq", note: "used sk-abcdefghijklmnopqr" }, "v")
    for (const s of ["abc123secret", "abcdefghijklmnopq", "sk-abcdefghijklmnopqr"]) expect(JSON.stringify(r)).not.toContain(s)
  })
})

describe("tailLines", () => {
  test("keeps the end", () => expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc"))
})
