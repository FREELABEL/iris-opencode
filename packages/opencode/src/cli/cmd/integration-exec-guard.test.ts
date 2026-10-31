import { describe, expect, test } from "bun:test"
import { isFailedResult, validateActionParams, type ActionSignature } from "./platform-run"

/**
 * Two defects measured 2026-10-22 against the live exec path (#190572, #190573):
 *
 *   `exec gmail read_emails totally_bogus=1` completed and returned 10 messages — a typo is
 *   silently ignored, so a wrong parameter looks exactly like a right one.
 *
 *   `exec gmail read_emails limit=999` came back with `error_after_page: Upstream_PayloadTooLarge`
 *   (HTTP 413 from Composio) AND `success: true`, exit 0. A partial result with an upstream
 *   failure on the end of it reads as a success to every script that checks the exit code.
 *
 * The catalogue on the server is the signature; this is the client-side guard that refuses a
 * call it can already prove is wrong instead of spending it upstream.
 */

const gmail: ActionSignature = {
  name: "read_emails",
  description: "Read recent emails",
  writes: false,
  parameters: [
    { name: "limit", type: "integer", required: false, description: "1-50" },
    { name: "unread_only", type: "boolean", required: false, description: "" },
  ],
}

const SYNONYMS = [["limit", "max_results", "maxResults"]]

describe("unknown parameters are refused, not ignored", () => {
  test("a typo is named in the refusal", () => {
    const res = validateActionParams(gmail, { totally_bogus: 1 }, SYNONYMS)
    expect(res.ok).toBe(false)
    expect(res.unknown).toEqual(["totally_bogus"])
  })

  test("a documented synonym is not a typo", () => {
    expect(validateActionParams(gmail, { maxResults: 5 }, SYNONYMS).ok).toBe(true)
    expect(validateActionParams(gmail, { max_results: 5 }, SYNONYMS).ok).toBe(true)
  })

  test("a declared parameter passes", () => {
    expect(validateActionParams(gmail, { limit: 5, unread_only: true }, SYNONYMS).ok).toBe(true)
  })

  test("a missing required parameter is named", () => {
    const write: ActionSignature = {
      ...gmail,
      name: "send_email",
      writes: true,
      parameters: [
        { name: "to", type: "string", required: true, description: "" },
        { name: "subject", type: "string", required: true, description: "" },
      ],
    }
    const res = validateActionParams(write, { to: "me@example.com" }, [])
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(["subject"])
  })

  test("a call with no parameters is left to the signature answer, not refused (#188781)", () => {
    const write: ActionSignature = {
      ...gmail,
      name: "send_email",
      writes: true,
      parameters: [{ name: "to", type: "string", required: true, description: "" }],
    }
    expect(validateActionParams(write, {}, []).ok).toBe(true)
  })

  test("an action with no declared parameters is not second-guessed", () => {
    const bare: ActionSignature = { ...gmail, parameters: [] }
    expect(validateActionParams(bare, { anything: 1 }, []).ok).toBe(true)
  })
})

describe("a partial upstream failure is a failure", () => {
  test("error_after_page with success:true is not success", () => {
    const result = {
      success: true,
      messages: [{ subject: "…" }],
      error_after_page: 'Composio action failed: {"slug":"Upstream_PayloadTooLarge","status":413}',
    }
    expect(isFailedResult(result)).toBe(true)
  })

  test("a clean result carrying a zero error count is still success", () => {
    expect(isFailedResult({ success: true, error_count: 0 })).toBe(false)
  })

  test("an empty errors array is still success", () => {
    expect(isFailedResult({ success: true, errors: [] })).toBe(false)
  })

  test("success:false is a failure whatever else is in the payload", () => {
    expect(isFailedResult({ success: false, data: [] })).toBe(true)
  })
})
