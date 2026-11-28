import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Notice } from "@opencode-ai/ui/notice"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { CommandAction } from "@/components/command-action"
import "./iris-pane-layout.css"
import "./iris-outreach.css"
import type { Fetch } from "./iris-leads"
import { ConversationDetail } from "./iris-inbox"
import { channelLabel, markUnread, parseSeen, readableBody, SEEN_KEY, type ConversationsAnswer } from "./iris-inbox-model"
import { IrisReachrReview } from "./iris-reachr-review"
import { IrisAudiences, type AudienceIntent } from "./iris-audiences"
import type { ReviewBatch } from "./iris-reachr-review-model"
import { setSurfaceCount } from "./iris-surface-store"
import {
  audienceGroups,
  audienceWarning,
  campaignViews,
  delayWord,
  filterMine,
  peopleWord,
  fmt,
  leadView,
  NO_CAMPAIGNS,
  onCount,
  segmentQuery,
  strategyOrder,
  todayCount,
  todayIsClear,
  todayQueue,
  type AudienceAnswer,
  type CampaignRow,
  type Payload,
  type Strategy,
  type StrategyStep,
  type TodayItem,
} from "./iris-outreach-model"

/**
 * OUTREACH (#193487, epic #193481): Today, Campaigns and Scripts on the account's real data.
 *
 * Flat by rule: hairlines, type and spacing — no cards, no decoration. Controls are the ui library's
 * (Button, Tabs, Notice, EmptyState, SkeletonRows; #194375 W5). Inbox and Leads are not drawn here;
 * their sub-tabs open those products (session-iris-tab.tsx).
 */
export type OutreachView = "today" | "campaigns" | "scripts" | "audiences"

const get = <T,>(doFetch: Fetch, path: string): Promise<Payload<T>> =>
  doFetch(path)
    .then((r) => r.json())
    .catch((e: unknown) => ({ measured: false, reason: e instanceof Error ? e.message : String(e), data: undefined as T }))

export function IrisOutreach(props: {
  doFetch: Fetch
  view: OutreachView
  onOpenLead: (leadId: number) => void
  /** Switch Outreach's sub-view (Today's "Build the next audience" opens Audiences). */
  onShow?: (view: OutreachView) => void
  /** Audiences: the panel's board, the boards to pick from, and the engine's event stream. */
  bloqId?: number
  boards?: () => { id: number; name: string }[]
  listen?: (fn: (e: { details?: { type?: string; properties?: any } }) => void) => () => void
}) {
  // What a Today button asked Audiences for; held here because the view below remounts.
  const [intent, setIntent] = createSignal<AudienceIntent>()
  const build = async (i: AudienceIntent) => {
    const bloq = props.bloqId ?? props.boards?.()[0]?.id
    // A fresh draft for "Find people"; "From a post" also starts it on that post.
    if (bloq)
      await props
        .doFetch("/iris/outreach/segments/draft", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bloq, reset: true, filters: i.post ? [{ key: "source_post", value: i.post }] : [] }),
        })
        .catch(() => undefined)
    setIntent(i)
    props.onShow?.("audiences")
  }
  return (
    <div class="iris-ui iris-or" data-slot="iris-outreach" data-view={props.view}>
      <Switch>
        <Match when={props.view === "today"}>
          <OutreachToday doFetch={props.doFetch} onOpenLead={props.onOpenLead} onBuild={(i) => void build(i)} />
        </Match>
        <Match when={props.view === "audiences"}>
          <IrisAudiences
            doFetch={props.doFetch}
            bloqId={props.bloqId}
            boards={props.boards}
            listen={props.listen}
            intent={intent()}
            onIntentUsed={() => setIntent(undefined)}
          />
        </Match>
        <Match when={props.view === "campaigns"}>
          <OutreachCampaigns doFetch={props.doFetch} onOpenLead={props.onOpenLead} />
        </Match>
        <Match when={props.view === "scripts"}>
          <OutreachScripts doFetch={props.doFetch} />
        </Match>
      </Switch>
    </div>
  )
}

/** An empty or failed read: the words as the title, and Retry when there is something to retry. */
function Empty(props: { children: JSX.Element; onRetry?: () => void }) {
  const language = useLanguage()
  return (
    <EmptyState
      size="small"
      class="iris-or-empty"
      title={props.children}
      action={
        props.onRetry ? (
          <Button size="small" onClick={() => props.onRetry?.()}>
            {language.t("iris.outreach.retry")}
          </Button>
        ) : undefined
      }
    />
  )
}

/** A list that is still being read: rows in its shape, not a word. */
function Loading(props: { rows?: number }) {
  const language = useLanguage()
  return <SkeletonRows class="iris-or-skel" rows={props.rows ?? 4} label={language.t("iris.outreach.loading")} />
}

// ─── Today ────────────────────────────────────────────────────────────────────

function OutreachToday(props: { doFetch: Fetch; onOpenLead: (id: number) => void; onBuild: (i: AudienceIntent) => void }) {
  const language = useLanguage()
  const [comms, { refetch: refetchComms }] = createResource(
    () => props.doFetch("/iris/comms?days=14").then((r) => r.json() as Promise<ConversationsAnswer>).catch((e) => ({ measured: false, reason: String(e) }) as ConversationsAnswer),
  )
  const [batches, { refetch: refetchBatches }] = createResource(() => get<ReviewBatch[]>(props.doFetch, "/iris/reachr/batches"))
  const convs = () => (comms.latest?.measured ? comms.latest.conversations : undefined)
  const bs = () => (batches.latest?.measured ? batches.latest.data : undefined)
  const queue = createMemo(() => todayQueue(convs(), bs()))
  const replies = () => queue().filter((i) => i.kind === "reply")
  const review = () => queue().filter((i) => i.kind === "review")
  createEffect(() => {
    const n = todayCount(convs(), bs())
    if (n !== undefined) setSurfaceCount("outreach", n)
  })
  const [sel, setSel] = createSignal<string>()
  const current = createMemo<TodayItem | undefined>(() => queue().find((i) => i.key === sel()) ?? queue()[0])
  const refresh = () => (refetchComms(), refetchBatches())
  const reasons = () =>
    [
      comms.latest && !comms.latest.measured ? language.t("iris.outreach.today.reason.replies", { reason: comms.latest.reason ?? "" }) : "",
      batches.latest && !batches.latest.measured ? language.t("iris.outreach.today.reason.review", { reason: batches.latest.reason ?? "" }) : "",
    ].filter(Boolean)

  return (
    <div class="iris-or-split" data-slot="or-today">
      <div class="iris-or-list" aria-label={language.t("iris.outreach.today")}>
        <div class="iris-or-head">
          <span>{language.t("iris.outreach.today.waiting")}</span>
          <span class="n">
            {comms.loading && batches.loading
              ? ""
              : language.t("iris.outreach.today.left", { count: replies().length + review().reduce((n, i) => n + (i.kind === "review" ? i.inReview : 0), 0) })}
          </span>
        </div>
        <Show when={reasons().length}>
          <Notice class="iris-or-notice" tone="warning">{reasons().join(" · ")}</Notice>
        </Show>
        <Show when={!comms.loading || !batches.loading} fallback={<Loading />}>
          <Show
            when={queue().length}
            fallback={
              <Show when={todayIsClear(convs(), bs())} fallback={<Empty onRetry={refresh}>{language.t("iris.outreach.today.nothing")}</Empty>}>
                <BuildAudience onBuild={props.onBuild} />
              </Show>
            }
          >
            <div class="iris-or-sect">
              <span>{language.t("iris.outreach.today.replies")}</span>
              <span class="n">{replies().length}</span>
            </div>
            <For each={replies()}>{(i) => <TodayRow item={i} selected={current()?.key === i.key} onPick={() => setSel(i.key)} />}</For>
            <div class="iris-or-sect">
              <span>{language.t("iris.outreach.today.inReview")}</span>
              <span class="n">{review().reduce((n, i) => n + (i.kind === "review" ? i.inReview : 0), 0)}</span>
            </div>
            <Show when={batches.latest?.measured && !review().length}>
              <div class="iris-or-none">{language.t("iris.outreach.today.noDrafts")}</div>
            </Show>
            <For each={review()}>{(i) => <TodayRow item={i} selected={current()?.key === i.key} onPick={() => setSel(i.key)} />}</For>
          </Show>
        </Show>
      </div>
      {/* `iris-inb`: the reply view is the Inbox's own (ConversationDetail), styled by its sheet. */}
      <div class="iris-or-detail iris-inb">
        <Show when={current()} keyed fallback={<Empty>{language.t("iris.outreach.today.pick")}</Empty>}>
          {(item) => (
            <Switch>
              <Match when={item.kind === "reply" && item.leadId !== undefined && item}>
                {(r) => {
                  const it = r() as Extract<TodayItem, { kind: "reply" }>
                  return (
                    <ConversationDetail
                      doFetch={props.doFetch}
                      leadId={it.leadId!}
                      name={it.name}
                      conv={it.conv}
                      onBack={() => setSel(undefined)}
                      onOpenLead={props.onOpenLead}
                      onSent={() => void refetchComms()}
                      onMarkUnread={() => {
                        try {
                          localStorage.setItem(SEEN_KEY, JSON.stringify(markUnread(parseSeen(localStorage.getItem(SEEN_KEY)), it.conv)))
                        } catch {}
                      }}
                    />
                  )
                }}
              </Match>
              <Match when={item.kind === "reply"}>
                <Empty>{language.t("iris.outreach.today.notLead")}</Empty>
              </Match>
              <Match when={item.kind === "review" && item}>
                {(r) => <IrisReachrReview doFetch={props.doFetch} batchId={(r() as Extract<TodayItem, { kind: "review" }>).batchId} />}
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  )
}

/** Today with nothing waiting (#193533): one line, then the three ways to start the next audience. */
function BuildAudience(props: { onBuild: (i: AudienceIntent) => void }) {
  const language = useLanguage()
  const [post, setPost] = createSignal<string>()
  return (
    <div class="iris-or-clear" data-slot="or-today-clear">
      <p>{language.t("iris.outreach.clear")}</p>
      <div class="iris-or-clear-actions">
        <Button size="small" data-slot="or-find-people" onClick={() => props.onBuild({ mode: "find" })}>
          {language.t("iris.outreach.clear.find")}
        </Button>
        <Button size="small" data-slot="or-from-post" aria-expanded={post() !== undefined} onClick={() => setPost(post() === undefined ? "" : undefined)}>
          {language.t("iris.outreach.clear.post")}
        </Button>
        <Button size="small" data-slot="or-from-site" onClick={() => props.onBuild({ mode: "site" })}>
          {language.t("iris.outreach.clear.site")}
        </Button>
      </div>
      <Show when={post() !== undefined}>
        <form
          class="iris-or-clear-post"
          onSubmit={(e) => {
            e.preventDefault()
            if (post()?.trim()) props.onBuild({ mode: "post", post: post()!.trim() })
          }}
        >
          <input
            class="iris-or-input"
            aria-label={language.t("iris.outreach.clear.postUrl")}
            placeholder={language.t("iris.outreach.clear.postPlaceholder")}
            value={post() ?? ""}
            onInput={(e) => setPost(e.currentTarget.value)}
          />
          <Button type="submit" size="small" disabled={!post()?.trim()}>
            {language.t("iris.outreach.clear.open")}
          </Button>
        </form>
      </Show>
    </div>
  )
}

function TodayRow(props: { item: TodayItem; selected: boolean; onPick: () => void }) {
  const language = useLanguage()
  const i = props.item
  return (
    <button type="button" class="iris-or-row" data-kind={i.kind} aria-selected={props.selected} onClick={props.onPick}>
      <span class="t">{i.name}</span>
      <span class="s">{i.kind === "reply" ? readableBody(i.preview) : language.plural("iris.outreach.today.inReviewN", i.inReview)}</span>
      <Show when={i.kind === "reply"}>
        <span class="m">{channelLabel((i as Extract<TodayItem, { kind: "reply" }>).channel)}</span>
      </Show>
    </button>
  )
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

function OutreachCampaigns(props: { doFetch: Fetch; onOpenLead: (id: number) => void }) {
  const language = useLanguage()
  const [list, { refetch }] = createResource(() =>
    get<{ campaigns: CampaignRow[]; mine_ids: number[] | null }>(props.doFetch, "/iris/outreach/campaigns"),
  )
  // Mine (#193486): shown only once fl-api answers /campaigns/mine; until then there is nothing true to filter by.
  const mineIds = () => (list.latest?.measured ? list.latest.data.mine_ids : null)
  const [mineOnly, setMineOnly] = createSignal(false)
  const [audiences, setAudiences] = createSignal<Record<number, Payload<AudienceAnswer>>>({})
  const rows = createMemo<CampaignRow[]>(() => {
    const base = list.latest?.measured ? list.latest.data.campaigns : []
    const a = audiences()
    return base.map((c) => (a[c.id]?.measured && a[c.id].data.campaign ? { ...c, ...a[c.id].data.campaign!, fits: a[c.id].data.campaign!.fits } : c))
  })
  const views = createMemo(() => campaignViews(filterMine(rows(), mineIds(), mineOnly())))
  const [sel, setSel] = createSignal<number>()
  const current = createMemo(() => rows().find((c) => c.id === sel()) ?? rows().find((c) => c.id === views()[0]?.id))

  // Fits is counted by scanning a board's lead list (iris som preflight). One campaign at a time,
  // the one on screen first, while this view is open; boards repeat, and the engine reuses a scan.
  let alive = true
  onCleanup(() => (alive = false))
  const loadAudience = async (id: number, refresh = false) => {
    if (audiences()[id] && !refresh) return
    const r = await get<AudienceAnswer>(props.doFetch, `/iris/outreach/campaigns/${id}/audience${refresh ? "?refresh=1" : ""}`)
    if (alive) setAudiences((m) => ({ ...m, [id]: r }))
  }
  createEffect(
    on(
      () => list.latest,
      async () => {
        const first = current()?.id
        if (first !== undefined) await loadAudience(first)
        for (const v of views()) if (alive) await loadAudience(v.id)
      },
    ),
  )
  createEffect(() => {
    const id = sel()
    if (id !== undefined) void loadAudience(id)
  })

  return (
    <div class="iris-or-cols" data-slot="or-campaigns">
      <div class="iris-or-camps">
        <div class="iris-or-head">
          <span>
            {language.t("iris.outreach.campaigns")}{" "}
            <span class="n">{list.latest?.measured ? language.t("iris.outreach.campaigns.count", { count: rows().length, on: onCount(rows()) }) : ""}</span>
          </span>
          <Show when={Array.isArray(mineIds())}>
            <Tabs variant="pill" size="small" class="iris-or-filter" value={mineOnly() ? "mine" : "all"} onChange={(v: string) => setMineOnly(v === "mine")}>
              <Tabs.List aria-label={language.t("iris.outreach.campaigns.whose")}>
                <Tabs.Trigger value="all">{language.t("iris.outreach.campaigns.all")}</Tabs.Trigger>
                <Tabs.Trigger value="mine">
                  {/* data-slot here: the trigger's own data-slot is the library's. */}
                  <span data-slot="or-mine">
                    {language.t("iris.outreach.campaigns.mine")} <span class="n">{mineIds()!.length}</span>
                  </span>
                </Tabs.Trigger>
              </Tabs.List>
            </Tabs>
          </Show>
          <Button variant="ghost" size="small" class="iris-or-link" disabled={list.loading} onClick={() => (setAudiences({}), void refetch())}>
            <Show when={list.loading}>
              <Spinner class="iris-ui-spin" />
            </Show>
            {list.loading ? language.t("iris.outreach.reading") : language.t("iris.outreach.refresh")}
          </Button>
        </div>
        <Show when={!list.loading || list.latest} fallback={<Loading rows={5} />}>
          <Show
            when={list.latest?.measured}
            fallback={<Empty onRetry={() => void refetch()}>{language.t("iris.outreach.campaigns.error", { reason: list.latest?.reason ?? "" })}</Empty>}
          >
            <Show when={rows().length} fallback={<Empty>{NO_CAMPAIGNS}</Empty>}>
            <Show when={views().length} fallback={<Empty>{language.t("iris.outreach.campaigns.notOnAny")}</Empty>}>
              <div class="iris-or-table" role="table" aria-label={language.t("iris.outreach.campaigns")}>
                <div class="iris-or-tr iris-or-th" role="row">
                  <span>{language.t("iris.outreach.col.campaign")}</span>
                  <span>{language.t("iris.outreach.col.board")}</span>
                  <span>{language.t("iris.outreach.col.sender")}</span>
                  <span>{language.t("iris.outreach.col.on")}</span>
                  <span>{language.t("iris.outreach.col.script")}</span>
                  <span class="r">{language.t("iris.outreach.col.eligible")}</span>
                  <span class="r" title={language.t("iris.outreach.col.fit.title")}>{language.t("iris.outreach.col.fit")}</span>
                  <span class="r" title={language.t("iris.outreach.col.days.title")}>{language.t("iris.outreach.col.days")}</span>
                  <span class="r">{language.t("iris.outreach.col.cap")}</span>
                  <span>{language.t("iris.outreach.col.people")}</span>
                </div>
                <For each={views()}>
                  {(v) => (
                    <button
                      type="button"
                      role="row"
                      class="iris-or-tr"
                      data-campaign-id={v.id}
                      data-campaign-label={v.label}
                      aria-selected={current()?.id === v.id}
                      onClick={() => setSel(v.id)}
                    >
                      <span class="t">{v.label}</span>
                      <span class="m">{v.board}</span>
                      <span class="m">{v.sender}</span>
                      <span data-tone={v.on ? "good" : "idle"} class="tone">{v.on ? language.t("iris.outreach.on") : language.t("iris.outreach.off")}</span>
                      <span class="m ell">{v.script}</span>
                      <span class="r num">{v.eligible}</span>
                      <span class="r num">{audiences()[v.id] ? v.fits : <Spinner class="iris-ui-spin" />}</span>
                      <span class="r num tone" data-tone={v.short ? "warn" : undefined}>{v.days}</span>
                      <span class="r m">{v.cap}</span>
                      <span class="m ell" data-slot="or-people" title={v.people}>{v.people}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={current()} keyed>
        {(c) => <CampaignDetail doFetch={props.doFetch} campaign={c} audience={audiences()[c.id]} onRefresh={() => void loadAudience(c.id, true)} onOpenLead={props.onOpenLead} />}
      </Show>
    </div>
  )
}

function CampaignDetail(props: {
  doFetch: Fetch
  campaign: CampaignRow
  audience?: Payload<AudienceAnswer>
  onRefresh: () => void
  onOpenLead: (id: number) => void
}) {
  const language = useLanguage()
  const groups = createMemo(() => audienceGroups(props.audience?.data))
  const report = () => props.audience?.data?.report ?? null
  const [seg, setSeg] = createSignal<string | null>(null)
  // The script's own post, when it names one; else everything on the board.
  createEffect(
    on(groups, (g) => {
      if (seg() === null) setSeg(g.find((x) => x.target)?.key ?? "*")
    }),
  )
  const group = () => groups().find((g) => g.key === seg())
  return (
    <div class="iris-or-three" data-slot="or-campaign-detail" data-campaign-label={props.campaign.label}>
      <section class="iris-or-col" aria-label={language.t("iris.outreach.audience")}>
        <div class="iris-or-head">
          <span>
            <b>1</b> {language.t("iris.outreach.audience")}
          </span>
          <Button variant="ghost" size="small" class="iris-or-link" onClick={props.onRefresh}>
            {language.t("iris.outreach.rescan")}
          </Button>
        </div>
        <Show
          when={props.audience}
          fallback={
            <div class="iris-ui-center iris-or-scanning" role="status">
              <Spinner class="iris-ui-spin" /> {language.t("iris.outreach.scanning")}
            </div>
          }
        >
          <Show
            when={props.audience?.measured}
            fallback={<Empty onRetry={props.onRefresh}>{language.t("iris.outreach.audience.error", { reason: props.audience?.reason ?? "" })}</Empty>}
          >
            <div class="iris-or-kv">
              <span>{language.t("iris.outreach.kv.eligible")}</span>
              <span class="num">{fmt(report()?.eligible)}</span>
              <span>{language.t("iris.outreach.kv.fit")}</span>
              <span class="num">
                {report()?.matching_eligible === null
                  ? language.t("iris.outreach.kv.fit.unstated")
                  : `${report()?.matching_complete ? "" : "≥"}${fmt(report()?.matching_eligible)}`}
              </span>
              <span>{language.t("iris.outreach.kv.scanned")}</span>
              <span class="num">{fmt(report()?.scanned)}</span>
            </div>
            <Show when={audienceWarning(report())}>
              {(w) => (
                <Notice class="iris-or-notice" tone="warning">
                  {w()}
                </Notice>
              )}
            </Show>
            <button type="button" class="iris-or-seg" aria-pressed={seg() === "*"} onClick={() => setSeg("*")}>
              <span class="t">{language.t("iris.outreach.allLeads", { board: props.campaign.bloq_id })}</span>
            </button>
            <For each={groups()}>
              {(g) => (
                <button
                  type="button"
                  class="iris-or-seg"
                  aria-pressed={seg() === g.key}
                  disabled={!g.url}
                  title={g.url ? g.url : language.t("iris.outreach.group.noUrl")}
                  onClick={() => g.url && setSeg(g.key)}
                >
                  <span class="t">
                    {g.label}
                    <Show when={g.target}>
                      <span class="tone" data-tone="good">{language.t("iris.outreach.group.scriptPost")}</span>
                    </Show>
                  </span>
                  <span class="num">
                    {fmt(g.count)} <span class="m">{g.share}%</span>
                  </span>
                  <Show when={g.words}>
                    <span class="s">{g.words}</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </Show>
        <div class="iris-or-people" data-slot="or-detail-people">
          <span class="m">{language.t("iris.outreach.people")}</span>
          <span class="ell">{peopleWord(props.campaign.members)}</span>
          {/* Stub until #193486's members endpoint answers; the add/remove flow ships with it. */}
          <Button variant="ghost" size="small" class="iris-or-link" disabled title={language.t("iris.outreach.assign.title")}>
            {language.t("iris.outreach.assign")}
          </Button>
        </div>
        <div class="iris-or-absent">
          <div>
            <span>{language.t("iris.outreach.absent.sent")}</span>
            {language.t("iris.outreach.absent.sent.why")}
          </div>
          <div>
            <span>{language.t("iris.outreach.absent.demo")}</span>
            {language.t("iris.outreach.absent.demo.why")}
          </div>
        </div>
      </section>
      <section class="iris-or-col" aria-label={language.t("iris.outreach.script")}>
        <div class="iris-or-head">
          <span>
            <b>2</b> {language.t("iris.outreach.script")}
          </span>
          <span class="m ell">{props.campaign.strategy_name}</span>
        </div>
        <Show
          when={props.audience?.data?.strategy}
          fallback={
            <Show when={props.audience}>
              <Empty>{language.t("iris.outreach.script.none", { name: props.campaign.strategy_name, board: props.campaign.bloq_id })}</Empty>
            </Show>
          }
        >
          {(s) => <Steps strategy={s()} />}
        </Show>
      </section>
      <section class="iris-or-col iris-or-col-wide" aria-label={language.t("iris.outreach.leads")}>
        <SegmentLeads
          doFetch={props.doFetch}
          board={props.campaign.bloq_id}
          label={seg() === "*" ? language.t("iris.outreach.leads.board", { board: props.campaign.bloq_id }) : (group()?.label ?? "")} url={seg() === "*" ? undefined : group()?.url} ready={seg() !== null} onOpenLead={props.onOpenLead} />
      </section>
    </div>
  )
}

function SegmentLeads(props: { doFetch: Fetch; board: number; label: string; url?: string; ready: boolean; onOpenLead: (id: number) => void }) {
  const language = useLanguage()
  const [page, setPage] = createSignal(1)
  createEffect(on(() => props.url, () => setPage(1), { defer: true }))
  const [data] = createResource(
    () => (props.ready ? { board: props.board, url: props.url, page: page() } : undefined),
    async (k) => {
      const r = await props
        .doFetch("/iris/leads-api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "list", query: segmentQuery(k.board, k.url, k.page) }) })
        .then((x) => x.json())
        .catch((e) => ({ measured: false, reason: String(e) }))
      return r as Payload<any>
    },
  )
  const rows = () => {
    const d = data.latest?.data
    const list = Array.isArray(d?.data) ? d.data : Array.isArray(d?.data?.data) ? d.data.data : []
    return list.map(leadView)
  }
  const total = () => Number(data.latest?.data?.total ?? data.latest?.data?.meta?.total ?? 0) || 0
  const last = () => Number(data.latest?.data?.last_page ?? 1) || 1
  return (
    <>
      <div class="iris-or-head">
        <span>
          <b>3</b> {language.t("iris.outreach.leads")} <span class="m">{props.label}</span>
        </span>
        <span class="n">{data.latest?.measured ? language.t("iris.outreach.leads.page", { total: fmt(total()), page: page(), last: last() }) : ""}</span>
      </div>
      <Show when={data.latest || !data.loading} fallback={<Loading rows={5} />}>
        <Show when={data.latest?.measured} fallback={<Empty>{language.t("iris.outreach.leads.error", { reason: data.latest?.reason ?? "" })}</Empty>}>
          <div class="iris-or-table iris-or-leads" role="table" aria-label={language.t("iris.outreach.leads.table")}>
            <div class="iris-or-tr iris-or-th" role="row">
              <span>{language.t("iris.outreach.leads.col.lead")}</span>
              <span>{language.t("iris.outreach.leads.col.comment")}</span>
              <span>{language.t("iris.outreach.leads.col.status")}</span>
              <span class="r">{language.t("iris.outreach.leads.col.step")}</span>
              <span class="r">{language.t("iris.outreach.leads.col.replied")}</span>
            </div>
            <For each={rows()} fallback={<Empty>{language.t("iris.outreach.leads.none")}</Empty>}>
              {(l) => (
                <button type="button" role="row" class="iris-or-tr" data-lead-id={l.id} onClick={() => props.onOpenLead(l.id)}>
                  <span class="t ell">{l.name}</span>
                  <span class="m ell" title={l.comment}>{l.comment || "—"}</span>
                  <span class="m ell">{l.status}</span>
                  <span class="r num">{l.step}</span>
                  <span class="r tone" data-tone={l.replied ? "good" : "idle"}>{l.replied ? language.t("iris.outreach.yes") : language.t("iris.outreach.no")}</span>
                </button>
              )}
            </For>
          </div>
          <div class="iris-or-pager">
            <Button variant="ghost" size="small" class="iris-or-link" disabled={page() <= 1 || data.loading} onClick={() => setPage(page() - 1)}>
              {language.t("iris.outreach.previous")}
            </Button>
            <Button variant="ghost" size="small" class="iris-or-link" disabled={page() >= last() || data.loading} onClick={() => setPage(page() + 1)}>
              <Show when={data.loading}>
                <Spinner class="iris-ui-spin" />
              </Show>
              {data.loading ? language.t("iris.outreach.loadingPage") : language.t("iris.outreach.next")}
            </Button>
          </div>
        </Show>
      </Show>
    </>
  )
}

function Steps(props: { strategy: Strategy }) {
  const language = useLanguage()
  return (
    <div class="iris-or-steps">
      <Show when={props.strategy.description}>
        <p class="iris-or-desc">{props.strategy.description}</p>
      </Show>
      <For each={props.strategy.steps} fallback={<Empty>{language.t("iris.outreach.steps.none")}</Empty>}>
        {(s: StrategyStep, i) => (
          <div class="iris-or-step" data-step={i() + 1}>
            <div class="h">
              <span class="num">{i() + 1}</span>
              <b>{s.title || language.t("iris.outreach.step.untitled")}</b>
              <span class="m">
                {s.type ?? language.t("iris.outreach.step.type")} · {delayWord(s.delay_hours)}
                {s.auto_execute ? language.t("iris.outreach.step.auto") : ""}
              </span>
            </div>
            <p class="iris-or-msg">{s.instructions || language.t("iris.outreach.step.noMessage")}</p>
            <Show when={s.ai_prompt}>
              <details class="iris-or-ai">
                <summary>{language.t("iris.outreach.step.ai")}</summary>
                <p>{s.ai_prompt}</p>
              </details>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

// ─── Scripts ──────────────────────────────────────────────────────────────────

function OutreachScripts(props: { doFetch: Fetch }) {
  const language = useLanguage()
  const [data, { refetch }] = createResource(() =>
    get<{ boards: number[]; strategies: Strategy[] }>(props.doFetch, "/iris/outreach/strategies"),
  )
  const list = createMemo(() => strategyOrder(data.latest?.measured ? data.latest.data.strategies : []))
  const [sel, setSel] = createSignal<number>()
  const current = createMemo(() => list().find((s) => s.id === sel()) ?? list()[0])
  return (
    <div class="iris-or-split" data-slot="or-scripts">
      <div class="iris-or-list" aria-label={language.t("iris.outreach.strategies")}>
        <div class="iris-or-head">
          <span>
            {language.t("iris.outreach.strategies")} <span class="n">{data.latest?.measured ? list().length : ""}</span>
          </span>
          <span class="m">
            {data.latest?.measured ? language.t("iris.outreach.strategies.boards", { boards: data.latest.data.boards.map((b) => `#${b}`).join(" ") }) : ""}
          </span>
        </div>
        <Show when={data.latest || !data.loading} fallback={<Loading rows={5} />}>
          <Show
            when={data.latest?.measured}
            fallback={<Empty onRetry={() => void refetch()}>{language.t("iris.outreach.strategies.error", { reason: data.latest?.reason ?? "" })}</Empty>}
          >
            <Show
              when={list().length}
              fallback={<Empty>{data.latest?.data.boards.length ? language.t("iris.outreach.strategies.none") : NO_CAMPAIGNS}</Empty>}
            >
              <For each={list()}>
                {(s) => (
                  <button type="button" class="iris-or-row" data-strategy-id={s.id} aria-selected={current()?.id === s.id} onClick={() => setSel(s.id)}>
                    <span class="t">{s.name}</span>
                    <span class="s">
                      {language.t("iris.outreach.strategy.uses", { id: s.id, uses: fmt(s.usage_count) })}
                      {language.plural("iris.outreach.strategy.steps", s.steps.length)}
                      {s.campaigns?.length ? ` · ${s.campaigns.map((c) => c.label).join(", ")}` : ""}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="iris-or-detail iris-or-pad">
        <Show when={current()} keyed>
          {(s) => (
            <div data-slot="or-script" data-strategy-name={s.name}>
              <div class="iris-or-title">{s.name}</div>
              <div class="iris-or-kv">
                <span>{language.t("iris.outreach.kv.used")}</span>
                <span class="num">{language.t("iris.outreach.kv.usedN", { count: fmt(s.usage_count) })}</span>
                <span>{language.t("iris.outreach.kv.replies")}</span>
                <span class="num">{s.replies === null ? language.t("iris.outreach.kv.replies.none") : fmt(s.replies)}</span>
                <span>{language.t("iris.outreach.kv.board")}</span>
                <span class="num">#{s.bloq_id}</span>
                <span>{language.t("iris.outreach.kv.runsOn")}</span>
                <span>
                  <Show when={s.campaigns?.length} fallback={language.t("iris.outreach.kv.noCampaign")}>
                    <For each={s.campaigns}>
                      {(c, i) => (
                        <>
                          {i() ? ", " : ""}
                          {c.label} <span class="tone" data-tone={c.active ? "good" : "idle"}>{c.active ? language.t("iris.outreach.on") : language.t("iris.outreach.off")}</span>
                        </>
                      )}
                    </For>
                  </Show>
                </span>
              </div>
              <Steps strategy={s} />
              {/* The change runs here (#194583): the line opens for the JSON file's path, then asks first. */}
              <div class="iris-or-foot iris-or-foot--run">
                <span>{language.t("iris.outreach.readOnly")}</span>
                <CommandAction
                  command={`iris reachr update ${s.bloq_id} ${s.id} --from-json `}
                  label={language.t("iris.outreach.change")}
                  describe={language.t("iris.outreach.change.describe")}
                  editable
                  size="small"
                  variant="secondary"
                  fetch={props.doFetch}
                  base=""
                />
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
