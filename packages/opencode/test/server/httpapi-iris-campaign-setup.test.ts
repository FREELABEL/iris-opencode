import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { campaignSetupDeps } from "../../src/iris/campaign-setup"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192627 — Desktop › Marketing's "Create your campaign board", through the real routes. Effect Schema
// strips undeclared fields silently (PR #459), so every field the panel reads is asserted to arrive.
// fl-api is a stand-in here: its two calls (the board list, POST /api/v1/campaigns/setup from #192625)
// answer with the shapes on fl-api PR #267, which is not deployed.

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

const realBoards = campaignSetupDeps.boards
const realSetup = campaignSetupDeps.setup
let setupCalls: number[] = []
afterEach(() => {
  campaignSetupDeps.boards = realBoards
  campaignSetupDeps.setup = realSetup
  setupCalls = []
})
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
/** fl-api's setup answer (CampaignProvisioner::provision), as PR #267 returns it. */
const provisioned = (o: { created: boolean; made: boolean; pageCreated?: boolean; datasets?: Record<string, string> }) =>
  json(o.created ? 201 : 200, {
    success: true,
    data: {
      bloq_id: 912,
      created: o.created,
      datasets: o.datasets ?? {
        campaign: o.created ? "created" : "present",
        "campaign-creative": o.created ? "created" : "present",
        "campaign-feedback": o.created ? "created" : "present",
        "campaign-template": o.created ? "created" : "present",
      },
      collections: { campaigns: "campaign" },
      page: { page_slug: "acme-shoes-campaigns", url: "https://heyiris.io/p/acme-shoes-campaigns", made: o.made, created: o.pageCreated ?? false },
    },
  })
function flApi(answer: () => Response) {
  campaignSetupDeps.setup = async (id) => {
    setupCalls.push(id)
    return answer()
  }
}
const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
const setup = (bloq_id: number) =>
  Effect.gen(function* () {
    const res = yield* postJson("/iris/campaigns/setup", { bloq_id })
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })
const boards = () =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get("/iris/campaigns/boards")
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("/iris/campaigns/boards (#192627)", () => {
  it.live("offers boards the account owns or edits, never ones it only views", () =>
    Effect.gen(function* () {
      campaignSetupDeps.boards = async () =>
        json(200, {
          data: [
            { id: 912, name: "Acme Shoes", is_owner: true, user_permission: "owner", lists: [] },
            { id: 40, name: " Client board ", is_owner: false, user_permission: "editor" },
            { id: 41, name: "Read only", is_owner: false, user_permission: "viewer" },
            { id: "x", name: "Broken", is_owner: true },
          ],
        })
      expect(yield* boards()).toEqual({
        measured: true,
        boards: [
          { id: 912, name: "Acme Shoes", role: "owner" },
          { id: 40, name: "Client board", role: "editor" },
        ],
      })
    }),
  )

  it.live("signed out, or a list that cannot be read, says so in plain words", () =>
    Effect.gen(function* () {
      campaignSetupDeps.boards = async () => null
      expect(yield* boards()).toEqual({ measured: false, reason: "Sign in to IRIS first.", boards: [] })
      campaignSetupDeps.boards = async () => json(500, {})
      const r = yield* boards()
      expect(r.measured).toBe(false)
      expect(r.reason).not.toMatch(/\d{3}/)
    }),
  )
})

describe("/iris/campaigns/setup (#192627)", () => {
  it.live("a new board: every field the panel reads arrives", () =>
    Effect.gen(function* () {
      flApi(() => provisioned({ created: true, made: true, pageCreated: true }))
      expect(yield* setup(912)).toEqual({
        ok: true,
        page_slug: "acme-shoes-campaigns",
        url: "https://heyiris.io/p/acme-shoes-campaigns",
        page_created: true,
        page_new: true,
        already_set_up: false,
        datasets: [
          { slug: "campaign", state: "created" },
          { slug: "campaign-creative", state: "created" },
          { slug: "campaign-feedback", state: "created" },
          { slug: "campaign-template", state: "created" },
        ],
      })
      expect(setupCalls).toEqual([912])
    }),
  )

  it.live("run again (idempotent): already set up, same page, nothing new", () =>
    Effect.gen(function* () {
      flApi(() => provisioned({ created: false, made: true, pageCreated: false }))
      const r = yield* setup(912)
      expect(r).toMatchObject({ ok: true, page_slug: "acme-shoes-campaigns", page_created: true, page_new: false, already_set_up: true })
      expect(r.datasets.every((d: { state: string }) => d.state === "present")).toBe(true)
    }),
  )

  it.live("the page hook made nothing yet: the address is reserved, page_created is false", () =>
    Effect.gen(function* () {
      flApi(() => provisioned({ created: true, made: false }))
      expect(yield* setup(912)).toMatchObject({ ok: true, page_slug: "acme-shoes-campaigns", page_created: false, page_new: false })
    }),
  )

  for (const [status, kind] of [
    [403, "not_allowed"],
    [404, "not_deployed"],
    [409, "conflict"],
    [401, "signed_out"],
    [429, "busy"],
    [500, "unreachable"],
    [422, "failed"],
  ] as const) {
    it.live(`fl-api ${status} -> ${kind}, in words without ids or codes`, () =>
      Effect.gen(function* () {
        flApi(() => json(status, { success: false, error: "You can't manage campaigns on board 912. Only its owner…" }))
        const r = yield* setup(912)
        expect(r.ok).toBe(false)
        expect(r.error.kind).toBe(kind)
        expect(r.error.message).not.toMatch(/912|\b\d{3}\b|bloq/i)
        expect(r.page_slug).toBeUndefined()
      }),
    )
  }

  it.live("fl-api unreachable -> unreachable", () =>
    Effect.gen(function* () {
      campaignSetupDeps.setup = async () => {
        throw new Error("ECONNREFUSED")
      }
      expect((yield* setup(912)).error.kind).toBe("unreachable")
    }),
  )

  it.live("no board -> refused before fl-api is asked", () =>
    Effect.gen(function* () {
      flApi(() => provisioned({ created: true, made: true }))
      expect((yield* setup(0)).ok).toBe(false)
      expect(setupCalls).toEqual([])
    }),
  )
})
