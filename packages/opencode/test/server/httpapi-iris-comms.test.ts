import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { clearCommsCache, commsDeps, groupConversations, commsRow, sendRefusal } from "../../src/iris/comms"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192688 — the people inbox through the real routes. Effect Schema strips undeclared fields silently,
// so every field the panel reads is asserted to arrive. The platform is replaced by the shapes fl-api
// returned on 2026-11-06; the sends are asserted by the calls they make — nothing reaches a person.

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, irisHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const NOW = Date.parse("2026-11-06T12:00:00Z")
const comm = (o: Record<string, unknown>) => ({ id: 1, user_id: 193, lead_id: 27590, bloq_id: 38, channel: "instagram", direction: "inbound", from_identifier: "heyiris.io", to_identifiers: null, subject: null, body: "hi", sent_at: "2026-11-05T12:00:00.000000Z", metadata: { source: "x" }, ...o })
const INBOUND = [
  comm({ id: 7139, body: "what's the one thing that needs improvement?", sent_at: "2026-11-05T12:09:10.000000Z" }),
  comm({ id: 7110, body: "where are you at with clients?", sent_at: "2026-11-04T23:08:40.000000Z" }),
  comm({ id: 7098, lead_id: 30466, bloq_id: null, channel: "gmail", from_identifier: null, to_identifiers: ["info@stelmobrewing.com"], subject: "Re: Live music night", body: "St. Elmo introduced the two taproom GMs", sent_at: "2026-11-04T18:46:54.000000Z" }),
  comm({ id: 7155, lead_id: null, bloq_id: 170, channel: "contact_form", from_identifier: "fan@example.com", subject: "Contact form", body: "Role: fan", sent_at: "2026-11-05T22:52:03.000000Z", metadata: { submitter_name: "Test Fan" } }),
]
const TAILS: Record<number, unknown[]> = {
  27590: [INBOUND[0], INBOUND[1], comm({ id: 7100, direction: "outbound", body: "We're early but not pre-revenue.", sent_at: "2026-11-04T23:12:14.000000Z" })],
  30466: [comm({ id: 7099, lead_id: 30466, channel: "gmail", direction: "outbound", subject: "Re: Live music night", body: "Thanks so much for the intro!", sent_at: "2026-11-04T19:48:13.000000Z" }), INBOUND[2]],
}
const LEADS: Record<number, unknown> = {
  27590: { id: 27590, nickname: "@alexrigby.7", status: "Responded", contact_info: { instagram: "alexrigby.7" }, has_replied: 1, replied_at: "2026-10-28T19:09:10.000000Z", lead_score: 0 },
  30466: { id: 30466, nickname: "St. Elmo Brewing Co.", email: "info@stelmobrewing.com", phone: "+15125550100", status: "Contacted", has_replied: 1 },
}
type Call = { path: string; method: string; body?: any }
let calls: Call[] = []
const real = { ...commsDeps }
afterEach(() => {
  Object.assign(commsDeps, real)
  calls = []
  clearCommsCache()
})
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const paged = (data: unknown[]) => ok({ success: true, data: { current_page: 1, data, last_page: 1, total: data.length } })
function platform() {
  commsDeps.userId = async () => 193
  commsDeps.now = () => NOW
  commsDeps.fetch = async (path, init) => {
    const method = init?.method ?? "GET"
    calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    if (path.startsWith("/api/v1/atlas/comms?")) {
      const q = new URLSearchParams(path.split("?")[1])
      if (q.get("lead_id")) return paged(TAILS[Number(q.get("lead_id"))] ?? [])
      return paged(INBOUND)
    }
    const lead = path.match(/^\/api\/v1\/leads\/(\d+)$/)
    if (lead) return ok({ success: true, data: LEADS[Number(lead[1])] })
    if (path.startsWith("/api/v1/users/193/assigned-leads")) return ok({ success: true, data: { data: [{ id: 30466 }], last_page: 1 } })
    if (path.endsWith("/outreach-steps"))
      return ok({ success: true, data: { steps: [{ id: 2, title: "Follow up", order: 2, is_completed: false, due_date: "2026-11-08" }, { id: 1, title: "First DM", order: 1, is_completed: true, completed_at: "2026-11-01" }], stats: { total: 2, completed: 1, progress_percent: 50 } } })
    if (path.includes("/outreach/messages?"))
      return ok({ success: true, stats: { total: 3, outbound: 1, inbound: 2, replied: 3 }, messages: [{ id: 2568, type: "instagram_dm", direction: "outbound", message: "<p>We're early</p>", status: "replied", generated_by_ai: true, sent_at: "2026-11-04T23:12:14.000000Z", channel_account: "heyiris.io" }, { id: 2500, type: "instagram_dm", direction: "inbound", message: "hand typed", generated_by_ai: false }] })
    if (path.endsWith("/outreach/generate-email")) return ok({ success: true, draft: { subject: "Re: Live music night", body: "<p>Hi Jenni,</p><p>Thursday works.</p>" } })
    if (path.endsWith("/outreach/reply-suggestions")) return ok({ success: true, suggestions: [{ tone: "warm", text: "glad you asked!" }, { tone: "direct", text: "here's the link" }] })
    if (path.endsWith("/outreach/send-email") || path.endsWith("/outreach/send-sms") || path.endsWith("/outreach/send-dm-reply")) return ok({ success: true, message: "Queued" })
    return new Response("{}", { status: 404 })
  }
}
const sends = () => calls.filter((c) => c.method !== "GET" && /send/.test(c.path))
const getJson = (url: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(url)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })
const postJson = (url: string, body: unknown) =>
  Effect.gen(function* () {
    const res = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("/iris/comms (#192688)", () => {
  it.live("one conversation per lead, newest first, with every field a row reads", () =>
    Effect.gen(function* () {
      platform()
      const b = yield* getJson("/iris/comms?days=14")
      expect(b).toMatchObject({ measured: true, total: 3, days: 14, truncated: false })
      expect(b.conversations.map((c: any) => c.key)).toEqual(["from:fan@example.com", "lead:27590", "lead:30466"])
      expect(b.conversations[1]).toEqual({
        key: "lead:27590",
        leadId: 27590,
        bloqId: 38,
        name: "@alexrigby.7",
        channel: "instagram",
        channels: ["instagram"],
        lastAt: "2026-11-05T12:09:10.000000Z",
        lastDirection: "inbound",
        preview: "what's the one thing that needs improvement?",
        lastInboundAt: "2026-11-05T12:09:10.000000Z",
        inbound: 2,
        outbound: 1,
        needsReply: true,
        assigned: false,
        status: "Responded",
      })
      // Their message was not the last word: answered, and assigned to me.
      expect(b.conversations[2]).toMatchObject({ name: "St. Elmo Brewing Co.", needsReply: false, assigned: true, subject: "Re: Live music night" })
      // A contact form with no lead yet is named by who filled it in.
      expect(b.conversations[0]).toMatchObject({ name: "Test Fan", needsReply: true })
      expect(b.counts).toEqual({ all: 3, needsReply: 2, assigned: 1, channels: { contact_form: 1, instagram: 1, gmail: 1 } })
      const scan = calls.find((c) => c.path.includes("direction=inbound"))!.path
      expect(scan).toContain("from=2026-10-23")
      expect(calls.every((c) => c.method === "GET")).toBe(true)
    }),
  )

  it.live("is cached for a minute, and refresh asks again", () =>
    Effect.gen(function* () {
      platform()
      yield* getJson("/iris/comms")
      const n = calls.length
      yield* getJson("/iris/comms")
      expect(calls.length).toBe(n)
      yield* getJson("/iris/comms?refresh=1")
      expect(calls.length).toBeGreaterThan(n)
    }),
  )

  it.live("a board narrows the scan on the platform", () =>
    Effect.gen(function* () {
      platform()
      yield* getJson("/iris/comms?bloqId=38")
      expect(calls[0].path).toContain("bloq_id=38")
    }),
  )

  it.live("signed out is said, not drawn as an empty inbox", () =>
    Effect.gen(function* () {
      platform()
      commsDeps.userId = async () => null
      const b = yield* getJson("/iris/comms")
      expect(b.measured).toBe(false)
      expect(b.reason).toContain("not signed in")
    }),
  )

  it.live("a thread: messages oldest first, the lead's card, the sequence step and AI history", () =>
    Effect.gen(function* () {
      platform()
      const t = yield* getJson("/iris/comms/thread/27590")
      expect(t.measured).toBe(true)
      expect(t.messages.map((m: any) => m.id)).toEqual([7110, 7100, 7139])
      expect(t.messages[0]).toEqual({ id: 7110, leadId: 27590, bloqId: 38, channel: "instagram", direction: "inbound", from: "heyiris.io", to: [], body: "where are you at with clients?", sentAt: "2026-11-04T23:08:40.000000Z" })
      expect(t.lead).toMatchObject({ id: 27590, name: "@alexrigby.7", instagram: "alexrigby.7", hasReplied: true, status: "Responded", score: 0 })
      expect(t.steps.map((s: any) => s.title)).toEqual(["First DM", "Follow up"])
      expect(t.currentStep).toMatchObject({ id: 2, title: "Follow up", done: false, dueDate: "2026-11-08" })
      expect(t.progress).toEqual({ total: 2, completed: 1, percent: 50 })
      expect(t.aiHistory).toEqual([{ id: 2568, type: "instagram_dm", direction: "outbound", status: "replied", text: "We're early", at: "2026-11-04T23:12:14.000000Z", account: "heyiris.io" }])
      expect(t.outreachStats).toEqual({ total: 3, outbound: 1, inbound: 2, replied: 3 })
      expect(t.replyTo).toEqual({ instagram: "alexrigby.7" })
    }),
  )
})

describe("drafting and sending (#192688): a draft sends nothing; a send needs a yes", () => {
  it.live("an AI email draft comes back as text and calls no send", () =>
    Effect.gen(function* () {
      platform()
      const d = yield* postJson("/iris/comms/draft", { leadId: 30466, channel: "email" })
      expect(d).toEqual({ measured: true, drafts: [{ subject: "Re: Live music night", text: "Hi Jenni,\n\nThursday works." }], fallback: false })
      expect(calls.at(-1)!.body.prompt.length).toBeGreaterThan(10)
      const ig = yield* postJson("/iris/comms/draft", { leadId: 27590, channel: "instagram" })
      expect(ig.drafts).toEqual([{ tone: "warm", text: "glad you asked!" }, { tone: "direct", text: "here's the link" }])
      expect(sends()).toEqual([])
    }),
  )

  it.live("a send without confirm is refused and calls nothing", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/comms/send", { leadId: 30466, channel: "email", to: "info@stelmobrewing.com", subject: "Re: hi", text: "Thursday works", origin: "person" })
      expect(r).toMatchObject({ ok: false, channel: "email" })
      expect(r.reason).toContain("confirmation")
      expect(sends()).toEqual([])
    }),
  )

  it.live("an AI draft that was not approved is refused even with confirm", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/comms/send", { leadId: 27590, channel: "instagram", text: "glad you asked!", origin: "ai", confirm: true })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("approved")
      expect(sends()).toEqual([])
    }),
  )

  it.live("approved and confirmed, it calls the channel's own send with exactly the text", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/comms/send", { leadId: 30466, channel: "email", to: "info@stelmobrewing.com", subject: "Re: Live music night", text: "Hi <Jenni>\nThursday", origin: "ai", approved: true, confirm: true })
      expect(r).toMatchObject({ ok: true, channel: "email", detail: "Queued" })
      expect(sends()).toEqual([
        {
          path: "/api/v1/leads/30466/outreach/send-email",
          method: "POST",
          body: { to_email: "info@stelmobrewing.com", subject: "Re: Live music night", body_text: "Hi <Jenni>\nThursday", body_html: "Hi &lt;Jenni&gt;<br>Thursday", plain_text_only: true },
        },
      ])
      yield* postJson("/iris/comms/send", { leadId: 27590, channel: "instagram", text: "see you there", to: "@alexrigby.7", origin: "person", confirm: true, bloqId: 38 })
      expect(sends().at(-1)).toEqual({ path: "/api/v1/leads/27590/outreach/send-dm-reply", method: "POST", body: { message: "see you there", bloq_id: 38, handle: "alexrigby.7" } })
      yield* postJson("/iris/comms/send", { leadId: 30466, channel: "sms", text: "on my way", to: "+15125550100", origin: "person", confirm: true })
      expect(sends().at(-1)).toEqual({ path: "/api/v1/leads/30466/outreach/send-sms", method: "POST", body: { to_phone: "+15125550100", body: "on my way" } })
    }),
  )

  it.live("a refused platform send is reported as not sent", () =>
    Effect.gen(function* () {
      platform()
      const before = commsDeps.fetch
      commsDeps.fetch = async (path, init) => (path.endsWith("/send-sms") ? new Response(JSON.stringify({ success: false, error: "Twilio is not configured" }), { status: 500 }) : before(path, init))
      const r = yield* postJson("/iris/comms/send", { leadId: 30466, channel: "sms", text: "hi", to: "+15125550100", origin: "person", confirm: true })
      expect(r).toMatchObject({ ok: false, reason: "Twilio is not configured" })
    }),
  )
})

describe("comms model (#192688)", () => {
  it.live("the refusals, in the order a person meets them", () =>
    Effect.sync(() => {
      const base = { channel: "email" as const, text: "hi", to: "a@b.co", subject: "s", origin: "person" as const, confirm: true }
      expect(sendRefusal(base)).toBeUndefined()
      expect(sendRefusal({ ...base, text: "  " })).toContain("empty")
      expect(sendRefusal({ ...base, confirm: undefined })).toContain("confirmation")
      expect(sendRefusal({ ...base, origin: "ai" })).toContain("approved")
      expect(sendRefusal({ ...base, origin: "ai", approved: true })).toBeUndefined()
      expect(sendRefusal({ ...base, to: undefined })).toContain("no email")
      expect(sendRefusal({ ...base, subject: "" })).toContain("subject")
      expect(sendRefusal({ ...base, channel: "sms", to: undefined })).toContain("phone")
    }),
  )
  it.live("a message seen twice is one message", () =>
    Effect.sync(() => {
      const rows = [commsRow(comm({ id: 5 })), commsRow(comm({ id: 5 })), commsRow(comm({ id: 6, direction: "outbound", sent_at: "2026-11-06T00:00:00Z" }))]
      const [c] = groupConversations(rows, new Map(), new Set())
      expect(c).toMatchObject({ inbound: 1, outbound: 1, needsReply: false, name: "Lead #27590" })
    }),
  )
})
