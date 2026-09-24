import { spawnSync } from "child_process"
import { UI } from "../ui"
import { irisFetch, IRIS_API, dim, bold, highlight, printDivider } from "./iris-api"
import { loadIndex, searchCapabilities } from "./platform-find"

/**
 * `iris intent "<what you want to do>"` — TOOL SELECTION: the one iris command to run.
 *
 * `iris find` is a search and lists what matches. This picks. find's top commands are the
 * candidates; a chooser picks one, because keyword order is often wrong at rank 1 while the right
 * command sits at 2 or 3 (S6, 20 intents: keyword 15/20 at @1, Decide rerank 19/20).
 *
 * Choosers, first that answers wins — it ALWAYS answers:
 *   1. the Decide service   POST $DECIDE_URL/decide (default http://127.0.0.1:3210), a `choice`
 *                           over the candidate names with each command's description as criteria
 *   2. the platform         POST /api/v1/intent with the candidate names as `choices` — the same
 *                           IntentClassifier the agent router uses (nano models), for installs
 *                           with no Decide service
 *   3. find's own order     and it says which chooser failed and why
 * A chooser's answer only counts if it is one of the candidates — never a command it made up.
 *
 * `iris intent "<text>" --choices a,b` is the older classifier and is unchanged.
 */

export type Candidate = { name: string; describe: string; run: string; score: number }
type Pick = { candidate: Candidate; by: string; confidence?: number; ms?: number }

const decideUrl = () => (process.env.DECIDE_URL || "http://127.0.0.1:3210").replace(/\/$/, "")

/**
 * Always offered, whatever the keywords matched: most requests are answered by looking something
 * up — on the web or in your own Atlas — and "find places to eat" shares no word with either.
 */
const GENERAL = ["web-search", "atlas search"]

export function candidatesFor(text: string, limit: number): Candidate[] {
  const index = loadIndex()
  const hits = searchCapabilities(index, text.toLowerCase(), "command", limit).map(({ e, s }) => ({
    name: e.name,
    describe: e.describe,
    run: e.run || `iris ${e.name}`,
    score: s,
  }))
  for (const name of GENERAL) {
    const e = index.entries.find((x) => x.kind === "command" && x.name === name)
    if (e && !hits.some((h) => h.name === name)) hits.push({ name, describe: e.describe, run: e.run, score: 0 })
  }
  return hits
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
 * boundaries — or undefined. This is what stops the planner from inventing a command.
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

export function decidePayload(text: string, candidates: Candidate[]) {
  return {
    state: `User request: "${text}"`,
    questions: {
      command: {
        type: "choice",
        instructions: "Which IRIS CLI command best fulfils the request?",
        options: candidates.map((c) => c.name),
        criteria: Object.fromEntries(candidates.map((c) => [c.name, c.describe || ""])),
      },
    },
  }
}

/** Only an answer that names a candidate counts. */
export const byName = (name: unknown, candidates: Candidate[]) =>
  typeof name === "string" ? candidates.find((c) => c.name === name.trim()) : undefined

async function viaDecide(text: string, candidates: Candidate[], timeoutMs: number): Promise<Pick | string> {
  try {
    const res = await fetch(`${decideUrl()}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decidePayload(text, candidates)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return `Decide: HTTP ${res.status}`
    const r = (await res.json()) as any
    const c = byName(r?.answers?.command?.value, candidates)
    if (!c) return "Decide: answer was not a candidate"
    return {
      candidate: c,
      by: `decide${r?.meta?.engine ? `:${r.meta.engine}` : ""}`,
      confidence: r?.answers?.command?.confidence,
      ms: r?.meta?.latency_ms,
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

const PLANNER_MODEL = "gpt-4.1-nano"

/**
 * The PLANNER: up to 3 complete commands, arguments filled in, for the request — e.g.
 * "find places to eat in austin" -> web-search "places to eat in austin" and an Atlas search for
 * what the user has saved about food. A nano model through the IRIS proxy (the same rail as
 * article-qa), so every signed-in install has it. Every line is checked against the candidates.
 */
async function viaPlanner(text: string, candidates: Candidate[]): Promise<{ lines: string[]; ms: number } | string> {
  const t0 = Date.now()
  const tools = candidates.map((c) => `- ${c.run}  — ${c.describe}`).join("\n")
  try {
    const res = await irisFetch(
      "/api/v6/openai/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: PLANNER_MODEL,
          temperature: 0.2,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You turn a request into IRIS CLI commands. Use ONLY the commands listed, with their exact names, " +
                "and fill every <placeholder> or [optional] argument with concrete text from the request (quote multi-word " +
                "arguments with double quotes). Return 1 to 3 commands, best first. When the request is about finding or " +
                "choosing something in the world (food, places, gifts, trips), answer with a web search first, then " +
                "Atlas searches for PERSONAL context the user may have saved that shapes the choice — e.g. for places " +
                'to eat: atlas search "favorite foods" and atlas search "family". Answer JSON: {"commands":["iris ..."]}.',
            },
            { role: "user", content: `Commands:\n${tools}\n\nRequest: ${text}` },
          ],
        }),
      },
      IRIS_API,
    )
    if (!res.ok) return `planner: HTTP ${res.status}`
    const content: string = ((await res.json()) as any)?.choices?.[0]?.message?.content ?? ""
    const lines = [...new Set(commandLines(content).map((l) => l.trim()))]
      .filter((l) => commandOf(l, candidates) && !/[;&|`$<>]/.test(l.replace(/"[^"]*"/g, "")))
      .slice(0, 3)
    return lines.length ? { lines, ms: Date.now() - t0 } : "planner: no usable command"
  } catch (e) {
    return `planner: ${e instanceof Error ? e.message : String(e)}`
  }
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

export async function selectTool(a: {
  text: string
  json?: boolean
  run?: boolean
  limit?: number
  decide?: boolean
  platform?: boolean
  plan?: boolean
  timeout?: number
}) {
  const text = a.text.trim()
  const candidates = candidatesFor(text, a.limit || 12)
  if (!candidates.length) {
    if (a.json) console.log(JSON.stringify({ query: text, choice: null, run: null, candidates: [] }, null, 2))
    else UI.error(`no iris command matches "${text}" — try: iris find "${text}"`)
    process.exitCode = 1
    return
  }

  const misses: string[] = []
  let pick: Pick | undefined
  let lines: string[] | undefined
  if (a.plan !== false) {
    const r = await viaPlanner(text, candidates)
    if (typeof r === "string") misses.push(r)
    else {
      lines = r.lines
      pick = { candidate: commandOf(r.lines[0], candidates)!, by: `planner:${PLANNER_MODEL}`, ms: r.ms }
    }
  }
  if (!pick && candidates.length === 1) pick = { candidate: candidates[0], by: "only candidate" }
  if (!pick && a.decide !== false) {
    const r = await viaDecide(text, candidates, a.timeout || 20000)
    if (typeof r === "string") misses.push(r)
    else pick = r
  }
  if (!pick && a.platform !== false) {
    const r = await viaPlatform(text, candidates)
    if (typeof r === "string") misses.push(r)
    else pick = r
  }
  const chosen = pick ?? { candidate: candidates[0], by: "keyword" }
  const best = chosen.candidate
  const commands = lines ?? [best.run]

  if (a.json) {
    console.log(
      JSON.stringify(
        {
          query: text,
          choice: best.name,
          run: commands[0],
          commands,
          decided_by: chosen.by,
          confidence: chosen.confidence ?? null,
          ms: chosen.ms ?? null,
          fell_back: misses,
          candidates: candidates.map((c) => ({ name: c.name, score: c.score, describe: c.describe })),
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
    if (best.describe) console.log(`  ${dim(best.describe)}`)
    if (!pick && misses.length) console.log(`  ${dim(`fell back to keyword order — ${misses.join("; ")}`)}`)
    console.log()
    for (const line of commands) console.log(`  ${highlight(`→ ${line}`)}`)
    printDivider()
    console.log(
      `  ${dim("also matched:")} ${dim(
        candidates
          .filter((c) => c !== best)
          .slice(0, 4)
          .map((c) => c.name)
          .join(" · "),
      )}`,
    )
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
