/**
 * `iris atlas pull|diff|push` (board) and `iris atlas:list pull|diff|push` (one list).
 *
 * Same nomenclature as `atlas:item`, one and two levels up: a board pulls into a folder of list
 * directories, each holding one markdown file per item, each file the SAME format `atlas:item push`
 * accepts on its own. The names work under both spellings because the command group is `atlas` with
 * `bloqs` as an alias, so `iris bloqs pull` and `iris atlas pull` are one command, not two.
 *
 * All of the judgement lives in atlas-tree-sync (pure, tested). This file fetches, writes files,
 * prints the plan, and asks before doing anything destructive.
 */

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, isNonInteractive } from "./iris-api"
import { renderItemFile, parseItemFile, itemFilename, type LocalFile, type RemoteItem } from "./atlas-item-sync"
import {
  planPull, planPush, summarize, boardDirName, listDirName, boardMeta, listMeta, pulledIdsFrom,
  type RemoteBoard, type RemoteList, type LocalEntry, type PushStep,
} from "./atlas-tree-sync"
import matter from "gray-matter"

const UI = { empty: () => console.log("") }

/** The whole board in one call: lists, each with its items. */
async function fetchBoard(userId: number, bloqId: string | number): Promise<RemoteBoard | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
  if (!res.ok) {
    await handleApiError(res, "Get board")
    return null
  }
  const body = (await res.json()) as { data?: RemoteBoard } & RemoteBoard
  const b = (body as any)?.data ?? body
  return b && (b as RemoteBoard).id !== undefined ? (b as RemoteBoard) : null
}

/** The board a list belongs to — a list is only addressable through its board. */
async function findBoardForList(userId: number, listId: string | number): Promise<{ board: RemoteBoard; list: RemoteList } | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=100&simplified=1`)
  if (!res.ok) return null
  const j = (await res.json()) as { data?: any }
  const boards = Array.isArray(j?.data) ? j.data : (j?.data?.bloqs ?? [])
  for (const b of boards) {
    const full = await fetchBoard(userId, b.id)
    const list = (full?.lists ?? []).find((l) => String(l.id) === String(listId))
    if (full && list) return { board: full, list }
  }
  return null
}

/** Every .md file under a pulled folder, with the list its directory names. */
function readFolder(root: string): { files: Record<string, LocalFile>; entries: LocalEntry[]; pulledIds: number[] } {
  const files: Record<string, LocalFile> = {}
  const entries: LocalEntry[] = []
  const pulledIds: number[] = []
  if (!existsSync(root)) return { files, entries, pulledIds }

  for (const dirent of readdirSync(root)) {
    const dirPath = join(root, dirent)
    if (!statSync(dirPath).isDirectory()) {
      if (dirent.endsWith(".md")) files[dirent] = parseItemFile(readFileSync(dirPath, "utf-8"))
      continue
    }
    const listMetaPath = join(dirPath, "_list.md")
    const listData = existsSync(listMetaPath) ? ((matter(readFileSync(listMetaPath, "utf-8")).data as any) ?? {}) : {}
    const listId = listData.iris_list_id ?? null
    // The prune universe: what this folder pulled, as recorded at pull time.
    for (const n of listData.pulled_item_ids ?? []) if (Number.isFinite(Number(n))) pulledIds.push(Number(n))
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md") || f === "_list.md") continue
      const rel = `${dirent}/${f}`
      const parsed = parseItemFile(readFileSync(join(dirPath, f), "utf-8"))
      files[rel] = parsed
      entries.push({ path: rel, file: parsed, listId: listId ?? null })
    }
  }
  return { files, entries, pulledIds }
}

function writeTree(root: string, board: RemoteBoard, lists: RemoteList[], steps: ReturnType<typeof planPull>): number {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "_board.md"), matter.stringify("", boardMeta(board)))
  const byPath = new Map(steps.map((s) => [s.path, s]))
  let written = 0
  for (const list of lists) {
    const dir = join(root, listDirName(list))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "_list.md"), matter.stringify("", listMeta(list, board.id)))
    for (const item of list.items ?? []) {
      const rel = `${listDirName(list)}/${itemFilename(item)}`
      if (byPath.get(rel)?.action !== "write") continue
      writeFileSync(join(root, rel), renderItemFile(item))
      written++
    }
  }
  return written
}

function printPullPlan(steps: ReturnType<typeof planPull>, written: number): void {
  const counts = (k: string) => steps.filter((s) => s.action === k).length
  console.log(`  ${success(String(written))} written · ${counts("identical")} unchanged · ${counts("refuse-local-edits")} kept (local edits) · ${counts("orphan-local")} no longer on the server`)
  for (const s of steps) {
    if (s.action === "refuse-local-edits") console.log(dim(`    kept    ${s.path} — ${s.reason}`))
    if (s.action === "orphan-local") console.log(dim(`    orphan  ${s.path} — ${s.reason}`))
  }
}

async function doPull(args: any, only?: RemoteList): Promise<void> {
  await requireAuth()
  const userId = await requireUserId(args["user-id"])
  if (!userId) return

  let board: RemoteBoard | null
  let lists: RemoteList[]
  if (only) {
    const found = await findBoardForList(userId, only.id)
    if (!found) { console.error(`No list ${only.id} on any board you can see.`); process.exitCode = 1; return }
    board = found.board
    lists = [found.list]
  } else {
    board = await fetchBoard(userId, args["bloq-id"])
    if (!board) { process.exitCode = 1; return }
    lists = board.lists ?? []
  }

  const root = String(args.out || join("atlas", boardDirName(board)))
  const { files } = readFolder(root)
  const steps = planPull({ board: { ...board, lists }, local: files, force: Boolean(args.force), itemFilename })

  if (args.json) { console.log(JSON.stringify({ root, steps })); return }
  UI.empty()
  const written = writeTree(root, board, lists, steps)
  console.log(`  ${bold(root)}`)
  printPullPlan(steps, written)
  console.log("")
  console.log(dim(`  edit the files, then:  iris atlas diff ${root}   ·   iris atlas push ${root}`))
  console.log("")
}

async function doDiff(args: any): Promise<void> {
  await requireAuth()
  const userId = await requireUserId(args["user-id"])
  if (!userId) return
  const root = String(args.dir)
  const boardMetaPath = join(root, "_board.md")
  if (!existsSync(boardMetaPath)) { console.error(`${root} is not a pulled folder (no _board.md).`); process.exitCode = 1; return }
  const bloqId = (matter(readFileSync(boardMetaPath, "utf-8")).data as any)?.iris_bloq_id
  const board = await fetchBoard(userId, bloqId)
  if (!board) { process.exitCode = 1; return }

  const { entries, pulledIds } = readFolder(root)
  const remoteById: Record<string, RemoteItem> = {}
  const titlesByList: Record<string, string[]> = {}
  for (const l of board.lists ?? []) {
    titlesByList[String(l.id)] = (l.items ?? []).map((i) => String(i.title ?? ""))
    for (const i of l.items ?? []) remoteById[String(i.id)] = i
  }
  const steps = planPush({ entries, remoteById, titlesByList, pulledIds })
  const s = summarize(steps)

  if (args.json) { console.log(JSON.stringify({ summary: s, steps })); process.exitCode = s.noop && s.refused === 0 ? 0 : 1; return }
  UI.empty()
  if (s.noop && s.refused === 0) { console.log(dim(`  no difference — ${root} matches board #${board.id}`)); return }
  for (const st of steps) {
    if (st.action === "skip") continue
    const tag = st.action === "update" ? success("update") : st.action === "create" ? success("create") : bold(st.action)
    console.log(`  ${tag}  ${st.path}  ${dim(st.reason)}`)
  }
  console.log("")
  console.log(`  ${s.update} to update · ${s.create} to create · ${s.refused} refused`)
  console.log("")
  process.exitCode = 1
}

/**
 * Apply one step and return the item the server now holds, so the file can be re-anchored.
 *
 * THE WRITE-BACK IS NOT COSMETIC. Without it a created file keeps no id, so the next push tries to
 * create it a second time and is refused as a duplicate; and an updated file keeps a marker older
 * than the write we just made, so the next push is refused as diverged — against our own change.
 * Measured both, running it twice. `publish` has always written frontmatter back for this reason.
 */
async function applyStep(userId: number, st: PushStep, file: LocalFile, boardId: number | string): Promise<{ ok: boolean; item: RemoteItem | null }> {
  const title = String(file.fm?.title ?? "")
  const content = file.body
  const readBack = async (id: number | string | null) => (id ? await fetchItemById(id) : null)

  if (st.action === "update") {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${st.itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    })
    return { ok: res.ok, item: res.ok ? await readBack(st.itemId) : null }
  }
  if (st.action === "create") {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${boardId}/lists/${st.listId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    })
    if (!res.ok) return { ok: false, item: null }
    const body = (await res.json().catch(() => null)) as any
    const created = body?.data ?? body
    return { ok: true, item: created?.id ? ((await readBack(created.id)) ?? created) : null }
  }
  if (st.action === "delete") {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${st.itemId}`, { method: "DELETE" })
    return { ok: res.ok, item: null }
  }
  return { ok: false, item: null }
}

async function fetchItemById(id: number | string): Promise<RemoteItem | null> {
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`)
  if (!res.ok) return null
  const j = (await res.json()) as { data?: RemoteItem } & RemoteItem
  return ((j as any)?.data ?? j) ?? null
}

async function doPush(args: any): Promise<void> {
  await requireAuth()
  const userId = await requireUserId(args["user-id"])
  if (!userId) return
  const root = String(args.dir)
  const boardMetaPath = join(root, "_board.md")
  if (!existsSync(boardMetaPath)) { console.error(`${root} is not a pulled folder (no _board.md).`); process.exitCode = 1; return }
  const bloqId = (matter(readFileSync(boardMetaPath, "utf-8")).data as any)?.iris_bloq_id
  const board = await fetchBoard(userId, bloqId)
  if (!board) { process.exitCode = 1; return }

  const { entries, pulledIds } = readFolder(root)
  const remoteById: Record<string, RemoteItem> = {}
  const titlesByList: Record<string, string[]> = {}
  for (const l of board.lists ?? []) {
    titlesByList[String(l.id)] = (l.items ?? []).map((i) => String(i.title ?? ""))
    for (const i of l.items ?? []) remoteById[String(i.id)] = i
  }
  const steps = planPush({
    entries, remoteById, titlesByList,
    force: Boolean(args.force), prune: Boolean(args.prune), allowDuplicate: Boolean(args["allow-duplicate"]),
    pulledIds,
  })
  const s = summarize(steps)

  if (s.noop) {
    if (args.json) console.log(JSON.stringify({ success: true, summary: s, steps }))
    else console.log(dim(`  nothing to push — ${root} matches board #${board.id}${s.refused ? ` (${s.refused} refused)` : ""}`))
    if (s.refused && !args.json) for (const st of steps.filter((x) => x.action.startsWith("refuse"))) console.log(dim(`    ${st.path}: ${st.reason}`))
    return
  }

  if (!args.json) {
    UI.empty()
    for (const st of steps) {
      if (st.action === "skip") continue
      console.log(`  ${st.action === "delete" ? bold("DELETE") : st.action}  ${st.path}  ${dim(st.reason)}`)
    }
    console.log("")
    console.log(`  ${s.update} update · ${s.create} create · ${bold(String(s.delete))} delete · ${s.refused} refused`)
  }

  // Deleting is the one step that cannot be undone from here, so it is confirmed, and in a
  // non-interactive shell it needs --yes rather than defaulting to "go ahead".
  if (s.delete > 0 && !args.yes) {
    if (isNonInteractive()) {
      prompts.log.error(`${s.delete} item(s) would be DELETED. Re-run with --yes to confirm in a non-interactive shell.`)
      process.exitCode = 1
      return
    }
    const ok = await prompts.confirm({ message: `Delete ${s.delete} item(s) that were pulled and then removed?` })
    if (prompts.isCancel(ok) || !ok) { console.log(dim("  nothing pushed")); return }
  }

  const byPath = new Map(entries.map((e) => [e.path, e.file]))
  let done = 0
  let failed = 0
  for (const st of steps) {
    if (st.action === "skip" || st.action.startsWith("refuse")) continue
    const { ok, item } = await applyStep(userId, st, byPath.get(st.path) ?? { fm: {}, body: "" }, board.id)
    if (ok) {
      done++
      // Re-anchor the file to what the server now holds: the id for a create, the fresh marker for
      // an update. Without this the SECOND push of the same folder fails on its own last write.
      if (item && st.path !== "(file removed)") {
        try { writeFileSync(join(root, st.path), renderItemFile(item)) } catch { /* the push landed; the file is a convenience */ }
      }
    } else failed++
  }

  // READ THE BOARD BACK. A 2xx per request is not the same claim as "the board now matches", and
  // this is the level where a half-applied push is easiest to miss.
  const after = await fetchBoard(userId, bloqId)
  const afterById: Record<string, RemoteItem> = {}
  for (const l of after?.lists ?? []) for (const i of l.items ?? []) afterById[String(i.id)] = i
  const stillDiffer = planPush({
    entries: readFolder(root).entries, remoteById: afterById, titlesByList: {},
    pulledIds: [], allowDuplicate: true,
  }).filter((x) => x.action === "update").length

  if (args.json) { console.log(JSON.stringify({ success: failed === 0, applied: done, failed, still_differ: stillDiffer, summary: s })); return }
  console.log("")
  console.log(`  ${success(`${done} applied`)}${failed ? ` · ${bold(`${failed} failed`)}` : ""}`)
  if (stillDiffer > 0) prompts.log.warn(`${stillDiffer} file(s) still differ from the server after the push — re-run diff.`)
  else console.log(dim("  read back: the board matches the folder"))
  console.log("")
  if (failed) process.exitCode = 1
}

const outOpt = (y: any) => y.option("out", { describe: "folder to pull into (default: ./atlas/<board>-<id>)", type: "string" })
  .option("force", { describe: "overwrite local files that have unpushed edits", type: "boolean", default: false })
  .option("json", { describe: "JSON output", type: "boolean", default: false })
  .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })

export const AtlasPullCommand = cmd({
  command: "pull <bloq-id>",
  describe: "pull a whole board into a folder of markdown files (lists become directories)",
  builder: (y: any) => outOpt(y.positional("bloq-id", { describe: "board id", type: "string", demandOption: true })),
  async handler(args: any) { await doPull(args) },
})

export const AtlasDiffCommand = cmd({
  command: "diff <dir>",
  describe: "what differs between a pulled folder and the board on the server",
  builder: (y: any) =>
    y.positional("dir", { describe: "a folder produced by `pull`", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args: any) { await doDiff(args) },
})

export const AtlasPushCommand = cmd({
  command: "push <dir>",
  describe: "send a pulled folder back — updates edited items, creates new files as items",
  builder: (y: any) =>
    y.positional("dir", { describe: "a folder produced by `pull`", type: "string", demandOption: true })
      .option("force", { describe: "overwrite items changed on the server since you pulled", type: "boolean", default: false })
      .option("prune", { describe: "DELETE items whose file you removed (only items this folder pulled)", type: "boolean", default: false })
      .option("allow-duplicate", { describe: "create an item even when the list already has that title", type: "boolean", default: false })
      .option("yes", { describe: "confirm deletions without a prompt", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args: any) { await doPush(args) },
})

const AtlasListPullCommand = cmd({
  command: "pull <list-id>",
  describe: "pull ONE list into a folder of markdown files",
  builder: (y: any) => outOpt(y.positional("list-id", { describe: "list id", type: "string", demandOption: true })),
  async handler(args: any) { await doPull(args, { id: String(args["list-id"]) }) },
})

/**
 * `iris atlas:list` — the same three verbs, scoped to one list.
 *
 * diff and push are the board commands unchanged: a pulled list folder carries the same `_board.md`
 * and `_list.md`, so there is nothing list-specific to decide. Two implementations of "push a
 * folder" would be two things to keep correct.
 */
export const PlatformAtlasListCommand = cmd({
  command: "atlas:list",
  aliases: ["atlas-list"],
  describe: "Atlas lists as folders — pull, diff, push",
  builder: (y: any) => y.command(AtlasListPullCommand).command(AtlasDiffCommand).command(AtlasPushCommand).demandCommand(),
  async handler() {},
})
