import { cmd } from "./cmd"
import { executePublish, executePublishMany, executeMakePublic, executeMakePrivate, executeUnpublish, executeListPublished } from "./bloq-item-shared"

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
    .command(AtlasItemUnpublishCommand)
    .command(AtlasItemListCommand)
    .command(AtlasItemShareCommand)
    .command(AtlasItemUnshareCommand)
    .demandCommand()

export const PlatformAtlasItemCommand = cmd({
  command: "atlas:item",
  aliases: ["atlas-item"],
  describe: "publish & share Atlas items (markdown → public URL)",
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
