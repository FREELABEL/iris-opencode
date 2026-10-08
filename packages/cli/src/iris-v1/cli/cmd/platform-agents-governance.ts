import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, success, writeJson, IRIS_API } from "./iris-api"
import { resolveBloqId } from "./platform-bloqs"

/**
 * `iris agents pause|resume|stop` — the kill switch, from the terminal (#187908).
 *
 * The server routes existed (POST /api/v1/agents/{id}/pause|resume|terminate, secured in
 * #187897), but no command reached them, so stopping a misbehaving agent meant the web UI or a
 * hand-built curl. They live on iris-api (IRIS_API), not fl-api, and authenticate with the same
 * bearer every other command sends; only the agent's creator or the bloq owner may act.
 *
 * What a pause DOES is enforced server-side at the entry of every run lane — chat, Slack and
 * the other channels, workspace runs, heartbeats, and approved actions waiting to execute.
 * This file only flips the switch and reports what the server says it is now.
 *
 * `stop` maps to terminate and is one-way: the server refuses to resume a terminated agent.
 * There is deliberately no `stop --all` — an irreversible action across a whole workspace is
 * one typo from disaster; `pause --all` is the workspace kill switch, and it is reversible.
 */

export type GovernanceAction = "pause" | "resume" | "stop"

export interface GovernanceTarget {
  id?: number | string
  all?: boolean
  bloq?: number
}

/** The request a governance action makes, or the reason it cannot be made. Pure — no network. */
export function governanceRequest(
  action: GovernanceAction,
  target: GovernanceTarget,
): { path: string; scope: "agent" | "bloq" } | { error: string } {
  const hasId = target.id !== undefined && target.id !== null && String(target.id).trim() !== ""

  if (target.all) {
    if (hasId) return { error: "Pass an agent id OR --all, not both." }
    if (action === "stop") {
      return {
        error:
          "stop --all is not supported: stop terminates, and that cannot be undone. " +
          "Use `iris agents pause --all --bloq <id>` to halt a workspace (reversible), then stop agents one at a time.",
      }
    }
    if (!target.bloq || !Number.isInteger(target.bloq) || target.bloq <= 0) {
      return { error: "--all needs the workspace: pass --bloq <id>." }
    }
    return { path: `/api/v1/bloqs/${target.bloq}/agents/${action}`, scope: "bloq" }
  }

  if (!hasId) return { error: `Which agent? Pass an id (iris agents ${action} <id>) or --all --bloq <id>.` }
  const id = Number(target.id)
  if (!Number.isInteger(id) || id <= 0) return { error: `"${target.id}" is not an agent id — expected a positive number.` }

  const verb = action === "stop" ? "terminate" : action
  return { path: `/api/v1/agents/${id}/${verb}`, scope: "agent" }
}

type Fetcher = (path: string, init: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init, IRIS_API)

/** POST the action. The fetcher is injectable so the round-trip is testable without a server. */
export async function sendGovernance(
  action: GovernanceAction,
  target: GovernanceTarget,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ error: string } | { res: Response; scope: "agent" | "bloq" }> {
  const req = governanceRequest(action, target)
  if ("error" in req) return req
  const res = await fetcher(req.path, { method: "POST", body: "{}" })
  return { res, scope: req.scope }
}

/** One human line for what the server reports. */
export function summarize(action: GovernanceAction, body: any): string {
  const past = action === "pause" ? "paused" : action === "resume" ? "resumed" : "stopped"
  if (body && typeof body.count === "number") {
    const released = body.released_approvals ? ` — ${body.released_approvals} held approval(s) released` : ""
    return `${body.count} agent(s) in bloq #${body.bloq_id} ${past}${released}`
  }
  const a = body?.agent ?? {}
  const name = a.name ? ` (${a.name})` : ""
  const released = body?.released_approvals ? ` — ${body.released_approvals} held approval(s) released` : ""
  return `Agent #${a.id}${name} ${past} — status: ${a.health_status}${released}`
}

async function runGovernance(action: GovernanceAction, args: any): Promise<void> {
  const json = !!args.json
  const title = action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Stop"
  if (!json) { UI.empty(); prompts.intro(`◈  ${title} ${args.all ? "Workspace Agents" : `Agent #${args.id}`}`) }

  const fail = async (msg: string) => {
    if (json) await writeJson({ success: false, error: msg })
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 1
  }

  // Validate before any network so a usage mistake is deterministic and offline. A bloq NAME
  // needs a lookup, so for this offline check it stands in as a valid id; it is resolved below.
  const bloqArg = args.bloq
  const needsBloqLookup = args.all && bloqArg !== undefined && !/^\d+$/.test(String(bloqArg))
  const preflight = governanceRequest(action, {
    id: args.id,
    all: !!args.all,
    bloq: needsBloqLookup ? 1 : bloqArg !== undefined ? Number(bloqArg) : undefined,
  })
  if ("error" in preflight) return fail(preflight.error)

  const token = await requireAuth()
  if (!token) { if (json) await writeJson({ success: false, error: "not authenticated" }); else prompts.outro("Done"); return }

  let bloq = bloqArg !== undefined && !needsBloqLookup ? Number(bloqArg) : undefined
  if (needsBloqLookup) {
    const userId = await requireUserId(args["user-id"])
    if (!userId) return fail("no user id")
    const resolved = await resolveBloqId(String(bloqArg), userId, json)
    if (!resolved) { if (!json) prompts.outro("Done"); return }
    bloq = resolved
  }

  // stop is one-way. Confirm unless scripted (--json / --force).
  if (action === "stop" && !args.force && !json) {
    const ok = await prompts.confirm({ message: `Stop (terminate) agent #${args.id}? It cannot be resumed afterwards.` })
    if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
  }

  const spinner = json ? null : prompts.spinner()
  spinner?.start(`${title}…`)
  try {
    const sent = await sendGovernance(action, { id: args.id, all: !!args.all, bloq })
    if ("error" in sent) { spinner?.stop("Failed", 1); return fail(sent.error) }

    const ok = await handleApiError(sent.res, `${title} agent`)
    if (!ok) { spinner?.stop("Failed", 1); if (!json) prompts.outro("Done"); return }

    const body = await sent.res.json().catch(() => ({}))
    if (json) {
      await writeJson(body)
    } else {
      spinner!.stop(`${success("✓")} ${summarize(action, body)}`)
      prompts.outro(dim(action === "pause" ? "Runs in chat, channels, workspaces and heartbeats are refused until resume." : "iris agents list"))
    }
  } catch (err) {
    spinner?.stop("Error", 1)
    return fail(err instanceof Error ? err.message : String(err))
  }
}

const sharedOptions = (yargs: any, allowAll: boolean) => {
  let y = yargs
    .option("json", { describe: "JSON output (implies non-interactive)", type: "boolean", default: false })
    .option("user-id", { describe: "user ID (or IRIS_USER_ID env) — only used to resolve a bloq by name", type: "number" })
  if (allowAll) {
    y = y
      .option("all", { describe: "every agent in a workspace (bloq owner only); needs --bloq", type: "boolean", default: false })
      .option("bloq", { describe: "workspace (bloq) id or name, with --all", type: "string" })
  }
  return y
}

export const AgentsPauseCommand = cmd({
  command: "pause [id]",
  describe: "pause an agent (or --all in a workspace): every run lane refuses it until resume",
  builder: (yargs) =>
    sharedOptions(yargs.positional("id", { describe: "agent ID", type: "string" }), true)
      .example("iris agents pause 42", "pause agent #42")
      .example("iris agents pause --all --bloq 550", "pause every runnable agent in bloq #550"),
  async handler(args) {
    await runGovernance("pause", args)
  },
})

export const AgentsResumeCommand = cmd({
  command: "resume [id]",
  describe: "resume a paused agent (or --all manually paused agents in a workspace)",
  builder: (yargs) =>
    sharedOptions(yargs.positional("id", { describe: "agent ID", type: "string" }), true)
      .example("iris agents resume 42", "resume agent #42 and release its held approvals")
      .example("iris agents resume --all --bloq 550", "resume the manually paused agents in bloq #550"),
  async handler(args) {
    await runGovernance("resume", args)
  },
})

export const AgentsStopCommand = cmd({
  command: "stop <id>",
  describe: "stop (terminate) an agent — permanent, cannot be resumed",
  builder: (yargs) =>
    sharedOptions(yargs.positional("id", { describe: "agent ID", type: "string", demandOption: true }), false)
      .option("force", { alias: "f", describe: "skip confirmation", type: "boolean", default: false }),
  async handler(args) {
    await runGovernance("stop", args)
  },
})
