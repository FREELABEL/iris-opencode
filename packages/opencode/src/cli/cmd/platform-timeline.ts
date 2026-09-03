import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, highlight, printDivider, irisFetch, requireAuth, requireUserId, IRIS_API } from "./iris-api"
import { homedir } from "os"
import { join } from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { execFileSync } from "child_process"
import { firstArray } from "../../util/array"

/**
 * `iris timeline` — what happened, across every channel that already writes it down.
 *
 * DELIBERATELY NOT A NEW STORE. The corpus (fl-api `signal_observations`) holds numeric metrics
 * for scoring; a timeline needs EVENTS. Rather than stand up a second spine before knowing the
 * output is useful, this reads the four places that already contain dated, human- or
 * model-written titles:
 *
 *   diary     GET /api/v6/diary/list       126 days already synced, Feb -> Aug
 *   git       commit subjects              across every nested repo
 *   opencode  session `title`              79/79 titled
 *   claude    `ai-title` / `custom-title`  53/68 titled
 *
 * NOTHING IS SYNTHESISED. Every line was already written by a human or by the tool that produced
 * the session, so this cannot hallucinate and needs no model. Persisting these as
 * `signal_episodes` is the follow-up (TL-01) once the shape is proven.
 *
 * SESSION CONTENT IS NEVER READ — titles and timestamps only. `corpus-collect.mjs` established
 * that rule because prompts carry credentials and client data, and this inherits it rather than
 * re-litigating it.
 */

type Episode = { date: string; source: string; title: string; ref?: string }

/**
 * First candidate that is genuinely an ARRAY.
 *
 * `a ?? b ?? []` picks the first non-nullish value, which for `{data:{items:[…]}}` is the `data`
 * OBJECT — and iterating an object yields nothing. The command then reports "0 episodes" against
 * a 200 OK, which is the same confident-omission this tool exists to expose. Check the type.
 */
const SOURCES = ["diary", "git", "opencode", "claude", "comms", "bloq"] as const

/** Sources that cannot run without a scope, and what supplies it. */
const NEEDS_SCOPE: Record<string, string> = { comms: "--lead", bloq: "--bloq" }

/** Field separator for git's pretty-format. Unit Separator cannot occur in a commit subject. */
const SEP = "\x1f"

function parseSince(v: string): Date {
  const m = String(v).match(/^(\d+)\s*(d|w|mo|m|y)?$/i)
  const now = new Date()
  if (!m) return new Date(now.getTime() - 120 * 864e5)
  const n = parseInt(m[1], 10)
  const unit = (m[2] || "d").toLowerCase()
  const days = unit === "y" ? n * 365 : unit === "mo" || unit === "m" ? n * 30 : unit === "w" ? n * 7 : n
  return new Date(now.getTime() - days * 864e5)
}

/** ISO week key (Monday-anchored), so weeks sort lexically. */
function weekKey(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  if (Number.isNaN(d.getTime())) return iso
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

// -- diary --------------------------------------------------------------------

/** The diary is USER-SCOPED; without user_id the endpoint answers for nobody and returns []. */
function sdkUserId(): string | undefined {
  const envPath = join(homedir(), ".iris", "sdk", ".env")
  if (!existsSync(envPath)) return undefined
  const m = readFileSync(envPath, "utf-8").match(/IRIS_USER_ID=(\d+)/)
  return m ? m[1] : undefined
}

async function fromDiary(since: Date): Promise<Episode[]> {
  const days = Math.ceil((Date.now() - since.getTime()) / 864e5)
  try {
    const token = await requireAuth()
    if (!token) return []
    const params = new URLSearchParams({ days: String(days) })
    const uid = sdkUserId()
    if (uid) params.set("user_id", uid)
    const res = await irisFetch(`/api/v6/diary/list?${params}`, {}, IRIS_API)
    if (!res.ok) return []
    const body: any = await res.json()
    // The endpoint returns { entries: [...] }; `data` and a bare array are accepted defensively.
    const rows: any[] = firstArray(body?.entries, body?.data, (Array.isArray(body) ? body : []))
    const out: Episode[] = []
    for (const r of rows) {
      const date = String(r?.date ?? "").slice(0, 10)
      if (!date) continue
      // entry_titles is the already-written summary; fall back to the day's summary line.
      const titles: string[] = Array.isArray(r.entry_titles) ? r.entry_titles : []
      if (titles.length) {
        for (const t of titles) out.push({ date, source: "diary", title: String(t) })
      } else if (r.summary) {
        out.push({ date, source: "diary", title: String(r.summary) })
      }
    }
    return out
  } catch {
    return []
  }
}

// -- comms (CRM) --------------------------------------------------------------
/**
 * Lead communications — iMessage, WhatsApp, email — already unified per lead by atlas:comms.
 *
 * This DOES carry message text, unlike the session sources, and the distinction is deliberate:
 * these are business records the operator owns and already reads via `iris atlas:comms list`.
 * Session transcripts are different in kind — they incidentally contain credentials and client
 * data that nobody chose to put there.
 */
async function resolveLead(idOrQuery: string): Promise<{ id: number; name: string } | null> {
  if (/^\d+$/.test(idOrQuery)) {
    try {
      const res = await irisFetch(`/api/v1/leads/${idOrQuery}`)
      if (!res.ok) return null
      const d: any = await res.json()
      const lead = d?.data ?? d
      return { id: Number(idOrQuery), name: String(lead?.name ?? `Lead #${idOrQuery}`) }
    } catch {
      return null
    }
  }
  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(idOrQuery)}&per_page=1`)
    if (!res.ok) return null
    const d: any = await res.json()
    const rows: any[] = firstArray(d?.data?.data, d?.data)
    if (!rows.length) return null
    return { id: Number(rows[0].id), name: String(rows[0].name ?? idOrQuery) }
  } catch {
    return null
  }
}

async function fromComms(leadId: number, since: Date): Promise<Episode[]> {
  try {
    const p = new URLSearchParams({ lead_id: String(leadId), per_page: "500" })
    const res = await irisFetch(`/api/v1/atlas/comms?${p}`)
    if (!res.ok) return []
    const d: any = await res.json()
    const rows: any[] = firstArray(d?.data?.data, d?.data?.items, d?.data, d?.items)
    const out: Episode[] = []
    for (const r of rows) {
      const date = String(r?.sent_at ?? r?.created_at ?? "").slice(0, 10)
      if (!date || new Date(date) < since) continue
      const arrow = r.direction === "inbound" ? "<-" : "->"
      const text = String(r.subject || r.body || "").replace(/\s+/g, " ").trim()
      if (!text) continue
      out.push({ date, source: "comms", title: `${arrow} ${r.channel}: ${text}`, ref: String(r.id) })
    }
    return out
  } catch {
    return []
  }
}

// -- bloq items ---------------------------------------------------------------
/** Decisions, epics and postmortems. `created_at` is when the thinking happened. */
async function fromBloq(bloqId: string, since: Date): Promise<Episode[]> {
  // requireUserId is the canonical resolver; the hand-rolled .env read used for the diary is a
  // narrower path and returned nothing here.
  const uid = await requireUserId()
  if (!uid) return []
  try {
    const res = await irisFetch(`/api/v1/user/${uid}/bloqs/${bloqId}/items?per_page=500`)
    if (!res.ok) return []
    const d: any = await res.json()
    // {data:{items:[...]}}. A `?? d?.data` fallback lands on an OBJECT, which iterates to
    // nothing and reports 0 with a 200 — so every candidate is array-checked, not truthy-checked.
    const rows: any[] = firstArray(d?.data?.items, d?.items, d?.data?.data, d?.data)
    const out: Episode[] = []
    for (const r of rows) {
      const date = String(r?.created_at ?? "").slice(0, 10)
      if (!date || new Date(date) < since) continue
      const title = String(r.title || r.content || "").replace(/\s+/g, " ").trim()
      if (!title) continue
      out.push({ date, source: "bloq", title, ref: String(r.id) })
    }
    return out
  } catch {
    return []
  }
}

// -- git ----------------------------------------------------------------------
/**
 * Walks nested repos. This monorepo has ELEVEN and NO `.gitmodules`, so anything reading
 * `.gitmodules` reports zero — the same 416x undercount the corpus collector hit. Gitlinks are
 * read from the index instead, and each candidate must be its OWN toplevel: `git -C` on an
 * uninitialised gitlink silently walks UP and answers about the parent, double-counting it.
 */
function gitRepos(root: string): string[] {
  const out = [root]
  try {
    const staged = execFileSync("git", ["-C", root, "ls-files", "--stage"], {
      encoding: "utf8",
      maxBuffer: 64e6,
    })
    for (const line of staged.split("\n")) {
      if (!line.startsWith("160000")) continue
      const p = line.split("\t")[1]
      if (!p) continue
      const abs = join(root, p)
      if (!existsSync(join(abs, ".git"))) continue
      try {
        const top = execFileSync("git", ["-C", abs, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }).trim()
        if (top === abs) out.push(abs)
      } catch {
        /* not a repo */
      }
    }
  } catch {
    /* not a repo */
  }
  return out
}

function fromGit(root: string, since: Date): Episode[] {
  const iso = since.toISOString().slice(0, 10)
  const out: Episode[] = []
  for (const repo of gitRepos(root)) {
    const name = repo === root ? "." : repo.slice(root.length + 1)
    try {
      const log = execFileSync(
        "git",
        ["-C", repo, "log", `--since=${iso}`, "--date=short", `--pretty=format:%ad${SEP}%h${SEP}%s`],
        { encoding: "utf8", maxBuffer: 128e6 },
      )
      for (const line of log.split("\n")) {
        const [date, sha, subject] = line.split(SEP)
        if (!date || !subject) continue
        out.push({ date, source: "git", title: subject, ref: `${name}@${sha}` })
      }
    } catch {
      /* empty or unreadable */
    }
  }
  return out
}

// -- opencode -----------------------------------------------------------------
function fromOpencode(since: Date): Episode[] {
  const base = join(homedir(), ".local", "share", "opencode", "storage", "session")
  if (!existsSync(base)) return []
  const out: Episode[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".json")) {
        try {
          const o = JSON.parse(readFileSync(p, "utf8"))
          const created = o?.time?.created
          if (!o?.title || !created) continue
          const d = new Date(created)
          if (d < since) continue
          out.push({
            date: d.toISOString().slice(0, 10),
            source: "opencode",
            title: String(o.title),
            ref: o.id,
          })
        } catch {
          /* skip */
        }
      }
    }
  }
  try {
    walk(base)
  } catch {
    /* skip */
  }
  return out
}

// -- claude code --------------------------------------------------------------
/** Titles and the first timestamp only — never message content. */
function fromClaude(since: Date): Episode[] {
  const base = join(homedir(), ".claude", "projects")
  if (!existsSync(base)) return []
  const out: Episode[] = []
  let projects: string[] = []
  try {
    projects = readdirSync(base)
  } catch {
    return []
  }

  for (const proj of projects) {
    const dir = join(base, proj)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const f of files) {
      const full = join(dir, f)
      try {
        if (statSync(full).mtime < since) continue
      } catch {
        continue
      }
      let title: string | null = null
      let date: string | null = null
      try {
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (!line) continue
          let o: any
          try {
            o = JSON.parse(line)
          } catch {
            continue
          }
          // custom-title is a human's word for it, and outranks the generated one.
          if (o.type === "custom-title" && o.customTitle) title = String(o.customTitle)
          else if (o.type === "ai-title" && o.aiTitle && !title) title = String(o.aiTitle)
          if (!date && o.timestamp) date = String(o.timestamp).slice(0, 10)
        }
      } catch {
        continue
      }
      if (title && date && new Date(date) >= since) {
        out.push({ date, source: "claude", title, ref: f.replace(/\.jsonl$/, "").slice(0, 8) })
      }
    }
  }
  return out
}

const MARK: Record<string, string> = { diary: "D", git: "G", opencode: "O", claude: "C", comms: "M", bloq: "B" }

function warn(s: string): string {
  return `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}`
}

const TimelineCommand = cmd({
  command: "timeline",
  aliases: ["history"],
  describe: "what happened across diary, git and coding sessions — grouped by week",
  builder: (y) =>
    y
      .option("since", { type: "string", default: "4mo", describe: "window, e.g. 30d / 6w / 4mo / 1y" })
      .option("source", { type: "string", describe: `comma-separated: ${SOURCES.join(",")}` })
      .option("grep", { type: "string", describe: "only episodes whose title matches" })
      .option("lead", { type: "string", describe: "lead id or name — adds their CRM comms" })
      .option("bloq", { type: "string", describe: "bloq id — adds its items as episodes" })
      .option("limit", { type: "number", default: 8, describe: "max lines per source per week" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    const since = parseSince(String(args.since))
    const sinceIso = since.toISOString().slice(0, 10)
    const want = new Set(
      (args.source ? String(args.source).split(",").map((s) => s.trim()) : [...SOURCES]).filter(Boolean),
    )

    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Timeline")
      console.log(dim(`  since   ${sinceIso}`))
    }

    let lead: { id: number; name: string } | null = null
    if (args.lead) {
      lead = await resolveLead(String(args.lead))
      if (!lead && !args.json) console.log(warn(`  lead '${args.lead}' not found — comms skipped`))
    }

    const perSource: Record<string, Episode[]> = {}
    if (want.has("diary")) perSource.diary = await fromDiary(since)
    if (want.has("git")) perSource.git = fromGit(process.cwd(), since)
    if (want.has("opencode")) perSource.opencode = fromOpencode(since)
    if (want.has("claude")) perSource.claude = fromClaude(since)
    if (want.has("comms") && lead) perSource.comms = await fromComms(lead.id, since)
    if (want.has("bloq") && args.bloq) perSource.bloq = await fromBloq(String(args.bloq), since)

    if (lead && !args.json) console.log(dim(`  lead    ${lead.name} (#${lead.id})`))

    let episodes = Object.values(perSource).flat().filter((e) => e.date >= sinceIso)
    if (args.grep) {
      const g = String(args.grep).toLowerCase()
      episodes = episodes.filter((e) => e.title.toLowerCase().includes(g))
    }

    if (args.json) {
      console.log(JSON.stringify({ since: sinceIso, episodes }, null, 2))
      return
    }

    /* COVERAGE IS PRINTED PER SOURCE, AND THAT IS THE POINT. These sources begin on different
     * dates — Claude Code only reaches back to mid-July, opencode to May — so a merged view with
     * no per-source range silently presents "nothing happened before May" as a fact about the
     * business rather than a fact about the instrument. */
    printDivider()
    console.log()
    console.log(dim("  COVERAGE") + dim("   (a source that starts late is not a quiet period)"))
    for (const s of SOURCES) {
      if (!want.has(s)) continue
      const eps = perSource[s] ?? []
      if (!eps.length) {
        // "not asked for" and "asked for and empty" are different answers, and collapsing them
        // is how a tool tells you nothing happened when it simply never looked.
        const scoped = NEEDS_SCOPE[s]
        const why =
          scoped && !(s === "comms" ? lead : args.bloq)
            ? dim(`    — not queried (pass ${scoped})`)
            : warn("0 episodes   (no data in window)")
        console.log(`    ${MARK[s]}  ${bold(s.padEnd(9))} ${why}`)
        continue
      }
      const ds = eps.map((e) => e.date).sort()
      console.log(
        `    ${MARK[s]}  ${bold(s.padEnd(9))} ${String(eps.length).padStart(5)} episodes   ` +
          dim(`${ds[0]} → ${ds[ds.length - 1]}`),
      )
    }
    console.log()

    if (lead && want.size > 1) {
      console.log(
        dim("  note    only comms are lead-scoped; add ") +
          highlight(`--grep "${lead.name.split(" ")[0]}"`) +
          dim(" to narrow the rest"),
      )
      console.log()
    }

    if (!episodes.length) {
      console.log(dim("  Nothing in that window."))
      console.log()
      prompts.outro("Done")
      return
    }

    const byWeek = new Map<string, Episode[]>()
    for (const e of episodes) {
      const k = weekKey(e.date)
      if (!byWeek.has(k)) byWeek.set(k, [])
      byWeek.get(k)!.push(e)
    }

    printDivider()
    const cap = Number(args.limit)
    for (const [wk, eps] of [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      console.log()
      console.log(`  ${highlight("week of " + wk)}  ${dim(String(eps.length))}`)
      for (const s of SOURCES) {
        const rows = eps.filter((e) => e.source === s).sort((a, b) => b.date.localeCompare(a.date))
        if (!rows.length) continue
        for (const r of rows.slice(0, cap)) {
          console.log(`    ${MARK[s]}  ${dim(r.date)}  ${r.title.slice(0, 86)}`)
        }
        // Never truncate silently — say what was left out and how to see it.
        if (rows.length > cap) {
          console.log(dim(`       … ${rows.length - cap} more from ${s} this week (raise --limit)`))
        }
      }
    }

    console.log()
    printDivider()
    console.log(`  ${bold(String(episodes.length))} episodes · ${bold(String(byWeek.size))} weeks`)
    console.log(dim("  Nothing here was summarised by a model — every line was already written."))
    console.log()
    prompts.outro("Done")
  },
})

export const TimelineCommands = [TimelineCommand]
