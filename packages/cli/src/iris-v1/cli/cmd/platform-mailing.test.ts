/**
 * `iris mailing` handlers against a mocked HTTP layer. The question every test here answers is
 * "what reached the server, and what did the person see" — above all, that no POST …/send ever
 * leaves without a yes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

process.env.IRIS_API_KEY = process.env.IRIS_API_KEY || "test-token"
const { runNew, runSend, runTest, runStatus, runLog, runDiscard } = await import("./platform-mailing")

type Call = { method: string; url: string; body: any }
let calls: Call[] = []
let routes: Record<string, (body: any) => { status?: number; json: any }> = {}
const realFetch = globalThis.fetch
const realWrite = process.stdout.write.bind(process.stdout)
const realLog = console.log
let out = ""
const argv0 = [...process.argv]

function mock(r: typeof routes) {
  routes = r
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const method = String(init.method ?? "GET").toUpperCase()
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const path = new URL(url).pathname
    const h = routes[`${method} ${path}`]
    if (!h) throw new Error(`unexpected ${method} ${path}`)
    const r = h(body)
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  }) as any
}

// MailingSender::summary() shape.
const aud = (sendable: number, extra: any = {}) => ({ total: sendable, sendable, dropped: { no_email: 0 }, sent: 0, failed: 0, pending: sendable, suppressed: 0, unknown: 0, ...extra })
const draft: any = {
  success: true,
  id: 12,
  status: "draft",
  subject: "Invitation",
  counts: { members: aud(101), prospects: aud(70) },
  placeholders_left: 0,
  send_audiences: null,
}

beforeEach(() => {
  calls = []
  out = ""
  process.exitCode = 0
  process.stdout.write = ((chunk: any, cb?: any) => {
    out += String(chunk)
    if (typeof cb === "function") cb()
    return true
  }) as any
  console.log = (...a: any[]) => {
    out += a.join(" ") + "\n"
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite as any
  console.log = realLog
  process.argv.splice(0, process.argv.length, ...argv0)
  process.exitCode = 0
})

const sends = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/send"))
const json = () => JSON.parse(out.trim().split("\n").filter((l) => l.trim()).length ? out.slice(out.indexOf("{")) : "{}")

describe("send — the confirm gate", () => {
  test("no terminal, no --yes: nothing is sent, exit 1, and the fix says --yes", async () => {
    mock({ "GET /api/v1/mailings/12": () => ({ json: draft }) })
    await runSend({ id: "12" }, { interactive: false })
    expect(sends()).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })

  test("interactive 'no': nothing is sent", async () => {
    mock({ "GET /api/v1/mailings/12": () => ({ json: draft }) })
    await runSend({ id: "12" }, { interactive: true, ask: async () => false })
    expect(sends()).toHaveLength(0)
  })

  test("interactive 'yes' asks with the right count, sends confirm:true and the audience, then follows to a tally", async () => {
    let polled = 0
    let question = ""
    mock({
      "GET /api/v1/mailings/12": () => {
        if (!sends().length) return { json: draft }
        polled++
        return polled < 2
          ? { json: { ...draft, status: "sending", send_audiences: ["members"], counts: { members: aud(101, { sent: 40, pending: 61 }), prospects: aud(70) } } }
          : { json: { ...draft, status: "sent", send_audiences: ["members"], counts: { members: aud(101, { sent: 101, pending: 0 }), prospects: aud(70) } } }
      },
      "POST /api/v1/mailings/12/send": () => ({ status: 202, json: { success: true, queued: true, ...draft, status: "sending" } }),
    })
    await runSend({ id: "12", audience: ["Members"] }, { interactive: true, ask: async (q) => ((question = q), true), sleep: async () => {} })
    expect(question).toBe("Send to 101 people? (y/N)")
    expect(sends()).toHaveLength(1)
    expect(sends()[0].body).toEqual({ confirm: true, audiences: ["members"] })
    expect(process.exitCode).toBe(0)
  })

  test("a failed send names who failed and how to resume", async () => {
    mock({
      "GET /api/v1/mailings/12": () =>
        sends().length
          ? { json: { ...draft, status: "stopped", last_error: "Mailjet refused the sender", send_audiences: ["members", "prospects"], counts: { members: aud(101, { sent: 50, failed: 1, pending: 50 }), prospects: aud(70) } } }
          : { json: draft },
      "POST /api/v1/mailings/12/send": () => ({ status: 202, json: { success: true, queued: true, ...draft, status: "sending" } }),
      "GET /api/v1/mailings/12/recipients": () => ({ json: { data: [{ email: "x@y.com", status: "failed", error: "Mailjet 401" }] } }),
    })
    process.argv.push("--json")
    await runSend({ id: "12", yes: true }, { interactive: false, sleep: async () => {} })
    const r = json()
    expect(r.success).toBe(false)
    expect(r.failures).toEqual([{ email: "x@y.com", error: "Mailjet 401" }])
    expect(r.resume).toBe("iris mailing send 12")
    expect(r.last_error).toBe("Mailjet refused the sender")
    expect(process.exitCode).toBe(1)
  })

  test("placeholders left on the draft: refuses to send even with --yes", async () => {
    mock({ "GET /api/v1/mailings/12": () => ({ json: { ...draft, placeholders_left: 171 } }) })
    process.argv.push("--json")
    await runSend({ id: "12", yes: true }, { interactive: false })
    expect(sends()).toHaveLength(0)
    expect(json().code).toBe("placeholders_left")
  })

  test("an audience the mailing does not have is refused before anything is sent", async () => {
    mock({ "GET /api/v1/mailings/12": () => ({ json: draft }) })
    await runSend({ id: "12", audience: ["staff"], yes: true }, { interactive: false })
    expect(sends()).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })
})

describe("friendly errors + JSON mode end to end", () => {
  test("new with no Mailjet connected → one JSON object with the connect command", async () => {
    mock({
      "POST /api/v1/mailings": () => ({ status: 422, json: { success: false, reason: "no_mailjet", message: "No active Mailjet connection on your account." } }),
    })
    process.argv.push("--json")
    const { writeFileSync, rmSync } = await import("node:fs")
    const f = `/tmp/iris-mailing-test-${process.pid}.html`
    writeFileSync(f, "<p>Hey {{First Name}}</p>")
    await runNew({ template: f, subject: "Hi", audience: ["members=186974"] })
    rmSync(f)
    const r = json()
    expect(r).toMatchObject({ success: false, code: "mailjet_not_connected" })
    expect(r.fix[0]).toStartWith("iris integrations connect mailjet")
    expect(process.exitCode).toBe(1)
  })

  test("new posts the contract body and returns the draft as JSON", async () => {
    let posted: any
    mock({
      "POST /api/v1/mailings": (b) => ((posted = b), { status: 201, json: { ...draft, sample: [{ to: "a@b.com", audience: "members", subject: "Hi", html: "<p>Hey Ann</p>" }] } }),
    })
    process.argv.push("--json")
    const { writeFileSync, rmSync } = await import("node:fs")
    const f = `/tmp/iris-mailing-test2-${process.pid}.html`
    writeFileSync(f, "<p>Hey {{First Name}}</p>")
    await runNew({ template: f, subject: "Hi", audience: ["members=186974"], "skip-status": ["Email Status=Unavailable"] })
    rmSync(f)
    expect(posted).toEqual({
      subject: "Hi",
      html: "<p>Hey {{First Name}}</p>",
      audiences: [{ name: "members", dataset_item_id: 186974 }],
      exclude_statuses: { "Email Status": ["Unavailable"] },
    })
    expect(json()).toMatchObject({ success: true, id: 12, status: "draft" })
  })

  test("a bad flag is a JSON usage error and nothing reaches the server", async () => {
    mock({})
    process.argv.push("--json")
    const f = `/tmp/iris-mailing-test3-${process.pid}.html`
    const { writeFileSync, rmSync } = await import("node:fs")
    writeFileSync(f, "<p>x</p>")
    await runNew({ template: f, subject: "Hi", audience: ["members"] })
    rmSync(f)
    expect(calls).toHaveLength(0)
    expect(json()).toMatchObject({ success: false, code: "usage" })
  })

  test("status on a missing mailing → not_found with the list command", async () => {
    mock({ "GET /api/v1/mailings/99": () => ({ status: 404, json: { success: false, reason: "not_found", message: "Mailing #99 not found." } }) })
    process.argv.push("--json")
    await runStatus({ id: "99" })
    expect(json()).toMatchObject({ success: false, code: "not_found", fix: ["iris mailing list"] })
  })

  test("test with no --to sends to the signed-in user's own address", async () => {
    let to: any
    mock({
      "GET /api/user": () => ({ json: { data: { id: 1, email: "Alex@Example.com" } } }),
      "POST /api/v1/mailings/12/test": (b) => ((to = b.to), { json: { success: true, id: 12, message_ids: ["1"], sent: [{ to: b.to[0], message_id: "1" }], failed: [] } }),
    })
    process.argv.push("--json")
    await runTest({ id: "12" })
    expect(to).toEqual(["alex@example.com"])
    expect(json()).toMatchObject({ success: true, to: ["alex@example.com"] })
  })

  test("a test Mailjet refuses (502) says who and why", async () => {
    mock({
      "POST /api/v1/mailings/12/test": () => ({ status: 502, json: { success: false, id: 12, sent: [], failed: [{ to: "x@y.com", error: "Sender not validated" }] } }),
    })
    process.argv.push("--json")
    await runTest({ id: "12", to: ["x@y.com"] })
    expect(json()).toMatchObject({ success: false, code: "test_failed", details: ["x@y.com: Sender not validated"] })
  })

  test("discard on a mailing that already sent explains it is kept", async () => {
    mock({ "DELETE /api/v1/mailings/12": () => ({ status: 409, json: { success: false, reason: "not_deletable", message: "kept" } }) })
    process.argv.push("--json")
    await runDiscard({ id: "12" })
    expect(json()).toMatchObject({ success: false, code: "not_deletable" })
  })

  test("log --csv writes a spreadsheet to stdout", async () => {
    mock({ "GET /api/v1/mailings/12/recipients": () => ({ json: { success: true, id: 12, data: [{ email: "a@b.com", audience: "members", status: "sent", mailjet_message_id: "1", sent_at: null, error: null }] } }) })
    await runLog({ id: "12", csv: true })
    expect(out).toBe("email,audience,status,sent_at,mailjet_message_id,error\na@b.com,members,sent,,1,\n")
  })
})
