import { Effect } from "effect"
import { filterRows, paginate } from "@/iris/pagination"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { filterAtlas, checkAuth, fetchAgents, fetchAtlas, fetchBloqs, fetchHiveNodes, fetchInbox, fetchLeads, fetchIntegrations, fetchPages, fetchPlaybooks, fetchRecords, fetchSchemas, fetchSites, fetchAgentTasks, fetchPlaybookDoc, fetchPageDoc, savePageDoc, fetchItem, saveItem, addItemTask, saveItemTask, deleteItemTask, fetchCardSchema, fetchShareState, setShareVisibility, setShareAllowlist, inviteMember, setMemberPermission, revokeMember, createShareLink, revokeShareLink, setItemLabels, fetchAttachments, uploadAttachment, deleteAttachment, fetchEvents, addEvent, fetchAsks, addAsk, answerAsk, fetchItemChat, sendItemChat, fetchCatalog, fetchBloqGraph, fetchBloqInterior, graphRows } from "@/iris/platform"
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
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number; q?: string } }) =>
        Effect.promise(() => fetchAtlas(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            // Filter BEFORE paging — see filterAtlas. Filtering after would count a page.
            const lists = ctx.query.q ? filterAtlas(r.data.lists, ctx.query.q) : r.data.lists
            const { items, meta } = pageOf(r, lists, ctx.query)
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
        query: { page?: number; perPage?: number; q?: string; mode?: "all" | "scheduled" | "ondemand" }
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
            const rows = filterRows(all, ctx.query.q, (a) => [a.name, a.status, a.model, a.description, a.schedule])
            const { items, meta } = pageOf(r, rows, ctx.query)
            return { ...meta, agents: items }
          }),
        ),
    )

    const leads = Effect.fn("IrisHttpApi.leads")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number; q?: string } }) =>
        Effect.promise(() => fetchLeads(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const rows = filterRows(r.data.leads, ctx.query.q, (l) => [l.name, l.company, l.email, l.status, l.city])
            const { items, meta } = pageOf(r, rows, ctx.query)
            return { ...meta, leads: items }
          }),
        ),
    )

    const pages = Effect.fn("IrisHttpApi.pages")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number; q?: string } }) =>
        Effect.promise(() => fetchPages(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            const rows = filterRows(r.data.pages, ctx.query.q, (p) => [p.title, p.slug, p.status, p.category])
            const { items, meta } = pageOf(r, rows, ctx.query)
            return { ...meta, pages: items }
          }),
        ),
    )

    const schemas = Effect.fn("IrisHttpApi.schemas")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number; q?: string } }) =>
        Effect.promise(() => fetchSchemas(ctx.params.bloqID)).pipe(
          Effect.map((r) => {
            // Field names too: "which dataset has patient_name" is a real question.
            const rows = filterRows(r.data.schemas, ctx.query.q, (s) => [
              s.name,
              s.slug,
              ...s.fields.map((f) => f.key),
              ...s.fields.map((f) => f.label),
            ])
            const { items, meta } = pageOf(r, rows, ctx.query)
            return { ...meta, schemas: items }
          }),
        ),
    )

    const playbooks = Effect.fn("IrisHttpApi.playbooks")(
      (ctx: {
        params: { bloqID: number }
        query: { page?: number; perPage?: number; q?: string; view?: "all" | "project" | "marketplace" }
      }) =>
        Effect.promise(() => fetchPlaybooks(ctx.params.bloqID, ctx.query.view)).pipe(
          Effect.map((r) => {
            // Description as well as name: playbooks are FOUND by what they do, and the name is
            // a slug. "restaurant-booking-cancel" is not how anyone looks for it.
            const rows = filterRows(r.data.playbooks, ctx.query.q, (p) => [
              p.name,
              p.description,
              p.scope,
              ...p.steps.map((s) => s.title),
            ])
            const { items, meta } = pageOf(r, rows, ctx.query)
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
    const graph = Effect.fn("IrisHttpApi.graph")((ctx: { query: { page?: number; perPage?: number } }) =>
      Effect.promise(() => fetchBloqGraph()).pipe(
        Effect.map((r) => {
          const { items, meta } = pageOf(r, graphRows(r.data), ctx.query)
          return { ...meta, summary: r.data.summary, rows: items }
        }),
      ),
    )

    /** Not paged: a board's interior is one picture. Slicing it would draw half a graph. */
    const graphBoard = Effect.fn("IrisHttpApi.graphBoard")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchBloqInterior(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, nodes: r.data.nodes, edges: r.data.edges, unread: r.data.unread })),
      ),
    )

    const catalog = Effect.fn("IrisHttpApi.catalog")(
      (ctx: { query: { page?: number; perPage?: number; q?: string } }) =>
        Effect.promise(() => fetchCatalog()).pipe(
          Effect.map((r) => {
            const rows = filterRows(r.data.catalog, ctx.query.q, (c) => [c.name, c.type, c.category, c.description])
            const { items, meta } = pageOf(r, rows, ctx.query)
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

    const item = Effect.fn("IrisHttpApi.item")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchItem(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
      ),
    )

    /** The card editor's writes. Field-scoped, so a title save cannot blank a body. */
    const itemSave = Effect.fn("IrisHttpApi.itemSave")(
      (ctx: {
        params: { itemID: number }
        payload: {
          title?: string
          body?: string
          bodyMode?: "replace" | "merge"
          status?: string
          priority?: string | null
          cardType?: string | null
          dueDate?: string | null
          listId?: number
        }
      }) => Effect.promise(() => saveItem(ctx.params.itemID, ctx.payload)),
    )

    const itemTaskAdd = Effect.fn("IrisHttpApi.itemTaskAdd")(
      (ctx: { params: { itemID: number }; payload: { title: string; agentId?: number; dueDate?: string } }) =>
        Effect.promise(() => addItemTask(ctx.params.itemID, ctx.payload)),
    )

    const itemTaskSave = Effect.fn("IrisHttpApi.itemTaskSave")(
      (ctx: { params: { itemID: number; taskID: number }; payload: { done?: boolean; title?: string } }) =>
        Effect.promise(() => saveItemTask(ctx.params.itemID, ctx.params.taskID, ctx.payload)),
    )

    const itemTaskDelete = Effect.fn("IrisHttpApi.itemTaskDelete")(
      (ctx: { params: { itemID: number; taskID: number } }) =>
        Effect.promise(() => deleteItemTask(ctx.params.itemID, ctx.params.taskID)),
    )

    const cardSchema = Effect.fn("IrisHttpApi.cardSchema")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchCardSchema(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
      ),
    )

    // ── Card editor, second pass (#185506) ──
    const itemShare = Effect.fn("IrisHttpApi.itemShare")((ctx: { params: { itemID: number }; query: { bloq?: number } }) =>
      Effect.promise(() => fetchShareState(ctx.params.itemID, ctx.query.bloq)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
      ),
    )
    const itemShareVisibility = Effect.fn("IrisHttpApi.itemShareVisibility")((ctx: { params: { itemID: number }; payload: { public: boolean } }) =>
      Effect.promise(() => setShareVisibility(ctx.params.itemID, ctx.payload.public)),
    )
    const itemShareAllowlist = Effect.fn("IrisHttpApi.itemShareAllowlist")((ctx: { params: { itemID: number }; payload: { emails: readonly string[] } }) =>
      Effect.promise(() => setShareAllowlist(ctx.params.itemID, [...ctx.payload.emails])),
    )
    const itemShareInvite = Effect.fn("IrisHttpApi.itemShareInvite")((ctx: { payload: { email: string; permission: string; bloq: number } }) =>
      Effect.promise(() => inviteMember(ctx.payload.bloq, ctx.payload.email, ctx.payload.permission)),
    )
    const itemSharePermission = Effect.fn("IrisHttpApi.itemSharePermission")((ctx: { payload: { userId: number; permission: string; bloq: number } }) =>
      Effect.promise(() => setMemberPermission(ctx.payload.bloq, ctx.payload.userId, ctx.payload.permission)),
    )
    const itemShareRevoke = Effect.fn("IrisHttpApi.itemShareRevoke")((ctx: { payload: { userId: number; bloq: number } }) =>
      Effect.promise(() => revokeMember(ctx.payload.bloq, ctx.payload.userId)),
    )
    const itemShareLink = Effect.fn("IrisHttpApi.itemShareLink")((ctx: { payload: { bloq: number; expiresInDays?: number } }) =>
      Effect.promise(() => createShareLink(ctx.payload.bloq, ctx.payload.expiresInDays)),
    )
    const itemShareLinkRevoke = Effect.fn("IrisHttpApi.itemShareLinkRevoke")((ctx: { params: { linkID: string }; payload: { bloq: number } }) =>
      Effect.promise(() => revokeShareLink(ctx.payload.bloq, ctx.params.linkID)),
    )
    const itemLabels = Effect.fn("IrisHttpApi.itemLabels")((ctx: { params: { itemID: number }; payload: { labels: readonly string[] } }) =>
      Effect.promise(() => setItemLabels(ctx.params.itemID, [...ctx.payload.labels])).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, labels: r.data.labels })),
      ),
    )
    const itemAttachments = Effect.fn("IrisHttpApi.itemAttachments")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchAttachments(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, files: r.data.files })),
      ),
    )
    const itemAttachmentUpload = Effect.fn("IrisHttpApi.itemAttachmentUpload")(
      (ctx: { params: { itemID: number }; payload: { name: string; type?: string; data: string; bloq?: number } }) =>
        Effect.promise(() => uploadAttachment(ctx.params.itemID, { name: ctx.payload.name, type: ctx.payload.type, data: ctx.payload.data, bloqId: ctx.payload.bloq })),
    )
    const itemAttachmentDelete = Effect.fn("IrisHttpApi.itemAttachmentDelete")((ctx: { params: { itemID: number; fileID: string } }) =>
      Effect.promise(() => deleteAttachment(ctx.params.itemID, ctx.params.fileID)),
    )
    const itemEvents = Effect.fn("IrisHttpApi.itemEvents")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchEvents(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, events: r.data.events })),
      ),
    )
    const itemEventAdd = Effect.fn("IrisHttpApi.itemEventAdd")((ctx: { params: { itemID: number }; payload: { title: string; startsAt: string; endsAt?: string } }) =>
      Effect.promise(() => addEvent(ctx.params.itemID, ctx.payload)),
    )
    const itemAsks = Effect.fn("IrisHttpApi.itemAsks")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchAsks(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, asks: r.data.asks })),
      ),
    )
    const itemAskAdd = Effect.fn("IrisHttpApi.itemAskAdd")((ctx: { params: { itemID: number }; payload: { to: string; what: string; dueAt?: string } }) =>
      Effect.promise(() => addAsk(ctx.params.itemID, ctx.payload)),
    )
    const itemAskAnswer = Effect.fn("IrisHttpApi.itemAskAnswer")((ctx: { params: { itemID: number; askID: number }; payload: { answer?: string } }) =>
      Effect.promise(() => answerAsk(ctx.params.itemID, ctx.params.askID, ctx.payload.answer)),
    )
    const itemChat = Effect.fn("IrisHttpApi.itemChat")((ctx: { params: { itemID: number }; query: { bloq?: number } }) =>
      Effect.promise(() => fetchItemChat(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, agentId: r.data.agentId, messages: r.data.messages })),
      ),
    )
    const itemChatSend = Effect.fn("IrisHttpApi.itemChatSend")((ctx: { params: { itemID: number }; payload: { agentId: number; text: string; bloq?: number } }) =>
      Effect.promise(() => sendItemChat(ctx.params.itemID, { agentId: ctx.payload.agentId, text: ctx.payload.text, bloqId: ctx.payload.bloq })),
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
        query: { page?: number; perPage?: number; q?: string; scope?: "all" | "project" | "organization" | "user" }
      }) =>
        Effect.promise(() => fetchIntegrations({ bloqId: ctx.params.bloqID, scope: ctx.query.scope })).pipe(
          Effect.map((r) => {
            const rows = filterRows(r.data.integrations, ctx.query.q, (i) => [i.name, i.type, i.category, i.account])
            const { items, meta } = pageOf(r, rows, ctx.query)
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

    return handlers.handle("auth", auth).handle("bloqs", bloqs).handle("inbox", inbox).handle("atlas", atlas).handle("agents", agents).handle("leads", leads).handle("pages", pages).handle("schemas", schemas).handle("playbooks", playbooks).handle("graph", graph).handle("graphBoard", graphBoard).handle("catalog", catalog).handle("pageDoc", pageDoc).handle("pageSave", pageSave).handle("item", item).handle("itemSave", itemSave).handle("itemTaskAdd", itemTaskAdd).handle("itemTaskSave", itemTaskSave).handle("itemTaskDelete", itemTaskDelete).handle("cardSchema", cardSchema).handle("itemShare", itemShare).handle("itemShareVisibility", itemShareVisibility).handle("itemShareAllowlist", itemShareAllowlist).handle("itemShareInvite", itemShareInvite).handle("itemSharePermission", itemSharePermission).handle("itemShareRevoke", itemShareRevoke).handle("itemShareLink", itemShareLink).handle("itemShareLinkRevoke", itemShareLinkRevoke).handle("itemLabels", itemLabels).handle("itemAttachments", itemAttachments).handle("itemAttachmentUpload", itemAttachmentUpload).handle("itemAttachmentDelete", itemAttachmentDelete).handle("itemEvents", itemEvents).handle("itemEventAdd", itemEventAdd).handle("itemAsks", itemAsks).handle("itemAskAdd", itemAskAdd).handle("itemAskAnswer", itemAskAnswer).handle("itemChat", itemChat).handle("itemChatSend", itemChatSend).handle("playbookDoc", playbookDoc).handle("agentTasks", agentTasks).handle("sites", sites).handle("records", records).handle("integrations", integrations).handle("hive", hive)
  }),
)
