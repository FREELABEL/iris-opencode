import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { connectsBy, healthRead, usageBars } from "./iris-catalog"
import { providerMark } from "./session-iris-tab"

/**
 * ONE CONNECTOR, drawn the way the registry draws it (#186542).
 *
 * The first cut rendered this record through the panel's generic key/value list, and it read
 * like a database row: a full-width green slab for uptime, a raw ISO timestamp, the basis
 * sentence stretched across a value cell, and the CLI line sitting above the description as
 * though typing it were the main event.
 *
 * This is the same data with the page's hierarchy — what it is, what connecting takes, whether
 * the provider is answering, how much it is used, what an agent gets — and the claims kept
 * intact: reachability is the PROVIDER's, absent is not down, and usage is a shape rather than
 * a volume.
 */

export interface IntegrationRow {
  type: string
  name: string
  category?: string
  description?: string
  mode?: string
  oauthRequired?: boolean
  functionsCount?: number
  logoUrl?: string
  command?: string
  health?: { state?: string; lastCheckedAt?: string; bars?: { from?: string; state: string }[] }
  usage?: { band?: string; series?: { day?: string; v: number }[] }
  functions?: { name: string; label?: string; share?: number; rank?: number }[]
}

/** "2h ago" beats an ISO string nobody reads. Never invents precision it does not have. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "unknown"
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Sep 17 — short enough to sit under a 5-day strip. */
export function dayLabel(iso: string | undefined): string {
  if (!iso) return ""
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function IrisIntegrationDetail(props: {
  row: IntegrationRow
  connect?: { state: "opening" | "waiting" | "failed" | "nothing"; message?: string }
  onConnect: () => void
}) {
  const health = () => healthRead(props.row.health?.state)
  const bars = () => props.row.health?.bars ?? []
  const measuredUptime = () => bars().some((b) => b.state && b.state !== "none")
  const usage = () => usageBars(props.row.usage?.series)
  const fns = () => props.row.functions ?? []

  return (
    <div class="iris-det">
      <header class="iris-det__head">
        <span class="iris-det__mark" data-logo={props.row.logoUrl ? undefined : undefined}>
          <Show when={props.row.logoUrl}>
            <img
              class="iris-det__logo"
              src={props.row.logoUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              onLoad={(e) => e.currentTarget.parentElement?.setAttribute("data-logo", "1")}
              onError={(e) => {
                e.currentTarget.parentElement?.removeAttribute("data-logo")
                e.currentTarget.remove()
              }}
            />
          </Show>
          <span class="iris-det__fallback">{providerMark(props.row.type, props.row.name)}</span>
        </span>
        <span class="min-w-0">
          <h3 class="iris-det__title">{props.row.name}</h3>
          <p class="iris-det__slug">{props.row.type}</p>
        </span>
      </header>

      <Show when={props.row.description}>
        <p class="iris-det__lede">{props.row.description}</p>
      </Show>

      {/* CONNECT is the action this view exists for, so it sits above the evidence. */}
      <div class="iris-det__cta">
        <Button size="small" variant="primary" disabled={props.connect?.state === "opening"} onClick={() => props.onConnect()}>
          {props.connect?.state === "opening" ? "Opening…" : `Connect ${props.row.name}`}
        </Button>
        <span class="iris-det__by">{connectsBy(props.row.mode, Boolean(props.row.oauthRequired))}</span>
      </div>
      <Show when={props.connect?.message}>
        <p class="iris-det__note" data-tone={props.connect?.state === "failed" ? "bad" : undefined}>
          {props.connect!.message}
        </p>
      </Show>

      <section class="iris-det__sec">
        <h4 class="iris-det__h">Provider status</h4>
        <Show
          when={measuredUptime()}
          fallback={<p class="iris-det__note">{health().basis}</p>}
        >
          <div class="iris-det__bars">
            <For each={bars()}>
              {(b) => <i data-state={b.state} title={`${dayLabel(b.from)} — ${b.state === "none" ? "not checked" : b.state}`} />}
            </For>
          </div>
          <div class="iris-det__days">
            <For each={bars()}>{(b) => <span>{dayLabel(b.from)}</span>}</For>
          </div>
        </Show>
        <p class="iris-det__verdict">
          <i class="iris-det__dot" data-tone={health().tone} />
          {health().label}
          <span class="iris-det__when">last checked {ago(props.row.health?.lastCheckedAt)}</span>
        </p>
        <Show when={measuredUptime()}>
          <p class="iris-det__note">{health().basis}</p>
        </Show>
      </section>

      <div class="iris-det__cards">
        <div class="iris-det__card">
          <h5>Commands</h5>
          <p class="iris-det__big">{props.row.functionsCount ?? fns().length}</p>
          <p>callable by an agent</p>
        </div>
        <div class="iris-det__card">
          <h5>Connects by</h5>
          <p>{connectsBy(props.row.mode, Boolean(props.row.oauthRequired))}</p>
        </div>
        <div class="iris-det__card">
          <h5>Category</h5>
          <p>{props.row.category ?? "—"}</p>
        </div>
      </div>

      <section class="iris-det__sec">
        <h4 class="iris-det__h">How much it is used</h4>
        <Show
          when={usage().measured}
          fallback={
            <p class="iris-det__note">
              No calls recorded yet. Counting started recently, so this means we have not measured it — not that nobody
              uses it.
            </p>
          }
        >
          <div class="iris-det__use">
            <For each={usage().heights}>{(h) => <i style={{ height: `${h}%` }} data-zero={h <= 4 ? "1" : undefined} />}</For>
          </div>
          <p class="iris-det__useline">
            <span class="iris-det__band">{props.row.usage?.band}</span>
            <span class="iris-det__when">relative to its own busiest day · across everyone, 30 days</span>
          </p>
        </Show>
      </section>

      <Show when={fns().length}>
        <section class="iris-det__sec">
          <h4 class="iris-det__h">What an agent can call</h4>
          <ul class="iris-det__fns">
            <For each={fns()}>
              {(f) => (
                <li>
                  <span class="iris-det__fnbar" data-none={f.share === undefined ? "1" : undefined}>
                    <span style={{ width: `${Math.max(Math.round((f.share ?? 0) * 100), f.share ? 6 : 0)}%` }} />
                  </span>
                  <span class="iris-det__fnname" data-top={f.rank === 1 ? "1" : undefined}>
                    {f.label || f.name}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      {/* The CLI line still exists for people who want it — as a footnote, not the headline. */}
      <Show when={props.row.command}>
        <p class="iris-det__cli">
          or from a terminal: <code>{props.row.command}</code>
        </p>
      </Show>
    </div>
  )
}
