import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, IRIS_API, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

// ============================================================================
// Dashboard Rules — the Atlas rule surface, one command for all of them
//
// Routes: /api/v1/dashboard/{slug}/rules[/{rule}]
//
// WHY ONE COMMAND. There are 44 rules behind the dashboards (case stats, AR/AP aging, stage
// breakdown, denial risk, SOL alerts…). Exposing one to an agent used to mean ~100 lines of
// boilerplate in three files — a system-tools.yaml entry, a V6ToolRegistry registration, and an
// executeGetX() that mostly reshaped the same payload. It drifted to 8 of 44, and nobody noticed,
// because a rule that is merely absent produces no error.
//
// This is the generic version. The server holds a manifest; the CLI just lists it and fetches from
// it. Adding rule 45 needs no change here at all.
//
// AND IT REACHES CLAUDE FOR FREE. The IRIS OS MCP connector exposes iris_run, which executes any
// IRIS CLI command as the signed-in user, and iris_help answers from the generated capability
// index. So a new CLI command shows up in Claude with no MCP work — the same reason iris_help was
// rewired to the generated index rather than kept as a hand-typed catalog.
//
// Scope, entitlement, PHI exposure and audit are ALL decided server-side. This command cannot
// widen them, and deliberately offers no flag that looks like it could.
// ============================================================================

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

// These routes live in IRIS-API, not fl-api. irisFetch() defaults to FL_API, so omitting the base
// silently sends every request to the wrong service and returns 404 — which reads exactly like
// "the route is not deployed yet". Caught by running the command against a stub rather than by
// reading it.


/**
 * Flatten a rule's `summary` into label/value pairs for display.
 *
 * The 44 rules do NOT agree on a shape, and assuming one produced `[object Object]` against real
 * production data on the first live run:
 *
 *   stats        summary: [{ label: "Active Cases", value: 2143, icon, color }, …]   // array
 *   ar-ap-aging  summary: { current: "$12,000", "30d": "$4,500" }                    // flat map
 *
 * Object.entries() on the array form yields index -> object, which stringifies to "[object
 * Object]" — a class of bug this repo already carries regression tests for (#55730). Handle both,
 * and never print a raw object: if a value is not a scalar, say so in a way that points at
 * --json rather than rendering noise.
 */
export function summaryPairs(summary: unknown): Array<[string, string]> {
  if (!summary || typeof summary !== "object") return []

  const scalar = (v: unknown): string => {
    if (v === null || v === undefined) return "—"
    if (typeof v === "object") return "(nested — use --json)"
    return String(v)
  }

  if (Array.isArray(summary)) {
    return summary
      .filter((t) => t && typeof t === "object")
      .map((t: any) => [String(t.label ?? t.title ?? t.key ?? "—"), scalar(t.value ?? t.amount ?? t.count)])
  }

  return Object.entries(summary as Record<string, unknown>).map(([k, v]) => [k, scalar(v)])
}


/**
 * Turn ONE panel into display lines, whatever shape it happens to be.
 *
 * The 44 rules do not share a schema, and assuming they did produced two visible failures against
 * real production data within a minute of deploying:
 *
 *   stats            { summary: [{label,value}, …] }              // array of tiles
 *   ar-ap-aging      { summary: { current: "$12,000", … } }       // flat map
 *   team             { name, role, subtitle, status }             // a person
 *   economics        { title, totalLabel, totalValue, lineItems } // a total + rows
 *   chart-data       { title, chartType, categories, series }     // a chart
 *   provider-ledger  { provider, cases, billed, collected, … }    // a table row
 *
 * Special-casing 44 shapes would put the manifest's job in the CLI and rot immediately. Instead:
 * print every SCALAR the panel carries, count every array, and always say --json has the rest.
 * A generic renderer that under-promises beats a specific one that silently shows nothing — which
 * is what the first version did for 5 of the 11 exposed rules.
 */
const NOISE = new Set(["icon", "color", "chartType", "type", "id", "slug"])

export function panelLines(panel: unknown, headingKey?: string): string[] {
  if (!panel || typeof panel !== "object") return []
  const p = panel as Record<string, unknown>
  const out: string[] = []

  // A rule's own summary block, when it has one, is the curated view — prefer it.
  const pairs = summaryPairs(p.summary)
  for (const [k, v] of pairs) out.push(`${k.padEnd(22)} ${v}`)

  for (const [k, v] of Object.entries(p)) {
    if (k === "summary" || NOISE.has(k)) continue
    if (k === "title" || k === "subtitle" || k === headingKey) continue // already the heading
    if (Array.isArray(v)) {
      out.push(`${k.padEnd(22)} ${v.length} row(s) — use --json`)
    } else if (v !== null && typeof v === "object") {
      out.push(`${k.padEnd(22)} (nested — use --json)`)
    } else if (v !== null && v !== undefined && String(v) !== "") {
      out.push(`${k.padEnd(22)} ${String(v)}`)
    }
  }

  return out
}

const DEFAULT_SLUG = "pathways-dashboard"

const RulesListCommand = cmd({
  command: "rules [slug]",
  aliases: ["ls", "list"],
  describe: "list the dashboard rules you can ask for",
  builder: (y) =>
    y
      .positional("slug", { type: "string", default: DEFAULT_SLUG, describe: "dashboard slug" })
      .option("all", { type: "boolean", default: false, describe: "include rules that exist but are not exposed" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Dashboard Rules")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const slug = String(args.slug || DEFAULT_SLUG)
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/dashboard/${encodeURIComponent(slug)}/rules${args.all ? "?all=1" : ""}`, {}, IRIS_API)
      const ok = await handleApiError(res, "List dashboard rules")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const body = (await res.json()) as any
      const rules: any[] = firstArray(body?.rules)
      spinner.stop(`${rules.length} available`)

      if (args.json) { await writeJson(body); prompts.outro("Done"); return }

      printDivider()
      if (!rules.length) {
        console.log(dim("  No rules available to you on this dashboard."))
      }
      for (const r of rules) {
        console.log(`  ${bold(String(r.rule))}  ${dim(String(r.title ?? ""))}`)
        if (r.answers) console.log(`      ${String(r.answers)}`)
        if (Array.isArray(r.filters) && r.filters.length) {
          console.log(`      ${dim("filters:")} ${r.filters.join(", ")}`)
        }
      }

      // The closed rules, when asked for. "That exists but is not cleared for this surface" is an
      // answer somebody can act on; silence sends them hunting for a typo.
      const catalogue: any[] = firstArray(body?.catalogue)
      if (args.all && catalogue.length) {
        printDivider()
        console.log(bold("  Declared but NOT exposed:"))
        for (const c of catalogue.filter((c) => !c.exposed)) {
          console.log(`  ${dim("·")} ${String(c.rule).padEnd(28)} ${c.phi ? highlight("patient-identifiable") : dim("not enabled")}`)
        }
      }

      printDivider()
      console.log(dim(`  iris dashboard get ${slug} <rule> --json`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    prompts.outro("Done")
  },
})

const RuleGetCommand = cmd({
  command: "get <slug> <rule>",
  describe: "run one dashboard rule and print the result",
  builder: (y) =>
    y
      .positional("slug", { type: "string", describe: "dashboard slug" })
      .positional("rule", { type: "string", describe: "rule name (see: iris dashboard rules)" })
      // Filters are declared PER RULE on the server and anything undeclared is dropped there.
      // Passing them as repeatable k=v keeps this command generic — a flag per filter would put
      // the allow-list in two places, which is how the two drift apart.
      .option("filter", { type: "array", string: true, default: [], describe: "filter as key=value (repeatable)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Dashboard Rule")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const slug = String(args.slug)
    const rule = String(args.rule)

    const p = new URLSearchParams()
    for (const f of (args.filter as string[]) ?? []) {
      const i = String(f).indexOf("=")
      if (i > 0) p.set(String(f).slice(0, i), String(f).slice(i + 1))
    }

    const spinner = prompts.spinner()
    spinner.start(`${rule}…`)
    try {
      const qs = p.toString()
      const res = await irisFetch(`/api/v1/dashboard/${encodeURIComponent(slug)}/rules/${encodeURIComponent(rule)}${qs ? "?" + qs : ""}`, {}, IRIS_API)
      const body = (await res.json().catch(() => ({}))) as any

      if (!res.ok || !body?.success) {
        // Surface the server's reason verbatim. It distinguishes "no such rule" from "exists but
        // is not cleared for this surface" from "you are not on this dashboard", and collapsing
        // those into a generic failure is how people end up debugging the wrong thing.
        spinner.stop(String(body?.code ?? `HTTP ${res.status}`), 1)
        console.log(`  ${highlight(String(body?.error ?? "Request failed"))}`)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      spinner.stop(success("ok"))
      if (args.json) { await writeJson(body); prompts.outro("Done"); return }

      printDivider()
      for (const panel of (body.data ?? []) as any[]) {
        // Whichever field names this panel becomes the heading and is not repeated below.
        const headingKey = ["title", "name", "provider", "label"].find((k) => panel?.[k])
        if (headingKey) console.log(`  ${bold(String(panel[headingKey]))}`)
        if (panel?.subtitle) console.log(`  ${dim(String(panel.subtitle))}`)
        for (const line of panelLines(panel, headingKey)) console.log(`      ${line}`)
        console.log()
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    prompts.outro("Done")
  },
})


// Exported as SUBCOMMANDS, not as a top-level command. `iris dashboard` already exists — it
// scaffolds and manages client dashboards — and these hang off it as `iris dashboard rules` and
// `iris dashboard get`. Writing a second top-level `dashboard` would have silently shadowed a
// 493-line feature.
export const DashboardRulesListCommand = RulesListCommand
export const DashboardRuleGetCommand = RuleGetCommand
