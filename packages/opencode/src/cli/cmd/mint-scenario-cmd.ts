import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, dim, bold, writeJson } from "./iris-api"
import { rollup, scoreScenario, type ScenarioLine, type ActualLine } from "./mint-scenarios"

// Lives in its own file rather than inside platform-mint.ts, which is mid-refactor into
// mint-core.ts. Registration is a single line there so the two do not collide.

const SCENARIOS = "mint-scenarios"
const LINES = "mint-scenario-lines"

const usd = (n: number | null): string =>
  n === null ? dim("—") : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
const pct = (n: number | null): string => (n === null ? dim("unmeasured") : `${(n * 100).toFixed(1)}%`)

/**
 * Atlas records come back paginated at `data.records.data`, with each row's actual fields
 * nested under `r.data` and the dedup key alongside at `r.external_id`. Flattened here so
 * callers work with plain field objects.
 *
 * Pagination is `per_page`, NOT `limit` — an unrecognised param is ignored rather than
 * rejected, so getting it wrong silently caps the result set at the default page instead of
 * erroring. Filters must be sent as `filter[key]=value`.
 */
async function rows(slug: string, filters: Record<string, string> = {}): Promise<any[]> {
  const p = new URLSearchParams({ per_page: "500" })
  for (const [k, v] of Object.entries(filters)) p.set(`filter[${k}]`, v)
  const res = await irisFetch(`/api/v1/atlas/datasets/${slug}?${p}`)
  if (!res.ok) return []
  const body = (await res.json().catch(() => null)) as any
  const recs: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
  return recs.map((r) => ({ ...(r?.data ?? {}), external_id: r?.external_id, _id: r?.id }))
}

/**
 * A line's margin is only a number if someone MEASURED it. `margin_measured: false` maps to
 * null, not to the stored figure, so an assigned-by-workload-class guess cannot quietly
 * become a blended percentage downstream. This is the storage-side half of the same rule the
 * arithmetic enforces.
 */
function toScenarioLines(raw: any[]): ScenarioLine[] {
  return raw.map((r) => ({
    label: String(r.label ?? ""),
    unit_price: Number(r.unit_price ?? 0),
    units: Number(r.units ?? 0),
    margin_pct: r.margin_measured === false || r.margin_pct == null ? null : Number(r.margin_pct),
  }))
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list scenarios",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty(); prompts.intro("◈  Mint Scenarios")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const all = await rows(SCENARIOS)
    if (args.json) { await writeJson(all); prompts.outro("Done"); return }
    if (!all.length) {
      prompts.log.warn("No scenarios yet. Create one with: iris mint scenario new <name>")
      prompts.outro("Done"); return
    }
    for (const s of all) {
      const lines = await rows(LINES, { scenario: String(s.name) })
      const r = rollup(toScenarioLines(lines))
      prompts.log.info(
        `${bold(String(s.name))}  ${dim(String(s.scope ?? "—"))}  ${lines.length} lines  ` +
          `${usd(r.monthly)}/mo  margin ${pct(r.blended_margin_pct)}`,
      )
    }
    prompts.outro("Done")
  },
})

const ShowCommand = cmd({
  command: "show <name>",
  describe: "show one scenario's lines and totals",
  builder: (y) => y.positional("name", { type: "string" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty(); prompts.intro(`◈  Scenario — ${args.name}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const raw = await rows(LINES, { scenario: String(args.name) })
    const r = rollup(toScenarioLines(raw))
    if (args.json) { await writeJson(r); prompts.outro("Done"); return }
    if (!r.lines.length) { prompts.log.warn("No lines on this scenario."); prompts.outro("Done"); return }

    for (const l of r.lines) {
      prompts.log.info(
        `${String(l.label).padEnd(28)} ${String(l.units).padStart(6)} x ${usd(l.unit_price).padStart(10)}  ` +
          `= ${usd(l.monthly).padStart(12)}  margin ${pct(l.margin_pct)}`,
      )
    }
    prompts.log.step(
      `${bold("TOTAL")}  ${r.units} units  ${bold(usd(r.monthly))}/mo  blended margin ${bold(pct(r.blended_margin_pct))}`,
    )
    // Never print a blend over guessed inputs. Say which lines are responsible instead —
    // the number is missing for a reason the reader can act on.
    if (r.unmeasured_lines.length) {
      prompts.log.warn(
        `Blended margin withheld: ${r.unmeasured_lines.length} line(s) have an UNMEASURED margin ` +
          `(${r.unmeasured_lines.join(", ")}). Revenue above is real; the margin is not known. ` +
          `Measure cost per line before treating any margin figure as a decision input.`,
      )
    }
    prompts.outro("Done")
  },
})

const ScoreCommand = cmd({
  command: "score <name>",
  describe: "compare a scenario's lines against actual booked revenue",
  builder: (y) =>
    y
      .positional("name", { type: "string" })
      .option("actuals", { type: "string", describe: "JSON file of [{label, monthly}] — omit to read the ledger" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty(); prompts.intro(`◈  Scenario score — ${args.name}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const planned = toScenarioLines(await rows(LINES, { scenario: String(args.name) }))
    let actual: ActualLine[] = []
    if (args.actuals) {
      const fs = await import("fs")
      actual = JSON.parse(fs.readFileSync(String(args.actuals), "utf-8"))
    }

    const s = scoreScenario(planned, actual)
    if (args.json) { await writeJson(s); prompts.outro("Done"); return }

    for (const l of s.lines) {
      const v = l.variance === null ? dim("no actuals recorded") : `${l.variance >= 0 ? "+" : ""}${usd(l.variance)}`
      prompts.log.info(`${String(l.label).padEnd(28)} planned ${usd(l.planned).padStart(12)}  actual ${(l.actual === null ? dim("—") : usd(l.actual)).padStart(12)}  ${v}`)
    }
    prompts.log.step(
      `Scored ${s.lines.length - s.totals.lines_without_actuals}/${s.lines.length} lines · ` +
        `planned ${usd(s.totals.planned_scored)} vs actual ${usd(s.totals.actual)} · variance ${usd(s.totals.variance)}`,
    )
    // Totals compare only the lines that HAVE actuals. Summing unscored lines as zero would
    // read as "we missed the target" when the truth is "we did not measure it".
    if (s.totals.lines_without_actuals > 0) {
      prompts.log.warn(
        `${s.totals.lines_without_actuals} line(s) have NO recorded actuals and are excluded from the totals. ` +
          `They are unknown, not zero — the variance above covers only what was measured.`,
      )
    }
    if (s.unmatched_actual.length) {
      prompts.log.warn(`Actual revenue with no scenario line: ${s.unmatched_actual.join(", ")} — the model is missing a line.`)
    }
    prompts.outro("Done")
  },
})

export const ScenarioCommand = cmd({
  command: "scenario",
  aliases: ["scenarios", "sim"],
  describe: "financial scenarios — model a distribution, then score it against actuals",
  builder: (y) => y.command(ListCommand).command(ShowCommand).command(ScoreCommand).demandCommand(),
  async handler() {},
})
