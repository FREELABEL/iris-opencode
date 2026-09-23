import { createSignal, For, Show } from "solid-js"
import { renderMarkdown } from "./iris-item"
import { markdownDocument, publishState, slugify, type ArtifactMeta, type Visibility } from "./iris-artifacts-model"

/**
 * Publish a Genesis artifact as a Genesis page — the second rung of artifact → page → site.
 *
 * The scope is ASKED, every time, with nothing pre-selected: Publish stays disabled until one is
 * chosen. A default would make "public on the internet" the answer to not reading the dialog.
 * "Save to Genesis" is the same form opened on Private: a draft in your account, not on the web.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>

const SCOPES: { id: Visibility; label: string; hint: (slug: string) => string }[] = [
  { id: "public", label: "Public", hint: (s) => `Anyone, at heyiris.io/p/${s || "…"}` },
  { id: "unlisted", label: "Unlisted", hint: () => "Only people you send the link to" },
  { id: "private", label: "Private", hint: () => "Only you, signed in — saved to Genesis, not on the web" },
]

export function IrisArtifactPublish(props: {
  meta: ArtifactMeta
  content: string
  doFetch: Fetch
  sessionId: string
  project?: string
  bloqId?: number
  bloqName?: string
  onPublished: () => void
  /** Present when the page can be shown in the app; toggles Draft ⇄ Live. */
  onToggleLive?: () => void
  live?: boolean
}) {
  const [mode, setMode] = createSignal<"closed" | "form">("closed")
  const [slug, setSlug] = createSignal("")
  const [scope, setScope] = createSignal<Visibility | undefined>()
  const [auth, setAuth] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
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

  const openForm = (preset?: Visibility) => {
    const p = props.meta.published
    setSlug(p?.slug ?? slugify(props.meta.title))
    // Republishing keeps the scope it had; a first publish starts with NONE selected, unless
    // the user pressed "Save to Genesis", which is the Private choice by name.
    setScope(preset ?? p?.visibility)
    setAuth(p?.requiresAuth ?? false)
    setNote(null)
    setMode("form")
  }

  async function submit() {
    const chosen = scope()
    if (!chosen || busy()) return
    setBusy(true)
    setNote(null)
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
          bloq: props.bloqId,
          html: props.meta.kind === "markdown" ? markdownDocument(renderMarkdown(props.content)) : undefined,
        }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; published?: { url: string } }
      if (out.ok && out.published) {
        setMode("closed")
        setNote({
          ok: true,
          text:
            chosen === "private"
              ? "Saved to Genesis (private) — only you can open it."
              : `Live at ${out.published.url.replace(/^https?:\/\//, "")} — what you see below is what's there.`,
        })
        props.onPublished()
      } else setNote({ ok: false, text: out.reason ?? `could not publish (HTTP ${res.status})` })
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
    setBusy(false)
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
            <button type="button" class="iris-card__linkbtn" onClick={() => openForm("private")}>
              Save to Genesis
            </button>
          </Show>
          <button type="button" class="iris-card__linkbtn iris-card__linkbtn--primary" onClick={() => openForm()}>
            {state().label}
          </button>
        </Show>
      </div>

      <Show when={mode() === "form"}>
        <form
          class="iris-publish__form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
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
          <p class="iris-publish__muted">
            {props.bloqId ? `Saved on the board ${props.bloqName ?? `#${props.bloqId}`}.` : "Saved to your account."}{" "}
            {props.meta.published ? "Updates the same page." : "Creates one page; publishing again updates it."}
          </p>
          <div class="iris-publish__actions">
            <button type="button" class="iris-card__linkbtn" onClick={() => setMode("closed")}>
              Cancel
            </button>
            <button
              type="submit"
              class="iris-card__linkbtn iris-card__linkbtn--primary"
              disabled={!scope() || !slug().trim() || busy()}
            >
              {busy()
                ? "Publishing…"
                : scope() === "private"
                  ? "Save to Genesis"
                  : scope()
                    ? `Publish ${scope()}`
                    : "Choose who can see it"}
            </button>
          </div>
        </form>
      </Show>

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
