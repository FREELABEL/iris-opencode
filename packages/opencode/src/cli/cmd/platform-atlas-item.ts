import { cmd } from "./cmd"
import { executePublish, executePublishMany, executeMakePublic, executeMakePrivate, executeUnpublish, executeListPublished } from "./bloq-item-shared"

// ============================================================================
// Atlas Item CLI — publish/share Atlas (bloq) items with a public URL.
//
// Customer-facing branded surface over the bloq-item endpoints. Shares logic
// with `iris bloqs publish/share` via ./bloq-item-shared so they never drift.
// ============================================================================

const AtlasItemPublishCommand = cmd({
  command: "publish <files..>",
  aliases: ["sync"],
  describe: "publish markdown file(s) as public Atlas items (globs ok; re-run to sync)",
  builder: (yargs) =>
    yargs
      .positional("files", { describe: "one or more markdown (.md) files (e.g. ./docs/*.md)", type: "string", demandOption: true })
      .option("bloq", { describe: "target bloq ID (default: prompt, or auto 'Published Docs')", type: "number" })
      .option("list", { describe: "target list (ID or name; created if missing)", type: "string" })
      .option("title", { describe: "override the item title (single file only)", type: "string" })
      .option("public", { describe: "make the item publicly shareable (private by default)", type: "boolean", default: false })
      .option("password", { describe: "share behind a password (implies --public)", type: "string" })
      .option("expires", { describe: "expiring link — ISO date/time, e.g. 2026-12-31 (implies --public)", type: "string" })
      .option("private", { describe: "force private (override; default is already private)", type: "boolean", default: false })
      .option("force", { describe: "overwrite even if the item was edited in the UI after the last publish", type: "boolean", default: false })
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
      .positional("file", { describe: "the published markdown file (reads iris_item_id from frontmatter)", type: "string", demandOption: true })
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

export const PlatformAtlasItemCommand = cmd({
  command: "atlas:item",
  aliases: ["atlas-item"],
  describe: "publish & share Atlas items (markdown → public URL)",
  builder: (y) =>
    y
      .command(AtlasItemPublishCommand)
      .command(AtlasItemUnpublishCommand)
      .command(AtlasItemListCommand)
      .command(AtlasItemShareCommand)
      .command(AtlasItemUnshareCommand)
      .demandCommand(),
  async handler() {},
})
