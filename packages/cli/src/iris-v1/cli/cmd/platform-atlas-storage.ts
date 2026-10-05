import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson } from "./iris-api"

// ============================================================================
// Atlas Storage — where your data lives, and how to stream it out.
//
// Three modes, and they are not a ladder:
//   1 default   Atlas data on the shared IRIS store
//   2 external  Atlas data on YOUR database (data residency)
//   3 parallel  Atlas + a continuous feed into your warehouse — alongside 1 or 2, not instead
//
// The question that separates 2 from 3 is whether you want to HOLD the data or QUERY it.
// "Put it in our Supabase for BI" is 3; answering it with 2 moves your operational store to
// solve a reporting problem, and then every read depends on your database being up.
// ============================================================================

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

const StatusCommand = cmd({
  command: "status",
  aliases: ["show"],
  describe: "which storage mode your data is on, and whether it is actually working",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Storage")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Checking…")
    const res = await irisFetch(`/api/v1/atlas/storage/mode`)
    spinner.stop("")
    if (!(await handleApiError(res, "Storage mode"))) { prompts.outro("Done"); return }

    const body = await res.json().catch(() => null) as any
    const data = body?.data ?? {}
    if (args.json) { writeJson(data); prompts.outro("Done"); return }

    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : []

    if (workspaces.length === 0) {
      console.log("  No workspaces yet — your Atlas data is on the shared IRIS store (mode 1).")
    }

    for (const w of workspaces) {
      console.log()
      console.log("  " + bold(w.workspace_name ?? `Workspace ${w.workspace_id}`))
      console.log(`    mode         ${w.mode_number} — ${w.mode}`)
      console.log(`    configured   ${w.configured_driver}`)
      console.log(`    resolves to  ${w.resolved_driver}`)

      // The failure that otherwise announces itself nowhere: a binding that cannot be built
      // falls back to the shared store so nothing hard-fails, which means it reads and writes
      // perfectly against the wrong backend forever.
      if (w.silent_fallback) {
        console.log()
        console.log("    ⚠ " + bold("SILENT FALLBACK") + ` — configured for ${w.configured_driver}, serving from ${w.resolved_driver}.`)
        console.log("      Reads and writes are succeeding against the shared store.")
        console.log("      Ask us to re-check the credentials on this binding.")
      }

      if (w.retained?.note) {
        console.log()
        console.log("    " + dim(w.retained.note))
      }
    }

    const feed = data.parallel_feed
    if (feed?.available) {
      console.log()
      printDivider()
      console.log("  " + bold("Mode 3 — parallel feed") + dim("  (runs alongside whichever mode you are on)"))
      console.log("    Stream changes into your own warehouse:")
      console.log("      iris atlas:storage feed <dataset> --since <iso8601>")
      console.log("    " + dim(feed.note ?? ""))
    }

    console.log()
    console.log(dim("  Changing to mode 2 (your own database) moves customer data and needs"))
    console.log(dim("  credentials — talk to us and we will run the migration with you."))
    prompts.outro("Done")
  },
})

const FeedCommand = cmd({
  command: "feed <dataset>",
  describe: "stream changed records since a cursor — the parallel feed (mode 3)",
  builder: (y) =>
    y
      .positional("dataset", { type: "string", demandOption: true, describe: "dataset slug" })
      .option("since", { type: "string", describe: "ISO-8601 cursor; omit for everything" })
      .option("include-deleted", { type: "boolean", default: false, describe: "emit tombstones so your replica can delete too" })
      .option("per-page", { type: "number", default: 200 })
      .option("all", { type: "boolean", default: false, describe: "follow next_cursor until the feed is quiet" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Change Feed")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    // No --since means "everything", which we express as an epoch cursor rather than omitting
    // the parameter — without it the endpoint is an ordinary list and returns no cursor at all,
    // so the first run of a sync would have nothing to resume from.
    let cursor = args.since || "1970-01-01T00:00:00Z"
    // Tracked separately from the REQUEST cursor. Advancing `cursor` only when we keep looping
    // meant a single-page run printed the cursor it started from — telling the user to re-read
    // the whole dataset on every sync, forever. That is precisely the re-emit loop the
    // strictly-greater-than cursor exists to prevent, reintroduced one layer up.
    let resumeCursor = cursor
    let page = 1
    let total = 0
    let deleted = 0
    const collected: any[] = []

    while (true) {
      const qs = new URLSearchParams({
        updated_since: cursor,
        per_page: String(args["per-page"] ?? 200),
      })
      if (args["include-deleted"]) qs.set("include_deleted", "1")

      const res = await irisFetch(`/api/v1/atlas/datasets/${args.dataset}?${qs.toString()}`)
      if (!(await handleApiError(res, "Change feed"))) { prompts.outro("Done"); return }

      const body = await res.json().catch(() => null) as any
      const payload = body?.data ?? body
      const records = payload?.records?.data ?? payload?.records ?? []
      const rows = Array.isArray(records) ? records : []

      for (const r of rows) {
        total++
        if (r?.deleted_at) deleted++
        if (args.json) collected.push(r)
      }

      const next = payload?.cdc?.next_cursor ?? payload?.records?.next_cursor ?? body?.meta?.next_cursor ?? null

      if (!args.json) {
        console.log(`  page ${page}  ${rows.length} record(s)${next ? dim("  → " + next) : ""}`)
      }

      // Stop when the page is empty. A feed that has caught up returns nothing and hands back
      // the cursor it was given, so "no rows" is the terminating condition, not "no cursor".
      if (next) resumeCursor = next

      if (rows.length === 0) break
      if (!args.all) break
      if (!next || next === cursor) break
      cursor = next
      page++
    }

    if (args.json) { writeJson({ dataset: args.dataset, records: collected, count: total, next_cursor: resumeCursor }); prompts.outro("Done"); return }

    console.log()
    printDivider()
    console.log(`  ${bold(String(total))} changed record(s)` + (args["include-deleted"] ? `  ·  ${deleted} tombstone(s)` : ""))
    if (!args["include-deleted"]) {
      // Silence about deletes is the trap: a replica built without them keeps every row it has
      // ever seen and quietly diverges while both sides report success.
      console.log(dim("  Tombstones are NOT included. Without them your copy can never delete."))
      console.log(dim("  Re-run with --include-deleted to mirror deletions."))
    }
    console.log()
    console.log("  Resume next time with:")
    console.log(`    iris atlas:storage feed ${args.dataset} --since '${resumeCursor}'` + (args["include-deleted"] ? " --include-deleted" : ""))
    prompts.outro("Done")
  },
})

// ============================================================================
export const PlatformAtlasStorageCommand = cmd({
  command: "atlas:storage",
  aliases: ["atlas-storage"],
  describe: "where your Atlas data lives (shared, your own database, or streamed to your warehouse)",
  builder: (y) => y.command(StatusCommand).command(FeedCommand).demandCommand(),
  async handler() {},
})
