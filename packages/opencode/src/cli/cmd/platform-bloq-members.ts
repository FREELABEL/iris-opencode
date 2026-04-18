import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success } from "./iris-api"

// Endpoints (from BloqsResource):
//   GET    /api/v1/user/bloqs/{bloqId}/shared-users
//   POST   /api/v1/user/bloqs/{bloqId}/share              { user_id, permission }
//   PUT    /api/v1/user/bloqs/{bloqId}/share/{userId}     { permission }
//   DELETE /api/v1/user/bloqs/{bloqId}/share/{userId}
//   POST   /api/v1/user/bloqs/{bloqId}/invite             { email, name?, permission, send_email }

const ListMembersCommand = cmd({
  command: "list <bloqId>",
  aliases: ["ls"],
  describe: "list bloq team members",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Members — Bloq #${args.bloqId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/shared-users`)
    const ok = await handleApiError(res, "List members")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const raw = data?.data ?? data?.users ?? data
    const users: any[] = Array.isArray(raw) ? raw : []
    if (args.json) { console.log(JSON.stringify(users, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (users.length === 0) console.log(`  ${dim("(no members)")}`)
    else for (const u of users) {
      const name = u.name ?? u.full_name ?? u.user_name ?? u.email ?? `User #${u.id ?? u.user_id}`
      console.log(`  ${bold(String(name))}  ${dim(`#${u.id ?? u.user_id}`)}  ${dim(String(u.permission ?? "viewer"))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const AddMemberCommand = cmd({
  command: "add <bloqId> <userId>",
  aliases: ["share"],
  describe: "share bloq with a user by ID",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("userId", { type: "number", demandOption: true })
      .option("permission", { alias: "p", type: "string", default: "viewer", choices: ["viewer", "editor", "owner"] }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add member`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/share`, {
      method: "POST",
      body: JSON.stringify({ user_id: args.userId, permission: args.permission }),
    })
    const ok = await handleApiError(res, "Add member")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Added user #${args.userId} as ${args.permission}`)
  },
})

const InviteMemberCommand = cmd({
  command: "invite <bloqId>",
  describe: "invite a user by email",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("email", { alias: "e", type: "string", demandOption: true })
      .option("name", { type: "string" })
      .option("permission", { alias: "p", type: "string", default: "viewer" })
      .option("no-email", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Invite ${args.email}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { email: args.email, permission: args.permission, send_email: !args["no-email"] }
    if (args.name) payload.name = args.name
    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/invite`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Invite")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Invited`)
  },
})

const UpdateMemberCommand = cmd({
  command: "update <bloqId> <userId>",
  aliases: ["set-permission"],
  describe: "update a member's permission",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("userId", { type: "number", demandOption: true })
      .option("permission", { alias: "p", type: "string", demandOption: true, choices: ["viewer", "editor", "owner"] }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update permission`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/share/${args.userId}`, {
      method: "PUT",
      body: JSON.stringify({ permission: args.permission }),
    })
    const ok = await handleApiError(res, "Update permission")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

const RemoveMemberCommand = cmd({
  command: "remove <bloqId> <userId>",
  aliases: ["rm", "unshare"],
  describe: "remove a member from a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("userId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove member`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/share/${args.userId}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Remove member")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Removed`)
  },
})

export const PlatformBloqMembersCommand = cmd({
  command: "bloq-members",
  aliases: ["members", "team"],
  describe: "manage bloq team members and sharing permissions",
  builder: (yargs) =>
    yargs
      .command(ListMembersCommand)
      .command(AddMemberCommand)
      .command(InviteMemberCommand)
      .command(UpdateMemberCommand)
      .command(RemoveMemberCommand)
      .demandCommand(),
  async handler() {},
})
