/**
 * Private backup for LOCAL how-to recipes.
 *
 * `iris how-to publish` mirrors the repository's curated `scaffold/how-to` to the public
 * /how-to endpoint, and deliberately REFUSES `~/.iris/how-to` because those may be
 * unreviewed. That refusal is right for a public surface — but it left the 45 recipes on this
 * machine with no durable home at all: ~350KB of operational knowledge, served to every
 * connected orchestrator as the MCP `iris://recipes` resource, and one disk failure from gone.
 *
 * This is the other half: a PRIVATE mirror into a bloq. Not published, not public — backed up,
 * available to another machine, and retrievable by agents because a bloq is what they read.
 */

export const RECIPE_TITLE_PREFIX = "how-to: "

export type LocalRecipe = { name: string; content: string }
export type RemoteRecipe = { itemId: number; name: string; content: string }

export function titleForRecipe(name: string): string {
  return `${RECIPE_TITLE_PREFIX}${name}`
}

/** Null for anything that is not one of ours — the prefix must START the title. */
export function recipeNameFromTitle(title: string): string | null {
  if (!title.startsWith(RECIPE_TITLE_PREFIX)) return null
  const name = title.slice(RECIPE_TITLE_PREFIX.length).trim()
  return name || null
}

/** Trailing whitespace is not an edit; rewriting on it would churn every recipe forever. */
const norm = (s: string): string => (s ?? "").replace(/\s+$/, "")

export type RecipeDiff = {
  toCreate: LocalRecipe[]
  toUpdate: Array<{ local: LocalRecipe; itemId: number }>
  unchanged: string[]
  remoteOnly: RemoteRecipe[]
}

export function diffRecipes(local: LocalRecipe[], remote: RemoteRecipe[]): RecipeDiff {
  const byName = new Map(remote.map((r) => [r.name, r]))
  const out: RecipeDiff = { toCreate: [], toUpdate: [], unchanged: [], remoteOnly: [] }

  for (const l of local) {
    const r = byName.get(l.name)
    if (!r) out.toCreate.push(l)
    else if (norm(r.content) === norm(l.content)) out.unchanged.push(l.name)
    else out.toUpdate.push({ local: l, itemId: r.itemId })
  }

  // A recipe removed locally is REPORTED, never deleted remotely. A backup that mirrors
  // deletions is not a backup — it is a second way to lose the same file.
  const localNames = new Set(local.map((l) => l.name))
  out.remoteOnly = remote.filter((r) => !localNames.has(r.name))

  return out
}

// ── command ──────────────────────────────────────────────────────────────────

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, resolveUserId, dim, bold } from "./iris-api"
import { homedir } from "os"
import { join } from "path"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { firstArray } from "../../util/array"

const HOWTO_DIR = join(homedir(), ".iris", "how-to")
const BACKUP_BLOQ_NAME = "IRIS How-To Recipes (private backup)"

function readLocal(): LocalRecipe[] {
  if (!existsSync(HOWTO_DIR)) return []
  return readdirSync(HOWTO_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ""), content: readFileSync(join(HOWTO_DIR, f), "utf8") }))
}

/**
 * Resolve the backup board and its Recipes list.
 *
 * Returns a REASON on failure rather than null. A single null could not tell "no board" from
 * "board exists but has no list", and both printed the same advice — one of which would have
 * been wrong. That is the defect class this whole sprint is about, so it does not get to live
 * in the fix for it.
 */
async function findBackupBloq(): Promise<{ ok: true; id: number; listId: number } | { ok: false; reason: string; bloqId?: number }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: "could not resolve your user id" }

  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=200`)
  if (!res.ok) return { ok: false, reason: `listing boards failed (HTTP ${res.status})` }
  const body = (await res.json()) as any
  const rows: any[] = firstArray(body?.data?.data, body?.data, body?.bloqs)
  const b = rows.find((x) => String(x?.name ?? "").trim() === BACKUP_BLOQ_NAME)
  if (!b) return { ok: false, reason: "no board with that exact name" }

  const lists: any[] = firstArray(b?.lists)
  let list = lists.find((l) => String(l?.name ?? "").toLowerCase() === "recipes") ?? lists[0]
  if (!list) {
    const det = await irisFetch(`/api/v1/user/${userId}/bloqs/${b.id}`)
    if (det.ok) {
      const d = (await det.json()) as any
      const dl: any[] = firstArray(d?.data?.lists, d?.lists)
      list = dl.find((l) => String(l?.name ?? "").toLowerCase() === "recipes") ?? dl[0]
    }
  }
  if (!list) return { ok: false, reason: "board found, but it has no lists", bloqId: b.id }

  return { ok: true, id: b.id, listId: list.id }
}

async function readRemote(bloqId: number): Promise<RemoteRecipe[]> {
  const userId = await resolveUserId()
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500&fields=id,title,content`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const items: any[] = firstArray(body?.items, body?.data?.items, body?.data)
  const out: RemoteRecipe[] = []
  for (const it of items) {
    const name = recipeNameFromTitle(String(it?.title ?? ""))
    if (name) out.push({ itemId: Number(it.id), name, content: String(it?.content ?? "") })
  }
  return out
}

const BackupCommand = cmd({
  command: "backup",
  describe: "mirror your LOCAL ~/.iris/how-to recipes into a private bloq (not published)",
  builder: (y) =>
    y
      .option("dry-run", { type: "boolean", default: false, describe: "show the diff, write nothing" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  How-To Backup")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const local = readLocal()
    if (local.length === 0) {
      prompts.log.warn(`No recipes found in ${HOWTO_DIR}. Nothing to back up.`)
      prompts.outro("Done"); return
    }

    const found = await findBackupBloq()
    if (!found.ok) {
      prompts.log.error(`Cannot back up: ${found.reason}.`)
      if (found.bloqId) {
        prompts.log.info(dim(`  iris bloqs create-list ${found.bloqId} --name Recipes`))
      } else {
        prompts.log.info(`Create a board named exactly:  ${bold(BACKUP_BLOQ_NAME)}`)
        prompts.log.info(dim(`  iris bloqs create --name "${BACKUP_BLOQ_NAME}"`))
      }
      prompts.outro("Done"); return
    }
    const target = found

    const remote = await readRemote(target.id)
    const d = diffRecipes(local, remote)

    prompts.log.info(
      `${local.length} local · ${remote.length} backed up · ` +
        `${d.toCreate.length} new · ${d.toUpdate.length} changed · ${d.unchanged.length} unchanged`,
    )
    if (d.remoteOnly.length) {
      // Never deleted. A backup that mirrors deletions is a second way to lose a file.
      prompts.log.warn(
        `${d.remoteOnly.length} recipe(s) exist in the backup but NOT locally: ` +
          `${d.remoteOnly.map((r) => r.name).join(", ")}. Left untouched — delete them by hand if that is deliberate.`,
      )
    }

    if (args["dry-run"]) { prompts.outro("Dry run — nothing written"); return }
    if (d.toCreate.length === 0 && d.toUpdate.length === 0) {
      prompts.log.success("Already current — nothing to write.")
      prompts.outro("Done"); return
    }

    const uid = await resolveUserId()
    let wrote = 0
    for (const r of d.toCreate) {
      const res = await irisFetch(`/api/v1/user/${uid}/bloqs/${target.id}/lists/${target.listId}/items`, {
        method: "POST",
        body: JSON.stringify({ title: titleForRecipe(r.name), content: r.content }),
      })
      if (res.ok) wrote++
      else prompts.log.error(`create failed: ${r.name}`)
    }
    for (const u of d.toUpdate) {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${u.itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: titleForRecipe(u.local.name), content: u.local.content }),
      })
      if (res.ok) wrote++
      else prompts.log.error(`update failed: ${u.local.name}`)
    }

    // Verify by RE-READING, not by trusting the write responses. The whole point of this
    // command is that the recipes exist somewhere other than one laptop; "probably wrote it"
    // does not clear that bar.
    const after = await readRemote(target.id)
    const still = diffRecipes(local, after)
    const outstanding = still.toCreate.length + still.toUpdate.length

    if (outstanding === 0) {
      prompts.log.success(`Backed up ${wrote} recipe(s). All ${local.length} verified present and current.`)
    } else {
      prompts.log.error(
        `Wrote ${wrote}, but ${outstanding} recipe(s) are STILL missing or stale after re-reading. ` +
          `Do not treat this backup as complete.`,
      )
    }
    prompts.outro(`iris bloqs get ${target.id}`)
  },
})

export const HowToBackupCommands = [BackupCommand]
