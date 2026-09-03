import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, printDivider, dim, bold, success, highlight, irisFetch, IRIS_API, resolveUserId, writeJson } from "./iris-api"

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

export const PlatformDriveCommand = cmd({
  command: "drive <action>",
  describe: "browse Google Drive including Shared Drives (list-drives, tree)",
  builder: (y) =>
    y
      .positional("action", {
        describe: "list-drives | tree | read",
        type: "string",
        choices: ["list-drives", "tree", "read"],
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
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    try {
      // `tree` could find a file and there was then nothing you could do with it — the
      // only way to open one was `integrations exec google-drive read_doc`, which is not
      // discoverable from `iris drive` at all (#178633).
      if (args.action === "read") {
        const fileId = (args.file as string) ?? (args._?.[1] as string)
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
