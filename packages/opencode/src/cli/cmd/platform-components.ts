import { cmd } from "./cmd"
import {
  irisFetch, requireAuth, handleApiError, printDivider, printKV,
  dim, bold, success, highlight, IRIS_API, writeJson,
} from "./iris-api"
import { UI } from "../ui"
import { firstArray } from "../../util/array"

/**
 * `iris genesis components …` — the stored Genesis Component library.
 *
 * WHY THIS EXISTS. The compiler has always recorded props, emits and slots on every artifact
 * so a builder need not re-parse source, and the API has always had an index. Nothing
 * surfaced either — so composing a page meant remembering slugs and guessing prop names,
 * which is the friction that makes someone write a NEW component instead of naming an
 * existing one. That quietly defeats the point of a stored library.
 */

function api(path: string, options?: RequestInit): Promise<Response> {
  return irisFetch(path, options ?? {}, IRIS_API)
}

const BASE = "/api/v1/genesis/components"

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list stored components with their props, emits and slots",
  builder: (y) =>
    y
      .option("search", { describe: "filter by slug, name, prop, emit or slot", type: "string" })
      .option("stale", { describe: "only components compiled by an older compiler", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const res = await api(BASE)
    if (!res.ok) { handleApiError(res, "list components"); return }
    const body = await res.json()

    let rows: any[] = firstArray(body.components)
    const q = String(args.search ?? "").toLowerCase()
    if (q) {
      // Searching the declared API is the point: "the one that emits select" is how an author
      // remembers a component, not by its slug.
      rows = rows.filter((c) =>
        [c.slug, c.name, c.description, ...(c.props ?? []), ...(c.emits ?? []), ...(c.slots ?? [])]
          .join(" ").toLowerCase().includes(q))
    }
    if (args.stale) rows = rows.filter((c) => c.stale)

    if (args.json) { writeJson({ components: rows, compilerVersion: body.compilerVersion }); return }

    UI.println("")
    UI.println(`◈  Components  ${dim(`compiler ${body.compilerVersion}`)}`)
    printDivider()
    if (!rows.length) {
      UI.println(dim(q ? `  no component matches "${args.search}"` : "  none published yet"))
      return
    }
    for (const c of rows) {
      const staleTag = c.stale ? `  ${UI.Style.TEXT_WARNING}stale · ${c.compilerVersion}${UI.Style.TEXT_NORMAL}` : ""
      UI.println(`  ${bold(c.slug)}${staleTag}`)
      if (c.description) UI.println(dim(`    ${c.description}`))
      if (c.props?.length) UI.println(dim(`    props   ${c.props.join(" · ")}`))
      if (c.emits?.length) UI.println(dim(`    emits   ${c.emits.join(" · ")}`))
      if (c.slots?.length) UI.println(dim(`    slots   ${c.slots.join(" · ")}`))
    }
    printDivider()
    const staleCount = (body.components ?? []).filter((c: any) => c.stale).length
    UI.println(dim(`  ${rows.length} shown · ${(body.components ?? []).length} total`
      + (staleCount ? ` · ${staleCount} compiled by an older compiler` : "")))
    UI.println(dim(`  iris genesis components show <slug>   ·   usage <slug>`))
  },
})

const ShowCmd = cmd({
  command: "show <slug>",
  aliases: ["get"],
  describe: "one component's declared API, compiler version and staleness",
  builder: (y) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("source", { describe: "print the source too", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const res = await api(`${BASE}/${args.slug}`)
    if (!res.ok) { handleApiError(res, `show ${args.slug}`); return }
    const body = await res.json()
    const c = body.component ?? body

    if (args.json) { writeJson(c); return }

    const declared = c.artifact?.declared ?? {}
    UI.println("")
    UI.println(`◈  ${bold(c.slug)}`)
    printDivider()
    if (c.name) printKV("Name", c.name)
    if (c.description) printKV("About", c.description)
    printKV("Compiler", c.compiler_version ?? c.compilerVersion ?? "—")
    printKV("Props", (declared.props ?? []).join(" · ") || dim("none"))
    printKV("Emits", (declared.emits ?? []).join(" · ") || dim("none"))
    printKV("Slots", (declared.slots ?? []).join(" · ") || dim("none"))
    printDivider()
    // The thing an author actually needs: what to paste into a page.
    UI.println(dim("  in a page:"))
    UI.println(`    "componentSlug": "${c.slug}"`)
    if ((declared.slots ?? []).length) {
      UI.println(`    "slots": { ${(declared.slots ?? []).map((s: string) => `"${s}": [ … ]`).join(", ")} }`)
    }
    if (args.source && c.source) {
      printDivider()
      UI.println(c.source)
    }
  },
})

const UsageCmd = cmd({
  command: "usage <slug>",
  aliases: ["used-by", "where"],
  describe: "which pages name this component — see it BEFORE you change it",
  builder: (y) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const res = await api(`${BASE}/${args.slug}/usage`)
    if (!res.ok) { handleApiError(res, `usage ${args.slug}`); return }
    const body = await res.json()

    if (args.json) { writeJson(body); return }

    UI.println("")
    UI.println(`◈  Usage — ${bold(args.slug)}`)
    printDivider()
    for (const p of body.pages ?? []) {
      const nested = p.nested ? dim("  (in a slot)") : ""
      UI.println(`  ${highlight("/p/" + p.page)}${nested}`)
      if (p.title) UI.println(dim(`    ${p.title} · ${p.status} · ${p.uses} use(s)`))
    }
    printDivider()
    // Said plainly, because this is the number that should give someone pause.
    UI.println(body.page_count ? `  ${bold(String(body.page_count))} page(s) — ${body.note}` : dim(`  ${body.note}`))
  },
})

const VersionsCmd = cmd({
  command: "versions <slug>",
  aliases: ["history"],
  describe: "publish history for a component",
  builder: (y) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const res = await api(`${BASE}/${args.slug}/versions`)
    if (!res.ok) { handleApiError(res, `versions ${args.slug}`); return }
    const body = await res.json()
    if (args.json) { writeJson(body); return }

    UI.println("")
    UI.println(`◈  Versions — ${bold(args.slug)}`)
    printDivider()
    if (body.current) {
      const stale = body.current.stale ? `  ${UI.Style.TEXT_WARNING}stale${UI.Style.TEXT_NORMAL}` : ""
      UI.println(`  current  ${body.current.compiler_version ?? "—"}${stale}`)
    }
    for (const v of body.versions ?? []) {
      UI.println(dim(`  v${v.version}  ${v.compiler_version ?? "—"}  ${String(v.created_at ?? "").slice(0, 19)}  ${v.note ?? ""}`))
    }
    printDivider()
    UI.println(dim(`  iris genesis components rollback ${args.slug} --version <n>`))
  },
})

const RollbackCmd = cmd({
  command: "rollback <slug>",
  describe: "restore a previous version (itself undoable — the current state is snapshotted first)",
  builder: (y) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("version", { describe: "version number to restore", type: "number", demandOption: true }),
  async handler(args: any) {
    await requireAuth()
    const res = await api(`${BASE}/${args.slug}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: args.version }),
    })
    if (!res.ok) { handleApiError(res, `rollback ${args.slug}`); return }
    const body = await res.json()
    UI.println("")
    UI.println(success(`  restored v${body.restored} of ${args.slug}`))
    // Every page naming this slug just changed — say so rather than letting it be discovered.
    UI.println(dim(`  ${body.note}`))
  },
})

/**
 * `publish` — put a component INTO the library.
 *
 * The library could roll a component back but not put one there (#182769): list, show, usage,
 * versions and rollback all existed, and the only way in was a hand-rolled curl with a platform
 * token. That is backwards — the destructive verb was wrapped and the ordinary one was not.
 *
 * It matters more than convenience. Genesis composition is finished at the platform level:
 * `<slot name="literal">` compiles, declarations reach the artifact, pages fill slots. So the
 * remaining work in that layer is ENTIRELY "write a component and publish it", and half of
 * that had no supported path — which is why the layout vocabulary stayed at two components
 * for months.
 *
 * COMPILE ERRORS ARE THE NORMAL CASE, NOT THE EXCEPTION. This format refuses a lot on purpose
 * — dynamic member access, runtime slot names, arrow-function prop defaults, `<form>`. So a
 * failed publish prints every error with its line, rather than one generic message: the author
 * is mid-edit and needs the list, not a verdict.
 */
const PublishCmd = cmd({
  command: "publish <slug>",
  aliases: ["push", "create"],
  describe: "publish a component from a local .vue file (compiles server-side first)",
  builder: (y) =>
    y
      .positional("slug", { describe: "component slug (lowercase, dashes)", type: "string", demandOption: true })
      .option("file", { describe: "path to the .vue source", type: "string", demandOption: true })
      .option("name", { describe: "display name (defaults to the slug)", type: "string" })
      .option("description", { describe: "one line describing what it is for", type: "string" })
      .option("dry-run", { describe: "compile only — report errors and slots, publish nothing", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()

    const file = Bun.file(args.file)
    if (!(await file.exists())) {
      UI.println("")
      UI.println(`  no such file: ${args.file}`)
      process.exitCode = 1
      return
    }
    const source = await file.text()

    // COMPILE FIRST, ALWAYS — including on a real publish. The store endpoint compiles too,
    // but asking here means a failure is reported as a LIST OF ERRORS WITH LINES rather than
    // a 422 the caller has to unpack. Same reason `pages verify` exists next to `pages push`.
    const compiled = await api(`${BASE}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, slug: args.slug }),
    })
    if (!compiled.ok) { handleApiError(compiled, `compile ${args.slug}`); return }
    const result = await compiled.json()

    if (!result.ok) {
      UI.println("")
      UI.println(`  ${bold(args.slug)} did not compile`)
      printDivider()
      for (const e of firstArray(result.errors) ?? []) {
        const where = e.line ? dim(`  line ${e.line}`) : ""
        UI.println(`  ${e.code}${where}`)
        UI.println(dim(`    ${e.message}`))
      }
      if (args.json) writeJson({ ok: false, slug: args.slug, errors: result.errors })
      process.exitCode = 1
      return
    }

    const declared = result.artifact?.declared ?? {}
    const shape = [
      declared.props?.length ? `props ${declared.props.join(" · ")}` : null,
      declared.emits?.length ? `emits ${declared.emits.join(" · ")}` : null,
      declared.slots?.length ? `slots ${declared.slots.join(" · ")}` : null,
    ].filter(Boolean)

    if (args["dry-run"]) {
      UI.println("")
      UI.println(`  ${success("compiles")}  ${bold(args.slug)}  ${dim("(nothing published)")}`)
      for (const line of shape) UI.println(dim(`    ${line}`))
      if (args.json) writeJson({ ok: true, published: false, slug: args.slug, declared })
      return
    }

    const res = await api(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: args.slug,
        name: args.name ?? args.slug,
        description: args.description ?? "",
        source,
        // The slug already exists in most real uses — this is an edit, not a first publish.
        replace: true,
      }),
    })
    if (!res.ok) { handleApiError(res, `publish ${args.slug}`); return }
    const body = await res.json()

    UI.println("")
    UI.println(`  ${success("published")}  ${bold(args.slug)}${body.version ? dim(`  v${body.version}`) : ""}`)
    for (const line of shape) UI.println(dim(`    ${line}`))
    // Every page naming this slug renders the NEW artifact from now on. Say so here rather
    // than letting it be discovered on a page nobody was looking at.
    UI.println(dim(`  ${highlight("iris genesis library usage " + args.slug)} — which pages this changes`))
    if (args.json) writeJson(body)
  },
})

/**
 * Named `library`, not `components`, because `iris genesis components <slug>` already exists
 * and means something DIFFERENT — the components used ON one page. One word with two meanings
 * is the drift that makes a CLI unlearnable, so the two stay distinct:
 *
 *   genesis components <page-slug>   what is on THIS PAGE
 *   genesis library …                what exists to be reused ANYWHERE
 */
/**
 * `audit` — does "stale" mean OLD, or mean BROKEN? (#182770)
 *
 * `list` marks a component stale by comparing its stored compiler version to the current one.
 * That is a version comparison wearing the clothes of a health check: it cannot tell a
 * component that is merely old from one that would no longer compile, and those two facts
 * lead to completely different days. Thirteen of twenty were marked stale, spanning 3.3.0 to
 * 3.9.0, and the label gave no way to know whether any of them were a problem.
 *
 * This answers it the only way that is not a guess: send each stored source back through the
 * CURRENT compiler and report what it says. The first run found all thirteen still compiling
 * — "just old", every one — which is a fact worth being able to re-establish in one command
 * rather than twenty.
 *
 * Nothing is published or modified. `compile` is the same endpoint `publish --dry-run` uses.
 */
const AuditCmd = cmd({
  command: "audit [slug]",
  aliases: ["recompile", "check"],
  describe: "recompile stored components against the CURRENT compiler — tells 'just old' from 'would not build'",
  builder: (y) =>
    y
      .positional("slug", { describe: "one component; omit to audit the whole library", type: "string" })
      .option("stale-only", { describe: "only the ones list already marks stale", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()

    let slugs: string[] = []
    if (args.slug) slugs = [args.slug]
    else {
      const res = await api(BASE)
      if (!res.ok) { handleApiError(res, "list components"); return }
      const body = await res.json()
      slugs = (firstArray(body.components) ?? firstArray(body.data) ?? []).map((c: any) => c.slug).filter(Boolean)
    }

    const rows: any[] = []
    for (const slug of slugs) {
      const one = await api(`${BASE}/${slug}`)
      if (!one.ok) { rows.push({ slug, ok: false, reason: `could not read (${one.status})` }); continue }
      const stored = await one.json()
      if (args["stale-only"] && !stored.stale) continue

      const res = await api(`${BASE}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: stored.source ?? "", slug }),
      })
      // A transport failure is NOT a compile failure. Saying "would not build" because the
      // network blinked is the same class of lie this command exists to remove.
      if (!res.ok) { rows.push({ slug, version: stored.compilerVersion, stale: !!stored.stale, ok: null, reason: `compile call failed (${res.status})` }); continue }
      const out = await res.json()
      rows.push({
        slug,
        version: stored.compilerVersion,
        stale: !!stored.stale,
        ok: !!out.ok,
        errors: (firstArray(out.errors) ?? []).map((e: any) => e.code).slice(0, 3),
      })
    }

    if (args.json) { writeJson({ audited: rows.length, rows }); return }

    UI.println("")
    UI.println(`◈  Library audit — against the current compiler`)
    printDivider()
    for (const r of rows) {
      const mark = r.ok === true ? success("  builds  ") : r.ok === false ? "  BROKEN  " : dim("  unknown ")
      const ver = dim((r.version ?? "?").toString().padEnd(8))
      const flag = r.stale ? dim("stale") : dim("     ")
      const why = r.ok === false ? "  " + (r.errors ?? []).join(", ") : r.reason ? dim("  " + r.reason) : ""
      UI.println(`${mark}${ver} ${flag}  ${bold(r.slug)}${why}`)
    }
    printDivider()
    const broken = rows.filter((r) => r.ok === false).length
    const staleOk = rows.filter((r) => r.stale && r.ok === true).length
    // The headline is the DISTINCTION, because that is the thing `list` could not draw.
    UI.println(
      broken === 0
        ? `  ${bold(String(rows.length))} audited · ${bold("0")} would fail to build · ${staleOk} marked stale are merely OLD`
        : `  ${bold(String(rows.length))} audited · ${highlight(String(broken))} would NOT build`,
    )
    if (broken > 0) process.exitCode = 1
  },
})

export const LibraryCmd = cmd({
  command: "library <command>",
  aliases: ["lib", "components-library"],
  describe: "the stored component library — publish, list, show, usage, versions, audit, rollback",
  builder: (y) =>
    y
      .command(PublishCmd)
      .command(ListCmd)
      .command(ShowCmd)
      .command(UsageCmd)
      .command(VersionsCmd)
      .command(AuditCmd)
      .command(RollbackCmd)
      .demandCommand(1),
  async handler() {},
})
