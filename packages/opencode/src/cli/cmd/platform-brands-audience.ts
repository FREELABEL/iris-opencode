import { cmd } from "./cmd"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"
import { readFileSync, existsSync } from "fs"
import {
  AUDIENCE_SCHEMA,
  SEGMENT_GROUPS,
  audienceSummary,
  audienceTemplateYaml,
  cleanAudienceInput,
  normalizeAudience,
  validateAudience,
  type AudienceValidation,
} from "./brand-audience"

// ============================================================================
// brands audience <subcommand> — who the brand sells to (audience.v1, #194612)
//
// Stored at brands.metadata.audience. fl-api's PATCH /api/v1/brands/{id} REPLACES `metadata`
// whole (BrandController::update → $brand->update), and metadata also holds design_tokens, the
// transcription glossary and transcript treatments. So `set` reads the brand, swaps only
// `audience` into the metadata it read, writes that, and reads back to check nothing else moved.
//
// The definition (types, enums, validator, template) is ./brand-audience.ts — the same file, byte
// for byte, as the Desktop's and the engine's on iris/1.18.23.
// ============================================================================

/** JSON with sorted keys, so two readings of the same audience compare equal whatever order the platform returns. */
export function stableJson(v: unknown, indent?: number): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x
  return JSON.stringify(sort(v ?? null), null, indent)
}

/** A file → the audience it holds. JSON by extension or by its first character; YAML otherwise. */
export function parseAudienceFile(path: string, text: string): unknown {
  const t = text.trim()
  if (/\.json$/i.test(path) || t.startsWith("{")) return JSON.parse(t)
  const yaml = (globalThis as any).Bun?.YAML
  if (!yaml) throw new Error("YAML needs the iris CLI's runtime; pass a .json file instead")
  return yaml.parse(text)
}

/** A plain line diff (LCS) of two texts: "  same", "- gone", "+ new". Audiences are small. */
export function lineDiff(a: string, b: string): string[] {
  const x = a.split("\n")
  const y = b.split("\n")
  const n = x.length
  const m = y.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push(`  ${x[i]}`), i++, j++)
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push(`- ${x[i++]}`)
    else out.push(`+ ${y[j++]}`)
  }
  while (i < n) out.push(`- ${x[i++]}`)
  while (j < m) out.push(`+ ${y[j++]}`)
  return out
}

/** A readable audience: each segment with its filled groups, then the brand-level parts. */
export function renderAudience(audience: unknown): string[] {
  const a = normalizeAudience(audience)
  const out: string[] = []
  const val = (v: unknown): string =>
    Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(" · ") : String(v)
  const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && !Object.values(v as object).some(Boolean))
  const lines = audienceSummary(a)
  a.segments.forEach((s, i) => {
    out.push(bold(s.name || "(unnamed segment)") + dim(`  ${[s.id && `#${s.id}`, s.priority, s.market, s.evidence?.confidence].filter(Boolean).join(" · ")}`))
    out.push(`  ${dim(lines[i]!.replace(/^[^:]*: ?/, "") || "(no details yet)")}`)
    for (const g of SEGMENT_GROUPS) {
      if (g.shape === "flat") continue
      const v = (s as any)[g.key]
      if (g.key === "jobs") {
        for (const j of (v ?? []) as any[]) out.push(`  ${dim("job")}  When ${j.when ?? "…"}, they want to ${j.want_to ?? "…"}, so they can ${j.so_they_can ?? "…"}.${j.today_they_use ? ` Today: ${j.today_they_use}.` : ""}`)
        continue
      }
      if (g.key === "personas") {
        for (const p of (v ?? []) as any[]) out.push(`  ${dim("persona")}  ${bold(p.name ?? "?")}${p.age ? `, ${p.age}` : ""}${p.role ? ` — ${p.role}` : ""}${p.quote ? `  "${p.quote}"` : ""}`)
        continue
      }
      const facts = g.fields.filter((f) => filled(v?.[f.key])).map((f) => `${f.key}: ${val(v[f.key])}`)
      if (facts.length) out.push(`  ${dim(g.key.padEnd(15))} ${facts.join("  ·  ")}`)
    }
    out.push("")
  })
  for (const u of a.use_cases ?? []) out.push(`${dim("use case")}  ${bold(u.name ?? "?")}${u.for_segments?.length ? dim(` for ${u.for_segments.join(", ")}`) : ""}${u.problem ? ` — ${u.problem}` : ""}`)
  for (const x of a.not_for ?? []) out.push(`${dim("not for")}   ${x.who}${x.why ? dim(` — ${x.why}`) : ""}`)
  const p = a.positioning ?? {}
  if (p.statement || p.category || p.alternatives?.length)
    out.push(`${dim("position")}  ${p.statement ?? ""}${p.category ? dim(` [${p.category}]`) : ""}${p.alternatives?.length ? dim(` · instead: ${p.alternatives.join(", ")}`) : ""}`)
  return out
}

function printIssues(v: AudienceValidation) {
  for (const e of v.errors) console.error(`  ✗ ${e.path || "(top)"}  ${e.message}`)
  for (const w of v.warnings) console.error(`  ! ${w.path}  ${w.message}`)
}

/** `41` or `northwind-studio` → the brand's id. */
async function brandIdOf(ref: string): Promise<number | null> {
  if (/^\d+$/.test(ref)) return Number(ref)
  const res = await irisFetch(`/api/v1/brands?slug=${encodeURIComponent(ref)}&per_page=1`)
  if (!res.ok) return null
  const body = (await res.json()) as any
  const brands: any[] = firstArray(body?.data?.data, body?.data)
  const hit = brands.find((b) => b?.slug === ref) ?? brands[0]
  return hit ? Number(hit.id) : null
}

async function readBrand(ref: string): Promise<{ ok: true; brand: any } | { ok: false; error: string }> {
  const id = await brandIdOf(ref)
  if (!id) return { ok: false, error: `no brand "${ref}" on your account` }
  const res = await irisFetch(`/api/v1/brands/${id}`)
  if (!res.ok) return { ok: false, error: res.status === 404 ? `no brand #${id} on your account` : `HTTP ${res.status}` }
  const brand = ((await res.json()) as any)?.data
  return brand ? { ok: true, brand } : { ok: false, error: "the platform returned no brand" }
}

function readFile(file: string): { ok: true; audience: unknown; validation: AudienceValidation } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: false, error: `no file at ${file}` }
  let raw: unknown
  try {
    raw = parseAudienceFile(file, readFileSync(file, "utf8"))
  } catch (e) {
    return { ok: false, error: `${file} is not valid JSON or YAML: ${e instanceof Error ? e.message : String(e)}` }
  }
  const audience = cleanAudienceInput(raw)
  return { ok: true, audience, validation: validateAudience(audience) }
}

const metadataOf = (b: any): Record<string, unknown> => (b?.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata) ? b.metadata : {})

const AudienceShowCommand = cmd({
  command: "show <brand>",
  aliases: ["get"],
  describe: "show who a brand sells to: segments, use cases, not-for, positioning",
  builder: (yargs) =>
    yargs
      .positional("brand", { describe: "brand id or slug", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = args.json as boolean
    if (!json) UI.empty()
    const token = await requireAuth(); if (!token) { process.exitCode = 1; return }
    const r = await readBrand(String(args.brand))
    if (!r.ok) {
      process.exitCode = 1
      if (json) return writeJson({ success: false, error: r.error })
      return console.error(r.error)
    }
    const audience = metadataOf(r.brand).audience
    const v = audience == null ? { ok: true, errors: [], warnings: [] } : validateAudience(audience)
    if (json)
      return writeJson({
        success: true,
        brand: { id: r.brand.id, slug: r.brand.slug, name: r.brand.name },
        audience: audience ?? null,
        summary: audience == null ? [] : audienceSummary(audience),
        errors: v.errors,
        warnings: v.warnings,
      })
    console.log(`${bold(String(r.brand.name))}  ${dim(`#${r.brand.id} · audience`)}`)
    printDivider()
    if (audience == null) {
      console.log(`  ${dim("No audience yet.")}`)
      console.log(`  ${dim(`Start one: iris brands audience template > audience.yaml, fill it in, then iris brands audience set ${r.brand.slug ?? r.brand.id} --file audience.yaml`)}`)
      return
    }
    for (const line of renderAudience(audience)) console.log(line)
    if (!v.ok || v.warnings.length) {
      console.log()
      console.log(dim("The stored audience does not fully match audience.v1:"))
      printIssues(v)
    }
  },
})

const AudienceSetCommand = cmd({
  command: "set <brand>",
  describe: "replace a brand's audience from a JSON or YAML file (checked first; only metadata.audience changes)",
  builder: (yargs) =>
    yargs
      .positional("brand", { describe: "brand id or slug", type: "string", demandOption: true })
      .option("file", { describe: "audience.v1 as .json, .yaml or .yml", type: "string", demandOption: true })
      .option("dry-run", { describe: "show what would change, write nothing", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = args.json as boolean
    const fail = async (error: string, extra: Record<string, unknown> = {}) => {
      process.exitCode = 1
      if (json) return writeJson({ success: false, error, ...extra })
      console.error(error)
    }
    const f = readFile(String(args.file))
    if (!f.ok) return fail(f.error)
    if (!f.validation.ok) {
      if (!json) {
        console.error(`${args.file} is not a valid ${AUDIENCE_SCHEMA} — nothing was sent:`)
        printIssues(f.validation)
        process.exitCode = 1
        return
      }
      return fail("not a valid audience.v1 — nothing was sent", { errors: f.validation.errors, warnings: f.validation.warnings })
    }
    const token = await requireAuth(); if (!token) { process.exitCode = 1; return }
    const r = await readBrand(String(args.brand))
    if (!r.ok) return fail(r.error)
    const metadata = metadataOf(r.brand)
    const before = stableJson(metadata.audience ?? null, 2)
    const after = stableJson(f.audience, 2)
    const kept = Object.keys(metadata).filter((k) => k !== "audience")
    if (before === after) {
      if (json) return writeJson({ success: true, changed: false, brand: r.brand.id })
      return console.log(dim(`${r.brand.name}'s audience already matches ${args.file} — nothing to change.`))
    }
    if (args["dry-run"]) {
      const diff = lineDiff(before, after)
      if (json) return writeJson({ success: true, dryRun: true, brand: r.brand.id, kept, diff, warnings: f.validation.warnings })
      console.log(`${bold(String(r.brand.name))}  ${dim(`#${r.brand.id} · metadata.audience · dry run, nothing written`)}`)
      printDivider()
      for (const l of diff) if (!l.startsWith("  ")) console.log(l)
      printDivider()
      console.log(dim(`Kept as they are: ${kept.length ? kept.join(", ") : "(no other metadata)"}`))
      if (f.validation.warnings.length) printIssues(f.validation)
      return
    }
    const res = await irisFetch(`/api/v1/brands/${r.brand.id}`, { method: "PATCH", body: JSON.stringify({ metadata: { ...metadata, audience: f.audience } }) })
    if (!res.ok) {
      if (!json) await handleApiError(res, "Save audience")
      return fail(`Save audience: HTTP ${res.status}`)
    }
    // Read back: a 200 says the request was accepted, not that the audience is stored (#179802).
    const again = await readBrand(String(r.brand.id))
    if (!again.ok) return fail(`saved, but reading it back failed: ${again.error}`)
    const now = metadataOf(again.brand)
    const lost = kept.filter((k) => !(k in now))
    if (stableJson(now.audience ?? null, 2) !== after) return fail("the platform accepted the save but holds a different audience — check with `iris brands audience show`")
    if (lost.length) return fail(`saved, but the brand no longer has ${lost.join(", ")} in its metadata`)
    if (json) return writeJson({ success: true, changed: true, brand: r.brand.id, kept, summary: audienceSummary(f.audience), warnings: f.validation.warnings })
    console.log(`${success("✓")} ${r.brand.name}'s audience saved ${dim(`(kept: ${kept.length ? kept.join(", ") : "nothing else stored"})`)}`)
    for (const l of audienceSummary(f.audience)) console.log(`  ${l}`)
  },
})

const AudienceTemplateCommand = cmd({
  command: "template",
  describe: "print an empty audience.v1 as commented YAML, to fill in",
  async handler() {
    process.stdout.write(audienceTemplateYaml())
  },
})

const AudienceValidateCommand = cmd({
  command: "validate",
  describe: "check a JSON or YAML file against audience.v1 (exit 1 on errors)",
  builder: (yargs) =>
    yargs
      .option("file", { describe: "audience.v1 as .json, .yaml or .yml", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const f = readFile(String(args.file))
    if (!f.ok) {
      process.exitCode = 1
      if (args.json) return writeJson({ success: false, error: f.error })
      return console.error(f.error)
    }
    if (!f.validation.ok) process.exitCode = 1
    if (args.json) return writeJson({ success: f.validation.ok, errors: f.validation.errors, warnings: f.validation.warnings, summary: f.validation.ok ? audienceSummary(f.audience) : [] })
    if (f.validation.ok) {
      console.log(`${success("✓")} ${args.file} is a valid ${AUDIENCE_SCHEMA}${f.validation.warnings.length ? dim(` (${f.validation.warnings.length} warning(s))`) : ""}`)
      for (const l of audienceSummary(f.audience)) console.log(`  ${l}`)
    } else console.error(`${args.file}: ${f.validation.errors.length} problem(s)`)
    printIssues(f.validation)
  },
})

export const BrandsAudienceGroup = cmd({
  command: "audience",
  describe: "who the brand sells to (audience.v1): segments, personas, use cases — show, set, template, validate",
  builder: (yargs) =>
    yargs.command(AudienceShowCommand).command(AudienceSetCommand).command(AudienceTemplateCommand).command(AudienceValidateCommand).demandCommand(),
  async handler() {},
})

