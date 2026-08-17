import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, writeJson } from "./iris-api"

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

    // #158137: this reported as "sharing is broken — add succeeds, list is empty, the row never
    // persists". The row DID persist. Verified in production: user_bloq_users has had
    // rdelgado (5365) and dbaker (5485) on bloqs 368/378/402 since 2026-07-06, and the endpoint
    // returns both with HTTP 200. The bug was here, in the reader.
    //
    // The API answers { success, message, data: { shared_users: [...] } }, so `data.data` is an
    // OBJECT. The old code did `Array.isArray(raw) ? raw : []` — the isArray check failed and it
    // SILENTLY substituted an empty list. A populated payload rendered as "(no members)", which
    // reads exactly like a failed write and sent the investigation at the database for a month.
    //
    // Unwrap the envelope first, then look for the collection by name.
    const payload = data?.data ?? data
    const raw = payload?.shared_users ?? payload?.users ?? payload

    // Do NOT quietly coerce an unexpected shape to empty — that is the whole defect. An empty
    // list and "the response was not what we expected" are different facts and must look different.
    if (!Array.isArray(raw)) {
      prompts.outro("Done")
      UI.error(
        `Unexpected response shape from shared-users — expected a list, got ${
          raw === null || raw === undefined ? String(raw) : Array.isArray(raw) ? "array" : typeof raw
        }. Keys: ${payload && typeof payload === "object" ? Object.keys(payload).join(", ") || "(none)" : "n/a"}`,
      )
      return
    }

    const users: any[] = raw
    if (args.json) { await writeJson(users); prompts.outro("Done"); return }
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
  describe: "invite a user by email (optionally scoped to one list or item)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("email", { alias: "e", type: "string", demandOption: true })
      .option("name", { type: "string" })
      .option("permission", { alias: "p", type: "string", default: "viewer" })
      // #179082 — scope the grant. Default stays the whole bloq so existing
      // behaviour is unchanged; these narrow it.
      .option("scope-list", { type: "number", describe: "grant access to ONE list only" })
      .option("scope-item", { type: "number", describe: "grant access to ONE item only" })
      .option("scope-own", { type: "boolean", default: false, describe: "grant access only to rows this person authored" })
      // Sending mail is OPT-IN. The old --no-email flag never worked: it sent
      // `send_email`, but the API reads `send_notification_email` and defaults it
      // to TRUE — so every invite mailed someone regardless of the flag. Making
      // it explicit means an agent minting invites cannot silently email people.
      .option("send-email", { type: "boolean", default: false, describe: "actually email the invitation (default: do not send)" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Invite ${args.email}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const scopes = [args["scope-list"] != null, args["scope-item"] != null, args["scope-own"]].filter(Boolean)
    if (scopes.length > 1) {
      prompts.log.error("Pick at most one of --scope-list, --scope-item, --scope-own")
      prompts.outro("Done")
      return
    }

    const payload: any = {
      email: args.email,
      permission: args.permission,
      send_notification_email: args["send-email"],
    }
    if (args.name) payload.name = args.name
    if (args["scope-list"] != null) { payload.scope_type = "list"; payload.scope_id = args["scope-list"] }
    else if (args["scope-item"] != null) { payload.scope_type = "item"; payload.scope_id = args["scope-item"] }
    else if (args["scope-own"]) { payload.scope_type = "own" }

    const res = await irisFetch(`/api/v1/user/bloqs/${args.bloqId}/invite`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Invite")
    if (!ok) { prompts.outro("Done"); return }

    const scopeLabel = payload.scope_type
      ? `${payload.scope_type}${payload.scope_id ? ` #${payload.scope_id}` : ""}`
      : "whole bloq"
    prompts.log.info(`Scope: ${scopeLabel}`)
    if (!args["send-email"]) prompts.log.info("No email sent — re-run with --send-email to notify them")
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
  aliases: ["members", "team", "share", "invite"],
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
