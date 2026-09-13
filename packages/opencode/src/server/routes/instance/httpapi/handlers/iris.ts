import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { checkAuth, fetchAgents, fetchAtlas, fetchBloqs, fetchHiveNodes, fetchInbox, fetchLeads, fetchIntegrations, fetchPages, fetchPlaybooks, fetchSchemas } from "@/iris/platform"
import { RootHttpApi } from "../api"

/**
 * Handlers for the IRIS platform routes.
 *
 * These sit on RootHttpApi, not InstanceHttpApi, deliberately: Atlas and the Hive belong to the
 * ACCOUNT, not to a workspace or a session. Putting them on the instance API would scope them to
 * whichever project the window happens to have open, which is exactly the bug the TUI's Pages
 * tab had — a per-user list rendered under a project header, unable to change when you switched
 * project.
 *
 * Sitting on RootHttpApi also means they inherit its Authorization middleware rather than
 * inventing their own. These routes return leads-adjacent account data over a localhost socket;
 * "localhost is safe" is an assumption, and the existing middleware is a decision someone
 * already made on purpose.
 */
export const irisHandlers = HttpApiBuilder.group(RootHttpApi, "iris", (handlers) =>
  Effect.gen(function* () {
    const bloqs = Effect.fn("IrisHttpApi.bloqs")(() =>
      Effect.promise(() => fetchBloqs()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, bloqs: r.data.bloqs })),
      ),
    )

    const auth = Effect.fn("IrisHttpApi.auth")(() => Effect.sync(() => checkAuth()))

    const inbox = Effect.fn("IrisHttpApi.inbox")(() => Effect.sync(() => fetchInbox()))

    const atlas = Effect.fn("IrisHttpApi.atlas")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchAtlas(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, lists: r.data.lists })),
      ),
    )

    const agents = Effect.fn("IrisHttpApi.agents")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchAgents(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, agents: r.data.agents })),
      ),
    )

    const leads = Effect.fn("IrisHttpApi.leads")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchLeads(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, leads: r.data.leads })),
      ),
    )

    const pages = Effect.fn("IrisHttpApi.pages")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchPages(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, pages: r.data.pages })),
      ),
    )

    const schemas = Effect.fn("IrisHttpApi.schemas")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchSchemas(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, schemas: r.data.schemas })),
      ),
    )

    const playbooks = Effect.fn("IrisHttpApi.playbooks")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchPlaybooks(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, playbooks: r.data.playbooks })),
      ),
    )

    const integrations = Effect.fn("IrisHttpApi.integrations")(() =>
      Effect.promise(() => fetchIntegrations()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, integrations: r.data.integrations })),
      ),
    )

    const hive = Effect.fn("IrisHttpApi.hive")(() =>
      Effect.promise(() => fetchHiveNodes()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, nodes: r.data.nodes })),
      ),
    )

    return handlers.handle("auth", auth).handle("bloqs", bloqs).handle("inbox", inbox).handle("atlas", atlas).handle("agents", agents).handle("leads", leads).handle("pages", pages).handle("schemas", schemas).handle("playbooks", playbooks).handle("integrations", integrations).handle("hive", hive)
  }),
)
