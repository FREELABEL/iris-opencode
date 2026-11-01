/**
 * The list audit on `iris email send` (#192096), against a mocked HTTP layer. No mail, no DNS: the
 * question every test answers is what reached the server, above all that no live send leaves a
 * list the audit refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { auditLines, decide, fetchAudit, isBulk, readOverride, type AuditReport } from "./list-audit"

process.env.IRIS_API_KEY = process.env.IRIS_API_KEY || "test-token"
const { SendCommand, AuditCommand } = await import("./platform-email")

const clean: AuditReport = { total: 2, bounce_risk: 0, flagged: [], suppressed: [], unchecked_domains: 0, complete: true, passed: true, unverified: 2, note: "Mailboxes are not verified." }
const bad: AuditReport = {
  ...clean,
  bounce_risk: 1,
  unverified: 1,
  passed: false,
  flagged: [{ email: "gone@no-mail.example", status: "undeliverable", reason: "no mail server (no MX)" }],
}

describe("what counts as bulk", () => {
  test("a real send to two or more; never a test, never one person", () => {
    expect(isBulk("live", 2)).toBe(true)
    expect(isBulk("live", 1)).toBe(false)
    expect(isBulk("test", 10)).toBe(false)
  })
})

describe("the override", () => {
  const flags = { "override-audit": "Checked by hand", "override-audit-count": 1 }
  test("none given is fine", () => expect(readOverride({}, false)).toEqual({ ok: true }))
  test("needs a person at a terminal", () => expect(readOverride(flags, false).ok).toBe(false))
  test("needs a reason", () => expect(readOverride({ ...flags, "override-audit": "  " }, true).ok).toBe(false))
  test("needs the count read", () => expect(readOverride({ "override-audit": "why" }, true).ok).toBe(false))
  test("a person with both", () => expect(readOverride(flags, true)).toEqual({ ok: true, override: { reason: "Checked by hand", count: 1 } }))
})

describe("the decision", () => {
  test("a clean list goes; a flagged one does not, and the refusal gives the count", () => {
    expect(decide(clean).go).toBe(true)
    const no = decide(bad)
    expect(no.go).toBe(false)
    if (!no.go) expect(no.error).toContain("--override-audit-count 1")
  })
  test("an override passes a flagged list, not an opted-out person", () => {
    expect(decide(bad, { reason: "x", count: 1 }).go).toBe(true)
    const left = { ...clean, passed: false, suppressed: [{ email: "left@x.example", status: "suppressed", reason: "unsubscribed" }] }
    expect(decide(left, { reason: "x", count: 0 }).go).toBe(false)
  })
  test("could not finish is not a pass", () => {
    expect(decide({ ...clean, passed: false, complete: false, unchecked_domains: 3 }).go).toBe(false)
  })
  test("every flagged address is shown with its reason, plus the unverified warning", () => {
    const text = auditLines(bad).join("\n")
    expect(text).toContain("gone@no-mail.example")
    expect(text).toContain("no mail server (no MX)")
    expect(text).toContain("Mailboxes are not verified")
  })
})

describe("asking the server", () => {
  const reply = (status: number, body: any) => async () => ({ status, body })
  test("a server with no audit refuses the send", async () => {
    expect((await fetchAudit(reply(404, {}), ["a@x.example"])).ok).toBe(false)
  })
  test("an error refuses the send", async () => {
    expect((await fetchAudit(reply(500, {}), ["a@x.example"])).ok).toBe(false)
  })
  test("an empty answer refuses the send", async () => {
    expect((await fetchAudit(reply(200, {}), ["a@x.example"])).ok).toBe(false)
  })
  test("asks again while domains are unchecked, then reports what is left", async () => {
    let n = 0
    const got = await fetchAudit(async () => {
      n++
      return { status: 200, body: { data: { ...clean, passed: false, complete: false, unchecked_domains: 5 } } }
    }, ["a@x.example"])
    expect(n).toBe(3)
    expect(got.ok && got.report.complete).toBe(false)
  })
})

describe("iris email send", () => {
  type Call = { method: string; path: string; body: any }
  let calls: Call[] = []
  let audit: any = clean
  const realFetch = globalThis.fetch
  const realLog = console.log
  const realWrite = process.stdout.write.bind(process.stdout)
  const realTty = process.stdin.isTTY
  const realCi = process.env.CI
  let out = ""

  beforeEach(() => {
    calls = []
    out = ""
    audit = clean
    process.exitCode = 0
    delete process.env.CI
    console.log = (...a: any[]) => {
      out += a.join(" ") + "\n"
    }
    process.stdout.write = ((c: any, cb?: any) => {
      out += String(c)
      if (typeof cb === "function") cb()
      return true
    }) as any
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname
      const method = String(init.method ?? "GET").toUpperCase()
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const payload = path.endsWith("/audit")
        ? audit === null
          ? { status: 404, json: {} }
          : { status: 200, json: { success: true, data: audit } }
        : { status: 202, json: { data: { id: 9, status: "sent", mode: "live", sent_count: 2, failed_count: 0, recipient_count: 2, messages: [] } } }
      return new Response(JSON.stringify(payload.json), { status: payload.status, headers: { "content-type": "application/json" } })
    }) as any
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    console.log = realLog
    process.stdout.write = realWrite as any
    process.stdin.isTTY = realTty as any
    if (realCi !== undefined) process.env.CI = realCi
    process.exitCode = 0
  })

  const run = (extra: Record<string, unknown>) =>
    (SendCommand as any).handler({ slug: "news", bloq: 251, provider: "resend", from: "me@sender.example", json: true, ...extra })
  const live2 = { to: ["a@good.example", "gone@no-mail.example"], live: true, "confirm-count": 2 }
  const sends = () => calls.filter((c) => c.path.endsWith("/sends"))

  test("a list that fails the audit never reaches the send, and the report comes back", async () => {
    audit = bad
    await run(live2)
    expect(sends()).toHaveLength(0)
    expect(process.exitCode).toBe(1)
    expect(out).toContain("gone@no-mail.example")
    expect(out).toContain("no mail server (no MX)")
  })

  test("a server that can't audit gets no bulk send", async () => {
    audit = null
    await run(live2)
    expect(sends()).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })

  test("a clean list sends, with no override on it", async () => {
    await run(live2)
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.body.audit_override).toBeUndefined()
  })

  test("a person's override reaches the server with the reason and count, and the list unchanged", async () => {
    audit = bad
    process.stdin.isTTY = true as any
    await run({ ...live2, "override-audit": "Checked by hand", "override-audit-count": 1 })
    expect(sends()[0]!.body.audit_override).toEqual({ reason: "Checked by hand", count: 1 })
    expect(sends()[0]!.body.recipients).toEqual(["a@good.example", "gone@no-mail.example"])
  })

  test("the override is refused with no terminal: an agent shell can't pass one", async () => {
    audit = bad
    process.stdin.isTTY = false as any
    await run({ ...live2, "override-audit": "agent says", "override-audit-count": 1 })
    expect(sends()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test("one person live, or a test, is not audited and not blocked", async () => {
    audit = bad
    await run({ to: ["gone@no-mail.example"], live: true, "confirm-count": 1 })
    await run({ to: ["a@good.example", "gone@no-mail.example"], test: true })
    expect(calls.filter((c) => c.path.endsWith("/audit"))).toHaveLength(0)
    expect(sends()).toHaveLength(2)
  })

  test("iris email audit reports and exits non-zero on a bad list, sending nothing", async () => {
    audit = bad
    await (AuditCommand as any).handler({ bloq: 251, to: ["a@good.example", "gone@no-mail.example"], json: true })
    expect(sends()).toHaveLength(0)
    expect(process.exitCode).toBe(1)
    expect(out).toContain("gone@no-mail.example")
  })
})
