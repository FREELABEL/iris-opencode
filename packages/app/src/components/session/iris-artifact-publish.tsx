import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { useLanguage } from "@/context/language"
import "./iris-artifact-publish.css"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { renderMarkdown } from "./iris-item"
import {
  initialPublishBoard,
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

const SCOPES = [
  { id: "public", label: "iris.publish.scope.public", short: "iris.publish.scope.public.short", icon: "globe" },
  { id: "unlisted", label: "iris.publish.scope.unlisted", short: "iris.publish.scope.unlisted.short", icon: "link" },
  { id: "private", label: "iris.publish.scope.private", short: "iris.publish.scope.private.short", icon: "lock" },
] as const satisfies readonly { id: Visibility; label: string; short: string; icon: IconProps["name"] }[]

/** What the primary button says it will do — never a bare "Submit". */
const ACTION = {
  public: "iris.publish.action.public",
  unlisted: "iris.publish.action.unlisted",
  private: "iris.publish.action.private",
} as const satisfies Record<Visibility, string>

export function IrisArtifactPublish(props: {
  meta: ArtifactMeta
  content: string
  doFetch: Fetch
  sessionId: string
  project?: string
  /** The project chosen in the IRIS panel (#193407). The modal opens on it. */
  selectedBloqId?: number
  /** The fallback when nothing is chosen — the panel's default board. */
  bloqId?: number
  bloqName?: string
  /** Every project (board) the person can publish into, for the destination control. */
  boards?: () => Board[]
  onPublished: () => void
  /** Present when the page can be shown in the app; toggles Draft ⇄ Live. */
  onToggleLive?: () => void
  live?: boolean
  /** Bumped by the pane's history list (#194583): "Publish" on a row opens this artifact's modal. */
  publishRequest?: number
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [slug, setSlug] = createSignal("")
  const [scope, setScope] = createSignal<Visibility | undefined>()
  const [auth, setAuth] = createSignal(false)
  // Who may get a sign-in code (#193846). Loaded from the page itself, because a list set by the
  // CLI or by hand is the one in force; `dirty` = the person changed it here, and only then is it
  // sent — untouched, the engine keeps whatever the page has.
  const [allow, setAllow] = createSignal<string[]>([])
  const [allowText, setAllowText] = createSignal("")
  const [allowState, setAllowState] = createSignal<"none" | "loading" | "known" | "unknown">("none")
  const [allowDirty, setAllowDirty] = createSignal(false)
  const [allowBad, setAllowBad] = createSignal<string[]>([])
  const addAllowed = () => {
    const parts = allowText().split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
    const ok = parts.filter(isSignInEntry).map((x) => (x.includes("@") && !x.startsWith("@") ? x : `@${x.replace(/^@/, "")}`))
    setAllowBad(parts.filter((x) => !isSignInEntry(x)))
    if (!ok.length) return
    setAllow((cur) => [...new Set([...cur, ...ok])])
    setAllowText("")
    setAllowDirty(true)
  }
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
      setNote({ ok: false, text: language.t("iris.publish.copyFailed", { url }) })
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
    if (busy()) return language.t("iris.publish.publishing")
    if (!board()) return language.t("iris.publish.chooseProject")
    const s = scope()
    if (!s) return language.t("iris.publish.chooseScope")
    return language.t(ACTION[s])
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
          gate: allowDirty()
            ? {
                allowedEmails: allow().filter((x) => !x.startsWith("@")),
                allowedDomains: allow().filter((x) => x.startsWith("@")).map((x) => x.slice(1)),
              }
            : undefined,
        }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; published?: { url: string } }
      if (out.ok && out.published) {
        dialog.close()
        setNote({
          ok: true,
          text:
            chosen === "private"
              ? language.t("iris.publish.note.private", { board: boardName() ?? "" })
              : language.t("iris.publish.note.live", { url: out.published.url.replace(/^https?:\/\//, ""), board: boardName() ?? "" }),
        })
        props.onPublished()
      } else setError(out.reason ?? language.t("iris.publish.error.http", { status: res.status }))
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
    setAllow([])
    setAllowText("")
    setAllowBad([])
    setAllowDirty(false)
    setAllowState(p ? "loading" : "none")
    if (p)
      void props
        .doFetch(
          `/iris/artifacts/${encodeURIComponent(props.meta.id)}/gate?session=${encodeURIComponent(props.sessionId)}${props.project ? `&project=${encodeURIComponent(props.project)}` : ""}`,
        )
        .then((r) => r.json())
        .then((g: { known?: boolean; allowedEmails?: string[]; allowedDomains?: string[] }) => {
          if (allowDirty()) return
          setAllow([...(g.allowedEmails ?? []), ...(g.allowedDomains ?? []).map((d) => `@${d}`)])
          setAllowState(g.known ? "known" : "unknown")
        })
        .catch(() => setAllowState("unknown"))
    // Pre-filled with the project chosen in the IRIS panel (#193407) — read NOW, at the press, not
    // when this component mounted — so the common case is one glance and a confirm. Only with
    // nothing chosen does it fall back to the panel's default board; with neither, the picker
    // is open: the modal asks rather than defaulting.
    const initial = () => initialPublishBoard({ selected: props.selectedBloqId, fallback: props.bloqId })
    let touched = false
    setBoard(initial())
    setPicking(initial() === undefined)
    setFilter("")
    setError(null)
    setNote(null)
    dialog.show(() => {
      // A project list that lands after the press only fills an EMPTY destination — it never
      // replaces the chosen project, nor one the person picked in the modal.
      createEffect(() => {
        const next = initial()
        if (touched || board() !== undefined || next === undefined) return
        setBoard(next)
        setPicking(false)
      })
      return (
        <Dialog
          title={props.meta.published ? language.t("iris.publish.title.update") : language.t("iris.publish.title")}
          description={props.meta.title}
          class="iris-pubm"
        >
          <form
            class="iris-pubm__form"
            data-testid="artifact-publish-modal"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div class="iris-pubm__body">
              {/* 1 · WHERE, before who. The destination is the decision; visibility qualifies it. */}
              <section class="iris-pubm__sec" aria-labelledby="pubm-where">
                <h3 class="iris-pubm__lbl" id="pubm-where">
                  <span class="iris-pubm__n">1</span>{language.t("iris.publish.where")}
                </h3>
                <Show
                  when={!picking()}
                  fallback={
                    <div class="iris-pubm__picker">
                      <div class="iris-pubm__search">
                        <Icon name="magnifying-glass" size="small" />
                        <input
                          placeholder={language.t("iris.publish.search.placeholder")}
                          value={filter()}
                          onInput={(e) => setFilter(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              const first = matches()[0]
                              if (first) {
                                touched = true
                                setBoard(first.id)
                                setPicking(false)
                              }
                            }
                          }}
                          aria-label={language.t("iris.publish.search.label")}
                          autofocus
                        />
                      </div>
                      <ul class="iris-publish__boards iris-pubm__boards" aria-label={language.t("iris.publish.projects")}>
                        <For each={matches()} fallback={<li class="iris-pubm__empty">{language.t("iris.publish.noMatch")}</li>}>
                          {(b) => (
                            <li>
                              <button
                                type="button"
                                class="iris-pubm__board"
                                aria-pressed={b.id === board()}
                                onClick={() => {
                                  touched = true
                                  setBoard(b.id)
                                  setPicking(false)
                                }}
                              >
                                <Icon name="folder" size="small" />
                                <span class="iris-pubm__boardname">{b.name}</span>
                                <span class="iris-pubm__id">#{b.id}</span>
                                <Show when={b.id === board()}>
                                  <Icon name="check-small" size="small" />
                                </Show>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  }
                >
                  <button
                    type="button"
                    class="iris-pubm__dest"
                    disabled={boards().length <= 1}
                    onClick={() => {
                      touched = true
                      setPicking(true)
                    }}
                    title={boards().length > 1 ? language.t("iris.publish.changeProject") : undefined}
                  >
                    <Icon name="folder" size="small" />
                    <strong class="iris-publish__destname">{boardName()}</strong>
                    <span class="iris-pubm__id">#{board()}</span>
                    <Show when={boards().length > 1}>
                      <span class="iris-pubm__change">{language.t("iris.publish.change")}</span>
                    </Show>
                  </button>
                </Show>
              </section>

              {/* 2 · the address, with the part you cannot change shown as part of it */}
              <section class="iris-pubm__sec" aria-labelledby="pubm-addr">
                <h3 class="iris-pubm__lbl" id="pubm-addr">
                  <span class="iris-pubm__n">2</span>{language.t("iris.publish.address")}
                </h3>
                <label class="iris-pubm__addr">
                  <span class="iris-pubm__prefix">heyiris.io/p/</span>
                  <input
                    value={slug()}
                    onInput={(e) => setSlug(e.currentTarget.value.toLowerCase())}
                    aria-label={language.t("iris.publish.address.label")}
                    spellcheck={false}
                  />
                </label>
              </section>

              {/* 3 · who. Nothing pre-selected — a default would make "public" the answer to not reading. */}
              <section class="iris-pubm__sec" aria-labelledby="pubm-who">
                <h3 class="iris-pubm__lbl" id="pubm-who">
                  <span class="iris-pubm__n">3</span>{language.t("iris.publish.who")}
                </h3>
                <div class="iris-pubm__scopes" role="radiogroup" aria-labelledby="pubm-who">
                  <For each={SCOPES}>
                    {(sc) => (
                      <label class="iris-pubm__scope" data-on={scope() === sc.id ? "1" : undefined}>
                        <input type="radio" name="scope" checked={scope() === sc.id} onChange={() => setScope(sc.id)} />
                        <Icon name={sc.icon} size="small" />
                        <span class="iris-pubm__scopename">{language.t(sc.label)}</span>
                        <span class="iris-pubm__scopehint">{language.t(sc.short)}</span>
                      </label>
                    )}
                  </For>
                </div>
                <label class="iris-pubm__switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={auth()}
                    onChange={(e) => setAuth(e.currentTarget.checked)}
                  />
                  <span class="iris-pubm__track" aria-hidden="true" />
                  <span>
                    {language.t("iris.publish.requireSignIn")}
                    <span class="iris-pubm__scopehint">{language.t("iris.publish.requireSignIn.hint")}</span>
                  </span>
                </label>
                {/* Who can sign in (#193846). Without this, "Require sign-in" turned on a door
                    whose list nobody could see, and people were refused with "not authorized
                    for this workspace". The words below are fl-api's actual rule
                    (GateDomainPolicy), not a guess. */}
                <Show when={auth()}>
                  <div class="iris-pubm__who" data-testid="artifact-signin-list">
                    <span class="iris-pubm__wholbl">
                      <span class="iris-pubm__tone" data-tone="info">
                        <Icon name="shield" size="small" />
                      </span>
                      {language.t("iris.publish.whoSignIn")}
                    </span>
                    <Show when={allow().length > 0}>
                      <div class="iris-pubm__chips">
                        <For each={allow()}>
                          {(entry) => (
                            <span class="iris-pubm__chip">
                              <StatusBadge size="small" tone="info" mark={<Icon name={entry.startsWith("@") ? "globe" : "at"} size="small" />}>
                                {entry}
                              </StatusBadge>
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                size="small"
                                class="iris-pubm__chipx"
                                aria-label={language.t("iris.publish.remove", { entry })}
                                onClick={() => {
                                  setAllow((cur) => cur.filter((x) => x !== entry))
                                  setAllowDirty(true)
                                }}
                              />
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="iris-pubm__whoadd">
                      <input
                        type="text"
                        placeholder={language.t("iris.publish.allow.placeholder")}
                        aria-label={language.t("iris.publish.allow.label")}
                        value={allowText()}
                        onInput={(e) => setAllowText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return
                          e.preventDefault()
                          addAllowed()
                        }}
                      />
                      <Button type="button" size="small" disabled={!allowText().trim()} onClick={addAllowed}>
                        {language.t("iris.publish.allow.add")}
                      </Button>
                    </div>
                    <Show when={allowBad().length > 0}>
                      <p class="iris-pubm__error" role="alert">
                        {language.t("iris.publish.allow.bad", { entries: allowBad().join(", ") })}
                      </p>
                    </Show>
                    <p class="iris-pubm__whosum" data-tone={signInTone(allow(), allowState())}>
                      <span class="iris-pubm__tone">
                        <Icon name={signInTone(allow(), allowState()) === "good" ? "circle-check" : signInTone(allow(), allowState()) === "warn" ? "warning" : "clock"} size="small" />
                      </span>
                      <span>{signInSummary(allow(), allowState(), boardName() ?? "")}</span>
                    </p>
                  </div>
                </Show>
              </section>
            </div>

            <footer class="iris-pubm__foot">
              {/* The consequence, in one sentence, where the decision is made. */}
              <p
                class="iris-pubm__summary"
                data-testid="artifact-publish-summary"
                data-ready={scope() && board() ? "1" : undefined}
              >
                <Show when={scope()} keyed fallback={<Icon name="help" size="small" />}>
                  {(chosen) => <Icon name={SCOPES.find((x) => x.id === chosen)!.icon} size="small" />}
                </Show>
                <span>
                  {publishSummary(scope(), slug(), boardName())}
                  {props.meta.published ? language.t("iris.publish.updatesSame") : ""}
                </span>
              </p>
              <Show when={error()}>
                <p class="iris-pubm__error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="iris-pubm__actions">
                <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
                <Button type="submit" variant="primary" disabled={!board() || !scope() || !slug().trim() || busy()}>
                  {submitLabel()}
                </Button>
              </div>
            </footer>
          </form>
        </Dialog>
      )
    })
  }
  createEffect(
    on(
      () => props.publishRequest,
      (n) => {
        if (n) openModal()
      },
      { defer: true },
    ),
  )


  return (
    <div class="iris-publish">
      <div class="iris-publish__bar">
        {/* The address stays IN the app (#186541). The live page is exactly this artifact's
            revision, already on screen below — so the link is shown and copyable, and leaving
            for the browser is a separate, explicit action. */}
        <Show when={props.meta.published}>
          {(p) => (
            <span class="iris-publish__addr" data-testid="artifact-page-link">
              {/* No address text in the bar (#193844): like the Genesis Pages toolbar, the link
                  lives behind Copy (its tooltip names it) and Open in browser. The text fought
                  the title for width and pushed the bar onto three lines. */}
              <Show when={p().visibility === "private"}>
                <span class="iris-publish__muted">{language.t("iris.publish.privateIn")}</span>
              </Show>
              {/* The Genesis Pages toolbar's controls (#193844), from the ui library (#194375 W5): icon
                  buttons and a Draft | Live segment, not a row of text links that wrapped onto three
                  lines in a narrow window. Each icon keeps its name as tooltip and accessible label. */}
              <IconButton
                icon={copied() ? "check" : "copy"}
                variant="ghost"
                size="small"
                title={copied() ? language.t("iris.publish.copied") : language.t("iris.publish.copyLink.title", { url: p().url.replace(/^https?:\/\//, "") })}
                aria-label={copied() ? language.t("iris.publish.copied") : language.t("iris.publish.copyLink")}
                onClick={() => void copy(p().url)}
              />
              {/* A real link (the browser opens it), drawn as the library's ghost icon button. */}
              <a
                class="iris-publish__open"
                data-component="icon-button"
                data-variant="ghost"
                data-size="small"
                href={p().url}
                target="_blank"
                rel="noopener noreferrer"
                title={language.t("iris.publish.openBrowser")}
                aria-label={language.t("iris.publish.openBrowser")}
              >
                <Icon name="square-arrow-top-right" size="small" />
              </a>
              <Show when={props.onToggleLive}>
                <RadioGroup
                  size="small"
                  class="iris-publish__live"
                  aria-label={language.t("iris.publish.show")}
                  options={["draft", "live"]}
                  current={props.live ? "live" : "draft"}
                  label={(v) => (v === "live" ? language.t("iris.publish.live") : language.t("iris.publish.draft"))}
                  onSelect={(v) => v && (v === "live") !== !!props.live && props.onToggleLive?.()}
                />
              </Show>
            </span>
          )}
        </Show>
        <Show when={state().behind}>
          <span class="iris-publish__behind">
            {language.t("iris.publish.behind", { page: props.meta.published?.revision ?? "", rev: props.meta.revision })}
          </span>
        </Show>
        <span class="iris-publish__spacer" />
        <Show
          when={publishable()}
          fallback={<span class="iris-publish__muted">{language.t("iris.publish.cantPublish", { kind: props.meta.kind })}</span>}
        >
          <Show when={!props.meta.published}>
            <Button size="small" onClick={() => openModal("private")}>
              {language.t("iris.publish.action.private")}
            </Button>
          </Show>
          <Button size="small" variant="primary" onClick={() => openModal()}>
            {state().label}
          </Button>
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

/** Green when a list limits who gets in; amber when it's empty (anyone with the code) or unread. */
export function signInTone(list: string[], state: "none" | "loading" | "known" | "unknown") {
  if (state === "loading") return "idle"
  return list.length > 0 ? "good" : "warn"
}

/** An address, or a domain with or without its leading @. */
function isSignInEntry(x: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) || /^@?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(x)
}

/**
 * What the list MEANS at the door, in words (fl-api GateDomainPolicy). Board members always get a
 * code. A list admits its addresses and domains. An empty list admits anyone who can receive a
 * code, except on a board marked sensitive or PHI, where only members (and people given a role)
 * get in — the empty case is said out loud because a quiet blank is how gates leaked before.
 */
export function signInSummary(list: string[], state: "none" | "loading" | "known" | "unknown", board: string) {
  if (state === "loading") return "Reading this page's current list…"
  if (state === "unknown" && list.length === 0)
    return "Couldn't read this page's current list. It stays as it is unless you add someone here."
  const members = board ? `Members of ${board}` : "Board members"
  if (list.length === 0)
    return `${members}, and anyone who can receive the code — unless the board is marked sensitive. Add an email or @domain to limit it.`
  return `${members}, plus ${list.length === 1 ? "this entry" : `these ${list.length}`}. Anyone else is told they aren't authorized.`
}
