import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { usePrompt } from "@/context/prompt"
import "./iris-panel-ui.css"
import "./iris-brand-kits.css"
import {
  bezierOf,
  buildSave,
  contrastChecks,
  diffKit,
  draftFromKit,
  draftProblems,
  exportCss,
  exportJson,
  exportName,
  groundsOf,
  inkFor,
  LOGO_VARIANTS,
  logoVisibility,
  MOTION_PRESETS,
  parseColor,
  draftLogoFor,
  previewRoles,
  ratioText,
  saveConfirm,
  scaleSizes,
  TILES,
  toHex6,
  type BrandKit,
  type DiffLine,
  type Draft,
  type LogoSeen,
  type LogoVariant,
} from "./iris-brand-kit-model"

/**
 * Genesis › Brand kits (#188816) — and, since #192667, the place a brand kit is EDITED.
 *
 * A brand kit is the design tokens fl-api keeps for a brand — colours, type, logo, motion, voice.
 * Every Genesis page, campaign page and render that names the brand reads it, so an edit here
 * changes all of them. That decides the shape of this pane:
 *
 *   One draft   the whole kit is editable in place; nothing is sent while you type. The toolbar
 *               counts what changed, and any field can be put back.
 *   Checked     each colour is checked against the kit's own background and surface (WCAG ratio and
 *               a pass/fail label), each logo is drawn on a light and a dark tile and flagged where
 *               it disappears, and a value the platform would refuse is named before Save is offered.
 *   Seen        a sample card and a sample page section are drawn in the draft, live.
 *   Confirmed   Save shows the diff — before → after, field by field — and says in plain words that
 *               every page using the kit changes. Then ONE pinned write (the `iris brands dt push`
 *               call): refused whole if anyone changed the kit since you opened it.
 *
 * Chrome stays on the panel's tokens. The kit's colours appear only inside swatches, the contrast
 * tiles, the logo tiles and the previews.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type BrandSummary = { id: number; name: string; slug: string; status: string; swatches: { name: string; value: string }[]; logoUrl?: string }
type Tab = "colours" | "type" | "logos" | "voice" | "motion" | "preview" | "export"
type Probe = { state: "loading" } | { state: "err"; reason: string } | { state: "ok"; src: string; light: LogoSeen; dark: LogoSeen }

const TABS: { id: Tab; label: string; part?: DiffLine["part"] }[] = [
  { id: "colours", label: "Colours", part: "colours" },
  { id: "type", label: "Type", part: "type" },
  { id: "logos", label: "Logos", part: "logos" },
  { id: "voice", label: "Voice", part: "voice" },
  { id: "motion", label: "Motion", part: "motion" },
  { id: "preview", label: "Preview" },
  { id: "export", label: "Export" },
]

/** Optional context: the pane can render where there is no composer (it then hides Use). */
function tryUse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** What Use puts in the composer. Plain words first, the tokens after, nothing hidden. */
export function usePromptFor(kit: BrandKit): string {
  return [
    `Use the ${kit.brand.name} brand kit (brand "${kit.brand.slug}") for the next Genesis artifact.`,
    "Take colour and type ONLY from these tokens — reference them as CSS custom properties, not hard-coded values:",
    "",
    "```css",
    exportCss(kit, draftFromKit(kit)),
    "```",
  ].join("\n")
}

/** A logo's pixels, at most 128px on its long side — enough to judge, cheap to scan. */
function pixelsOf(src: string): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w0 = img.naturalWidth || 128
      const h0 = img.naturalHeight || 128
      const k = Math.min(1, 128 / Math.max(w0, h0))
      const w = Math.max(1, Math.round(w0 * k))
      const h = Math.max(1, Math.round(h0 * k))
      const cv = document.createElement("canvas")
      cv.width = w
      cv.height = h
      const ctx = cv.getContext("2d", { willReadFrequently: true })
      if (!ctx) return reject(new Error("no canvas"))
      ctx.drawImage(img, 0, 0, w, h)
      resolve(ctx.getImageData(0, 0, w, h).data)
    }
    img.onerror = () => reject(new Error("the image would not draw"))
    img.src = src
  })
}

const readBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error("could not read the file"))
    r.readAsDataURL(f)
  })

export function IrisBrandKits(props: { doFetch: Fetch }) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => (await (await props.doFetch(path, init)).json()) as T
  const prompt = tryUse(() => usePrompt())

  // ── the list ──
  const [list, { refetch: reloadList }] = createResource(() => json<{ measured: boolean; reason?: string; brands: BrandSummary[] }>("/iris/brands"))
  const [q, setQ] = createSignal("")
  const brands = createMemo(() => {
    const all = list()?.brands ?? []
    const n = q().trim().toLowerCase()
    return n ? all.filter((b) => b.name.toLowerCase().includes(n) || b.slug.toLowerCase().includes(n)) : all
  })

  // ── one kit ──
  const [openId, setOpenId] = createSignal<number>()
  const [kitRes, { mutate: setKitRes, refetch: reloadKit }] = createResource(openId, (id) =>
    json<{ measured: boolean; reason?: string; kit?: BrandKit }>(`/iris/brands/${id}`),
  )
  const kit = () => kitRes()?.kit
  const [draft, setDraft] = createStore<Draft>(draftFromKit({ brand: { id: 0, name: "", slug: "", status: "" }, colors: [], fonts: [], typeScale: [], personas: [], sections: {} }))
  createEffect(on(kit, (k) => k && setDraft(reconcile(draftFromKit(k)))))
  const [tab, setTab] = createSignal<Tab>("colours")
  const diff = createMemo(() => (kit() ? diffKit(kit()!, draft) : []))
  const problems = createMemo(() => draftProblems(draft))
  const changedIn = (part: DiffLine["part"]) => diff().filter((l) => l.part === part).length
  const grounds = createMemo(() => groundsOf(draft.colors))
  const roles = createMemo(() => previewRoles(draft))
  const was = createMemo(() => (kit() ? draftFromKit(kit()!) : undefined))

  const [note, setNote] = createSignal<{ tone: "good" | "bad" | "info"; text: string; reload?: boolean }>()
  const [confirm, setConfirm] = createSignal<"save" | "leave">()
  const [saving, setSaving] = createSignal(false)
  const [showProblems, setShowProblems] = createSignal(false)

  function open(id: number) {
    setNote(undefined)
    setTab("colours")
    setOpenId(id)
  }
  function leave(force = false) {
    if (!force && diff().length) return setConfirm("leave")
    setConfirm(undefined)
    setOpenId(undefined)
    setKitRes(undefined)
    setNote(undefined)
  }
  function discard() {
    const k = kit()
    if (k) setDraft(reconcile(draftFromKit(k)))
    setShowProblems(false)
    setNote(undefined)
  }
  function askSave() {
    setNote(undefined)
    if (problems().length) return setShowProblems(true)
    setShowProblems(false)
    setConfirm("save")
  }

  async function save() {
    const k = kit()
    if (!k) return
    setSaving(true)
    try {
      const body = buildSave(k, draft)
      const r = await json<{ ok: boolean; reason?: string; kit?: BrandKit; saved?: string[] }>(`/iris/brands/${k.brand.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      setConfirm(undefined)
      if (!r.ok) return setNote({ tone: "bad", text: r.reason ?? "The save was refused.", reload: /changed since/.test(r.reason ?? "") })
      const n = diff().length
      if (r.kit) setKitRes({ measured: true, kit: r.kit })
      else await reloadKit()
      setNote({ tone: "good", text: r.reason ?? `Saved ${n} ${n === 1 ? "change" : "changes"} to ${k.brand.name} — showing what the platform holds now.` })
      void reloadList()
    } catch (e) {
      setConfirm(undefined)
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  function use() {
    const k = kit()
    if (!k || !prompt) return
    const text = usePromptFor(k)
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus())
    setNote({ tone: "info", text: "In the composer — read it, then press enter." })
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNote({ tone: "good", text: `${what} copied.` })
    } catch {
      setNote({ tone: "bad", text: "The clipboard is not available here — use Download." })
    }
  }
  function download(text: string, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement("a")
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setNote({ tone: "good", text: `Downloaded ${name}.` })
  }

  // ── logos: measure each one on a light and a dark tile ──
  const [probes, setProbes] = createStore<Record<string, Probe>>({})
  async function measure(url: string) {
    if (!/^https?:\/\//i.test(url) || probes[url]) return
    setProbes(url, { state: "loading" })
    try {
      const r = await json<{ ok: boolean; reason?: string; dataUrl?: string }>(`/iris/brand-logo/probe?url=${encodeURIComponent(url)}`)
      if (!r.ok || !r.dataUrl) return setProbes(url, { state: "err", reason: r.reason ?? "could not be read" })
      const px = await pixelsOf(r.dataUrl)
      setProbes(url, { state: "ok", src: r.dataUrl, light: logoVisibility(px, TILES.light.rgba), dark: logoVisibility(px, TILES.dark.rgba) })
    } catch (e) {
      setProbes(url, { state: "err", reason: e instanceof Error ? e.message : String(e) })
    }
  }
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const urls = LOGO_VARIANTS.map((v) => draft.logos[v.id].trim()).filter(Boolean)
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => urls.forEach((u) => void measure(u)), 350)
  })
  onCleanup(() => clearTimeout(probeTimer))

  const [uploading, setUploading] = createSignal<LogoVariant>()
  async function upload(variant: LogoVariant, file: File) {
    const k = kit()
    if (!k) return
    setUploading(variant)
    setNote(undefined)
    try {
      const data = await readBase64(file)
      const r = await json<{ ok: boolean; reason?: string; url?: string }>(`/iris/brands/${k.brand.id}/logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, type: file.type, data, variant }),
      })
      if (!r.ok || !r.url) return setNote({ tone: "bad", text: `Upload failed — ${r.reason ?? "no URL came back"}.` })
      setDraft("logos", variant, r.url)
      setNote({ tone: "info", text: `Uploaded ${file.name}. It is in your draft — Save puts it in the kit.` })
    } catch (e) {
      setNote({ tone: "bad", text: `Upload failed — ${e instanceof Error ? e.message : String(e)}.` })
    } finally {
      setUploading(undefined)
    }
  }

  const failing = createMemo(() => draft.colors.filter((c) => contrastChecks(c, grounds()).some((x) => !x.grade.pass)).length)
  const [colourFilter, setColourFilter] = createSignal<"all" | "failing" | "changed">("all")
  const shownColours = createMemo(() =>
    draft.colors
      .map((c, i) => ({ c, i }))
      .filter(({ c }) =>
        colourFilter() === "failing"
          ? contrastChecks(c, grounds()).some((x) => !x.grade.pass)
          : colourFilter() === "changed"
            ? diff().some((l) => l.part === "colours" && l.label === c.name)
            : true,
      ),
  )

  return (
    <div class="iris-ui iris-bk" data-slot="brand-kits">
      <Show
        when={openId() != null}
        fallback={
          <>
            <div class="iris-ui-bar">
              <label class="iris-ui-search">
                <Icon name="magnifying-glass" size="small" />
                <input placeholder="Search brands" value={q()} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search brands" />
              </label>
              <span class="iris-ui-spacer" />
              <button type="button" class="iris-ui-icon" title="Reload" aria-label="Reload brands" onClick={() => void reloadList()}>
                <Show when={!list.loading} fallback={<Spinner class="iris-ui-spin" />}>
                  <Icon name="reset" size="small" />
                </Show>
              </button>
            </div>
            <div class="iris-bk-scroll">
              <Switch>
                <Match when={list.loading && !list()}>
                  <div class="iris-ui-empty"><Spinner class="iris-ui-spin" />Loading brand kits…</div>
                </Match>
                <Match when={list() && !list()!.measured}>
                  <div class="iris-ui-empty" role="alert">
                    Couldn't load brand kits — {list()!.reason}.
                    <button type="button" class="iris-ui-btn" onClick={() => void reloadList()}>Try again</button>
                  </div>
                </Match>
                <Match when={list()?.measured && (list()?.brands.length ?? 0) === 0}>
                  <div class="iris-ui-empty">
                    No brands on this account yet.
                    <span>Create one with <code>iris brands create</code>, then import its tokens with <code>iris brands dt import &lt;slug&gt; --css ./tokens.css</code>.</span>
                  </div>
                </Match>
                <Match when={brands().length === 0}>
                  <div class="iris-ui-empty">No brand matches “{q()}”.</div>
                </Match>
              </Switch>
              <ul class="iris-bk-list">
                <For each={brands()}>
                  {(b) => (
                    <li>
                      <button type="button" class="iris-bk-row" data-slot="bk-row" data-slug={b.slug} onClick={() => open(b.id)}>
                        <span class="iris-bk-mark">
                          <Show when={b.logoUrl} fallback={<span>{b.name.slice(0, 1).toUpperCase()}</span>}>
                            <img src={b.logoUrl} alt="" loading="lazy" />
                          </Show>
                        </span>
                        <span class="iris-bk-rowtext">
                          <span class="iris-bk-name">{b.name}</span>
                          <span class="iris-bk-slug">{b.slug}{b.status !== "active" ? ` · ${b.status}` : ""}</span>
                        </span>
                        <span class="iris-bk-chips" aria-hidden="true">
                          <For each={b.swatches}>{(s) => <span style={{ background: s.value }} />}</For>
                        </span>
                        <Icon name="chevron-right" size="small" />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </>
        }
      >
        {/* ── the kit's toolbar ── */}
        <div class="iris-ui-bar">
          <button type="button" class="iris-ui-icon" title="All brands" aria-label="All brands" onClick={() => leave()}>
            <Icon name="arrow-left" size="small" />
          </button>
          <Show when={kit()}>
            {(k) => (
              <span class="iris-bk-ident">
                <span class="iris-bk-mark">
                  <Show when={k().logos?.icon ?? k().logoUrl} fallback={<span>{k().brand.name.slice(0, 1).toUpperCase()}</span>}>
                    <img src={k().logos?.icon ?? k().logoUrl} alt="" />
                  </Show>
                </span>
                <span class="iris-bk-rowtext">
                  <span class="iris-bk-name">{k().brand.name}</span>
                  <span class="iris-bk-slug">{k().brand.slug}</span>
                </span>
              </span>
            )}
          </Show>
          <span class="iris-ui-spacer" />
          <Show when={kit()}>
            <Show when={diff().length}>
              <span class="iris-ui-chip" data-tone="warn" data-slot="bk-dirty">{diff().length} unsaved</span>
              <button type="button" class="iris-ui-btn" onClick={discard} disabled={saving()}>Discard</button>
            </Show>
            <Show when={prompt && !diff().length}>
              <button type="button" class="iris-ui-btn" onClick={use} title="Put this kit in the composer for the next Genesis artifact">Use</button>
            </Show>
            <button type="button" class="iris-ui-btn" data-primary data-slot="bk-save" disabled={!diff().length || saving()} onClick={askSave}>
              <Icon name="save" size="small" />
              Save…
            </button>
          </Show>
        </div>
        <Show when={kit()}>
          <div class="iris-ui-tabs" role="tablist" aria-label="Brand kit parts">
            <For each={TABS}>
              {(t) => (
                <button type="button" class="iris-ui-tab" role="tab" aria-selected={tab() === t.id} data-tab={t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                  <Show when={t.part && changedIn(t.part)}>
                    <span class="iris-bk-dot" title={`${changedIn(t.part!)} unsaved`} />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <div class="iris-bk-scroll">
          <Show when={note()}>
            {(n) => (
              <div class="iris-ui-callout iris-bk-note" data-tone={n().tone} role="status" data-slot="bk-note">
                <span class="iris-ui-ic"><Icon name={n().tone === "bad" ? "warning" : n().tone === "good" ? "circle-check" : "help"} size="small" /></span>
                <span>
                  {n().text}
                  <Show when={n().reload}>
                    {" "}
                    <button type="button" class="iris-ui-btn" onClick={() => { setNote(undefined); void reloadKit() }}>Reload kit</button>
                  </Show>
                </span>
              </div>
            )}
          </Show>
          <Show when={showProblems() && problems().length}>
            <div class="iris-ui-callout iris-bk-note" data-tone="bad" role="alert" data-slot="bk-problems">
              <span class="iris-ui-ic"><Icon name="warning" size="small" /></span>
              <span>
                Fix {problems().length === 1 ? "this" : "these"} before saving:
                <ul class="iris-bk-problems"><For each={problems()}>{(p) => <li>{p}</li>}</For></ul>
              </span>
            </div>
          </Show>
          <Show when={kitRes.loading && !kit()}>
            <div class="iris-ui-empty"><Spinner class="iris-ui-spin" />Loading the kit…</div>
          </Show>
          <Show when={kitRes() && !kitRes()!.measured}>
            <div class="iris-ui-empty" role="alert">
              Couldn't load this kit — {kitRes()!.reason}.
              <button type="button" class="iris-ui-btn" onClick={() => void reloadKit()}>Try again</button>
            </div>
          </Show>

          <Show when={kit()}>
            {(k) => (
              <div class="iris-bk-body">
                <div class="iris-bk-main">
                  <Switch>
                    {/* ── Colours ── */}
                    <Match when={tab() === "colours"}>
                      <p class="iris-bk-lede">
                        Each colour is checked against
                        <For each={grounds()}>
                          {(g, i) => (
                            <>
                              {i() ? " and " : " "}
                              <span class="iris-bk-inline"><span class="iris-bk-pip" style={{ background: g.value }} />{g.name} <code>{g.value}</code></span>
                            </>
                          )}
                        </For>
                        . Body text needs 4.5:1; large text and marks 3:1.
                      </p>
                      <div class="iris-ui-tabs iris-bk-filter" role="toolbar" aria-label="Filter colours">
                        <button type="button" class="iris-ui-tab" aria-pressed={colourFilter() === "all"} onClick={() => setColourFilter("all")}>All <span class="n">{draft.colors.length}</span></button>
                        <button type="button" class="iris-ui-tab" aria-pressed={colourFilter() === "failing"} onClick={() => setColourFilter("failing")}>Not body-text safe <span class="n">{failing()}</span></button>
                        <button type="button" class="iris-ui-tab" aria-pressed={colourFilter() === "changed"} onClick={() => setColourFilter("changed")}>Changed <span class="n">{changedIn("colours")}</span></button>
                      </div>
                      <Show when={draft.colors.length === 0}>
                        <div class="iris-ui-empty">No colours in this kit. Import some with <code>iris brands dt import {k().brand.slug} --css ./tokens.css</code>.</div>
                      </Show>
                      <ul class="iris-bk-colours">
                        <For each={shownColours()}>
                          {({ c, i }) => {
                            const before = () => was()?.colors.find((x) => x.name === c.name)?.value
                            const changed = () => (before() ?? "").trim() !== c.value.trim()
                            const ok = () => !!parseColor(c.value)
                            return (
                              <li class="iris-bk-colour" data-changed={changed() || undefined} data-slot="bk-colour" data-name={c.name}>
                                <label class="iris-bk-swatch" title="Pick a colour" style={{ background: ok() ? c.value : undefined }} data-none={!ok() || undefined}>
                                  <input type="color" aria-label={`${c.name} picker`} value={toHex6(c.value)} onInput={(e) => setDraft("colors", i, "value", e.currentTarget.value)} />
                                </label>
                                <div class="iris-bk-cmain">
                                  <div class="iris-bk-cname">
                                    <span class="iris-bk-name">{c.name}</span>
                                    <Show when={changed()}>
                                      <span class="iris-bk-was" title="Saved value">was <code>{before()}</code></span>
                                      <button type="button" class="iris-ui-icon iris-bk-reset" title="Put back" aria-label={`Put ${c.name} back`} onClick={() => setDraft("colors", i, "value", before() ?? c.value)}>
                                        <Icon name="arrow-undo-down" size="small" />
                                      </button>
                                    </Show>
                                  </div>
                                  <input class="iris-bk-input iris-bk-mono" aria-label={`${c.name} value`} aria-invalid={!ok() || undefined} value={c.value} onInput={(e) => setDraft("colors", i, "value", e.currentTarget.value)} spellcheck={false} />
                                  <div class="iris-bk-checks">
                                    <For each={contrastChecks(c, grounds())}>
                                      {(x) => (
                                        <span class="iris-bk-check" title={`${c.name} on ${x.ground.name}: ${x.grade.detail}`} data-slot="bk-contrast" data-pass={x.grade.pass ? "yes" : "no"}>
                                          <span class="iris-bk-tile" style={{ background: x.ground.value, color: c.value }}>Aa</span>
                                          <span class="iris-bk-ratio">on {x.ground.name} {ratioText(x.grade.ratio)}</span>
                                          <span class="iris-ui-chip" data-tone={x.grade.tone}>{x.grade.label}</span>
                                        </span>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                    </Match>

                    {/* ── Type ── */}
                    <Match when={tab() === "type"}>
                      <h4 class="iris-bk-h">Families <span class="n">{draft.fonts.length}</span></h4>
                      <Show when={draft.fonts.length === 0}>
                        <div class="iris-ui-empty">No font stacks in this kit.</div>
                      </Show>
                      <ul class="iris-bk-fonts">
                        <For each={draft.fonts}>
                          {(f, i) => {
                            const before = () => was()?.fonts.find((x) => x.role === f.role)?.family
                            return (
                              <li data-changed={(before() ?? "").trim() !== f.family.trim() || undefined}>
                                <div class="iris-bk-cname">
                                  <span class="iris-bk-name">{f.role}</span>
                                  <Show when={(before() ?? "").trim() !== f.family.trim()}>
                                    <button type="button" class="iris-ui-icon iris-bk-reset" title="Put back" aria-label={`Put ${f.role} back`} onClick={() => setDraft("fonts", i(), "family", before() ?? "")}>
                                      <Icon name="arrow-undo-down" size="small" />
                                    </button>
                                  </Show>
                                </div>
                                <input class="iris-bk-input iris-bk-mono" aria-label={`${f.role} font stack`} value={f.family} onInput={(e) => setDraft("fonts", i(), "family", e.currentTarget.value)} spellcheck={false} />
                                <span class="iris-bk-specimen" style={{ "font-family": f.family }}>
                                  {k().brand.name} — The quick brown fox <span class="iris-bk-alt">Aa Gg Rr 0123</span>
                                </span>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                      <h4 class="iris-bk-h">Scale <span class="n">{draft.typeScale.length}</span></h4>
                      <Show when={scaleSizes(draft.typeScale).length}>
                        <div class="iris-bk-scaleview" data-slot="bk-scale">
                          <For each={scaleSizes(draft.typeScale)}>
                            {(t) => (
                              <div class="iris-bk-scalerow">
                                <span class="iris-bk-scalemeta">{t.role.replace(/^font-size-/, "")} · {t.value}</span>
                                <span class="iris-bk-scalesample" style={{ "font-size": `${Math.min(t.px, 56)}px`, "font-family": roles().display }}>Brand kits</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={draft.typeScale.length === 0}>
                        <div class="iris-ui-empty">No type scale in this kit — pages use their own sizes.</div>
                      </Show>
                      <div class="iris-bk-grid2">
                        <For each={draft.typeScale}>
                          {(t, i) => (
                            <label class="iris-bk-field">
                              <span>{t.role}</span>
                              <input class="iris-bk-input iris-bk-mono" value={t.value} onInput={(e) => setDraft("typeScale", i(), "value", e.currentTarget.value)} spellcheck={false} />
                            </label>
                          )}
                        </For>
                      </div>
                    </Match>

                    {/* ── Logos ── */}
                    <Match when={tab() === "logos"}>
                      <p class="iris-bk-lede">
                        Each mark is drawn on a light and a dark tile. One that disappears is flagged — a page picks <b>on light</b> on light grounds and <b>on dark</b> on dark ones, and falls back to <b>primary</b>.
                      </p>
                      <LogoWarnings draft={draft} probes={probes} />
                      <ul class="iris-bk-logos">
                        <For each={LOGO_VARIANTS}>
                          {(v) => {
                            const url = () => draft.logos[v.id].trim()
                            const before = () => was()?.logos[v.id] ?? ""
                            const p = () => (url() ? probes[url()] : undefined)
                            let file!: HTMLInputElement
                            return (
                              <li class="iris-bk-logo" data-slot="bk-logo" data-variant={v.id} data-changed={before().trim() !== url() || undefined}>
                                <div class="iris-bk-cname">
                                  <span class="iris-bk-name">{v.label}</span>
                                  <span class="iris-bk-hint">{v.hint}</span>
                                  <Show when={before().trim() !== url()}>
                                    <button type="button" class="iris-ui-icon iris-bk-reset" title="Put back" aria-label={`Put ${v.label} back`} onClick={() => setDraft("logos", v.id, before())}>
                                      <Icon name="arrow-undo-down" size="small" />
                                    </button>
                                  </Show>
                                </div>
                                <div class="iris-bk-tiles">
                                  <For each={[TILES.light, TILES.dark]}>
                                    {(tile) => {
                                      const seen = () => {
                                        const x = p()
                                        return x?.state === "ok" ? x[tile.id] : undefined
                                      }
                                      const expected = () => (v.tile ? v.tile === tile.id : true)
                                      return (
                                        <figure class="iris-bk-ltile" data-tile={tile.id} data-verdict={seen()?.verdict} data-slot="bk-ltile">
                                          <div class="iris-bk-lground" style={{ background: tile.value }}>
                                            <Switch fallback={<span class="iris-bk-lnone" style={{ color: inkFor(tile.value) }}>No logo</span>}>
                                              <Match when={p()?.state === "loading"}><Spinner class="iris-ui-spin" style={{ color: inkFor(tile.value) }} /></Match>
                                              <Match when={p()?.state === "ok"}><img src={(p() as { src: string }).src} alt={`${v.label} logo on ${tile.label.toLowerCase()}`} /></Match>
                                              <Match when={p()?.state === "err"}><span class="iris-bk-lnone" style={{ color: inkFor(tile.value) }}>Can't draw it</span></Match>
                                            </Switch>
                                          </div>
                                          <figcaption>
                                            <span>{tile.label}</span>
                                            <Show when={seen()}>
                                              {(s) => (
                                                <span class="iris-ui-chip" data-tone={s().verdict === "visible" ? "good" : expected() ? "bad" : "idle"} title={`${Math.round(s().visible * 100)}% of the mark stands out from this tile`}>
                                                  {s().label}
                                                </span>
                                              )}
                                            </Show>
                                          </figcaption>
                                        </figure>
                                      )
                                    }}
                                  </For>
                                </div>
                                <Show when={p()?.state === "err"}>
                                  <p class="iris-bk-err">This URL is not a usable image — {(p() as { reason: string }).reason}.</p>
                                </Show>
                                <div class="iris-bk-lrow">
                                  <input class="iris-bk-input iris-bk-mono" aria-label={`${v.label} logo URL`} placeholder="https://… (png, svg, webp)" value={draft.logos[v.id]} onInput={(e) => setDraft("logos", v.id, e.currentTarget.value)} spellcheck={false} />
                                  <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void upload(v.id, f) }} />
                                  <button type="button" class="iris-ui-btn" disabled={!!uploading()} onClick={() => file.click()} title="Upload an image to your cloud files and use its URL">
                                    <Show when={uploading() === v.id} fallback={<Icon name="cloud-upload" size="small" />}><Spinner class="iris-ui-spin" /></Show>
                                    Upload
                                  </button>
                                  <Show when={url()}>
                                    <button type="button" class="iris-ui-icon" title="Remove this variant" aria-label={`Remove the ${v.label} logo`} onClick={() => setDraft("logos", v.id, "")}>
                                      <Icon name="close-small" size="small" />
                                    </button>
                                  </Show>
                                </div>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                    </Match>

                    {/* ── Voice ── */}
                    <Match when={tab() === "voice"}>
                      <p class="iris-bk-lede">How {k().brand.name} sounds. Agents writing for the brand read these two lines.</p>
                      <label class="iris-bk-field iris-bk-field--block" data-changed={(was()?.voice ?? "").trim() !== draft.voice.trim() || undefined}>
                        <span>Voice</span>
                        <textarea class="iris-bk-input" rows={4} value={draft.voice} placeholder="Confident, technical but approachable…" onInput={(e) => setDraft("voice", e.currentTarget.value)} />
                      </label>
                      <label class="iris-bk-field iris-bk-field--block" data-changed={(was()?.tone ?? "").trim() !== draft.tone.trim() || undefined}>
                        <span>Tone</span>
                        <textarea class="iris-bk-input" rows={3} value={draft.tone} placeholder="Professional yet bold…" onInput={(e) => setDraft("tone", e.currentTarget.value)} />
                      </label>
                      <h4 class="iris-bk-h">Personas <span class="n">{k().personas.length}</span></h4>
                      <Show when={k().personas.length} fallback={<p class="iris-bk-hint">No personas. Add one with <code>iris brands personas add {k().brand.id}</code>.</p>}>
                        <ul class="iris-bk-personas">
                          <For each={k().personas}>
                            {(p) => (
                              <li>
                                <span class="iris-bk-name">{p.name}</span>
                                <Show when={p.isDefault}><span class="iris-ui-chip">default</span></Show>
                                <Show when={p.tone}><span class="iris-bk-hint">{p.tone}</span></Show>
                              </li>
                            )}
                          </For>
                        </ul>
                        <p class="iris-bk-hint">Personas are edited with <code>iris brands personas</code>.</p>
                      </Show>
                    </Match>

                    {/* ── Motion ── */}
                    <Match when={tab() === "motion"}>
                      <p class="iris-bk-lede">How {k().brand.name} moves — the ease and duration its pages and films share.</p>
                      <div class="iris-ui-seg iris-bk-presets" role="group" aria-label="Start from">
                        <For each={Object.entries(MOTION_PRESETS)}>
                          {([name, m]) => (
                            <button
                              type="button"
                              aria-pressed={draft.character === name}
                              onClick={() => {
                                setDraft({ character: name, ease: m.ease, durationMs: String(m.durationMs), stiffness: String(m.stiffness), damping: String(m.damping) })
                              }}
                            >
                              {name}
                            </button>
                          )}
                        </For>
                      </div>
                      <div class="iris-bk-grid2">
                        <label class="iris-bk-field">
                          <span>Ease</span>
                          <input class="iris-bk-input iris-bk-mono" value={draft.ease} placeholder="cubic-bezier(.45,0,.15,1)" onInput={(e) => setDraft({ ease: e.currentTarget.value, character: "" })} spellcheck={false} />
                        </label>
                        <label class="iris-bk-field">
                          <span>Duration (ms)</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.durationMs} placeholder="320" onInput={(e) => setDraft({ durationMs: e.currentTarget.value, character: "" })} />
                        </label>
                        <label class="iris-bk-field">
                          <span>Spring stiffness</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.stiffness} placeholder="170" onInput={(e) => setDraft({ stiffness: e.currentTarget.value, character: "" })} />
                        </label>
                        <label class="iris-bk-field">
                          <span>Spring damping</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.damping} placeholder="26" onInput={(e) => setDraft({ damping: e.currentTarget.value, character: "" })} />
                        </label>
                      </div>
                      <MotionPreview ease={draft.ease} durationMs={draft.durationMs} color={roles().primary} ground={roles().bg} />
                    </Match>

                    {/* ── Preview ── */}
                    <Match when={tab() === "preview"}>
                      <p class="iris-bk-lede">The draft, drawn. A sample card and a sample page section in {k().brand.name}'s colours, type and logo — they change as you edit.</p>
                      <KitCard kit={k()} draft={draft} />
                      <KitSection kit={k()} draft={draft} />
                    </Match>

                    {/* ── Export ── */}
                    <Match when={tab() === "export"}>
                      <p class="iris-bk-lede">The draft{diff().length ? " (with your unsaved edits)" : ""} as CSS custom properties, and as the design tokens <code>iris brands dt push</code> takes.</p>
                      <For each={[{ ext: "css" as const, label: "CSS", text: exportCss(k(), draft), type: "text/css" }, { ext: "json" as const, label: "JSON", text: exportJson(k(), draft), type: "application/json" }]}>
                        {(x) => (
                          <section class="iris-bk-export" data-slot="bk-export" data-ext={x.ext}>
                            <div class="iris-bk-exhead">
                              <span class="iris-bk-name">{x.label}</span>
                              <code class="iris-bk-slug">{exportName(k(), x.ext)}</code>
                              <span class="iris-ui-spacer" />
                              <button type="button" class="iris-ui-btn" onClick={() => void copy(x.text, x.label)}><Icon name="copy" size="small" />Copy</button>
                              <button type="button" class="iris-ui-btn" onClick={() => download(x.text, exportName(k(), x.ext), x.type)}><Icon name="download" size="small" />Export {x.label}</button>
                            </div>
                            <pre class="iris-bk-pre">{x.text}</pre>
                          </section>
                        )}
                      </For>
                    </Match>
                  </Switch>
                </div>
                {/* The live preview beside the editor, when the panel is wide enough to hold both. */}
                <Show when={tab() !== "preview" && tab() !== "export"}>
                  <aside class="iris-bk-side" aria-label="Live preview">
                    <span class="iris-bk-h">Live preview</span>
                    <KitCard kit={k()} draft={draft} compact />
                  </aside>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>

      {/* ── the confirms ── */}
      <Show when={confirm() === "save" && kit()}>
        {(_) => {
          const c = () => saveConfirm(kit()!, draft)
          return (
            <div class="iris-ui-scrim" onClick={(e) => e.target === e.currentTarget && !saving() && setConfirm(undefined)}>
              <div class="iris-ui-dialog iris-bk-dialog" role="alertdialog" aria-modal="true" aria-labelledby="iris-bk-confirm-title" data-slot="bk-confirm">
                <div class="iris-ui-dialog-icon" data-tone="warn"><Icon name="warning" /></div>
                <h3 id="iris-bk-confirm-title">{c().title}</h3>
                <For each={c().body}>{(line) => <p>{line}</p>}</For>
                <ul class="iris-bk-diff" data-slot="bk-diff">
                  <For each={diff()}>
                    {(l) => (
                      <li>
                        <span class="iris-bk-dlabel">{l.label}</span>
                        <span class="iris-bk-dvals">
                          <DiffValue value={l.before} swatch={l.swatch} gone />
                          <span class="iris-bk-arrow" aria-label="becomes">→</span>
                          <DiffValue value={l.after} swatch={l.swatch} />
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
                <For each={c().warn}>
                  {(w) => (
                    <div class="iris-ui-callout" data-tone="warn">
                      <span class="iris-ui-ic"><Icon name="warning" size="small" /></span>
                      <span>{w}</span>
                    </div>
                  )}
                </For>
                <div class="iris-ui-dialog-actions">
                  <button type="button" class="iris-ui-btn" disabled={saving()} onClick={() => setConfirm(undefined)} autofocus>Keep editing</button>
                  <button type="button" class="iris-ui-btn" data-primary data-slot="bk-confirm-save" disabled={saving()} onClick={() => void save()}>
                    <Show when={saving()}><Spinner class="iris-ui-spin" /></Show>
                    Save to {kit()!.brand.name}
                  </button>
                </div>
              </div>
            </div>
          )
        }}
      </Show>
      <Show when={confirm() === "leave"}>
        <div class="iris-ui-scrim" onClick={(e) => e.target === e.currentTarget && setConfirm(undefined)}>
          <div class="iris-ui-dialog" role="alertdialog" aria-modal="true" aria-labelledby="iris-bk-leave-title">
            <div class="iris-ui-dialog-icon" data-tone="warn"><Icon name="warning" /></div>
            <h3 id="iris-bk-leave-title">Leave without saving?</h3>
            <p>{diff().length} {diff().length === 1 ? "change" : "changes"} to {kit()?.brand.name} will be lost. Nothing has been sent.</p>
            <div class="iris-ui-dialog-actions">
              <button type="button" class="iris-ui-btn" onClick={() => setConfirm(undefined)} autofocus>Keep editing</button>
              <button type="button" class="iris-ui-btn" data-primary data-tone="warn" onClick={() => leave(true)}>Discard changes</button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

function DiffValue(props: { value?: string; swatch?: boolean; gone?: boolean }) {
  return (
    <Show when={props.value} fallback={<span class="iris-bk-dnone">{props.gone ? "not set" : "removed"}</span>}>
      <span class="iris-bk-dval" data-gone={props.gone || undefined}>
        <Show when={props.swatch && parseColor(props.value)}>
          <span class="iris-bk-pip" style={{ background: props.value }} />
        </Show>
        <code title={props.value}>{props.value}</code>
      </span>
    </Show>
  )
}

/** The combinations that would leave a page without a visible mark, said once at the top. */
function LogoWarnings(props: { draft: Draft; probes: Record<string, Probe> }) {
  const seen = (v: LogoVariant) => {
    const u = props.draft.logos[v].trim()
    const p = u ? props.probes[u] : undefined
    return p?.state === "ok" ? p : undefined
  }
  const lines = createMemo(() => {
    const out: string[] = []
    for (const tile of ["light", "dark"] as const) {
      const own = tile === "light" ? "on_light" : "on_dark"
      // What a page will actually draw (the #192664 resolver). A tiled pick brings its own ground.
      const r = draftLogoFor(props.draft, tile)
      if (!r || r.tile || (r.variant !== own && r.variant !== "primary")) continue
      const pick = r.variant
      const p = seen(pick)
      if (p && p[tile].verdict !== "visible")
        out.push(
          pick === own
            ? `The ${tile === "light" ? "on light" : "on dark"} logo is ${p[tile].verdict} on a ${tile} page.`
            : `On a ${tile} page the primary logo is ${p[tile].verdict} — add an ${tile === "light" ? "on light" : "on dark"} version.`,
        )
    }
    return out
  })
  return (
    <For each={lines()}>
      {(l) => (
        <div class="iris-ui-callout iris-bk-note" data-tone="warn" data-slot="bk-logo-warn">
          <span class="iris-ui-ic"><Icon name="warning" size="small" /></span>
          <span>{l}</span>
        </div>
      )}
    </For>
  )
}

function MotionPreview(props: { ease: string; durationMs: string; color: string; ground: string }) {
  const [at, setAt] = createSignal(false)
  const ms = () => (Number(props.durationMs) >= 0 && props.durationMs.trim() ? Number(props.durationMs) : 320)
  const ease = () => props.ease.trim() || "ease"
  const curve = () => bezierOf(ease())
  return (
    <div class="iris-bk-motion" data-slot="bk-motion">
      <Show when={curve()}>
        {(b) => (
          <svg class="iris-bk-curve" viewBox="-0.1 -0.6 1.2 2.2" preserveAspectRatio="none" aria-label={`Curve of ${ease()}`}>
            <path d="M0 1 L1 1 M0 1 L0 0" class="iris-bk-axis" />
            <path d={`M0 1 C ${b()[0]} ${1 - b()[1]}, ${b()[2]} ${1 - b()[3]}, 1 0`} class="iris-bk-bez" />
          </svg>
        )}
      </Show>
      <div class="iris-bk-track" style={{ background: props.ground }}>
        <span class="iris-bk-ball" data-at={at() ? "end" : "start"} style={{ background: props.color, transition: `left ${ms()}ms ${ease()}` }} />
      </div>
      <button type="button" class="iris-ui-btn" onClick={() => setAt(!at())}>
        <Icon name="play" size="small" />Play · {ms()} ms
      </button>
    </div>
  )
}

function kitVars(draft: Draft): JSX.CSSProperties {
  const r = previewRoles(draft)
  const ms = Number(draft.durationMs)
  return {
    "--k-bg": r.bg,
    "--k-surface": r.surface,
    "--k-text": r.text,
    "--k-muted": r.muted,
    "--k-primary": r.primary,
    "--k-on-primary": r.onPrimary,
    "--k-accent": r.accent,
    "--k-border": r.border,
    "--k-font": r.body,
    "--k-display": r.display,
    "--k-mono": r.mono,
    "--k-ease": draft.ease.trim() || "ease",
    "--k-dur": `${draft.durationMs.trim() && Number.isFinite(ms) ? ms : 200}ms`,
  } as JSX.CSSProperties
}

/** A sample card in the kit: surface, border, logo for that ground, display type, a primary button. */
function KitCard(props: { kit: BrandKit; draft: Draft; compact?: boolean }) {
  const r = () => previewRoles(props.draft)
  const logo = () => draftLogoFor(props.draft, r().surface)
  return (
    <div class="iris-bk-kitground" style={kitVars(props.draft)} data-compact={props.compact || undefined}>
      <article class="iris-bk-kcard" data-slot="bk-sample-card">
        <header>
          <KitLogo logo={logo()} name={props.kit.brand.name} />
          <span class="iris-bk-ktag">New</span>
        </header>
        <h5>Launch your first campaign</h5>
        <p>Agents, pages and outreach from one place — set up in an afternoon.</p>
        <footer>
          <span class="iris-bk-kbtn">Get started</span>
          <span class="iris-bk-klink">Learn more →</span>
        </footer>
      </article>
    </div>
  )
}

/** A sample page section in the kit: nav, a hero set in the scale's largest size, three tiles. */
function KitSection(props: { kit: BrandKit; draft: Draft }) {
  const r = () => previewRoles(props.draft)
  const logo = () => draftLogoFor(props.draft, r().bg)
  const big = () => {
    const s = scaleSizes(props.draft.typeScale)
    return s.length ? Math.min(Math.max(s.at(-1)!.px, 28), 44) : 36
  }
  const tagline = () => props.draft.tone.trim() || props.kit.brand.description || "What the system does, shown — not sold."
  return (
    <div class="iris-bk-kitground iris-bk-kpage" style={kitVars(props.draft)} data-slot="bk-sample-page">
      <nav>
        <KitLogo logo={logo()} name={props.kit.brand.name} />
        <span>Product</span>
        <span>Pricing</span>
        <span>Docs</span>
        <span class="iris-bk-kbtn iris-bk-kbtn--sm">Sign in</span>
      </nav>
      <section class="iris-bk-khero">
        <span class="iris-bk-ktag">{props.kit.brand.name}</span>
        <h2 style={{ "font-size": `${big()}px` }}>Run the whole business from one place.</h2>
        <p>{tagline()}</p>
        <div class="iris-bk-kactions">
          <span class="iris-bk-kbtn">Start free</span>
          <span class="iris-bk-kghost">See how it works</span>
        </div>
      </section>
      <div class="iris-bk-ktiles">
        <For each={["Agents", "Pages", "Outreach"]}>
          {(t, i) => (
            <div>
              <b>{t}</b>
              <span>{["Work while you sleep.", "Built from your kit.", "Sent in your voice."][i()]}</span>
              <code>0{i() + 1}</code>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

/** The resolver's pick, on the tile it asks for (when the mark does not suit the ground). */
function KitLogo(props: { logo: ReturnType<typeof draftLogoFor>; name: string }) {
  return (
    <Show when={props.logo} fallback={<span class="iris-bk-kmark">{props.name.slice(0, 1)}</span>}>
      {(l) => (
        <span class="iris-bk-klogo" data-variant={l().variant} data-tile={l().tile ?? undefined} title={l().reason} style={l().tile ? { background: l().tile! } : undefined}>
          <img src={l().url} alt="" />
        </span>
      )}
    </Show>
  )
}
