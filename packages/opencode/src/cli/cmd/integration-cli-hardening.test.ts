import { describe, expect, test } from "bun:test"
import { probeExitCode } from "./integration-health"
import { summarizeUpstreamError } from "./platform-run"

/**
 * Two integration defects measured 2026-10-22 (#190575, #190576).
 *
 *   `iris integrations test nosuchintegration12345` printed "No ... connection on this
 *   account." and exited 0, while a genuine failure exited 1. A CI loop over a list of
 *   integrations therefore reported success for every typo — the one case where "no such
 *   thing" and "it works" must not look alike.
 *
 *   A request blocked by Cloudflare printed the entire block page into the terminal:
 *   `Composio action failed: <!DOCTYPE html> ... <title>Attention Required! | Cloudflare`.
 *   The request being refused is correct; handing the operator a page of markup is not.
 */

describe("a probe that could not answer is not a pass", () => {
  test("a type with no connection exits non-zero", () => {
    expect(probeExitCode({ notConnected: true, failure: null, rows: null })).toBe(1)
  })

  test("a probe that could not complete exits non-zero", () => {
    expect(probeExitCode({ notConnected: false, failure: "HTTP 502", rows: null })).toBe(1)
  })

  test("a failing connection exits non-zero", () => {
    expect(
      probeExitCode({
        notConnected: false,
        failure: null,
        rows: [{ id: 1, type: "gmail", status: "active", state: "failing" } as any],
      }),
    ).toBe(1)
  })

  test("a working connection exits zero", () => {
    expect(
      probeExitCode({
        notConnected: false,
        failure: null,
        rows: [{ id: 1, type: "gmail", status: "active", state: "working" } as any],
      }),
    ).toBe(0)
  })

  test("never-checked is not a failure — it is an honest zero", () => {
    expect(
      probeExitCode({
        notConnected: false,
        failure: null,
        rows: [{ id: 1, type: "gmail", status: "active", state: "never_checked" } as any],
      }),
    ).toBe(0)
  })
})

describe("an HTML error is summarised, not printed", () => {
  const cloudflare =
    '<!DOCTYPE html><html class="no-js"><head><title>Attention Required! | Cloudflare</title></head>' +
    "<body><h1>Attention Required!</h1><p>Ray ID: 8a1b2c3d4e5f6</p></body></html>"

  test("a Cloudflare block page becomes one line with the Ray ID", () => {
    const out = summarizeUpstreamError(`Composio action failed: ${cloudflare}`)
    expect(out.toLowerCase()).toContain("cloudflare")
    expect(out).toContain("8a1b2c3d4e5f6")
    expect(out).not.toContain("<")
    expect(out).not.toContain("DOCTYPE")
  })

  test("the summary says the request did not run", () => {
    expect(summarizeUpstreamError(cloudflare).toLowerCase()).toContain("not")
  })

  test("an ordinary upstream error is left alone", () => {
    const plain = "Tool GMAIL_FETCH_EMAILS not found"
    expect(summarizeUpstreamError(plain)).toBe(plain)
  })

  test("a JSON error body is not rewritten as HTML", () => {
    const json = 'Composio action failed: {"slug":"Upstream_PayloadTooLarge","status":413}'
    expect(summarizeUpstreamError(json)).toBe(json)
  })
})
