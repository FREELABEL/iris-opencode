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

export function candidatesFor(text: string, limit: number): Candidate[] {
  const index = loadIndex()
  const q = text.toLowerCase()
  const commands = searchCapabilities(index, q, "command", limit + 6).map(({ e, s }) => ({
    name: e.name,
    describe: e.describe,
    run: e.run || `iris ${e.name}`,
    score: s,
  }))
  const allNames = index.entries.filter((e) => e.kind === "command").map((e) => e.name)
  const hits = leafOnly(commands, allNames).slice(0, limit)
  // PLAYBOOKS are answers too: "build a website" is best served by a playbook, not a raw command.
  // Offered as GUIDED PROJECTS, so a single action ("report a bug") still goes to its command:
  // unlabelled, playbooks won 3 of 20 simple requests from the right command (measured).
  for (const { e, s } of searchCapabilities(index, q, "playbook", 2)) {
    hits.push({
      name: `playbook run ${e.name}`,
      describe: `GUIDED PROJECT, not a single action — choose only when the request is a whole multi-step job: ${e.describe}`,
      run: `iris playbook run ${e.name}`,
      score: s,
    })
  }

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

export function decidePayload(text: string, candidates: Candidate[], full = text, extras = true) {
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

/** Only an answer that names a candidate counts. */
export const byName = (name: unknown, candidates: Candidate[]) =>
  typeof name === "string" ? candidates.find((c) => c.name === name.trim()) : undefined

async function viaDecide(
  text: string,
  candidates: Candidate[],
  timeoutMs: number,
  full = text,
  extras = true,
): Promise<Pick | string> {
  try {
    const payload = decidePayload(text, candidates, full)
    const res = await fetch(`${decideUrl()}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(extras ? payload : withoutExtras(payload)),
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

/**
 * The no-model fallback: fill a placeholder only from what the request actually supplies — a URL
 * for <url>, the request for a [query]. Anything else stays a placeholder (and --run refuses it);
 * pasting the whole sentence into `transcribe [url]` was worse than asking.
 */
export function heuristicFill(c: Candidate, text: string): string {
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  const q = `"${text.replace(/"/g, "'")}"`
  let used = false
  return c.run
    .replace(/<([^>]+)>|\[([^\]]+)\]/g, (m, req, opt) => {
      const name = String(req ?? opt).toLowerCase()
      if (used) return opt ? "" : m
      if (/url|link|file|path|source/.test(name) && url) return ((used = true), url)
      if (/query|text|search|q\b|message|topic|prompt|question|term/.test(name)) return ((used = true), q)
      return opt ? "" : m
    })
    .replace(/\s+/g, " ")
    .trim()
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
    if (!res.ok) return fallback
    const content: string = ((await res.json()) as any)?.choices?.[0]?.message?.content ?? ""
    // Resolved against EVERY command, not just the chosen ones: "iris leads pull" starts with the
    // chosen `leads` but is a different command — the filler must not change Decide's decision.
    const lines = [...new Set(commandLines(content).map((l) => l.trim()))].filter((l) => {
      const c = commandOf(l, chosen)
      if (!c || c.name.startsWith("playbook run ")) return false
      const bare = l.replace(/"[^"]*"/g, "").replace(/<[^>\s]+>/g, "")
      return commandOf(l, allCommands())?.name === c.name && !/[;&|`$<>]/.test(bare)
    })
    // Every chosen command appears: filled if the model covered it, heuristically if it did not.
    const out: string[] = []
    for (const c of chosen) {
      if (c.name.startsWith("playbook run ")) {
        out.push(c.run)
        continue
      }
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

/**
 * MANY COMMANDS, not one (5–30). Decide answers one yes/no relevance question per candidate in a
 * single call — measured 40 questions in 368ms — and the candidates are ranked by p(yes).
 * Kept: everything at p ≥ RELATED_MIN, padded to at least RELATED_FLOOR, capped at `top`.
 */
export const RELATED_MIN = 0.25
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
    const res = await fetch(`${decideUrl()}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: `User request: "${text}"`, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return `Decide relevance: HTTP ${res.status}`
    const r = (await res.json()) as any
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
}) {
  const text = a.text.trim()
  const steps = splitSteps(text)
  const perStep = steps.map((step) => candidatesFor(step, a.limit || 12))
  const candidates = [...new Map(perStep.flat().map((c) => [c.name, c])).values()]
  if (!perStep.some((c) => c.length)) {
    if (a.json) console.log(JSON.stringify({ query: text, choice: null, run: null, candidates: [] }, null, 2))
    else UI.error(`no iris command matches "${text}" — try: iris find "${text}"`)
    process.exitCode = 1
    return
  }

  // One decision per step. The web / notes questions are asked once, with the first step, about
  // the WHOLE request.
  const misses: string[] = []
  const picks: Pick[] = []
  for (const [i, step] of steps.entries()) {
    const cands = perStep[i]
    if (!cands.length) continue
    let pick: Pick | undefined
    if (cands.length === 1) pick = { candidate: cands[0], by: "only candidate" }
    if (!pick && a.decide !== false) {
      const r = await viaDecide(step, cands, a.timeout || 20000, text, i === 0)
      if (typeof r === "string") misses.push(r)
      else pick = r
    }
    if (!pick && a.platform !== false) {
      const r = await viaPlatform(step, cands)
      if (typeof r === "string") misses.push(r)
      else pick = r
    }
    picks.push(pick ?? { candidate: cands[0], by: "keyword" })
  }
  const chosen = picks[0]
  const best = chosen.candidate
  const extras = picks.flatMap((p) => p.extras ?? [])
  const picked = [
    ...new Map(
      [
        ...picks.map((p) => p.candidate),
        ...extras.map((n) => candidates.find((c) => c.name === n)!).filter(Boolean),
      ].map((c) => [c.name, c]),
    ).values(),
  ]
  const filled =
    a.fill === false
      ? { lines: picked.map((c) => heuristicFill(c, text)), filled: false }
      : await fillArguments(text, picked)
  const commands = filled.lines

  // RELATED: a wider pool (find's top 40 per step, leaf commands, plus playbooks), ranked by Decide.
  // Without Decide, find's own order stands in — the list is still useful, and says so.
  const top = Math.min(30, Math.max(RELATED_FLOOR, a.top || 10))
  const pool = [
    ...new Map(
      steps
        .flatMap((step) => candidatesFor(step, 40))
        .concat(candidates)
        .map((c) => [c.name, c]),
    ).values(),
  ]
  const exclude = new Set(picked.map((c) => c.name))
  let relatedBy = "keyword"
  let probs: (number | undefined)[] = pool.map(() => undefined)
  if (a.decide !== false && pool.length) {
    const r = await viaRelevance(text, pool, a.timeout || 20000)
    if (typeof r === "string") misses.push(r)
    else {
      probs = r
      relatedBy = "decide"
    }
  }
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
