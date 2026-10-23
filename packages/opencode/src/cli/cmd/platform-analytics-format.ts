import { bold, dim } from "./iris-api"

/**
 * `iris usage --platform` — the whole platform, not one account (#187316).
 *
 * Renders GET /api/v6/telemetry/analytics (fl-iris-api UsageAnalytics::report, the same report
 * as `php artisan analytics:usage`). Pure: data in, lines out, so it is tested without a network.
 * Every figure is printed as the server gave it — nothing here is summed, estimated or rounded
 * beyond display, so this view and the artisan command can never disagree.
 */

// Plain "—", never dim("—"): cells are cut to width, and cutting through a colour code leaves
// a broken escape on screen (found rendering the real production report, not by the tests).
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—")
const usd = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : "—")
const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—")
const cell = (s: unknown, w: number) => String(s ?? "—").slice(0, w - 1).padEnd(w)

function table(headers: string[], widths: number[], rows: unknown[][]): string[] {
  const out = ["  " + headers.map((h, i) => dim(cell(h, widths[i]))).join("")]
  for (const r of rows) out.push("  " + r.map((c, i) => cell(c, widths[i])).join(""))
  return out
}

export function formatPlatformAnalytics(d: any): string[] {
  const out: string[] = []
  const w = d?.window ?? {}
  const u = d?.users ?? {}
  const t = d?.tokens ?? {}
  const q = d?.quality ?? {}

  out.push("")
  out.push(bold(`  IRIS platform usage · last ${w.days ?? "?"} day(s)${w.external_only ? " · external accounts only" : ""}`))
  out.push("")

  out.push(bold("  Users"))
  out.push(`  DAU ${bold(n(u.dau))}   WAU ${bold(n(u.wau))}   MAU ${bold(n(u.mau))}   active in window ${n(u.active_in_window)}   new signups ${u.new_signups === null || u.new_signups === undefined ? dim("unknown") : n(u.new_signups)}`)
  if (u.new_signups_error) out.push(dim(`  signups unknown: ${u.new_signups_error}`))
  const platforms = Object.entries(u.by_platform ?? {})
  if (platforms.length) out.push(dim("  by platform: ") + platforms.map(([k, v]) => `${k} ${n(v)}`).join(" · "))
  out.push("")

  const activity = Object.entries(d?.activity ?? {}) as [string, any][]
  if (activity.length) {
    out.push(bold("  Activity"))
    out.push(
      ...table(
        ["event", "count", "by platform"],
        [20, 12, 40],
        activity.map(([k, a]) => [k, n(a.count), Object.entries(a.by_platform ?? {}).map(([p, c]) => `${p} ${c}`).join(" · ")]),
      ),
    )
    out.push("")
  }

  out.push(bold("  Tokens & cost"))
  if (t.error) {
    out.push(`  ${t.error}`)
  } else {
    out.push(`  ${n(t.calls)} calls · ${n(t.input_tokens)} in · ${n(t.output_tokens)} out · ${bold(usd(t.cost_usd))} · ${n(t.users)} users`)
    const slice = (title: string, rows: any[]) => {
      if (!rows?.length) return
      out.push(...table([title, "calls", "tokens", "cost", "users"], [30, 10, 16, 10, 6], rows.map((r) => [r.key, n(r.calls), n(r.tokens), usd(r.cost), n(r.users)])))
    }
    slice("model", t.by_model)
    slice("source", t.by_source)
    if (t.top_users?.length) {
      out.push(...table(["user", "calls", "tokens", "cost"], [40, 10, 16, 10], t.top_users.map((r: any) => [r.email ?? `#${r.user_id}`, n(r.calls), n(r.tokens), usd(r.cost)])))
    }
  }
  out.push("")

  out.push(bold("  Quality"))
  const qrow = (label: string, r: any) => [label, n(r?.count), n(r?.errors), pct(r?.error_rate)]
  out.push(...table(["", "count", "errors", "error rate"], [18, 10, 10, 12], [qrow("model responses", q.responses), qrow("tool runs", q.tool_runs), qrow("CLI commands", q.commands)]))
  const errs = Object.entries(q.top_errors ?? {})
  if (errs.length) out.push(...table(["error", "count"], [56, 8], errs.map(([k, v]) => [k, n(v)])))
  out.push("")

  if (d?.top_tools?.length) {
    out.push(bold("  Top tools"))
    out.push(...table(["tool", "runs", "errors", "users"], [30, 8, 8, 6], d.top_tools.map((r: any) => [r.tool, n(r.count), n(r.errors), n(r.users)])))
    out.push("")
  }
  if (d?.top_commands?.length) {
    out.push(bold("  Top CLI commands"))
    out.push(...table(["command", "runs", "errors", "users"], [30, 8, 8, 6], d.top_commands.map((r: any) => [r.command, n(r.count), n(r.errors), n(r.users)])))
    out.push("")
  }
  if (d?.daily?.length) {
    out.push(bold("  Daily"))
    out.push(...table(["date", "active", "messages", "tokens", "cost"], [12, 8, 10, 16, 10], d.daily.map((r: any) => [r.date, n(r.active_users), n(r.messages), n(r.tokens), usd(r.cost)])))
    out.push("")
  }
  return out
}
