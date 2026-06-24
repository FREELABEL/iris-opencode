import { cmd } from "./cmd"
import { executePublish, executeMakePublic, executeMakePrivate } from "./bloq-item-shared"

// ============================================================================
// Atlas Item CLI — publish/share a single Atlas (bloq) item with a public URL.
//
// Customer-facing branded surface over the bloq-item endpoints. Shares logic
// with `iris bloqs publish/share` via ./bloq-item-shared so they never drift.
// ============================================================================

const AtlasItemPublishCommand = cmd({
  command: "publish <file>",
  aliases: ["sync"],
  describe: "publish a markdown file as a public Atlas item (returns a shareable URL; re-run to sync)",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to a markdown (.md) file", type: "string", demandOption: true })
      .option("bloq", { describe: "target bloq ID (default: prompt, or auto 'Published Docs')", type: "number" })
      .option("list", { describe: "target list (ID or name; created if missing)", type: "string" })
      .option("title", { describe: "override the item title (default: frontmatter title, first # heading, or filename)", type: "string" })
      .option("private", { describe: "create/update without making it public", type: "boolean", default: false })
      .option("no-frontmatter", { describe: "don't write iris_item_id/iris_public_url back into the file", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executePublish(args as any)
  },
})

const AtlasItemShareCommand = cmd({
  command: "make-public <item-id>",
  aliases: ["share", "publish-item"],
  describe: "make an existing Atlas item publicly shareable and print its public URL",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to share", type: "number", demandOption: true })
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
      .command(AtlasItemShareCommand)
      .command(AtlasItemUnshareCommand)
      .demandCommand(),
  async handler() {},
})
