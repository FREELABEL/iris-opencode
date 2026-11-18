import { describe, expect, test } from "bun:test"
import {
  verifyProbeFor,
  isProbeSuccess,
  isProbeInconclusive,
  classifyProbeAnswer,
  checkConnection,
  connectionKey,
  statusLabelFor,
} from "./integration-verify-probe"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Post-authorize verification, replacing a list diff that could not tell whether a
 * credential actually worked. Every failure this week came from that gap:
 *
 *   - a repair overwrites a row, so nothing looks new and success reads as failure (#182697)
 *   - the callback can land just after the 60s poll gives up — a race decides the verdict
 *   - `status: "active"` is a claim: Notion rows sat at active with EXPIRED credentials
 *   - a live connection can point at the wrong account entirely (a personal workspace)
 */
describe("verifyProbeFor", () => {
  test("returns a read-only probe for the integrations people actually connect", () => {
    for (const t of ["gmail", "google-drive", "google-calendar", "notion", "slack"]) {
      expect(verifyProbeFor(t)).not.toBeNull()
    }
  })

  test("is case-insensitive", () => {
    expect(verifyProbeFor("Gmail")?.action).toBe("read_emails")
  })

  test("every probe asks for the smallest possible page — this runs on a live account", () => {
    for (const t of ["gmail", "google-drive", "notion", "slack", "dropbox", "canva"]) {
      const p = verifyProbeFor(t)!
      const sizes = Object.entries(p.params)
        .filter(([k]) => /limit|size|max|results/i.test(k))
        .map(([, v]) => v)
      for (const v of sizes) expect(v).toBe(1)
    }
  })

  test("no probe is a write — the first thing we do with someone's credential must not change anything", () => {
    for (const t of ["gmail", "google-drive", "google-calendar", "google-docs", "notion", "slack", "dropbox", "github", "canva", "servis-ai"]) {
      expect(verifyProbeFor(t)!.action).not.toMatch(/create|send|delete|update|insert|append|write|post/i)
    }
  })

  test("an unknown toolkit has no probe, so connect falls back to the diff rather than guessing", () => {
    expect(verifyProbeFor("some-new-thing")).toBeNull()
    expect(verifyProbeFor("")).toBeNull()
  })
})

describe("isProbeSuccess", () => {
  test("only an explicit success:true counts", () => {
    expect(isProbeSuccess({ success: true })).toBe(true)
    expect(isProbeSuccess({ success: false })).toBe(false)
  })

  test('"no error" is NOT success — that conflation is how a 401 became a green check', () => {
    expect(isProbeSuccess({})).toBe(false)
    expect(isProbeSuccess(null)).toBe(false)
    expect(isProbeSuccess("ok")).toBe(false)
    expect(isProbeSuccess({ data: [1, 2, 3] })).toBe(false)
  })
})

describe("isProbeInconclusive", () => {
  test('"not allowed to ask" is never "your integration is broken" (#182581)', () => {
    expect(isProbeInconclusive(401, {})).toBe(true)
    expect(isProbeInconclusive(403, {})).toBe(true)
    expect(isProbeInconclusive(200, { error: "Authentication required" })).toBe(true)
  })

  test("a real answered failure is conclusive — it tells us something about the credential", () => {
    expect(isProbeInconclusive(200, { success: false, error: "invalid_grant" })).toBe(false)
    expect(isProbeInconclusive(500, { error: "upstream exploded" })).toBe(false)
  })
})

// `iris integrations list` (#191975): it reported a 404 from routes that never existed.
describe("checking one connection", () => {
  const live = { id: 161, type: "gmail", status: "active", store: "iris-api", inExecStore: true }
  const answering = (status: number, body: unknown) => {
    const calls: Record<string, unknown>[] = []
    return { calls, exec: async (b: Record<string, unknown>) => (calls.push(b), { status, body }) }
  }

  test("asks through THAT account, with the read-only call", async () => {
    const { calls, exec } = answering(200, { success: true })
    const v = await checkConnection(live, exec)
    expect(calls).toEqual([{ integration: "gmail", action: "read_emails", params: { max_results: 1 }, integration_id: 161 }])
    expect(v?.state).toBe("verified")
    expect(statusLabelFor(live, v).text).toBe("[connected]")
  })

  test("a 404 reports check unavailable: not healthy, not broken", async () => {
    const v = await checkConnection(live, answering(404, { message: "Not Found" }).exec)
    expect(v?.state).toBe("unavailable")
    const label = statusLabelFor(live, v)
    expect(label.text).toBe("[check unavailable]")
    expect(label.tone).toBe("dim")
    expect(label.detail).toContain("404")
    expect(label.detail).toContain("says nothing about the integration")
  })

  test("our own 401, a 5xx, a timeout and an empty 200 are all check unavailable", async () => {
    for (const [status, body] of [[401, {}], [403, {}], [500, {}], [503, null], [429, {}], [200, {}]] as const) {
      expect((await checkConnection(live, answering(status, body).exec))?.state).toBe("unavailable")
    }
    const v = await checkConnection(live, async () => {
      throw new Error("The operation timed out")
    })
    expect(v?.state).toBe("unavailable")
  })

  test("an expired grant says expired and how to fix it", async () => {
    for (const [status, body] of [
      [200, { success: false, error: "Composio error 1820 ConnectedAccountExpired" }],
      [410, {}],
      [400, { success: false, error: "token has been revoked" }],
    ] as const) {
      const v = await checkConnection(live, answering(status, body).exec)
      expect(v?.state).toBe("expired")
      expect(v?.fix).toBe("iris integrations connect gmail")
      expect(statusLabelFor(live, v).detail).toContain("run: iris integrations connect gmail")
    }
  })

  test("a refusal with a reason is failed, with the reason and the command for that account", async () => {
    const v = await checkConnection(live, answering(400, { success: false, error: "No usable connection" }).exec)
    expect(v?.state).toBe("error")
    expect(v?.reason).toBe("No usable connection")
    expect(v?.fix).toBe("iris integrations exec gmail read_emails --integration-id=161 --dry-run")
    expect(statusLabelFor(live, v).text).toBe("[failed]")
  })

  test("a row exec cannot read is unavailable, and nothing is called", async () => {
    const { calls, exec } = answering(200, { success: true })
    const v = await checkConnection({ ...live, store: "fl-api", inExecStore: false }, exec)
    expect(calls).toEqual([])
    expect(v?.state).toBe("unavailable")
    expect(v?.reason).toContain("fl-api")
  })

  test("a marked-expired row is not called; a type with no check is never shown as checked", async () => {
    const { calls, exec } = answering(200, { success: true })
    expect((await checkConnection({ ...live, status: "expired" }, exec))?.state).toBe("expired")
    const noCheck = { ...live, type: "vagaro" }
    expect(await checkConnection(noCheck, exec)).toBeNull()
    expect(await checkConnection({ ...live, status: "inactive" }, exec)).toBeNull()
    expect(calls).toEqual([])
    expect(statusLabelFor(noCheck, null).text).toBe("[active, not checked]")
    expect(statusLabelFor({ ...live, status: "inactive" }, null).text).toBe("[inactive]")
  })

  test("the same id in each store is two connections", () => {
    const a = connectionKey({ id: 11, type: "gmail", store: "iris-api" })
    const b = connectionKey({ id: 11, type: "google-drive", store: "fl-api" })
    expect(a).not.toBe(b)
  })

  test("classify reports a success with the check's label", () => {
    expect(classifyProbeAnswer("gmail", 200, { success: true }, { label: "reading 1 message" }).reason).toContain("reading 1 message")
  })

  test("the list and the key check call the rail that exists, not the routes that 404", () => {
    const src = readFileSync(join(import.meta.dir, "platform-run.ts"), "utf8")
    expect(src).not.toContain("/api/v1/integrations/exec\"")
    expect(src).not.toContain("/leads/0/gmail-threads")
    const listStart = src.indexOf("await checkConnection(i,")
    expect(src.slice(listStart, listStart + 500)).toContain("IRIS_API")
    expect(src).toContain("connectionKey(i)")
  })
})
