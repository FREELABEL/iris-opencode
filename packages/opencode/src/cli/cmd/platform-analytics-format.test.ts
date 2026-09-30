import { describe, expect, test } from "bun:test"
import { formatPlatformAnalytics } from "./platform-analytics-format"

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
const render = (d: any) => formatPlatformAnalytics(d).map(strip).join("\n")

// Shape of GET /api/v6/telemetry/analytics as fl-iris-api UsageAnalytics::report returns it.
const report = {
  window: { days: 30, external_only: true },
  users: { dau: 4, wau: 5, mau: 15, active_in_window: 15, new_signups: 7, new_signups_error: null, by_platform: { cli: 12, desktop: 6, ai_usage: 12 } },
  activity: { app_open: { count: 18, by_platform: { desktop: 18 } }, run_end: { count: 5181, by_platform: { cli: 4946, mcp: 231 } } },
  tokens: {
    calls: 75721, input_tokens: 469604689, output_tokens: 2904181, total_tokens: 472508870, cost_usd: 60.68, users: 13,
    by_model: [{ key: "iris/mimo-v2.5-pro", calls: 624, tokens: 49744274, cost: 21.74, users: 3 }],
    by_source: [{ key: "iris_model_proxy", calls: 4416, tokens: 470745574, cost: 60.13, users: 13 }],
    top_users: [{ user_id: 7, email: "client@example.com", calls: 1618, tokens: 132933875, cost: 26.25 }, { user_id: 0, email: null, calls: 1, tokens: 1, cost: 0 }],
  },
  quality: { responses: { count: 2, errors: 1, error_rate: 0.5 }, tool_runs: { count: 0, errors: 0, error_rate: null }, commands: { count: 5181, errors: 39, error_rate: 0.0075 }, top_errors: { "upstream_error (proxy)": 837 } },
  top_tools: [{ tool: "callintegrationtool", count: 40, errors: 21, users: 1 }],
  top_commands: [{ command: "integrations", count: 3115, errors: 0, users: 6 }],
  daily: [{ date: "2026-09-30", active_users: 4, messages: 3, tokens: 1000, cost: 0.25 }],
}

describe("iris usage --platform (#187316)", () => {
  test("prints every section with the server's figures, unaltered", () => {
    const out = render(report)
    expect(out).toContain("last 30 day(s) · external accounts only")
    expect(out).toContain("DAU 4   WAU 5   MAU 15")
    expect(out).toContain("new signups 7")
    expect(out).toContain("desktop 6")
    expect(out).toContain("app_open")
    expect(out).toContain("5,181")
    expect(out).toContain("$60.68")
    expect(out).toContain("iris/mimo-v2.5-pro")
    expect(out).toContain("client@example.com")
    expect(out).toContain("#0")
    expect(out).toContain("50.0%")
    expect(out).toContain("0.8%")
    expect(out).toContain("upstream_error (proxy)")
    expect(out).toContain("callintegrationtool")
    expect(out).toContain("2026-09-30")
  })

  test("unknown signups say why; a missing figure is a dash, never 0", () => {
    const out = render({ ...report, users: { ...report.users, new_signups: null, new_signups_error: "QueryException: no created_at" }, quality: {} })
    expect(out).toContain("new signups unknown")
    expect(out).toContain("signups unknown: QueryException: no created_at")
    expect(out).toMatch(/model responses\s+—/)
  })

  test("no cell is cut through a colour code, and headers are whole", () => {
    // missing figures in the NARROW columns (users: 6 wide) — where a cut lands inside a colour code
    const raw = formatPlatformAnalytics({ ...report, quality: {}, top_tools: [{ tool: "bash" }], top_commands: [{ command: "leads" }] }).join("\n")
    // strip only COMPLETE escapes; anything left is a broken one
    expect(raw.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b")
    expect(render(report)).toContain("error rate")
  })

  test("an unreachable ledger is reported, not rendered as zero spend", () => {
    const out = render({ ...report, tokens: { error: "usage ledger unreachable: QueryException" } })
    expect(out).toContain("usage ledger unreachable")
    expect(out).not.toContain("$60.68")
  })
})
