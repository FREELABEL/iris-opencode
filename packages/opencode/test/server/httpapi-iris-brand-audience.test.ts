import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { brandDeps, stableJson } from "../../src/iris/brand-kits"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

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

// #194611 — a brand's audience (audience.v1) through the real routes. The platform is a stand-in
// that applies PATCH /brands/{id} the way fl-api does: `metadata` is REPLACED whole. So the test
// that the design tokens, glossary and treatments survive an audience save is a real one.

const META = {
  design_tokens: { colors: { primary: { DEFAULT: "#059669" } } },
  transcription_glossary: "IRIS, Genesis",
  transcript_treatments: [{ name: "standup" }],
}
const AUDIENCE = {
  schema: "audience.v1",
  segments: [
    { id: "studio-owner", name: "Small studio owner", priority: "primary", market: "b2b", firmographics: { company_size: "2-10" }, evidence: { confidence: "observed" } },
  ],
}
type Call = { path: string; method: string; body?: string }
let calls: Call[] = []
let brand: Record<string, any> = {}
const real = { ...brandDeps }
afterEach(() => {
  Object.assign(brandDeps, real)
  calls = []
})
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
function platform(metadata: Record<string, unknown> = { ...structuredClone(META), audience: structuredClone(AUDIENCE) }) {
  brand = { id: 8, name: "Northwind Studio", slug: "northwind", status: "active", personas: [], metadata }
  brandDeps.userId = async () => 193
  brandDeps.fetch = async (path, init) => {
    const method = init?.method ?? "GET"
    calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined })
    if (path === "/api/v1/brands/8" && method === "PATCH") {
      const body = JSON.parse(String(init?.body))
      // BrandController::update → $brand->update($data): metadata is replaced, not merged.
      if (body.metadata) brand.metadata = body.metadata
      return ok(brand)
    }
    if (path === "/api/v1/brands/8") return ok(brand)
    if (path === "/api/v1/brands/8/design-tokens") return ok(brand.metadata?.design_tokens ?? {})
    return new Response("{}", { status: 404 })
  }
}
const patches = () => calls.filter((c) => c.method === "PATCH")
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

describe("/iris/brands/:id/audience (#194611)", () => {
  it.live("the kit carries the audience and what to echo back; the read adds a line per segment", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      expect(kit.audience).toEqual(AUDIENCE)
      expect(kit.audienceRead).toBe(stableJson(AUDIENCE))
      const r = yield* getJson("/iris/brands/8/audience")
      expect(r.measured).toBe(true)
      expect(r.summary).toEqual(["Small studio owner (observed): primary · b2b · 2-10 people"])
      expect(r.errors).toEqual([])
      expect(r.expected).toBe(kit.audienceRead)
    }),
  )

  it.live("a save writes only metadata.audience — design tokens, glossary and treatments are kept", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      const next = structuredClone(AUDIENCE) as any
      next.segments.push({ name: "Weekend maker", market: "b2c", summary: "  ", demographics: { age_band: ["25-34"], locations: [""] }, evidence: { confidence: "assumed" } })
      const r = yield* postJson("/iris/brands/8/audience/save", { audience: next, expected: kit.audienceRead })
      expect(r.ok).toBe(true)
      expect(patches()).toHaveLength(1)
      const sent = JSON.parse(patches()[0]!.body!)
      expect(Object.keys(sent)).toEqual(["metadata"])
      expect(sent.metadata.design_tokens).toEqual(META.design_tokens)
      expect(sent.metadata.transcription_glossary).toBe(META.transcription_glossary)
      expect(sent.metadata.transcript_treatments).toEqual(META.transcript_treatments)
      // Empty text and lists are dropped before it is stored.
      expect(sent.metadata.audience.segments[1]).toEqual({ name: "Weekend maker", market: "b2c", demographics: { age_band: ["25-34"] }, evidence: { confidence: "assumed" } })
      expect(brand.metadata.design_tokens).toEqual(META.design_tokens)
      expect(r.kit.audience.segments).toHaveLength(2)
      expect(r.reason).toBeUndefined()
    }),
  )

  it.live("an invalid audience is refused with paths, and nothing is sent", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      const bad = structuredClone(AUDIENCE) as any
      bad.segments[0].priority = "top"
      bad.segments[0].evidence = {}
      const r = yield* postJson("/iris/brands/8/audience/save", { audience: bad, expected: kit.audienceRead })
      expect(r.ok).toBe(false)
      expect(r.errors.map((e: any) => [e.path, e.code])).toEqual([
        ["segments[0].priority", "enum"],
        ["segments[0].evidence.confidence", "required"],
      ])
      expect(patches()).toHaveLength(0)
    }),
  )

  it.live("a save is refused when the audience moved since it was read", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      brand.metadata.audience.segments[0].name = "Someone else's edit"
      const r = yield* postJson("/iris/brands/8/audience/save", { audience: AUDIENCE, expected: kit.audienceRead })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("changed since you opened")
      expect(patches()).toHaveLength(0)
    }),
  )

  it.live("a brand with no audience reads as none, and its first save keeps the rest of its metadata", () =>
    Effect.gen(function* () {
      platform(structuredClone(META))
      const { kit } = yield* getJson("/iris/brands/8")
      expect(kit.audience).toBeUndefined()
      expect(kit.audienceRead).toBe("null")
      expect((yield* getJson("/iris/brands/8/audience")).summary).toEqual([])
      const r = yield* postJson("/iris/brands/8/audience/save", { audience: AUDIENCE, expected: "null" })
      expect(r.ok).toBe(true)
      expect(Object.keys(brand.metadata).sort()).toEqual(["audience", "design_tokens", "transcript_treatments", "transcription_glossary"])
    }),
  )

  it.live("key order in the platform's JSON does not break the pin", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      // A JSON column hands keys back in its own order.
      brand.metadata.audience = JSON.parse(JSON.stringify({ segments: AUDIENCE.segments, schema: AUDIENCE.schema }))
      const r = yield* postJson("/iris/brands/8/audience/save", { audience: AUDIENCE, expected: kit.audienceRead })
      expect(r.ok).toBe(true)
    }),
  )
})
