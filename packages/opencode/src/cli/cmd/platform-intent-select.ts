import { spawnSync } from "child_process"
import { UI } from "../ui"
import { irisFetch, IRIS_API, dim, bold, highlight, printDivider } from "./iris-api"
import { loadIndex, searchCapabilities } from "./platform-find"

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
type Pick = { candidate: Candidate; by: string; confidence?: number; ms?: number; extras?: string[] }

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
      web: { type: "boolean", instructions: "Would searching the open web help fulfil this request?" },
      atlas: {
        type: "boolean",
        instructions:
          "Could things the user has saved about themselves — tastes, favourite foods, family, past choices, notes — " +
          "personalise or improve the answer?",
      },
    },
  }
}

/** Decide's yes/no answers -> the extra commands they add beside its pick. */
export function extrasFrom(answers: any, picked: string, candidates: Candidate[]): string[] {
  const out: string[] = []
  const yes = (k: string) => answers?.[k]?.value === true
  if (yes("web") && picked !== "web-search" && candidates.some((c) => c.name === "web-search")) out.push("web-search")
  if (yes("atlas") && picked !== "atlas search" && candidates.some((c) => c.name === "atlas search"))
    out.push("atlas search")
  return out
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
      extras: extrasFrom(r?.answers, c.name, candidates),
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
  (_all ??= loadIndex()
    .entries.filter((e) => e.kind === "command")
    .map((e) => ({ name: e.name, describe: e.describe, run: e.run, score: 0 })))

/** The command with its first placeholder filled by the request itself — the no-model fallback. */
export function heuristicFill(c: Candidate, text: string): string {
  const q = `"${text.replace(/"/g, "'")}"`
  return /<[^>]+>|\[[^\]]+\]/.test(c.run)
    ? c.run.replace(/<[^>]+>|\[[^\]]+\]/, q).replace(/\s*(<[^>]+>|\[[^\]]+\])/g, "")
    : c.run
}

/**
 * ARGUMENTS ONLY. Decide has already chosen `chosen`; a nano model (IRIS proxy, the article-qa
 * rail) writes their arguments — the web query, and for atlas search the PERSONAL context worth
 * looking up (e.g. "favorite foods", "family"). A line for any command not in `chosen` is dropped,
 * so the model cannot change the decision. Any command it leaves out gets heuristicFill.
 */
async function fillArguments(text: string, chosen: Candidate[]): Promise<{ lines: string[]; filled: boolean }> {
  const fallback = { lines: chosen.map((c) => heuristicFill(c, text)), filled: false }
  const spec = chosen.map((c) => `- ${c.run}  — ${c.describe}`).join("\n")
  try {
    const res = await irisFetch(
      "/api/v6/openai/chat/completions",
      {
        method: "POST",
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
                "multi-word arguments). For `iris atlas search`, give up to 2 searches for PERSONAL context the user may " +
                'have saved that shapes the answer (for places to eat: "favorite foods" and "family"). ' +
                'Answer JSON: {"commands":["iris ..."]}.',
            },
            { role: "user", content: `Commands:\n${spec}\n\nRequest: ${text}` },
          ],
        }),
      },
      IRIS_API,
    )
    if (!res.ok) return fallback
    const content: string = ((await res.json()) as any)?.choices?.[0]?.message?.content ?? ""
    // Resolved against EVERY command, not just the chosen ones: "iris leads pull" starts with the
    // chosen `leads` but is a different command — the filler must not change Decide's decision.
    const lines = [...new Set(commandLines(content).map((l) => l.trim()))].filter((l) => {
      const c = commandOf(l, chosen)
      return c && commandOf(l, allCommands())?.name === c.name && !/[;&|`$<>]/.test(l.replace(/"[^"]*"/g, ""))
    })
    // Every chosen command appears: filled if the model covered it, heuristically if it did not.
    const out: string[] = []
    for (const c of chosen) {
      const mine = lines.filter((l) => commandOf(l, chosen) === c).slice(0, c.name === "atlas search" ? 2 : 1)
      out.push(...(mine.length ? mine : [heuristicFill(c, text)]))
    }
    return { lines: out, filled: lines.length > 0 }
  } catch {
    return fallback
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
  fill?: boolean
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
  if (candidates.length === 1) pick = { candidate: candidates[0], by: "only candidate" }
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
  const picked = [best, ...(chosen.extras ?? []).map((n) => candidates.find((c) => c.name === n)!).filter(Boolean)]
  const filled =
    a.fill === false
      ? { lines: picked.map((c) => heuristicFill(c, text)), filled: false }
      : await fillArguments(text, picked)
  const commands = filled.lines

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
          arguments_by: filled.filled ? FILL_MODEL : "request text",
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
