import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { agreementDeps } from "../../src/iris/agreements"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192484 — Lexicon › Agreements through the real route. The point of this file is PR #459: Effect
// Schema strips undeclared fields silently, so every field the panel reads is asserted to arrive.
// fl-api is mocked: issue and revoke reach a real counterparty.

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

const ROW = {
  id: 26584,
  type: "ENGAGEMENT",
  kind: "Engagement Letter",
  raisedByCaller: true,
  counterparty: "Dana Whitfield",
  org: "Whitfield LLC",
  email: "dana@example.com",
  disclosingParty: "Test Firm LLP",
  status: "partially_signed",
  tier: "standard",
  subjectRef: "case:999001",
  issuedAt: "2026-11-01 23:10:32",
  executedAt: null,
  expiryDate: "2027-11-01",
  revokedAt: null,
  documentHash: "abcdef0123456789",
  signingUrl: "https://heyiris.io/p/sign?t=a",
  partyLinks: [
    { role: "Client", name: "Dana Whitfield", status: "signed", url: "https://heyiris.io/p/sign?t=a" },
    { role: "Guarantor", name: "Sam Whitfield", status: "opened", url: "https://heyiris.io/p/sign?t=b" },
  ],
  live: false,
  partiesTotal: 2,
  partiesSigned: 1,
  waitingOn: "Guarantor",
  waitingDays: 9,
  expiringSoon: true,
}
const PANEL_FIELDS = Object.keys(ROW)

type Seen = { path: string; init?: RequestInit }
let seen: Seen[] = []
const real = agreementDeps.fetch
afterEach(() => {
  agreementDeps.fetch = real
  seen = []
})
function flApi(status: number, body: unknown) {
  agreementDeps.fetch = async (path, init) => {
    seen.push({ path, init })
    return new Response(JSON.stringify(body), { status })
  }
}
const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)

describe("/iris/agreements (#192484)", () => {
  it.live("the list keeps every field the panel reads", () =>
    Effect.gen(function* () {
      flApi(200, { summary: { total: 1, awaiting: 1, executed: 0, expiringSoon: 1, revoked: 0 }, agreements: [{ ...ROW, bloqId: 9 }] })
      const res = yield* HttpClientRequest.get("/iris/agreements?case=999001").pipe(HttpClient.execute)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as any
      expect(body.measured).toBe(true)
      expect(body.summary).toEqual({ total: 1, awaiting: 1, executed: 0, expiringSoon: 1, revoked: 0 })
      const row = body.agreements[0]
      for (const k of PANEL_FIELDS) expect(row).toHaveProperty(k)
      expect(row).toMatchObject(ROW)
      expect(row.partyLinks[1]).toEqual(ROW.partyLinks[1])
      expect(seen[0].path).toBe("/api/v1/agreements?subject=case%3A999001")
    }),
  )

  it.live("an unreachable ledger is measured: false, never an empty one", () =>
    Effect.gen(function* () {
      flApi(401, { message: "Unauthenticated." })
      const body = (yield* (yield* HttpClientRequest.get("/iris/agreements").pipe(HttpClient.execute)).json) as any
      expect(body).toMatchObject({ measured: false, reason: "Unauthenticated.", agreements: [] })
    }),
  )

  it.live("detail keeps the document, seal and trail", () =>
    Effect.gen(function* () {
      flApi(200, {
        agreement: ROW,
        document: {
          kind: "Engagement Letter",
          title: "Dana Whitfield",
          reference: "ENGAGEMENT-26584",
          parties: [{ role: "Issuing party", name: "Test Firm LLP", meta: null }],
          preamble: "Pre",
          clauses: [{ heading: "Scope", body: "Body" }],
          endNote: null,
          signatures: [{ role: "Client", name: "Dana Whitfield", method: "typed", signedAt: "2026-11-02" }],
          recordNote: "Issued to dana@example.com",
          integrityNote: null,
          numbered: true,
        },
        seal: { status: "intact", stored: "x", recomputed: "x", chain: "abc", detail: null },
        trail: [{ seq: 7, action: "agreement.sent", ip: "1.2.3.4", at: "2026-11-01" }],
      })
      const body = (yield* (yield* HttpClientRequest.get("/iris/agreements/26584").pipe(HttpClient.execute)).json) as any
      expect(body.measured).toBe(true)
      expect(body.agreement).toMatchObject(ROW)
      expect(body.document.clauses).toEqual([{ heading: "Scope", body: "Body" }])
      expect(body.document.signatures[0]).toEqual({ role: "Client", name: "Dana Whitfield", method: "typed", signedAt: "2026-11-02" })
      expect(body.document.recordNote).toBe("Issued to dana@example.com")
      expect(body.seal).toEqual({ status: "intact", detail: null, chain: "abc" })
      expect(body.trail).toEqual([{ seq: 7, action: "agreement.sent", ip: "1.2.3.4", at: "2026-11-01" }])
    }),
  )

  it.live("raise posts a draft on the case and never issues", () =>
    Effect.gen(function* () {
      flApi(201, { agreement: { ...ROW, status: "draft" } })
      const res = yield* postJson("/iris/agreements", { case: "999001", type: "engagement", name: "Dana Whitfield", firm: "Test Firm LLP" })
      const body = (yield* res.json) as any
      expect(body.agreement.status).toBe("draft")
      expect(JSON.parse(String(seen[0].init?.body))).toMatchObject({ subject_ref: "case:999001", issue: false })
    }),
  )

  it.live("issue and revoke reach the right fl-api routes", () =>
    Effect.gen(function* () {
      flApi(200, { agreement: { ...ROW, status: "revoked" } })
      yield* postJson("/iris/agreements/26584/issue", {})
      const res = yield* postJson("/iris/agreements/26584/revoke", { reason: "engagement ended" })
      expect(((yield* res.json) as any).agreement.status).toBe("revoked")
      expect(seen.map((s) => s.path)).toEqual(["/api/v1/agreements/26584/issue", "/api/v1/agreements/26584/revoke"])
      expect(JSON.parse(String(seen[1].init?.body))).toEqual({ reason: "engagement ended" })
    }),
  )
})
