import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, dim, success, writeJson, IRIS_API } from "./iris-api"
import {
  resolveParticipant,
  isValidRole,
  participantPathSegment,
  isNodeParticipant,
  nodeIdFromParticipant,
  isSessionParticipant,
  sessionIdFromParticipant,
  ROLES,
} from "./rooms-participants"
import { readParticipant, roleUpdateBody } from "./workspace-rooms-core"

/**
 * Room membership, including for MACHINES — S1 of #185277 (epic #503, list #1688).
 *
 * The endpoints already existed: `POST /api/threads/{id}/agents` and
 * `DELETE /api/threads/{id}/agents/{agentId}`. Only the CLI never exposed them, which is why
 * "rooms join/leave" read as a missing feature in #184778 when it was a missing command.
 *
 * Verified against the live API before this was written: a node-shaped participant
 * (`node:<uuid>`, role `observer`) is accepted with 200 and appears in the thread, and removing
 * it with the id URL-encoded returns 200 and it is gone. No migration, no new participant type,
 * no external-agent credentials.
 */

async function changeMembership(
  args: any,
  mode: "join" | "leave" | "role",
): Promise<void> {
  const isJoin = mode === "join"
  const isRole = mode === "role"
  if (!args.json) { UI.empty(); prompts.intro(isJoin ? "◈  Join Room" : isRole ? "◈  Room Role" : "◈  Leave Room") }

  const fail = async (msg: string) => {
    if (args.json) await writeJson({ error: msg })
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 1
  }

  // Validate the role OURSELVES so a typo is a sentence, not a 422 validation blob.
  if ((isJoin || isRole) && !isValidRole(String(args.role))) {
    return fail(`Unknown role "${args.role}". Use one of: ${ROLES.join(", ")}.`)
  }

  const who = resolveParticipant({
    agent: args.agent,
    node: args.node,
    session: args.session,
    thisNode: Boolean(args["this-node"]),
  })
  if ("error" in who) return fail(who.error)

  const token = await requireAuth()
  if (!token) { if (!args.json) prompts.outro("Done"); return }

  const thread = encodeURIComponent(String(args.thread))
  // participantPathSegment, not the raw id: `node:` carries a COLON into a URL path. Unencoded
  // the request reads as a different path and the answer looks like "not a participant" rather
  // than "your URL was wrong".
  // IRIS_API explicitly: irisFetch defaults to FL_API, and the thread endpoints live on
  // iris-api. Omitting it returns 404 WITH valid auth — which reads as "no such room or
  // participant" when it means "wrong host". Cost a wrong diagnosis before it was spotted.
  const res = isRole
    ? await irisFetch(
        `/api/threads/${thread}/agents/${participantPathSegment(who.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            roleUpdateBody({ role: String(args.role), alwaysOn: typeof args["auto-respond"] === "boolean" ? args["auto-respond"] : null }),
          ),
        },
        IRIS_API,
      )
    : isJoin
    ? await irisFetch(
        `/api/threads/${thread}/agents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: who.id,
            role: String(args.role),
            auto_respond: Boolean(args["auto-respond"]),
          }),
        },
        IRIS_API,
      )
    : await irisFetch(
        `/api/threads/${thread}/agents/${participantPathSegment(who.id)}`,
        { method: "DELETE" },
        IRIS_API,
      )

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    if (isRole && res.status === 404) return fail(`That ${who.id.includes(":") ? "member" : "agent"} is not in this room — add it with \`iris agents join ${args.thread} --agent <id> --role ${args.role}\`.`)
    return fail(`Could not ${isRole ? "change the role" : mode}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`)
  }

  const body = await res.json().catch(() => ({}))
  if (args.json) { await writeJson(body ?? { ok: true }); return }

  const kind = isSessionParticipant(who.id)
    ? `session ${sessionIdFromParticipant(who.id).slice(0, 12)}`
    : isNodeParticipant(who.id)
      ? `machine ${nodeIdFromParticipant(who.id)}`
      : `agent ${who.id}`
  const now = readParticipant(body)
  const leadNote = () => {
    if ((now?.role ?? args.role) === "lead")
      console.log(`  ${dim("it takes your request first and hands parts to the others · one lead per room — any previous lead is now a participant")}`)
  }
  if (isRole) {
    console.log(`  ${success("✓")} ${kind} ${dim("is now")} ${now?.role ?? args.role}${now ? dim(now.alwaysOn ? " · answers everything" : " · answers when @mentioned") : ""}`)
    leadNote()
  } else if (isJoin) {
    console.log(`  ${success("✓")} ${dim("added")} ${kind} ${dim(`as ${now?.role ?? args.role}`)}`)
    leadNote()
    if (!args["auto-respond"] && (now?.role ?? args.role) !== "lead") {
      console.log(`  ${dim("@mention it in the room to reach it — pass --auto-respond for always-on")}`)
    }
    if (isNodeParticipant(who.id)) {
      // Say this HERE, at the moment someone would otherwise wait for a message that never
      // arrives. A machine can be a member; it cannot be a delivery target, because nothing can
      // tell which of its sessions a person is watching.
      console.log(`  ${dim("note: a machine is a member, not an inbox — join with --session <id> to RECEIVE messages")}`)
    }
  } else {
    console.log(`  ${success("✓")} ${dim("removed")} ${kind}`)
  }
  prompts.outro(dim(`iris agents thread ${args.thread}`))
}

const selectors = (yargs: any) =>
  yargs
    .positional("thread", { describe: "thread (room) ID", type: "string" })
    .option("agent", { describe: "bloq agent ID", type: "string" })
    .option("session", {
      describe: "session ID — the terminal that should RECEIVE the room's messages",
      type: "string",
    })
    .option("node", { describe: "node ID, added as a machine participant", type: "string" })
    .option("this-node", { describe: "this machine", type: "boolean", default: false })
    .option("json", { describe: "JSON output", type: "boolean", default: false })
    .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })

export const AgentsJoinCommand = cmd({
  command: "join <thread>",
  describe: "add a participant to a room — an agent (optionally as its lead), a live session, or a machine",
  builder: (yargs: any) =>
    selectors(yargs)
      .option("role", {
        describe: "participant role: lead | participant | primary | support | observer (lead = takes requests first; one per room)",
        type: "string",
        default: "participant",
      })
      .option("auto-respond", {
        describe: "respond without being @mentioned",
        type: "boolean",
        default: false,
      })
      .example("iris agents join <room> --agent 101 --role lead", "add agent 101 as the room's lead")
      .example("iris agents join <room> --session ses_abc123 --auto-respond", "a live chat that receives every message"),
  async handler(args: any) {
    await changeMembership(args, "join")
  },
})

export const AgentsLeaveCommand = cmd({
  command: "leave <thread>",
  describe: "remove a participant from a room — an agent, a live session, or a machine",
  builder: (yargs: any) => selectors(yargs).example("iris agents leave <room> --agent 102", "take agent 102 out of the room"),
  async handler(args: any) {
    await changeMembership(args, "leave")
  },
})

export const AgentsRoleCommand = cmd({
  command: "role <thread> <role>",
  describe: "change a room member's role — make an agent the lead (one per room), or whether it answers everything",
  builder: (yargs: any) =>
    selectors(yargs)
      .positional("role", {
        describe: "lead | participant | primary | support | observer",
        type: "string",
      })
      .option("auto-respond", { describe: "answer every message (--no-auto-respond: only when @mentioned); unchanged if omitted", type: "boolean" })
      .example("iris agents role <room> lead --agent 101", "agent 101 leads; the previous lead becomes a participant")
      .example("iris agents role <room> participant --agent 102 --auto-respond", "102 answers every message"),
  async handler(args: any) {
    await changeMembership(args, "role")
  },
})
