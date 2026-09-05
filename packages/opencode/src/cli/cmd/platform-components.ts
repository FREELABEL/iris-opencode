import { cmd } from "./cmd"
import {
  irisFetch, requireAuth, handleApiError, printDivider, printKV,
  dim, bold, success, highlight, IRIS_API, writeJson,
} from "./iris-api"
import { UI } from "../ui"
import { firstArray } from "../../util/array"
import {
  componentHeader, parseComponentHeader, stripComponentHeader,
  handleComponentConflictResponse, restampComponentHeader,
} from "./component-base"
import { diffComponentSource, mergeComponentSource } from "./component-diff"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"

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
/**
 * `pull` — the half of the round trip that never existed.
 *
 * `show --source` prints to a terminal, so editing a stored component meant copy-pasting out of
 * scrollback. These components have no `.vue` anywhere on disk — the stored row IS the source —
 * so that was the only route, and it carried no record of which state you edited.
 */
/** One component to disk, marker + pristine base. Returns false rather than throwing. */
async function pullOne(slug: string, dir: string): Promise<boolean> {
  try {
    const res = await api(`${BASE}/${slug}`)
    if (!res.ok) return false
    const body = await res.json()
    const c = body.component ?? body
    if (typeof c.source !== "string" || c.source === "") return false
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const pristine = stripComponentHeader(c.source)
    const header = componentHeader({
      slug: c.slug ?? slug,
      hash: c.compileHash ?? "none",
      compiler: c.compilerVersion ?? "unknown",
      pulledAt: new Date().toISOString(),
    })
    writeFileSync(join(dir, `${slug}.vue`), `${header}\n${pristine}`)
    const baseDir = join(dir, ".iris-base")
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    writeFileSync(join(baseDir, `${slug}.vue`), pristine)
    return true
  } catch {
    return false
  }
}

const PullCmd = cmd({
  // `[slug]` not `<slug>`: --all takes no slug, and yargs' demandOption would print help
  // instead of running — a flag that silently does nothing reads as a broken flag.
  command: "pull [slug]",
  aliases: ["download", "checkout"],
  describe: "download a stored component to a local .vue you can edit and publish back",
  builder: (y: any) =>
    y
      .positional("slug", { describe: "component slug (omit with --all)", type: "string" })
      .option("dir", { describe: "output directory", type: "string", default: "./components" })
      .option("all", { describe: "pull every component you own", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()

    if (!args.all && !args.slug) {
      UI.println("")
      UI.println("  Which component? Pass a slug, or --all to pull every one you own.")
      UI.println(dim("    iris pages library pull chat-stage"))
      UI.println(dim("    iris pages library pull --all"))
      process.exitCode = 1
      return
    }

    // --all: the library is the source of truth for these components and there is no .vue on
    // disk for any of them, so "let me see everything I own" is the normal first move.
    if (args.all) {
      const idx = await api(BASE)
      if (!idx.ok) { handleApiError(idx, "list components"); process.exitCode = 1; return }
      const ib = await idx.json()
      const all = firstArray(ib.components) ?? firstArray(ib) ?? []
      let ok = 0
      let failed = 0
      for (const item of all) {
        const slug = item?.slug
        if (!slug) continue
        const r = await pullOne(slug, args.dir)
        r ? ok++ : failed++
      }
      UI.println("")
      UI.println(`  ${success("pulled")} ${ok} component(s) → ${resolve(args.dir)}${failed ? dim(`  (${failed} failed)`) : ""}`)
      if (failed) process.exitCode = 1
      return
    }

    const res = await api(`${BASE}/${args.slug}`)
    if (!res.ok) { handleApiError(res, `pull ${args.slug}`); process.exitCode = 1; return }
    const body = await res.json()
    const c = body.component ?? body

    if (typeof c.source !== "string" || c.source === "") {
      UI.println("")
      UI.println(`  ${bold(args.slug)} has no stored source to pull.`)
      process.exitCode = 1
      return
    }

    const dir = args.dir as string
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${args.slug}.vue`)

    // The marker rides IN the file. A sidecar is lost the moment somebody copies just the .vue,
    // and a guard that disables itself when a file moves is the defect it exists to prevent.
    // `publish` strips it again before sending, so it never becomes stored source.
    const header = componentHeader({
      slug: c.slug,
      hash: c.compileHash ?? "none",
      compiler: c.compilerVersion ?? "unknown",
      pulledAt: new Date().toISOString(),
    })
    const pristine = stripComponentHeader(c.source)
    writeFileSync(file, `${header}\n${pristine}`)

    // A PRISTINE COPY OF WHAT WE PULLED, for `library merge`.
    //
    // The merge base cannot come from the server: `GET {slug}/versions` returns version,
    // compiler, author and note — no source. So without this, a three-way merge has no
    // ancestor, and a two-way guess is exactly the failure the page merge refuses (every line
    // reads as "added on both sides", resolving falsely clean or conflicting on everything).
    //
    // A sidecar is the right shape HERE, unlike the provenance marker: losing it degrades the
    // merge to an honest refusal, not to a silently disabled guard.
    try {
      const baseDir = join(dir, ".iris-base")
      if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, `${args.slug ?? c.slug}.vue`), pristine)
    } catch {
      // Non-fatal: the pull succeeded. `merge` will refuse rather than guess.
    }

    if (args.json) { writeJson({ ok: true, slug: c.slug, file: resolve(file), compileHash: c.compileHash }); return }

    UI.println("")
    UI.println(`  ${success("pulled")}  ${bold(c.slug)}  ${dim("→ " + resolve(file))}`)
    if (!c.compileHash) {
      // No token means publish cannot check divergence. Say so rather than letting a silent
      // downgrade look like protection.
      UI.println(dim(`    no compile hash on the server — publish cannot detect a clobber`))
    }
    UI.println(dim(`    edit it, then: ${highlight("iris pages library publish " + c.slug + " --file " + file)}`))
  },
})

/**
 * `diff` — what pages got and components did not. Nothing makes you run it, but its absence
 * meant there was no way to answer "am I about to clobber someone" before publishing.
 */
const DiffCmd = cmd({
  command: "diff <slug>",
  describe: "compare your local .vue against the published component",
  builder: (y: any) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("file", { describe: "path to the local .vue (default ./components/<slug>.vue)", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const file = args.file ?? join("./components", `${args.slug}.vue`)
    if (!existsSync(file)) {
      UI.println("")
      UI.println(`  no local file: ${file}`)
      UI.println(dim(`  pull it first: iris pages library pull ${args.slug}`))
      process.exitCode = 1
      return
    }
    const res = await api(`${BASE}/${args.slug}`)
    if (!res.ok) { handleApiError(res, `diff ${args.slug}`); process.exitCode = 1; return }
    // Same shape ShowCmd reads: the API returns the fields at top level, with `component` as an
    // older nesting. Defaulting to {} here would make `live` empty and report the whole file as
    // changed — a diff that is confidently wrong is worse than no diff.
    const body = await res.json()
    const c = body.component ?? body
    const live = typeof c.source === "string" ? c.source : ""
    const d = diffComponentSource(live, readFileSync(file, "utf-8"))

    if (args.json) { writeJson({ ok: true, slug: args.slug, ...d }); return }
    UI.println("")
    if (!d.changed) {
      UI.println(`  ${success("identical")}  ${bold(args.slug)}  ${dim("(the marker is not counted)")}`)
      return
    }
    UI.println(`  ${bold(args.slug)}  ${dim(`+${d.added} -${d.removed}`)}`)
    printDivider()
    for (const l of d.lines.slice(0, 200)) UI.println("  " + l)
    if (d.lines.length > 200) UI.println(dim(`  … ${d.lines.length - 200} more line(s)`))
  },
})

/**
 * `merge` — the recovery a component conflict never had.
 *
 * Line-based three-way, because a `.vue` is text with no addressable units. The page merge is
 * structural for the opposite reason; see component-diff.ts.
 */
const MergeCmd = cmd({
  command: "merge <slug>",
  describe: "three-way merge your local .vue with the published one after a conflict",
  builder: (y: any) =>
    y
      .positional("slug", { describe: "component slug", type: "string", demandOption: true })
      .option("file", { describe: "path to the local .vue (default ./components/<slug>.vue)", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    await requireAuth()
    const file = args.file ?? join("./components", `${args.slug}.vue`)
    if (!existsSync(file)) {
      UI.println(""); UI.println(`  no local file: ${file}`); process.exitCode = 1; return
    }
    const baseFile = join(dirname(file), ".iris-base", `${args.slug}.vue`)
    const base = existsSync(baseFile) ? readFileSync(baseFile, "utf-8") : null

    const res = await api(`${BASE}/${args.slug}`)
    if (!res.ok) { handleApiError(res, `merge ${args.slug}`); process.exitCode = 1; return }
    const mbody = await res.json()
    const c = mbody.component ?? mbody
    const ours = readFileSync(file, "utf-8")
    const r = mergeComponentSource(base, ours, typeof c.source === "string" ? c.source : "")

    if (r.refused) {
      UI.println("")
      UI.println(`  Refusing to merge ${bold(args.slug)} — no record of what you started from.`)
      UI.println(dim(`  ${baseFile} is missing, so there is no common ancestor and a two-way`))
      UI.println(dim(`  merge would read every line as added on both sides.`))
      UI.println("")
      UI.println(`  See the difference:  ${highlight("iris pages library diff " + args.slug)}`)
      UI.println(`  Take theirs:         ${highlight("iris pages library pull " + args.slug)}`)
      if (args.json) writeJson({ ok: false, refused: true, slug: args.slug, reason: "no_merge_base" })
      process.exitCode = 1
      return
    }

    // STAMP A CLEAN MERGE WITH *THEIRS* — so the follow-up publish is still guarded.
    //
    // Found by the production round trip: merge wrote the file bare, publish therefore sent no
    // expected_hash, and the recovery path for a clobber was itself unguarded. A third writer
    // publishing between your merge and your publish would have been overwritten silently —
    // the exact defect this work removes, reappearing inside the fix for it.
    //
    // Theirs is the right anchor: you merged against the published state, so that is the state
    // you are claiming to replace. Ours would claim a state the server never had.
    //
    // A CONFLICTED merge is deliberately left bare. It contains <<<<<<< markers, does not
    // compile, and is not a publishable state; stamping it would smooth the path for a reflex
    // publish that sends conflict markers to the server as source.
    const body = r.merged.endsWith("\n") ? r.merged : r.merged + "\n"
    const liveHash = typeof c.compileHash === "string" ? c.compileHash : ""
    writeFileSync(
      file,
      r.conflicted || !liveHash
        ? body
        : restampComponentHeader(body, {
            slug: args.slug,
            hash: liveHash,
            compiler: c.compilerVersion ?? "unknown",
            pulledAt: new Date().toISOString(),
          }),
    )

    // The ancestor for any FUTURE merge is now what we merged against, not what we first pulled.
    try {
      const bd = join(dirname(file), ".iris-base")
      if (!existsSync(bd)) mkdirSync(bd, { recursive: true })
      writeFileSync(join(bd, `${args.slug}.vue`), stripComponentHeader(String(c.source ?? "")))
    } catch {
      // Non-fatal: a later merge refuses rather than guessing.
    }

    if (args.json) { writeJson({ ok: !r.conflicted, slug: args.slug, conflicts: r.conflicts, file: resolve(file) }); return }
    UI.println("")
    if (r.conflicted) {
      UI.println(`  ${bold(args.slug)} merged with ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}`)
      UI.println(dim(`  resolve the <<<<<<< markers in ${resolve(file)}, then:`))
      UI.println(`    ${highlight("iris pages library publish " + args.slug + " --file " + file + " --force")}`)
      process.exitCode = 1
    } else {
      UI.println(`  ${success("merged cleanly")}  ${bold(args.slug)}  ${dim("→ " + resolve(file))}`)
      UI.println(dim(`  review it, then: iris pages library publish ${args.slug} --file ${file} --force`))
    }
  },
})

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
      .option("force", { describe: "publish even if someone else changed the component since you pulled it", type: "boolean", default: false })
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
    const raw = await file.text()
    // The provenance marker is NOT source. Storing it would drift the hash by one byte on every
    // pull, and every publish would then conflict against itself.
    const source = stripComponentHeader(raw)
    const pulledFrom = parseComponentHeader(raw)

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
        // Optimistic concurrency (#182331 / the #183600 shape). Only when the file carries a
        // marker: a hand-written component has nothing to diverge from, and refusing every
        // unmarked file is the shape that gets a guard disabled rather than fixed.
        ...(pulledFrom && pulledFrom.hash && pulledFrom.hash !== "none" && !args.force
          ? { expected_hash: pulledFrom.hash }
          : {}),
      }),
    })

    // A publish changes every page naming this slug, so a refusal here is protecting more than
    // one document. Handled before the generic error path so it reads as a conflict, not a 409.
    const conflictBody = res.status === 409 ? await res.clone().json().catch(() => null) : null
    const conflict = handleComponentConflictResponse(args.slug, res.status, conflictBody)
    if (conflict.conflicted) {
      UI.println("")
      for (const line of conflict.lines) UI.println("  " + line)
      if (args.json) writeJson({ ok: false, conflict: true, slug: args.slug, ...conflictBody })
      process.exitCode = conflict.exitCode
      return
    }

    if (!res.ok) { handleApiError(res, `publish ${args.slug}`); process.exitCode = 1; return }
    const body = await res.json()

    // Point the local file at the state we just created, so the NEXT publish from this file is
    // guarded rather than conflicting with our own work.
    if (body?.compileHash) {
      try {
        writeFileSync(args.file, restampComponentHeader(raw, {
          slug: args.slug,
          hash: body.compileHash,
          compiler: body.compilerVersion ?? pulledFrom?.compiler ?? "unknown",
          pulledAt: new Date().toISOString(),
        }))
      } catch {
        // Non-fatal: the publish already succeeded. The file just keeps its old marker, and the
        // next publish will refuse rather than clobber — the safe direction to fail.
      }
    }

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

/**
 * `studio` — point people at the browser workbench.
 *
 * WHY A CLI COMMAND FOR A URL
 *
 * The Component Studio has existed since 2026-08-21 and the CLI never mentioned it — zero
 * references in the whole source. So the only people who knew were the ones who already knew.
 * A capability nobody can find is indistinguishable from one that was never built: a session
 * spent a day rebuilding a local preview loop for a thing that was already live.
 *
 * The two lanes are complementary and the describe text says which is which, because "write it
 * in a browser" and "edit it in my own editor with a merge" are different days.
 */
const StudioCmd = cmd({
  command: "studio [slug]",
  aliases: ["workbench", "web"],
  describe: "open the browser Studio — write a component with a live preview beside it",
  builder: (y: any) =>
    y
      .positional("slug", { describe: "open this component (omit to start a new one)", type: "string" })
      .option("open", { describe: "open a browser", type: "boolean", default: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    // heyiris.io, not IRIS_API: this is a page a human opens, not an endpoint. Pointing it at
    // an API host would hand somebody a URL that renders nothing.
    const base = (process.env.IRIS_WEB_URL || "https://heyiris.io").replace(/\/$/, "")
    const url = `${base}/p/genesis-studio`

    if (args.json) { writeJson({ ok: true, url, slug: args.slug ?? null }); return }

    UI.println("")
    UI.println(`  ${bold("Component Studio")} — code on the left, live preview on the right`)
    printDivider()
    UI.println(`  ${highlight(url)}`)
    UI.println("")
    UI.println(dim("  Sign in first, or it cannot compile — components are owner-scoped:"))
    UI.println(`    ${highlight(base + "/auth/google/redirect?intended=/p/genesis-studio")}`)
    UI.println("")
    UI.println(dim("  In the Studio:  Open… loads a stored component · Compile · Save component"))
    UI.println(dim("  Here instead:   iris pages library pull <slug>   — edit it in your own editor,"))
    UI.println(dim("                  with diff, three-way merge and a stale-write guard the"))
    UI.println(dim("                  Studio does not have."))
    if (args.slug) UI.println(dim(`\n  Tip: in the Studio press Open… and pick “${args.slug}”.`))

    if (args.open) { try { Bun.spawn(["open", url]) } catch { /* not fatal */ } }
  },
})

export const LibraryCmd = cmd({
  command: "library <command>",
  aliases: ["lib", "components-library"],
  describe: "stored components — write one in the browser (studio), or pull/diff/merge it here",
  builder: (y) =>
    y
      .command(StudioCmd)
      .command(PullCmd)
      .command(DiffCmd)
      .command(MergeCmd)
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
