import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-panel-ui.css"
import "./iris-outreach.css"
import type { Fetch } from "./iris-leads"
import { ConversationDetail } from "./iris-inbox"
import { channelLabel, markUnread, parseSeen, readableBody, SEEN_KEY, type ConversationsAnswer } from "./iris-inbox-model"
import { IrisReachrReview } from "./iris-reachr-review"
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
 * Flat by rule: hairlines, type and spacing — no cards, no filled pills, no decoration. Inbox and
 * Leads are not drawn here; their sub-tabs open those products (session-iris-tab.tsx).
 */
export type OutreachView = "today" | "campaigns" | "scripts"

const get = <T,>(doFetch: Fetch, path: string): Promise<Payload<T>> =>
  doFetch(path)
    .then((r) => r.json())
    .catch((e: unknown) => ({ measured: false, reason: e instanceof Error ? e.message : String(e), data: undefined as T }))

export function IrisOutreach(props: { doFetch: Fetch; view: OutreachView; onOpenLead: (leadId: number) => void }) {
  return (
    <div class="iris-ui iris-or" data-slot="iris-outreach" data-view={props.view}>
      <Switch>
        <Match when={props.view === "today"}>
          <OutreachToday doFetch={props.doFetch} onOpenLead={props.onOpenLead} />
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

function Empty(props: { children: any; onRetry?: () => void }) {
  return (
    <div class="iris-ui-empty">
      <span>{props.children}</span>
      <Show when={props.onRetry}>
        <button type="button" class="iris-ui-btn" onClick={() => props.onRetry?.()}>
          Retry
        </button>
      </Show>
    </div>
  )
}

// ─── Today ────────────────────────────────────────────────────────────────────

function OutreachToday(props: { doFetch: Fetch; onOpenLead: (id: number) => void }) {
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
  const reasons = () => [comms.latest && !comms.latest.measured ? `Replies: ${comms.latest.reason}` : "", batches.latest && !batches.latest.measured ? `Review: ${batches.latest.reason}` : ""].filter(Boolean)

  return (
    <div class="iris-or-split" data-slot="or-today">
      <div class="iris-or-list" aria-label="Today">
        <div class="iris-or-head">
          <span>Waiting on you</span>
          <span class="n">{comms.loading && batches.loading ? "" : `${replies().length + review().reduce((n, i) => n + (i.kind === "review" ? i.inReview : 0), 0)} left`}</span>
        </div>
        <Show when={reasons().length}>
          <div class="iris-or-note" data-tone="warn">{reasons().join(" · ")}</div>
        </Show>
        <Show when={!comms.loading || !batches.loading} fallback={<Empty><Spinner class="iris-ui-spin" /></Empty>}>
          <Show when={queue().length} fallback={<Empty onRetry={refresh}>Nothing waiting. Replies that need an answer and drafts in review land here.</Empty>}>
            <div class="iris-or-sect">
              <span>Replies</span>
              <span class="n">{replies().length}</span>
            </div>
            <For each={replies()}>{(i) => <TodayRow item={i} selected={current()?.key === i.key} onPick={() => setSel(i.key)} />}</For>
            <div class="iris-or-sect">
              <span>In review</span>
              <span class="n">{review().reduce((n, i) => n + (i.kind === "review" ? i.inReview : 0), 0)}</span>
            </div>
            <Show when={batches.latest?.measured && !review().length}>
              <div class="iris-or-none">No drafts waiting for approval.</div>
            </Show>
            <For each={review()}>{(i) => <TodayRow item={i} selected={current()?.key === i.key} onPick={() => setSel(i.key)} />}</For>
          </Show>
        </Show>
      </div>
      {/* `iris-inb`: the reply view is the Inbox's own (ConversationDetail), styled by its sheet. */}
      <div class="iris-or-detail iris-inb">
        <Show when={current()} keyed fallback={<Empty>Pick something on the left.</Empty>}>
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
                <Empty>Not a lead yet, so there is nowhere to reply from here. Open it in Inbox.</Empty>
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

function TodayRow(props: { item: TodayItem; selected: boolean; onPick: () => void }) {
  const i = props.item
  return (
    <button type="button" class="iris-or-row" data-kind={i.kind} aria-selected={props.selected} onClick={props.onPick}>
      <span class="t">{i.name}</span>
      <span class="s">{i.kind === "reply" ? readableBody(i.preview) : `${i.inReview} ${i.inReview === 1 ? "message" : "messages"} in review`}</span>
      <Show when={i.kind === "reply"}>
        <span class="m">{channelLabel((i as Extract<TodayItem, { kind: "reply" }>).channel)}</span>
      </Show>
    </button>
  )
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

function OutreachCampaigns(props: { doFetch: Fetch; onOpenLead: (id: number) => void }) {
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
            Campaigns <span class="n">{list.latest?.measured ? `${rows().length} · ${onCount(rows())} on` : ""}</span>
          </span>
          <Show when={Array.isArray(mineIds())}>
            <span class="iris-or-filter" role="group" aria-label="Whose campaigns">
              <button type="button" class="iris-or-link" aria-pressed={!mineOnly()} onClick={() => setMineOnly(false)}>
                All
              </button>
              <button type="button" class="iris-or-link" data-slot="or-mine" aria-pressed={mineOnly()} onClick={() => setMineOnly(true)}>
                Mine <span class="n">{mineIds()!.length}</span>
              </button>
            </span>
          </Show>
          <button type="button" class="iris-or-link" disabled={list.loading} onClick={() => (setAudiences({}), void refetch())}>
            {list.loading ? "Reading…" : "Refresh"}
          </button>
        </div>
        <Show when={!list.loading || list.latest} fallback={<Empty><Spinner class="iris-ui-spin" /></Empty>}>
          <Show when={list.latest?.measured} fallback={<Empty onRetry={() => void refetch()}>Couldn't read your campaigns: {list.latest?.reason}</Empty>}>
            <Show when={rows().length} fallback={<Empty>{NO_CAMPAIGNS}</Empty>}>
            <Show when={views().length} fallback={<Empty>You are not on any campaign yet. All shows every campaign on the account.</Empty>}>
              <div class="iris-or-table" role="table" aria-label="Campaigns">
                <div class="iris-or-tr iris-or-th" role="row">
                  <span>Campaign</span>
                  <span>Board</span>
                  <span>Sender</span>
                  <span>On</span>
                  <span>Script</span>
                  <span class="r">Eligible</span>
                  <span class="r" title="Leads whose source post or comment matches who the script is written for">Fit script</span>
                  <span class="r" title="Days of fitting leads at the daily cap (all eligible until fit is counted)">Days left</span>
                  <span class="r">Cap</span>
                  <span>People</span>
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
                      <span data-tone={v.on ? "good" : "idle"} class="tone">{v.on ? "on" : "off"}</span>
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
      <section class="iris-or-col" aria-label="Audience">
        <div class="iris-or-head">
          <span>
            <b>1</b> Audience
          </span>
          <button type="button" class="iris-or-link" onClick={props.onRefresh}>
            Rescan
          </button>
        </div>
        <Show when={props.audience} fallback={<Empty><Spinner class="iris-ui-spin" /> Scanning the lead list…</Empty>}>
          <Show when={props.audience?.measured} fallback={<Empty onRetry={props.onRefresh}>Couldn't check this campaign: {props.audience?.reason}</Empty>}>
            <div class="iris-or-kv">
              <span>Eligible</span>
              <span class="num">{fmt(report()?.eligible)}</span>
              <span>Fit the script</span>
              <span class="num">
                {report()?.matching_eligible === null ? "not stated by the script" : `${report()?.matching_complete ? "" : "≥"}${fmt(report()?.matching_eligible)}`}
              </span>
              <span>Scanned</span>
              <span class="num">{fmt(report()?.scanned)}</span>
            </div>
            <Show when={audienceWarning(report())}>{(w) => <p class="iris-or-note" data-tone="warn">{w()}</p>}</Show>
            <button type="button" class="iris-or-seg" aria-pressed={seg() === "*"} onClick={() => setSeg("*")}>
              <span class="t">All leads on board #{props.campaign.bloq_id}</span>
            </button>
            <For each={groups()}>
              {(g) => (
                <button
                  type="button"
                  class="iris-or-seg"
                  aria-pressed={seg() === g.key}
                  disabled={!g.url}
                  title={g.url ? g.url : "fl-api cannot filter leads by a missing field; pick All leads"}
                  onClick={() => g.url && setSeg(g.key)}
                >
                  <span class="t">
                    {g.label}
                    <Show when={g.target}>
                      <span class="tone" data-tone="good"> script's post</span>
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
          <span class="m">People</span>
          <span class="ell">{peopleWord(props.campaign.members)}</span>
          {/* Stub until #193486's members endpoint answers; the add/remove flow ships with it. */}
          <button type="button" class="iris-or-link" disabled title="Assigning people arrives with #193486">
            Assign
          </button>
        </div>
        <div class="iris-or-absent">
          <div>
            <span>Sent today</span> not collected yet (the send ledger lives on the sending computer)
          </div>
          <div>
            <span>City, niche, followers</span> not collected yet
          </div>
        </div>
      </section>
      <section class="iris-or-col" aria-label="Script">
        <div class="iris-or-head">
          <span>
            <b>2</b> Script
          </span>
          <span class="m ell">{props.campaign.strategy_name}</span>
        </div>
        <Show when={props.audience?.data?.strategy} fallback={<Empty>{props.audience ? `No strategy named "${props.campaign.strategy_name}" on board #${props.campaign.bloq_id}.` : ""}</Empty>}>
          {(s) => <Steps strategy={s()} />}
        </Show>
      </section>
      <section class="iris-or-col iris-or-col-wide" aria-label="Leads">
        <SegmentLeads doFetch={props.doFetch} board={props.campaign.bloq_id} label={seg() === "*" ? `board #${props.campaign.bloq_id}` : group()?.label ?? ""} url={seg() === "*" ? undefined : group()?.url} ready={seg() !== null} onOpenLead={props.onOpenLead} />
      </section>
    </div>
  )
}

function SegmentLeads(props: { doFetch: Fetch; board: number; label: string; url?: string; ready: boolean; onOpenLead: (id: number) => void }) {
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
          <b>3</b> Leads <span class="m">{props.label}</span>
        </span>
        <span class="n">{data.latest?.measured ? `${fmt(total())} · page ${page()} of ${last()}` : ""}</span>
      </div>
      <Show when={data.latest || !data.loading} fallback={<Empty><Spinner class="iris-ui-spin" /></Empty>}>
        <Show when={data.latest?.measured} fallback={<Empty>Couldn't read leads: {data.latest?.reason}</Empty>}>
          <div class="iris-or-table iris-or-leads" role="table" aria-label="Leads in this segment">
            <div class="iris-or-tr iris-or-th" role="row">
              <span>Lead</span>
              <span>Comment</span>
              <span>Status</span>
              <span class="r">Step</span>
              <span class="r">Replied</span>
            </div>
            <For each={rows()} fallback={<Empty>No leads here.</Empty>}>
              {(l) => (
                <button type="button" role="row" class="iris-or-tr" data-lead-id={l.id} onClick={() => props.onOpenLead(l.id)}>
                  <span class="t ell">{l.name}</span>
                  <span class="m ell" title={l.comment}>{l.comment || "—"}</span>
                  <span class="m ell">{l.status}</span>
                  <span class="r num">{l.step}</span>
                  <span class="r tone" data-tone={l.replied ? "good" : "idle"}>{l.replied ? "yes" : "no"}</span>
                </button>
              )}
            </For>
          </div>
          <div class="iris-or-pager">
            <button type="button" class="iris-or-link" disabled={page() <= 1 || data.loading} onClick={() => setPage(page() - 1)}>
              Previous
            </button>
            <button type="button" class="iris-or-link" disabled={page() >= last() || data.loading} onClick={() => setPage(page() + 1)}>
              {data.loading ? "Loading…" : "Next"}
            </button>
          </div>
        </Show>
      </Show>
    </>
  )
}

function Steps(props: { strategy: Strategy }) {
  return (
    <div class="iris-or-steps">
      <Show when={props.strategy.description}>
        <p class="iris-or-desc">{props.strategy.description}</p>
      </Show>
      <For each={props.strategy.steps} fallback={<Empty>This strategy has no steps.</Empty>}>
        {(s: StrategyStep, i) => (
          <div class="iris-or-step" data-step={i() + 1}>
            <div class="h">
              <span class="num">{i() + 1}</span>
              <b>{s.title || "Untitled step"}</b>
              <span class="m">
                {s.type ?? "step"} · {delayWord(s.delay_hours)}
                {s.auto_execute ? " · runs on its own" : ""}
              </span>
            </div>
            <p class="iris-or-msg">{s.instructions || "No message written."}</p>
            <Show when={s.ai_prompt}>
              <details class="iris-or-ai">
                <summary>AI rewrite rules</summary>
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
  const [data, { refetch }] = createResource(() =>
    get<{ boards: number[]; strategies: Strategy[] }>(props.doFetch, "/iris/outreach/strategies"),
  )
  const list = createMemo(() => strategyOrder(data.latest?.measured ? data.latest.data.strategies : []))
  const [sel, setSel] = createSignal<number>()
  const current = createMemo(() => list().find((s) => s.id === sel()) ?? list()[0])
  return (
    <div class="iris-or-split" data-slot="or-scripts">
      <div class="iris-or-list" aria-label="Strategies">
        <div class="iris-or-head">
          <span>
            Strategies <span class="n">{data.latest?.measured ? list().length : ""}</span>
          </span>
          <span class="m">{data.latest?.measured ? `boards ${data.latest.data.boards.map((b) => `#${b}`).join(" ")}` : ""}</span>
        </div>
        <Show when={data.latest || !data.loading} fallback={<Empty><Spinner class="iris-ui-spin" /></Empty>}>
          <Show when={data.latest?.measured} fallback={<Empty onRetry={() => void refetch()}>Couldn't read strategies: {data.latest?.reason}</Empty>}>
            <Show when={list().length} fallback={<Empty>{data.latest?.data.boards.length ? "No outreach strategies on these boards yet." : NO_CAMPAIGNS}</Empty>}>
              <For each={list()}>
                {(s) => (
                  <button type="button" class="iris-or-row" data-strategy-id={s.id} aria-selected={current()?.id === s.id} onClick={() => setSel(s.id)}>
                    <span class="t">{s.name}</span>
                    <span class="s">
                      #{s.id} · {fmt(s.usage_count)} uses · {s.steps.length} {s.steps.length === 1 ? "step" : "steps"}
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
                <span>Used</span>
                <span class="num">{fmt(s.usage_count)} times</span>
                <span>Replies</span>
                <span class="num">{s.replies === null ? "not recorded" : fmt(s.replies)}</span>
                <span>Board</span>
                <span class="num">#{s.bloq_id}</span>
                <span>Runs on</span>
                <span>
                  <Show when={s.campaigns?.length} fallback="no campaign">
                    <For each={s.campaigns}>
                      {(c, i) => (
                        <>
                          {i() ? ", " : ""}
                          {c.label} <span class="tone" data-tone={c.active ? "good" : "idle"}>{c.active ? "on" : "off"}</span>
                        </>
                      )}
                    </For>
                  </Show>
                </span>
              </div>
              <Steps strategy={s} />
              <p class="iris-or-foot">Read-only here. Edit with <code>iris reachr update {s.bloq_id} {s.id}</code>.</p>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
