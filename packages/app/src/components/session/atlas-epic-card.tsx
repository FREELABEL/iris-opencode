import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ToolRegistry } from "@opencode-ai/session-ui/message-part"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { GmailLogo, OutlookLogo } from "@/pages/home/home-first-run-art"
import {
  BUTTON_LABEL,
  STATUS_LABEL,
  buttonsFor,
  hue,
  initials,
  itemKey,
  progress,
  promptFor,
  readEpic,
  sourceMark,
  type ButtonAction,
  type CardItem,
  type CardList,
} from "./atlas-epic-model"
import { requestIrisNav } from "./iris-nav"
import "./atlas-epic-card.css"

/**
 * The chat's side of `atlas_epic`: a plan as a card — header with progress, one collapsible
 * section per list, items you can tick off, drafts quoted in full.
 *
 * NO BUTTON SENDS ANYTHING. "Review & send", "Edit" and "Walk me through it" put a request in the
 * composer and focus it; the person reads it, may change it, and presses enter. The agent acts on
 * that as an ordinary turn. "Dismiss" is local: it ticks the item off.
 *
 * Ticks are saved to Atlas (status done/todo through the sidecar's /iris/item/:id/save) when the
 * epic was saved and the item has an id; otherwise they are local to this card.
 */

/** Optional contexts: a card rendered outside a session (a share view) must still draw. */
function tryUse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function SourceIcon(props: { source?: string }) {
  return (
    <span class="atlas-epic__icon" aria-hidden="true">
      <Show
        when={props.source === "gmail"}
        fallback={
          <Show when={props.source === "outlook"} fallback={<span class="atlas-epic__mono">{sourceMark(props.source)}</span>}>
            <OutlookLogo class="atlas-epic__logo" />
          </Show>
        }
      >
        <GmailLogo class="atlas-epic__logo" />
      </Show>
    </span>
  )
}

ToolRegistry.register({
  name: "atlas_epic",
  render(props) {
    const epic = createMemo(() => readEpic(props.input, props.metadata, props.status))
    const prompt = tryUse(() => usePrompt())
    const platform = tryUse(() => usePlatform())
    const serverSDK = tryUse(() => useServerSDK())
    const layout = tryUse(() => useLayout())
    const session = tryUse(() => useSessionLayout())

    // Tick state: undefined = follow the data; true/false = the person's choice.
    const [ticks, setTicks] = createStore<Record<string, boolean>>({})
    // Sections start folded (Alex, 2026-10-09): the card reads as a summary — each list's header,
    // badge and count — and opens where you click.
    const [opened, setOpened] = createStore<Record<number, boolean>>({})
    const [note, setNote] = createSignal<string>()
    const prog = createMemo(() => progress(epic(), (k) => ticks[k]))

    const isDone = (li: number, ii: number, it: CardItem, l: CardList) =>
      ticks[itemKey(li, ii, it)] ?? (it.done === true || l.status === "done")

    async function tick(li: number, ii: number, it: CardItem, l: CardList, value: boolean) {
      const key = itemKey(li, ii, it)
      const before = ticks[key]
      setTicks(key, value)
      if (!epic().saved || !it.id || !serverSDK) return
      try {
        const base = serverSDK().url.replace(/\/$/, "")
        const doFetch = platform?.fetch ?? globalThis.fetch
        const res = await doFetch(`${base}/iris/item/${it.id}/save`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: value ? "done" : "todo" }),
        })
        const j = /json/i.test(res.headers.get("content-type") ?? "") ? await res.json().catch(() => undefined) : undefined
        if (!res.ok || !j?.ok) throw new Error(j?.reason ?? `request failed (${res.status})`)
        setNote(undefined)
      } catch (e) {
        setTicks(key, before as boolean)
        setNote(`Couldn't update "${it.title}" in Atlas: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    function ask(action: Exclude<ButtonAction, "dismiss">, it: CardItem, l: CardList) {
      const text = promptFor(action, it, l)
      if (!prompt) {
        // TODO(atlas_epic): no composer in this context (e.g. a shared transcript) — nothing to do.
        setNote("Open this conversation to act on it.")
        return
      }
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus(),
      )
    }

    function openInAtlas() {
      const id = epic().bloqId
      requestIrisNav({ surface: "atlas", bloqId: id })
      if (!session || !layout) return
      // Same three steps as the Genesis/Atlas artifact cards: open the side panel on the IRIS tab.
      session.view().reviewPanel.open("other")
      if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
      void session.tabs().open("iris")
      session.tabs().setActive("iris")
    }

    return (
      <section class="atlas-epic" data-working={epic().working ? "" : undefined} aria-label={`Atlas Epic: ${epic().title}`}>
        <header class="atlas-epic__head">
          <div class="atlas-epic__eyebrow">
            <span>Atlas Epic</span>
            <Show when={epic().working}>
              <span class="atlas-epic__pill" data-status="working">
                Working
              </span>
            </Show>
          </div>
          <h3 class="atlas-epic__title">{epic().title}</h3>
          <Show when={epic().summary}>
            <p class="atlas-epic__summary">{epic().summary}</p>
          </Show>
          <Show when={prog().total > 0}>
            <div class="atlas-epic__progress">
              <div
                class="atlas-epic__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={prog().total}
                aria-valuenow={prog().done}
              >
                <span style={{ width: `${(prog().done / prog().total) * 100}%` }} />
              </div>
              <span class="atlas-epic__count">
                {prog().done} of {prog().total} done
              </span>
            </div>
          </Show>
        </header>

        <For each={epic().lists}>
          {(l, li) => (
            <div class="atlas-epic__list">
              <button
                type="button"
                class="atlas-epic__list-head"
                aria-expanded={!!opened[li()]}
                onClick={() => setOpened(li(), !opened[li()])}
              >
                <SourceIcon source={l.source} />
                <span class="atlas-epic__list-title">{l.title}</span>
                <Show when={l.status && l.status !== "none"}>
                  <span class="atlas-epic__pill" data-status={l.status}>
                    {l.label ?? STATUS_LABEL[l.status!]}
                  </span>
                </Show>
                <Show when={(!l.status || l.status === "none") && l.label}>
                  <span class="atlas-epic__pill" data-status="none">
                    {l.label}
                  </span>
                </Show>
                <span class="atlas-epic__chev" aria-hidden="true">
                  {opened[li()] ? "⌄" : "›"}
                </span>
              </button>
              <Show when={opened[li()]}>
                <ul class="atlas-epic__items">
                  <For each={l.items}>
                    {(it, ii) => (
                      <li class="atlas-epic__item" data-done={isDone(li(), ii(), it, l) ? "" : undefined}>
                        <input
                          type="checkbox"
                          class="atlas-epic__check"
                          checked={isDone(li(), ii(), it, l)}
                          disabled={epic().working}
                          aria-label={`Mark ${it.title} done`}
                          onChange={(e) => void tick(li(), ii(), it, l, e.currentTarget.checked)}
                        />
                        <span
                          class="atlas-epic__avatar"
                          aria-hidden="true"
                          style={{ "--epic-hue": String(hue(it.title)) }}
                        >
                          {initials(it.title)}
                        </span>
                        <div class="atlas-epic__main">
                          <div class="atlas-epic__line">
                            <span class="atlas-epic__item-title">{it.title}</span>
                            <Show when={it.subtitle}>
                              <span class="atlas-epic__item-sub">{it.subtitle}</span>
                            </Show>
                          </div>
                          <Show when={it.body}>
                            <blockquote class="atlas-epic__body">{it.body}</blockquote>
                          </Show>
                          <Show when={!epic().working && buttonsFor(it).length > 0 && !isDone(li(), ii(), it, l)}>
                            <div class="atlas-epic__actions">
                              <For each={buttonsFor(it)}>
                                {(b) => (
                                  <button
                                    type="button"
                                    class="atlas-epic__btn"
                                    data-variant={b === "send" || b === "walk" ? "solid" : "outline"}
                                    onClick={() => (b === "dismiss" ? void tick(li(), ii(), it, l, true) : ask(b, it, l))}
                                  >
                                    {BUTTON_LABEL[b]}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          )}
        </For>

        <footer class="atlas-epic__foot">
          <Show when={!epic().working}>
            <Show
              when={epic().saved}
              fallback={<span class="atlas-epic__muted">Not saved{epic().reason ? `: ${epic().reason}` : ""}</span>}
            >
              <span class="atlas-epic__muted">
                Saved to Atlas{epic().reason ? ` — ${epic().reason}` : ""}
              </span>
              <button type="button" class="atlas-epic__link" onClick={openInAtlas}>
                Open in Atlas ›
              </button>
            </Show>
          </Show>
          <Show when={note()}>
            <span class="atlas-epic__note" role="status">
              {note()}
            </span>
          </Show>
        </footer>
      </section>
    )
  },
})
