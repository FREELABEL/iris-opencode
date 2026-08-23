/**
 * `iris pulse check "<keyword>"` — Pulse, pointed at a topic instead of a lead.
 *
 * `iris pulse <lead-id>` works because a lead is a row someone already created.
 * The work you actually want to resume rarely is: "creator os" has no id, no
 * owner and no record — only a trail across commits, diary entries, agent
 * sessions, files and messages. This command walks that trail, prints what it
 * found, and files the result as a scored entity in the Signal Corpus so the
 * SECOND time you ask, there is history to compare against.
 *
 * The brief you read is assembled locally and is always complete. What gets
 * UPLOADED is narrower on purpose — see toObservations() in pulse-check-sweep.
 */

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "./../ui"
import {
  irisFetch,
  requireAuth,
  resolveUserId,
  dim,
  bold,
  success,
  highlight,
  writeJson,
  BRIDGE_URL,
  getBridgeToken,
} from "./iris-api"
import {
  TOPIC_SOURCES,
  type TopicSource,
  type SourceSweep,
  sweepAll,
  toObservations,
  topicSlug,
  keywordVariants,
} from "./pulse-check-sweep"

const SOURCE_LABEL: Record<TopicSource, string> = {
  git: "commits",
  diary: "diary",
  files: "files",
  claude_code: "Claude Code",
  opencode: "opencode",
  imessage: "iMessage",
  email: "Apple Mail",
  gmail: "Gmail",
  bloq: "Atlas",
}

function ago(iso?: string): string {
  if (!iso) return "—"
  const days = (Date.now() - Date.parse(iso)) / 864e5
  if (!Number.isFinite(days)) return "—"
  if (days < 1) return "today"
  if (days < 2) return "yesterday"
  if (days < 60) return `${Math.round(days)}d ago`
  return `${Math.round(days / 30)}mo ago`
}

function trend(s: SourceSweep): string {
  if (!s.searched || s.hitsPrior === undefined) return ""
  const delta = s.hits - s.hitsPrior
  if (delta === 0) return dim("  flat")
  return delta > 0 ? success(`  +${delta}`) : dim(`  ${delta}`)
}

export const PulseCheckCommand = cmd({
  command: "check <keyword..>",
  aliases: ["topic"],
  describe: "sweep every trail a topic left — commits, diary, files, agent sessions, messages, mail — and score how warm the thread is",
  builder: (yargs) =>
    yargs
      .positional("keyword", {
        describe: 'the topic, e.g. "creator os"',
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("days", {
        describe: "sweep window; momentum compares it against the equally-long window before it",
        type: "number",
        default: 30,
      })
      .option("repo", { describe: "repository root to sweep", type: "string", default: process.cwd() })
      .option("sources", {
        describe: `comma-separated subset of: ${TOPIC_SOURCES.join(", ")}`,
        type: "string",
      })
      .option("limit", { describe: "items shown per source", type: "number", default: 6 })
      .option("include-context", {
        describe: "also upload message/mail/session text (off by default — those carry credentials and client data)",
        type: "boolean",
        default: false,
      })
      // boolean-negation is disabled globally (see src/index.ts), so `--no-push`
      // has to be a literal flag rather than the negation of `--push`.
      .option("no-push", {
        describe: "sweep and print, but do not file the result in the Signal Corpus",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args) {
    const keyword = (args.keyword as string[]).join(" ").trim()
    if (!keyword) {
      console.error("A keyword is required, e.g. iris pulse check \"creator os\"")
      process.exitCode = 1
      return
    }

    const requested = args.sources
      ? String(args.sources).split(",").map((s) => s.trim()).filter(Boolean)
      : [...TOPIC_SOURCES]

    const unknown = requested.filter((s) => !TOPIC_SOURCES.includes(s as TopicSource))
    if (unknown.length) {
      console.error(`Unknown source(s): ${unknown.join(", ")}. Known: ${TOPIC_SOURCES.join(", ")}`)
      process.exitCode = 1
      return
    }
    const sources = requested as TopicSource[]

    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Pulse check — ${bold(keyword)}`)
    }

    // Resolved BEFORE the sweep, not just for the push: the Atlas source reads
    // your boards and needs an identity to read them with, so `--no-push` must
    // not blind it. A signed-out run still gets the six local sources, and the
    // Atlas source says why it could not look.
    const userId = await resolveUserId().catch(() => null)

    const spinner = json ? null : prompts.spinner()
    spinner?.start("sweeping")

    const sweeps = await sweepAll(
      {
        keyword,
        repo: String(args.repo),
        windowDays: Number(args.days),
        limit: Number(args.limit),
        sources,
        bridgeUrl: BRIDGE_URL,
        bridgeKey: getBridgeToken() ?? undefined,
        apiFetch: (path: string) => irisFetch(path),
        userId: userId ?? undefined,
      },
      (s) => spinner?.message(`sweeping ${SOURCE_LABEL[s]}`),
    )

    spinner?.stop(dim("swept"))

    // ── push ────────────────────────────────────────────────────────────────
    let scored: any = null
    let pushError: string | null = null
    const push = !args["no-push"]

    // Built unconditionally so `--json --no-push` shows exactly what a push
    // WOULD send. A collector whose payload can only be seen by sending it is a
    // collector you cannot check before it writes.
    const observations = toObservations(keyword, sweeps, {
      includeContext: Boolean(args.includeContext),
      windowDays: Number(args.days),
      ownerUserId: userId ?? undefined,
    })

    if (push) {
      if (!(await requireAuth())) {
        pushError = "not signed in — run `iris auth login`. The brief below is local and unaffected."
      } else {
        try {
          const res = await irisFetch("/api/v1/corpus/observe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ observations, score: true }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok && res.status !== 207) {
            pushError = `corpus rejected the sweep (${res.status}): ${JSON.stringify(body).slice(0, 200)}`
          } else {
            // observe returns every entity it touched; a topic sweep is one.
            const entity = (body?.entities ?? [])[0] ?? null
            if (entity?.score_error) {
              pushError = `filed, but scoring failed: ${String(entity.score_error).slice(0, 160)}`
            }
            scored = entity
          }
        } catch (e: any) {
          pushError = `could not reach the corpus: ${String(e?.message ?? e).slice(0, 160)}`
        }
      }
    }

    if (json) {
      await writeJson({
        keyword,
        slug: topicSlug(keyword),
        variants: keywordVariants(keyword),
        window_days: Number(args.days),
        sweeps,
        observations,
        pushed: push && !pushError,
        push_error: pushError,
        score: scored,
      })
      return
    }

    // ── brief ───────────────────────────────────────────────────────────────
    const searched = sweeps.filter((s) => s.searched)
    const carrying = searched.filter((s) => s.hits > 0)
    const totalHits = searched.reduce((n, s) => n + s.hits, 0)
    // From lastHitEpoch, NOT from the item list — `items` is trimmed to --limit
    // for display, so reading it here made a DISPLAY flag change the headline
    // fact: `--limit 0` reported "last touched —" on a board touched today.
    // The scorer already ages from the full set; the brief must agree with it.
    const newestEpoch = sweeps
      .map((s) => s.lastHitEpoch)
      .filter((e): e is number => typeof e === "number")
      .reduce<number | undefined>((a, b) => (a === undefined || b > a ? b : a), undefined)
    const newest = newestEpoch === undefined ? undefined : new Date(newestEpoch * 1000).toISOString()

    console.log()
    if (scored?.score !== undefined && scored?.score !== null) {
      const band = String(scored.band ?? "unknown")
      const label = band === "healthy" ? success(`${scored.score}/100`) : highlight(`${scored.score}/100`)
      console.log(`  ${bold("Thread warmth")}  ${label}  ${dim(`[${band}]`)}   last touched ${bold(ago(newest))}`)
    } else {
      console.log(`  ${bold("Last touched")}  ${bold(ago(newest))}   ${dim(`${totalHits} hits across ${carrying.length}/${searched.length} sources`)}`)
    }
    console.log(dim(`  ${keywordVariants(keyword).join(" · ")}   ·   ${args.days}d window`))
    console.log()

    for (const s of sweeps) {
      const label = SOURCE_LABEL[s.source].padEnd(12)

      if (!s.searched) {
        // Rule 1, made visible. A reader must never mistake this line for a zero.
        console.log(`  ${dim(label)} ${dim("not searched")} ${dim("— " + (s.unavailableReason ?? "no reason given"))}`)
        continue
      }

      const count = s.hits === 0 ? dim("none") : bold(String(s.hits))
      const caveat = s.unavailableReason ? dim(`  (${s.unavailableReason})`) : ""
      console.log(`  ${label} ${count}${trend(s)}${caveat}`)

      // A resolved board is a different KIND of answer from a text match, and
      // saying so is the point of resolving it at all.
      if (s.board) {
        console.log(
          dim(`    board  ${bold(s.board.name)} #${s.board.id} — ${s.board.items} items across ${s.board.lists} lists`),
        )
      }

      for (const item of s.items) {
        const when = dim((ago(item.when) + "        ").slice(0, 9))
        const where = item.where.length > 46 ? item.where.slice(0, 45) + "…" : item.where.padEnd(46)
        console.log(`    ${when} ${where} ${dim((item.text ?? "").slice(0, 70))}`)
      }
      if (s.hits > s.items.length) {
        console.log(dim(`    … and ${s.hits - s.items.length} more`))
      }
    }

    console.log()

    // Momentum only means something when a source could see both windows. Say
    // which ones could, so a flat reading is not mistaken for a quiet month.
    const withPrior = searched.filter((s) => s.hitsPrior !== undefined)
    if (withPrior.length) {
      const now = withPrior.reduce((n, s) => n + s.hits, 0)
      const was = withPrior.reduce((n, s) => n + (s.hitsPrior ?? 0), 0)
      const dir = now > was ? "heating up" : now < was ? "cooling" : "flat"
      console.log(
        dim(`  Momentum: ${now} this ${args.days}d vs ${was} the ${args.days}d before — ${dir}`) +
          dim(`  (from ${withPrior.map((s) => SOURCE_LABEL[s.source]).join(", ")})`),
      )
      // `now` is deliberately smaller than the headline total whenever a source
      // cannot see the prior window. Two totals side by side with no explanation
      // reads as an arithmetic bug; say which sources are missing and why.
      const noPrior = searched.filter((s) => s.hitsPrior === undefined)
      if (noPrior.length) {
        const excluded = noPrior.reduce((n, s) => n + s.hits, 0)
        console.log(
          dim(`            ${excluded} of the ${totalHits} hits are from ${noPrior.map((s) => SOURCE_LABEL[s.source]).join(", ")}, `) +
            dim("which cannot see the prior window — counted in the total, not in the trend."),
        )
      }
    } else {
      console.log(dim("  Momentum: no source could see the prior window, so none is claimed."))
    }

    // The finding a keyword sweep structurally cannot produce: a list that is
    // fed by a schedule and holds nothing is a dead scheduler, and it looks
    // identical to a list nobody uses.
    const board = sweeps.find((s) => s.board)?.board
    if (board?.silentLists?.length) {
      const empty = board.silentLists.filter((l) => l.items === 0)
      const stale = board.silentLists.filter((l) => l.items > 0)
      console.log()
      console.log(`  ${bold("Silent in this board")}`)
      for (const l of empty) {
        console.log(`    ${highlight("empty")}  ${l.name.slice(0, 44).padEnd(45)} ${dim("#" + l.id + " — 0 items; if a schedule feeds this, it has stopped")}`)
      }
      for (const l of stale.slice(0, 6)) {
        console.log(`    ${dim("stale")}  ${l.name.slice(0, 44).padEnd(45)} ${dim("#" + l.id + " — " + l.items + " items, newest " + ago(l.newest ?? undefined))}`)
      }
      if (stale.length > 6) console.log(dim(`    … and ${stale.length - 6} more stale`))
    }

    const blind = sweeps.filter((s) => !s.searched)
    if (blind.length) {
      console.log(dim(`  Blind spots: ${blind.map((s) => SOURCE_LABEL[s.source]).join(", ")} — excluded from breadth, not counted as misses.`))
    }

    if (pushError) {
      console.log()
      console.log(highlight(`  Not filed: ${pushError}`))
    } else if (push) {
      console.log(dim(`  Filed as topic:${topicSlug(keyword)} — run it again later and momentum becomes a real diff.`))
      if (!args.includeContext) {
        console.log(dim("  Message, mail and session TEXT stayed on this machine (--include-context to upload it)."))
      }
    }

    console.log()
    prompts.outro(dim(`iris pulse check "${keyword}" --days 90  ·  --sources git,diary  ·  --json`))
  },
})
