import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { IRIS_BRAND_KITS_ENGLISH } from "@/i18n/iris-brand-kits"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { CommandAction } from "@/components/command-action"
import { PaneDialog, PaneDialogActions, statusTone } from "./iris-pane-dialog"
import "./iris-pane-layout.css"
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
type BrandSummary = {
  id: number
  name: string
  slug: string
  status: string
  swatches: { name: string; value: string }[]
  logoUrl?: string
  /** Connected accounts and files under the brand (#194583). Absent when the platform did not say. */
  accounts?: number
  files?: number
}
type Tab = "colours" | "type" | "logos" | "voice" | "motion" | "preview" | "export"
type Probe = { state: "loading" } | { state: "err"; reason: string } | { state: "ok"; src: string; light: LogoSeen; dark: LogoSeen }

const TABS: { id: Tab; label: BrandsKey; part?: DiffLine["part"] }[] = [
  { id: "colours", label: "iris.brands.tab.colours", part: "colours" },
  { id: "type", label: "iris.brands.tab.type", part: "type" },
  { id: "logos", label: "iris.brands.tab.logos", part: "logos" },
  { id: "voice", label: "iris.brands.tab.voice", part: "voice" },
  { id: "motion", label: "iris.brands.tab.motion", part: "motion" },
  { id: "preview", label: "iris.brands.tab.preview" },
  { id: "export", label: "iris.brands.tab.export" },
]
type BrandsKey = keyof typeof IRIS_BRAND_KITS_ENGLISH
type ColourFilter = "all" | "failing" | "changed"

/**
 * Copy with inline marks, kept whole in one i18n string so a translator sees the sentence: `text`
 * is drawn as <code>, **text** as <b>. Only for strings whose params cannot carry either mark.
 */
function rich(text: string): JSX.Element {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code>{part.slice(1, -1)}</code>
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <b>{part.slice(2, -2)}</b>
    return part
  })
}

/** Optional context: the pane can render where there is no composer (it then hides Use). */
function tryUse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * The row's mark (#194583): the brand's logo where it has one, and its initial only when it has
 * none or the image does not load — a broken image is never left on the row.
 */
function BrandMark(props: { name: string; src?: string }) {
  const [broken, setBroken] = createSignal(false)
  createEffect(on(() => props.src, () => setBroken(false), { defer: true }))
  return (
    <span class="iris-bk-mark" data-logo={props.src && !broken() ? "1" : undefined}>
      <Show when={props.src && !broken()} fallback={<span>{props.name.slice(0, 1).toUpperCase()}</span>}>
        <img src={props.src} alt="" loading="lazy" onError={() => setBroken(true)} />
      </Show>
    </span>
  )
}

/** "2 accounts · 14 files" — only the counts the platform sent; nothing when it sent none. */
function usageLine(t: (key: BrandsKey, params?: Record<string, string | number>) => string, b: BrandSummary): string | undefined {
  const parts = [
    b.accounts ? t(b.accounts === 1 ? "iris.brands.usage.account" : "iris.brands.usage.accounts", { n: String(b.accounts) }) : undefined,
    b.files ? t(b.files === 1 ? "iris.brands.usage.file" : "iris.brands.usage.files", { n: String(b.files) }) : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

/**
 * New brand kit (#194583): `iris brands create`, run here. It needs a name and a slug, so the line
 * opens to fill them in, then asks before it creates anything.
 */
function NewBrandKit(props: { doFetch: (path: string, init?: RequestInit) => Promise<Response>; onDone: () => void; variant?: "primary" | "secondary" }) {
  const language = useLanguage()
  return (
    <CommandAction
      command={'iris brands create --name "My brand" --slug my-brand'}
      label={language.t("iris.brands.new" satisfies BrandsKey)}
      describe={language.t("iris.brands.new.describe" satisfies BrandsKey)}
      editable
      icon="plus"
      size="small"
      variant={props.variant ?? "secondary"}
      fetch={props.doFetch}
      base=""
      onDone={(r) => r.ran && r.code === 0 && props.onDone()}
    />
  )
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
  const language = useLanguage()
  const t = (key: BrandsKey, params?: Record<string, string | number>) => language.t(key, params)

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
      if (!r.ok) return setNote({ tone: "bad", text: r.reason ?? t("iris.brands.note.refused"), reload: /changed since/.test(r.reason ?? "") })
      const n = diff().length
      if (r.kit) setKitRes({ measured: true, kit: r.kit })
      else await reloadKit()
      setNote({ tone: "good", text: r.reason ?? language.plural("iris.brands.note.saved", n, { name: k.brand.name }) })
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
    setNote({ tone: "info", text: t("iris.brands.note.inComposer") })
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNote({ tone: "good", text: t("iris.brands.note.copied", { what }) })
    } catch {
      setNote({ tone: "bad", text: t("iris.brands.note.noClipboard") })
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
    setNote({ tone: "good", text: t("iris.brands.note.downloaded", { name }) })
  }

  // ── logos: measure each one on a light and a dark tile ──
  const [probes, setProbes] = createStore<Record<string, Probe>>({})
  async function measure(url: string) {
    if (!/^https?:\/\//i.test(url) || probes[url]) return
    setProbes(url, { state: "loading" })
    try {
      const r = await json<{ ok: boolean; reason?: string; dataUrl?: string }>(`/iris/brand-logo/probe?url=${encodeURIComponent(url)}`)
      if (!r.ok || !r.dataUrl) return setProbes(url, { state: "err", reason: r.reason ?? t("iris.brands.logo.unreadable") })
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
      if (!r.ok || !r.url) return setNote({ tone: "bad", text: t("iris.brands.note.uploadFailed", { reason: r.reason ?? t("iris.brands.note.noUrl") }) })
      setDraft("logos", variant, r.url)
      setNote({ tone: "info", text: t("iris.brands.note.uploaded", { name: file.name }) })
    } catch (e) {
      setNote({ tone: "bad", text: t("iris.brands.note.uploadFailed", { reason: e instanceof Error ? e.message : String(e) }) })
    } finally {
      setUploading(undefined)
    }
  }

  const failing = createMemo(() => draft.colors.filter((c) => contrastChecks(c, grounds()).some((x) => !x.grade.pass)).length)
  const [colourFilter, setColourFilter] = createSignal<ColourFilter>("all")
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

  // The motion presets as a segmented control. A draft whose ease/duration was typed by hand has no
  // preset: CUSTOM (value "") keeps the control controlled with nothing selected — passing undefined
  // would let Kobalte fall back to uncontrolled and keep showing the last preset picked.
  const presets = Object.keys(MOTION_PRESETS) as (keyof typeof MOTION_PRESETS)[]
  const CUSTOM: { id: string } = { id: "" }
  const presetOptions: { id: string }[] = presets.map((id) => ({ id }))
  const presetNow = () => presetOptions.find((o) => o.id === draft.character) ?? CUSTOM

  // What each confirm shows, read once when it opens — the dialog holds it while it closes.
  const saveAsk = () => {
    const k = kit()
    return confirm() === "save" && k ? { kit: k, ask: saveConfirm(k, draft), lines: diff() } : undefined
  }
  const leaveAsk = () => (confirm() === "leave" ? { count: diff().length, name: kit()?.brand.name ?? "" } : undefined)

  return (
    <div class="iris-ui iris-bk" data-slot="brand-kits">
      <Show
        when={openId() != null}
        fallback={
          <>
            <div class="iris-ui-bar">
              <label class="iris-ui-search">
                <Icon name="magnifying-glass" size="small" />
                <input placeholder={t("iris.brands.search")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t("iris.brands.search")} />
              </label>
              <span class="iris-ui-spacer" />
              <NewBrandKit doFetch={props.doFetch} onDone={() => void reloadList()} />
              <Button variant="ghost" size="small" class="iris-bk-iconbtn" title={t("iris.brands.reload.title")} aria-label={t("iris.brands.reload")} onClick={() => void reloadList()}>
                <Show when={!list.loading} fallback={<Spinner class="iris-ui-spin" />}>
                  <Icon name="reset" size="small" />
                </Show>
              </Button>
            </div>
            <div class="iris-bk-scroll">
              <Switch>
                <Match when={list.loading && !list()}>
                  <SkeletonRows rows={5} label={t("iris.brands.loading")} />
                </Match>
                <Match when={list() && !list()!.measured}>
                  <EmptyState
                    size="small"
                    role="alert"
                    title={t("iris.brands.error.list", { reason: list()!.reason ?? "" })}
                    action={<Button size="small" onClick={() => void reloadList()}>{t("iris.brands.retry")}</Button>}
                  />
                </Match>
                <Match when={list()?.measured && (list()?.brands.length ?? 0) === 0}>
                  <EmptyState
                    size="small"
                    title={t("iris.brands.empty")}
                    description={t("iris.brands.empty.body")}
                    action={<NewBrandKit doFetch={props.doFetch} onDone={() => void reloadList()} variant="primary" />}
                  />
                </Match>
                <Match when={brands().length === 0}>
                  <EmptyState size="small" title={t("iris.brands.noMatch", { q: q() })} />
                </Match>
              </Switch>
              <ul class="iris-bk-list">
                <For each={brands()}>
                  {(b) => (
                    <li>
                      <button type="button" class="iris-bk-row" data-slot="bk-row" data-slug={b.slug} onClick={() => open(b.id)}>
                        <BrandMark name={b.name} src={b.logoUrl} />
                        <span class="iris-bk-rowtext">
                          <span class="iris-bk-name">{b.name}</span>
                          <span class="iris-bk-slug">{b.slug}{b.status !== "active" ? ` · ${b.status}` : ""}</span>
                        </span>
                        <Show when={usageLine(t, b)}>
                          {(u) => <span class="iris-bk-usage">{u()}</span>}
                        </Show>
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
          <IconButton icon="arrow-left" variant="ghost" size="small" title={t("iris.brands.back")} aria-label={t("iris.brands.back")} onClick={() => leave()} />
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
              <StatusBadge size="small" tone="warning" data-slot="bk-dirty">{t("iris.brands.unsaved", { count: diff().length })}</StatusBadge>
              <Button size="small" onClick={discard} disabled={saving()}>{t("iris.brands.discard")}</Button>
            </Show>
            <Show when={prompt && !diff().length}>
              <Button size="small" onClick={use} title={t("iris.brands.use.title")}>{t("iris.brands.use")}</Button>
            </Show>
            <Button size="small" variant="primary" icon="save" data-slot="bk-save" disabled={!diff().length || saving()} onClick={askSave}>
              {t("iris.brands.save")}
            </Button>
          </Show>
        </div>
        <Show when={kit()}>
          <div class="iris-bk-tabs">
            <Tabs variant="pill" size="small" value={tab()} onChange={(v: string) => setTab(v as Tab)}>
              <Tabs.List aria-label={t("iris.brands.parts")}>
                <For each={TABS}>
                  {(x) => (
                    <Tabs.Trigger value={x.id} data-tab={x.id}>
                      {t(x.label)}
                      <Show when={x.part && changedIn(x.part)}>
                        <span class="iris-bk-dot" title={t("iris.brands.unsaved", { count: changedIn(x.part!) })} />
                      </Show>
                    </Tabs.Trigger>
                  )}
                </For>
              </Tabs.List>
            </Tabs>
          </div>
        </Show>

        <div class="iris-bk-scroll">
          <Show when={note()}>
            {(n) => (
              <Notice
                class="iris-bk-note"
                tone={statusTone(n().tone)}
                role="status"
                data-slot="bk-note"
                icon={<Icon name={n().tone === "bad" ? "warning" : n().tone === "good" ? "circle-check" : "help"} size="small" />}
                action={
                  n().reload ? (
                    <Button size="small" onClick={() => { setNote(undefined); void reloadKit() }}>{t("iris.brands.reloadKit")}</Button>
                  ) : undefined
                }
              >
                {n().text}
              </Notice>
            )}
          </Show>
          <Show when={showProblems() && problems().length}>
            <Notice class="iris-bk-note" tone="critical" role="alert" data-slot="bk-problems" icon={<Icon name="warning" size="small" />}>
              {language.plural("iris.brands.problems", problems().length)}
              <ul class="iris-bk-problems"><For each={problems()}>{(p) => <li>{p}</li>}</For></ul>
            </Notice>
          </Show>
          <Show when={kitRes.loading && !kit()}>
            <SkeletonRows rows={4} label={t("iris.brands.loadingKit")} />
          </Show>
          <Show when={kitRes() && !kitRes()!.measured}>
            <EmptyState
              size="small"
              role="alert"
              title={t("iris.brands.error.kit", { reason: kitRes()!.reason ?? "" })}
              action={<Button size="small" onClick={() => void reloadKit()}>{t("iris.brands.retry")}</Button>}
            />
          </Show>

          <Show when={kit()}>
            {(k) => (
              <div class="iris-bk-body">
                <div class="iris-bk-main">
                  <Switch>
                    {/* ── Colours ── */}
                    <Match when={tab() === "colours"}>
                      <p class="iris-bk-lede">
                        {t("iris.brands.colours.lede")}
                        <For each={grounds()}>
                          {(g, i) => (
                            <>
                              {i() ? t("iris.brands.colours.and") : " "}
                              <span class="iris-bk-inline"><span class="iris-bk-pip" style={{ background: g.value }} />{g.name} <code>{g.value}</code></span>
                            </>
                          )}
                        </For>
                        {t("iris.brands.colours.ledeEnd")}
                      </p>
                      <div class="iris-bk-filter">
                        <Tabs variant="pill" size="small" value={colourFilter()} onChange={(v: string) => setColourFilter(v as ColourFilter)}>
                          <Tabs.List aria-label={t("iris.brands.colours.filter")}>
                            <Tabs.Trigger value="all">{t("iris.brands.colours.all")} <span class="n">{draft.colors.length}</span></Tabs.Trigger>
                            <Tabs.Trigger value="failing">{t("iris.brands.colours.failing")} <span class="n">{failing()}</span></Tabs.Trigger>
                            <Tabs.Trigger value="changed">{t("iris.brands.colours.changed")} <span class="n">{changedIn("colours")}</span></Tabs.Trigger>
                          </Tabs.List>
                        </Tabs>
                      </div>
                      <Show when={draft.colors.length === 0}>
                        <EmptyState size="small" title={t("iris.brands.colours.none")} description={rich(t("iris.brands.colours.none.how", { slug: k().brand.slug }))} />
                      </Show>
                      <ul class="iris-bk-colours">
                        <For each={shownColours()}>
                          {({ c, i }) => {
                            const before = () => was()?.colors.find((x) => x.name === c.name)?.value
                            const changed = () => (before() ?? "").trim() !== c.value.trim()
                            const ok = () => !!parseColor(c.value)
                            return (
                              <li class="iris-bk-colour" data-changed={changed() || undefined} data-slot="bk-colour" data-name={c.name}>
                                <label class="iris-bk-swatch" title={t("iris.brands.colours.pick")} style={{ background: ok() ? c.value : undefined }} data-none={!ok() || undefined}>
                                  <input type="color" aria-label={t("iris.brands.colours.picker", { name: c.name })} value={toHex6(c.value)} onInput={(e) => setDraft("colors", i, "value", e.currentTarget.value)} />
                                </label>
                                <div class="iris-bk-cmain">
                                  <div class="iris-bk-cname">
                                    <span class="iris-bk-name">{c.name}</span>
                                    <Show when={changed()}>
                                      <span class="iris-bk-was" title={t("iris.brands.was.title")}>{t("iris.brands.was")} <code>{before()}</code></span>
                                      <IconButton icon="arrow-undo-down" variant="ghost" size="small" class="iris-bk-reset" title={t("iris.brands.putBack")} aria-label={t("iris.brands.putBack.label", { name: c.name })} onClick={() => setDraft("colors", i, "value", before() ?? c.value)} />
                                    </Show>
                                  </div>
                                  <input class="iris-bk-input iris-bk-mono" aria-label={t("iris.brands.colours.value", { name: c.name })} aria-invalid={!ok() || undefined} value={c.value} onInput={(e) => setDraft("colors", i, "value", e.currentTarget.value)} spellcheck={false} />
                                  <div class="iris-bk-checks">
                                    <For each={contrastChecks(c, grounds())}>
                                      {(x) => (
                                        <span class="iris-bk-check" title={t("iris.brands.contrast.title", { name: c.name, ground: x.ground.name, detail: x.grade.detail })} data-slot="bk-contrast" data-pass={x.grade.pass ? "yes" : "no"}>
                                          <span class="iris-bk-tile" style={{ background: x.ground.value, color: c.value }}>Aa</span>
                                          <span class="iris-bk-ratio">{t("iris.brands.contrast.on", { ground: x.ground.name, ratio: ratioText(x.grade.ratio) })}</span>
                                          <StatusBadge size="small" tone={statusTone(x.grade.tone)}>{x.grade.label}</StatusBadge>
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
                      <h4 class="iris-bk-h">{t("iris.brands.type.families")} <span class="n">{draft.fonts.length}</span></h4>
                      <Show when={draft.fonts.length === 0}>
                        <EmptyState size="small" title={t("iris.brands.type.noFonts")} />
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
                                    <IconButton icon="arrow-undo-down" variant="ghost" size="small" class="iris-bk-reset" title={t("iris.brands.putBack")} aria-label={t("iris.brands.putBack.label", { name: f.role })} onClick={() => setDraft("fonts", i(), "family", before() ?? "")} />
                                  </Show>
                                </div>
                                <input class="iris-bk-input iris-bk-mono" aria-label={t("iris.brands.type.stack", { role: f.role })} value={f.family} onInput={(e) => setDraft("fonts", i(), "family", e.currentTarget.value)} spellcheck={false} />
                                <span class="iris-bk-specimen" style={{ "font-family": f.family }}>
                                  {t("iris.brands.type.specimen", { name: k().brand.name })} <span class="iris-bk-alt">Aa Gg Rr 0123</span>
                                </span>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                      <h4 class="iris-bk-h">{t("iris.brands.type.scale")} <span class="n">{draft.typeScale.length}</span></h4>
                      <Show when={scaleSizes(draft.typeScale).length}>
                        <div class="iris-bk-scaleview" data-slot="bk-scale">
                          <For each={scaleSizes(draft.typeScale)}>
                            {(s) => (
                              <div class="iris-bk-scalerow">
                                <span class="iris-bk-scalemeta">{s.role.replace(/^font-size-/, "")} · {s.value}</span>
                                <span class="iris-bk-scalesample" style={{ "font-size": `${Math.min(s.px, 56)}px`, "font-family": roles().display }}>{t("iris.brands.type.sample")}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={draft.typeScale.length === 0}>
                        <EmptyState size="small" title={t("iris.brands.type.noScale")} />
                      </Show>
                      <div class="iris-bk-grid2">
                        <For each={draft.typeScale}>
                          {(s, i) => (
                            <label class="iris-bk-field">
                              <span>{s.role}</span>
                              <input class="iris-bk-input iris-bk-mono" value={s.value} onInput={(e) => setDraft("typeScale", i(), "value", e.currentTarget.value)} spellcheck={false} />
                            </label>
                          )}
                        </For>
                      </div>
                    </Match>

                    {/* ── Logos ── */}
                    <Match when={tab() === "logos"}>
                      <p class="iris-bk-lede">{rich(t("iris.brands.logos.lede"))}</p>
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
                                    <IconButton icon="arrow-undo-down" variant="ghost" size="small" class="iris-bk-reset" title={t("iris.brands.putBack")} aria-label={t("iris.brands.putBack.label", { name: v.label })} onClick={() => setDraft("logos", v.id, before())} />
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
                                            <Switch fallback={<span class="iris-bk-lnone" style={{ color: inkFor(tile.value) }}>{t("iris.brands.logo.none")}</span>}>
                                              <Match when={p()?.state === "loading"}><Spinner class="iris-ui-spin" style={{ color: inkFor(tile.value) }} /></Match>
                                              <Match when={p()?.state === "ok"}><img src={(p() as { src: string }).src} alt={t("iris.brands.logo.alt", { variant: v.label, tile: tile.label.toLowerCase() })} /></Match>
                                              <Match when={p()?.state === "err"}><span class="iris-bk-lnone" style={{ color: inkFor(tile.value) }}>{t("iris.brands.logo.cantDraw")}</span></Match>
                                            </Switch>
                                          </div>
                                          <figcaption>
                                            <span>{tile.label}</span>
                                            <Show when={seen()}>
                                              {(s) => (
                                                <StatusBadge size="small" tone={statusTone(s().verdict === "visible" ? "good" : expected() ? "bad" : "idle")} title={t("iris.brands.logo.standsOut", { percent: Math.round(s().visible * 100) })}>
                                                  {s().label}
                                                </StatusBadge>
                                              )}
                                            </Show>
                                          </figcaption>
                                        </figure>
                                      )
                                    }}
                                  </For>
                                </div>
                                <Show when={p()?.state === "err"}>
                                  <p class="iris-bk-err">{t("iris.brands.logo.notImage", { reason: (p() as { reason: string }).reason })}</p>
                                </Show>
                                <div class="iris-bk-lrow">
                                  <input class="iris-bk-input iris-bk-mono" aria-label={t("iris.brands.logo.url", { variant: v.label })} placeholder={t("iris.brands.logo.url.placeholder")} value={draft.logos[v.id]} onInput={(e) => setDraft("logos", v.id, e.currentTarget.value)} spellcheck={false} />
                                  <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void upload(v.id, f) }} />
                                  <Button size="small" disabled={!!uploading()} onClick={() => file.click()} title={t("iris.brands.logo.upload.title")}>
                                    <Show when={uploading() === v.id} fallback={<Icon name="cloud-upload" size="small" />}><Spinner class="iris-ui-spin" /></Show>
                                    {t("iris.brands.logo.upload")}
                                  </Button>
                                  <Show when={url()}>
                                    <IconButton icon="close-small" variant="ghost" size="small" title={t("iris.brands.logo.remove.title")} aria-label={t("iris.brands.logo.remove", { variant: v.label })} onClick={() => setDraft("logos", v.id, "")} />
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
                      <p class="iris-bk-lede">{t("iris.brands.voice.lede", { name: k().brand.name })}</p>
                      <label class="iris-bk-field iris-bk-field--block" data-changed={(was()?.voice ?? "").trim() !== draft.voice.trim() || undefined}>
                        <span>{t("iris.brands.voice.voice")}</span>
                        <textarea class="iris-bk-input" rows={4} value={draft.voice} placeholder={t("iris.brands.voice.voice.placeholder")} onInput={(e) => setDraft("voice", e.currentTarget.value)} />
                      </label>
                      <label class="iris-bk-field iris-bk-field--block" data-changed={(was()?.tone ?? "").trim() !== draft.tone.trim() || undefined}>
                        <span>{t("iris.brands.voice.tone")}</span>
                        <textarea class="iris-bk-input" rows={3} value={draft.tone} placeholder={t("iris.brands.voice.tone.placeholder")} onInput={(e) => setDraft("tone", e.currentTarget.value)} />
                      </label>
                      <h4 class="iris-bk-h">{t("iris.brands.voice.personas")} <span class="n">{k().personas.length}</span></h4>
                      <Show when={k().personas.length} fallback={<p class="iris-bk-hint">{rich(t("iris.brands.voice.noPersonas", { id: k().brand.id }))}</p>}>
                        <ul class="iris-bk-personas">
                          <For each={k().personas}>
                            {(p) => (
                              <li>
                                <span class="iris-bk-name">{p.name}</span>
                                <Show when={p.isDefault}><StatusBadge size="small">{t("iris.brands.voice.default")}</StatusBadge></Show>
                                <Show when={p.tone}><span class="iris-bk-hint">{p.tone}</span></Show>
                              </li>
                            )}
                          </For>
                        </ul>
                        <p class="iris-bk-hint">{rich(t("iris.brands.voice.personasEdited"))}</p>
                      </Show>
                    </Match>

                    {/* ── Motion ── */}
                    <Match when={tab() === "motion"}>
                      <p class="iris-bk-lede">{t("iris.brands.motion.lede", { name: k().brand.name })}</p>
                      <RadioGroup
                        size="small"
                        class="iris-bk-presets"
                        aria-label={t("iris.brands.motion.startFrom")}
                        options={presetOptions}
                        current={presetNow()}
                        value={(o) => o.id}
                        label={(o) => o.id}
                        onSelect={(o) => {
                          const name = o?.id as keyof typeof MOTION_PRESETS | undefined
                          if (!name || !MOTION_PRESETS[name]) return
                          const m = MOTION_PRESETS[name]
                          setDraft({ character: name, ease: m.ease, durationMs: String(m.durationMs), stiffness: String(m.stiffness), damping: String(m.damping) })
                        }}
                      />
                      <div class="iris-bk-grid2">
                        <label class="iris-bk-field">
                          <span>{t("iris.brands.motion.ease")}</span>
                          <input class="iris-bk-input iris-bk-mono" value={draft.ease} placeholder="cubic-bezier(.45,0,.15,1)" onInput={(e) => setDraft({ ease: e.currentTarget.value, character: "" })} spellcheck={false} />
                        </label>
                        <label class="iris-bk-field">
                          <span>{t("iris.brands.motion.duration")}</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.durationMs} placeholder="320" onInput={(e) => setDraft({ durationMs: e.currentTarget.value, character: "" })} />
                        </label>
                        <label class="iris-bk-field">
                          <span>{t("iris.brands.motion.stiffness")}</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.stiffness} placeholder="170" onInput={(e) => setDraft({ stiffness: e.currentTarget.value, character: "" })} />
                        </label>
                        <label class="iris-bk-field">
                          <span>{t("iris.brands.motion.damping")}</span>
                          <input class="iris-bk-input iris-bk-mono" inputmode="numeric" value={draft.damping} placeholder="26" onInput={(e) => setDraft({ damping: e.currentTarget.value, character: "" })} />
                        </label>
                      </div>
                      <MotionPreview ease={draft.ease} durationMs={draft.durationMs} color={roles().primary} ground={roles().bg} />
                    </Match>

                    {/* ── Preview ── */}
                    <Match when={tab() === "preview"}>
                      <p class="iris-bk-lede">{t("iris.brands.preview.lede", { name: k().brand.name })}</p>
                      <KitCard kit={k()} draft={draft} />
                      <KitSection kit={k()} draft={draft} />
                    </Match>

                    {/* ── Export ── */}
                    <Match when={tab() === "export"}>
                      <p class="iris-bk-lede">{rich(t("iris.brands.export.lede", { edits: diff().length ? t("iris.brands.export.withEdits") : "" }))}</p>
                      <For each={[{ ext: "css" as const, label: "CSS", text: exportCss(k(), draft), type: "text/css" }, { ext: "json" as const, label: "JSON", text: exportJson(k(), draft), type: "application/json" }]}>
                        {(x) => (
                          <section class="iris-bk-export" data-slot="bk-export" data-ext={x.ext}>
                            <div class="iris-bk-exhead">
                              <span class="iris-bk-name">{x.label}</span>
                              <code class="iris-bk-slug">{exportName(k(), x.ext)}</code>
                              <span class="iris-ui-spacer" />
                              <Button size="small" icon="copy" onClick={() => void copy(x.text, x.label)}>{t("iris.brands.export.copy")}</Button>
                              <Button size="small" icon="download" onClick={() => download(x.text, exportName(k(), x.ext), x.type)}>{t("iris.brands.export.download", { format: x.label })}</Button>
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
                  <aside class="iris-bk-side" aria-label={t("iris.brands.livePreview")}>
                    <span class="iris-bk-h">{t("iris.brands.livePreview")}</span>
                    <KitCard kit={k()} draft={draft} compact />
                  </aside>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>

      {/* ── the confirms ── */}
      <PaneDialog when={saveAsk()} onClose={() => setConfirm(undefined)} title={(c) => c.ask.title} size="normal" class="iris-bk-dialog" id="bk-confirm">
        {(c) => (
          <div class="iris-bk-confirm" data-slot="bk-confirm">
            <For each={c().ask.body}>{(line) => <p>{line}</p>}</For>
            <ul class="iris-bk-diff" data-slot="bk-diff">
              <For each={c().lines}>
                {(l) => (
                  <li>
                    <span class="iris-bk-dlabel">{l.label}</span>
                    <span class="iris-bk-dvals">
                      <DiffValue value={l.before} swatch={l.swatch} gone />
                      <span class="iris-bk-arrow" aria-label={t("iris.brands.confirm.becomes")}>→</span>
                      <DiffValue value={l.after} swatch={l.swatch} />
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <For each={c().ask.warn}>
              {(w) => (
                <Notice tone="warning" icon={<Icon name="warning" size="small" />}>
                  {w}
                </Notice>
              )}
            </For>
            <PaneDialogActions>
              <Button size="small" disabled={saving()} onClick={() => setConfirm(undefined)} autofocus>
                {t("iris.brands.confirm.keepEditing")}
              </Button>
              <Button size="small" variant="primary" data-slot="bk-confirm-save" disabled={saving()} onClick={() => void save()}>
                <Show when={saving()}>
                  <Spinner class="iris-ui-spin" />
                </Show>
                {t("iris.brands.confirm.saveTo", { name: c().kit.brand.name })}
              </Button>
            </PaneDialogActions>
          </div>
        )}
      </PaneDialog>
      <PaneDialog when={leaveAsk()} onClose={() => setConfirm(undefined)} title={() => t("iris.brands.leave.title")} id="bk-leave">
        {(c) => (
          <div class="iris-bk-confirm" data-slot="bk-leave">
            <p>{language.plural("iris.brands.leave.body", c().count, { name: c().name })}</p>
            <PaneDialogActions>
              <Button size="small" onClick={() => setConfirm(undefined)} autofocus>
                {t("iris.brands.confirm.keepEditing")}
              </Button>
              <Button size="small" variant="primary" data-slot="bk-leave-discard" onClick={() => leave(true)}>
                {t("iris.brands.leave.discard")}
              </Button>
            </PaneDialogActions>
          </div>
        )}
      </PaneDialog>
    </div>
  )
}

function DiffValue(props: { value?: string; swatch?: boolean; gone?: boolean }) {
  const language = useLanguage()
  return (
    <Show when={props.value} fallback={<span class="iris-bk-dnone">{props.gone ? language.t("iris.brands.diff.notSet") : language.t("iris.brands.diff.removed")}</span>}>
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
  const language = useLanguage()
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
          language.t(
            pick === own
              ? tile === "light" ? "iris.brands.logo.warn.own.light" : "iris.brands.logo.warn.own.dark"
              : tile === "light" ? "iris.brands.logo.warn.primary.light" : "iris.brands.logo.warn.primary.dark",
            { verdict: p[tile].verdict },
          ),
        )
    }
    return out
  })
  return (
    <For each={lines()}>
      {(l) => (
        <Notice class="iris-bk-note" tone="warning" data-slot="bk-logo-warn" icon={<Icon name="warning" size="small" />}>
          {l}
        </Notice>
      )}
    </For>
  )
}

function MotionPreview(props: { ease: string; durationMs: string; color: string; ground: string }) {
  const language = useLanguage()
  const [at, setAt] = createSignal(false)
  const ms = () => (Number(props.durationMs) >= 0 && props.durationMs.trim() ? Number(props.durationMs) : 320)
  const ease = () => props.ease.trim() || "ease"
  const curve = () => bezierOf(ease())
  return (
    <div class="iris-bk-motion" data-slot="bk-motion">
      <Show when={curve()}>
        {(b) => (
          <svg class="iris-bk-curve" viewBox="-0.1 -0.6 1.2 2.2" preserveAspectRatio="none" aria-label={language.t("iris.brands.motion.curve", { ease: ease() })}>
            <path d="M0 1 L1 1 M0 1 L0 0" class="iris-bk-axis" />
            <path d={`M0 1 C ${b()[0]} ${1 - b()[1]}, ${b()[2]} ${1 - b()[3]}, 1 0`} class="iris-bk-bez" />
          </svg>
        )}
      </Show>
      <div class="iris-bk-track" style={{ background: props.ground }}>
        <span class="iris-bk-ball" data-at={at() ? "end" : "start"} style={{ background: props.color, transition: `left ${ms()}ms ${ease()}` }} />
      </div>
      <Button size="small" icon="play" onClick={() => setAt(!at())}>
        {language.t("iris.brands.motion.play", { ms: ms() })}
      </Button>
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
  const language = useLanguage()
  const r = () => previewRoles(props.draft)
  const logo = () => draftLogoFor(props.draft, r().surface)
  return (
    <div class="iris-bk-kitground" style={kitVars(props.draft)} data-compact={props.compact || undefined}>
      <article class="iris-bk-kcard" data-slot="bk-sample-card">
        <header>
          <KitLogo logo={logo()} name={props.kit.brand.name} />
          <span class="iris-bk-ktag">{language.t("iris.brands.sample.new")}</span>
        </header>
        <h5>{language.t("iris.brands.sample.card.title")}</h5>
        <p>{language.t("iris.brands.sample.card.body")}</p>
        <footer>
          <span class="iris-bk-kbtn">{language.t("iris.brands.sample.card.cta")}</span>
          <span class="iris-bk-klink">{language.t("iris.brands.sample.card.link")}</span>
        </footer>
      </article>
    </div>
  )
}

/** A sample page section in the kit: nav, a hero set in the scale's largest size, three tiles. */
function KitSection(props: { kit: BrandKit; draft: Draft }) {
  const language = useLanguage()
  const r = () => previewRoles(props.draft)
  const logo = () => draftLogoFor(props.draft, r().bg)
  const big = () => {
    const s = scaleSizes(props.draft.typeScale)
    return s.length ? Math.min(Math.max(s.at(-1)!.px, 28), 44) : 36
  }
  const tagline = () => props.draft.tone.trim() || props.kit.brand.description || language.t("iris.brands.sample.page.tagline")
  return (
    <div class="iris-bk-kitground iris-bk-kpage" style={kitVars(props.draft)} data-slot="bk-sample-page">
      <nav>
        <KitLogo logo={logo()} name={props.kit.brand.name} />
        <span>{language.t("iris.brands.sample.nav.product")}</span>
        <span>{language.t("iris.brands.sample.nav.pricing")}</span>
        <span>{language.t("iris.brands.sample.nav.docs")}</span>
        <span class="iris-bk-kbtn iris-bk-kbtn--sm">{language.t("iris.brands.sample.nav.signIn")}</span>
      </nav>
      <section class="iris-bk-khero">
        <span class="iris-bk-ktag">{props.kit.brand.name}</span>
        <h2 style={{ "font-size": `${big()}px` }}>{language.t("iris.brands.sample.page.title")}</h2>
        <p>{tagline()}</p>
        <div class="iris-bk-kactions">
          <span class="iris-bk-kbtn">{language.t("iris.brands.sample.page.cta")}</span>
          <span class="iris-bk-kghost">{language.t("iris.brands.sample.page.ghost")}</span>
        </div>
      </section>
      <div class="iris-bk-ktiles">
        <For each={SAMPLE_TILES}>
          {(tile, i) => (
            <div>
              <b>{language.t(tile.name)}</b>
              <span>{language.t(tile.line)}</span>
              <code>0{i() + 1}</code>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

const SAMPLE_TILES: { name: BrandsKey; line: BrandsKey }[] = [
  { name: "iris.brands.sample.tile.agents", line: "iris.brands.sample.tile.agents.line" },
  { name: "iris.brands.sample.tile.pages", line: "iris.brands.sample.tile.pages.line" },
  { name: "iris.brands.sample.tile.outreach", line: "iris.brands.sample.tile.outreach.line" },
]

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
