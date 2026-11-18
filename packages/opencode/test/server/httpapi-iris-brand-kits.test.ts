import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { brandDeps } from "../../src/iris/brand-kits"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192667 — Genesis › Brand kits, the editor, through the real routes. Effect Schema strips undeclared
// fields silently, so every field the editor reads is asserted to arrive. The platform is replaced by
// the IRIS kit's shape as fl-api returned it on 2026-11-05; writes are asserted by the calls they
// make — nothing reaches a real brand.

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

const TOKENS = {
  brand: {
    name: "IRIS",
    logo: { primary: "https://freelabel.net/images/iris-logo-white-transparent.png", on_light: "https://freelabel.net/images/iris-logo-dark.png", on_dark: "https://freelabel.net/images/iris-logo-white-transparent.png" },
    voice: "Confident, technical but approachable.",
    tone: "Professional yet bold.",
  },
  colors: { accent: { DEFAULT: "#f59e0b" }, background: { DEFAULT: "#000000" } },
  typography: { "font-family": { family: "Inter, sans-serif" }, "font-size-lg": { family: "1.125rem" } },
  motion: { ease: "cubic-bezier(.45,0,.15,1)", spring: { damping: 26, stiffness: 170 }, character: "smooth", duration_ms: 320 },
}
type Call = { path: string; method: string; body?: string }
let calls: Call[] = []
let tokens: Record<string, any> = structuredClone(TOKENS)
let uploads: FormData[] = []
const real = { ...brandDeps }
afterEach(() => {
  Object.assign(brandDeps, real)
  calls = []
  uploads = []
  tokens = structuredClone(TOKENS)
})
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
/** fl-api as it answered, applying a PATCH the way mergeForUpdate does: each section sent replaces the stored one. */
function platform() {
  brandDeps.userId = async () => 193
  brandDeps.fetch = async (path, init) => {
    const method = init?.method ?? "GET"
    calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined })
    if (path === "/api/v1/brands/8") return ok({ id: 8, name: "IRIS", slug: "iris", status: "active", personas: [] })
    if (path === "/api/v1/brands/8/design-tokens" && method === "PATCH") {
      tokens = { ...tokens, ...JSON.parse(String(init?.body)) }
      return ok(tokens)
    }
    if (path === "/api/v1/brands/8/design-tokens") return ok(tokens)
    return new Response("{}", { status: 404 })
  }
  brandDeps.upload = async (form) => {
    uploads.push(form)
    return new Response(JSON.stringify({ success: true, data: { id: 991, url: "https://cdn.heyiris.io/cloud-files/991_logo.png", filepath: "https://cdn.heyiris.io/cloud-files/991_logo.png" } }), { status: 200 })
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

describe("/iris/brands/:id (#192667)", () => {
  it.live("the kit arrives with every field the editor reads", () =>
    Effect.gen(function* () {
      platform()
      const { measured, kit } = yield* getJson("/iris/brands/8")
      expect(measured).toBe(true)
      expect(kit.logos).toEqual(TOKENS.brand.logo)
      expect(kit.voice).toBe(TOKENS.brand.voice)
      expect(kit.tone).toBe(TOKENS.brand.tone)
      expect(kit.fontSection).toBe("typography")
      expect(kit.motion).toEqual({ ease: "cubic-bezier(.45,0,.15,1)", durationMs: 320, character: "smooth", stiffness: 170, damping: 26 })
      expect(Object.keys(kit.sections).sort()).toEqual(["brand", "colors", "font", "fonts", "motion", "typography"])
    }),
  )

  it.live("a save sends every changed section in ONE PATCH, pinned, and returns what the server now holds", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      const colors = { ...tokens.colors, accent: { DEFAULT: "#ff3366" } }
      const brand = { ...tokens.brand, voice: "Plain." }
      const r = yield* postJson("/iris/brands/8/save", {
        changes: { colors, brand },
        expected: { colors: kit.sections.colors, brand: kit.sections.brand },
      })
      expect(r.ok).toBe(true)
      expect(r.saved).toEqual(["colors", "brand"])
      expect(patches()).toHaveLength(1)
      expect(Object.keys(JSON.parse(patches()[0].body!))).toEqual(["colors", "brand"])
      expect(r.kit.colors.find((c: any) => c.name === "accent").value).toBe("#ff3366")
      expect(r.kit.voice).toBe("Plain.")
      expect(r.kit.logos.on_light).toBe(TOKENS.brand.logo.on_light) // the rest of brand survived
    }),
  )

  it.live("a save is refused whole when any section moved since it was read — nothing is written", () =>
    Effect.gen(function* () {
      platform()
      const { kit } = yield* getJson("/iris/brands/8")
      tokens.brand = { ...tokens.brand, tone: "someone else's edit" }
      const r = yield* postJson("/iris/brands/8/save", {
        changes: { colors: { accent: { DEFAULT: "#ff3366" } }, brand: { ...TOKENS.brand, voice: "x" } },
        expected: { colors: kit.sections.colors, brand: kit.sections.brand },
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("brand changed since you opened")
      expect(patches()).toHaveLength(0)
    }),
  )

  it.live("a bad value is refused before anything is read or written", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/brands/8/save", { changes: { colors: { accent: { DEFAULT: "orange-ish" } } }, expected: { colors: "{}" } })
      expect(r).toMatchObject({ ok: false })
      expect(r.reason).toContain('"accent"')
      const r2 = yield* postJson("/iris/brands/8/save", { changes: { colors: { accent: "#fff" } }, expected: {} })
      expect(r2.reason).toContain("without what it replaces")
      expect(calls).toHaveLength(0)
    }),
  )

  it.live("a logo upload goes to cloud files with the brand's id and returns a URL — the kit is untouched", () =>
    Effect.gen(function* () {
      platform()
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64")
      const r = yield* postJson("/iris/brands/8/logo", { name: "mark.png", type: "image/png", data: `data:image/png;base64,${png}`, variant: "on_light" })
      expect(r).toEqual({ ok: true, url: "https://cdn.heyiris.io/cloud-files/991_logo.png", fileId: 991 })
      expect(uploads).toHaveLength(1)
      expect(uploads[0].get("brand_id")).toBe("8")
      expect(uploads[0].get("type")).toBe("digital_product")
      expect(uploads[0].get("user_id")).toBe("193")
      expect(calls).toHaveLength(0)
      const bad = yield* postJson("/iris/brands/8/logo", { name: "x.pdf", type: "application/pdf", data: png })
      expect(bad.ok).toBe(false)
      expect(uploads).toHaveLength(1)
    }),
  )

  it.live("the logo probe returns an image as a data URL, and refuses what is not one", () =>
    Effect.gen(function* () {
      platform()
      const seen: string[] = []
      brandDeps.probe = async (url) => {
        seen.push(String(url))
        if (String(url).endsWith(".png")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })
        return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
      }
      const r = yield* getJson(`/iris/brand-logo/probe?url=${encodeURIComponent("https://freelabel.net/a.png")}`)
      expect(r).toMatchObject({ ok: true, status: 200, contentType: "image/png", bytes: 3, dataUrl: "data:image/png;base64,AQID" })
      expect((yield* getJson(`/iris/brand-logo/probe?url=${encodeURIComponent("https://freelabel.net/")}`)).reason).toContain("not an image")
      expect((yield* getJson(`/iris/brand-logo/probe?url=${encodeURIComponent("http://127.0.0.1:4096/")}`)).ok).toBe(false)
      expect(seen).toEqual(["https://freelabel.net/a.png", "https://freelabel.net/"])
    }),
  )
})
