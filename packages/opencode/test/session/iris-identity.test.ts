import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// IRIS Desktop's base prompts introduced the agent as "OpenCode", so a person who asked who
// they were talking to was told a name they had never seen. Every per-model prompt must
// introduce IRIS. (The model proxy adds an IRIS block server-side too; this is the source.)
const dir = path.join(import.meta.dir, "../../src/session/prompt")

test("no base prompt introduces the agent as OpenCode", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".txt"))
  expect(files.length).toBeGreaterThan(5)
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), "utf8")
    expect(text, f).not.toMatch(/you are opencode|your name is opencode/i)
    expect(text, f).not.toContain("github.com/anomalyco/opencode")
  }
})

test("the per-model prompts introduce IRIS", () => {
  for (const f of ["anthropic", "beast", "codex", "default", "gemini", "gpt", "kimi", "meta", "trinity"]) {
    const first = readFileSync(path.join(dir, `${f}.txt`), "utf8").split("\n")[0]
    expect(first, f).toContain("You are IRIS")
  }
})
