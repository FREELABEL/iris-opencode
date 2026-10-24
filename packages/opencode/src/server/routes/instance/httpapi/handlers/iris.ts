import { fetchBrandKit, fetchBrands, saveBrandSection } from "@/iris/brand-kits"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import * as Sse from "effect/unstable/encoding/Sse"
import { filterRows, paginate } from "@/iris/pagination"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  filterAtlas,
  checkAuth,
  fetchAgents,
  fetchAtlas,
  fetchBloqs,
  fetchHiveNodes,
  fetchInbox,
  readInboxMessage,
  markInboxRead,
  fetchLeads,
  fetchIntegrations,
  fetchPages,
  fetchPlaybooks,
  fetchRecords,
  fetchSchemas,
  fetchSites,
  fetchAgentTasks,
  fetchPlaybookDoc,
  fetchPageDoc,
  savePageDoc,
  fetchItem,
  saveItem,
  createItem,
  createList,
  fetchBoardMembers,
  fetchActivity,
  fetchMyAgents,
  addComment,
  notifySettings,
  fetchAssignees,
  assign,
  unassign,
  moveItem,
  addItemTask,
  saveItemTask,
  deleteItemTask,
  fetchCardSchema,
  fetchShareState,
  setShareVisibility,
  setShareAllowlist,
  inviteMember,
  setMemberPermission,
  revokeMember,
  createShareLink,
  revokeShareLink,
  setItemLabels,
  fetchAttachments,
  uploadAttachment,
  deleteAttachment,
  fetchEvents,
  addEvent,
  fetchAsks,
  addAsk,
  answerAsk,
  fetchItemChat,
  sendItemChat,
  fetchCatalog,
  fetchBloqGraph,
  fetchBloqInterior,
  graphRows,
  fetchAllowance,
  fetchSecurity,
  reportGateEvent,
  setGateChoice,
  fetchPlan,
  fetchMe,
  tokenSource,
  resolveToken,
  dataDir,
  resetCredentialCache,
  fetchPlans,
  createCheckout,
} from "@/iris/platform"
import { parseExpandedListIds } from "@/iris/relationship-graph"
import { resolveDelivery, sendInboxMessage, setInboxState } from "@/iris/inbox-actions"
import {
  accountRef,
  agentCredential,
  cliDataDir,
  credentialKind,
  forgetActiveAccount,
  readAccountStore,
  readNodeKey,
  registerAccount,
  removeAccount,
  signOutPersonal,
  switchAccount,
  type CredentialKind,
} from "@/iris/account"
import { homedir } from "os"
import { createRoom, fetchRoom, fetchRooms, sendRoomMessage } from "@/iris/rooms"
import { fetchAgentLive, handBackRun, takeOverRun } from "@/iris/agent-live"
import { RootHttpApi } from "../api"
import { PanelCommandPayload, PanelStatePayload } from "../groups/iris"
import { markLocal, playbookRows, projectRoot } from "@/iris/playbook-local"
import { Artifacts } from "@/iris/artifacts"
import { Panel } from "@/iris/panel"
import { atlasNoteUrl, probeAtlasNote, type NoteProbe } from "@/iris/atlas-note"
import { frameTarget, probeFrame } from "@/iris/frame-check"
import { startIntegrationConnect } from "@/iris/platform"
import { readAtlasBoardWithEdits, readBoardList } from "@/iris/atlas-board-read"
import { createCard, moveCard, saveCard } from "@/iris/atlas-write"
import { resolveUserId } from "@/iris/platform"
import { counts as outboxCounts, replay as replayOutbox, resolve as resolveOutbox } from "@/iris/atlas-outbox"
import { readLocalCopySettings, writeLocalCopySettings } from "@/iris/atlas-local-copy"
import { buildCommandReport, submitCommandReport } from "@/iris/bug-report"
import * as Onboarding from "@/iris/onboarding"
import * as Capabilities from "@/iris/onboarding-capabilities"
import { searchCliCommands } from "@/iris/cli-commands"
import { fetchHivePeers } from "@/iris/platform"
import { watchAtlas, watchMe, type AtlasLiveEvent, type MeLiveEvent } from "@/iris/atlas-live"
import { publishArtifact } from "@/iris/artifact-publish"
import { runPlaybookInstall, ttlCache } from "@/iris/playbook-install"
import * as HiveScripts from "@/iris/hive-scripts"
import * as HiveSessions from "@/iris/hive-sessions"
import { fetchHeartbeats, runHeartbeat, setHeartbeatPaused } from "@/iris/heartbeats"
import { fetchPulseContact, fetchPulseContacts, fetchPulseTopic } from "@/iris/pulse"

/**
 * The board + account playbook list, cached for a minute per board/view (#186279). The handler
 * used to re-fetch the whole account set from the API for EVERY search query (~3 s each) and then
 * filter it in memory. "Installed here" is NOT cached — it is recomputed from disk per request.
 * An install clears it.
 */
// Live notes only, for ten minutes: a private note may be published a minute from now, and a
// network failure says nothing about the note, so neither is remembered.
const liveNotes = new Map<string, { at: number; probe: NoteProbe }>()
const LIVE_NOTE_TTL_MS = 10 * 60_000

const playbookLists = ttlCache<string, Awaited<ReturnType<typeof fetchPlaybooks>>>(60_000)

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
const pageOf = <T>(r: { measured: boolean; reason?: string }, all: T[], q: { page?: number; perPage?: number }) => {
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
    const bloqs = Effect.fn("IrisHttpApi.bloqs")((ctx: { query: { page?: number; perPage?: number } }) =>
      Effect.promise(() => readBoardList()).pipe(
        Effect.map(({ r, offline, copiedAt }) => {
          const { items, meta } = pageOf(r, r.data.bloqs, ctx.query)
          return { ...meta, bloqs: items, ...(offline ? { offline, copiedAt } : {}) }
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
    const inbox = Effect.fn("IrisHttpApi.inbox")((ctx: { query: { page?: number; perPage?: number } }) =>
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

    const inboxMessage = Effect.fn("IrisHttpApi.inboxMessage")(
      (ctx: { params: { index: number }; query: { id?: string } }) =>
        Effect.sync(() => readInboxMessage(ctx.params.index, ctx.query.id)),
    )
    const inboxRead = Effect.fn("IrisHttpApi.inboxRead")((ctx: { params: { index: number }; payload: { id?: string } }) =>
      Effect.promise(() => markInboxRead(ctx.params.index, ctx.payload.id)),
    )
    const inboxState = Effect.fn("IrisHttpApi.inboxState")(
      (ctx: { params: { index: number }; payload: { id?: string; read?: boolean; done?: boolean; resolveCard?: boolean } }) =>
        Effect.promise(() => setInboxState(ctx.params.index, ctx.payload)),
    )
    const inboxSend = Effect.fn("IrisHttpApi.inboxSend")((ctx: { payload: { to: string; text: string; replyTo?: string } }) =>
      Effect.promise(() => sendInboxMessage(ctx.payload)),
    )
    // Each unresolved sent row asks the platform what became of its task (#190982).
    const inboxSent = Effect.fn("IrisHttpApi.inboxSent")(() =>
      Effect.promise(async () => {
        const r = await resolveDelivery()
        return {
          measured: true,
          ...(r.unparsed ? { reason: `${r.unparsed} sent ${r.unparsed === 1 ? "line" : "lines"} could not be read` } : {}),
          items: r.rows.slice(-500),
        }
      }),
    )

    const atlas = Effect.fn("IrisHttpApi.atlas")(
      (ctx: { params: { bloqID: number }; query: { page?: number; perPage?: number; q?: string; fresh?: string } }) =>
        Effect.promise(() => readAtlasBoardWithEdits(ctx.params.bloqID, ctx.query)).pipe(
          Effect.map(({ r, source, copiedAt, offline, sync, outbox }) => {
            // Filter BEFORE paging — see filterAtlas. Filtering after would count a page.
            const lists = ctx.query.q ? filterAtlas(r.data.lists, ctx.query.q) : r.data.lists
            const { items, meta } = pageOf(r, lists, ctx.query)
            return {
              ...meta,
              lists: items,
              source,
              ...(copiedAt ? { copiedAt } : {}),
              ...(offline ? { offline } : {}),
              ...(sync ? { sync } : {}),
              ...(outbox ? { outbox } : {}),
            }
          }),
        ),
    )

    /**
     * Atlas, live (#189767). Carries no board data, only "it changed" — the panel re-reads the
     * board through the route above, so there is one path that turns fl-api into rows.
     */
    const atlasLive = Effect.fn("IrisHttpApi.atlasLive")((ctx: { params: { bloqID: number } }) =>
      Effect.sync(() => {
        const events = Stream.callback<AtlasLiveEvent>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => watchAtlas(ctx.params.bloqID, (e) => Queue.offerUnsafe(queue, e))),
            (stop) => Effect.sync(stop),
          ),
        )
        const ping = Stream.tick("25 seconds").pipe(
          Stream.drop(1),
          Stream.map((): Sse.Event => ({ _tag: "Event", event: "ping", id: undefined, data: "{}" })),
        )
        const ready: Sse.Event = { _tag: "Event", event: "ready", id: undefined, data: "{}" }
        return HttpServerResponse.stream(
          Stream.make(ready).pipe(
            Stream.concat(
              events.pipe(
                Stream.map((e): Sse.Event => {
                  const { type, ...data } = e
                  return { _tag: "Event", event: type, id: undefined, data: JSON.stringify(data) }
                }),
                Stream.merge(ping, { haltStrategy: "left" }),
              ),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
          },
        )
      }),
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
        query: {
          page?: number
          perPage?: number
          q?: string
          view?: "all" | "project" | "marketplace"
          project?: string
        }
      }) =>
        Effect.gen(function* () {
          // The session's project, sent by the panel: "installed here" must count the project's
          // .iris/playbooks and .claude/skills, not only ~/.iris/playbooks (#186277). NOT
          // InstanceState.directory — /iris routes run outside an instance and that throws
          // "InstanceRef not provided", failing every request (caught on a live server).
          const project = projectRoot(ctx.query.project)
          const key = `${ctx.params.bloqID}:${ctx.query.view ?? "all"}`
          const r = yield* Effect.promise(() =>
            playbookLists.get(key, () => fetchPlaybooks(ctx.params.bloqID, ctx.query.view)),
          )
          // Never keep an answer that says it could not measure — the next request should retry.
          if (!(r as any).measured) playbookLists.invalidate()
          const rows = playbookRows(r.data.playbooks, {
            view: ctx.query.view,
            bloqId: ctx.params.bloqID,
            q: ctx.query.q,
            roots: { project },
          })
          const { items, meta } = pageOf(r, rows, ctx.query)
          return { ...meta, playbooks: markLocal(items, { project }) }
        }),
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
    const graphBoard = Effect.fn("IrisHttpApi.graphBoard")(
      (ctx: { params: { bloqID: number }; query: { expand?: string } }) =>
      Effect.promise(() => fetchBloqInterior(ctx.params.bloqID, parseExpandedListIds(ctx.query.expand))).pipe(
        Effect.map((r) => ({
          measured: r.measured,
          reason: r.reason,
          nodes: r.data.nodes,
          edges: r.data.edges,
          unread: r.data.unread,
        })),
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
      }) => Effect.promise(() => saveCard(ctx.params.itemID, ctx.payload)),
    )

    const atlasItemCreate = Effect.fn("IrisHttpApi.atlasItemCreate")(
      (ctx: { params: { bloqID: number; listID: number }; payload: { title: string; body?: string; position?: number } }) =>
        Effect.promise(() => createCard(ctx.params.bloqID, ctx.params.listID, ctx.payload)),
    )
    const atlasListCreate = Effect.fn("IrisHttpApi.atlasListCreate")(
      (ctx: { params: { bloqID: number }; payload: { name: string; position?: number } }) =>
        Effect.promise(() => createList(ctx.params.bloqID, ctx.payload)),
    )

    /** The Board view's drag: list AND position, so the saved order is the one on screen. */
    const itemMove = Effect.fn("IrisHttpApi.itemMove")(
      (ctx: { params: { itemID: number }; payload: { listId: number; position: number } }) =>
        Effect.promise(() => moveCard(ctx.params.itemID, ctx.payload.listId, ctx.payload.position)),
    )

    /** A held offline edit, settled by a person (#190537 W3): keep mine, or keep theirs. */
    const atlasOutboxResolve = Effect.fn("IrisHttpApi.atlasOutboxResolve")(
      (ctx: { params: { opID: string }; payload: { choice: "mine" | "theirs" } }) =>
        Effect.promise(async () => {
          const userId = await resolveUserId()
          if (!userId) return { ok: false, reason: "not signed in", waiting: 0, held: 0 }
          const r = await resolveOutbox(userId, ctx.params.opID, ctx.payload.choice)
          return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), ...outboxCounts(userId) }
        }),
    )
    /** Send what is waiting now — the sync chip's click. */
    const atlasOutboxSend = Effect.fn("IrisHttpApi.atlasOutboxSend")(() =>
      Effect.promise(async () => {
        const userId = await resolveUserId()
        if (!userId) return { sent: 0, held: 0, waiting: 0, offline: false }
        return replayOutbox(userId)
      }),
    )

    // Board members (#189795) and card assignees (#189796).
    const atlasMembers = Effect.fn("IrisHttpApi.atlasMembers")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchBoardMembers(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
      ),
    )
    const atlasMemberInvite = Effect.fn("IrisHttpApi.atlasMemberInvite")(
      (ctx: { params: { bloqID: number }; payload: { email: string; permission: "viewer" | "editor" } }) =>
        Effect.promise(() => inviteMember(ctx.params.bloqID, ctx.payload.email.trim(), ctx.payload.permission)),
    )
    const atlasMemberSave = Effect.fn("IrisHttpApi.atlasMemberSave")(
      (ctx: { params: { bloqID: number; memberID: number }; payload: { permission: "viewer" | "editor" } }) =>
        Effect.promise(() => setMemberPermission(ctx.params.bloqID, ctx.params.memberID, ctx.payload.permission)),
    )
    const atlasMemberRemove = Effect.fn("IrisHttpApi.atlasMemberRemove")((ctx: { params: { bloqID: number; memberID: number } }) =>
      Effect.promise(() => revokeMember(ctx.params.bloqID, ctx.params.memberID)),
    )
    const itemComment = Effect.fn("IrisHttpApi.itemComment")(
      (ctx: { params: { itemID: number }; payload: { body: string; mentions?: readonly number[] } }) =>
        Effect.promise(() => addComment(ctx.params.itemID, { body: ctx.payload.body, mentions: [...(ctx.payload.mentions ?? [])] })),
    )
    const atlasLocalCopyRead = Effect.fn("IrisHttpApi.atlasLocalCopy")(() => Effect.sync(() => readLocalCopySettings()))
    const atlasLocalCopySave = Effect.fn("IrisHttpApi.atlasLocalCopySave")(
      (ctx: { payload: { enabled?: boolean; includePhi?: boolean; maxBoards?: number; maxMB?: number } }) =>
        Effect.sync(() => writeLocalCopySettings(ctx.payload)),
    )
    const notifySettingsRead = Effect.fn("IrisHttpApi.notifySettings")(() =>
      Effect.promise(() => notifySettings()).pipe(Effect.map((r) => ({ measured: r.measured, reason: r.reason, settings: r.data.settings }))),
    )
    const notifySettingsSave = Effect.fn("IrisHttpApi.notifySettingsSave")(
      (ctx: { payload: { emailAssign?: boolean; emailMention?: boolean; emailDue?: boolean; push?: boolean } }) =>
        Effect.promise(() => notifySettings(ctx.payload)).pipe(Effect.map((r) => ({ measured: r.measured, reason: r.reason, settings: r.data.settings }))),
    )
    const meLive = Effect.fn("IrisHttpApi.meLive")(() =>
      Effect.sync(() => {
        const events = Stream.callback<MeLiveEvent>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => watchMe((e) => Queue.offerUnsafe(queue, e))),
            (stop) => Effect.sync(stop),
          ),
        )
        const ping = Stream.tick("25 seconds").pipe(
          Stream.drop(1),
          Stream.map((): Sse.Event => ({ _tag: "Event", event: "ping", id: undefined, data: "{}" })),
        )
        const ready: Sse.Event = { _tag: "Event", event: "ready", id: undefined, data: "{}" }
        return HttpServerResponse.stream(
          Stream.make(ready).pipe(
            Stream.concat(
              events.pipe(
                Stream.map((e): Sse.Event =>
                  e.type === "notice"
                    ? { _tag: "Event", event: "notice", id: undefined, data: JSON.stringify(e.notice) }
                    : { _tag: "Event", event: "status", id: undefined, data: JSON.stringify({ pusher: e.pusher }) },
                ),
                Stream.merge(ping, { haltStrategy: "left" }),
              ),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
          },
        )
      }),
    )
    const agentsMine = Effect.fn("IrisHttpApi.agentsMine")(() =>
      Effect.promise(() => fetchMyAgents()).pipe(Effect.map((r) => ({ measured: r.measured, reason: r.reason, agents: r.data.agents }))),
    )
    const itemActivity = Effect.fn("IrisHttpApi.itemActivity")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchActivity(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, activity: r.data.activity })),
      ),
    )
    const itemAssignees = Effect.fn("IrisHttpApi.itemAssignees")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchAssignees(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, assignees: r.data.assignees })),
      ),
    )
    const itemAssign = Effect.fn("IrisHttpApi.itemAssign")(
      (ctx: { params: { itemID: number }; payload: { userId?: number; agentId?: number; email?: string } }) =>
        Effect.promise(() => assign(ctx.params.itemID, ctx.payload)),
    )
    const itemUnassign = Effect.fn("IrisHttpApi.itemUnassign")((ctx: { params: { itemID: number; assigneeID: number } }) =>
      Effect.promise(() => unassign(ctx.params.itemID, ctx.params.assigneeID)),
    )

    const itemTaskAdd = Effect.fn("IrisHttpApi.itemTaskAdd")(
      (ctx: { params: { itemID: number }; payload: { title: string; agentId?: number; dueDate?: string; parentId?: number } }) =>
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
    const itemShare = Effect.fn("IrisHttpApi.itemShare")(
      (ctx: { params: { itemID: number }; query: { bloq?: number } }) =>
        Effect.promise(() => fetchShareState(ctx.params.itemID, ctx.query.bloq)).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
        ),
    )
    const itemShareVisibility = Effect.fn("IrisHttpApi.itemShareVisibility")(
      (ctx: { params: { itemID: number }; payload: { public: boolean } }) =>
        Effect.promise(() => setShareVisibility(ctx.params.itemID, ctx.payload.public)),
    )
    const itemShareAllowlist = Effect.fn("IrisHttpApi.itemShareAllowlist")(
      (ctx: { params: { itemID: number }; payload: { emails: readonly string[] } }) =>
        Effect.promise(() => setShareAllowlist(ctx.params.itemID, [...ctx.payload.emails])),
    )
    const itemShareInvite = Effect.fn("IrisHttpApi.itemShareInvite")(
      (ctx: { payload: { email: string; permission: string; bloq: number } }) =>
        Effect.promise(() => inviteMember(ctx.payload.bloq, ctx.payload.email, ctx.payload.permission)),
    )
    const itemSharePermission = Effect.fn("IrisHttpApi.itemSharePermission")(
      (ctx: { payload: { userId: number; permission: string; bloq: number } }) =>
        Effect.promise(() => setMemberPermission(ctx.payload.bloq, ctx.payload.userId, ctx.payload.permission)),
    )
    const itemShareRevoke = Effect.fn("IrisHttpApi.itemShareRevoke")(
      (ctx: { payload: { userId: number; bloq: number } }) =>
        Effect.promise(() => revokeMember(ctx.payload.bloq, ctx.payload.userId)),
    )
    const itemShareLink = Effect.fn("IrisHttpApi.itemShareLink")(
      (ctx: { payload: { bloq: number; expiresInDays?: number } }) =>
        Effect.promise(() => createShareLink(ctx.payload.bloq, ctx.payload.expiresInDays)),
    )
    const itemShareLinkRevoke = Effect.fn("IrisHttpApi.itemShareLinkRevoke")(
      (ctx: { params: { linkID: string }; payload: { bloq: number } }) =>
        Effect.promise(() => revokeShareLink(ctx.payload.bloq, ctx.params.linkID)),
    )
    const itemLabels = Effect.fn("IrisHttpApi.itemLabels")(
      (ctx: { params: { itemID: number }; payload: { labels: readonly string[] } }) =>
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
        Effect.promise(() =>
          uploadAttachment(ctx.params.itemID, {
            name: ctx.payload.name,
            type: ctx.payload.type,
            data: ctx.payload.data,
            bloqId: ctx.payload.bloq,
          }),
        ),
    )
    const itemAttachmentDelete = Effect.fn("IrisHttpApi.itemAttachmentDelete")(
      (ctx: { params: { itemID: number; fileID: string } }) =>
        Effect.promise(() => deleteAttachment(ctx.params.itemID, ctx.params.fileID)),
    )
    const itemEvents = Effect.fn("IrisHttpApi.itemEvents")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchEvents(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, events: r.data.events })),
      ),
    )
    const itemEventAdd = Effect.fn("IrisHttpApi.itemEventAdd")(
      (ctx: { params: { itemID: number }; payload: { title: string; startsAt: string; endsAt?: string } }) =>
        Effect.promise(() => addEvent(ctx.params.itemID, ctx.payload)),
    )
    const itemAsks = Effect.fn("IrisHttpApi.itemAsks")((ctx: { params: { itemID: number } }) =>
      Effect.promise(() => fetchAsks(ctx.params.itemID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, asks: r.data.asks })),
      ),
    )
    const itemAskAdd = Effect.fn("IrisHttpApi.itemAskAdd")(
      (ctx: { params: { itemID: number }; payload: { to: string; what: string; dueAt?: string } }) =>
        Effect.promise(() => addAsk(ctx.params.itemID, ctx.payload)),
    )
    const itemAskAnswer = Effect.fn("IrisHttpApi.itemAskAnswer")(
      (ctx: { params: { itemID: number; askID: number }; payload: { answer?: string } }) =>
        Effect.promise(() => answerAsk(ctx.params.itemID, ctx.params.askID, ctx.payload.answer)),
    )
    const itemChat = Effect.fn("IrisHttpApi.itemChat")(
      (ctx: { params: { itemID: number }; query: { bloq?: number } }) =>
        Effect.promise(() => fetchItemChat(ctx.params.itemID)).pipe(
          Effect.map((r) => ({
            measured: r.measured,
            reason: r.reason,
            agentId: r.data.agentId,
            messages: r.data.messages,
          })),
        ),
    )
    const itemChatSend = Effect.fn("IrisHttpApi.itemChatSend")(
      (ctx: { params: { itemID: number }; payload: { agentId: number; text: string; bloq?: number } }) =>
        Effect.promise(() =>
          sendItemChat(ctx.params.itemID, {
            agentId: ctx.payload.agentId,
            text: ctx.payload.text,
            bloqId: ctx.payload.bloq,
          }),
        ),
    )

    const rooms = Effect.fn("IrisHttpApi.rooms")(() =>
      Effect.promise(() => fetchRooms()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, rooms: r.data.rooms })),
      ),
    )
    const roomCreate = Effect.fn("IrisHttpApi.roomCreate")(
      (ctx: { payload: { name: string; agentIds: readonly string[] } }) =>
        Effect.promise(() => createRoom({ name: ctx.payload.name, agentIds: [...ctx.payload.agentIds] })),
    )
    const room = Effect.fn("IrisHttpApi.room")((ctx: { params: { roomID: string } }) =>
      Effect.promise(() => fetchRoom(ctx.params.roomID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, room: r.data.room, messages: r.data.messages })),
      ),
    )
    const roomSend = Effect.fn("IrisHttpApi.roomSend")(
      (ctx: { params: { roomID: string }; payload: { text: string } }) =>
        Effect.promise(() => sendRoomMessage(ctx.params.roomID, ctx.payload.text)),
    )

    const playbookDoc = Effect.fn("IrisHttpApi.playbookDoc")(
      (ctx: { params: { name: string }; query: { project?: string } }) =>
        Effect.gen(function* () {
          const project = projectRoot(ctx.query.project)
          const r = yield* Effect.promise(() => fetchPlaybookDoc(ctx.params.name, project))
          return { found: r.found, name: ctx.params.name, path: r.path, source: r.source, content: r.content }
        }),
    )

    // Artifacts (epic #186508). Local files only — no network, no token. The project comes from the
    // panel because /iris routes have no instance (memory: desktop-iris-routes-have-no-instance).
    const artifacts = Effect.fn("IrisHttpApi.artifacts")((ctx: { query: { session: string; project?: string } }) =>
      Effect.sync(() => {
        const where = Artifacts.rootFor(projectRoot(ctx.query.project))
        if (!Artifacts.validSegment(ctx.query.session)) {
          return { measured: false, reason: "invalid session id", root: where.root, dir: where.dir, artifacts: [] }
        }
        return {
          measured: true,
          root: where.root,
          dir: where.dir,
          artifacts: Artifacts.list(where.dir, ctx.query.session),
        }
      }),
    )

    const artifactDoc = Effect.fn("IrisHttpApi.artifactDoc")(
      (ctx: { params: { artifactID: string }; query: { session: string; project?: string } }) =>
        Effect.sync(() => {
          const where = Artifacts.rootFor(projectRoot(ctx.query.project))
          const r = Artifacts.read(where.dir, ctx.query.session, ctx.params.artifactID)
          return r
            ? {
                root: where.root,
                dir: where.dir,
                found: true,
                meta: r.meta,
                content: r.content,
                truncated: r.truncated,
              }
            : { root: where.root, dir: where.dir, found: false, meta: null, content: "", truncated: false }
        }),
    )

    const artifactPublish = Effect.fn("IrisHttpApi.artifactPublish")(
      (ctx: {
        params: { artifactID: string }
        payload: {
          session: string
          project?: string
          slug: string
          visibility: "public" | "unlisted" | "private"
          requiresAuth: boolean
          bloq?: number
          html?: string
        }
      }) =>
        Effect.promise(() =>
          publishArtifact({
            rootDir: Artifacts.rootFor(projectRoot(ctx.payload.project)).dir,
            session: ctx.payload.session,
            id: ctx.params.artifactID,
            slug: ctx.payload.slug,
            visibility: ctx.payload.visibility,
            requiresAuth: ctx.payload.requiresAuth,
            bloqId: ctx.payload.bloq,
            html: ctx.payload.html,
          }),
        ),
    )

    const bugReport = Effect.fn("IrisHttpApi.bugReport")(
      (ctx: { payload: { tool: string; command: string; error: string; output?: string; note?: string; preview?: boolean } }) =>
        Effect.promise(async () => {
          if (!ctx.payload.preview) return submitCommandReport(ctx.payload)
          const r = buildCommandReport(ctx.payload)
          return { ok: true, title: r.title, description: r.description }
        }),
    )

    const playbookInstall = Effect.fn("IrisHttpApi.playbookInstall")(
      (ctx: { payload: { name: string; project?: string; force?: boolean } }) =>
        Effect.promise(async () => {
          const r = await runPlaybookInstall({
            name: ctx.payload.name,
            project: projectRoot(ctx.payload.project),
            force: ctx.payload.force === true,
          })
          if (r.ok) playbookLists.invalidate()
          return r
        }),
    )

    const integrationConnect = Effect.fn("IrisHttpApi.integrationConnect")((ctx: { payload: { type: string } }) =>
      Effect.promise(() => startIntegrationConnect(ctx.payload.type)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, mode: r.data.mode, url: r.data.url, hint: r.data.hint })),
      ),
    )

    // First-run onboarding (D4 #188245). Thin: the logic and its tests live in iris/onboarding.ts.
    const onboardingState = Effect.fn("IrisHttpApi.onboardingState")(() =>
      Effect.promise(() => Onboarding.state()).pipe(Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data }))),
    )

    const onboardingMail = Effect.fn("IrisHttpApi.onboardingMail")(() =>
      Effect.promise(() => Onboarding.mail()).pipe(
        Effect.map((r) => ({
          measured: r.measured,
          reason: r.reason,
          account: r.data.account,
          threads: r.data.threads,
          waiting: Onboarding.waiting(r.data.threads, r.data.account),
        })),
      ),
    )

    const onboardingGround = Effect.fn("IrisHttpApi.onboardingGround")(
      (ctx: { payload: { threads: ReadonlyArray<Onboarding.MailThread> } }) =>
        Effect.promise(() => Onboarding.ground([...ctx.payload.threads])).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
        ),
    )

    const onboardingCapabilities = Effect.fn("IrisHttpApi.onboardingCapabilities")(
      (ctx: { payload: { id: Capabilities.GoalId; goal: string } }) =>
        Effect.promise(() => Capabilities.capabilities(ctx.payload.id, ctx.payload.goal)).pipe(
          Effect.map((r) => ({ measured: true, capabilities: r.capabilities, intent: r.intent ?? undefined })),
        ),
    )

    const onboardingWorkspace = Effect.fn("IrisHttpApi.onboardingWorkspace")((ctx: { payload: { name: string } }) =>
      Effect.sync(() => {
        const r = Onboarding.workspace(ctx.payload.name)
        return { measured: r.measured, reason: r.reason, path: r.data.path }
      }),
    )

    const onboardingTrack = Effect.fn("IrisHttpApi.onboardingTrack")(
      (ctx: { payload: { event: string; label?: string } }) =>
        Effect.sync(() => {
          void Onboarding.track(ctx.payload.event, ctx.payload.label) // fire and forget
          return { ok: true }
        }),
    )

    const cliCommands = Effect.fn("IrisHttpApi.cliCommands")((ctx: { query: { q?: string; limit?: number } }) =>
      Effect.promise(() => searchCliCommands(ctx.query.q ?? "", { limit: ctx.query.limit })),
    )

    const hivePeers = Effect.fn("IrisHttpApi.hivePeers")((ctx: { query: { page?: number; perPage?: number } }) =>
      Effect.promise(() => fetchHivePeers()).pipe(
        Effect.map((r) => {
          const { items, meta } = pageOf(r, r.data.peers, ctx.query)
          return { ...meta, peers: items }
        }),
      ),
    )

    // #187921 — live view + take over / hand back. Poll-friendly: a failed read is "not
    // measured" with a reason, never an empty run.
    const agentLive = Effect.fn("IrisHttpApi.agentLive")(
      (ctx: { params: { agentID: number }; query: { limit?: string } }) =>
        Effect.promise(() => fetchAgentLive(ctx.params.agentID, Number(ctx.query.limit) || 10)).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, run: r.data.run })),
        ),
    )
    const runTakeOver = Effect.fn("IrisHttpApi.runTakeOver")((ctx: { params: { runID: string } }) =>
      Effect.promise(() => takeOverRun(ctx.params.runID)),
    )
    const runHandBack = Effect.fn("IrisHttpApi.runHandBack")(
      (ctx: { params: { runID: string }; payload: { message?: string } }) =>
        Effect.promise(() => handBackRun(ctx.params.runID, ctx.payload.message)),
    )

    const agentTasks = Effect.fn("IrisHttpApi.agentTasks")(
      (ctx: { params: { agentID: number }; query: { includeDone?: string } }) =>
        Effect.promise(() => fetchAgentTasks(ctx.params.agentID, { includeDone: ctx.query.includeDone === "1" })).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, counts: r.data.counts, tasks: r.data.tasks })),
        ),
    )

    // Agents › Heartbeats (#189110)
    const heartbeats = Effect.fn("IrisHttpApi.heartbeats")(() =>
      Effect.promise(() => fetchHeartbeats()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, heartbeats: r.data.heartbeats })),
      ),
    )
    const heartbeatRun = Effect.fn("IrisHttpApi.heartbeatRun")((ctx: { params: { jobID: number } }) =>
      Effect.promise(() => runHeartbeat(ctx.params.jobID)),
    )
    const heartbeatPause = Effect.fn("IrisHttpApi.heartbeatPause")(
      (ctx: { params: { jobID: number }; payload: { paused: boolean } }) =>
        Effect.promise(() => setHeartbeatPaused(ctx.params.jobID, ctx.payload.paused)),
    )

    // The side panel (#190093) — see src/iris/panel.ts.
    const panel = Effect.fn("IrisHttpApi.panel")((ctx: { query: { session?: string } }) =>
      Effect.sync(() => {
        const state = Panel.get(ctx.query.session || undefined)
        return { reported: !!state, state }
      }),
    )
    const panelState = Effect.fn("IrisHttpApi.panelState")((ctx: { payload: typeof PanelStatePayload.Type }) =>
      Effect.sync(() => {
        if (!Panel.validSession(ctx.payload.session)) return { ok: false }
        Panel.report(ctx.payload as unknown as Panel.State)
        return { ok: true }
      }),
    )
    const panelCommand = Effect.fn("IrisHttpApi.panelCommand")((ctx: { payload: typeof PanelCommandPayload.Type }) =>
      Effect.gen(function* () {
        const p = ctx.payload
        if (!Panel.validSession(p.session)) return { answered: false, refused: "invalid session id" }
        const command: Panel.Command | string =
          p.action === "open" || p.action === "close"
            ? { action: p.action }
            : p.action === "show"
              ? p.surface
                ? { action: "show", surface: p.surface, sub: p.sub, bloq: p.bloq }
                : "show needs a surface"
              : p.action === "artifact"
                ? p.id
                  ? { action: "artifact", id: p.id }
                  : "artifact needs an id"
                : p.action === "tab"
                  ? p.tab
                    ? { action: "tab", tab: p.tab }
                    : "tab needs tab"
                  : p.url
                    ? { action: "browse", url: p.url }
                    : "browse needs a url"
        if (typeof command === "string") return { answered: false, refused: command }
        const known = Panel.get(p.session)
        const refused = Panel.refuse(command, known?.catalog)
        if (refused) return { answered: false, refused }
        // No directory: /iris routes have no instance. The desktop matches commands by SESSION.
        const state = yield* Effect.promise(() =>
          Panel.send({ session: p.session, command: Panel.canonical(command, known?.catalog) }),
        )
        return { answered: !!state, state }
      }),
    )

    // Pulse (#189286) — reads only.
    const pulseTopic = Effect.fn("IrisHttpApi.pulseTopic")((ctx: { query: { q: string; days?: string; project?: string } }) =>
      Effect.promise(() =>
        fetchPulseTopic({ keyword: ctx.query.q, days: ctx.query.days ? Number(ctx.query.days) : undefined, repo: projectRoot(ctx.query.project) }),
      ),
    )
    // #189319 — the same route, streamed: one event as Pulse reaches each stop, one as it lands.
    const pulseTopicStream = Effect.fn("IrisHttpApi.pulseTopicStream")((ctx: { query: { q: string; days?: string; project?: string } }) =>
      Effect.sync(() => {
        type Ev = { event: "start" | "stop" | "done" | "error"; data: unknown }
        const events = Stream.callback<Ev>((queue) =>
          Effect.sync(() => {
            const push = (e: Ev) => Queue.offerUnsafe(queue, e)
            void fetchPulseTopic(
              { keyword: ctx.query.q, days: ctx.query.days ? Number(ctx.query.days) : undefined, repo: projectRoot(ctx.query.project) },
              {
                onStart: (source, label) => push({ event: "start", data: { source, label } }),
                onStop: (stop) => push({ event: "stop", data: { stop } }),
              },
            )
              .then((r) => push(r.measured ? { event: "done", data: r } : { event: "error", data: { reason: r.reason ?? "the route did not finish" } }))
              .catch((e) => push({ event: "error", data: { reason: String(e?.message ?? e).slice(0, 300) } }))
              .finally(() => Queue.endUnsafe(queue))
          }),
        )
        return HttpServerResponse.stream(
          events.pipe(
            Stream.map((e): Sse.Event => ({ _tag: "Event", event: e.event, id: undefined, data: JSON.stringify(e.data) })),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
          },
        )
      }),
    )
    const pulseContacts = Effect.fn("IrisHttpApi.pulseContacts")((ctx: { query: { q?: string } }) =>
      Effect.promise(() => fetchPulseContacts(ctx.query.q ?? "")),
    )
    const pulseContact = Effect.fn("IrisHttpApi.pulseContact")((ctx: { params: { leadID: number }; query: { days?: string } }) =>
      Effect.promise(() => fetchPulseContact(ctx.params.leadID, ctx.query.days ? Number(ctx.query.days) : 30)),
    )

    // Genesis › Brand kits (#188816)
    const brands = Effect.fn("IrisHttpApi.brands")(() =>
      Effect.promise(() => fetchBrands()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, brands: r.data.brands })),
      ),
    )
    const brandKit = Effect.fn("IrisHttpApi.brandKit")((ctx: { params: { brandID: number } }) =>
      Effect.promise(() => fetchBrandKit(ctx.params.brandID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, kit: r.data.kit })),
      ),
    )
    const brandSave = Effect.fn("IrisHttpApi.brandSave")(
      (ctx: { params: { brandID: number }; payload: { section: string; value: unknown; expected: string } }) =>
        Effect.promise(() =>
          saveBrandSection({
            id: ctx.params.brandID,
            section: ctx.payload.section,
            value: ctx.payload.value,
            expected: ctx.payload.expected,
          }),
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

    // Hive › Scripts (#188817) — the `iris scripts` cloud calls, for the webview.
    const hiveScripts = Effect.fn("IrisHttpApi.hiveScripts")(() =>
      Effect.promise(() => HiveScripts.fetchScripts()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, scripts: r.data.scripts, account: r.data.account ?? null })),
      ),
    )
    const hiveScript = Effect.fn("IrisHttpApi.hiveScript")((ctx: { params: { slug: string } }) =>
      Effect.promise(() => HiveScripts.fetchScript(ctx.params.slug)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, script: r.data.script })),
      ),
    )
    const hiveScriptDoctor = Effect.fn("IrisHttpApi.hiveScriptDoctor")((ctx: { params: { slug: string } }) =>
      Effect.promise(() => HiveScripts.fetchDoctor(ctx.params.slug)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, doctor: r.data.doctor })),
      ),
    )
    const hiveScriptSave = Effect.fn("IrisHttpApi.hiveScriptSave")(
      (ctx: { params: { slug: string }; payload: { content: string; tags?: readonly string[] } }) =>
        Effect.promise(() =>
          HiveScripts.saveScript(ctx.params.slug, ctx.payload.content, ctx.payload.tags ? { tags: [...ctx.payload.tags] } : {}),
        ),
    )
    const hiveScriptTags = Effect.fn("IrisHttpApi.hiveScriptTags")(
      (ctx: { params: { slug: string }; payload: { tags: readonly string[] } }) =>
        Effect.promise(() => HiveScripts.setScriptTags(ctx.params.slug, [...ctx.payload.tags])),
    )
    const hiveMarket = Effect.fn("IrisHttpApi.hiveMarket")((ctx: { query: { q?: string } }) =>
      Effect.promise(() => HiveScripts.fetchMarket(ctx.query.q)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, scripts: r.data.scripts })),
      ),
    )
    const hiveMarketScript = Effect.fn("IrisHttpApi.hiveMarketScript")((ctx: { params: { slug: string } }) =>
      Effect.promise(() => HiveScripts.fetchMarketScript(ctx.params.slug)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, script: r.data.script })),
      ),
    )
    const hiveMarketInstall = Effect.fn("IrisHttpApi.hiveMarketInstall")(
      (ctx: { params: { slug: string }; payload: { tags?: readonly string[] } }) =>
        Effect.promise(() => HiveScripts.installScript(ctx.params.slug, [...(ctx.payload.tags ?? [])])),
    )
    const hiveScriptRun = Effect.fn("IrisHttpApi.hiveScriptRun")(
      (ctx: { params: { slug: string }; payload: { node: string; timeout?: number; args?: Record<string, string> } }) =>
        Effect.promise(() => HiveScripts.runScript(ctx.params.slug, ctx.payload.node, ctx.payload.timeout, ctx.payload.args)),
    )
    const hiveTaskDecide = Effect.fn("IrisHttpApi.hiveTaskDecide")(
      (ctx: { params: { taskID: string; decision: "approve" | "reject" | "cancel" } }) =>
        Effect.promise(() => HiveScripts.decideHeldTask(ctx.params.taskID, ctx.params.decision)).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, taskId: r.data.taskId })),
        ),
    )
    const hiveTask = Effect.fn("IrisHttpApi.hiveTask")((ctx: { params: { taskID: string } }) =>
      Effect.promise(() => HiveScripts.fetchTask(ctx.params.taskID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, task: r.data.task })),
      ),
    )

    const hiveSessions = Effect.fn("IrisHttpApi.hiveSessions")(() =>
      Effect.promise(() => HiveSessions.fetchHiveSessions()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, nodes: r.data.nodes })),
      ),
    )
    const hiveSessionTranscript = Effect.fn("IrisHttpApi.hiveSessionTranscript")(
      (ctx: { params: { sessionID: string }; query: { machine?: string; provider?: string; since?: number; limit?: number } }) =>
        Effect.promise(() => HiveSessions.fetchHiveTranscript(ctx.params.sessionID, ctx.query)).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, ...r.data })),
        ),
    )
    const hiveSessionReply = Effect.fn("IrisHttpApi.hiveSessionReply")(
      (ctx: { params: { sessionID: string }; payload: { nodeId: string; provider: string; label?: string; message: string } }) =>
        Effect.promise(() => HiveSessions.replyToHiveSession({ sessionId: ctx.params.sessionID, ...ctx.payload })).pipe(
          Effect.map((r) => ({ measured: r.measured, reason: r.reason, taskId: r.data.taskId })),
        ),
    )

    const hive = Effect.fn("IrisHttpApi.hive")((ctx: { query: { page?: number; perPage?: number } }) =>
      Effect.promise(() => fetchHiveNodes()).pipe(
        Effect.map((r) => {
          const { items, meta } = pageOf(r, r.data.nodes, ctx.query)
          return { ...meta, nodes: items }
        }),
      ),
    )

    /**
     * The allowance, straight through from fl-iris-api.
     *
     * Deliberately does NOT reshape, threshold, or decide anything. Every judgement in this
     * feature lives in config/allowance.php; this route's only job is that the webview cannot
     * reach fl-iris-api itself, because the bearer token is on disk in this process.
     */
    // Atlas › Artifacts (#187717): is this note live, and what is it called?
    const frameCheck = Effect.fn("IrisHttpApi.frameCheck")((ctx: { query: { url: string; origin: string } }) =>
      Effect.promise(async () => {
        const url = frameTarget(ctx.query.url)
        if (!url) return { state: "invalid" as const, url: null }
        const probe = await probeFrame(url, ctx.query.origin)
        if (probe.state === "embeddable") return { state: probe.state, url }
        return { state: probe.state, url, reason: probe.reason }
      }),
    )

    const atlasNote = Effect.fn("IrisHttpApi.atlasNote")((ctx: { query: { url: string } }) =>
      Effect.promise(async () => {
        const url = atlasNoteUrl(ctx.query.url)
        if (!url) return { state: "invalid" as const, url: null }
        const hit = liveNotes.get(url)
        const probe =
          hit && Date.now() - hit.at < LIVE_NOTE_TTL_MS ? hit.probe : await probeAtlasNote(url)
        if (probe.state === "public") liveNotes.set(url, { at: hit?.probe === probe ? hit.at : Date.now(), probe })
        if (probe.state === "public") return { state: probe.state, url, ...(probe.title ? { title: probe.title } : {}) }
        if (probe.state === "unavailable") return { state: probe.state, url, status: probe.status }
        return { state: probe.state, url }
      }),
    )

    const plans = Effect.fn("IrisHttpApi.plans")(() =>
      Effect.promise(() => fetchPlans()).pipe(
        Effect.map((r) => ({ measured: r.measured, ...(r.reason ? { reason: r.reason } : {}), plans: r.data })),
      ),
    )

    const checkout = Effect.fn("IrisHttpApi.checkout")((ctx: { payload: { slug: string } }) =>
      Effect.promise(() => createCheckout(ctx.payload.slug)).pipe(
        Effect.map((r) => (r.ok ? { ok: true, url: r.url } : { ok: false, reason: r.reason })),
      ),
    )

    const plan = Effect.fn("IrisHttpApi.plan")(() =>
      Effect.promise(() => fetchPlan()).pipe(
        Effect.map((r) => ({
          measured: r.measured,
          ...(r.reason ? { reason: r.reason } : {}),
          plan: r.data.plan,
          paid: r.data.paid,
          label: r.data.label,
          trialEndsAt: r.data.trialEndsAt,
          fraction: r.data.fraction,
          tokensUsed: r.data.tokensUsed,
          resetsAt: r.data.resetsAt,
          uncapped: r.data.uncapped,
          upgradeUrl: r.data.upgradeUrl,
        })),
      ),
    )

    // Settings › Security (#189589). The key CHAT uses (#188506), because that is the account the
    // model proxy screens — the panel must describe the same account the proxy sees.
    const chatToken = () => agentCredential(process.env, () => ({ token: resolveToken(), source: tokenSource() })).token
    const security = Effect.fn("IrisHttpApi.security")(() =>
      Effect.promise(() => fetchSecurity({ token: chatToken(), signal: AbortSignal.timeout(8000) })).pipe(
        Effect.map((r) => ({ measured: r.measured, ...(r.reason ? { reason: r.reason } : {}), ...r.data })),
      ),
    )
    const securityGate = Effect.fn("IrisHttpApi.securityGate")((ctx: { payload: { enabled: boolean | null } }) =>
      Effect.promise(() => setGateChoice(ctx.payload.enabled, { token: chatToken(), signal: AbortSignal.timeout(8000) })).pipe(
        Effect.map((r) => ({ measured: r.measured, ...(r.reason ? { reason: r.reason } : {}), ...r.data })),
      ),
    )
    const securityGateReport = Effect.fn("IrisHttpApi.securityGateReport")((ctx: { params: { id: string } }) =>
      Effect.promise(() => reportGateEvent(Number(ctx.params.id), { token: chatToken(), signal: AbortSignal.timeout(8000) })).pipe(
        Effect.map((r) => ({ measured: r.measured, ...(r.reason ? { reason: r.reason } : {}), event: r.data })),
      ),
    )

    const me = Effect.fn("IrisHttpApi.me")(() =>
      Effect.promise(async () => {
        // The key CHAT uses, not the panels' resolution (#188506), and what kind of key it is
        // (#188505: a Hive node key is refused by whoami, which is not "can't reach IRIS").
        const cred = agentCredential(process.env, () => ({ token: resolveToken(), source: tokenSource() }))
        const kind = credentialKind(cred.token, readNodeKey(homedir()))
        // 8s: one hung upstream must not leave Settings on "Checking…" forever (#188507).
        const opts = { token: cred.token, signal: AbortSignal.timeout(8000) }
        const [who, plan, allowance] = await Promise.all([
          fetchMe(opts),
          fetchPlan(opts),
          fetchAllowance({ ...opts, peek: true }),
        ])
        const credential: CredentialKind | "rejected" = kind === "personal" && who.data.rejected ? "rejected" : kind
        // Remember who this key is (#189321), so signing in as a second account does not throw
        // this one away and a switch back has a key and a name to show. Never the node key.
        if (credential === "personal" && who.measured && who.data.id !== null && cred.token) {
          try {
            registerAccount(homedir(), cred.token, who.data)
          } catch {}
        }
        return {
          measured: who.measured,
          ...(who.reason ? { reason: who.reason } : {}),
          signedIn: credential === "personal" && who.measured && who.data.id !== null,
          credential,
          panelsDiffer: Boolean(cred.token) && resolveToken() !== cred.token,
          tokenSource: cred.source,
          id: who.data.id,
          name: who.data.name,
          email: who.data.email,
          plan: {
            measured: plan.measured,
            ...(plan.reason ? { reason: plan.reason } : {}),
            plan: plan.data.plan,
            paid: plan.data.paid,
            label: plan.data.label,
            trialEndsAt: plan.data.trialEndsAt,
            fraction: plan.data.fraction,
            uncapped: plan.data.uncapped,
            upgradeUrl: plan.data.upgradeUrl,
          },
          allowance: {
            measured: allowance.measured,
            ...(allowance.reason ? { reason: allowance.reason } : {}),
            ...allowance.data,
            notice: null,
          },
        }
      }),
    )

    const signOut = Effect.fn("IrisHttpApi.signOut")(() =>
      Effect.sync(() => {
        const home = homedir()
        const active = agentCredential(process.env, () => ({ token: resolveToken(), source: tokenSource() })).token
        const r = signOutPersonal({ home, dataDir: dataDir() })
        // An engine started for a second account has its own data dir; the CLI's auth store is
        // the default one, and it must not keep acting as the account just signed out of.
        const cli = cliDataDir(process.env, home)
        if (cli !== dataDir()) r.removed.push(...signOutPersonal({ home, dataDir: cli }).removed)
        // Another saved account? Fall back to it rather than to the sign-in screen (#189321).
        const { next } = forgetActiveAccount(home, active)
        if (next) {
          const s = switchAccount({ home, cliDataDir: cli }, accountRef(next))
          if (s.ok) r.removed.push(`now signed in as ${next.email ?? accountRef(next)}`)
        }
        resetCredentialCache()
        return { ok: true, removed: r.removed }
      }),
    )

    const accounts = Effect.fn("IrisHttpApi.accounts")(() =>
      Effect.sync(() => {
        const active = agentCredential(process.env, () => ({ token: resolveToken(), source: tokenSource() })).token
        const { store, readable } = readAccountStore(homedir())
        return {
          readable,
          accounts: store.accounts.map((a) => ({
            ref: accountRef(a),
            id: a.user_id,
            email: a.email,
            name: a.name,
            active: Boolean(active) && a.key === active,
            separateData: a.data_dir !== null,
          })),
        }
      }),
    )

    const accountSwitch = Effect.fn("IrisHttpApi.accountSwitch")((ctx: { payload: { ref: string } }) =>
      Effect.sync(() => {
        const home = homedir()
        const r = switchAccount({ home, cliDataDir: cliDataDir(process.env, home) }, ctx.payload.ref)
        resetCredentialCache()
        return r.ok ? { ok: true } : { ok: false, reason: r.reason }
      }),
    )

    const accountRemove = Effect.fn("IrisHttpApi.accountRemove")((ctx: { payload: { ref: string } }) =>
      Effect.sync(() => {
        const active = agentCredential(process.env, () => ({ token: resolveToken(), source: tokenSource() })).token
        const r = removeAccount(homedir(), ctx.payload.ref, active)
        return r.ok ? { ok: true } : { ok: false, reason: r.reason }
      }),
    )

    const allowance = Effect.fn("IrisHttpApi.allowance")(() =>
      Effect.promise(() => fetchAllowance()).pipe(
        Effect.map((r) => ({
          measured: r.measured,
          ...(r.reason ? { reason: r.reason } : {}),
          window: r.data.window,
          capUsd: r.data.capUsd,
          uncapped: r.data.uncapped,
          spendUsd: r.data.spendUsd,
          fraction: r.data.fraction,
          resetsAt: r.data.resetsAt,
          thresholds: r.data.thresholds,
          surface: r.data.surface,
          upgradeUrl: r.data.upgradeUrl,
          notice: r.data.notice,
        })),
      ),
    )

    return handlers.handle("frameCheck", frameCheck).handle("atlasNote", atlasNote).handle("panel", panel).handle("panelState", panelState).handle("panelCommand", panelCommand).handle("allowance", allowance).handle("plan", plan).handle("me", me).handle("security", security).handle("securityGate", securityGate).handle("securityGateReport", securityGateReport).handle("signOut", signOut).handle("accounts", accounts).handle("accountSwitch", accountSwitch).handle("accountRemove", accountRemove).handle("plans", plans).handle("checkout", checkout).handle("auth", auth).handle("bloqs", bloqs).handle("inbox", inbox).handle("inboxMessage", inboxMessage).handle("inboxRead", inboxRead).handle("inboxState", inboxState).handle("inboxSend", inboxSend).handle("inboxSent", inboxSent).handle("atlas", atlas).handle("atlasLive", atlasLive).handle("atlasItemCreate", atlasItemCreate).handle("atlasListCreate", atlasListCreate).handle("atlasMembers", atlasMembers).handle("atlasMemberInvite", atlasMemberInvite).handle("atlasMemberSave", atlasMemberSave).handle("atlasMemberRemove", atlasMemberRemove).handle("itemComment", itemComment).handle("notifySettings", notifySettingsRead).handle("notifySettingsSave", notifySettingsSave).handle("atlasLocalCopy", atlasLocalCopyRead).handle("atlasLocalCopySave", atlasLocalCopySave).handle("atlasOutboxResolve", atlasOutboxResolve).handle("atlasOutboxSend", atlasOutboxSend).handle("meLive", meLive).handle("agentsMine", agentsMine).handle("itemActivity", itemActivity).handle("itemAssignees", itemAssignees).handle("itemAssign", itemAssign).handle("itemUnassign", itemUnassign).handle("agents", agents).handle("leads", leads).handle("pages", pages).handle("schemas", schemas).handle("playbooks", playbooks).handle("graph", graph).handle("graphBoard", graphBoard).handle("catalog", catalog).handle("integrationConnect", integrationConnect).handle("onboardingState", onboardingState).handle("onboardingMail", onboardingMail).handle("onboardingGround", onboardingGround).handle("onboardingCapabilities", onboardingCapabilities).handle("onboardingWorkspace", onboardingWorkspace).handle("onboardingTrack", onboardingTrack).handle("cliCommands", cliCommands).handle("hivePeers", hivePeers).handle("pageDoc", pageDoc).handle("pageSave", pageSave).handle("item", item).handle("itemSave", itemSave).handle("itemMove", itemMove).handle("itemTaskAdd", itemTaskAdd).handle("itemTaskSave", itemTaskSave).handle("itemTaskDelete", itemTaskDelete).handle("cardSchema", cardSchema).handle("itemShare", itemShare).handle("itemShareVisibility", itemShareVisibility).handle("itemShareAllowlist", itemShareAllowlist).handle("itemShareInvite", itemShareInvite).handle("itemSharePermission", itemSharePermission).handle("itemShareRevoke", itemShareRevoke).handle("itemShareLink", itemShareLink).handle("itemShareLinkRevoke", itemShareLinkRevoke).handle("itemLabels", itemLabels).handle("itemAttachments", itemAttachments).handle("itemAttachmentUpload", itemAttachmentUpload).handle("itemAttachmentDelete", itemAttachmentDelete).handle("itemEvents", itemEvents).handle("itemEventAdd", itemEventAdd).handle("itemAsks", itemAsks).handle("itemAskAdd", itemAskAdd).handle("itemAskAnswer", itemAskAnswer).handle("itemChat", itemChat).handle("itemChatSend", itemChatSend).handle("rooms", rooms).handle("roomCreate", roomCreate).handle("room", room).handle("roomSend", roomSend).handle("playbookDoc", playbookDoc).handle("artifacts", artifacts).handle("artifactDoc", artifactDoc).handle("artifactPublish", artifactPublish).handle("playbookInstall", playbookInstall).handle("bugReport", bugReport).handle("agentTasks", agentTasks).handle("heartbeats", heartbeats).handle("heartbeatRun", heartbeatRun).handle("heartbeatPause", heartbeatPause).handle("pulseTopic", pulseTopic).handle("pulseTopicStream", pulseTopicStream).handle("pulseContacts", pulseContacts).handle("pulseContact", pulseContact).handle("agentLive", agentLive).handle("runTakeOver", runTakeOver).handle("runHandBack", runHandBack).handle("sites", sites).handle("brands", brands).handle("brandKit", brandKit).handle("brandSave", brandSave).handle("records", records).handle("integrations", integrations).handle("hive", hive).handle("hiveSessions", hiveSessions).handle("hiveSessionTranscript", hiveSessionTranscript).handle("hiveSessionReply", hiveSessionReply).handle("hiveScripts", hiveScripts).handle("hiveScript", hiveScript).handle("hiveScriptDoctor", hiveScriptDoctor).handle("hiveScriptSave", hiveScriptSave).handle("hiveScriptRun", hiveScriptRun).handle("hiveTask", hiveTask).handle("hiveTaskDecide", hiveTaskDecide).handle("hiveScriptTags", hiveScriptTags).handle("hiveMarket", hiveMarket).handle("hiveMarketScript", hiveMarketScript).handle("hiveMarketInstall", hiveMarketInstall)
  }),
)
