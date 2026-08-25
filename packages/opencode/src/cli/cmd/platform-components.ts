import { cmd } from "./cmd"
import {
  irisFetch, requireAuth, handleApiError, printDivider, printKV,
  dim, bold, success, highlight, IRIS_API, writeJson,
} from "./iris-api"
import { UI } from "../ui"

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

    let rows: any[] = body.components ?? []
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
 * Named `library`, not `components`, because `iris genesis components <slug>` already exists
 * and means something DIFFERENT — the components used ON one page. One word with two meanings
 * is the drift that makes a CLI unlearnable, so the two stay distinct:
 *
 *   genesis components <page-slug>   what is on THIS PAGE
 *   genesis library …                what exists to be reused ANYWHERE
 */
export const LibraryCmd = cmd({
  command: "library <command>",
  aliases: ["lib", "components-library"],
  describe: "the stored component library — list, show, usage, versions, rollback",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(ShowCmd)
      .command(UsageCmd)
      .command(VersionsCmd)
      .command(RollbackCmd)
      .demandCommand(1),
  async handler() {},
})
