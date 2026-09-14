import { Effect } from "effect"
import { paginate } from "@/iris/pagination"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { checkAuth, fetchAgents, fetchAtlas, fetchBloqs, fetchHiveNodes, fetchInbox, fetchLeads, fetchIntegrations, fetchPages, fetchPlaybooks, fetchRecords, fetchSchemas, fetchSites, fetchAgentTasks, fetchPlaybookDoc, fetchPageDoc, savePageDoc, fetchCatalog } from "@/iris/platform"
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

    /**
     * The inbox goes through the same envelope as every list, for one reason: the panel renders
     * it with the same code. A second shape here would mean a second "is there more", and the
     * whole point of the pagination service is that there is exactly one.
     *
     * `measured` is false when the manifest is UNREADABLE — present and unparseable, which is a
     * fault, not an empty inbox. A partially unparseable one still counts what it can, and says
     * how much is missing in `reason` rather than quietly returning a shorter list.
     */
    const inbox = Effect.fn("IrisHttpApi.inbox")(
      (ctx: { query: { page?: number; perPage?: number } }) =>
        Effect.sync(() => {
          const r = fetchInbox()
          const { items, meta } = pageOf(
            {
              measured: !r.unreadable,
              reason: r.unreadable
                ? "the inbox manifest could not be parsed"
                : r.unparsed
                  ? `${r.unparsed} manifest ${r.unparsed === 1 ? "line" : "lines"} could not be read and ${r.unparsed === 1 ? "is" : "are"} missing below`
                  : undefined,
            },
            r.items,
            ctx.query,
          )
          return { ...meta, unread: r.unread, from: r.from, unreadable: r.unreadable, items }
        }),
    )

    const atlas = Effect.fn("IrisHttpApi.atlas")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchAtlas(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.lists, ctx.query)
            return { ...meta, lists: items }
          }),
        ),
    )

    /**
     * `mode` narrows BEFORE paging.
     *
     * Filtering the page the client already holds would make "12 of 40" mean "12 of 40 agents,
     * of which some unknown number are scheduled" — a count that describes a different set from
     * the rows under it. Narrowing here keeps `total` a true statement about what is on screen.
     */
    const agents = Effect.fn("IrisHttpApi.agents")(
      (ctx: {
        params: { bloqID: number }
        query: { page?: number; perPage?: number; mode?: "all" | "scheduled" | "ondemand" }
      }) =>
        Effect.promise(() => fetchAgents(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const mode = ctx.query.mode ?? "all"
            const all =
              mode === "scheduled"
                ? r.data.agents.filter((a) => a.heartbeat)
                : mode === "ondemand"
                  ? r.data.agents.filter((a) => !a.heartbeat)
                  : r.data.agents
            const { items, meta } = pageOf(r, all, ctx.query)
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
      (ctx: {
        params: { bloqID: number }
        query: { page?: number; perPage?: number; view?: "all" | "project" | "marketplace" }
      }) =>
        Effect.promise(() => fetchPlaybooks(ctx.params.bloqID, ctx.query.view)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.playbooks, ctx.query)
            return { ...meta, playbooks: items }
          }),
        ),
    )

    /**
     * Records do NOT go through pageOf.
     *
     * Everything else here holds the whole list and slices it; this one is paged by fl-api, so
     * the envelope is built from the upstream's meta instead. Running it through pageOf would
     * slice a 25-row page down to a 25-row page and report `total` as 25 — a number that looks
     * right and says the dataset has 25 rows in it.
     */
    /** Not paged: an agent holding more than a screenful of work is the exception, and the
     *  four sources are already capped upstream (500 item tasks, 200 each of the rest). */
    const catalog = Effect.fn("IrisHttpApi.catalog")(
      (ctx: { query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchCatalog()).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.catalog, ctx.query)
            return { ...meta, catalog: items, attribution: r.data.attribution }
          }),
        ),
    )

    const pageDoc = Effect.fn("IrisHttpApi.pageDoc")((ctx: { params: { pageID: number } }) =>
      Effect.promise(() => fetchPageDoc(ctx.params.pageID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
      ),
    )

    /** The only WRITE in this group. Pinned to a version; see the endpoint description. */
    const pageSave = Effect.fn("IrisHttpApi.pageSave")(
      (ctx: { params: { pageID: number }; payload: { json: string; expectedVersion?: number } }) =>
        Effect.promise(() =>
          savePageDoc({ id: ctx.params.pageID, json: ctx.payload.json, expectedVersion: ctx.payload.expectedVersion }),
        ),
    )

    const playbookDoc = Effect.fn("IrisHttpApi.playbookDoc")((ctx: { params: { name: string } }) =>
      Effect.promise(() => fetchPlaybookDoc(ctx.params.name)).pipe(
        Effect.map((r) => ({ found: r.found, name: ctx.params.name, path: r.path, source: r.source, content: r.content })),
      ),
    )

    const agentTasks = Effect.fn("IrisHttpApi.agentTasks")(
      (ctx: { params: { agentID: number }; query: { includeDone?: string } }) =>
        Effect.promise(() => fetchAgentTasks(ctx.params.agentID, { includeDone: ctx.query.includeDone === "1" })).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, counts: r.data.counts, tasks: r.data.tasks })),
        ),
    )

    const sites = Effect.fn("IrisHttpApi.sites")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchSites(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.sites, ctx.query)
            return { ...meta, sites: items }
          }),
        ),
    )

    const records = Effect.fn("IrisHttpApi.records")(
      (ctx: { params: { bloqID: number; slug: string }; query: { page?: number; perPage?: number } }) =>
        Effect.promise(() => fetchRecords(ctx.params.slug, { ...ctx.query, bloqId: ctx.params.bloqID })).pipe(
          Effect.map((r) => ({
            measured: r.measured,
            reason: r.reason,
            page: r.data.page,
            perPage: r.data.perPage,
            total: r.measured ? r.data.total : null,
            totalIsExact: r.measured ? r.data.totalIsExact : false,
            hasMore: r.measured ? r.data.hasMore : false,
            schema: r.data.schema,
            columns: r.data.columns,
            rows: r.data.rows,
          })),
        ),
    )

    const integrations = Effect.fn("IrisHttpApi.integrations")(
      (ctx: {
        params: { bloqID: number }
        query: { page?: number; perPage?: number; scope?: "all" | "project" | "organization" | "user" }
      }) =>
        Effect.promise(() => fetchIntegrations({ bloqId: ctx.params.bloqID, scope: ctx.query.scope })).pipe(
          Effect.map((r) => {
            const { items, meta } = pageOf(r, r.data.integrations, ctx.query)
            return { ...meta, integrations: items, attribution: r.data.attribution }
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

    return handlers.handle("auth", auth).handle("bloqs", bloqs).handle("inbox", inbox).handle("atlas", atlas).handle("agents", agents).handle("leads", leads).handle("pages", pages).handle("schemas", schemas).handle("playbooks", playbooks).handle("catalog", catalog).handle("pageDoc", pageDoc).handle("pageSave", pageSave).handle("playbookDoc", playbookDoc).handle("agentTasks", agentTasks).handle("sites", sites).handle("records", records).handle("integrations", integrations).handle("hive", hive)
  }),
)
