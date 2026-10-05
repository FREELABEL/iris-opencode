import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, printDivider, dim, bold, success, highlight, irisFetch, IRIS_API, resolveUserId, writeJson } from "./iris-api"
import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as nodePath from "path"
import * as os from "os"

/**
 * Google Drive browsing, including SHARED DRIVES.
 *
 * Why this exists: `search_files` maps to GOOGLEDRIVE_FIND_FILE, which does NOT reach
 * Shared Drives / Team Drives. So the obvious command silently returned only personal
 * and shared-with-me files and missed entire org drives — for Vanguard that is exactly
 * where the case files live, per their own G-Drive SOP. Listing a drive root is also not
 * enough: content sits nested in folders, so this walks the tree to a chosen depth
 * instead of making the operator click through one folder at a time.
 */

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
}

const FOLDER_MIME = "application/vnd.google-apps.folder"

/**
 * A browser-openable URL for a Drive file. Workspace docs open in their own editor;
 * everything else opens through the generic file viewer. Having located a file, the
 * fastest human action is opening it, and the CLI used to make you build this by hand
 * from an id it already had (#178633).
 */
function driveUrlFor(f: { id: string; mimeType?: string }): string {
  const m = f.mimeType ?? ""
  if (m === "application/vnd.google-apps.document") return `https://docs.google.com/document/d/${f.id}/edit`
  if (m === "application/vnd.google-apps.spreadsheet") return `https://docs.google.com/spreadsheets/d/${f.id}/edit`
  if (m === "application/vnd.google-apps.presentation") return `https://docs.google.com/presentation/d/${f.id}/edit`
  return `https://drive.google.com/file/d/${f.id}/view`
}

/** Run one Composio Drive action through the backend executor. */
async function driveExec(action: string, params: Record<string, unknown>): Promise<any> {
  const userId = await resolveUserId()
  if (!userId) throw new Error("Not signed in — run: iris auth login")

  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct`,
    { method: "POST", body: JSON.stringify({ integration: "google-drive", action, params }) },
    IRIS_API,
  )

  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data?.error ?? data?.message ?? `Drive request failed (HTTP ${res.status}).`)
  if (data?.success === false) throw new Error(String(data?.error ?? data?.message ?? "Drive request failed."))

  return data?.data?.response_data ?? data?.data ?? data
}

function listFiles(parentId: string | null, driveId: string | null, pageSize: number) {
  const params: Record<string, unknown> = {
    pageSize,
    // Both flags are required for Shared Drive content to appear at all.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: "files(id,name,mimeType,size,modifiedTime)",
  }
  if (driveId) {
    params.driveId = driveId
    params.corpora = "drive"
  }

  // Always scope by folderId — including at the root, where the drive id doubles as the
  // root folder id.
  //
  // Without that, a drive-level call with corpora=drive returns EVERY file in the drive
  // FLAT, so the root appeared to contain files that actually live several folders down
  // and each was then printed twice. Verified by inspecting parents: the three files sat
  // under Ring Central (1ExYctlJ…), not at the root. The tree was double-counting rather
  // than mis-filtering, which is subtler and reads as plausible.
  const scope = parentId ?? driveId
  if (scope) params.folderId = scope
  else params.q = "'root' in parents and trashed = false"

  return driveExec("list_files", params)
}

/** Depth-first walk, printing an indented tree. Returns counts for the summary. */
async function walk(
  parentId: string | null,
  driveId: string | null,
  depth: number,
  maxDepth: number,
  pageSize: number,
  prefix: string,
  counts: { files: number; folders: number; errors: number },
  showIds = false,
): Promise<void> {
  let items: DriveFile[] = []
  try {
    const data = await listFiles(parentId, driveId, pageSize)
    items = data?.files ?? []
  } catch (e: any) {
    counts.errors++
    console.log(`${prefix}${highlight("⚠")} ${dim(String(e?.message ?? "failed").slice(0, 90))}`)
    return
  }

  const folders = items.filter((f) => f.mimeType === FOLDER_MIME)
  const files = items.filter((f) => f.mimeType !== FOLDER_MIME)

  for (const f of files) {
    counts.files++
    const kind = f.mimeType?.replace("application/vnd.google-apps.", "") ?? ""
    // Print the FULL id and a clickable URL. Having found a file, the next action is
    // always to open or read it, and an id that is absent (or abbreviated) forces the
    // operator to go rebuild it by hand from a listing that already had it (#178633).
    const tail = showIds ? `  ${dim(f.id)}\n${prefix}  ${dim(driveUrlFor(f))}` : ""
    console.log(`${prefix}${f.name}  ${dim(kind)}${tail}`)
  }

  for (const d of folders) {
    counts.folders++
    console.log(`${prefix}${bold(d.name + "/")}`)
    // Stop descending at maxDepth, but say so rather than implying the folder is empty.
    if (depth + 1 < maxDepth) {
      await walk(d.id, driveId, depth + 1, maxDepth, pageSize, prefix + "  ", counts, showIds)
    } else {
      console.log(`${prefix}  ${dim("… (deeper — raise --depth)")}`)
    }
  }
}

// ── The LOCAL index ─────────────────────────────────────────────────────────
// Everything above talks to the Drive API through driveExec. DriveFS also keeps
// a SQLite index on this machine, and it answers the one question the API is
// worst at: what is the full path of this file? The API returns `parents` one
// hop at a time, so resolving paths for N files costs N x depth round trips and
// quota; a recursive CTE does it in one query, offline, with no login — which
// also means it still works while the Drive integration is broken (#157987).
//
// IRIS already reads local application databases this way; see platform-wispr.
//
// THE SCHEMA IS PRIVATE AND UNDOCUMENTED. Google can rename a column in any
// DriveFS update with no notice, so every query is gated behind a shape check
// that FAILS CLOSED. A confident wrong answer about where a file lives is worse
// than no answer.

// Overridable so the fail-closed guard below can actually be demonstrated
// failing. A guard nobody can make fail is indistinguishable from one that does
// not work, and this one's whole job is to refuse a query when Google changes
// its private schema.
const DRIVEFS_ROOT =
  process.env.IRIS_DRIVEFS_ROOT ||
  nodePath.join(os.homedir(), "Library", "Application Support", "Google", "DriveFS")

const REQUIRED_SCHEMA: Record<string, string[]> = {
  items: ["stable_id", "id", "local_title", "mime_type", "file_size", "modified_date", "trashed", "is_owner", "is_folder"],
  stable_parents: ["item_stable_id", "parent_stable_id"],
}

type DriveAccount = { accountId: string; dbPath: string }

/**
 * Every Drive account signed in on this machine.
 *
 * The numeric directory is a per-ACCOUNT id. Hardcoding one is the tenancy trap
 * that once put another company's locations on a client's booking form: a machine
 * with two Google accounts has two of these, and picking the first silently
 * answers about the wrong Drive.
 */
function driveAccounts(root: string = DRIVEFS_ROOT): DriveAccount[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .filter((d) => /^\d+$/.test(d))
    .map((accountId) => ({ accountId, dbPath: nodePath.join(root, accountId, "metadata_sqlite_db") }))
    .filter((a) => fs.existsSync(a.dbPath))
}

/** Missing tables/columns, so the caller can name the broken account and continue. */
function schemaProblems(db: Database): string[] {
  const problems: string[] = []
  for (const [table, cols] of Object.entries(REQUIRED_SCHEMA)) {
    let present: string[]
    try {
      present = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
    } catch {
      problems.push(`${table}: unreadable`)
      continue
    }
    if (present.length === 0) { problems.push(`${table}: table missing`); continue }
    const missing = cols.filter((c) => !present.includes(c))
    if (missing.length) problems.push(`${table}: missing ${missing.join(", ")}`)
  }
  return problems
}

type LocalRow = {
  id: string
  local_title: string | null
  mime_type: string | null
  file_size: number | null
  modified_date: number | null
  trashed: number
  is_owner: number
  is_folder: number
  full_path: string | null
}

// depth < 40 is a cycle guard, not a belief about how deep Drive goes: this is a
// graph, and one corrupted parent row would otherwise spin forever.
//
// The seed is its own CTE because SQLite REJECTS a LIMIT in a recursive CTE's
// initial SELECT — "LIMIT clause should come after UNION ALL not before". That
// is a runtime prepare error no typechecker can see, and it was caught only by
// running the real SQL against the real index.
function selectWithPaths(db: Database, seedWhere: string, params: any[], limit: number | null): LocalRow[] {
  const seed = limit === null
    ? `SELECT stable_id, id, local_title FROM items WHERE ${seedWhere}`
    : `SELECT stable_id, id, local_title FROM items WHERE ${seedWhere} LIMIT ${Number(limit)}`

  return db
    .query(
      `WITH RECURSIVE seed AS (${seed}),
         path(sid, target, title, depth) AS (
           SELECT s.stable_id, s.id, s.local_title, 0 FROM seed s
           UNION ALL
           SELECT sp.parent_stable_id, p.target, pi.local_title || '/' || p.title, p.depth + 1
           FROM path p
           JOIN stable_parents sp ON sp.item_stable_id = p.sid
           JOIN items pi ON pi.stable_id = sp.parent_stable_id
           WHERE p.depth < 40
         )
       SELECT i.id, i.local_title, i.mime_type, i.file_size, i.modified_date,
              i.trashed, i.is_owner, i.is_folder,
              (SELECT title FROM path WHERE target = i.id ORDER BY depth DESC LIMIT 1) AS full_path
       FROM items i JOIN seed s ON s.id = i.id`,
    )
    .all(...params) as LocalRow[]
}

function humanBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—"
  const u = ["B", "KB", "MB", "GB"]
  let n = bytes, i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${u[i]}`
}

function renderLocalRows(rows: LocalRow[]) {
  for (const r of rows) {
    const flags = [r.is_folder ? "folder" : null, r.trashed ? "TRASHED" : null, r.is_owner ? null : "not-owner"]
      .filter(Boolean).join(" ")
    const when = r.modified_date ? new Date(r.modified_date).toISOString().slice(0, 16).replace("T", " ") : "—"
    console.log(`  ${bold(r.full_path ?? r.local_title ?? "(no path)")}`)
    console.log(`  ${dim(`${r.id}  ${r.mime_type ?? "—"}  ${humanBytes(r.file_size)}  ${when}${flags ? "  [" + flags + "]" : ""}`)}`)
  }
}

/**
 * Run a local read across every signed-in account.
 *
 * Reports per-account schema failure rather than a blank result, because
 * "nothing matched" and "nothing was readable" are different answers and only
 * one of them means you should stop trusting the tool.
 */
async function runLocal(args: any, build: (db: Database) => LocalRow[]): Promise<void> {
  const accounts = driveAccounts()
  if (!accounts.length) {
    prompts.log.error("No Google Drive accounts found on this machine.")
    prompts.log.info(`Looked in ${dim(DRIVEFS_ROOT)}`)
    process.exitCode = 1
    return
  }

  const all: LocalRow[] = []
  let usable = 0
  for (const acct of accounts) {
    let db: Database
    try { db = new Database(acct.dbPath, { readonly: true }) } catch (e) {
      prompts.log.error(`account ${acct.accountId}: cannot open index — ${String(e)}`)
      continue
    }
    try {
      const problems = schemaProblems(db)
      if (problems.length) {
        prompts.log.error(`account ${acct.accountId}: DriveFS schema has changed — ${problems.join("; ")}`)
        prompts.log.info("Refusing to query it. This index is private to Google and its shape is not guaranteed.")
        continue
      }
      usable++
      all.push(...build(db))
    } finally { db.close() }
  }

  if (!usable) {
    prompts.log.error("No readable Drive index on this machine.")
    process.exitCode = 1
    return
  }
  if (args.json) { await writeJson(all); return }
  printDivider()
  if (!all.length) { console.log(`  ${dim("no matches in the local index")}`); return }
  renderLocalRows(all)
  printDivider()
  console.log(`  ${dim(`${all.length} result(s) from the local index — no API calls, no quota`)}`)
}

export const PlatformDriveCommand = cmd({
  command: "drive <action> [target..]",
  describe: "browse Google Drive including Shared Drives, or read the local index offline",
  builder: (y) =>
    y
      .positional("action", {
        describe: "list-drives | tree | read | path | find | accounts",
        type: "string",
        choices: ["list-drives", "tree", "read", "path", "find", "accounts"],
      })
      // Without this, yargs strict mode rejects every trailing word with
      // "Unknown argument", and `iris drive read <id>` has NEVER worked — the
      // args._[1] fallback below it was unreachable from the day it was written
      // for #178633. Only --file ever reached the handler.
      .positional("target", {
        describe: "file id(s) for `read`/`path`, or the search text for `find`",
        type: "string",
        array: true,
      })
      .option("file", { describe: "file id to read (drive read --file <id>)", type: "string" })
      .option("out", { describe: "write the exported text here instead of stdout", type: "string" })
      .option("ids", { describe: "show full file ids + open URLs in the tree", type: "boolean", default: false })
      .option("drive", { describe: "Shared Drive id (from list-drives); omit for My Drive", type: "string" })
      .option("folder", { describe: "start at this folder id instead of the drive root", type: "string" })
      .option("depth", { describe: "how many folder levels to walk", type: "number", default: 2 })
      .option("page-size", { describe: "items fetched per folder", type: "number", default: 100 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    if (!args.json) prompts.intro(`◈  Drive: ${args.action}`)
    // Local-index actions run BEFORE the auth gate on purpose. They read a
    // SQLite file on this machine: no login, no network, no quota — and they
    // keep working while the Drive integration itself is broken (#157987),
    // which is exactly when you most need to know where a file went.
    const LOCAL_ACTIONS = ["path", "find", "accounts"]
    if (LOCAL_ACTIONS.includes(String(args.action))) {
      try {
        if (args.action === "accounts") {
          const accounts = driveAccounts().map((a) => {
            let problems: string[] = ["cannot open"]
            try { const db = new Database(a.dbPath, { readonly: true }); problems = schemaProblems(db); db.close() } catch {}
            return { account_id: a.accountId, db_path: a.dbPath, readable: problems.length === 0, problems }
          })
          if (args.json) { await writeJson(accounts); return }
          printDivider()
          if (!accounts.length) console.log(`  ${dim("no Drive accounts on this machine")}`)
          for (const a of accounts) {
            console.log(`  ${bold(a.account_id)}  ${a.readable ? success("readable") : `NOT readable — ${a.problems.join("; ")}`}`)
          }
          return
        }

        const rest = ((args.target as string[] | undefined) ?? []).map(String)
        if (args.action === "path") {
          if (!rest.length) {
            prompts.log.error("Which files? Pass ids:  iris drive path <file-id> [<file-id>...]")
            process.exitCode = 1
            return
          }
          const ph = rest.map(() => "?").join(",")
          await runLocal(args, (db) => selectWithPaths(db, `id IN (${ph})`, rest, null))
          return
        }

        // find
        const needle = rest[0]
        if (!needle) {
          prompts.log.error('What are you looking for?  iris drive find "quarterly report"')
          process.exitCode = 1
          return
        }
        const limit = Number(args["page-size"] ?? 25)
        await runLocal(args, (db) =>
          selectWithPaths(db, "local_title LIKE ? AND trashed = 0", [`%${needle}%`], limit),
        )
        return
      } finally {
        prompts.outro("Done")
      }
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }

    try {
      // `tree` could find a file and there was then nothing you could do with it — the
      // only way to open one was `integrations exec google-drive read_doc`, which is not
      // discoverable from `iris drive` at all (#178633).
      if (args.action === "read") {
        const fileId = (args.file as string) ?? ((args.target as string[] | undefined) ?? [])[0]
        if (!fileId) {
          prompts.log.error("Which file? Pass an id:  iris drive read --file <file-id>")
          prompts.log.info(`Find one with:  ${bold("iris drive tree --ids")}`)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }

        const data = await driveExec("read_doc", { file_id: fileId })
        const content = data?.content ?? data?.text ?? data?.body ?? ""
        const name = data?.name ?? data?.fileName ?? fileId

        if (args.json) { await writeJson(data); return }

        if (args.out) {
          const { writeFileSync } = await import("fs")
          writeFileSync(args.out as string, String(content))
          printDivider()
          prompts.outro(`${success("✓")} ${name} → ${bold(String(args.out))}`)
          return
        }

        printDivider()
        console.log(String(content))
        printDivider()
        prompts.outro(`${success("✓")} ${name}`)
        return
      }

      if (args.action === "list-drives") {
        const data = await driveExec("list_shared_drives", {})
        const drives = data?.drives ?? data?.items ?? []

        if (args.json) { await writeJson(drives); return }

        printDivider()
        if (!drives.length) {
          console.log(`  ${dim("No Shared Drives visible to this account.")}`)
          console.log(`  ${dim("An account only sees Shared Drives it is a MEMBER of.")}`)
        } else {
          for (const d of drives) console.log(`  ${bold(d.name)}  ${dim(d.id)}`)
        }
        printDivider()
        prompts.outro(`${success("✓")} ${drives.length} shared drive${drives.length === 1 ? "" : "s"}`)
        return
      }

      // tree
      const driveId = (args.drive as string) ?? null
      const folderId = (args.folder as string) ?? null
      const maxDepth = Math.max(1, Number(args.depth) || 2)
      const pageSize = Math.min(1000, Math.max(1, Number(args["page-size"]) || 100))

      if (!args.json) {
        console.log(`  ${dim(driveId ? `Shared Drive ${driveId}` : "My Drive")}  ${dim("· depth " + maxDepth)}`)
        printDivider()
      }

      const counts = { files: 0, folders: 0, errors: 0 }
      await walk(folderId, driveId, 0, maxDepth, pageSize, "  ", counts, Boolean(args.ids))

      if (args.json) { await writeJson(counts); return }

      printDivider()
      const errNote = counts.errors ? highlight(`  ·  ${counts.errors} error(s)`) : ""
      prompts.outro(`${success("✓")} ${counts.files} file(s), ${counts.folders} folder(s)${errNote}`)
    } catch (err: any) {
      prompts.log.error(String(err?.message ?? err))
      process.exitCode = 1
      prompts.outro("Done")
    }
  },
})
