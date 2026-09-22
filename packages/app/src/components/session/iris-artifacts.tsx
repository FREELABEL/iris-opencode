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
  markdownDocument,
  parseCsv,
  sandboxedDocument,
  type ArtifactMeta,
} from "./iris-artifacts-model"

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
type DocPayload = { found: boolean; meta: ArtifactMeta | null; content: string; truncated: boolean }
type Listen = (fn: (e: { name: string; details?: { type?: string; properties?: any } }) => void) => () => void

export const ARTIFACT_EVENT = "iris.artifact.updated"
const POLL_MS = 4000

export function IrisArtifacts(props: { doFetch: Fetch; sessionId?: string; projectParam: string; listen: Listen }) {
  const query = () =>
    `session=${encodeURIComponent(props.sessionId ?? "")}${props.projectParam ? `&${props.projectParam}` : ""}`

  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((n) => n + 1)

  const [list] = createResource(
    () => (props.sessionId ? ([props.sessionId, props.projectParam, tick()] as const) : undefined),
    async () => (await (await props.doFetch(`/iris/artifacts?${query()}`)).json()) as ListPayload,
  )
  const artifacts = createMemo(() => list.latest?.artifacts ?? [])

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
  // Open the newest one by default; keep the user's choice while it still exists.
  createEffect(() => {
    const list = artifacts()
    if (!list.length) return
    if (!list.some((m) => m.id === openId())) setOpenId(list[0].id)
  })
  const open = createMemo(() => artifacts().find((m) => m.id === openId()))
  const choose = (id: string) => {
    setOpenId(id)
    setFresh((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  // The preview re-reads when the open artifact's REVISION changes — another agent's edit
  // reloads it by itself.
  const [doc] = createResource(
    () => (open() ? ([open()!.id, open()!.revision, props.sessionId] as const) : undefined),
    async ([id]) =>
      (await (await props.doFetch(`/iris/artifacts/${encodeURIComponent(id)}?${query()}`)).json()) as DocPayload,
  )

  const csv = createMemo(() => (doc.latest?.meta?.kind === "csv" ? parseCsv(doc.latest.content) : []))

  return (
    <div class="iris-artifacts">
      <Show when={!props.sessionId}>
        <p class="iris-artifacts__note">Open a session — artifacts belong to the conversation that made them.</p>
      </Show>
      <Show when={list.latest && !list.latest.measured}>
        <p class="iris-artifacts__note">Could not read artifacts — {list.latest?.reason}</p>
      </Show>
      <Show when={props.sessionId && list.latest?.measured && artifacts().length === 0}>
        <p class="iris-artifacts__note">
          Nothing here. Files saved under .iris/artifacts for this session show up here, with who wrote them.
        </p>
      </Show>

      <Show when={artifacts().length}>
        <ul class="iris-artifacts__list" aria-label="Artifacts">
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
                  onClick={() => choose(m.id)}
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
        </ul>

        <Show when={doc.latest?.found && doc.latest.meta}>
          {(meta) => (
            <div class="iris-artifacts__preview">
              <p class="iris-artifacts__head">
                <strong>{meta().title}</strong> · {authorLine(meta())}
                <Show when={doc.latest?.truncated}> · truncated at 2 MB</Show>
              </p>
              <Switch>
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
