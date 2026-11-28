import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { IRIS_SHELL_PHONE_QUERY } from "@/components/iris-shell-layout"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { usePlatform } from "@/context/platform"
import { persisted } from "@/utils/persist"
import { CALLOUTS, pickCallout, placeCallout, type Callout } from "./feature-callouts"
import "./feature-callout.css"

/** How long a control must sit on screen before its callout appears. */
const SETTLE_MS = 1500
const POLL_MS = 400

function onScreen(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
}

const find = (target: string) => document.querySelector(`[data-callout="${target}"]`)

/**
 * One "New" callout at a time, pointing at the control it is about (#193866).
 * Shown once per person on this device: closing it, or using the control, marks it seen.
 * At most one per app launch, so nobody is walked through a queue of them.
 */
export function FeatureCallouts(props: { callouts?: Callout[] }) {
  const platform = usePlatform()
  const phone = createMediaQuery(IRIS_SHELL_PHONE_QUERY)
  const [store, setStore, , ready] = persisted("callouts.v1", createStore<{ seen: string[] }>({ seen: [] }))
  const [active, setActive] = createSignal<{ callout: Callout; target: string }>()
  const [pos, setPos] = createSignal<ReturnType<typeof placeCallout>>()
  let card: HTMLDivElement | undefined
  let shownThisLaunch = false
  let candidateSince: number | undefined

  const markSeen = (id: string) => {
    if (!store.seen.includes(id)) setStore("seen", (s) => [...s, id])
    setActive(undefined)
  }

  const place = () => {
    const a = active()
    if (!a) return
    const el = find(a.target)
    if (!onScreen(el)) return setPos(undefined)
    const r = el.getBoundingClientRect()
    setPos(
      placeCallout({
        target: { top: r.top, left: r.left, width: r.width, height: r.height },
        card: { width: card?.offsetWidth || 320, height: card?.offsetHeight || 120 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    )
  }

  const tick = () => {
    if (!ready()) return
    if (active()) return place()
    if (shownThisLaunch) return
    // Never on top of a dialog or onboarding: wait until the person is back in the app.
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return void (candidateSince = undefined)
    const next = pickCallout({
      callouts: props.callouts ?? CALLOUTS,
      seen: store.seen,
      // A dev build reports the branch label (1.18.23), not a release number, so the
      // version gate would hide everything; releases stamp the real number (release-desktop.yml).
      version: import.meta.env.DEV ? undefined : platform.version,
      now: new Date(),
      onScreen: (t) => onScreen(find(t)),
      phone: phone(),
    })
    if (!next) return void (candidateSince = undefined)
    candidateSince ??= Date.now()
    if (Date.now() - candidateSince < SETTLE_MS) return
    shownThisLaunch = true
    setActive(next)
    queueMicrotask(place)
  }

  // Using the control counts as seeing the news.
  const onPointerDown = (e: PointerEvent) => {
    const a = active()
    if (!a) return
    const el = find(a.target)
    if (el && e.target instanceof Node && el.contains(e.target)) markSeen(a.callout.id)
  }
  const onKey = (e: KeyboardEvent) => {
    const a = active()
    if (a && e.key === "Escape") markSeen(a.callout.id)
  }

  onMount(() => {
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener("resize", place)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("resize", place)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <Show when={!phone() && active()}>
      {(a) => (
        <Portal>
          <div
            ref={card}
            class="iris-callout"
            role="status"
            aria-live="polite"
            data-side={pos()?.side ?? "below"}
            data-ready={pos() ? "" : undefined}
            style={{
              top: `${pos()?.top ?? -9999}px`,
              left: `${pos()?.left ?? -9999}px`,
              "--iris-callout-arrow": `${pos()?.arrow ?? 24}px`,
            }}
          >
            <div class="iris-callout-head">
              <span class="iris-callout-title">{a().callout.title}</span>
              <span class="iris-callout-badge">New</span>
              <button
                type="button"
                class="iris-callout-close"
                aria-label="Dismiss"
                onClick={() => markSeen(a().callout.id)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <p class="iris-callout-body">{a().callout.body}</p>
          </div>
        </Portal>
      )}
    </Show>
  )
}
