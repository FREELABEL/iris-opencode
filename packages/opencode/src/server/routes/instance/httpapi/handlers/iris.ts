import { Effect } from "effect"
import { paginate } from "@/iris/pagination"
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
/**
 * Fold a PlatformResult into the wire envelope: measured flags + the page.
 *
 * One helper rather than eight inline slices — the whole reason pagination is a service is that
 * "how many are there" must mean the same thing on every surface.
 */
const pageOf = <T>(
  r: { measured: boolean; reason?: string },
  all: T[],
  q: { page?: number; perPage?: number },
) => {
  const p = paginate(all, q)
  return {
    items: p.items,
    meta: {
      measured: r.measured,
      reason: r.reason,
      page: p.page,
      perPage: p.perPage,
      // Nothing to count when the fetch failed — null, not 0, so a client cannot render
      // "0 results" for "we could not look".
      total: r.measured ? p.total : null,
      totalIsExact: r.measured ? p.totalIsExact : false,
      hasMore: r.measured ? p.hasMore : false,
    },
  }
}

export const irisHandlers = HttpApiBuilder.group(RootHttpApi, "iris", (handlers) =>
  Effect.gen(function* () {
    const bloqs = Effect.fn("IrisHttpApi.bloqs")(
      (ctx: { query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchBloqs()).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.bloqs, ctx.query)
            return { ...meta, bloqs: items }
          }),
        ),
    )

    const auth = Effect.fn("IrisHttpApi.auth")(() => Effect.sync(() => checkAuth()))

    const inbox = Effect.fn("IrisHttpApi.inbox")(() => Effect.sync(() => fetchInbox()))

    const atlas = Effect.fn("IrisHttpApi.atlas")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchAtlas(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.lists, ctx.query)
            return { ...meta, lists: items }
          }),
        ),
    )

    const agents = Effect.fn("IrisHttpApi.agents")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchAgents(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.agents, ctx.query)
            return { ...meta, agents: items }
          }),
        ),
    )

    const leads = Effect.fn("IrisHttpApi.leads")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchLeads(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.leads, ctx.query)
            return { ...meta, leads: items }
          }),
        ),
    )

    const pages = Effect.fn("IrisHttpApi.pages")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchPages(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.pages, ctx.query)
            return { ...meta, pages: items }
          }),
        ),
    )

    const schemas = Effect.fn("IrisHttpApi.schemas")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchSchemas(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.schemas, ctx.query)
            return { ...meta, schemas: items }
          }),
        ),
    )

    const playbooks = Effect.fn("IrisHttpApi.playbooks")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchPlaybooks(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.playbooks, ctx.query)
            return { ...meta, playbooks: items }
          }),
        ),
    )

    const integrations = Effect.fn("IrisHttpApi.integrations")(
      (ctx: { query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchIntegrations()).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.integrations, ctx.query)
            return { ...meta, integrations: items }
          }),
        ),
    )

    const hive = Effect.fn("IrisHttpApi.hive")(
      (ctx: { query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchHiveNodes()).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.nodes, ctx.query)
            return { ...meta, nodes: items }
          }),
        ),
    )

    return handlers.handle("auth", auth).handle("bloqs", bloqs).handle("inbox", inbox).handle("atlas", atlas).handle("agents", agents).handle("leads", leads).handle("pages", pages).handle("schemas", schemas).handle("playbooks", playbooks).handle("integrations", integrations).handle("hive", hive)
  }),
)
