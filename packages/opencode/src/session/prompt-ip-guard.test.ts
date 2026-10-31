import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { createHash } from "crypto"

/**
 * IP-07 (#189850) — the GUARD that stops proprietary prompt text drifting back into
 * the public repo (and from there into the public binary).
 *
 * The IRIS-authored versions of these prompts are served by the private API
 * (`GET /api/v1/cli/prompts`). What ships here is the upstream opencode v1.1.3 text,
 * byte for byte (MIT). If you need to change what IRIS says, change it SERVER-SIDE.
 *
 * Hashes computed from
 *   https://raw.githubusercontent.com/anomalyco/opencode/v1.1.3/packages/opencode/src/session/prompt/<name>.txt
 */
const UPSTREAM_V1_1_3_SHA256: Record<string, string> = {
  "anthropic.txt": "ea3a641c302a840fb8eb70485c420300ad2d1b24d03867131a9141b723875f91",
  "qwen.txt": "dba14c96ffc6a7d4c69b0b17b5d1fe0237973cc2f346c507cbb25939f80106cc",
  "beast.txt": "f375b4c013cdd8e549591cb7a935b9dd06c835148acfb05fbf463552802bfa3f",
  "copilot-gpt-5.txt": "61352b83ce47d5c35efe0db9902e218f4f2c8310b1957d7e9291135ae7df38cb",
  "gemini.txt": "921750803b0314b88b8adc996e2afcf1a61fd7d9dd6dfcf812baeadac1468cf3",
}

/**
 * Strings our IRIS edits introduced into the prompts (found by diffing our versions against
 * upstream v1.1.3). None of them occur in any upstream prompt file. Case-sensitive on purpose:
 * "IRIS" in caps is ours; upstream never says it.
 */
const IRIS_MARKERS = ["heyiris", "IRIS", "FREELABEL", "iris-opencode", ".iris/how-to", "iris --help"]

const SESSION_PROMPTS = path.join(import.meta.dir, "prompt")
const AGENT_PROMPTS = path.join(import.meta.dir, "..", "agent", "prompt")

function listPromptFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => path.join(dir, f))
}

describe("shipped prompt fallbacks carry no IRIS-authored text (IP-07 #189850)", () => {
  for (const [name, sha] of Object.entries(UPSTREAM_V1_1_3_SHA256)) {
    test(`${name} is byte-identical to upstream opencode v1.1.3`, () => {
      const bytes = fs.readFileSync(path.join(SESSION_PROMPTS, name))
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha)
    })
  }

  test("no file under session/prompt or agent/prompt contains an IRIS marker", () => {
    const files = [...listPromptFiles(SESSION_PROMPTS), ...listPromptFiles(AGENT_PROMPTS)]
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      for (const marker of IRIS_MARKERS) {
        if (text.includes(marker)) hits.push(`${path.relative(import.meta.dir, file)}: ${marker}`)
      }
    }
    expect(hits).toEqual([])
  })

  test("system.ts ships only a neutral one-line identity fallback", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "system.ts"), "utf8")
    for (const marker of ["heyiris", "iris-daemon", "iris platform-", "iris mcp serve"]) {
      expect(src).not.toContain(marker)
    }
  })
})
