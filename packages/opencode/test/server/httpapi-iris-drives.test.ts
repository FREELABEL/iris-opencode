import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { driveDeps } from "../../src/iris/drives"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #193705 — Drives through the real route. PR #459: Effect Schema strips undeclared fields silently,
// so every field the panel reads is asserted to arrive. fl-api is mocked.

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


const DRIVE = {
  id: "fs:aaaa",
  label: "BK-01",
  kind: "backup-drive",
  node: "iris-hive-001",
  encrypted: true,
  sizeGb: 931.5,
  usedGb: 412.25,
  freeGb: 519.25,
  files: 120034,
  folders: 3,
  sensitiveFiles: 6,
  lastScanned: "2026-11-09",
  lastSeenOn: "iris-hive-001",
  lastSeenAt: "2026-11-16T03:00:00Z",
  lastBackupAt: "2026-11-16T03:10:00Z",
}
const FOLDER = { id: "fs:aaaa/Projects", driveId: "fs:aaaa", folder: "Projects", mainKind: "video", kinds: "video, audio", files: 900, sizeGb: 88.5, newest: "2026-10-01", sensitiveFiles: 2 }
const FINDING = { id: "f1", driveId: "fs:aaaa", path: "Projects/.env", kind: "credential", sizeKb: 1, status: "contained", found: "2026-11-09", driveEncrypted: true }

const rec = (external_id: string, data: Record<string, unknown>) => ({ id: 1, external_id, data })
const SCHEMAS = { schemas: [
  { slug: "drives", bloq_id: 905 },
  { slug: "drive-folders", bloq_id: 905 },
  // The real account: findings' schema row names another board; its records are on the Drives board.
  { slug: "drive-findings", bloq_id: 913 },
] }
const RECORDS: Record<string, unknown> = {
  drives: rec(DRIVE.id, { label: "BK-01", kind: "backup-drive", node: "iris-hive-001", encrypted: true, size_gb: 931.5, used_gb: "412.25", free_gb: 519.25, files: 120034, folders: 3, sensitive_files: 6, last_scanned: "2026-11-09", last_seen_on: "iris-hive-001", last_seen_at: "2026-11-16T03:00:00Z", last_backup_at: "2026-11-16T03:10:00Z", manifest_key: "SECRET" }),
  "drive-folders": rec(FOLDER.id, { drive_id: "fs:aaaa", folder: "Projects", main_kind: "video", kinds: "video, audio", files: 900, size_gb: 88.5, newest: "2026-10-01", sensitive_files: 2 }),
  "drive-findings": rec(FINDING.id, { drive_id: "fs:aaaa", path: "Projects/.env", kind: "credential", size_kb: 1, status: "contained", found: "2026-11-09", drive_encrypted: true }),
}

let seen: string[] = []
const real = { ...driveDeps }
afterEach(() => {
  Object.assign(driveDeps, real)
  seen = []
})
function flApi(opts: { schemas?: unknown; status?: number; signedIn?: boolean } = {}) {
  driveDeps.userId = async () => (opts.signedIn === false ? null : 7)
  driveDeps.fetch = async (path) => {
    seen.push(path)
    if (opts.status) return new Response("{}", { status: opts.status })
    if (path.startsWith("/api/v1/atlas/schemas")) return Response.json(opts.schemas ?? SCHEMAS)
    const slug = path.match(/datasets\/([^?]+)/)![1]
    return Response.json({ data: { records: { data: [RECORDS[slug]], total: 1 } } })
  }
}
const get = (url: string) => HttpClientRequest.get(url).pipe(HttpClient.execute)

describe("/iris/drives (#193705)", () => {
  it.live("drives and folders keep every field the panel reads; secrets are not passed on", () =>
    Effect.gen(function* () {
      flApi()
      const res = yield* get("/iris/drives")
      expect(res.status).toBe(200)
      const body = (yield* res.json) as any
      expect(body).toMatchObject({ measured: true, state: "ok" })
      expect(body.drives[0]).toEqual(DRIVE)
      expect(body.folders[0]).toEqual(FOLDER)
      expect(JSON.stringify(body)).not.toContain("SECRET")
      // Findings are never in the first payload.
      expect(seen.some((p) => p.includes("drive-findings"))).toBe(false)
    }),
  )

  it.live("findings are read per drive, filtered upstream, under the DRIVES board", () =>
    Effect.gen(function* () {
      flApi()
      const body = (yield* (yield* get("/iris/drives/findings?drive=" + encodeURIComponent("fs:aaaa"))).json) as any
      expect(body).toMatchObject({ measured: true, total: 1, hasMore: false, page: 1 })
      expect(body.findings[0]).toEqual(FINDING)
      const call = seen.find((p) => p.includes("drive-findings"))!
      const q = new URLSearchParams(call.split("?")[1])
      expect(q.get("bloq_id")).toBe("905")
      expect(q.get("filter[drive_id]")).toBe("fs:aaaa")
    }),
  )

  it.live("signed out is a state, never zero drives", () =>
    Effect.gen(function* () {
      flApi({ signedIn: false })
      const body = (yield* (yield* get("/iris/drives")).json) as any
      expect(body).toMatchObject({ measured: false, state: "signed_out", drives: [] })
      expect(seen).toEqual([])
    }),
  )

  it.live("an account that never scanned is no_datasets; an unreachable platform is unreachable", () =>
    Effect.gen(function* () {
      flApi({ schemas: { schemas: [{ slug: "cases", bloq_id: 1 }] } })
      expect((yield* (yield* get("/iris/drives")).json) as any).toMatchObject({ measured: true, state: "no_datasets" })
      flApi({ status: 503 })
      expect((yield* (yield* get("/iris/drives")).json) as any).toMatchObject({ measured: false, state: "unreachable" })
    }),
  )
})
