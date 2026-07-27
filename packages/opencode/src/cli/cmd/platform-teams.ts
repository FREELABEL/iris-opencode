import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"

// ============================================================================
// iris teams — Teams (pods): named, mixed human+AI subsets of a board's roster.
//
// Parity with the Elon agents tab Teams builder over TeamController — all
// bloq-scoped, owner-authed server-side (#177806):
//   GET    /api/v1/bloqs/{id}/teams              → index    (list)
//   POST   /api/v1/bloqs/{id}/teams              → store    (create)
//   PATCH  /api/v1/teams/{id}                    → update   (rename)
//   DELETE /api/v1/teams/{id}                    → destroy  (delete)
//   POST   /api/v1/teams/{id}/members            → addMember    (add)
//   DELETE /api/v1/teams/{id}/members/{agentId}  → removeMember (remove)
//
// A Team is a pod — e.g. "Intake Pod" = 2 people + 2 AI. Members come from
// bloq_agents (type=human|ai), so one team mixes humans and AI freely. Distinct
// from a Workspace (the whole 1:1 board roster). IRIS-owned; never syncs to Google.
// ============================================================================

/** Run an authed request, honour --json, surface API errors consistently. */
async function call(action: string, path: string, init: RequestInit = {}): Promise<any | null> {
  const token = await requireAuth()
  if (!token) {
    prompts.outro("Done")
    return null
  }
  const res = await irisFetch(path, init)
  const ok = await handleApiError(res, action)
  if (!ok) {
    prompts.outro("Done")
    return null
  }
  return (await res.json()) as any
}

/** One-line summary of a team's membership: "2 people · 2 agents". */
function memberSummary(t: any): string {
  const people = t?.people_count ?? 0
  const agents = t?.agent_count ?? 0
  return `${people} ${people === 1 ? "person" : "people"} ${dim("·")} ${agents} ${agents === 1 ? "agent" : "agents"}`
}

// ----------------------------------------------------------------------------
// teams list <bloqId>
// ----------------------------------------------------------------------------

const ListCommand = cmd({
  command: "list <bloqId>",
  aliases: ["ls"],
  describe: "list the teams (pods) on a bloq/board + their members",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Teams · List")
    const data = await call("List teams", `/api/v1/bloqs/${args.bloqId}/teams`)
    if (!data) return
    const payload = data?.data ?? data
    const teams: any[] = payload?.teams ?? []
    if (args.json) {
      console.log(JSON.stringify(teams, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    if (!teams.length) {
      console.log(`  ${dim("No teams on bloq")} #${args.bloqId}`)
      console.log(`  ${dim("create one:")} ${highlight(`iris teams create ${args.bloqId} --name "Intake Pod" --members 1,2,3`)}`)
    } else {
      for (const t of teams) {
        console.log(`  ${bold(t.name)}  ${dim("#" + t.id)}  ${memberSummary(t)}`)
        for (const m of t.members ?? []) {
          const kind = m.is_human ? "👤" : "🤖"
          console.log(`      ${kind} ${m.name} ${dim("#" + m.id)}${m.role ? dim(" · " + m.role) : ""}`)
        }
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// teams create <bloqId> --name [--color] [--description] [--members 1,2,3]
// ----------------------------------------------------------------------------

const CreateCommand = cmd({
  command: "create <bloqId>",
  aliases: ["new"],
  describe: "create a team (pod) — optionally seed it with members (humans + AI)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("name", { type: "string", demandOption: true, describe: "team name (e.g. 'Intake Pod')" })
      .option("color", { type: "string", describe: "UI accent hex (e.g. #cc252c)" })
      .option("description", { type: "string" })
      .option("members", { type: "string", describe: "comma-separated agent IDs to add (humans and/or AI)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Teams · Create")
    const memberIds = (args.members ?? "")
      .split(",")
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => Number.isFinite(n))
    const body: Record<string, unknown> = { name: args.name }
    if (args.color) body.color = args.color
    if (args.description) body.description = args.description
    if (memberIds.length) body.member_ids = memberIds
    const data = await call("Create team", `/api/v1/bloqs/${args.bloqId}/teams`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const t = (data?.data ?? data)?.team
    if (args.json) {
      console.log(JSON.stringify(t, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ created")} ${bold(t?.name)} ${dim("#" + t?.id)} ${dim("→ bloq")} #${args.bloqId}`)
    console.log(`  ${dim("Members:")} ${memberSummary(t)}`)
    console.log(`  ${dim("add more:")} ${highlight(`iris teams add ${t?.id} <agentId>`)}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// teams add <teamId> <agentId> [--role]
// ----------------------------------------------------------------------------

const AddCommand = cmd({
  command: "add <teamId> <agentId>",
  describe: "add an agent (human or AI) to a team",
  builder: (yargs) =>
    yargs
      .positional("teamId", { type: "number", demandOption: true })
      .positional("agentId", { type: "number", demandOption: true })
      .option("role", { type: "string", describe: "role on this team (e.g. lead)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Teams · Add member")
    const body: Record<string, unknown> = { agent_id: args.agentId }
    if (args.role) body.role = args.role
    const data = await call("Add member", `/api/v1/teams/${args.teamId}/members`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const t = (data?.data ?? data)?.team
    if (args.json) {
      console.log(JSON.stringify(t, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ added")} ${dim("agent")} #${args.agentId} ${dim("→")} ${bold(t?.name)}`)
    console.log(`  ${dim("Members:")} ${memberSummary(t)}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// teams remove <teamId> <agentId>
// ----------------------------------------------------------------------------

const RemoveCommand = cmd({
  command: "remove <teamId> <agentId>",
  aliases: ["rm"],
  describe: "remove an agent from a team",
  builder: (yargs) =>
    yargs
      .positional("teamId", { type: "number", demandOption: true })
      .positional("agentId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Teams · Remove member")
    const data = await call("Remove member", `/api/v1/teams/${args.teamId}/members/${args.agentId}`, {
      method: "DELETE",
    })
    if (!data) return
    const t = (data?.data ?? data)?.team
    if (args.json) {
      console.log(JSON.stringify(t, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ removed")} ${dim("agent")} #${args.agentId} ${dim("from")} ${bold(t?.name)}`)
    console.log(`  ${dim("Members:")} ${memberSummary(t)}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// teams delete <teamId>
// ----------------------------------------------------------------------------

const DeleteCommand = cmd({
  command: "delete <teamId>",
  aliases: ["del"],
  describe: "delete a team (does not delete its members)",
  builder: (yargs) =>
    yargs
      .positional("teamId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Teams · Delete")
    const data = await call("Delete team", `/api/v1/teams/${args.teamId}`, { method: "DELETE" })
    if (!data) return
    if (args.json) {
      console.log(JSON.stringify(data?.data ?? data, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ deleted")} ${dim("team")} #${args.teamId}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// Parent command
// ----------------------------------------------------------------------------

export const PlatformTeamsCommand = cmd({
  command: "teams",
  aliases: ["team", "pods"],
  describe: "Teams (pods) — named, mixed human+AI subsets of a board's roster",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(CreateCommand)
      .command(AddCommand)
      .command(RemoveCommand)
      .command(DeleteCommand)
      .demandCommand(),
  async handler() {},
})
