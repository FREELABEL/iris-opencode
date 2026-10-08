import { describe, expect, test } from "bun:test"
import { readTemplate, setupHint } from "./platform-hive-trigger"

describe("iris hive trigger (#188301)", () => {
  test("a template is a file when one exists at that path, otherwise the text itself", () => {
    expect(readTemplate("triage.md", (p) => p === "triage.md", () => "From the file: {{issue.title}}")).toBe("From the file: {{issue.title}}")
    expect(readTemplate("Triage {{issue.title}}", () => false)).toBe("Triage {{issue.title}}")
    expect(readTemplate("   ")).toBeNull()
  })
  test("GitHub setup names the payload URL, JSON content type and the ping", () => {
    const h = setupHint("github", "https://x/api/v1/hooks/trg_1").join("\n")
    expect(h).toContain("https://x/api/v1/hooks/trg_1")
    expect(h).toContain("application/json")
    expect(h).toContain("ping")
  })
  test("generic setup says exactly how to sign", () => {
    expect(setupHint("generic-sha256", "u").join("\n")).toContain("X-Signature-256: sha256=")
  })
})
