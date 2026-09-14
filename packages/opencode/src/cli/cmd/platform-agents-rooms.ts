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
  mode: "join" | "leave",
): Promise<void> {
  const isJoin = mode === "join"
  if (!args.json) { UI.empty(); prompts.intro(isJoin ? "◈  Join Room" : "◈  Leave Room") }

  const fail = async (msg: string) => {
    if (args.json) await writeJson({ error: msg })
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 1
  }

  // Validate the role OURSELVES so a typo is a sentence, not a 422 validation blob.
  if (isJoin && !isValidRole(String(args.role))) {
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
  const res = isJoin
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
    return fail(`Could not ${mode}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`)
  }

  const body = await res.json().catch(() => ({}))
  if (args.json) { await writeJson(body ?? { ok: true }); return }

  const kind = isSessionParticipant(who.id)
    ? `session ${sessionIdFromParticipant(who.id).slice(0, 12)}`
    : isNodeParticipant(who.id)
      ? `machine ${nodeIdFromParticipant(who.id)}`
      : `agent ${who.id}`
  if (isJoin) {
    console.log(`  ${success("✓")} ${dim("added")} ${kind} ${dim(`as ${args.role}`)}`)
    if (!args["auto-respond"]) {
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
  describe: "add a participant to a room — an agent, or a machine",
  builder: (yargs: any) =>
    selectors(yargs)
      .option("role", {
        describe: `participant role (${ROLES.join(" | ")})`,
        type: "string",
        default: "participant",
      })
      .option("auto-respond", {
        describe: "respond without being @mentioned",
        type: "boolean",
        default: false,
      }),
  async handler(args: any) {
    await changeMembership(args, "join")
  },
})

export const AgentsLeaveCommand = cmd({
  command: "leave <thread>",
  describe: "remove a participant from a room",
  builder: (yargs: any) => selectors(yargs),
  async handler(args: any) {
    await changeMembership(args, "leave")
  },
})
