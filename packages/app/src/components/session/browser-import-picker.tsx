import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { NativeBrowser, NativeBrowserImported, NativeBrowserImportSource } from "@/context/platform"
import { filterSites, presetSites, primarySource, saveChoice } from "./browser-import"

/**
 * "Use my Chrome sign-ins" (S3b, #193051): pick a Chrome profile and the sites to bring in.
 *
 * It is a role="dialog", so the native page hides while it is open (OVERLAY_SELECTOR) and the
 * picker draws where the page was. Only site names and counts are shown: the Rust side decrypts
 * and writes the cookies, and their values never reach this code.
 */
export function BrowserImportPicker(props: {
  browser: NativeBrowser
  onClose: () => void
  onDone: (r: NativeBrowserImported) => void
}) {
  const [sources, setSources] = createSignal<NativeBrowserImportSource[]>()
  const [sourceId, setSourceId] = createSignal<string>()
  const [ticked, setTicked] = createSignal<Set<string>>(new Set())
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const source = createMemo(() => sources()?.find((s) => s.id === sourceId()))
  const shown = createMemo(() => filterSites(source(), query()))

  const pick = (id: string) => {
    setSourceId(id)
    setTicked(new Set(presetSites(sources()?.find((s) => s.id === id))))
  }

  onMount(() => {
    void props.browser
      .importSources?.()
      .then((list) => {
        setSources(list)
        const first = primarySource(list)
        if (first) pick(first.id)
      })
      .catch((e) => {
        setSources([])
        setError(String(e))
      })
  })

  const toggle = (site: string) => {
    const next = new Set(ticked())
    if (next.has(site)) next.delete(site)
    else next.add(site)
    setTicked(next)
  }

  const run = async () => {
    const s = source()
    const sites = [...ticked()]
    if (!s || !sites.length || !props.browser.importSignIns) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await props.browser.importSignIns(s.id, sites)
      saveChoice({ source: s.id, sites, persistent: r.persistent, at: Date.now() })
      props.onDone(r)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="session-web__import" role="dialog" aria-label="Use my Chrome sign-ins" data-slot="browser-import">
      <div class="session-web__import-head">
        <div class="session-web__note-title">Use my Chrome sign-ins</div>
        <button type="button" class="session-web__agent-link" onClick={props.onClose} disabled={busy()}>
          Close
        </button>
      </div>
      <div class="session-web__import-why">
        Pick the sites you want signed in here. IRIS copies those sign-ins from Chrome into this Browser. IRIS still
        can't read or click a site until you allow it.
      </div>
      <Show
        when={sources()}
        fallback={<div class="session-web__reason">Looking for Chrome on this Mac…</div>}
      >
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={
              <div class="session-web__reason">
                {error() ?? "No Chrome, Brave, Edge or Arc sign-ins found on this computer."}
              </div>
            }
          >
            <Show when={list().length > 1}>
              <select
                class="session-web__import-select"
                value={sourceId()}
                onChange={(e) => pick(e.currentTarget.value)}
                aria-label="Profile"
              >
                <For each={list()}>
                  {(s) => (
                    <option value={s.id}>
                      {s.browser} · {s.profile} ({s.sites.length} sites)
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <input
              class="session-web__address"
              placeholder="Find a site"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              spellcheck={false}
            />
            <div class="session-web__import-tools">
              <button
                type="button"
                class="session-web__agent-link"
                onClick={() => setTicked(new Set([...ticked(), ...shown().map((s) => s.site)]))}
              >
                Select all
              </button>
              <button type="button" class="session-web__agent-link" onClick={() => setTicked(new Set<string>())}>
                Clear
              </button>
              <span class="session-web__reason">{ticked().size} picked</span>
            </div>
            <div class="session-web__import-list">
              <For each={shown()}>
                {(s) => (
                  <label class="session-web__import-row">
                    <input type="checkbox" checked={ticked().has(s.site)} onChange={() => toggle(s.site)} />
                    <span>{s.site}</span>
                  </label>
                )}
              </For>
            </div>
            <Show when={busy()}>
              <div class="session-web__reason">
                macOS will ask to let IRIS use "Chrome Safe Storage", which unlocks your Chrome sign-ins. Choose
                Always Allow so it doesn't ask again.
              </div>
            </Show>
            <Show when={error()}>{(e) => <div class="session-web__reason" data-error="true">{e()}</div>}</Show>
            <button
              type="button"
              class="session-web__agent-btn session-web__import-go"
              data-primary="true"
              disabled={busy() || ticked().size === 0}
              onClick={run}
            >
              {busy() ? "Bringing them in…" : `Sign in to ${ticked().size} site${ticked().size === 1 ? "" : "s"}`}
            </button>
          </Show>
        )}
      </Show>
    </div>
  )
}
