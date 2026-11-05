import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IrisPinnedPage } from "./iris-pinned-page"
import {
  addPin,
  EMPTY_PINS,
  movePin,
  openPin,
  parsePins,
  PIN_MAX,
  pinsKey,
  removePin,
  renamePin,
  selectPin,
  serializePins,
  type MarketingPin,
  type MarketingPins,
} from "./iris-marketing-pins"
import "./iris-marketing.css"

/**
 * MARKETING (#192624, epic #192614): the account's own review pages, as sub-tabs.
 *
 * Each sub-tab is a Genesis page the signed-in account pinned — never a page named in code (1.18.169
 * showed FREELABEL's ads pages to every customer). "+" at the end of the row opens a search of the
 * account's own pages (the Genesis tab's list, /iris/pages ?scope=all); a pick is checked by the
 * engine (POST /iris/page-pin, own pages only) and becomes a tab, labelled with the page's title. The
 * open tab's menu renames, moves and unpins it. The page itself is the pinned-page frame (#192480),
 * signed in where the page needs it (#192482).
 *
 * Storage: see iris-marketing-pins.ts — per account, in this machine's localStorage.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Account = { at: "checking" } | { at: "out"; reason?: string } | { at: "in"; id: number }
type PageRow = { id: number; title: string; slug?: string; status: string; visibility?: string; requiresAuth?: boolean }
type PinCheck = { measured: boolean; allowed: boolean; reason?: string; page?: { slug: string; title: string; signIn: boolean } }

/** The outcome of pinning a page by slug: the pin as stored, or why not. */
export type PinResult = { ok: true; pin: MarketingPin } | { ok: false; reason: string }

/**
 * PIN A PAGE BY SLUG, programmatically — the picker's own path, exported so another flow can pin a
 * page it just made (#192627: "Create your campaign board" pins /p/<board-slug>-campaigns). The
 * engine decides (POST /iris/page-pin: the account's own pages only); nothing is stored unless it
 * allows the page. Pure I/O: the caller stores the pin (IrisMarketing's `pin` does both).
 */
export async function checkPin(doFetch: Fetch, slug: string, label?: string, opts?: PinOptions): Promise<PinResult> {
  const c = await doFetch(`/iris/page-pin`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  })
    .then((r) => r.json() as Promise<PinCheck>)
    .catch(() => ({ measured: false, allowed: false, reason: "IRIS isn't answering" }) as PinCheck)
  if (!c.allowed || !c.page) return { ok: false, reason: c.reason ?? "this page can't be pinned" }
  const signIn = c.page.signIn || opts?.signIn === true
  return { ok: true, pin: { slug: c.page.slug, label: label ?? c.page.title, ...(signIn ? { signIn: true } : {}) } }
}

/** `signIn: true` opens the page signed in (#192482) even if the page list calls it public — a members-only page made just now. */
export type PinOptions = { signIn?: boolean }

/** What the empty state hands a slotted action (#192627), so it can pin what it creates. */
export type MarketingEmptyActions = {
  /** Check with the engine, then pin and open the page. Resolves with the outcome. */
  pin: (slug: string, label?: string, opts?: PinOptions) => Promise<PinResult>
  accountId: number
}

const read = (key: string | null): MarketingPins => {
  if (!key) return EMPTY_PINS
  try {
    return parsePins(localStorage.getItem(key))
  } catch {
    return EMPTY_PINS
  }
}

export function IrisMarketing(props: {
  doFetch: Fetch
  openExternal: (url: string) => void
  /**
   * More ways in, drawn in the empty state beside the picker's heading (#192627 drops "Create your
   * campaign board" here). Given `pin` so it can pin the page it creates.
   */
  emptyActions?: (ctx: MarketingEmptyActions) => JSX.Element
  /** The same, drawn small at the top of the "+" picker, so an account with pins can use it too (#192627). */
  pickerActions?: (ctx: MarketingEmptyActions) => JSX.Element
}) {
  const [account, setAccount] = createSignal<Account>({ at: "checking" })
  // Asked on every mount: switching accounts and coming back to Marketing shows the new account's pins.
  void props
    .doFetch("/iris/me")
    .then((r) => r.json())
    .then((j: { id?: number | null; reason?: string }) =>
      setAccount(pinsKey(j?.id) ? { at: "in", id: j.id as number } : { at: "out", reason: j?.reason }),
    )
    .catch(() => setAccount({ at: "out", reason: "IRIS isn't answering" }))

  const key = createMemo(() => {
    const a = account()
    return a.at === "in" ? pinsKey(a.id) : null
  })
  const [state, setState] = createSignal<MarketingPins>(EMPTY_PINS)
  createEffect(on(key, (k) => setState(read(k))))
  const save = (next: MarketingPins) => {
    setState(next)
    const k = key()
    if (!k) return
    try {
      localStorage.setItem(k, serializePins(next))
    } catch {}
  }

  const [picking, setPicking] = createSignal(false)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const open = createMemo(() => openPin(state()))
  const pinned = createMemo(() => new Set(state().pins.map((p) => p.slug)))
  const full = () => state().pins.length >= PIN_MAX

  const pick = (pin: MarketingPin) => {
    save(addPin(state(), pin))
    setPicking(false)
  }
  const pinBySlug = async (slug: string, label?: string, opts?: PinOptions): Promise<PinResult> => {
    if (!key()) return { ok: false, reason: "nobody is signed in" }
    const r = await checkPin(props.doFetch, slug, label, opts)
    if (r.ok) pick(r.pin)
    return r
  }

  return (
    <div class="iris-mkt" data-component="iris-marketing" data-account={account().at} data-pins={state().pins.length}>
      <Switch>
        <Match when={account().at === "checking"}>
          <div class="iris-pinned__note" data-slot="marketing-checking">
            <div class="iris-pinned__reason">Checking which account is signed in…</div>
          </div>
        </Match>
        <Match when={account().at === "out" && (account() as Extract<Account, { at: "out" }>)}>
          {(a) => (
            <div class="iris-pinned__note" data-slot="marketing-signed-out">
              <div class="iris-pinned__title">Sign in to pin your review pages</div>
              <div class="iris-pinned__reason">
                Marketing shows Genesis pages your IRIS account pins.{a().reason ? ` (${a().reason})` : ""}
              </div>
            </div>
          )}
        </Match>
        <Match when={state().pins.length === 0}>
          <div class="iris-mkt__empty" data-slot="marketing-empty">
            <div class="iris-mkt__empty-head">
              <div class="iris-pinned__title">Pin your review pages here</div>
              <div class="iris-mkt__hint">
                Pick one of your Genesis pages and it becomes a tab here. Only pages you own, or pages on a board you are a
                member of, can be pinned.
              </div>
              {/* The slot for other ways in (#192627). Empty unless a caller passes emptyActions. */}
              <div class="iris-mkt__empty-actions" data-slot="marketing-empty-actions">
                {props.emptyActions?.({ pin: pinBySlug, accountId: (account() as { id: number }).id })}
              </div>
            </div>
            <PagePicker doFetch={props.doFetch} pinned={pinned()} onPick={pick} />
          </div>
        </Match>
        <Match when={true}>
          <div class="iris-subrow shrink-0">
            <div class="iris-subnav" role="tablist" aria-label="Marketing views">
              <For each={state().pins}>
                {(p, i) => {
                  const active = () => !picking() && open()?.slug === p.slug
                  return (
                    <div class="iris-mkt__tab" classList={{ "iris-mkt__tab--active": active() }} data-slug={p.slug}>
                      <Show
                        when={renaming() === p.slug}
                        fallback={
                          <button
                            type="button"
                            role="tab"
                            aria-selected={active()}
                            class="iris-subnav__item"
                            classList={{ "iris-subnav__item--active": active() }}
                            title={`freelabel.net/p/${p.slug}`}
                            onClick={() => {
                              setPicking(false)
                              save(selectPin(state(), p.slug))
                            }}
                            onDblClick={() => setRenaming(p.slug)}
                          >
                            {p.label}
                          </button>
                        }
                      >
                        <RenameInput
                          value={p.label}
                          onDone={(label) => {
                            if (label !== undefined) save(renamePin(state(), p.slug, label))
                            setRenaming(null)
                          }}
                        />
                      </Show>
                      <Show when={active() && renaming() !== p.slug}>
                        <DropdownMenu gutter={4} placement="bottom-start">
                          <DropdownMenu.Trigger
                            class="iris-mkt__menu-btn"
                            aria-label={`Options for ${p.label}`}
                            title="Rename, move or unpin"
                          >
                            <Icon name="chevron-down" size="small" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content data-slot="marketing-tab-menu">
                              <DropdownMenu.Item onSelect={() => setRenaming(p.slug)}>
                                <DropdownMenu.ItemLabel>Rename</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Item disabled={i() === 0} onSelect={() => save(movePin(state(), p.slug, -1))}>
                                <DropdownMenu.ItemLabel>Move left</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                disabled={i() === state().pins.length - 1}
                                onSelect={() => save(movePin(state(), p.slug, 1))}
                              >
                                <DropdownMenu.ItemLabel>Move right</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item onSelect={() => save(removePin(state(), p.slug))}>
                                <DropdownMenu.ItemLabel>Unpin</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>
                      </Show>
                    </div>
                  )
                }}
              </For>
              <button
                type="button"
                class="iris-subnav__item iris-mkt__add"
                classList={{ "iris-subnav__item--active": picking() }}
                aria-label="Pin a page"
                aria-expanded={picking()}
                title={full() ? `${PIN_MAX} pages are pinned — unpin one first` : "Pin one of your Genesis pages"}
                disabled={full() && !picking()}
                onClick={() => setPicking((v) => !v)}
              >
                <Icon name="plus-small" size="small" />
              </button>
            </div>
          </div>
          <div class="iris-mkt__body">
            <Show
              when={!picking() && open()}
              keyed
              fallback={
                <div class="iris-mkt__picker-wrap">
                  <Show when={props.pickerActions}>
                    {(slot) => slot()({ pin: pinBySlug, accountId: (account() as { id: number }).id })}
                  </Show>
                  <PagePicker doFetch={props.doFetch} pinned={pinned()} onPick={pick} onClose={() => setPicking(false)} />
                </div>
              }
            >
              {(pin) => (
                <IrisPinnedPage
                  slug={pin.slug}
                  label={pin.label}
                  signIn={pin.signIn === true}
                  doFetch={props.doFetch}
                  openExternal={props.openExternal}
                />
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

function RenameInput(props: { value: string; onDone: (label: string | undefined) => void }) {
  let done = false
  const finish = (v: string | undefined) => {
    if (done) return
    done = true
    props.onDone(v)
  }
  return (
    <input
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      class="iris-mkt__rename"
      aria-label="Tab name"
      value={props.value}
      maxLength={40}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value)
        if (e.key === "Escape") finish(undefined)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

/**
 * A search over the account's own Genesis pages — the Genesis tab's list (/iris/pages ?scope=all,
 * searched by iris-api). A pick is asked of the engine first; only an allowed page is pinned.
 */
function PagePicker(props: { doFetch: Fetch; pinned: Set<string>; onPick: (pin: MarketingPin) => void; onClose?: () => void }) {
  const [query, setQuery] = createSignal("")
  const [applied, setApplied] = createSignal("")
  const [list, setList] = createSignal<{ at: "loading" } | { at: "error"; reason: string } | { at: "ready"; pages: PageRow[] }>({
    at: "loading",
  })
  const [busy, setBusy] = createSignal<string | null>(null)
  const [refused, setRefused] = createSignal<{ slug: string; reason: string } | null>(null)
  let debounce: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(debounce))
  createEffect(() => {
    const q = query()
    clearTimeout(debounce)
    debounce = setTimeout(() => setApplied(q.trim()), 250)
  })
  createEffect(
    on(applied, (q) => {
      setList({ at: "loading" })
      props
        .doFetch(`/iris/pages/0?scope=all&perPage=50${q ? `&q=${encodeURIComponent(q)}` : ""}`, { headers: { Accept: "application/json" } })
        .then((r) => r.json())
        .then((j: { measured?: boolean; reason?: string; pages?: PageRow[] }) => {
          if (q !== applied()) return
          if (j?.measured === false) return setList({ at: "error", reason: j.reason ?? "your pages could not be read" })
          setList({ at: "ready", pages: (j?.pages ?? []).filter((p) => !!p.slug) })
        })
        .catch(() => q === applied() && setList({ at: "error", reason: "IRIS isn't answering" }))
    }),
  )

  const choose = (p: PageRow) => {
    const slug = p.slug!
    if (props.pinned.has(slug)) return props.onPick({ slug, label: p.title })
    setBusy(slug)
    setRefused(null)
    void checkPin(props.doFetch, slug).then((r) => {
      setBusy(null)
      if (r.ok) return props.onPick(r.pin)
      setRefused({ slug, reason: r.reason })
    })
  }

  return (
    <div class="iris-mkt__picker" data-slot="marketing-picker">
      <div class="iris-mkt__picker-bar">
        <Icon name="magnifying-glass" size="small" class="iris-mkt__picker-ic" />
        <input
          ref={(el) => queueMicrotask(() => el.focus())}
          class="iris-mkt__picker-input"
          type="text"
          placeholder="Search your Genesis pages"
          aria-label="Search your Genesis pages"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onClose?.()}
        />
        <Show when={props.onClose}>
          {(close) => (
            <button type="button" class="iris-mkt__picker-close" onClick={() => close()()} aria-label="Close" title="Close">
              <Icon name="close-small" size="small" />
            </button>
          )}
        </Show>
      </div>
      <div class="iris-mkt__picker-list" role="listbox" aria-label="Your Genesis pages">
        <Switch>
          <Match when={list().at === "loading"}>
            <div class="iris-mkt__picker-note">Loading your pages…</div>
          </Match>
          <Match when={list().at === "error" && (list() as { reason: string })}>
            {(e) => <div class="iris-mkt__picker-note">Couldn't read your pages: {e().reason}</div>}
          </Match>
          <Match when={list().at === "ready" && (list() as { pages: PageRow[] }).pages}>
            {(pages) => (
              <Show when={pages().length} fallback={<div class="iris-mkt__picker-note">{applied() ? `No pages match "${applied()}"` : "You have no Genesis pages yet"}</div>}>
                <For each={pages()}>
                  {(p) => (
                    <button
                      type="button"
                      role="option"
                      class="iris-mkt__page"
                      data-slug={p.slug}
                      aria-selected={props.pinned.has(p.slug!)}
                      disabled={busy() !== null}
                      onClick={() => choose(p)}
                    >
                      <span class="iris-mkt__page-title">{p.title}</span>
                      <span class="iris-mkt__page-slug">/p/{p.slug}</span>
                      <span class="iris-mkt__page-tags">
                        <Show when={p.status !== "published"}>
                          <span class="iris-mkt__tag">{p.status}</span>
                        </Show>
                        <Show when={p.visibility && p.visibility !== "public"}>
                          <span class="iris-mkt__tag">{p.visibility}</span>
                        </Show>
                        <Show when={p.requiresAuth}>
                          <span class="iris-mkt__tag">sign-in</span>
                        </Show>
                        <Show when={props.pinned.has(p.slug!)}>
                          <span class="iris-mkt__tag iris-mkt__tag--on">pinned</span>
                        </Show>
                        <Show when={busy() === p.slug}>
                          <span class="iris-mkt__tag">checking…</span>
                        </Show>
                      </span>
                      <Show when={refused()?.slug === p.slug}>
                        <span class="iris-mkt__page-refused" role="alert">
                          {refused()!.reason}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
