import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, dim, bold, success, writeJson, IRIS_API } from "./iris-api"

/**
 * `iris mint agent seal|versions|stop|resume` — mint an agent: seal one exact version to a hash
 * (#190380 SH-05, epic #184944 step 3).
 *
 * The owner's rules (2026-10-21), which the server enforces and this file only reports:
 *   - a version is a key: a sealed version is never edited; a change is a new version, new hash
 *   - production calls a hash: a hash can be STOPPED, never changed
 *   - deleting an agent retires its name; its versions stay on record
 *
 * Routes live on iris-api (AgentMintController), owner only. A refusal comes back with a `reason`
 * code; each code has its own plain-words line below, and a refusal always exits 1 — a seal that
 * reads as success when it refused is the failure #184944 is written against.
 *
 * NOT here yet (#184944): the ledger account asset:agent:<hash12> (steps 1-2), the run-time gate
 * that refuses an unknown or stopped hash (step 4), the usage policy condition (step 5). So `stop`
 * records the stop; it does not yet halt runs — `iris agents pause` does that today, and the output
 * says so rather than implying otherwise.
 */

export type MintAgentAction = "seal" | "versions" | "stop" | "resume"

/** Plain words for every reason the server can give. One line each, no codes in the sentence. */
export const REFUSAL_TEXT: Record<string, string> = {
  no_model: "No model is set, so the agent would run on whatever the platform default is that day.",
  model_not_pinned: "The model is not pinned to one exact model (an alias such as auto, latest or a brand name moves).",
  unknown_tools: "The agent lists tools the tool registry does not know.",
  no_identity: "The agent has no system prompt, so it has no identity to seal.",
  unchanged: "Nothing changed since the version production calls, so there is nothing to seal.",
  already_sealed: "This exact agent is already sealed as an earlier version; a hash is never sealed twice.",
  not_owner: "No agent you own has that id.",
  no_such_version: "That agent has no sealed version with that number.",
}

/** The request an action makes, or why it cannot be made. Pure — no network. */
export function mintAgentRequest(
  action: MintAgentAction,
  id: unknown,
  version?: unknown,
): { method: "GET" | "POST"; path: string } | { error: string } {
  const agent = Number(id)
  if (id === undefined || id === null || String(id).trim() === "" || !Number.isInteger(agent) || agent <= 0) {
    return { error: `"${id ?? ""}" is not an agent id — expected a positive number (iris mint agent ${action} <id>).` }
  }
  if (action === "seal") return { method: "POST", path: `/api/v1/agents/${agent}/mint/seal` }
  if (action === "versions") return { method: "GET", path: `/api/v1/agents/${agent}/mint/versions` }

  const v = Number(String(version ?? "").replace(/^v/i, ""))
  if (!Number.isInteger(v) || v <= 0) {
    return { error: `"${version ?? ""}" is not a version — expected a number like 3 or v3 (iris mint agent ${action} ${agent} <version>).` }
  }
  return { method: "POST", path: `/api/v1/agents/${agent}/mint/versions/${v}/${action}` }
}

type Fetcher = (path: string, init: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init, IRIS_API)

export type MintAgentResult =
  | { ok: true; status: number; body: any }
  | { ok: false; status: number; reason: string; body: any }

/** Send the action and classify the answer. The fetcher is injectable so this runs without a server. */
export async function sendMintAgent(
  action: MintAgentAction,
  id: unknown,
  version?: unknown,
  fetcher: Fetcher = defaultFetcher,
): Promise<MintAgentResult | { error: string }> {
  const req = mintAgentRequest(action, id, version)
  if ("error" in req) return req
  const res = await fetcher(req.path, req.method === "POST" ? { method: "POST", body: "{}" } : { method: "GET" })
  const body: any = await res.json().catch(() => ({}))
  if (res.ok && body?.success !== false) return { ok: true, status: res.status, body }
  const reason = typeof body?.reason === "string" ? body.reason : res.status === 401 ? "unauthenticated" : `http_${res.status}`
  return { ok: false, status: res.status, reason, body }
}

/** The lines a person reads for a refusal: the plain headline, then every condition the server named. */
export function describeRefusal(action: MintAgentAction, reason: string, body: any): string[] {
  const verb = action === "seal" ? "Not sealed" : action === "versions" ? "No versions shown" : action === "stop" ? "Not stopped" : "Not resumed"
  const head = REFUSAL_TEXT[reason]
    ?? (reason === "unauthenticated" ? "You are not signed in (iris auth login)." : body?.message || body?.error || `The server answered ${reason}.`)
  const lines = [`${verb}: ${head}`]
  const problems: any[] = Array.isArray(body?.problems) ? body.problems : []
  for (const p of problems) {
    if (p?.message) lines.push(`  · ${p.message}`)
  }
  if (problems.length === 0 && body?.message && REFUSAL_TEXT[reason] && body.message !== head) lines.push(`  · ${body.message}`)
  return lines
}

export function summarizeSeal(id: unknown, body: any): string {
  return `Sealed agent #${id} as v${body?.version} · hash ${body?.hash12} · name@prod → v${body?.version}`
}

/** One line per version, newest first. */
export function formatVersions(body: any): string[] {
  const rows: any[] = Array.isArray(body?.versions) ? body.versions : []
  if (rows.length === 0) return ["No sealed versions yet — iris mint agent seal <id>"]
  return rows.map((v) => {
    const prod = v.prod ? "  ← prod" : ""
    const when = v.sealed_at ? String(v.sealed_at).slice(0, 10) : ""
    return `  v${v.version}  ${v.hash12}  ${String(v.status).padEnd(7)}  ${v.model ?? "-"}  ${when}${prod}`
  })
}

export function summarizeStatus(action: "stop" | "resume", id: unknown, body: any): string {
  const v = body?.version ?? {}
  const past = action === "stop" ? "stopped" : "resumed"
  if (body?.changed === false) return `v${v.version} (${v.hash12}) was already ${v.status} — nothing changed`
  return `Agent #${id} v${v.version} (${v.hash12}) ${past} — status: ${v.status}`
}

async function runMintAgent(action: MintAgentAction, args: any): Promise<void> {
  const json = !!args.json
  const title = { seal: "Seal", versions: "Versions of", stop: "Stop", resume: "Resume" }[action]
  if (!json) {
    UI.empty()
    prompts.intro(`◈  ${title} agent #${args.id}${args.version !== undefined ? ` v${String(args.version).replace(/^v/i, "")}` : ""}`)
  }

  const fail = async (lines: string[], payload: Record<string, unknown>) => {
    if (json) await writeJson({ success: false, ...payload })
    else {
      prompts.log.error(lines[0])
      for (const l of lines.slice(1)) prompts.log.message(l)
      prompts.outro("Done")
    }
    process.exitCode = 1
  }

  const pre = mintAgentRequest(action, args.id, args.version)
  if ("error" in pre) return fail([pre.error], { reason: "usage", error: pre.error })

  const token = await requireAuth()
  if (!token) return fail(["You are not signed in (iris auth login)."], { reason: "unauthenticated" })

  const spinner = json ? null : prompts.spinner()
  spinner?.start(action === "seal" ? "Sealing…" : action === "versions" ? "Reading…" : `${title}…`)
  let result: MintAgentResult | { error: string }
  try {
    result = await sendMintAgent(action, args.id, args.version)
  } catch (err) {
    spinner?.stop("Error", 1)
    const msg = err instanceof Error ? err.message : String(err)
    return fail([msg], { reason: "network", error: msg })
  }
  if ("error" in result) {
    spinner?.stop("Failed", 1)
    return fail([result.error], { reason: "usage", error: result.error })
  }
  if (!result.ok) {
    spinner?.stop("Refused", 1)
    return fail(describeRefusal(action, result.reason, result.body), { ...result.body, reason: result.reason, status: result.status })
  }

  const body = result.body
  if (json) return writeJson(body)

  if (action === "seal") {
    spinner!.stop(`${success("✓")} ${summarizeSeal(args.id, body)}`)
    for (const w of body?.warnings ?? []) prompts.log.warn(w)
    prompts.log.message(dim(`hash ${body?.hash}`))
    prompts.outro(dim(`A sealed version is never edited — change the agent and seal again for v${Number(body?.version) + 1}. Stop it: iris mint agent stop ${args.id} ${body?.version}`))
    return
  }
  if (action === "versions") {
    spinner!.stop(`${bold(String((body?.versions ?? []).length))} sealed version(s)${body?.agent_exists === false ? " — agent deleted; its versions stay on record" : ""}`)
    for (const line of formatVersions(body)) console.log(line)
    prompts.outro(dim(body?.prod ? `name@prod → v${body.prod.version} (${body.prod.hash12})` : "iris mint agent seal " + args.id))
    return
  }
  spinner!.stop(`${success("✓")} ${summarizeStatus(action, args.id, body)}`)
  prompts.outro(
    dim(
      action === "stop"
        ? `Recorded. Runs do not check sealed hashes yet (#184944 step 4); to halt the agent itself now: iris agents pause ${args.id}`
        : "iris mint agent versions " + args.id,
    ),
  )
}

const jsonOption = (y: any) => y.option("json", { describe: "JSON output (implies non-interactive)", type: "boolean", default: false })
const idPositional = (y: any) => y.positional("id", { describe: "agent ID", type: "string", demandOption: true })

const SealCommand = cmd({
  command: "seal <id>",
  describe: "seal the agent as it is now to a hash — a new version that is never edited; name@prod points at it",
  builder: (y) => jsonOption(idPositional(y)).example("iris mint agent seal 42", "seal agent #42 (refuses, by name, an unpinned model, unknown tools, no prompt, or no change)"),
  async handler(args) {
    await runMintAgent("seal", args)
  },
})

const VersionsCommand = cmd({
  command: "versions <id>",
  aliases: ["ls"],
  describe: "every sealed version of an agent, newest first, with its hash and status",
  builder: (y) => jsonOption(idPositional(y)),
  async handler(args) {
    await runMintAgent("versions", args)
  },
})

const versionPositional = (y: any) => y.positional("version", { describe: "version number (3 or v3)", type: "string", demandOption: true })

const StopCommand = cmd({
  command: "stop <id> <version>",
  describe: "stop a sealed version — its status changes, nothing else; resume undoes it",
  builder: (y) => jsonOption(versionPositional(idPositional(y))),
  async handler(args) {
    await runMintAgent("stop", args)
  },
})

const ResumeCommand = cmd({
  command: "resume <id> <version>",
  describe: "resume a stopped version",
  builder: (y) => jsonOption(versionPositional(idPositional(y))),
  async handler(args) {
    await runMintAgent("resume", args)
  },
})

export const MintAgentCommand = cmd({
  command: "agent",
  aliases: ["agents"],
  describe: "mint an agent — seal one exact version to a hash; stop or resume a version (never edit one)",
  builder: (y) => y.command(SealCommand).command(VersionsCommand).command(StopCommand).command(ResumeCommand).demandCommand(),
  async handler() {},
})
