import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePrompt } from "@/context/prompt"
import "./iris-brand-kits.css"

/**
 * Genesis › Brand kits (#188816).
 *
 * A brand kit is the design tokens fl-api keeps for a brand — colours, type, logo, motion — plus
 * its voice personas. This pane is the specimen sheet for one: what the colours ARE (swatches with
 * their values in mono), what the type looks like set in its own stack, and how it moves.
 *
 * THREE VERBS, and two of them never send anything:
 *   Use   puts a request in the composer carrying the kit as CSS custom properties; you read it
 *         and press enter. Same rule as the Atlas epic card: a button that talks to the agent
 *         on your behalf without showing you the words is how prompts get sent you did not mean.
 *   Copy  copies that CSS.
 *   Edit  one section at a time (colours, type, motion). The save is PINNED to what this pane read
 *         and refused if the kit changed underneath it; on success the pane shows what the server
 *         read back, not what it hoped it sent.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Swatch = { name: string; value: string }
type BrandSummary = {
  id: number
  name: string
  slug: string
  status: string
  entityType?: string
  swatches: Swatch[]
  logoUrl?: string
}
type BrandColor = { name: string; value: string; key: string; extra: Record<string, unknown> }
type BrandKit = {
  brand: { id: number; name: string; slug: string; status: string; description?: string }
  colors: BrandColor[]
  fonts: { role: string; family: string }[]
  typeScale: { role: string; value: string }[]
  logoUrl?: string
  motion?: { ease?: string; durationMs?: number; character?: string }
  personas: { name: string; isDefault: boolean; tone?: string }[]
  sections: Record<string, string>
}
type Section = "colors" | "typography" | "motion"

const DRAWABLE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i
const HEX6 = /^#[0-9a-f]{6}$/i

/** Optional context: the pane can render where there is no composer (it then hides Use). */
function tryUse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** Same rules as the sidecar's kitToCss: sanitised names, values that cannot close the rule. */
export function kitCss(kit: BrandKit): string {
  const name = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  const safe = (v: string) => v.replace(/[;{}<>]/g, "")
  const lines = [`/* ${safe(kit.brand.name)} — IRIS brand kit */`, ":root {"]
  for (const c of kit.colors) if (DRAWABLE.test(c.value.trim())) lines.push(`  --color-${name(c.name)}: ${safe(c.value)};`)
  for (const f of kit.fonts) lines.push(`  --font-${name(f.role)}: ${safe(f.family)};`)
  if (kit.motion?.ease) lines.push(`  --ease: ${safe(kit.motion.ease)};`)
  if (kit.motion?.durationMs != null) lines.push(`  --duration: ${kit.motion.durationMs}ms;`)
  lines.push("}")
  return lines.join("\n")
}

/** What Use puts in the composer. Plain words first, the tokens after, nothing hidden. */
export function usePromptFor(kit: BrandKit): string {
  return [
    `Use the ${kit.brand.name} brand kit (brand "${kit.brand.slug}") for the next Genesis artifact.`,
    "Take colour and type ONLY from these tokens — reference them as CSS custom properties, not hard-coded values:",
    "",
    "```css",
    kitCss(kit),
    "```",
  ].join("\n")
}

export function IrisBrandKits(props: { doFetch: Fetch }) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> =>
    (await (await props.doFetch(path, init)).json()) as T
  const prompt = tryUse(() => usePrompt())

  const [list, { refetch: reloadList }] = createResource(() =>
    json<{ measured: boolean; reason?: string; brands: BrandSummary[] }>("/iris/brands"),
  )
  const [openId, setOpenId] = createSignal<number>()
  const [kitRes, { mutate: setKit, refetch: reloadKit }] = createResource(openId, (id) =>
    json<{ measured: boolean; reason?: string; kit?: BrandKit }>(`/iris/brands/${id}`),
  )
  const kit = () => kitRes()?.kit

  // ── editing: one section at a time ───────────────────────────────────
  const [editing, setEditing] = createSignal<Section>()
  const [draft, setDraft] = createStore<{ colors: BrandColor[]; fonts: { role: string; family: string }[]; ease: string; durationMs: string }>({
    colors: [],
    fonts: [],
    ease: "",
    durationMs: "",
  })
  const [saving, setSaving] = createSignal(false)
  const [note, setNote] = createSignal<{ kind: "ok" | "err"; text: string }>()

  function startEdit(section: Section) {
    const k = kit()
    if (!k) return
    setNote(undefined)
    setDraft("colors", reconcile(k.colors.map((c) => ({ ...c }))))
    setDraft("fonts", reconcile(k.fonts.map((f) => ({ ...f }))))
    setDraft("ease", k.motion?.ease ?? "")
    setDraft("durationMs", k.motion?.durationMs != null ? String(k.motion.durationMs) : "")
    setEditing(section)
  }

  /** The whole section, because fl-api replaces sections whole: a partial one would delete keys. */
  function valueFor(section: Section, k: BrandKit): unknown {
    // Written back under the key the brand already uses (DEFAULT or default): see BrandColor.key.
    if (section === "colors") return Object.fromEntries(draft.colors.map((c) => [c.name, { ...c.extra, [c.key || "DEFAULT"]: c.value.trim() }]))
    if (section === "typography") {
      // Keep the type-scale entries (sizes/weights) the pane does not edit.
      const read = JSON.parse(k.sections.typography || "null") ?? {}
      for (const f of draft.fonts) read[f.role] = { ...(read[f.role] ?? {}), family: f.family.trim() }
      return read
    }
    const read = JSON.parse(k.sections.motion || "null") ?? {}
    const out: Record<string, unknown> = { ...read, ease: draft.ease.trim() || undefined }
    const ms = Number(draft.durationMs)
    if (draft.durationMs.trim() !== "" && Number.isFinite(ms)) out.duration_ms = ms
    return out
  }

  async function save() {
    const k = kit()
    const section = editing()
    if (!k || !section) return
    setSaving(true)
    setNote(undefined)
    try {
      const r = await json<{ ok: boolean; reason?: string; kit?: BrandKit }>(`/iris/brands/${k.brand.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, value: valueFor(section, k), expected: k.sections[section] ?? "null" }),
      })
      if (!r.ok) {
        setNote({ kind: "err", text: r.reason ?? "The save was refused." })
        return
      }
      if (r.kit) setKit({ measured: true, kit: r.kit })
      else await reloadKit()
      setEditing(undefined)
      setNote({ kind: "ok", text: r.reason ?? "Saved — showing what the server holds now." })
      void reloadList()
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : String(e) })
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
    setNote({ kind: "ok", text: "In the composer — read it, then press enter." })
  }

  async function copyCss() {
    const k = kit()
    if (!k) return
    try {
      await navigator.clipboard.writeText(kitCss(k))
      setNote({ kind: "ok", text: "CSS copied." })
    } catch {
      setNote({ kind: "err", text: "Clipboard is not available here." })
    }
  }

  const brands = createMemo(() => list()?.brands ?? [])

  return (
    <div class="iris-bk">
      <Show
        when={openId() != null}
        fallback={
          <>
            <Show when={list.loading && !list()}>
              <p class="iris-bk__muted">Loading brand kits…</p>
            </Show>
            <Show when={list() && !list()!.measured}>
              <p class="iris-bk__error">Couldn't load brand kits: {list()!.reason}</p>
            </Show>
            <Show when={list()?.measured && brands().length === 0}>
              <p class="iris-bk__muted">
                No brands on this account yet. Create one with <code>iris brands create</code>, then import its tokens
                with <code>iris brands dt import &lt;slug&gt; --css ./tokens.css</code>.
              </p>
            </Show>
            <ul class="iris-bk__list">
              <For each={brands()}>
                {(b) => (
                  <li>
                    <button type="button" class="iris-bk__row" onClick={() => setOpenId(b.id)}>
                      <span class="iris-bk__mark">
                        <Show when={b.logoUrl} fallback={<span>{b.name.slice(0, 1).toUpperCase()}</span>}>
                          <img src={b.logoUrl} alt="" loading="lazy" />
                        </Show>
                      </span>
                      <span class="iris-bk__rowtext">
                        <span class="iris-bk__name">{b.name}</span>
                        <span class="iris-bk__slug">{b.slug}{b.status !== "active" ? ` · ${b.status}` : ""}</span>
                      </span>
                      <span class="iris-bk__chips" aria-hidden="true">
                        <For each={b.swatches}>{(s) => <span class="iris-bk__chip" style={{ background: s.value }} />}</For>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </>
        }
      >
        <div class="iris-bk__bar">
          <button type="button" class="iris-card__linkbtn" onClick={() => { setOpenId(undefined); setEditing(undefined); setNote(undefined) }}>
            ← All brands
          </button>
          <span class="iris-bk__spacer" />
          <Show when={kit()}>
            <button type="button" class="iris-card__linkbtn" onClick={copyCss}>Copy CSS</button>
            <Show when={prompt}>
              <button type="button" class="iris-card__linkbtn iris-card__linkbtn--primary" onClick={use}>
                Use for new artifact
              </button>
            </Show>
          </Show>
        </div>

        <Show when={note()}>
          <p class={note()!.kind === "err" ? "iris-bk__error" : "iris-bk__ok"} role="status">
            {note()!.text}
            {/* A refused save (someone else changed the kit) is fixed by reading it again. Your
                draft is discarded: it was built on values that are no longer there. */}
            <Show when={note()!.kind === "err" && /changed since/.test(note()!.text)}>
              {" "}
              <button
                type="button"
                class="iris-card__linkbtn"
                onClick={() => {
                  setEditing(undefined)
                  setNote(undefined)
                  void reloadKit()
                }}
              >
                Reload kit
              </button>
            </Show>
          </p>
        </Show>
        <Show when={kitRes.loading && !kit()}>
          <p class="iris-bk__muted">Loading kit…</p>
        </Show>
        <Show when={kitRes() && !kitRes()!.measured}>
          <p class="iris-bk__error">Couldn't load this kit: {kitRes()!.reason}</p>
        </Show>

        <Show when={kit()}>
          {(k) => (
            <div class="iris-bk__kit">
              <header class="iris-bk__head">
                <span class="iris-bk__mark iris-bk__mark--lg">
                  <Show when={k().logoUrl} fallback={<span>{k().brand.name.slice(0, 1).toUpperCase()}</span>}>
                    <img src={k().logoUrl} alt={`${k().brand.name} logo`} />
                  </Show>
                </span>
                <div>
                  <h3 class="iris-bk__title">{k().brand.name}</h3>
                  <p class="iris-bk__slug">{k().brand.slug}</p>
                  <Show when={k().brand.description}>
                    <p class="iris-bk__desc">{k().brand.description}</p>
                  </Show>
                </div>
              </header>

              {/* ── Colours ─────────────────────────────────────────── */}
              <section class="iris-bk__sec">
                <div class="iris-bk__sechead">
                  <h4>Colours <span class="iris-bk__count">{k().colors.length}</span></h4>
                  <SectionActions section="colors" editing={editing()} saving={saving()} onEdit={startEdit} onSave={save} onCancel={() => setEditing(undefined)} />
                </div>
                <Show when={k().colors.length === 0 && editing() !== "colors"}>
                  <p class="iris-bk__muted">No colours in this kit.</p>
                </Show>
                <Show
                  when={editing() === "colors"}
                  fallback={
                    <ul class="iris-bk__swatches">
                      <For each={k().colors}>
                        {(c) => (
                          <li class="iris-bk__swatch">
                            <span
                              class="iris-bk__fill"
                              style={{ background: DRAWABLE.test(c.value.trim()) ? c.value : "transparent" }}
                              classList={{ "iris-bk__fill--none": !DRAWABLE.test(c.value.trim()) }}
                            />
                            <span class="iris-bk__label">{c.name}</span>
                            <code class="iris-bk__value">{c.value}</code>
                          </li>
                        )}
                      </For>
                    </ul>
                  }
                >
                  <ul class="iris-bk__editlist">
                    <For each={draft.colors}>
                      {(c, i) => (
                        <li class="iris-bk__editrow">
                          <input
                            type="color"
                            aria-label={`${c.name} picker`}
                            value={HEX6.test(c.value.trim()) ? c.value.trim() : "#000000"}
                            onInput={(e) => setDraft("colors", i(), "value", e.currentTarget.value)}
                          />
                          <span class="iris-bk__label">{c.name}</span>
                          <input
                            class="iris-bk__text iris-bk__mono"
                            aria-label={`${c.name} value`}
                            value={c.value}
                            onInput={(e) => setDraft("colors", i(), "value", e.currentTarget.value)}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              {/* ── Type ────────────────────────────────────────────── */}
              <section class="iris-bk__sec">
                <div class="iris-bk__sechead">
                  <h4>Type <span class="iris-bk__count">{k().fonts.length}</span></h4>
                  <SectionActions section="typography" editing={editing()} saving={saving()} onEdit={startEdit} onSave={save} onCancel={() => setEditing(undefined)} />
                </div>
                <Show when={k().fonts.length === 0 && editing() !== "typography"}>
                  <p class="iris-bk__muted">No font stacks in this kit.</p>
                </Show>
                <Show
                  when={editing() === "typography"}
                  fallback={
                    <ul class="iris-bk__fonts">
                      <For each={k().fonts}>
                        {(f) => (
                          <li>
                            <span class="iris-bk__specimen" style={{ "font-family": f.family }}>
                              {k().brand.name} <span class="iris-bk__specimen-alt">Aa Gg 0123</span>
                            </span>
                            <span class="iris-bk__label">{f.role}</span>
                            <code class="iris-bk__value">{f.family}</code>
                          </li>
                        )}
                      </For>
                    </ul>
                  }
                >
                  <ul class="iris-bk__editlist">
                    <For each={draft.fonts}>
                      {(f, i) => (
                        <li class="iris-bk__editrow iris-bk__editrow--wide">
                          <span class="iris-bk__label">{f.role}</span>
                          <input
                            class="iris-bk__text iris-bk__mono"
                            aria-label={`${f.role} font stack`}
                            value={f.family}
                            onInput={(e) => setDraft("fonts", i(), "family", e.currentTarget.value)}
                          />
                          <span class="iris-bk__specimen iris-bk__specimen--sm" style={{ "font-family": f.family }}>Aa</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={k().typeScale.length > 0}>
                  <dl class="iris-bk__scale">
                    <For each={k().typeScale}>
                      {(t) => (
                        <>
                          <dt>{t.role}</dt>
                          <dd>{t.value}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>

              {/* ── Motion ──────────────────────────────────────────── */}
              <section class="iris-bk__sec">
                <div class="iris-bk__sechead">
                  <h4>Motion</h4>
                  <SectionActions section="motion" editing={editing()} saving={saving()} onEdit={startEdit} onSave={save} onCancel={() => setEditing(undefined)} />
                </div>
                <Show
                  when={editing() === "motion"}
                  fallback={
                    <Show when={k().motion} fallback={<p class="iris-bk__muted">No motion tokens — films use the default ease.</p>}>
                      <dl class="iris-bk__scale">
                        <Show when={k().motion!.character}><dt>character</dt><dd>{k().motion!.character}</dd></Show>
                        <Show when={k().motion!.ease}><dt>ease</dt><dd>{k().motion!.ease}</dd></Show>
                        <Show when={k().motion!.durationMs != null}><dt>duration</dt><dd>{k().motion!.durationMs} ms</dd></Show>
                      </dl>
                    </Show>
                  }
                >
                  <div class="iris-bk__editlist">
                    <label class="iris-bk__editrow iris-bk__editrow--wide">
                      <span class="iris-bk__label">ease</span>
                      <input class="iris-bk__text iris-bk__mono" value={draft.ease} placeholder="cubic-bezier(.45,0,.15,1)" onInput={(e) => setDraft("ease", e.currentTarget.value)} />
                    </label>
                    <label class="iris-bk__editrow iris-bk__editrow--wide">
                      <span class="iris-bk__label">duration ms</span>
                      <input class="iris-bk__text iris-bk__mono" inputmode="numeric" value={draft.durationMs} placeholder="800" onInput={(e) => setDraft("durationMs", e.currentTarget.value)} />
                    </label>
                  </div>
                </Show>
              </section>

              {/* ── Voice ───────────────────────────────────────────── */}
              <section class="iris-bk__sec">
                <div class="iris-bk__sechead"><h4>Voice <span class="iris-bk__count">{k().personas.length}</span></h4></div>
                <Show when={k().personas.length > 0} fallback={<p class="iris-bk__muted">No personas. Agents write in their own voice.</p>}>
                  <ul class="iris-bk__personas">
                    <For each={k().personas}>
                      {(p) => (
                        <li>
                          <span class="iris-bk__name">{p.name}</span>
                          <Show when={p.isDefault}><span class="iris-bk__tag">default</span></Show>
                          <Show when={p.tone}><span class="iris-bk__muted"> — {p.tone}</span></Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function SectionActions(props: {
  section: Section
  editing?: Section
  saving: boolean
  onEdit: (s: Section) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <Show
      when={props.editing === props.section}
      fallback={
        <button
          type="button"
          class="iris-card__linkbtn"
          disabled={props.editing != null}
          onClick={() => props.onEdit(props.section)}
        >
          Edit
        </button>
      }
    >
      <span class="iris-bk__actions">
        <button type="button" class="iris-card__linkbtn" disabled={props.saving} onClick={props.onCancel}>Cancel</button>
        <button type="button" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={props.saving} onClick={props.onSave}>
          {props.saving ? "Saving…" : "Save"}
        </button>
      </span>
    </Show>
  )
}
