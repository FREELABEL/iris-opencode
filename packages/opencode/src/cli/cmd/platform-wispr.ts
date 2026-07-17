import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { Database } from "bun:sqlite"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  dim,
  bold,
  success,
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  printKV,
} from "./iris-api"

// Default Wispr Flow history DB on macOS (bundle id com.electron.wispr-flow).
function defaultWisprDbPath(): string {
  return join(homedir(), "Library", "Application Support", "Wispr Flow", "flow.sqlite")
}

// A bloq can omit --bloq-id by storing `default_bloq_id` in ~/.iris/config.json.
function resolveDefaultBloqId(): number | undefined {
  try {
    const p = join(homedir(), ".iris", "config.json")
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"))
      const v = cfg.default_bloq_id ?? cfg.bloq_id
      if (typeof v === "number") return v
      if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10)
    }
  } catch {}
  return undefined
}

interface WisprRow {
  transcriptEntityId: string
  formattedText: string | null
  asrText: string | null
  editedText: string | null
  timestamp: string | null
  app: string | null
  url: string | null
  numWords: number | null
}

// The IRIS content item we store for a Wispr transcript. `transcript_id` is the
// stable dedup key so re-running `import` never duplicates an entry.
interface WisprItemContent {
  source: "wispr-flow"
  transcript_id: string
  text: string
  app: string | null
  url: string | null
  num_words: number | null
  spoken_at: string | null
}

function pickText(row: WisprRow): string {
  const t = row.formattedText || row.editedText || row.asrText || ""
  return t.trim()
}

// "Jul 16 · So in many ways it is only retaining the context…"
function deriveTitle(row: WisprRow, text: string): string {
  const day = (row.timestamp ?? "").slice(0, 10) // YYYY-MM-DD
  const snippet = text.replace(/\s+/g, " ").slice(0, 80).trim()
  const title = day ? `${day} · ${snippet}` : snippet
  return (title || `Wispr ${row.transcriptEntityId.slice(0, 8)}`).slice(0, 140)
}

const WisprImportCommand = cmd({
  command: "import",
  describe: "Import Wispr Flow dictation transcripts into an IRIS bloq as content items",
  builder: (yargs) =>
    yargs
      .option("bloq-id", {
        type: "number",
        alias: "b",
        describe: "Target bloq (default: default_bloq_id in ~/.iris/config.json)",
      })
      .option("list", {
        type: "string",
        alias: "l",
        describe: "Target list name within the bloq (default: first list)",
      })
      .option("db", {
        type: "string",
        describe: "Path to flow.sqlite (default: Wispr Flow app support dir)",
      })
      .option("since", {
        type: "string",
        describe: "Only import transcripts on/after this date (YYYY-MM-DD)",
      })
      .option("min-words", {
        type: "number",
        default: 3,
        describe: "Skip transcripts shorter than this many words",
      })
      .option("app", {
        type: "string",
        describe: "Only import transcripts dictated in this app bundle id (e.g. com.anthropic.claudefordesktop)",
      })
      .option("limit", { type: "number", describe: "Max transcripts to import" })
      .option("dry-run", { type: "boolean", default: false, describe: "Preview without writing to IRIS" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Wispr → IRIS")

    const dryRun = args["dry-run"] as boolean

    // ── Locate the Wispr DB ──
    const dbPath = (args.db as string | undefined) ?? defaultWisprDbPath()
    if (!existsSync(dbPath)) {
      prompts.log.error(`Wispr Flow database not found at:\n  ${dbPath}`)
      prompts.log.info("Is Wispr Flow installed? Pass a custom path with --db <path>.")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    // ── Auth (skipped on dry-run so you can preview offline) ──
    let userId: number | null = null
    if (!dryRun) {
      if (!(await requireAuth())) {
        prompts.outro("Done")
        process.exitCode = 1
        return
      }
      userId = await requireUserId(args["user-id"] as number | undefined)
      if (!userId) {
        prompts.outro("Done")
        process.exitCode = 1
        return
      }
    }

    // ── Read transcripts (read-only; never mutate Wispr's DB) ──
    const sp = prompts.spinner()
    sp.start("Reading Wispr transcripts…")
    let rows: WisprRow[]
    try {
      const db = new Database(dbPath, { readonly: true })
      const clauses = ["isArchived = 0", "COALESCE(formattedText, editedText, asrText) IS NOT NULL"]
      const params: Record<string, string | number> = {}
      if (args.since) {
        clauses.push("timestamp >= $since")
        params.$since = String(args.since)
      }
      if (args.app) {
        clauses.push("app = $app")
        params.$app = String(args.app)
      }
      if (typeof args["min-words"] === "number") {
        clauses.push("(numWords IS NULL OR numWords >= $minWords)")
        params.$minWords = args["min-words"]
      }
      let sql =
        `SELECT transcriptEntityId, formattedText, asrText, editedText, timestamp, app, url, numWords ` +
        `FROM History WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC`
      if (typeof args.limit === "number" && args.limit > 0) {
        sql += ` LIMIT $limit`
        params.$limit = args.limit
      }
      rows = db.query(sql).all(params as Record<string, string | number>) as unknown as WisprRow[]
      db.close()
    } catch (e: any) {
      sp.stop("Read failed", 1)
      prompts.log.error(e?.message || String(e))
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    // Drop rows that end up empty after text selection.
    const usable = rows.filter((r) => pickText(r).length > 0)
    sp.stop(`${success("✓")} ${usable.length} transcript(s) to import`)

    if (usable.length === 0) {
      prompts.outro("Nothing to import")
      return
    }

    // ── Dry run: preview and exit before touching IRIS ──
    if (dryRun) {
      for (const r of usable.slice(0, 10)) {
        const text = pickText(r)
        prompts.log.info(`${bold(deriveTitle(r, text))}  ${dim(`(${r.numWords ?? "?"} words · ${r.app ?? "?"})`)}`)
      }
      if (usable.length > 10) prompts.log.info(dim(`…and ${usable.length - 10} more`))
      prompts.outro(`Dry run — ${usable.length} transcript(s) would be imported`)
      return
    }

    // ── Resolve target bloq + list ──
    const bloqId = (args["bloq-id"] as number | undefined) ?? resolveDefaultBloqId()
    if (!bloqId) {
      prompts.log.error("Which bloq? Pass --bloq-id <id> (or set default_bloq_id in ~/.iris/config.json)")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const sp2 = prompts.spinner()
    sp2.start("Resolving target list…")
    let listId: number | null = null
    const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
    if (listsRes.ok) {
      const listsData = (await listsRes.json()) as { data?: any[] }
      const lists: any[] = listsData?.data ?? []
      if (args.list) {
        const match = lists.find((l: any) => (l.name ?? "").toLowerCase() === String(args.list).toLowerCase())
        if (match) listId = match.id
      }
      if (!listId && lists.length > 0) listId = lists[0].id
    } else if (listsRes.status === 404) {
      sp2.stop("Bloq not found", 1)
      prompts.log.error(`Bloq ${bloqId} not found (or not yours)`)
      prompts.outro("Done")
      process.exitCode = 1
      return
    }
    if (!listId) {
      sp2.stop("No list found", 1)
      prompts.log.error(`Bloq ${bloqId} has no lists. Create one first.`)
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    // ── Dedup against existing items by transcript_id ──
    sp2.start("Checking for already-imported transcripts…")
    const existingIds = new Set<string>()
    const existRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500`)
    if (existRes.ok) {
      const existData = (await existRes.json()) as { data?: any }
      const raw = existData?.data?.items ?? existData?.data?.data ?? existData?.data ?? []
      const items: any[] = Array.isArray(raw) ? raw : Object.values(raw)
      for (const item of items) {
        try {
          const c = typeof item.content === "string" ? JSON.parse(item.content) : item.content
          if (c?.source === "wispr-flow" && c?.transcript_id) existingIds.add(String(c.transcript_id))
        } catch {}
      }
    }
    const toCreate = usable.filter((r) => !existingIds.has(r.transcriptEntityId))
    sp2.stop(
      existingIds.size > 0
        ? `${existingIds.size} already imported — ${toCreate.length} new`
        : `${toCreate.length} to create`,
    )

    if (toCreate.length === 0) {
      prompts.outro(`${success("✓")} Already up to date`)
      return
    }

    // ── Create items ──
    const sp3 = prompts.spinner()
    sp3.start(`Importing ${toCreate.length} transcript(s)…`)
    let created = 0
    let failed = 0
    for (const r of toCreate) {
      const text = pickText(r)
      const content: WisprItemContent = {
        source: "wispr-flow",
        transcript_id: r.transcriptEntityId,
        text,
        app: r.app,
        url: r.url,
        num_words: r.numWords,
        spoken_at: r.timestamp,
      }
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items`, {
        method: "POST",
        body: JSON.stringify({
          title: deriveTitle(r, text),
          content: JSON.stringify(content),
          type: "default",
          bloq_list_id: listId,
        }),
      })
      if (res.ok) created++
      else failed++
    }
    sp3.stop(`${success("✓")} ${created} imported${failed > 0 ? `, ${failed} failed` : ""}`)

    printDivider()
    printKV("Bloq", bloqId)
    printKV("List", listId)
    printKV("Imported", created)
    if (existingIds.size > 0) printKV("Skipped (dup)", existingIds.size)
    if (failed > 0) printKV("Failed", failed)
    printDivider()

    if (created === 0 && failed > 0) process.exitCode = 1
    prompts.outro(created > 0 ? `${success("✓")} ${created} transcript(s) imported` : "Nothing imported")
  },
})

export const PlatformWisprCommand = cmd({
  command: "wispr",
  describe: "Import Wispr Flow dictation history into IRIS",
  builder: (yargs) => yargs.command(WisprImportCommand).demandCommand(),
  async handler() {},
})
