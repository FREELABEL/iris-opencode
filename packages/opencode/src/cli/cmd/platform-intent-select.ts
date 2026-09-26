import { spawnSync } from "child_process"
import { UI } from "../ui"
import { irisFetch, IRIS_API, dim, bold, highlight, printDivider } from "./iris-api"
import { loadIndex, searchCapabilities } from "./platform-find"
import { loadAgents, rankAgents, type AgentCandidate } from "./platform-intent-agents"

/**
 * `iris intent "<what you want to do>"` — TOOL SELECTION, by the Decide engine.
 *
 * `iris find` is traditional search: it lists what matches. `intent` DECIDES. find's top commands
 * are the candidates, and Decide answers three questions about them in one call:
 *   command  which candidate fulfils the request (a `choice`, descriptions as criteria)
 *   web      would a web search help?            (boolean)
 *   atlas    would the user's saved Atlas notes help?  (boolean)
 * That is the decision. A nano model then only FILLS ARGUMENTS for the commands Decide picked —
 * it chooses nothing, and a line for any other command is dropped.
 *
 *   "find places to eat in austin" -> Decide: web-search · web yes · atlas yes
 *     -> iris web-search "places to eat in Austin"
 *        iris atlas search "favorite foods"
 *        iris atlas search "family"
 *
 * Choosers, first that answers: Decide ($DECIDE_URL, default http://127.0.0.1:3210); the platform
 * classifier (/api/v1/intent — for installs with no Decide service); find's own order. It always
 * answers, and says which failed and why. Keyword order alone is 5/20 at @1 on our intent set;
 * Decide is 16/20.
 *
 * `iris intent "<text>" --choices a,b` is the older label classifier and is unchanged.
 */

export type Candidate = { name: string; describe: string; run: string; score: number }
type AgentPick = { candidate: Candidate; confidence: number; delegate: number }
type Pick = { candidate: Candidate; by: string; confidence?: number; ms?: number; extras?: string[]; agent?: AgentPick }

/** Lines built whole, never argument-filled by a model: playbooks and agent hand-offs. */
export const prebuilt = (c: { name: string }) => c.name.startsWith("playbook run ") || c.name.startsWith("agent ")

const decideUrl = () => (process.env.DECIDE_URL || "http://127.0.0.1:3210").replace(/\/$/, "")

/**
 * WHERE A DECISION IS MADE (#186675). A Decide service on this machine first — it answers in one
 * local hop and can route PHI to a local model — then the platform's `/api/v1/decide`, which runs
 * the same Jev decision on the platform's key with the user's IRIS token. The platform leg is what
 * every client install uses: before it, the local service existed on one machine and every other
 * install fell back to keyword order.
 */
let localDown = false
export async function postDecide(
  body: object,
  timeoutMs: number,
): Promise<{ json: any; via: "local" | "platform" } | string> {
  const errs: string[] = []
  if (!localDown) {
    try {
      const res = await fetch(`${decideUrl()}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return { json: await res.json(), via: "local" }
      errs.push(`local HTTP ${res.status}`)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (/refused|Unable to connect|fetch failed|ECONN/i.test(m)) localDown = true
      errs.push(localDown ? "no local service" : `local: ${m}`)
    }
  }
  try {
    const res = await irisFetch(
      "/api/v1/decide",
      { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) },
      IRIS_API,
    )
    const j = (await res.json().catch(() => ({}))) as any
    if (res.ok && j?.answers) return { json: j, via: "platform" }
    errs.push(`platform: ${j?.error ?? j?.message ?? `HTTP ${res.status}`}`)
  } catch (e) {
    errs.push(`platform: ${e instanceof Error ? e.message : String(e)}`)
  }
  return `Decide: ${errs.join("; ")}`
}

/**
 * Always offered, whatever the keywords matched: most requests are answered by looking something
 * up — on the web or in your own Atlas — and "find places to eat" shares no word with either.
 */
const GENERAL = ["web-search", "atlas search"]

/**
 * A command GROUP ("genesis", "geo") only lists its subcommands; offered as an answer, Decide took
 * `iris genesis` for "build a website" at 31% (measured). A candidate is dropped when another
 * command extends its name — unless nothing else matched.
 */
export function leafOnly(cands: Candidate[], allNames: string[]): Candidate[] {
  const leaves = cands.filter(
    (c) => c.name.includes("playbook run ") || !allNames.some((n) => n.startsWith(c.name + " ")),
  )
  return leaves.length ? leaves : cands
}

/** The index and its command names, read ONCE per process — `intent` used to re-parse per step. */
let _index: ReturnType<typeof loadIndex> | undefined
let _names: string[] | undefined
const index = () => (_index ??= loadIndex())
const commandNames = () =>
  (_names ??= index()
    .entries.filter((e) => e.kind === "command")
    .map((e) => e.name))

/**
 * ONE ranking per step gives both lists: the short list Decide picks from (`pick`) and the wide
 * list it ranks for "also relevant" (`pool`). It was two searches per step at ~95ms each (measured).
 */
export function candidatePools(
  text: string,
  pickLimit: number,
  poolLimit = 40,
): { pick: Candidate[]; pool: Candidate[] } {
  const q = text.toLowerCase()
  const leaves = leafOnly(
    searchCapabilities(index(), q, "command", Math.max(pickLimit, poolLimit) + 6).map(({ e, s }) => ({
      name: e.name,
      describe: e.describe,
      run: e.run || `iris ${e.name}`,
      score: s,
    })),
    commandNames(),
  )
  // PLAYBOOKS are answers too: "build a website" is best served by a playbook, not a raw command.
  // Offered as GUIDED PROJECTS, so a single action ("report a bug") still goes to its command:
  // unlabelled, playbooks won 3 of 20 simple requests from the right command (measured).
  // Top 5 playbooks (#186666 A5): the first 2 are offered for the PICK (more let playbooks steal
  // single-action requests — 3 of 20, measured), all 5 go to the ranked list, where Jev scores them.
  const playbooks = searchCapabilities(index(), q, "playbook", 5).map(({ e, s }) => ({
    name: `playbook run ${e.name}`,
    describe: `GUIDED PROJECT, not a single action — choose only when the request is a whole multi-step job: ${e.describe}`,
    run: `iris playbook run ${e.name}`,
    score: s,
  }))
  const general = (have: Candidate[]) =>
    GENERAL.flatMap((name) => {
      if (have.some((h) => h.name === name)) return []
      const e = index().entries.find((x) => x.kind === "command" && x.name === name)
      return e ? [{ name, describe: e.describe, run: e.run, score: 0 }] : []
    })
  const pick = [...leaves.slice(0, pickLimit), ...playbooks.slice(0, 2)]
  const pool = [...leaves.slice(0, poolLimit), ...playbooks]
  return { pick: [...pick, ...general(pick)], pool: [...pool, ...general(pool)] }
}

export function candidatesFor(text: string, limit: number): Candidate[] {
  return candidatePools(text, limit, limit).pick
}

/** Split a command line the way a shell would for quoted words: iris atlas search "family" -> 4 args. */
export function argv(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * Which candidate a full command line runs — the LONGEST candidate name it starts with, on word
 * boundaries — or undefined. This is what stops a model from inventing a command.
 */
export function commandOf(line: string, candidates: Candidate[]): Candidate | undefined {
  const words = argv(line.trim())
  if (words[0] !== "iris") return undefined
  const rest = words.slice(1)
  let best: Candidate | undefined
  for (const c of candidates) {
    const n = c.name.split(" ")
    if (n.every((w, i) => rest[i] === w) && (!best || n.length > best.name.split(" ").length)) best = c
  }
  return best
}

/**
 * A request can be several jobs: "transcribe this video and build a website from it" is a
 * transcribe AND a Genesis page, and one `choice` can only name one of them (measured: it named
 * transcribe and dropped the website). Split on "and"/"then" before a verb; at most 3 steps.
 */
const STEP_VERBS =
  "build|make|create|transcribe|publish|send|write|schedule|connect|find|search|add|run|post|email|book|generate|turn|summari[sz]e|draft|deploy|upload|share|clip|translate|post|design|launch|set up|setup|import|export|analy[sz]e"
export function splitSteps(text: string): string[] {
  const re = new RegExp(
    `\\s*(?:,\\s*)?(?:\\band then\\b|\\bthen\\b|\\bafter that\\b|\\band\\b)\\s+(?=(?:${STEP_VERBS})\\b)`,
    "i",
  )
  const parts = text
    .split(re)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts.slice(0, 3) : [text]
}

export function decidePayload(
  text: string,
  candidates: Candidate[],
  full = text,
  extras = true,
  agents: AgentCandidate[] = [],
) {
  const agentQs =
    extras && agents.length >= 2
      ? {
          // (#186666 A2) Same call, two more questions: which of the account's agents, and whether
          // handing the job to an agent beats running one command at all.
          agent: {
            type: "choice",
            instructions: "Which of the user's AI agents is best suited to take on this request?",
            options: agents.map((a) => a.name),
            criteria: Object.fromEntries(agents.map((a) => [a.name, a.describe])),
            allow_none: true,
          },
          delegate: {
            type: "boolean",
            instructions:
              "Is this a job to hand to an AI agent (ongoing work, research, writing, outreach, judgement) rather than " +
              "something one CLI command does?",
          },
        }
      : {}
  return {
    state: full === text ? `User request: "${text}"` : `User request: "${full}"\nThis step of it: "${text}"`,
    questions: {
      command: {
        type: "choice",
        instructions: "Which IRIS CLI command best fulfils the request?",
        options: candidates.map((c) => c.name),
        criteria: Object.fromEntries(candidates.map((c) => [c.name, c.describe || ""])),
      },
      web: { type: "boolean", instructions: "Would searching the open web help fulfil this request?" },
      atlas: {
        type: "boolean",
        instructions:
          "Could things the user has saved about themselves — tastes, favourite foods, family, past choices, notes — " +
          "personalise or improve the answer?",
      },
      ...agentQs,
    },
  }
}

function withoutExtras(payload: ReturnType<typeof decidePayload>) {
  const { command } = payload.questions
  return { ...payload, questions: { command } }
}

export const EXTRA_MIN = 0.65

/** Decide's yes/no answers -> the extra commands they add beside its pick. */
export function extrasFrom(answers: any, picked: string, candidates: Candidate[]): string[] {
  const out: string[] = []
  // A CONFIDENT yes only. At 0.5 it added a web search to "transcribe <url>" (p=0.52) and an
  // Atlas search for favourite foods to a coffee-shop website.
  const yes = (k: string) =>
    answers?.[k]?.value === true &&
    Number(answers?.[k]?.probabilities?.true ?? answers?.[k]?.confidence ?? 0) >= EXTRA_MIN
  if (yes("web") && picked !== "web-search" && candidates.some((c) => c.name === "web-search")) out.push("web-search")
  if (yes("atlas") && picked !== "atlas search" && candidates.some((c) => c.name === "atlas search"))
    out.push("atlas search")
  return out
}

/** Decide's agent answer, only if it named one of the offered agents (never "none of these"). */
export function agentFrom(answers: any, agents: AgentCandidate[]): AgentPick | undefined {
  const name = answers?.agent?.value
  const a = typeof name === "string" ? agents.find((x) => x.name === name) : undefined
  if (!a) return undefined
  const delegate = Number(
    answers?.delegate?.probabilities?.true ??
      (answers?.delegate?.value === true ? answers?.delegate?.confidence : 0) ??
      0,
  )
  return { candidate: a, confidence: Number(answers?.agent?.confidence ?? 0), delegate }
}

/**
 * Hand the job to the agent only when Decide is sure it's an agent's job AND sure which agent.
 * Set from the bench (script/intent-cases.json, 2026-09-24): every real agent job scored delegate
 * ≥ 0.78 and agent ≥ 0.87; at 0.65 / 0.5, 9 of 24 command requests also handed off ("send an email
 * to a client" → an outreach agent at 0.89 / 0.53). At 0.75 / 0.85: 10/10 agent jobs, 1/24
 * command requests (a website → the Web Designer Agent, 0.93 / 0.95 — defensible). Ten agent
 * cases set this line; widen the case set before trusting it further.
 */
export const AGENT_DELEGATE_MIN = 0.75
export const AGENT_CONFIDENCE_MIN = 0.85
export const handsOff = (a?: AgentPick) =>
  !!a && a.delegate >= AGENT_DELEGATE_MIN && a.confidence >= AGENT_CONFIDENCE_MIN

/** Only an answer that names a candidate counts. */
export const byName = (name: unknown, candidates: Candidate[]) =>
  typeof name === "string" ? candidates.find((c) => c.name === name.trim()) : undefined

async function viaDecide(
  text: string,
  candidates: Candidate[],
  timeoutMs: number,
  full = text,
  extras = true,
  agents: AgentCandidate[] = [],
): Promise<Pick | string> {
  try {
    const payload = decidePayload(text, candidates, full, extras, agents)
    const sent = await postDecide(extras ? payload : withoutExtras(payload), timeoutMs)
    if (typeof sent === "string") return sent
    const r = sent.json as any
    const c = byName(r?.answers?.command?.value, candidates)
    if (!c) return "Decide: answer was not a candidate"
    return {
      candidate: c,
      by: `decide${r?.meta?.engine ? `:${r.meta.engine}` : ""}${sent.via === "platform" ? ` (platform${r?.meta?.cache === "hit" ? ", cached" : ""})` : ""}`,
      confidence: r?.answers?.command?.confidence,
      ms: r?.meta?.latency_ms,
      extras: extrasFrom(r?.answers, c.name, candidates),
      agent: agentFrom(r?.answers, agents),
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return /refused|Unable to connect|fetch failed|ECONN/i.test(m) ? "Decide: not running" : `Decide: ${m}`
  }
}

async function viaPlatform(text: string, candidates: Candidate[]): Promise<Pick | string> {
  try {
    const res = await irisFetch(
      "/api/v1/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, choices: candidates.map((c) => c.name) }),
      },
      IRIS_API,
    )
    const d = ((await res.json().catch(() => ({}))) as any)?.data ?? {}
    if (!res.ok) return `platform: ${d?.error ?? `HTTP ${res.status}`}`
    const c = byName(d.choice, candidates)
    if (!c) return "platform: answer was not a candidate"
    return { candidate: c, by: `platform${d.decided_by ? `:${d.decided_by}` : ""}`, confidence: d.confidence, ms: d.ms }
  } catch (e) {
    return `platform: ${e instanceof Error ? e.message : String(e)}`
  }
}

const FILL_MODEL = "gpt-4.1-nano"

let _all: Candidate[] | undefined
/** Every command in the index, as candidates — to resolve what a filled line REALLY runs. */
const allCommands = () =>
  (_all ??= index()
    .entries.filter((e) => e.kind === "command")
    .map((e) => ({ name: e.name, describe: e.describe, run: e.run, score: 0 })))

/** "find places to eat in austin" -> "places to eat in austin": the request's topic, not its verb. */
export function topicOf(text: string): string {
  const t = text
    .trim()
    .replace(
      /^(?:(?:please|can you|could you|i want to|i need to|help me|let'?s)\s+)*(?:find|search(?: for)?|look ?up|show me|get me|get|give me|tell me|what are|what is|list|see)\s+/i,
      "",
    )
    .replace(/[?.!]+$/, "")
  return t || text.trim()
}

/**
 * The no-model fallback: fill a placeholder only from what the request actually supplies — a URL
 * for <url>, the request's TOPIC for a [query]. Anything else stays a placeholder (and --run refuses
 * it); pasting the whole sentence into `transcribe [url]` was worse than asking.
 */
export function heuristicFill(c: Candidate, text: string): string {
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  const q = `"${topicOf(text).replace(/"/g, "'")}"`
  let used = false
  return c.run
    .replace(/<([^>]+)>|\[([^\]]+)\]/g, (m, req, opt) => {
      const name = String(req ?? opt).toLowerCase()
      if (used) return opt ? "" : m
      const input = /url|link|file|path|source/.test(name)
      if (input && url) return ((used = true), url)
      if (/query|text|search|q\b|message|topic|prompt|question|term/.test(name)) return ((used = true), q)
      // An optional INPUT the request did not supply stays visible as <url>: dropping it made
      // "transcribe this video" come out as a bare `iris transcribe`, hiding the one thing the
      // user has to add. --run refuses anything still holding a <placeholder>.
      if (input) return `<${name.replace(/\.\.$/, "")}>`
      return opt ? "" : m
    })
    .replace(/\s+/g, " ")
    .trim()
}

const FILL_TIMEOUT_MS = 12_000
const FILL_ATTEMPTS = 2

/** One filler call -> the valid lines it produced, per chosen command. Never throws. */
async function fillOnce(text: string, chosen: Candidate[], signal: AbortSignal): Promise<Map<string, string[]>> {
  const got = new Map<string, string[]>()
  const spec = chosen.map((c) => `- ${c.run}  — ${c.describe}`).join("\n")
  try {
    const res = await irisFetch(
      "/api/v6/openai/chat/completions",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          model: FILL_MODEL,
          temperature: 0.2,
          // The IRIS proxy spends tokens on a <think> preamble even for nano (#186551); 300 ran out
          // inside it and returned no commands at all (finish_reason "length").
          max_tokens: 1500,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Fill in the arguments of the given IRIS CLI commands for the request. Use exactly these commands, in this " +
                "order, and no others. Replace every <placeholder> or [optional] argument with concrete text (double-quote " +
                "multi-word arguments). Use only values the request gives or clearly implies; if a required value is " +
                "missing (a URL, a file), keep its <placeholder>. For `iris atlas search`, give up to 2 searches for " +
                "PERSONAL context the user may have saved that is about THIS request (e.g. for places to eat: favourite " +
                "foods, family). Playbook commands take no arguments. " +
                'Answer JSON: {"commands":["iris ..."]}.',
            },
            { role: "user", content: `Commands:\n${spec}\n\nRequest: ${text}` },
          ],
        }),
      },
      IRIS_API,
    )
    if (!res.ok) return got
    const content: string = ((await res.json()) as any)?.choices?.[0]?.message?.content ?? ""
    for (const l of new Set(commandLines(content).map((x) => x.trim()))) {
      const c = commandOf(l, chosen)
      if (!c || prebuilt(c)) continue
      // Resolved against EVERY command, not just the chosen ones: "iris leads pull" starts with the
      // chosen `leads` but is a different command — the filler must not change Decide's decision.
      const bare = l.replace(/"[^"]*"/g, "").replace(/<[^>\s]+>/g, "")
      if (commandOf(l, allCommands())?.name !== c.name || /[;&|`$<>]/.test(bare)) continue
      got.set(c.name, [...(got.get(c.name) ?? []), l])
    }
  } catch {}
  return got
}

/** Lines that still hold a <placeholder> are worse than lines that do not. */
const filledScore = (lines: string[] = []) => lines.filter((l) => !/<[^>]+>/.test(l.replace(/"[^"]*"/g, ""))).length

/**
 * ARGUMENTS ONLY. Decide has already chosen `chosen`; a nano model (IRIS proxy, the article-qa
 * rail) writes their arguments — the web query, and for atlas search the PERSONAL context worth
 * looking up (e.g. "favorite foods", "family"). A line for any command not in `chosen` is dropped,
 * so the model cannot change the decision.
 *
 * HEDGED, because one call is flaky (measured, 6 runs: 3.7–20.8s; one returned nothing, two
 * covered only some commands). Two calls race; the first to cover EVERY command wins at once, and
 * otherwise, at the 12s limit, each command takes the best line either call produced. A command
 * neither covered gets heuristicFill — the request's topic, never the whole sentence.
 */
export async function fillArguments(text: string, chosen: Candidate[]): Promise<{ lines: string[]; filled: boolean }> {
  const needs = chosen.filter((c) => !prebuilt(c))
  const results: Map<string, string[]>[] = []
  if (needs.length) {
    const controller = new AbortController()
    const covers = (m: Map<string, string[]>) => needs.every((c) => filledScore(m.get(c.name)) > 0 || m.has(c.name))
    await new Promise<void>((resolve) => {
      let settled = 0
      const timer = setTimeout(resolve, FILL_TIMEOUT_MS)
      for (let i = 0; i < FILL_ATTEMPTS; i++) {
        fillOnce(text, needs, controller.signal).then((m) => {
          results.push(m)
          if (covers(m) || ++settled === FILL_ATTEMPTS) {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    })
    controller.abort()
  }
  const out: string[] = []
  let filled = false
  for (const c of chosen) {
    if (prebuilt(c)) {
      out.push(c.run)
      continue
    }
    const best = results
      .map((m) => m.get(c.name) ?? [])
      .filter((l) => l.length)
      .sort((a, b) => filledScore(b) - filledScore(a))[0]
    if (best) {
      filled = true
      out.push(...best.slice(0, c.name === "atlas search" ? 2 : 1))
    } else out.push(heuristicFill(c, text))
  }
  return { lines: out, filled }
}

/**
 * The command lines in a model reply, tolerant of the IRIS proxy: it prefixes a <think> block even
 * for non-reasoning models and can drop the first tokens after it (#186551), so the JSON's opening
 * may be missing. Every quoted "iris …" string is taken instead of parsing the envelope.
 */
export function commandLines(content: string): string[] {
  const body = content.replace(/<think>[\s\S]*?<\/think>/g, "")
  const out: string[] = []
  for (const m of body.matchAll(/"(iris (?:[^"\\]|\\.)*)"/g)) {
    try {
      out.push(JSON.parse(`"${m[1]}"`))
    } catch {}
  }
  return out
}

/** A command still carrying a <required> placeholder cannot be run as-is. */
export const needsArgument = (run: string) => /<[^>]+>/.test(run)

/**
 * MANY COMMANDS, not one (5–30). Decide answers one yes/no relevance question per candidate in a
 * single call — measured 40 questions in 368ms — and the candidates are ranked by p(yes).
 * Kept: everything at p ≥ RELATED_MIN, padded to at least RELATED_FLOOR, capped at `top`.
 */
export const RELATED_MIN = 0.25
/** Promote the ranking's top command over the pick when it is at least this sure, and this much surer. */
export const PROMOTE_MIN = 0.7
export const PROMOTE_MARGIN = 0.15
/** ...and only when the pick itself was unsure. A 63% pick of `integrations connect` lost to a
 *  bare `connect` at 80% before this guard (measured). */
export const PROMOTE_UNSURE = 0.6
export const RELATED_FLOOR = 5

export type Related = Candidate & { p: number }

export function rankRelated(
  pool: Candidate[],
  probs: (number | undefined)[],
  top: number,
  exclude: Set<string>,
): Related[] {
  const ranked = pool
    .map((c, i) => ({ ...c, p: probs[i] ?? 0 }))
    .filter((c) => !exclude.has(c.name))
    .sort((a, b) => b.p - a.p)
  const keep = ranked.filter((c) => c.p >= RELATED_MIN)
  const out = keep.length >= RELATED_FLOOR ? keep : ranked.slice(0, RELATED_FLOOR)
  return out.slice(0, top)
}

async function viaRelevance(
  text: string,
  pool: Candidate[],
  timeoutMs: number,
): Promise<(number | undefined)[] | string> {
  const questions = Object.fromEntries(
    pool.map((c, i) => [
      `c${i}`,
      {
        type: "boolean",
        instructions: `Would running \`${c.run}\` (${c.describe.slice(0, 140)}) help with this request?`,
      },
    ]),
  )
  try {
    const sent = await postDecide({ state: `User request: "${text}"`, questions }, timeoutMs)
    if (typeof sent === "string") return sent.replace(/^Decide:/, "Decide relevance:")
    const r = sent.json as any
    return pool.map((_, i) => {
      const p = r?.answers?.[`c${i}`]?.probabilities?.true
      return typeof p === "number" ? p : undefined
    })
  } catch (e) {
    return `Decide relevance: ${e instanceof Error ? e.message : String(e)}`
  }
}

export async function selectTool(a: {
  text: string
  json?: boolean
  run?: boolean
  limit?: number
  decide?: boolean
  platform?: boolean
  fill?: boolean
  timeout?: number
  top?: number
  agents?: boolean
}) {
  const text = a.text.trim()
  // Agents load (cache or API) while the index is searched — never on the critical path twice.
  const agentsLoad = a.agents === false ? Promise.resolve({ agents: [], source: "off" }) : loadAgents()
  const steps = splitSteps(text)
  const pools = steps.map((step) => candidatePools(step, a.limit || 12))
  const perStep = pools.map((p) => p.pick)
  const candidates = [...new Map(perStep.flat().map((c) => [c.name, c])).values()]
  if (!perStep.some((c) => c.length)) {
    if (a.json) console.log(JSON.stringify({ query: text, choice: null, run: null, candidates: [] }, null, 2))
    else UI.error(`no iris command matches "${text}" — try: iris find "${text}"`)
    process.exitCode = 1
    return
  }

  // EVERY Decide call runs at once — the per-step picks and the relevance ranking of the wider pool
  // do not depend on each other. Sequentially they added up; in parallel the whole decision costs
  // one Decide round trip (~250–400ms).
  const t0 = Date.now()
  const timing: Record<string, number> = {}
  const top = Math.min(30, Math.max(RELATED_FLOOR, a.top || 10))
  const loaded = await agentsLoad
  const agentCands = rankAgents(text, loaded.agents, index().terms, 8)
  timing.agents_ms = Date.now() - t0
  const pool = [
    ...new Map(
      steps
        .flatMap((_, i) => pools[i].pool)
        .concat(agentCands)
        .concat(candidates)
        .map((c) => [c.name, c]),
    ).values(),
  ]
  const misses: string[] = []
  const decideStep = async (step: string, i: number): Promise<Pick | undefined> => {
    const cands = perStep[i]
    if (!cands.length) return undefined
    if (cands.length === 1) return { candidate: cands[0], by: "only candidate" }
    if (a.decide !== false) {
      const r = await viaDecide(step, cands, a.timeout || 20000, text, i === 0, i === 0 ? agentCands : [])
      if (typeof r !== "string") return r
      misses.push(r)
    }
    if (a.platform !== false) {
      const r = await viaPlatform(step, cands)
      if (typeof r !== "string") return r
      misses.push(r)
    }
    return { candidate: cands[0], by: "keyword" }
  }
  const [stepPicks, relevance] = await Promise.all([
    Promise.all(steps.map(decideStep)),
    a.decide !== false && pool.length ? viaRelevance(text, pool, a.timeout || 20000) : Promise.resolve(undefined),
  ])
  timing.decide_ms = Date.now() - t0
  const picks = stepPicks.filter((p): p is Pick => !!p)

  let relatedBy = "keyword"
  let probs: (number | undefined)[] = pool.map(() => undefined)
  if (typeof relevance === "string") misses.push(relevance)
  else if (relevance) {
    probs = relevance
    relatedBy = "decide"
  }

  // PROMOTE — OFF BY DEFAULT (IRIS_INTENT_PROMOTE=1 to try it). Measured on script/intent-cases.json:
  // 21/24 @1 without it, 18/24 with it — it fixed the coffee-shop case and broke three
  // ("check platform health" → hive doctor). The relevance question is broader than "which command",
  // so it over-rates general tools. The ranked list still shows its top command first.
  // PROMOTE: the ranking asks "would this help?" of every candidate; the pick asks "which one?" of
  // a shorter list. When the ranking is clearly surer about a command than the pick was about its
  // own (coffee shop: genesis compose 80% vs the pick's 57%), that command leads.
  let promoted: string | undefined
  if (relatedBy === "decide" && picks[0] && process.env.IRIS_INTENT_PROMOTE === "1") {
    const pickP = picks[0].confidence ?? 0
    const lead = pool
      .map((c, i) => ({ c, p: probs[i] ?? 0 }))
      .filter((x) => x.c.name !== picks[0].candidate.name && !prebuilt(x.c))
      .sort((x, y) => y.p - x.p)[0]
    if (lead && pickP < PROMOTE_UNSURE && lead.p >= PROMOTE_MIN && lead.p >= pickP + PROMOTE_MARGIN) {
      promoted = lead.c.name
      picks.unshift({
        candidate: lead.c,
        by: `decide relevance (promoted over ${picks[0].candidate.name})`,
        confidence: lead.p,
        extras: picks[0].extras,
      })
      picks[1] = { ...picks[1], extras: [] }
    }
  }

  const chosen = picks[0]
  const best = chosen.candidate
  const extras = picks.flatMap((p) => p.extras ?? [])
  const agentPick = picks[0]?.agent
  const handoff = handsOff(agentPick) ? agentPick!.candidate : undefined
  const picked = [
    ...new Map(
      [
        ...picks.map((p) => p.candidate),
        ...(handoff ? [handoff] : []),
        ...extras.map((n) => candidates.find((c) => c.name === n) ?? pool.find((c) => c.name === n)!).filter(Boolean),
      ].map((c) => [c.name, c]),
    ).values(),
  ]

  // Arguments: instant from the request by default; `--fill` asks a model (3–12s through the proxy).
  const tf = Date.now()
  const filled = a.fill
    ? await fillArguments(text, picked)
    : { lines: picked.map((c) => heuristicFill(c, text)), filled: false }
  timing.fill_ms = Date.now() - tf
  timing.total_ms = Date.now() - t0
  const commands = filled.lines

  const exclude = new Set(picked.map((c) => c.name))
  const related =
    relatedBy === "decide"
      ? rankRelated(pool, probs, top, exclude)
      : pool
          .filter((c) => !exclude.has(c.name))
          .slice(0, top)
          .map((c) => ({ ...c, p: 0 }))

  if (a.json) {
    console.log(
      JSON.stringify(
        {
          query: text,
          choice: best.name,
          run: commands[0],
          commands,
          decided_by: chosen.by,
          decided: picked.map((c) => c.name),
          steps,
          arguments_by: filled.filled ? FILL_MODEL : "request text",
          promoted: promoted ?? null,
          agent: agentPick
            ? {
                id: agentCands.find((c) => c.name === agentPick.candidate.name)?.id ?? null,
                name: agentPick.candidate.name.replace(/^agent \d+ · /, ""),
                confidence: Number(agentPick.confidence.toFixed(2)),
                delegate: Number(agentPick.delegate.toFixed(2)),
                handed_off: !!handoff,
              }
            : null,
          agents_source: loaded.source,
          timing,
          confidence: chosen.confidence ?? null,
          ms: chosen.ms ?? null,
          fell_back: misses,
          related_by: relatedBy,
          related: related.map((c) => ({
            name: c.name,
            run: c.run,
            relevance: relatedBy === "decide" ? Number(c.p.toFixed(2)) : null,
            describe: c.describe,
          })),
        },
        null,
        2,
      ),
    )
  } else {
    UI.empty()
    console.log(`  ${bold("iris intent")}  ${dim(`"${text}"`)}`)
    printDivider()
    const detail = [
      chosen.by,
      chosen.confidence != null ? `${Math.round(chosen.confidence * 100)}%` : null,
      chosen.ms != null ? `${Math.round(chosen.ms)}ms` : null,
    ]
      .filter(Boolean)
      .join(" · ")
    console.log(`  ${bold(best.name)}  ${dim(`(${detail})`)}`)
    if (best.describe)
      console.log(`  ${dim(best.describe.replace(/^GUIDED PROJECT[^:]*: /, "playbook — ").slice(0, 110))}`)
    if (picks.some((p) => p.by === "keyword") && misses.length)
      console.log(`  ${dim(`fell back to keyword order — ${misses.join("; ")}`)}`)
    console.log()
    for (const line of commands) console.log(`  ${highlight(`→ ${line}`)}`)
    printDivider()
    console.log(
      `  ${bold(`also relevant (${related.length})`)}  ${dim(relatedBy === "decide" ? "ranked by Decide" : "find's order — Decide unavailable")}`,
    )
    const w = Math.min(46, Math.max(...related.map((c) => c.run.length), 10))
    for (const c of related) {
      const pct = relatedBy === "decide" ? dim(`${String(Math.round(c.p * 100)).padStart(3)}%`) : dim("  · ")
      console.log(
        `  ${pct}  ${c.run.padEnd(w)}  ${dim(c.describe.replace(/^GUIDED PROJECT[^:]*: /, "playbook — ").slice(0, 60))}`,
      )
    }
    UI.empty()
  }

  if (a.run) {
    const line = commands[0]
    if (needsArgument(line)) {
      console.log(`  ${dim("needs an argument — run it yourself:")} ${highlight(line)}`)
      return
    }
    const [bin, ...rest] = argv(line)
    // `iris …` re-invokes THIS binary, never whatever `iris` is first on PATH.
    const compiled = !process.argv[1] || process.argv[1].startsWith("/$bunfs")
    const r =
      bin === "iris"
        ? spawnSync(process.execPath, compiled ? rest : [process.argv[1], ...rest], { stdio: "inherit" })
        : spawnSync(bin, rest, { stdio: "inherit" })
    process.exitCode = r.status ?? 1
  }
}
