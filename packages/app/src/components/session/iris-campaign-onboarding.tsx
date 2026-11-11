import { createEffect, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { PinResult } from "./iris-marketing"
import {
  afterBoards,
  afterMake,
  afterSetup,
  boardTag,
  confirmText,
  KINDS,
  kindTitle,
  nameText,
  pinRefused,
  type CampaignBoard,
  type CampaignBoards,
  type CampaignSetup,
  type MakeKind,
  type MakeResult,
  type Step,
} from "./iris-campaign-onboarding-model"
import "./iris-campaign-onboarding.css"

/**
 * MARKETING "+" — MAKE SOMETHING NEW (#193233, was "Create your campaign board" #192627).
 *
 * A wizard: what are you making (campaign review / landing page / brand kit) → which board → a name
 * (or, for a campaign review, a confirm) → made, and pinned where it is a page. While it is past its
 * entry button it tells the host (`onActive`) so the host hides everything else — the page search,
 * the page list — and Esc backs out. The rules are in iris-campaign-onboarding-model.ts.
 *
 *   campaign review  POST /iris/campaigns/setup        then pin /p/<board-slug>-campaigns signed in
 *   landing page     POST /iris/marketing/landing-page then pin the new draft page signed in
 *   brand kit        POST /iris/marketing/brand        then offer Genesis › Brand kits (a kit is not a page)
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Pin = (slug: string, label?: string, opts?: { signIn?: boolean }) => Promise<PinResult>

export function IrisCampaignOnboarding(props: {
  doFetch: Fetch
  pin: Pin
  compact?: boolean
  /** True while the wizard is open (past its entry button), so the host can hide what would distract. */
  onActive?: (active: boolean) => void
  /** Open Genesis › Brand kits, after a kit is made. */
  openBrandKits?: () => void
}) {
  const [s, set] = createStore<{ step: Step; kind: MakeKind; name: string }>({ step: { at: "idle" }, kind: "campaign", name: "" })
  const go = (step: Step) => set("step", step)
  const close = () => {
    set("name", "")
    go({ at: "idle" })
  }

  const active = () => s.step.at !== "idle"
  createEffect(() => props.onActive?.(active()))
  onCleanup(() => props.onActive?.(false))

  // Esc backs out of the wizard from anywhere on the page — but never mid-request.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !active() || s.step.at === "running" || s.step.at === "loading") return
    e.preventDefault()
    e.stopPropagation()
    close()
  }
  window.addEventListener("keydown", onKey, true)
  onCleanup(() => window.removeEventListener("keydown", onKey, true))

  const loadBoards = (kind: MakeKind) => {
    set("kind", kind)
    go({ at: "loading" })
    void props
      .doFetch("/iris/campaigns/boards", { headers: { Accept: "application/json" } })
      .then((r) => r.json() as Promise<CampaignBoards>)
      .catch((): CampaignBoards => ({ measured: false, reason: "IRIS isn't answering right now.", boards: [] }))
      .then((r) => go(afterBoards(r, kind)))
  }

  const chooseBoard = (b: CampaignBoard, boards: CampaignBoard[]) =>
    go(s.kind === "campaign" ? { at: "confirm", board: b, boards } : { at: "name", board: b, boards })

  const runCampaign = async (board: CampaignBoard) => {
    go({ at: "running", board })
    const r = await props
      .doFetch("/iris/campaigns/setup", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ bloq_id: board.id }),
      })
      .then((x) => x.json() as Promise<CampaignSetup>)
      .catch((): CampaignSetup => ({ ok: false, error: { kind: "unreachable", message: "IRIS isn't answering right now. Nothing was made." } }))
    const next = afterSetup(board, r)
    if (next.do === "say") return go(next.step)
    // The review page is members-only: open it signed in (#192482), whatever the list says about it.
    const pinned = await props.pin(next.slug, next.label, { signIn: true })
    go(pinned.ok ? { at: "pinned", board, already: next.already } : pinRefused(board, next.slug, pinned.reason))
  }

  const runMake = async (board: CampaignBoard) => {
    const kind = s.kind
    if (kind === "campaign") return runCampaign(board)
    const name = s.name.trim()
    if (!name) return
    go({ at: "running", board })
    const r = await props
      .doFetch(kind === "landing" ? "/iris/marketing/landing-page" : "/iris/marketing/brand", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ bloq_id: board.id, name }),
      })
      .then((x) => x.json() as Promise<MakeResult>)
      .catch((): MakeResult => ({ ok: false, error: { kind: "unreachable", message: "IRIS isn't answering right now. Nothing was made." } }))
    const next = afterMake(kind, board, r)
    if (next.do === "say" || next.do === "made") return go(next.step)
    // A draft page isn't public: open it signed in.
    const pinned = await props.pin(next.slug, next.label, { signIn: true })
    go(pinned.ok ? { at: "pinned", board, already: false } : pinRefused(board, next.slug, pinned.reason))
  }

  const boards = () => {
    const st = s.step
    return st.at === "pick" || st.at === "confirm" || st.at === "name" ? st.boards : []
  }
  const back = (list: CampaignBoard[]) => go(list.length > 1 ? { at: "pick", boards: list } : { at: "choose" })

  return (
    <div
      class="iris-camp"
      classList={{ "iris-camp--compact": props.compact, "iris-camp--active": active() }}
      data-component="iris-campaign-onboarding"
      data-step={s.step.at}
      data-kind={s.kind}
    >
      <Switch>
        <Match when={s.step.at === "idle"}>
          <Show
            when={props.compact}
            fallback={
              <Button size="small" variant="primary" icon="plus-small" onClick={() => go({ at: "choose" })} data-action="marketing-new">
                Make something new
              </Button>
            }
          >
            <button type="button" class="iris-camp__entry" onClick={() => go({ at: "choose" })} data-action="marketing-new">
              <Icon name="plus-small" size="small" />
              <span class="iris-camp__entry-title">Make something new</span>
              <span class="iris-camp__entry-hint">A campaign review, a landing page or a brand kit, on one of your boards</span>
            </button>
          </Show>
        </Match>

        <Match when={s.step.at === "choose"}>
          <div class="iris-camp__card" data-slot="marketing-choose">
            <div class="iris-camp__title">What are you making?</div>
            <div class="iris-camp__kinds" role="list">
              <For each={KINDS}>
                {(k) => (
                  <button type="button" role="listitem" class="iris-camp__kind" data-kind={k.kind} onClick={() => loadBoards(k.kind)}>
                    <span class="iris-camp__kind-title">{k.title}</span>
                    <span class="iris-camp__kind-hint">{k.hint}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="iris-camp__actions">
              <Button size="small" variant="ghost" onClick={close} data-action="wizard-cancel">
                Cancel
              </Button>
            </div>
          </div>
        </Match>

        <Match when={s.step.at === "loading"}>
          <div class="iris-camp__card" data-slot="campaign-loading">
            <div class="iris-camp__busy">
              <Spinner class="iris-camp__spin" /> Reading your boards…
            </div>
          </div>
        </Match>

        <Match when={s.step.at === "pick"}>
          <div class="iris-camp__card" data-slot="campaign-pick">
            <div class="iris-camp__step">{kindTitle(s.kind)}</div>
            <div class="iris-camp__title">Which board is this for?</div>
            <div class="iris-camp__text">Boards you own or can edit.</div>
            <div class="iris-camp__boards" role="listbox" aria-label="Your boards">
              <For each={boards()}>
                {(b) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    class="iris-camp__board"
                    data-board={b.name}
                    onClick={() => chooseBoard(b, boards())}
                  >
                    <span class="iris-camp__board-name">{b.name}</span>
                    <Show when={boardTag(b)}>{(t) => <span class="iris-camp__tag">{t()}</span>}</Show>
                  </button>
                )}
              </For>
            </div>
            <div class="iris-camp__actions">
              <Button size="small" variant="ghost" onClick={() => go({ at: "choose" })}>
                Back
              </Button>
              <Button size="small" variant="ghost" onClick={close} data-action="wizard-cancel">
                Cancel
              </Button>
            </div>
          </div>
        </Match>

        <Match when={s.step.at === "confirm" && (s.step as Extract<Step, { at: "confirm" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-confirm">
              <div class="iris-camp__step">{kindTitle("campaign")}</div>
              <div class="iris-camp__title">Create a campaign review on {st().board.name}?</div>
              <div class="iris-camp__text">{confirmText(st().board)}</div>
              <div class="iris-camp__actions">
                <Button size="small" variant="primary" onClick={() => void runCampaign(st().board)} data-action="campaign-confirm">
                  Create it
                </Button>
                <Button size="small" variant="ghost" onClick={() => back(st().boards)}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "name" && (s.step as Extract<Step, { at: "name" }>)}>
          {(st) => {
            const kind = () => s.kind as Exclude<MakeKind, "campaign">
            return (
              <form
                class="iris-camp__card"
                data-slot="marketing-name"
                onSubmit={(e) => {
                  e.preventDefault()
                  void runMake(st().board)
                }}
              >
                <div class="iris-camp__step">{kindTitle(kind())}</div>
                <label class="iris-camp__title" for="iris-camp-name">
                  {kind() === "landing" ? "What's the page called?" : "What's the brand called?"}
                </label>
                <input
                  id="iris-camp-name"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  class="iris-camp__input"
                  type="text"
                  maxLength={120}
                  placeholder={kind() === "landing" ? "Spring launch" : "Acme Shoes"}
                  value={s.name}
                  onInput={(e) => set("name", e.currentTarget.value)}
                />
                <div class="iris-camp__text">{nameText(kind(), st().board)}</div>
                <div class="iris-camp__actions">
                  <Button size="small" variant="primary" type="submit" disabled={!s.name.trim()} data-action="marketing-make">
                    Make it
                  </Button>
                  <Button size="small" variant="ghost" type="button" onClick={() => back(st().boards)}>
                    Back
                  </Button>
                </div>
              </form>
            )
          }}
        </Match>

        <Match when={s.step.at === "running" && (s.step as Extract<Step, { at: "running" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-running">
              <div class="iris-camp__busy">
                <Spinner class="iris-camp__spin" />
                {s.kind === "campaign" ? `Setting up ${st().board.name}…` : `Making ${s.name.trim()} on ${st().board.name}…`}
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "pinned" && (s.step as Extract<Step, { at: "pinned" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-pinned">
              <div class="iris-camp__title">
                {s.kind === "landing"
                  ? `${s.name.trim()} is made and pinned`
                  : st().already
                    ? `${st().board.name} was already set up — its review page is pinned`
                    : `${st().board.name}'s review page is pinned`}
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "made" && (s.step as Extract<Step, { at: "made" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="marketing-made">
              <div class="iris-camp__title">{st().name}'s brand kit is made</div>
              <div class="iris-camp__text">
                It's on {st().board.name}. Add its logo, colours and type in Genesis › Brand kits.
              </div>
              <div class="iris-camp__actions">
                <Show when={props.openBrandKits}>
                  {(open) => (
                    <Button size="small" variant="primary" onClick={() => open()()} data-action="open-brand-kits">
                      Open Brand kits
                    </Button>
                  )}
                </Show>
                <Button size="small" variant="ghost" onClick={close}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "message" && (s.step as Extract<Step, { at: "message" }>)}>
          {(st) => (
            <div class="iris-camp__card" classList={{ "iris-camp__card--error": st().tone === "error" }} data-slot="campaign-message" role="status">
              <div class="iris-camp__title">
                <Show when={st().tone === "error"}>
                  <Icon name="circle-x" size="small" class="iris-camp__warn" />
                </Show>
                {st().title}
              </div>
              <div class="iris-camp__text">{st().body}</div>
              <div class="iris-camp__actions">
                <Show when={st().retry}>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                      const b = st().board
                      if (b) return void runMake(b)
                      loadBoards(s.kind)
                    }}
                  >
                    Try again
                  </Button>
                </Show>
                <Button size="small" variant="ghost" onClick={close}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
