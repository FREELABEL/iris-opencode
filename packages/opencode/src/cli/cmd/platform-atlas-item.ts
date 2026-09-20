import { cmd } from "./cmd"
import { executePublish, executePublishMany, executeMakePublic, executeMakePrivate, executeUnpublish, executeListPublished } from "./bloq-item-shared"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import * as prompts from "./clack"
import { irisFetch, handleApiError, dim, bold, success } from "./iris-api"
import { renderItemFile, parseItemFile, pullDecision, diffItem, itemFilename, type RemoteItem } from "./atlas-item-sync"

/**
 * One item, read from the server.
 *
 * Same endpoint `bloqs get-item` reads and `publish` writes (/api/v1/user/bloqs/list/item/<id>), so
 * pull, diff and push cannot disagree about what an item IS.
 */
async function fetchItem(id: string | number): Promise<RemoteItem | null> {
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`)
  if (!res.ok) {
    await handleApiError(res, "Get item")
    return null
  }
  const body = (await res.json()) as { data?: RemoteItem } & RemoteItem
  const item = (body as any)?.data ?? body
  return item && (item as RemoteItem).id !== undefined ? (item as RemoteItem) : null
}

const readLocal = (file: string) => (existsSync(file) ? parseItemFile(readFileSync(file, "utf-8")) : null)

const AtlasItemPullCommand = cmd({
  command: "pull <item-id>",
  describe: "bring an Atlas item DOWN as a markdown file you can edit, diff and push back",
  builder: (y: any) =>
    y
      .positional("item-id", { describe: "item id", type: "string", demandOption: true })
      .option("out", { describe: "write here (default: ./atlas/<title>-<id>.md)", type: "string" })
      .option("force", { describe: "overwrite local edits that were never pushed", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const item = await fetchItem(String(args["item-id"]))
    if (!item) { process.exitCode = 1; return }

    const file = String(args.out || join("atlas", itemFilename(item)))
    const local = readLocal(file)
    const d = pullDecision({ local, remote: item, force: Boolean(args.force) })

    if (d.action === "refuse-local-edits" || d.action === "refuse-no-item") {
      if (args.json) console.log(JSON.stringify({ success: false, action: d.action, reason: d.reason, file }))
      else prompts.log.error(`${file}: ${d.reason}`)
      process.exitCode = 1
      return
    }
    if (d.action === "identical") {
      if (args.json) console.log(JSON.stringify({ success: true, action: d.action, file }))
      else console.log(dim(`  ${file} is already up to date`))
      return
    }

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, renderItemFile(item))
    if (args.json) { console.log(JSON.stringify({ success: true, action: "write", file, item_id: item.id, updated_at: item.updated_at })); return }
    console.log(success(`  pulled #${item.id} → ${bold(file)}`))
    console.log(dim(`  edit it, then:  iris atlas:item diff ${file}   ·   iris atlas:item push ${file}`))
  },
})

const AtlasItemDiffCommand = cmd({
  command: "diff <file>",
  describe: "what differs between your local file and the item on the server",
  builder: (y: any) =>
    y
      .positional("file", { describe: "a file produced by `pull`", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const file = String(args.file)
    const local = readLocal(file)
    if (!local) { console.error(`No such file: ${file}`); process.exitCode = 1; return }
    const id = local.fm?.iris_item_id
    if (!id) { console.error(`${file} has no iris_item_id — pull it first, or publish it to create the item.`); process.exitCode = 1; return }

    const item = await fetchItem(String(id))
    if (!item) { process.exitCode = 1; return }
    const d = diffItem(local, item)

    if (args.json) { console.log(JSON.stringify({ item_id: item.id, ...d })); process.exitCode = d.changed.length ? 1 : 0; return }
    if (d.changed.length === 0) {
      console.log(dim(`  no difference — ${file} matches item #${item.id}`))
      return
    }
    console.log(`  ${bold(`#${item.id}`)}  differs in: ${d.changed.join(", ")}`)
    if (d.serverMovedSincePull)
      prompts.log.warn(`The server copy changed after you pulled it (${item.updated_at}). Pushing would overwrite that — pull again, or push with --force.`)
    console.log("")
    for (const l of d.lines) console.log(l.startsWith("+") ? success(`  ${l}`) : l.startsWith("-") ? dim(`  ${l}`) : `  ${l}`)
    console.log("")
    // exit 1 so a script can branch on "is there anything to push"
    process.exitCode = 1
  },
})

/**
 * `push` is deliberately a thin alias over `publish`, not a second writer.
 *
 * `publish` already keys on iris_item_id, refuses to overwrite UI edits, and writes the divergence
 * marker back. A separate push implementation would be a second thing to keep correct, and the two
 * would drift the first time one of them was fixed.
 */
const AtlasItemPushCommand = cmd({
  command: "push <file>",
  describe: "send your local edits back to the item this file came from",
  builder: (y: any) =>
    y
      .positional("file", { describe: "a file produced by `pull`", type: "string", demandOption: true })
      .option("force", { describe: "overwrite changes made on the server since you pulled", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args: any) {
    const file = String(args.file)
    const local = readLocal(file)
    if (!local) { console.error(`No such file: ${file}`); process.exitCode = 1; return }
    if (!local.fm?.iris_item_id) {
      console.error(`${file} has no iris_item_id, so pushing would CREATE a second item rather than update one.\n  Pull it first:  iris atlas:item pull <id> --out ${file}`)
      process.exitCode = 1
      return
    }
    await executePublish({ ...(args as any), file, update: Number(local.fm.iris_item_id), force: Boolean(args.force) } as any)
  },
})

// ============================================================================
// Atlas Item CLI — publish/share Atlas (bloq) items with a public URL.
//
// Customer-facing branded surface over the bloq-item endpoints. Shares logic
// with `iris bloqs publish/share` via ./bloq-item-shared so they never drift.
// ============================================================================

const AtlasItemPublishCommand = cmd({
  command: "publish [files..]",
  aliases: ["sync"],
  describe: "publish markdown file(s) as Atlas items (private by default — add --public for a shareable URL; globs ok; re-run to sync)",
  builder: (yargs) =>
    yargs
      .positional("files", { describe: "one or more markdown (.md) files (e.g. ./docs/*.md)", type: "string", demandOption: true })
      .option("bloq-item", {
        describe: "share an EXISTING item by id instead of publishing a file (same as make-public)",
        type: "number",
        alias: ["bloqItem", "item"],
      })
      .option("bloq", { describe: "target bloq ID (default: prompt, or auto 'Published Docs')", type: "number" })
      .option("list", { describe: "target list (ID or name; created if missing)", type: "string" })
      .option("title", { describe: "override the item title (single file only)", type: "string" })
      .option("public", { describe: "make the item publicly shareable (private by default)", type: "boolean", default: false })
      .option("password", { describe: "share behind a password (implies --public)", type: "string" })
      .option("expires", { describe: "expiring link — ISO date/time, e.g. 2026-12-31 (implies --public)", type: "string" })
      .option("private", { describe: "force private (override; default is already private)", type: "boolean", default: false })
      .option("new", { describe: "publish a SECOND item even though one with this title already exists in the list", type: "boolean", default: false })
      .option("update", { describe: "sync into this existing item ID instead of creating a new one (single file only)", type: "number" })
      .option("force", { describe: "overwrite even if the item was edited in the UI after the last publish", type: "boolean", default: false })
      .option("force-public", { describe: "consent to making it PUBLIC — REQUIRED when there is no terminal", type: "boolean", default: false })
      .option("format", { describe: "content format: html or markdown (default: from the file extension)", type: "string", choices: ["html", "markdown"] })
      .option("no-frontmatter", { describe: "don't write iris_item_id/iris_public_url back into the file", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executePublishMany({ ...(args as any), files: (args as any).files })
  },
})

const AtlasItemUnpublishCommand = cmd({
  command: "unpublish <file>",
  describe: "make the item a markdown file points at private again (--delete to remove it)",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "the published markdown file (reads iris_item_id from frontmatter)", type: "string", demandOption: false })
      .option("delete", { describe: "also delete the bloq item (not just unshare)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executeUnpublish(args as any)
  },
})

const AtlasItemListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your published (public) Atlas items + their URLs",
  builder: (yargs) =>
    yargs
      .option("bloq", { describe: "limit to a single bloq ID (default: scan your bloqs)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executeListPublished(args as any)
  },
})

const AtlasItemShareCommand = cmd({
  command: "make-public <item-id>",
  aliases: ["share", "publish-item"],
  describe: "make an existing Atlas item publicly shareable and print its public URL",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to share", type: "number", demandOption: true })
      .option("password", { describe: "share behind a password", type: "string" })
      .option("expires", { describe: "expiring link — ISO date/time, e.g. 2026-12-31", type: "string" })
      .option("allowed-emails", { describe: "gate the link to these named, address-verified emails (required for PHI-classified items)", type: "array", string: true })
      .option("allowed-domains", { describe: "gate the link to these bare domains, e.g. vanguard.com", type: "array", string: true })
      .option("force", { describe: "consent to widening exposure — REQUIRED when there is no terminal", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executeMakePublic(args as any)
  },
})

const AtlasItemUnshareCommand = cmd({
  command: "make-private <item-id>",
  aliases: ["unshare"],
  describe: "revoke public sharing for an Atlas item",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to unshare", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executeMakePrivate(args as any)
  },
})

/** The subcommand set, mounted identically wherever this group appears. */
const mountItemVerbs = (y: any) =>
  y
    .command(AtlasItemPublishCommand)
    .command(AtlasItemPullCommand)
    .command(AtlasItemDiffCommand)
    .command(AtlasItemPushCommand)
    .command(AtlasItemUnpublishCommand)
    .command(AtlasItemListCommand)
    .command(AtlasItemShareCommand)
    .command(AtlasItemUnshareCommand)
    .demandCommand()

export const PlatformAtlasItemCommand = cmd({
  command: "atlas:item",
  aliases: ["atlas-item"],
  describe: "Atlas items as files — pull, diff, push, publish & share",
  builder: mountItemVerbs,
  async handler() {},
})

/**
 * `iris atlas doc publish <id>` / `iris atlas note publish <id>`.
 *
 * People reach for the word for the THING — a doc, a note — not for the word the schema uses.
 * Both were being typed and both failed, and a command that does not exist fails the same way
 * as one that is broken.
 *
 * Deliberately an ALIAS, not a second implementation: it mounts the exact command objects
 * `atlas:item` mounts, so `doc publish` and `atlas:item publish` cannot drift into meaning
 * different things. Two commands that are supposed to be the same are only the same until
 * someone edits one of them.
 */
export const AtlasDocCommand = cmd({
  command: "doc",
  aliases: ["note", "document", "docs", "notes"],
  describe: "alias for atlas:item — publish & share a doc/note (e.g. iris atlas doc publish 180288)",
  builder: mountItemVerbs,
  async handler() {},
})
