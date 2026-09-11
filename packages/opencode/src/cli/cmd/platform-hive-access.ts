import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, handleApiError, dim, bold, success, writeJson } from "./iris-api"
import { hiveFetch, resolveNode } from "./platform-hive-nodes"

// ============================================================================
// iris hive access — who may reach a machine (epic #184516, ADR-03)
//
// The CLI over the org-ownership endpoints: place a machine in an organization, and attach or
// detach the users who may reach it. Least privilege is the server's default — an org member
// reaches nothing until an admin grants them a specific machine — so these verbs are the whole
// onboarding: `access org` once, then `access grant` per person.
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Your own node by name/id — or, for an org machine you administer but do not own, its raw id. */
async function nodeIdFor(userId: number, target: string): Promise<{ id: string; name: string } | null> {
  const own = await resolveNode(userId, target)
  if (own) return { id: own.id, name: own.name }
  if (UUID.test(target)) return { id: target, name: target.slice(0, 8) }
  return null
}

const jsonReq = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

async function begin(argv: Record<string, unknown>, title: string): Promise<number | null> {
  if (!argv.json) { UI.empty(); prompts.intro(`◈  ${title}`) }
  const token = await requireAuth()
  if (!token) return null
  return requireUserId(argv["user-id"] as number | undefined)
}

const GrantCommand = cmd({
  command: "grant <node> <user-id>",
  describe: "attach a user to a machine — they can now reach it",
  builder: (y) =>
    y
      .positional("node", { describe: "machine name or id", type: "string", demandOption: true })
      .positional("user-id", { describe: "the user to attach (must already be in the machine's org)", type: "number", demandOption: true })
      .option("role", { describe: "what they may do at the machine", type: "string", default: "operator" })
      .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const userId = await begin(argv as Record<string, unknown>, "Hive Access — grant")
    if (!userId) return
    const node = await nodeIdFor(userId, String(argv.node))
    if (!node) { prompts.log.error(`No node matching "${argv.node}".`); process.exit(1) }

    const res = await hiveFetch(`/api/v6/nodes/${node.id}/users?user_id=${userId}`, jsonReq("POST", {
      user_id: Number(argv["user-id"]),
      role: String(argv.role),
    }))
    if (!(await handleApiError(res, "Grant access"))) process.exit(1)
    const data = (await res.json()) as { attached: { user_id: number; role: string }; can_reach: boolean }

    if (argv.json) { await writeJson(data); return }
    console.log(`  ${success("✓")} user ${bold(String(data.attached.user_id))} attached to ${bold(node.name)} as ${data.attached.role}`)
    console.log(`  ${dim("can reach it now:")} ${data.can_reach ? success("yes") : "no"}`)
    prompts.outro("Done")
  },
})

const RevokeCommand = cmd({
  command: "revoke <node> <user-id>",
  describe: "detach a user from a machine — they can no longer reach it",
  builder: (y) =>
    y
      .positional("node", { type: "string", demandOption: true })
      .positional("user-id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const userId = await begin(argv as Record<string, unknown>, "Hive Access — revoke")
    if (!userId) return
    const node = await nodeIdFor(userId, String(argv.node))
    if (!node) { prompts.log.error(`No node matching "${argv.node}".`); process.exit(1) }

    const res = await hiveFetch(`/api/v6/nodes/${node.id}/users/${Number(argv["user-id"])}?user_id=${userId}`, jsonReq("DELETE"))
    if (!(await handleApiError(res, "Revoke access"))) process.exit(1)
    const data = (await res.json()) as { detached: { user_id: number }; can_reach: boolean }

    if (argv.json) { await writeJson(data); return }
    console.log(`  ${success("✓")} user ${bold(String(data.detached.user_id))} detached from ${bold(node.name)}`)
    console.log(`  ${dim("can reach it now:")} ${data.can_reach ? "yes (still the machine owner, or org all-members is on)" : success("no")}`)
    prompts.outro("Done")
  },
})

const ListCommand = cmd({
  command: "list <node>",
  aliases: ["ls"],
  describe: "who is attached to a machine",
  builder: (y) => y.positional("node", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const userId = await begin(argv as Record<string, unknown>, "Hive Access — list")
    if (!userId) return
    const node = await nodeIdFor(userId, String(argv.node))
    if (!node) { prompts.log.error(`No node matching "${argv.node}".`); process.exit(1) }

    const res = await hiveFetch(`/api/v6/nodes/${node.id}/users?user_id=${userId}`)
    if (!(await handleApiError(res, "List access"))) process.exit(1)
    const data = (await res.json()) as { organization_id: string | null; users: Array<{ user_id: number; role: string; added_by: number | null; created_at: string }> }

    if (argv.json) { await writeJson(data); return }
    console.log(`  ${bold(node.name)}  ${dim(data.organization_id ? `org ${data.organization_id.slice(0, 8)}` : "personal machine — no attachments possible")}`)
    if (data.users.length === 0) { console.log(dim("  nobody attached.")); prompts.outro("Done"); return }
    for (const u of data.users) {
      console.log(`  user ${bold(String(u.user_id))}  ${u.role}  ${dim(`added by ${u.added_by ?? "?"}`)}`)
    }
    prompts.outro("Done")
  },
})

const OrgCommand = cmd({
  command: "org <node> [org-id]",
  describe: "place a machine in an organization (only its owner can; --clear makes it personal again)",
  builder: (y) =>
    y
      .positional("node", { type: "string", demandOption: true })
      .positional("org-id", { describe: "organization id", type: "string" })
      .option("clear", { describe: "remove the machine from its org", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const userId = await begin(argv as Record<string, unknown>, "Hive Access — org")
    if (!userId) return
    const node = await nodeIdFor(userId, String(argv.node))
    if (!node) { prompts.log.error(`No node matching "${argv.node}".`); process.exit(1) }

    let res: Response
    if (argv.clear) {
      res = await hiveFetch(`/api/v6/nodes/${node.id}/organization?user_id=${userId}`, jsonReq("DELETE"))
    } else {
      if (!argv["org-id"]) { prompts.log.error("Give an org id, or --clear."); process.exit(1) }
      res = await hiveFetch(`/api/v6/nodes/${node.id}/organization?user_id=${userId}`, jsonReq("POST", { organization_id: String(argv["org-id"]) }))
    }
    if (!(await handleApiError(res, "Set organization"))) process.exit(1)
    const data = (await res.json()) as { node: { name: string; organization_id: string | null } }

    if (argv.json) { await writeJson(data); return }
    console.log(`  ${success("✓")} ${bold(data.node.name)} → ${data.node.organization_id ? `org ${data.node.organization_id}` : "personal"}`)
    prompts.outro("Done")
  },
})

export const HiveAccessCommand = cmd({
  command: "access",
  describe: "who may reach a machine — grant, revoke, list; place it in an org",
  builder: (y) =>
    y
      .command(GrantCommand)
      .command(RevokeCommand)
      .command(ListCommand)
      .command(OrgCommand)
      .demandCommand(1, "Run iris hive access --help for subcommands"),
  handler() {},
})
