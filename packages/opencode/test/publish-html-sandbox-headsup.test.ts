import { describe, expect, test } from "bun:test"
import { formatSandboxReport } from "../src/cli/cmd/platform-pages"

/**
 * `iris genesis publish-html` prints the heads-up fl-api returns (`data.sandbox`) when a page
 * will be served in a browser sandbox: what the sandbox blocks, the line, and the fix — and a
 * note when a page is flagged for review (#185942).
 */
describe("formatSandboxReport", () => {
  test("a trusted page, or no report at all, prints nothing", () => {
    expect(formatSandboxReport(undefined)).toEqual([])
    expect(formatSandboxReport({ sandboxed: false, findings: [] })).toEqual([])
  })

  test("a clean sandboxed page says so, and says nothing is wrong", () => {
    const out = formatSandboxReport({ sandboxed: true, findings: [] })
    expect(out[0]).toContain("browser sandbox")
    expect(out.join("\n")).toContain("Nothing in it uses what the sandbox blocks")
  })

  test("each finding shows its message, where it is, and the fix", () => {
    const out = formatSandboxReport({
      sandboxed: true,
      findings: [
        { code: "browser_storage", severity: "warning", message: "localStorage is blocked.", fix: "Keep state in page variables.", count: 3, line: 42 },
      ],
    }).join("\n")
    expect(out).toContain("localStorage is blocked. (line 42, 3 places)")
    expect(out).toContain("→ Keep state in page variables.")
    expect(out).not.toContain("reviewed by the IRIS team")
  })

  test("a review finding tells the author the page will be reviewed", () => {
    const out = formatSandboxReport({
      sandboxed: true,
      findings: [{ code: "password_field", severity: "review", message: "This page asks for a password.", fix: "Remove it.", count: 1, line: 7 }],
    }).join("\n")
    expect(out).toContain("⚑ This page asks for a password. (line 7)")
    expect(out).toContain("reviewed by the IRIS team")
  })

  test("a finding with no line (bindings) prints no line reference", () => {
    const out = formatSandboxReport({
      sandboxed: true,
      findings: [{ code: "bindings_public_only", severity: "info", message: "Only public datasets bind.", fix: "Make it public.", count: 1, line: 0 }],
    }).join("\n")
    expect(out).toContain("i Only public datasets bind.")
    expect(out).not.toContain("(line")
  })
})

describe("publish-html prints it", () => {
  const SRC = Bun.file(new URL("../src/cli/cmd/platform-pages.ts", import.meta.url).pathname).text()
  test("both save paths capture the report, and the handler prints it", async () => {
    const src = await SRC
    const start = src.indexOf('command: "publish-html')
    const body = src.slice(start, src.indexOf("\n})\n", start))
    expect(body).toContain("sandboxReport = page.sandbox") // create path
    expect(body).toContain("?.data?.sandbox") // update path
    expect(body).toContain("formatSandboxReport(sandboxReport)")
  })
})
