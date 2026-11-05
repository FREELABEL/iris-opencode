import { For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { PinResult } from "./iris-marketing"
import {
  afterBoards,
  afterSetup,
  confirmText,
  pinRefused,
  type CampaignBoard,
  type CampaignBoards,
  type CampaignSetup,
  type Step,
} from "./iris-campaign-onboarding-model"
import "./iris-campaign-onboarding.css"

/**
 * "CREATE YOUR CAMPAIGN BOARD" (#192627, epic #192614) — Desktop › Marketing's way to get a review
 * page like FREELABEL's ads review on the account's own board, in one click.
 *
 * Drawn in the Marketing empty state (its `emptyActions` slot) and, small, at the top of the "+"
 * picker, so an account that already has pins can do it too. Pick a board (skipped when there is one),
 * confirm what will be made, run the engine's setup (fl-api #192625), then pin the review page signed
 * in. The rules are in iris-campaign-onboarding-model.ts.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Pin = (slug: string, label?: string, opts?: { signIn?: boolean }) => Promise<PinResult>

export function IrisCampaignOnboarding(props: { doFetch: Fetch; pin: Pin; compact?: boolean }) {
  const [s, set] = createStore<{ step: Step }>({ step: { at: "idle" } })
  const go = (step: Step) => set("step", step)

  const loadBoards = () => {
    go({ at: "loading" })
    void props
      .doFetch("/iris/campaigns/boards", { headers: { Accept: "application/json" } })
      .then((r) => r.json() as Promise<CampaignBoards>)
      .catch((): CampaignBoards => ({ measured: false, reason: "IRIS isn't answering right now.", boards: [] }))
      .then((r) => go(afterBoards(r)))
  }

  const run = async (board: CampaignBoard) => {
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

  const boards = () => {
    const st = s.step
    return st.at === "pick" || st.at === "confirm" ? st.boards : []
  }

  return (
    <div class="iris-camp" classList={{ "iris-camp--compact": props.compact }} data-component="iris-campaign-onboarding" data-step={s.step.at}>
      <Switch>
        <Match when={s.step.at === "idle"}>
          <Show
            when={props.compact}
            fallback={
              <Button size="small" variant="primary" icon="plus-small" onClick={loadBoards} data-action="campaign-create">
                Create your campaign board
              </Button>
            }
          >
            <button type="button" class="iris-camp__entry" onClick={loadBoards} data-action="campaign-create">
              <Icon name="plus-small" size="small" />
              <span class="iris-camp__entry-title">New campaign board</span>
              <span class="iris-camp__entry-hint">A private review page for your ads, on one of your boards</span>
            </button>
          </Show>
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
                    onClick={() => go({ at: "confirm", board: b, boards: boards() })}
                  >
                    <span class="iris-camp__board-name">{b.name}</span>
                    <span class="iris-camp__tag">{b.role === "owner" ? "yours" : "editor"}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="iris-camp__actions">
              <Button size="small" variant="ghost" onClick={() => go({ at: "idle" })}>
                Cancel
              </Button>
            </div>
          </div>
        </Match>

        <Match when={s.step.at === "confirm" && (s.step as Extract<Step, { at: "confirm" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-confirm">
              <div class="iris-camp__title">Create a campaign board on {st().board.name}?</div>
              <div class="iris-camp__text">{confirmText(st().board)}</div>
              <div class="iris-camp__actions">
                <Button size="small" variant="primary" onClick={() => void run(st().board)} data-action="campaign-confirm">
                  Create it
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => go(st().boards.length > 1 ? { at: "pick", boards: st().boards } : { at: "idle" })}
                >
                  {st().boards.length > 1 ? "Back" : "Cancel"}
                </Button>
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "running" && (s.step as Extract<Step, { at: "running" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-running">
              <div class="iris-camp__busy">
                <Spinner class="iris-camp__spin" /> Setting up {st().board.name}…
              </div>
            </div>
          )}
        </Match>

        <Match when={s.step.at === "pinned" && (s.step as Extract<Step, { at: "pinned" }>)}>
          {(st) => (
            <div class="iris-camp__card" data-slot="campaign-pinned">
              <div class="iris-camp__title">
                {st().already ? `${st().board.name} was already set up — its review page is pinned` : `${st().board.name}'s review page is pinned`}
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
                      if (b) return void run(b)
                      loadBoards()
                    }}
                  >
                    Try again
                  </Button>
                </Show>
                <Button size="small" variant="ghost" onClick={() => go({ at: "idle" })}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
