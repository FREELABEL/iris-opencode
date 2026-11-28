import { createEffect, createMemo, createSignal, For, Index, Match, on, Show, Switch, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { StatusBadge, type StatusTone } from "@opencode-ai/ui/status-badge"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Tag } from "@opencode-ai/ui/tag"
import { useLanguage } from "@/context/language"
import type { IRIS_BRAND_AUDIENCE_ENGLISH } from "@/i18n/iris-brand-audience"
import {
  AUDIENCE_ENUMS,
  NOT_FOR_FIELDS,
  POSITIONING_FIELDS,
  SEGMENT_GROUPS,
  USE_CASE_FIELDS,
  emptySegment,
  isB2b,
  normalizeAudience,
  segmentSummary,
  validateAudience,
  type Audience,
  type AudienceIssue,
  type FieldSpec,
  type GroupSpec,
  type Segment,
  type SegmentGroupKey,
} from "./iris-brand-audience-schema"
import { audienceChanged, audienceDiff, groupOfPath, issuesUnder, type AudienceDiffLine } from "./iris-brand-audience-model"
import "./iris-brand-audience.css"

/**
 * Genesis › Brand kits › Audience (#194611): who a brand sells to, in the shared audience.v1 shape
 * (iris-brand-audience-schema.ts). Segments are cards; a segment opens to one group at a time
 * (Identity, Demographics, …, Personas) so a dense form reads as short ones. Brand-level use cases,
 * not-for and positioning sit beside the segments.
 *
 * The draft lives in createAudienceEditor(), owned by the brand kit pane, so it survives switching
 * tabs and the kit's one Save and unsaved-changes guard cover it. Nothing is sent while typing.
 */

type AudKey = keyof typeof IRIS_BRAND_AUDIENCE_ENGLISH
type Section = "segments" | "use_cases" | "not_for" | "positioning"
type Path = (string | number)[]

const pathText = (p: Path) => p.map((x, i) => (typeof x === "number" ? `[${x}]` : i ? `.${x}` : x)).join("")
const at = (root: unknown, p: Path): any => p.reduce<any>((o, k) => (o == null ? undefined : o[k]), root)

/** The audience draft for the open kit. Created once by the kit pane; reset whenever the kit is (re)read. */
export function createAudienceEditor(kit: () => { brand: { id: number }; audience?: unknown } | undefined) {
  const [aud, setAud] = createStore<Audience>(normalizeAudience(undefined))
  let keep: Audience | undefined
  const [section, setSection] = createSignal<Section>("segments")
  const [open, setOpen] = createSignal<number>()
  const [group, setGroup] = createSignal<SegmentGroupKey>("identity")
  const [server, setServer] = createSignal<AudienceIssue[]>([])
  const [shown, setShown] = createSignal(false)
  let lastId: number | undefined
  createEffect(
    on(kit, (k) => {
      if (!k) return
      setAud(reconcile(keep ?? normalizeAudience(k.audience)))
      keep = undefined
      if (k.brand.id !== lastId) {
        lastId = k.brand.id
        setSection("segments")
        setOpen(undefined)
        setGroup("identity")
        setShown(false)
        setServer([])
      }
    }),
  )
  const changed = createMemo(() => !!kit() && audienceChanged(kit()!.audience, aud))
  const check = createMemo(() => validateAudience(JSON.parse(JSON.stringify(aud))))
  const issues = createMemo(() => (shown() ? [...check().errors, ...server()] : []))
  return {
    aud,
    setAud,
    set: (p: Path, v: unknown) => (setAud as unknown as (...a: unknown[]) => void)(...p, v),
    changed,
    check,
    issues,
    server,
    setServer,
    shown,
    setShown,
    section,
    setSection,
    open,
    setOpen,
    group,
    setGroup,
    /** Keep this draft across the next kit read (a token save that landed while the audience did not). */
    keepNext: (a: Audience) => (keep = JSON.parse(JSON.stringify(a)) as Audience),
    discard: () => {
      const k = kit()
      setAud(reconcile(normalizeAudience(k?.audience)))
      setShown(false)
      setServer([])
      if ((open() ?? 0) >= aud.segments.length) setOpen(undefined)
    },
    /** Show every problem inline and jump to the first one. */
    reveal: () => {
      setShown(true)
      const first = issues()[0]
      if (!first) return
      const g = groupOfPath(first.path)
      if (g) {
        setSection("segments")
        setOpen(g.segment)
        setGroup(g.group)
      } else {
        const s = first.path.split(/[.[]/)[0] as Section
        if (s === "use_cases" || s === "not_for" || s === "positioning") {
          setSection(s)
          setOpen(undefined)
        }
      }
    },
  }
}
export type AudienceEditor = ReturnType<typeof createAudienceEditor>

/** The confirm's lines for the audience, in the kit's own words. */
export function audienceDiffLines(ed: AudienceEditor, read: unknown, t: (k: AudKey, p?: Record<string, string | number>) => string): AudienceDiffLine[] {
  if (!ed.changed()) return []
  return audienceDiff(read, ed.aud, {
    segment: (name) => t("iris.aud.diff.segment", { name }),
    brand: (part) => t(`iris.aud.section.${part}` as AudKey),
    group: (key) => t(`iris.aud.g.${key}` as AudKey),
    added: t("iris.aud.diff.added"),
    removed: t("iris.brands.diff.removed" as AudKey),
    changed: (parts) => t("iris.aud.diff.changed", { parts }),
    unnamed: t("iris.aud.unnamed"),
  })
}

const PRIORITY_TONE: Record<string, StatusTone> = { primary: "accent", secondary: "neutral", emerging: "info" }
const CONFIDENCE_TONE: Record<string, StatusTone> = { assumed: "warning", observed: "info", validated: "success" }
const LONG = new Set(["summary", "self_image", "quote", "typical_tuesday", "what_would_make_them_switch", "problem", "how_we_solve_it", "example", "statement", "why"])
const PLACEHOLDER = new Set(["name", "summary", "self_image", "best_time_to_reach", "budget", "sources", "languages", "quote", "statement"])

function useT() {
  const language = useLanguage()
  const t = (key: AudKey, params?: Record<string, string | number>) => language.t(key, params)
  return { t, language }
}

export function IrisBrandAudience(props: { ed: AudienceEditor; brandName: string }) {
  const { t, language } = useT()
  const ed = props.ed
  const segs = () => ed.aud.segments

  function addSegment() {
    const s = { ...emptySegment(""), id: undefined } as Segment
    ed.setAud("segments", (list) => [...list, normalizeAudience({ segments: [s] }).segments[0]!])
    ed.setSection("segments")
    ed.setGroup("identity")
    ed.setOpen(segs().length - 1)
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-slot="aud-field"][data-key="name"] input')?.focus())
  }
  function removeSegment(i: number) {
    ed.setAud("segments", (list) => list.filter((_, j) => j !== i))
    ed.setOpen(undefined)
  }
  const unknownKeys = createMemo(() => [...new Set(ed.check().warnings.filter((w) => w.code === "unknown").map((w) => w.path.split(/[.[]/).pop()!))])
  const count = (s: Section) =>
    s === "segments" ? segs().length : s === "use_cases" ? (ed.aud.use_cases?.length ?? 0) : s === "not_for" ? (ed.aud.not_for?.length ?? 0) : undefined

  return (
    <div class="iris-aud" data-slot="audience">
      <p class="iris-bk-lede">{t("iris.aud.lede", { name: props.brandName })}</p>
      <Show when={ed.open() == null}>
        <div class="iris-aud-head">
          <Tabs variant="pill" size="small" value={ed.section()} onChange={(v: string) => ed.setSection(v as Section)}>
            <Tabs.List aria-label={t("iris.aud.sections")}>
              <For each={["segments", "use_cases", "not_for", "positioning"] as Section[]}>
                {(s) => (
                  <Tabs.Trigger value={s} data-aud-section={s}>
                    {t(`iris.aud.section.${s}` as AudKey)}
                    <Show when={count(s) != null}>
                      {" "}
                      <span class="n">{count(s)}</span>
                    </Show>
                    <Show when={issuesUnder(ed.issues(), s).length}>
                      <span class="iris-aud-errdot" />
                    </Show>
                  </Tabs.Trigger>
                )}
              </For>
            </Tabs.List>
          </Tabs>
          <span class="iris-ui-spacer" />
          <Show when={ed.section() === "segments" && segs().length}>
            <Button size="small" icon="plus" onClick={addSegment}>{t("iris.aud.add")}</Button>
          </Show>
        </div>
      </Show>

      <Switch>
        {/* ── one segment, one group at a time ── */}
        <Match when={ed.open() != null && segs()[ed.open()!]}>
          <SegmentEditor ed={ed} index={ed.open()!} onRemove={() => removeSegment(ed.open()!)} />
        </Match>
        <Match when={ed.section() === "segments"}>
          <Show
            when={segs().length}
            fallback={
              <EmptyState
                class="iris-aud-empty"
                title={t("iris.aud.empty.title")}
                description={t("iris.aud.empty.body")}
                action={<Button variant="primary" size="small" icon="plus" onClick={addSegment}>{t("iris.aud.add")}</Button>}
              />
            }
          >
            <ul class="iris-aud-cards">
              <Index each={segs()}>
                {(s, i) => {
                  const problems = () => issuesUnder(ed.issues(), `segments[${i}]`).length
                  const facts = () => segmentSummary({ ...s(), summary: undefined, priority: undefined, market: undefined })
                  return (
                    <li>
                      <button type="button" class="iris-aud-card" data-slot="aud-card" onClick={() => { ed.setGroup("identity"); ed.setOpen(i) }}>
                        <span class="iris-aud-card-top">
                          <span class="iris-aud-card-name">{s().name || t("iris.aud.unnamed")}</span>
                          <Show when={s().priority}>
                            <StatusBadge size="small" tone={PRIORITY_TONE[s().priority!] ?? "neutral"}>{t(`iris.aud.v.priority.${s().priority}` as AudKey)}</StatusBadge>
                          </Show>
                          <Show when={s().market}>
                            <span class="iris-aud-card-market">{t(`iris.aud.v.market.${s().market}` as AudKey)}</span>
                          </Show>
                        </span>
                        <span class="iris-aud-card-summary" data-none={!s().summary || undefined}>{s().summary || t("iris.aud.noSummary")}</span>
                        <Show when={facts()}>
                          <span class="iris-aud-card-facts">{facts()}</span>
                        </Show>
                        <span class="iris-aud-card-foot">
                          <StatusBadge size="small" tone={CONFIDENCE_TONE[s().evidence?.confidence] ?? "neutral"} mark="dot">
                            {t(`iris.aud.v.confidence.${s().evidence?.confidence ?? "assumed"}` as AudKey)}
                          </StatusBadge>
                          <Show when={s().personas?.length}>
                            <span>{language.plural("iris.aud.personaCount", s().personas!.length)}</span>
                          </Show>
                          <Show when={s().jobs?.length}>
                            <span>{language.plural("iris.aud.useCaseCount", s().jobs!.length)}</span>
                          </Show>
                          <Show when={problems()}>
                            <StatusBadge size="small" tone="critical">{language.plural("iris.aud.cardProblems", problems())}</StatusBadge>
                          </Show>
                        </span>
                      </button>
                    </li>
                  )
                }}
              </Index>
            </ul>
          </Show>
        </Match>
        <Match when={ed.section() === "use_cases"}>
          <p class="iris-aud-glede">{t("iris.aud.usecase.lede")}</p>
          <Rows ed={ed} path={["use_cases"]} fields={USE_CASE_FIELDS} add={t("iris.aud.usecase.add")} title={(r) => r.name || t("iris.aud.usecase.untitled")} />
        </Match>
        <Match when={ed.section() === "not_for"}>
          <p class="iris-aud-glede">{t("iris.aud.notfor.lede")}</p>
          <Rows ed={ed} path={["not_for"]} fields={NOT_FOR_FIELDS} add={t("iris.aud.notfor.add")} />
        </Match>
        <Match when={ed.section() === "positioning"}>
          <p class="iris-aud-glede">{t("iris.aud.positioning.lede")}</p>
          <div class="iris-aud-form">
            <For each={POSITIONING_FIELDS}>{(f) => <Field ed={ed} spec={f} path={["positioning", f.key]} />}</For>
          </div>
        </Match>
      </Switch>
      <Show when={ed.open() == null && unknownKeys().length}>
        <p class="iris-bk-hint iris-aud-kept">{t("iris.aud.unknownKept", { keys: unknownKeys().join(", ") })}</p>
      </Show>
    </div>
  )
}

function SegmentEditor(props: { ed: AudienceEditor; index: number; onRemove: () => void }) {
  const { t } = useT()
  const ed = props.ed
  const seg = () => ed.aud.segments[props.index]!
  const groups = createMemo(() => SEGMENT_GROUPS.filter((g) => g.when !== "b2b" || isB2b(seg().market)))
  createEffect(() => {
    if (!groups().some((g) => g.key === ed.group())) ed.setGroup("identity")
  })
  const base = () => `segments[${props.index}]`
  const groupIssues = (g: GroupSpec) =>
    g.shape === "flat"
      ? ed.issues().filter((i) => groupOfPath(i.path)?.segment === props.index && groupOfPath(i.path)?.group === "identity")
      : issuesUnder(ed.issues(), `${base()}.${g.key}`)
  const filled = (g: GroupSpec) => {
    const v = g.shape === "flat" ? undefined : (seg() as any)[g.key]
    if (g.shape === "flat") return !!seg().name
    if (Array.isArray(v)) return v.length > 0
    return !!v && Object.values(v).some((x) => (Array.isArray(x) ? x.length : x && typeof x === "object" ? Object.values(x).some(Boolean) : x !== undefined && x !== ""))
  }
  const spec = () => groups().find((g) => g.key === ed.group()) ?? groups()[0]!

  return (
    <div class="iris-aud-seg" data-slot="aud-segment">
      <div class="iris-aud-seghead">
        <IconButton icon="arrow-left" variant="ghost" size="small" title={t("iris.aud.back")} aria-label={t("iris.aud.back")} onClick={() => ed.setOpen(undefined)} />
        <span class="iris-aud-segname">{seg().name || t("iris.aud.unnamed")}</span>
        <Show when={seg().priority}>
          <StatusBadge size="small" tone={PRIORITY_TONE[seg().priority!] ?? "neutral"}>{t(`iris.aud.v.priority.${seg().priority}` as AudKey)}</StatusBadge>
        </Show>
        <StatusBadge size="small" tone={CONFIDENCE_TONE[seg().evidence?.confidence] ?? "neutral"} mark="dot">
          {t(`iris.aud.v.confidence.${seg().evidence?.confidence ?? "assumed"}` as AudKey)}
        </StatusBadge>
        <span class="iris-ui-spacer" />
        <Button size="small" variant="ghost" icon="trash" onClick={props.onRemove}>{t("iris.aud.remove")}</Button>
      </div>
      <div class="iris-aud-segbody">
        <Tabs variant="alt" orientation="vertical" class="iris-aud-groups" value={ed.group()} onChange={(v: string) => ed.setGroup(v as SegmentGroupKey)}>
          <Tabs.List aria-label={t("iris.aud.groups")}>
            <For each={groups()}>
              {(g) => (
                <Tabs.Trigger value={g.key} data-group={g.key}>
                  <span class="iris-aud-gname">{t(`iris.aud.g.${g.key}` as AudKey)}</span>
                  <Show when={groupIssues(g).length} fallback={<span class="iris-aud-filled" data-on={filled(g) || undefined} aria-hidden="true" />}>
                    <span class="iris-aud-errdot" />
                  </Show>
                </Tabs.Trigger>
              )}
            </For>
          </Tabs.List>
        </Tabs>
        <section class="iris-aud-group" data-slot="aud-group" data-group-open={spec().key}>
          <h4 class="iris-aud-gtitle">{t(`iris.aud.g.${spec().key}` as AudKey)}</h4>
          <p class="iris-aud-glede">{t(`iris.aud.g.${spec().key}.lede` as AudKey)}</p>
          <Switch>
            <Match when={spec().key === "jobs"}>
              <Jobs ed={ed} path={["segments", props.index, "jobs"]} />
            </Match>
            <Match when={spec().key === "personas"}>
              <Rows
                ed={ed}
                path={["segments", props.index, "personas"]}
                fields={spec().fields}
                add={t("iris.aud.persona.add")}
                max={3}
                maxNote={t("iris.aud.persona.max")}
                title={(r) => r.name || t("iris.aud.persona.untitled")}
                persona
              />
            </Match>
            <Match when={spec().shape === "flat"}>
              <div class="iris-aud-form">
                <For each={spec().fields.filter((f) => f.key !== "id")}>{(f) => <Field ed={ed} spec={f} path={["segments", props.index, f.key]} />}</For>
              </div>
            </Match>
            <Match when={true}>
              <div class="iris-aud-form">
                <For each={spec().fields}>{(f) => <Field ed={ed} spec={f} path={["segments", props.index, spec().key, f.key]} />}</For>
              </div>
            </Match>
          </Switch>
        </section>
      </div>
    </div>
  )
}

/** Use cases inside a segment, read as a sentence: When … they want to … so they can … Today they use … */
function Jobs(props: { ed: AudienceEditor; path: Path }) {
  const { t } = useT()
  const rows = () => (at(props.ed.aud, props.path) as any[]) ?? []
  const parts = ["when", "want_to", "so_they_can", "today_they_use"] as const
  return (
    <div class="iris-aud-rows">
      <Index each={rows()}>
        {(_, i) => (
          <div class="iris-aud-job" data-slot="aud-job">
            <For each={parts}>
              {(k) => (
                <label class="iris-aud-jobpart">
                  <span>{t(`iris.aud.job.${k}` as AudKey)}</span>
                  <input
                    class="iris-bk-input"
                    value={rows()[i]?.[k] ?? ""}
                    placeholder={t(`iris.aud.ph.${k}` as AudKey)}
                    onInput={(e) => props.ed.set([...props.path, i, k], e.currentTarget.value)}
                  />
                </label>
              )}
            </For>
            <IconButton
              class="iris-aud-rowx"
              icon="close-small"
              variant="ghost"
              size="small"
              title={t("iris.aud.row.remove")}
              aria-label={t("iris.aud.row.remove")}
              onClick={() => props.ed.set(props.path, rows().filter((__, j) => j !== i))}
            />
          </div>
        )}
      </Index>
      <div>
        <Button size="small" icon="plus" onClick={() => props.ed.set(props.path, [...rows(), {}])}>{t("iris.aud.job.add")}</Button>
      </div>
    </div>
  )
}

/** A list of objects (personas, brand use cases, not-for), each a small card of fields. */
function Rows(props: {
  ed: AudienceEditor
  path: Path
  fields: FieldSpec[]
  add: string
  title?: (row: any) => string
  max?: number
  maxNote?: string
  persona?: boolean
}) {
  const { t } = useT()
  const rows = () => (at(props.ed.aud, props.path) as any[]) ?? []
  return (
    <div class="iris-aud-rows">
      <Index each={rows()}>
        {(row, i) => (
          <div class="iris-aud-row" data-slot={props.persona ? "aud-persona" : "aud-row"}>
            <Show when={props.title}>
              <div class="iris-aud-rowhead">
                <Show when={props.persona}>
                  <span class="iris-aud-avatar" aria-hidden="true">
                    <Show when={/^https?:\/\//.test(row()?.photo ?? "")} fallback={(row()?.name || "?").slice(0, 1).toUpperCase()}>
                      <img src={row().photo} alt="" />
                    </Show>
                  </span>
                </Show>
                <span class="iris-aud-rowtitle">{props.title!(row() ?? {})}</span>
                <Show when={props.persona && (row()?.age || row()?.role)}>
                  <span class="iris-bk-hint">{[row()?.age, row()?.role].filter(Boolean).join(" · ")}</span>
                </Show>
                <span class="iris-ui-spacer" />
                <IconButton icon="close-small" variant="ghost" size="small" title={t("iris.aud.row.remove")} aria-label={t("iris.aud.row.remove")} onClick={() => props.ed.set(props.path, rows().filter((_, j) => j !== i))} />
              </div>
            </Show>
            <div class="iris-aud-form">
              <For each={props.fields}>
                {(f) =>
                  f.key === "for_segments" ? (
                    <SegmentPicker ed={props.ed} path={[...props.path, i, f.key]} spec={f} />
                  ) : (
                    <Field ed={props.ed} spec={f} path={[...props.path, i, f.key]} />
                  )
                }
              </For>
            </div>
            <Show when={!props.title}>
              <div class="iris-aud-rowfoot">
                <Button size="small" variant="ghost" icon="close-small" onClick={() => props.ed.set(props.path, rows().filter((_, j) => j !== i))}>{t("iris.aud.row.remove")}</Button>
              </div>
            </Show>
          </div>
        )}
      </Index>
      <Show when={!props.max || rows().length < props.max} fallback={<p class="iris-bk-hint">{props.maxNote}</p>}>
        <div>
          <Button size="small" icon="plus" onClick={() => props.ed.set(props.path, [...rows(), {}])}>{props.add}</Button>
        </div>
      </Show>
    </div>
  )
}

/** "For" on a brand use case: which segments it serves, picked from the segments that exist. */
function SegmentPicker(props: { ed: AudienceEditor; path: Path; spec: FieldSpec }) {
  const { t } = useT()
  const value = () => ((at(props.ed.aud, props.path) as string[] | undefined) ?? []).filter((x) => typeof x === "string")
  const options = () => props.ed.aud.segments.map((s) => ({ ref: s.id || s.name, name: s.name || t("iris.aud.unnamed") })).filter((o) => o.ref)
  const toggle = (ref: string) => props.ed.set(props.path, value().includes(ref) ? value().filter((x) => x !== ref) : [...value(), ref])
  return (
    <div class="iris-bk-field iris-aud-wide" data-slot="aud-field" data-key={props.spec.key}>
      <span>{t("iris.aud.f.for_segments")}</span>
      <Show when={options().length} fallback={<span class="iris-bk-hint">{t("iris.aud.noSegmentsYet")}</span>}>
        <div class="iris-aud-toggles">
          <For each={options()}>
            {(o) => (
              <Button size="small" variant="ghost" class="iris-aud-toggle" aria-pressed={value().includes(o.ref)} data-on={value().includes(o.ref) || undefined} onClick={() => toggle(o.ref)}>
                {o.name}
              </Button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** One audience.v1 field, drawn by its kind: text, chips for lists, a select or toggles for enums. */
function Field(props: { ed: AudienceEditor; spec: FieldSpec; path: Path }) {
  const { t } = useT()
  const ed = props.ed
  const key = props.spec.key
  const value = () => at(ed.aud, props.path)
  const errs = createMemo(() => issuesUnder(ed.issues(), pathText(props.path)))
  const label = t(`iris.aud.f.${key}` as AudKey)
  const ph = PLACEHOLDER.has(key) ? t(`iris.aud.ph.${key}` as AudKey) : undefined
  const enumValues = props.spec.enum ? (AUDIENCE_ENUMS[props.spec.enum] as readonly string[]) : []
  const enumLabel = (v: string) => (v ? t(`iris.aud.v.${props.spec.enum}.${v}` as AudKey) : t("iris.aud.notSet"))
  const wide = props.spec.kind === "list" || props.spec.kind === "enums" || props.spec.kind === "routine" || LONG.has(key)
  const set = (v: unknown) => ed.set(props.path, v)
  const err = (): JSX.Element => (
    <Show when={errs()[0]}>
      {(e) => <span class="iris-aud-err" role="alert">{t(`iris.aud.err.${e().code}` as AudKey) || t("iris.aud.err.other")}</span>}
    </Show>
  )
  return (
    <div class="iris-bk-field" classList={{ "iris-aud-wide": wide }} data-slot="aud-field" data-key={key} data-invalid={errs().length ? "" : undefined}>
      <Switch>
        <Match when={props.spec.kind === "list"}>
          <span>{label}</span>
          <Chips values={(value() as string[] | undefined) ?? []} label={label} placeholder={ph} invalid={!!errs().length} onChange={(v) => set(v)} />
        </Match>
        <Match when={props.spec.kind === "enums"}>
          <span>{label}</span>
          <div class="iris-aud-toggles" role="group" aria-label={label}>
            <For each={enumValues}>
              {(v) => {
                const on = () => ((value() as string[] | undefined) ?? []).includes(v)
                return (
                  <Button size="small" variant="ghost" class="iris-aud-toggle" aria-pressed={on()} data-on={on() || undefined}
                    onClick={() => set(on() ? ((value() as string[]) ?? []).filter((x) => x !== v) : enumValues.filter((x) => x === v || ((value() as string[]) ?? []).includes(x)))}>
                    {enumLabel(v)}
                  </Button>
                )
              }}
            </For>
          </div>
        </Match>
        <Match when={props.spec.kind === "enum"}>
          <span>{label}</span>
          <div class="iris-aud-select">
            <Select
              size="small"
              options={["none", ...enumValues]}
              current={(value() as string | undefined) || "none"}
              value={(x) => x}
              label={(x) => enumLabel(x === "none" ? "" : x)}
              onSelect={(x) => set(x && x !== "none" ? x : undefined)}
              aria-label={label}
            />
          </div>
        </Match>
        <Match when={props.spec.kind === "routine"}>
          <span>{label}</span>
          <div class="iris-aud-routine">
            <For each={["morning", "work", "evening"] as const}>
              {(part) => (
                <label class="iris-aud-jobpart">
                  <span>{t(`iris.aud.f.${part}` as AudKey)}</span>
                  <input class="iris-bk-input" value={value()?.[part] ?? ""} onInput={(e) => ed.set([...props.path, part], e.currentTarget.value)} />
                </label>
              )}
            </For>
          </div>
        </Match>
        <Match when={LONG.has(key)}>
          <span>{label}</span>
          <textarea class="iris-bk-input" rows={2} value={(value() as string) ?? ""} placeholder={ph} aria-invalid={errs().length ? true : undefined} onInput={(e) => set(e.currentTarget.value)} />
        </Match>
        <Match when={true}>
          <span>{label}</span>
          <input
            class="iris-bk-input"
            type={props.spec.kind === "date" ? "date" : "text"}
            inputmode={props.spec.kind === "number" ? "numeric" : undefined}
            value={value() == null ? "" : String(value())}
            placeholder={ph}
            aria-invalid={errs().length ? true : undefined}
            onInput={(e) => {
              const raw = e.currentTarget.value
              if (props.spec.kind !== "number") return set(raw)
              const n = raw.trim()
              set(n === "" ? undefined : Number.isFinite(Number(n)) ? Number(n) : n)
            }}
          />
        </Match>
      </Switch>
      {err()}
    </div>
  )
}

/** A list of short values as chips. Enter or a comma adds; Backspace in an empty box takes the last one back. */
function Chips(props: { values: string[]; label: string; placeholder?: string; invalid?: boolean; onChange: (v: string[]) => void }) {
  const { t } = useT()
  const [text, setText] = createSignal("")
  const commit = () => {
    const parts = text().split(",").map((s) => s.trim()).filter(Boolean)
    if (parts.length) props.onChange([...props.values, ...parts.filter((p) => !props.values.includes(p))])
    setText("")
  }
  return (
    <div class="iris-aud-chips" data-invalid={props.invalid || undefined}>
      <For each={props.values}>
        {(v, i) => (
          <Tag class="iris-aud-chip">
            <span>{v}</span>
            <IconButton icon="close-small" variant="ghost" size="small" class="iris-aud-chipx" aria-label={t("iris.aud.list.remove", { value: v })} onClick={() => props.onChange(props.values.filter((_, j) => j !== i()))} />
          </Tag>
        )}
      </For>
      <input
        class="iris-aud-chipinput"
        value={text()}
        aria-label={props.label}
        placeholder={props.values.length ? "" : (props.placeholder ?? t("iris.aud.list.placeholder"))}
        onInput={(e) => {
          const v = e.currentTarget.value
          if (v.includes(",")) {
            setText(v)
            commit()
          } else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Backspace" && !text() && props.values.length) props.onChange(props.values.slice(0, -1))
        }}
        onBlur={commit}
      />
    </div>
  )
}

