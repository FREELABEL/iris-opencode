import { createMemo, createSignal, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { renderMarkdown } from "./iris-item"
import {
  markdownDocument,
  publishState,
  publishSummary,
  slugify,
  type ArtifactMeta,
  type Visibility,
} from "./iris-artifacts-model"

/**
 * Publish a Genesis artifact as a Genesis page — the second rung of artifact → page → site.
 *
 * A MODAL, not an inline form (#187131). Inline, the form pushed the artifact it was about off the
 * screen, so you chose "public on the internet" while looking at radios instead of the thing, and
 * it read like a settings section rather than a commitment.
 *
 * PROJECT FIRST. Before publishing, an artifact belongs to the session and lives nowhere else —
 * that is why the panel says "this session". Publishing is the moment it has to land somewhere,
 * so the destination is the first control, required, pre-filled with the session's project. An
 * artifact published to no project is an orphan nobody can find again.
 *
 * The scope is ASKED, every time, with nothing pre-selected: Publish stays disabled until one is
 * chosen. A default would make "public on the internet" the answer to not reading the dialog.
 * "Save to Genesis" is the same modal opened on Private: a draft in your account, not on the web.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Board = { id: number; name: string }

const SCOPES: { id: Visibility; label: string; hint: (slug: string) => string }[] = [
  { id: "public", label: "Public", hint: (s) => `Anyone, at heyiris.io/p/${s || "…"}` },
  { id: "unlisted", label: "Unlisted", hint: () => "Only people you send the link to" },
  { id: "private", label: "Private", hint: () => "Only you, signed in — saved to Genesis, not on the web" },
]

/** What the primary button says it will do — never a bare "Submit". */
const ACTION: Record<Visibility, string> = {
  public: "Publish publicly",
  unlisted: "Publish unlisted",
  private: "Save to Genesis",
}

export function IrisArtifactPublish(props: {
  meta: ArtifactMeta
  content: string
  doFetch: Fetch
  sessionId: string
  project?: string
  bloqId?: number
  bloqName?: string
  /** Every project (board) the person can publish into, for the destination control. */
  boards?: () => Board[]
  onPublished: () => void
  /** Present when the page can be shown in the app; toggles Draft ⇄ Live. */
  onToggleLive?: () => void
  live?: boolean
}) {
  const dialog = useDialog()
  const [slug, setSlug] = createSignal("")
  const [scope, setScope] = createSignal<Visibility | undefined>()
  const [auth, setAuth] = createSignal(false)
  const [board, setBoard] = createSignal<number | undefined>()
  const [picking, setPicking] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [note, setNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = createSignal(false)
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNote({ ok: false, text: `copy failed — the address is ${url}` })
    }
  }

  const state = () => publishState(props.meta)
  const publishable = () => props.meta.kind === "html" || props.meta.kind === "markdown"
  const boards = () => props.boards?.() ?? []
  const boardName = createMemo(() => {
    const id = board()
    if (!id) return undefined
    return boards().find((b) => b.id === id)?.name ?? (id === props.bloqId ? props.bloqName : undefined) ?? `#${id}`
  })
  const matches = createMemo(() => {
    const q = filter().trim().toLowerCase().replace(/^#/, "")
    const all = boards()
    if (!q) return all.slice(0, 50)
    return all.filter((b) => b.name.toLowerCase().includes(q) || String(b.id).startsWith(q)).slice(0, 50)
  })

  function submitLabel() {
    if (busy()) return "Publishing…"
    if (!board()) return "Choose a project"
    const s = scope()
    if (!s) return "Choose who can see it"
    return ACTION[s]
  }

  async function submit() {
    const chosen = scope()
    const dest = board()
    if (!chosen || !dest || !slug().trim() || busy()) return
    setBusy(true)
    setError(null)
    try {
      const res = await props.doFetch(`/iris/artifacts/${encodeURIComponent(props.meta.id)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: props.sessionId,
          project: props.project,
          slug: slug().trim(),
          visibility: chosen,
          requiresAuth: auth(),
          bloq: dest,
          html: props.meta.kind === "markdown" ? markdownDocument(renderMarkdown(props.content)) : undefined,
        }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; published?: { url: string } }
      if (out.ok && out.published) {
        dialog.close()
        setNote({
          ok: true,
          text:
            chosen === "private"
              ? `Saved to Genesis (private) in ${boardName()} — only you can open it.`
              : `Live at ${out.published.url.replace(/^https?:\/\//, "")}, saved to ${boardName()} — what you see below is what's there.`,
        })
        props.onPublished()
      } else setError(out.reason ?? `could not publish (HTTP ${res.status})`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const openModal = (preset?: Visibility) => {
    const p = props.meta.published
    setSlug(p?.slug ?? slugify(props.meta.title))
    // Republishing keeps the scope it had; a first publish starts with NONE selected, unless
    // the user pressed "Save to Genesis", which is the Private choice by name.
    setScope(preset ?? p?.visibility)
    setAuth(p?.requiresAuth ?? false)
    // Pre-filled with the session's project, so the common case is one glance and a confirm.
    // With none resolved, the picker is open: the modal asks rather than defaulting.
    setBoard(props.bloqId)
    setPicking(!props.bloqId)
    setFilter("")
    setError(null)
    setNote(null)
    dialog.show(() => (
      <Dialog title={props.meta.published ? "Update page" : "Publish"} description={props.meta.title}>
        <form
          class="iris-publish__form iris-publish__form--modal"
          data-testid="artifact-publish-modal"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {/* WHERE, before who. The destination is the decision; visibility qualifies it. */}
          <fieldset class="iris-publish__dest" aria-label="Project">
            <legend>Project</legend>
            <Show
              when={!picking()}
              fallback={
                <div class="iris-publish__picker">
                  <input
                    class="iris-field__input"
                    placeholder="Search projects or #id…"
                    value={filter()}
                    onInput={(e) => setFilter(e.currentTarget.value)}
                    aria-label="Search projects"
                    autofocus
                  />
                  <ul class="iris-publish__boards" aria-label="Projects">
                    <For each={matches()} fallback={<li class="iris-publish__muted">No projects match.</li>}>
                      {(b) => (
                        <li>
                          <button
                            type="button"
                            class="iris-publish__board"
                            classList={{ "iris-publish__board--on": b.id === board() }}
                            onClick={() => {
                              setBoard(b.id)
                              setPicking(false)
                            }}
                          >
                            <span class="truncate">{b.name}</span>
                            <span class="iris-publish__boardid">#{b.id}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              }
            >
              <div class="iris-publish__destrow">
                <strong class="iris-publish__destname">{boardName()}</strong>
                <Show when={boards().length > 1}>
                  <button type="button" class="iris-card__linkbtn" onClick={() => setPicking(true)}>
                    Change
                  </button>
                </Show>
              </div>
            </Show>
          </fieldset>
          <label class="iris-publish__field">
            <span>Address</span>
            <input
              class="iris-field__input"
              value={slug()}
              onInput={(e) => setSlug(e.currentTarget.value.toLowerCase())}
              aria-label="Page address"
            />
          </label>
          <fieldset class="iris-publish__scopes" aria-label="Who can see it">
            <legend>Who can see it?</legend>
            <For each={SCOPES}>
              {(s) => (
                <label class="iris-publish__scope" classList={{ "iris-publish__scope--on": scope() === s.id }}>
                  <input type="radio" name="scope" checked={scope() === s.id} onChange={() => setScope(s.id)} />
                  <span class="iris-publish__scopename">{s.label}</span>
                  <span class="iris-publish__muted">{s.hint(slug())}</span>
                </label>
              )}
            </For>
          </fieldset>
          <label class="iris-publish__check">
            <input type="checkbox" checked={auth()} onChange={(e) => setAuth(e.currentTarget.checked)} />
            <span>Require sign-in (visitors get an email code)</span>
          </label>
          {/* The consequence, in one sentence, where the decision is made. */}
          <p class="iris-publish__summary" data-testid="artifact-publish-summary">
            {publishSummary(scope(), slug(), boardName())}
            {props.meta.published ? " · updates the same page" : ""}
          </p>
          <Show when={error()}>
            <p class="iris-publish__note iris-publish__note--bad">{error()}</p>
          </Show>
          <div class="iris-publish__actions">
            <button type="button" class="iris-card__linkbtn" onClick={() => dialog.close()}>
              Cancel
            </button>
            <button
              type="submit"
              class="iris-card__linkbtn iris-card__linkbtn--primary"
              disabled={!board() || !scope() || !slug().trim() || busy()}
            >
              {submitLabel()}
            </button>
          </div>
        </form>
      </Dialog>
    ))
  }

  return (
    <div class="iris-publish">
      <div class="iris-publish__bar">
        {/* The address stays IN the app (#186541). The live page is exactly this artifact's
            revision, already on screen below — so the link is shown and copyable, and leaving
            for the browser is a separate, explicit action. */}
        <Show when={props.meta.published}>
          {(p) => (
            <span class="iris-publish__addr" data-testid="artifact-page-link">
              <span class="iris-publish__url" title={p().url}>
                {p().visibility === "private" ? "Private in Genesis · " : ""}
                {p().url.replace(/^https?:\/\//, "")}
              </span>
              <button type="button" class="iris-card__linkbtn" onClick={() => void copy(p().url)}>
                {copied() ? "Copied" : "Copy"}
              </button>
              <Show when={props.onToggleLive}>
                <button type="button" class="iris-card__linkbtn" onClick={() => props.onToggleLive?.()}>
                  {props.live ? "Show draft" : "View live"}
                </button>
              </Show>
              <a class="iris-card__linkbtn" href={p().url} target="_blank" rel="noopener noreferrer">
                Open in browser
              </a>
            </span>
          )}
        </Show>
        <Show when={state().behind}>
          <span class="iris-publish__behind">
            page is rev {props.meta.published?.revision}, this is rev {props.meta.revision}
          </span>
        </Show>
        <span class="iris-publish__spacer" />
        <Show
          when={publishable()}
          fallback={<span class="iris-publish__muted">{props.meta.kind} can't be published yet</span>}
        >
          <Show when={!props.meta.published}>
            <button type="button" class="iris-card__linkbtn" onClick={() => openModal("private")}>
              Save to Genesis
            </button>
          </Show>
          <button type="button" class="iris-card__linkbtn iris-card__linkbtn--primary" onClick={() => openModal()}>
            {state().label}
          </button>
        </Show>
      </div>

      <Show when={note()}>
        {(n) => (
          <p class="iris-publish__note" classList={{ "iris-publish__note--bad": !n().ok }}>
            {n().text}
          </p>
        )}
      </Show>
    </div>
  )
}
