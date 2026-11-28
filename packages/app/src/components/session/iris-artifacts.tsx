import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { renderMarkdown } from "./iris-item"
import {
  ARTIFACT_SANDBOX,
  authorLine,
  changedSince,
  LIVE_SANDBOX,
  liveUrl,
  markdownDocument,
  parseCsv,
  sandboxedDocument,
  type ArtifactMeta,
} from "./iris-artifacts-model"
import { clearArtifactFocus, irisArtifactFocus, setIrisOpenArtifact } from "./iris-nav"
import { IrisArtifactPublish } from "./iris-artifact-publish"
import { IrisFileArtifact, type FileContent } from "./iris-file-artifact"
import { fileRevision, type PromotedFile } from "./iris-promote"
import { HistoryScope, IrisArtifactHistory, type HistoryRow } from "./iris-artifact-history"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

/**
 * Agents › Artifacts (epics #186508 / #186510): what the agents in THIS session made.
 *
 * Shared by every agent in the session — the `artifact` tool writes to the root session, so a
 * subagent's page shows up here beside the parent's — and every row says which agent wrote its
 * current revision.
 *
 * Live without a reload, two ways:
 *   - the tool emits `iris.artifact.updated` on the sidecar's event stream; the pane refetches
 *     on it immediately;
 *   - a 4 s poll while the pane is mounted catches writers outside the engine (the CLI, another
 *     process), which never touch that stream.
 * Rows that changed since the last look are marked, so an edit by another agent is visible,
 * not only a new artifact.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type ListPayload = { measured: boolean; reason?: string; root: string; dir: string; artifacts: ArtifactMeta[] }
/** With `all=1` (#194583): every chat's artifacts, each naming its chat. */
type HistoryMeta = ArtifactMeta & { session?: string }
type HistoryPayload = { measured: boolean; reason?: string; artifacts: HistoryMeta[] }
type DocPayload = { found: boolean; meta: ArtifactMeta | null; content: string; truncated: boolean }
type Listen = (fn: (e: { name: string; details?: { type?: string; properties?: any } }) => void) => () => void

export const ARTIFACT_EVENT = "iris.artifact.updated"
const POLL_MS = 4000

export function IrisArtifacts(props: {
  doFetch: Fetch
  sessionId?: string
  projectParam: string
  project?: string
  /** The project chosen in the IRIS panel (#193407) — what "Save to Genesis" opens on. */
  selectedBloqId?: number
  /** The fallback when nothing is chosen (the panel's default board). */
  bloqId?: number
  bloqName?: string
  /** Projects the publish modal can send an artifact to (#187131). */
  boards?: () => { id: number; name: string }[]
  listen: Listen
  /** PROMOTE (#186584): documents this session made, from its changed files. */
  files?: () => PromotedFile[]
  readFile?: (path: string) => Promise<FileContent | undefined>
  openPath?: (path: string) => void
  revealPath?: (path: string) => void
}) {
  const query = () =>
    `session=${encodeURIComponent(props.sessionId ?? "")}${props.projectParam ? `&${props.projectParam}` : ""}`

  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((n) => n + 1)

  const [list] = createResource(
    () => (props.sessionId ? ([props.sessionId, props.projectParam, tick()] as const) : undefined),
    async () => (await (await props.doFetch(`/iris/artifacts?${query()}`)).json()) as ListPayload,
  )
  const artifacts = createMemo(() => list.latest?.artifacts ?? [])
  const language = useLanguage()

  // HISTORY (#194583): every chat in this project's store, not only this one. Read on the same
  // tick as the list — one local directory walk, no network.
  const [history] = createResource(
    () => [props.projectParam, tick()] as const,
    async () => {
      try {
        return (await (await props.doFetch(`/iris/artifacts?all=1&session=${props.projectParam ? `&${props.projectParam}` : ""}`)).json()) as HistoryPayload
      } catch (e) {
        return { measured: false, reason: e instanceof Error ? e.message : String(e), artifacts: [] } as HistoryPayload
      }
    },
  )
  const allArtifacts = createMemo(() => history.latest?.artifacts ?? [])
  /** "chat": this chat's artifacts and the preview. "all": the history list. */
  const [scope, setScope] = createSignal<"chat" | "all">("chat")
  /** An artifact from ANOTHER chat, opened from the history: previewed and published as that chat's. */
  const [other, setOther] = createSignal<{ session: string; meta: ArtifactMeta } | undefined>()
  const [publishAsk, setPublishAsk] = createSignal(0)
  const [publishFor, setPublishFor] = createSignal<string | undefined>()
  const files = createMemo(() => props.files?.() ?? [])
  const total = () => artifacts().length + files().length

  // Marked rows: whatever changed between the last two reads. Cleared when you open one.
  const [fresh, setFresh] = createSignal<Set<string>>(new Set())
  createEffect(
    on(artifacts, (next, prev) => {
      const changed = changedSince(prev, next)
      if (changed.size) setFresh((s) => new Set([...s, ...changed]))
    }),
  )

  // Live: the event for writes in this engine, the poll for everyone else.
  const stop = props.listen((e) => {
    if (e.details?.type === ARTIFACT_EVENT && e.details.properties?.session === props.sessionId) refresh()
  })
  // NOT gated on document.visibilityState. It was, and a desktop window behind another app — or a
  // browser tab the OS calls "hidden" — then never refreshed while agents wrote: measured, the
  // preview sat on rev 1 while rev 2 was on disk. The poll is one local directory read.
  const poll = setInterval(refresh, POLL_MS)
  const onVisible = () => document.visibilityState === "visible" && refresh()
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible)
  onCleanup(() => {
    stop()
    clearInterval(poll)
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible)
  })

  const [openId, setOpenId] = createSignal<string | undefined>()
  // The selected artifact, for the agent (#190093). Cleared when the pane goes away.
  createEffect(() => setIrisOpenArtifact(openId()))
  onCleanup(() => setIrisOpenArtifact(undefined))
  const [listOpen, setListOpen] = createSignal(false)
  // Open the newest one by default; keep the user's choice while it still exists.
  createEffect(() => {
    const list = artifacts()
    const docs = files()
    if (list.some((m) => m.id === openId()) || docs.some((f) => f.id === openId())) return
    const first = list[0]?.id ?? docs[0]?.id
    if (first) setOpenId(first)
  })
  const open = createMemo(() => other()?.meta ?? artifacts().find((m) => m.id === openId()))
  const openFile = createMemo(() => (other() ? undefined : files().find((f) => f.id === openId())))
  /** The chat whose store the open artifact is read from (and published as). */
  const docSession = () => other()?.session ?? props.sessionId
  // Draft (the artifact, from disk) or Live (its published page, from heyiris.io). Resets to the
  // draft when another artifact is opened.
  const [live, setLive] = createSignal(false)
  createEffect(on(openId, () => setLive(false), { defer: true }))
  const liveSrc = createMemo(() => (live() ? liveUrl(open()?.published?.url) : undefined))

  const choose = (id: string) => {
    setOther(undefined)
    setOpenId(id)
    setFresh((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  // A chat card asked for one artifact (iris-nav.ts). Select it once the list has it; until then
  // re-read — the card can arrive before this pane's next poll has seen the new file.
  createEffect(() => {
    const want = irisArtifactFocus()
    if (!want) return
    if (artifacts().some((m) => m.id === want.id) || files().some((f) => f.id === want.id)) {
      choose(want.id)
      clearArtifactFocus()
    } else refresh()
  })

  // The preview re-reads when the open artifact's REVISION changes — another agent's edit
  // reloads it by itself.
  const [doc] = createResource(
    () => (open() && docSession() ? ([open()!.id, open()!.revision, docSession()!] as const) : undefined),
    async ([id, , session]) =>
      (await (
        await props.doFetch(
          `/iris/artifacts/${encodeURIComponent(id)}?session=${encodeURIComponent(session)}${props.projectParam ? `&${props.projectParam}` : ""}`,
        )
      ).json()) as DocPayload,
  )
  // "Publish" on a history row: open it, and once its content is here, open its publish modal.
  createEffect(() => {
    const want = publishFor()
    if (want && doc.latest?.found && doc.latest.meta?.id === want) {
      setPublishFor(undefined)
      setPublishAsk((n) => n + 1)
    }
  })

  const fromHistory = (row: HistoryRow, publish = false) => {
    const m = allArtifacts().find((a) => `${a.session}/${a.id}` === row.key)
    if (!m || !m.session) return
    if (m.session === props.sessionId) choose(m.id)
    else {
      setOther({ session: m.session, meta: m })
      setLive(false)
    }
    setScope("chat")
    if (publish) setPublishFor(m.id)
  }
  const share = (row: HistoryRow) => {
    if (!row.shareUrl) return
    void navigator.clipboard
      ?.writeText(row.shareUrl)
      .then(() => showToast({ variant: "success", icon: "check", description: language.t("iris.artifacts.history.shared") }))
      .catch(() => showToast({ description: row.shareUrl }))
  }
  const historyRows = createMemo<HistoryRow[]>(() =>
    allArtifacts().map((m) => {
      const pub = m.published
      const behind = !!pub && pub.revision < m.revision
      return {
        key: `${m.session}/${m.id}`,
        title: m.title,
        kind: m.kind,
        author: m.author?.agent,
        where: m.session === props.sessionId ? language.t("iris.artifacts.history.here") : language.t("iris.artifacts.history.elsewhere"),
        when: m.updated,
        status: pub
          ? behind
            ? { label: language.t("iris.artifacts.status.behind"), tone: "warning" as const }
            : { label: language.t(`iris.artifacts.status.${pub.visibility}`), tone: "success" as const }
          : { label: language.t("iris.artifacts.status.draft"), tone: "neutral" as const },
        shareUrl: pub && pub.visibility !== "private" ? pub.url : undefined,
        canPublish: !pub || behind,
        selected: open()?.id === m.id && docSession() === m.session,
      }
    }),
  )

  const csv = createMemo(() => (doc.latest?.meta?.kind === "csv" ? parseCsv(doc.latest.content) : []))

  return (
    <div class="iris-artifacts">
      <Show when={list.latest && !list.latest.measured && props.sessionId}>
        <p class="iris-artifacts__note">Could not read artifacts — {list.latest?.reason}</p>
      </Show>
      {/* THE HISTORY (#194583): every chat's artifacts, newest first. It is also what shows when
          this chat has none yet (or no chat is open), with an empty state only when there are none
          anywhere. */}
      <Show when={scope() === "all" || (!other() && total() === 0)}>
        <IrisArtifactHistory
          rows={historyRows()}
          loading={history.loading && !history.latest}
          header={
            <div class="iris-artifacts__histhead">
              <Show when={total() > 0 || other()}>
                <HistoryScope value="all" onChange={setScope} counts={{ chat: total(), all: allArtifacts().length }} />
              </Show>
              <Show when={total() === 0 && !other() && allArtifacts().length > 0}>
                <p class="iris-artifacts__note iris-artifacts__note--inline">
                  {props.sessionId ? language.t("iris.artifacts.history.noneHere") : language.t("iris.artifacts.history.noChat")}
                </p>
              </Show>
            </div>
          }
          empty={{
            title: language.t("iris.artifacts.empty.title"),
            body: language.t("iris.artifacts.empty.body"),
          }}
          onOpen={(r) => fromHistory(r)}
          onPublish={(r) => fromHistory(r, true)}
          onShare={share}
        />
      </Show>

      <Show when={scope() === "chat" && (total() || other())}>
        {/* ONE LINE for the artifact (#186509 nav): the list opens from "‹ All (N)", and the
            title, author and publish actions share the row. It used to be three stacked rows —
            a list, a title line repeating it, and a button bar. */}
        <div class="iris-artifacts__toolbar">
          <div class="iris-artifacts__all" hidden={total() === 0}>
            <button
              type="button"
              class="iris-artifacts__allbtn"
              classList={{ "iris-artifacts__allbtn--open": listOpen() }}
              aria-haspopup="listbox"
              aria-expanded={listOpen()}
              onClick={() => setListOpen((v) => !v)}
            >
              {/* Named for what it lists (#187131). "‹ All (1)" read as a project picker. */}
              {total()} {total() === 1 ? "artifact" : "artifacts"}
              {fresh().size ? " •" : ""} ▾
            </button>
            <Show when={listOpen()}>
              <ul
                class="iris-artifacts__list iris-artifacts__menu"
                aria-label="Artifacts"
                onMouseLeave={() => setListOpen(false)}
              >
                <For each={artifacts()}>
                  {(m) => (
                    <li>
                      <button
                        type="button"
                        class="iris-artifacts__row"
                        classList={{
                          "iris-artifacts__row--open": m.id === openId(),
                          "iris-artifacts__row--fresh": fresh().has(m.id),
                        }}
                        data-artifact-id={m.id}
                        onClick={() => {
                          choose(m.id)
                          setListOpen(false)
                        }}
                      >
                        <span class="iris-artifacts__title">{m.title}</span>
                        <span class="iris-artifacts__kind">{m.kind}</span>
                        <span class="iris-artifacts__by" data-testid="artifact-author">
                          {authorLine(m)}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
                <Show when={files().length}>
                  <li class="iris-artifacts__group" aria-hidden="true">
                    Files this session made
                  </li>
                  <For each={files()}>
                    {(f) => (
                      <li>
                        <button
                          type="button"
                          class="iris-artifacts__row"
                          classList={{ "iris-artifacts__row--open": f.id === openId() }}
                          data-artifact-id={f.id}
                          title={f.path}
                          onClick={() => {
                            choose(f.id)
                            setListOpen(false)
                          }}
                        >
                          <span class="iris-artifacts__title">{f.name}</span>
                          <span class="iris-artifacts__kind">{f.kind}</span>
                          <span class="iris-artifacts__by">file · {f.status}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </Show>
              </ul>
            </Show>
          </div>
          <button type="button" class="iris-card__linkbtn iris-artifacts__histbtn" data-action="artifacts-history" onClick={() => setScope("all")}>
            {language.t("iris.artifacts.history.allChats")}
            <span class="iris-artifacts__histn">{allArtifacts().length}</span>
          </button>
          <Show when={openFile()}>
            {(f) => (
              <>
                <span class="iris-artifacts__sep" />
                <strong class="iris-artifacts__tbtitle">{f().name}</strong>
                <span class="iris-artifacts__tbmeta" data-testid="artifact-file-path">
                  {f().path}
                </span>
                <Show when={props.openPath}>
                  <button type="button" class="iris-card__linkbtn" onClick={() => props.openPath!(f().path)}>
                    Open
                  </button>
                </Show>
                <Show when={props.revealPath}>
                  <button type="button" class="iris-card__linkbtn" onClick={() => props.revealPath!(f().path)}>
                    Reveal
                  </button>
                </Show>
              </>
            )}
          </Show>
          <Show when={!openFile() && doc.latest?.found && doc.latest.meta}>
            {(meta) => (
              <>
                <span class="iris-artifacts__sep" />
                <strong class="iris-artifacts__tbtitle">{meta().title}</strong>
                <span class="iris-artifacts__tbmeta" data-testid="artifact-toolbar-author">
                  {authorLine(meta())}
                  {other() ? ` · ${language.t("iris.artifacts.history.elsewhere")}` : ""}
                  {doc.latest?.truncated ? " · truncated" : ""}
                </span>
                <Show when={docSession()}>
                  <IrisArtifactPublish
                    meta={open() ?? meta()}
                    content={doc.latest!.content}
                    doFetch={props.doFetch}
                    sessionId={docSession()!}
                    publishRequest={publishAsk()}
                    project={props.project}
                    selectedBloqId={props.selectedBloqId}
                    bloqId={props.bloqId}
                    bloqName={props.bloqName}
                    boards={props.boards}
                    onPublished={refresh}
                    live={live()}
                    onToggleLive={liveUrl((open() ?? meta()).published?.url) ? () => setLive((v) => !v) : undefined}
                  />
                </Show>
              </>
            )}
          </Show>
        </div>

        <Show when={openFile()}>
          {(f) => (
            <IrisFileArtifact
              file={f()}
              revision={fileRevision(f())}
              read={(path) => props.readFile?.(path) ?? Promise.resolve(undefined)}
              onOpen={props.openPath ? () => props.openPath!(f().path) : undefined}
            />
          )}
        </Show>
        <Show when={!openFile() && doc.latest?.found && doc.latest.meta}>
          {(meta) => (
            <div class="iris-artifacts__preview">
              <Switch>
                <Match when={liveSrc()}>
                  {(src) => (
                    <iframe
                      class="iris-artifacts__frame"
                      title={`${meta().title} — live`}
                      sandbox={LIVE_SANDBOX}
                      referrerpolicy="strict-origin-when-cross-origin"
                      src={src()}
                      data-testid="artifact-live-frame"
                    />
                  )}
                </Match>
                <Match when={meta().kind === "html"}>
                  <iframe
                    class="iris-artifacts__frame"
                    title={meta().title}
                    sandbox={ARTIFACT_SANDBOX}
                    referrerpolicy="no-referrer"
                    srcdoc={sandboxedDocument(doc.latest!.content)}
                  />
                </Match>
                {/* Markdown is agent-written HTML once rendered — `marked` passes raw tags through
                    unsanitised — so it goes in the SAME sandbox as an html artifact, never into
                    innerHTML in the app's own origin. */}
                <Match when={meta().kind === "markdown"}>
                  <iframe
                    class="iris-artifacts__frame"
                    title={meta().title}
                    sandbox={ARTIFACT_SANDBOX}
                    referrerpolicy="no-referrer"
                    srcdoc={sandboxedDocument(markdownDocument(renderMarkdown(doc.latest!.content)))}
                  />
                </Match>
                <Match when={meta().kind === "csv"}>
                  <div class="iris-artifacts__doc">
                    <table class="iris-artifacts__table">
                      <For each={csv()}>
                        {(row, i) => (
                          <tr>{<For each={row}>{(cell) => (i() === 0 ? <th>{cell}</th> : <td>{cell}</td>)}</For>}</tr>
                        )}
                      </For>
                    </table>
                  </div>
                </Match>
                <Match when={meta().kind === "code"}>
                  <pre class="iris-artifacts__doc iris-artifacts__code">{doc.latest!.content}</pre>
                </Match>
              </Switch>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
