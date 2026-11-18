import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, writeJson, emitJsonError } from "./iris-api"
import { resolveBloqId } from "./platform-bloqs"
import {
  campaignBody,
  centsToDollars,
  countsLine,
  creativeBody,
  creativeLine,
  DECISION_WORDS,
  parseId,
  reviewBody,
  stateWord,
  when,
  type Decision,
} from "./ad-campaigns-core"

// ============================================================================
// iris campaigns — a brand's ad campaigns, creatives and approvals, on its own board
// (#192625, epic #192614)
//
// One shared format for every brand: four Atlas datasets on the brand's board — `campaign`,
// `campaign-creative`, `campaign-feedback`, `campaign-template` — made by `iris campaigns setup`.
// The server (fl-api /api/v1/campaigns) owns the rules: the BOARD decides who may read (its
// owner and members) and who may write and review (its owner and whole-board editors); a review
// records who and when from the signed-in account; a rejection must say why.
//
// APPROVING NEVER PUBLISHES. It records a decision. Posting stays `iris post`, behind its own gate.
//
// Not the same thing as `iris campaign` (singular) — that is outreach (DM) campaigns.
// ============================================================================

const BLOQ_OPTION = { describe: "the brand's board — id or name (see: iris bloqs list)", type: "string" } as const
const JSON_OPTION = { describe: "machine-readable output", type: "boolean", default: false } as const

/** The board the command is about, as an id — or null, having said why. */
async function boardFrom(raw: unknown, json: boolean): Promise<number | null> {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    const msg = "Say which board: --bloq <id or name>. Your boards: iris bloqs list"
    if (json) emitJsonError(msg, { action: "campaigns" })
    else prompts.log.warn(msg)
    process.exitCode = 1
    return null
  }
  if (parseId(raw)) return parseId(raw)
  const userId = await requireUserId()
  if (!userId) {
    process.exitCode = 1
    return null
  }
  return resolveBloqId(String(raw), userId, json)
}

/** Start a command: header, auth, board. Returns the board id, or null when it cannot go on. */
async function begin(title: string, args: { bloq?: unknown; json?: boolean }): Promise<number | null> {
  const json = Boolean(args.json)
  if (!json) {
    UI.empty()
    prompts.intro(`◈  ${title}`)
  }
  if (!(await requireAuth())) {
    if (!json) prompts.outro("Done")
    return null
  }
  const bloq = await boardFrom(args.bloq, json)
  if (!bloq && !json) prompts.outro("Done")
  return bloq
}

/** Call the server; on failure it has already printed the reason (JSON on stdout under --json). */
async function call(path: string, init: RequestInit, action: string, json: boolean): Promise<any | null> {
  const res = await irisFetch(path, init)
  if (res.status === 409) {
    // "not set up yet" — say the one command that fixes it, in both modes
    const body = (await res.json().catch(() => ({}))) as any
    const msg = body?.error || "Campaigns aren't set up on this board yet."
    if (json) emitJsonError(msg, { status: 409, action, ...(body?.setup ? { fix: body.setup } : {}) })
    else prompts.log.warn(msg)
    process.exitCode = 1
    return null
  }
  if (!(await handleApiError(res, action))) return null
  return ((await res.json()) as any)?.data ?? null
}

function end(json: boolean, line = "Done") {
  if (!json) prompts.outro(line)
}

// ── setup ──────────────────────────────────────────────────────────────────

const SetupCommand = cmd({
  command: "setup",
  describe: "set a board up for campaigns — the four datasets and the review page's address (safe to re-run)",
  builder: (y) =>
    y
      .option("bloq", BLOQ_OPTION)
      .option("json", JSON_OPTION)
      .example("$0 campaigns setup --bloq 912", "set up board 912 (run it again any time — it only adds what is missing)")
      .example('$0 campaigns setup --bloq "Acme Shoes" --json', "by board name, machine-readable"),
  async handler(args) {
    const json = Boolean(args.json)
    const bloq = await begin("Set up campaigns", args)
    if (!bloq) return
    const data = await call("/api/v1/campaigns/setup", { method: "POST", body: JSON.stringify({ bloq_id: bloq }) }, "Set up campaigns", json)
    if (!data) return end(json, "Nothing changed")
    if (json) return writeJson({ success: true, ...data })

    const words: Record<string, string> = { created: "made", restored: "restored", present: "already there" }
    for (const [slug, state] of Object.entries(data.datasets ?? {})) {
      console.log(`  ${state === "present" ? dim("·") : success("✓")} ${bold(slug)}  ${dim(words[String(state)] ?? String(state))}`)
    }
    const page = data.page ?? {}
    if (page.made) console.log(`  ${success("✓")} review page  ${page.url}${page.created ? "" : dim("  (already there)")}`)
    else if (page.page_slug) console.log(`  ${dim("·")} review page  ${dim(`address reserved: ${page.url} — the page itself is not made yet`)}`)
    console.log("")
    prompts.log.info(`Next:  iris campaigns create "Spring launch" --bloq ${bloq}`)
    end(json, data.created ? `Board ${bloq} is ready for campaigns` : `Board ${bloq} was already set up — nothing changed`)
  },
})

// ── list / show ───────────────────────────────────────────────────────────

function printCampaign(c: any, full: boolean) {
  const bits = [c.state, c.brand, c.objective].filter(Boolean).join(" · ")
  console.log(`${bold(`#${c.id}  ${c.name}`)}  ${dim(bits)}`)
  const more = [
    Array.isArray(c.channels) && c.channels.length ? `on ${c.channels.join(", ")}` : "",
    c.starts_at || c.ends_at ? `${c.starts_at ?? "…"} → ${c.ends_at ?? "…"}` : "",
    c.budget_cents !== undefined && c.budget_cents !== null ? `budget ${centsToDollars(c.budget_cents)}` : "",
    c.owner ? `owner ${c.owner}` : "",
  ].filter(Boolean)
  if (more.length) console.log(`  ${dim(more.join(" · "))}`)
  console.log(`  ${countsLine(c.counts)}`)
  for (const cr of c.creatives ?? []) {
    console.log(`    ${creativeLine(cr)}`)
    if (full) for (const f of cr.feedback ?? []) {
      const d = f.decision ? DECISION_WORDS[f.decision as Decision] ?? f.decision : "Scored"
      console.log(`      ${dim(`${d}${f.score ? ` ${f.score}/5` : ""} by ${f.reviewer ?? "someone"}, ${when(f.reviewed_at ?? f.voted_at)}${f.note ? ` — "${f.note}"` : ""}`)}`)
    }
  }
  console.log("")
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "the board's campaigns, each creative's approval state, and who decided when",
  builder: (y) =>
    y
      .option("bloq", BLOQ_OPTION)
      .option("json", JSON_OPTION)
      .example("$0 campaigns list --bloq 912", "every campaign and where each creative stands")
      .example("$0 campaigns list --bloq 912 --json", "the same, with approved_by / approved_at / approval_note on each creative"),
  async handler(args) {
    const json = Boolean(args.json)
    const bloq = await begin("Campaigns", args)
    if (!bloq) return
    const data = await call(`/api/v1/campaigns?bloq_id=${bloq}`, {}, "List campaigns", json)
    if (!data) return end(json)
    if (json) return writeJson({ success: true, bloq_id: bloq, campaigns: data })
    if (!data.length) {
      prompts.log.info(`No campaigns on board ${bloq} yet. Start one: iris campaigns create "Spring launch" --bloq ${bloq}`)
      return end(json)
    }
    console.log("")
    for (const c of data) printCampaign(c, false)
    end(json, `${data.length} campaign${data.length === 1 ? "" : "s"} · details: iris campaigns show <id> --bloq ${bloq}`)
  },
})

const ShowCommand = cmd({
  command: "show <campaign>",
  aliases: ["get"],
  describe: "one campaign: its creatives, their approval state, and every review",
  builder: (y) =>
    y
      .positional("campaign", { describe: "campaign id (from iris campaigns list)", type: "string", demandOption: true })
      .option("bloq", BLOQ_OPTION)
      .option("json", JSON_OPTION)
      .example("$0 campaigns show 4211 --bloq 912", "the campaign, each creative, and who reviewed it"),
  async handler(args) {
    const json = Boolean(args.json)
    const id = parseId(args.campaign)
    const bloq = await begin("Campaign", args)
    if (!bloq) return
    if (!id) return badId("campaign", args.campaign, json)
    const data = await call(`/api/v1/campaigns/${id}?bloq_id=${bloq}`, {}, "Show campaign", json)
    if (!data) return end(json)
    if (json) return writeJson({ success: true, campaign: data })
    console.log("")
    printCampaign(data, true)
    end(json, `Add a creative: iris campaigns add-creative ${id} --bloq ${bloq} --headline "…"`)
  },
})

function badId(noun: string, raw: unknown, json: boolean) {
  const msg = `"${raw}" is not a ${noun} id — use the number from iris campaigns list.`
  if (json) emitJsonError(msg, { action: "campaigns" })
  else prompts.log.warn(msg)
  process.exitCode = 1
  end(json)
}

// ── create / add-creative ─────────────────────────────────────────────────

const CreateCommand = cmd({
  command: "create <name>",
  describe: "start a campaign on the board",
  builder: (y) =>
    y
      .positional("name", { describe: "what the campaign is called", type: "string", demandOption: true })
      .option("bloq", BLOQ_OPTION)
      .option("brand", { describe: "brand name (defaults to the board's name)", type: "string" })
      .option("objective", { describe: "what it is for, in a few words (e.g. sign-ups)", type: "string" })
      .option("channels", { describe: "where it runs, comma-separated (e.g. instagram,x)", type: "string" })
      .option("starts", { describe: "start date, YYYY-MM-DD", type: "string" })
      .option("ends", { describe: "end date, YYYY-MM-DD", type: "string" })
      .option("budget", { describe: "budget in dollars (e.g. 500 or 1250.50)", type: "string" })
      .option("owner", { describe: "who runs it (defaults to you)", type: "string" })
      .option("state", { describe: "draft (default), active, paused or ended", type: "string" })
      .option("json", JSON_OPTION)
      .example('$0 campaigns create "Spring launch" --bloq 912 --objective sign-ups --channels instagram,x --budget 500', "a campaign with a $500 budget")
      .example('$0 campaigns create "Holiday" --bloq 912 --starts 2026-12-01 --ends 2026-12-31 --json', "dated, machine-readable"),
  async handler(args) {
    const json = Boolean(args.json)
    const bloq = await begin("New campaign", args)
    if (!bloq) return
    const built = campaignBody(bloq, {
      name: String(args.name), brand: args.brand as string | undefined, objective: args.objective as string | undefined,
      channels: args.channels, starts: args.starts as string | undefined, ends: args.ends as string | undefined,
      budget: args.budget, owner: args.owner as string | undefined, state: args.state as string | undefined,
    })
    if (built.error) {
      if (json) emitJsonError(built.error, { action: "Create campaign" })
      else prompts.log.warn(built.error)
      process.exitCode = 1
      return end(json, "Nothing changed")
    }
    const data = await call("/api/v1/campaigns", { method: "POST", body: JSON.stringify(built.body) }, "Create campaign", json)
    if (!data) return end(json, "Nothing changed")
    if (json) return writeJson({ success: true, campaign: data })
    prompts.log.success(`Campaign #${data.id} "${data.name}" started on board ${bloq}${data.budget_cents !== undefined ? ` · budget ${centsToDollars(data.budget_cents)}` : ""}`)
    end(json, `Add creatives: iris campaigns add-creative ${data.id} --bloq ${bloq} --headline "…" --text "…"`)
  },
})

const AddCreativeCommand = cmd({
  command: "add-creative <campaign>",
  aliases: ["add"],
  describe: "add an ad to a campaign — it starts as a draft (or waiting for review with --submit)",
  builder: (y) =>
    y
      .positional("campaign", { describe: "campaign id (from iris campaigns list)", type: "string", demandOption: true })
      .option("bloq", BLOQ_OPTION)
      .option("headline", { describe: "the ad's headline", type: "string", demandOption: true })
      .option("text", { describe: "post text / caption", type: "string" })
      .option("text-x", { describe: "a shorter caption for X (280 characters)", type: "string" })
      .option("image", { describe: "image URL", type: "string" })
      .option("video", { describe: "video URL", type: "string" })
      .option("poster", { describe: "video poster frame URL", type: "string" })
      .option("slides", { describe: "carousel slide URLs, comma-separated, in order", type: "string" })
      .option("landing-url", { describe: "exact landing URL (with UTMs)", type: "string" })
      .option("landing-page", { describe: "landing page name or slug", type: "string" })
      .option("utm-content", { describe: "utm_content value", type: "string" })
      .option("product", { describe: "product it sells", type: "string" })
      .option("concept", { describe: "concept cluster", type: "string" })
      .option("tags", { describe: "tags", type: "string" })
      .option("ad-no", { describe: "your ad number", type: "number" })
      .option("ab-pair", { describe: "the ad it is A/B tested against", type: "string" })
      .option("hypothesis", { describe: "what you expect it to prove (private)", type: "string" })
      .option("notes", { describe: "pre-flight notes (private)", type: "string" })
      .option("submit", { describe: "send it straight to review instead of leaving it a draft", type: "boolean", default: false })
      .option("json", JSON_OPTION)
      .example('$0 campaigns add-creative 4211 --bloq 912 --headline "Book in 30 seconds" --text "No calls, no forms." --image https://…/a.png', "a single-image ad")
      .example('$0 campaigns add-creative 4211 --bloq 912 --headline "Three reasons" --slides https://…/1.png,https://…/2.png --submit', "a carousel, sent to review"),
  async handler(args) {
    const json = Boolean(args.json)
    const id = parseId(args.campaign)
    const bloq = await begin("Add creative", args)
    if (!bloq) return
    if (!id) return badId("campaign", args.campaign, json)
    const body = creativeBody(bloq, {
      headline: String(args.headline), text: args.text as string | undefined, textX: args["text-x"] as string | undefined,
      image: args.image as string | undefined, video: args.video as string | undefined, poster: args.poster as string | undefined,
      slides: args.slides, landingUrl: args["landing-url"] as string | undefined, landingPage: args["landing-page"] as string | undefined,
      utmContent: args["utm-content"] as string | undefined, product: args.product as string | undefined,
      concept: args.concept as string | undefined, tags: args.tags as string | undefined, adNo: args["ad-no"] as number | undefined,
      abPair: args["ab-pair"] as string | undefined, hypothesis: args.hypothesis as string | undefined,
      notes: args.notes as string | undefined, submit: Boolean(args.submit),
    })
    const data = await call(`/api/v1/campaigns/${id}/creatives`, { method: "POST", body: JSON.stringify(body) }, "Add creative", json)
    if (!data) return end(json, "Nothing changed")
    if (json) return writeJson({ success: true, creative: data })
    prompts.log.success(`Creative #${data.id} "${data.headline}" added to campaign #${id} — ${stateWord(data.approval_state).toLowerCase()}`)
    end(json, `Review it: iris campaigns approve ${data.id} --bloq ${bloq}   (or reject / request-changes)`)
  },
})

// ── the review: approve / reject / request-changes ────────────────────────

function reviewBuilder(y: any, command: string, noteFlag: "note" | "reason", required: boolean, example: string, exampleNote: string) {
  return y
    .positional("creative", { describe: "creative id (from iris campaigns list)", type: "string", demandOption: true })
    .option("bloq", BLOQ_OPTION)
    .option(noteFlag, {
      describe: required ? "why — it goes on the creative for whoever made it (required)" : "a note for whoever made it",
      type: "string",
      ...(noteFlag === "reason" ? { alias: "note" } : {}),
    })
    .option("score", { describe: "a score from 1 to 5, kept with the review", type: "number" })
    .option("json", JSON_OPTION)
    .example(example, exampleNote)
}

async function review(args: any, command: string, decision: Decision, note: unknown) {
  const json = Boolean(args.json)
  const id = parseId(args.creative)
  const bloq = await begin(`${DECISION_WORDS[decision]} creative`, args)
  if (!bloq) return
  if (!id) return badId("creative", args.creative, json)
  const score = args.score === undefined ? undefined : Number(args.score)
  if (score !== undefined && !(Number.isInteger(score) && score >= 1 && score <= 5)) {
    const msg = "A score is a whole number from 1 to 5."
    if (json) emitJsonError(msg, { action: command })
    else prompts.log.warn(msg)
    process.exitCode = 1
    return end(json, "Nothing changed")
  }
  const built = reviewBody(bloq, decision, note as string | undefined)
  if (built.error) {
    if (json) emitJsonError(built.error, { action: command })
    else prompts.log.warn(built.error)
    process.exitCode = 1
    return end(json, "Nothing changed")
  }
  const payload = { ...built.body, ...(score !== undefined ? { score } : {}) }
  const data = await call(`/api/v1/campaigns/creatives/${id}/review`, { method: "POST", body: JSON.stringify(payload) }, `${command} creative`, json)
  if (!data) return end(json, "Nothing changed")
  if (json) return writeJson({ success: true, published: false, creative: data })
  prompts.log.success(`${DECISION_WORDS[decision]} creative #${data.id} "${data.headline}" — recorded as ${data.approved_by}, ${when(data.approved_at)}`)
  if (data.approval_note) prompts.log.info(`Note: "${data.approval_note}"`)
  end(json, decision === "approve" ? "Nothing was published. When you're ready to post it: iris post" : "Done")
}

const ApproveCommand = cmd({
  command: "approve <creative>",
  describe: "approve a creative — records who and when; never publishes it",
  builder: (y) => reviewBuilder(y, "approve", "note", false, "$0 campaigns approve 5120 --bloq 912", "records you and the time on creative 5120 — nothing is published"),
  async handler(args) {
    await review(args, "approve", "approve", args.note)
  },
})

const RejectCommand = cmd({
  command: "reject <creative>",
  describe: "reject a creative, with the reason (required)",
  builder: (y) => reviewBuilder(y, "reject", "reason", true, '$0 campaigns reject 5122 --bloq 912 --reason "Off-brand colours"', "records you, the time and the reason on creative 5122"),
  async handler(args) {
    await review(args, "reject", "reject", args.reason)
  },
})

const RequestChangesCommand = cmd({
  command: "request-changes <creative>",
  describe: "send a creative back with what to change (required)",
  builder: (y) => reviewBuilder(y, "request-changes", "note", true, '$0 campaigns request-changes 5123 --bloq 912 --note "Shorter headline"', "records you, the time and the note on creative 5123"),
  async handler(args) {
    await review(args, "request-changes", "request_changes", args.note)
  },
})

// ── templates ─────────────────────────────────────────────────────────────

const TemplatesCommand = cmd({
  command: "templates",
  describe: "the board's reusable post templates",
  builder: (y) => y.option("bloq", BLOQ_OPTION).option("json", JSON_OPTION).example("$0 campaigns templates --bloq 912", "what each template looks like and when to use it"),
  async handler(args) {
    const json = Boolean(args.json)
    const bloq = await begin("Templates", args)
    if (!bloq) return
    const data = await call(`/api/v1/campaigns/templates?bloq_id=${bloq}`, {}, "List templates", json)
    if (!data) return end(json)
    if (json) return writeJson({ success: true, bloq_id: bloq, templates: data })
    if (!data.length) prompts.log.info(`No templates on board ${bloq} yet.`)
    for (const t of data) {
      console.log(`${bold(`${t.tpl_no ? `T${t.tpl_no}` : `#${t.id}`}  ${t.name ?? "(unnamed)"}`)}  ${dim([t.family, t.status].filter(Boolean).join(" · "))}`)
      if (t.one_line) console.log(`  ${t.one_line}`)
      if (t.use_for) console.log(`  ${dim(`Use it for: ${t.use_for}`)}`)
    }
    end(json)
  },
})

// ── root ──────────────────────────────────────────────────────────────────

export const PlatformAdCampaignsCommand = cmd({
  command: "campaigns",
  describe: "ad campaigns on your board — creatives, approvals, who decided when (approving never publishes)",
  builder: (yargs) =>
    yargs
      .command(SetupCommand)
      .command(ListCommand)
      .command(CreateCommand)
      .command(ShowCommand)
      .command(AddCreativeCommand)
      .command(ApproveCommand)
      .command(RejectCommand)
      .command(RequestChangesCommand)
      .command(TemplatesCommand)
      .demandCommand()
      .epilogue(
        "Start:  iris campaigns setup --bloq <board>  →  create  →  add-creative  →  approve | reject | request-changes\n" +
          "Approving records a decision; posting stays `iris post`. Outreach (DM) campaigns are `iris campaign`.\n" +
          "How-to: iris how-to run-ad-campaigns",
      ),
  async handler() {},
})
