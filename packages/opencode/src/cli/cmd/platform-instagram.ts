import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  printDivider,
  dim,
  bold,
  success,
  warn,
  getBridgeToken,
  BRIDGE_URL,
  writeJson,
  isNonInteractive,
  bridgeFetch as bridgeRequest,
} from "./iris-api"

const BRIDGE_BASE = BRIDGE_URL

function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["X-Bridge-Key"] = token
  return headers
}

async function bridgeFetch(path: string, timeout = 30000): Promise<any> {
  const res = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: bridgeHeaders(),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `HTTP ${res.status}`
    try { const err = JSON.parse(text) as any; if (err?.error) message = err.error } catch {
      if (res.status === 404 && text.includes("Cannot")) message = "Instagram endpoints not available. Restart bridge: iris bridge restart"
    }
    throw new Error(message)
  }
  return res.json()
}

function formatTimestamp(ts: string): string {
  if (!ts) return ""
  try {
    return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return ts }
}

const InstagramInboxCommand = cmd({
  command: "inbox",
  aliases: ["list", "dms", "ls"],
  describe: "scan Instagram DM inbox (uses saved browser session)",
  builder: (yargs) =>
    yargs
      .option("account", { type: "string", describe: "IG account name (e.g., freelabelnet)" })
      .option("limit", { type: "number", default: 20, describe: "max conversations" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Instagram Inbox") }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Scanning Instagram DMs (this takes ~10s)...")

      let url = `/api/instagram/inbox?limit=${args.limit}`
      if (args.account) url += `&account=${encodeURIComponent(args.account)}`

      const data = await bridgeFetch(url, 60000)
      const conversations = data?.conversations ?? []

      if (sp) sp.stop(`${conversations.length} conversation(s)`)

      if (!conversations.length) {
        prompts.log.info("No DM conversations found")
        prompts.log.info(dim("Check your session: iris hive credentials save-session --platform instagram"))
        prompts.outro("Done")
        return
      }

      if (args.json) { await writeJson(data); return }

      if (data.account) prompts.log.info(dim(`Account: @${data.account}`))
      printDivider()
      for (const conv of conversations) {
        const time = conv.timestamp ? dim(formatTimestamp(conv.timestamp)) : ""
        console.log(`  ${bold(conv.username)}  ${time}`)
        if (conv.preview) console.log(`    ${dim(conv.preview.slice(0, 100))}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else { prompts.log.error(err.message) }
      prompts.outro("Done")
    }
  },
})

const InstagramScrapeCommand = cmd({
  command: "scrape <url>",
  describe: "scrape an Instagram post (caption, images, metadata)",
  builder: (yargs) =>
    yargs
      .positional("url", { type: "string", demandOption: true, describe: "Instagram post URL" })
      .option("account", { type: "string", describe: "IG account for session" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Instagram Scrape") }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Scraping post...")

      const res = await fetch(`${BRIDGE_BASE}/api/scrape/instagram`, {
        method: "POST",
        headers: { ...bridgeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ url: args.url, account: args.account }),
        signal: AbortSignal.timeout(30000),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any
        throw new Error(err?.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      if (sp) sp.stop("Done")

      if (args.json) { await writeJson(data); return }

      printDivider()
      if (data.caption) console.log(`  ${bold("Caption:")} ${data.caption.slice(0, 300)}${data.caption.length > 300 ? "..." : ""}`)
      if (data.author) console.log(`  ${bold("Author:")} ${data.author}`)
      if (data.timestamp) console.log(`  ${bold("Date:")} ${data.timestamp}`)
      if (data.images?.length) console.log(`  ${bold("Images:")} ${data.images.length} image(s)`)
      if (data.location) console.log(`  ${bold("Location:")} ${data.location}`)
      printDivider()
      prompts.outro(success("Scraped"))
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

// ─── keyword-dm: comment a keyword, get a DM (FL-CO-47, #190735) ─────
//
// A creator posts "comment PIPELINE and I'll send it"; this DMs everyone who commented the keyword,
// through the daemon's POST /api/instagram/keyword-dm (which drives the saved browser session).
//
// SAFETY, in order: without --send nothing is sent and the output says so. With --send the daemon
// first does a dry run, the person sees exactly who would be messaged, and only after they say yes
// does a second call send — to that confirmed list and nobody else. No terminal means no prompt, so
// --send without a TTY is refused unless --yes is given too. The daemon caps a run at 25, keeps a
// ledger per post so nobody is messaged twice, and never runs this on a schedule.

export const KEYWORD_DM_MAX_CEILING = 25
export const KEYWORD_DM_ROUTE = "/api/instagram/keyword-dm"
export const DAEMON_TOO_OLD =
  "Your IRIS daemon does not have keyword DMs yet (404 from /api/instagram/keyword-dm). Update the daemon, then restart it: iris bridge restart"

export interface KeywordDmArgs {
  url?: string
  keyword?: string
  message?: string
  account?: string
  max?: number
  send?: boolean
  ledger?: boolean
}

export interface KeywordDmBody {
  postUrl: string
  keyword: string
  message: string
  account?: string
  max: number
  send: boolean
  handles?: string[]
}

export function isInstagramPostUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(url)
}

/** Validate CLI args into the daemon request body. `send` is always false here: the preview. */
export function buildKeywordDmBody(args: KeywordDmArgs): { error: string } | { body: KeywordDmBody } {
  const postUrl = String(args.url ?? "").trim()
  if (!isInstagramPostUrl(postUrl)) return { error: "post-url must be an instagram.com /p/ or /reel/ link" }
  if (args.ledger) return { body: { postUrl, keyword: "", message: "", max: 0, send: false } }
  const keyword = String(args.keyword ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .join(",")
  if (!keyword) return { error: 'missing --keyword (e.g. --keyword PIPELINE, or several: --keyword "PIPELINE,GUIDE")' }
  const message = String(args.message ?? "")
  if (!message.trim()) return { error: 'missing --message (e.g. --message "here you go {handle}: https://…")' }
  if (message.length > 1000) return { error: "--message is longer than 1000 characters" }
  const account = args.account ? String(args.account).trim().replace(/^@/, "") : undefined
  if (account !== undefined && !/^[A-Za-z0-9._]{1,30}$/.test(account)) return { error: "--account is not a valid Instagram handle" }
  const rawMax = args.max === undefined ? 10 : Number(args.max)
  if (!Number.isInteger(rawMax) || rawMax < 1) return { error: "--max must be a whole number of at least 1" }
  const max = Math.min(rawMax, KEYWORD_DM_MAX_CEILING)
  const body: KeywordDmBody = { postUrl, keyword, message, max, send: false }
  if (account) body.account = account
  return { body }
}

/** The second call: the same request, sending, restricted to the handles the person confirmed. */
export function sendBody(preview: KeywordDmBody, handles: string[]): KeywordDmBody {
  return { ...preview, send: true, handles: [...handles] }
}

/** A dry run reads the comments (~1–3 min); a send waits ~45s between DMs. */
export function keywordDmTimeoutMs(body: KeywordDmBody): number {
  return body.send ? (body.max * 2 + 7) * 60_000 : 11 * 60_000
}

async function readBridgeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  try {
    const err = JSON.parse(text) as any
    if (err?.error) return String(err.error)
  } catch {}
  return `HTTP ${res.status}`
}

/** POST the run. A bare 404 from Express means the daemon predates the route. */
export async function postKeywordDm(body: KeywordDmBody): Promise<any> {
  const res = await bridgeRequest(KEYWORD_DM_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(keywordDmTimeoutMs(body)),
  })
  if (res.status === 404) {
    // The route itself answers 404 with a JSON error when no Instagram session is saved; Express's
    // own "Cannot POST" page (no JSON error) means the route does not exist on this daemon.
    const msg = await readBridgeError(res)
    throw new Error(msg === "HTTP 404" ? DAEMON_TOO_OLD : msg)
  }
  const data = await res.json().catch(() => null)
  // 502 = the run happened but stopped (session expired, challenge): still a summary worth showing.
  if (data && typeof data === "object" && ("targets" in data || "results" in data)) return data
  if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`)
  return data
}

export async function fetchKeywordDmLedger(postUrl: string): Promise<any> {
  const res = await bridgeRequest(`${KEYWORD_DM_ROUTE}/ledger?postUrl=${encodeURIComponent(postUrl)}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 404) {
    const msg = await readBridgeError(res)
    throw new Error(msg === "HTTP 404" ? DAEMON_TOO_OLD : msg)
  }
  if (!res.ok) throw new Error(await readBridgeError(res))
  return res.json()
}

function printTargets(data: any, verb: string) {
  const targets: any[] = data?.targets ?? []
  const skipped: any[] = data?.skipped ?? []
  console.log(
    `  ${data?.commenters ?? 0} commenters · ${data?.matched ?? 0} said ${bold(String(data?.keywords?.join(" / ") ?? ""))} · ${targets.length} to message · ${skipped.length} skipped`,
  )
  printDivider()
  for (const t of targets) console.log(`  ${verb} ${bold("@" + t.handle)}  ${dim(`"${String(t.comment ?? "").slice(0, 70)}"`)}`)
  for (const sk of skipped) console.log(`  ${dim(`skip @${sk.handle} — ${sk.reason}`)}`)
  if (!targets.length && !skipped.length) console.log(`  ${dim("Nobody has commented the keyword yet.")}`)
  printDivider()
}

function printLedger(data: any) {
  const entries: any[] = data?.entries ?? []
  const real = entries.filter((e) => !e.dry)
  const previews = entries.length - real.length
  if (!real.length) {
    prompts.log.info(`Nobody has been sent a DM for this post yet${previews ? dim(` (${previews} dry-run preview row(s))`) : ""}.`)
    return
  }
  printDivider()
  for (const e of real) {
    const mark = e.status === "sent" ? success("✓ sent") : warn(`✗ ${e.status}`)
    const when = e.time ? dim(formatTimestamp(e.time)) : ""
    console.log(`  ${mark}  ${bold("@" + e.handle)}  ${when}${e.error ? dim(`  ${e.error}`) : ""}`)
  }
  printDivider()
  prompts.log.info(`${data?.sent ?? 0} sent for this post${previews ? dim(` · ${previews} dry-run preview row(s) not shown`) : ""}`)
}

export const InstagramKeywordDmCommand = cmd({
  command: "keyword-dm <post-url>",
  aliases: ["comment-dm"],
  describe: "DM everyone who commented a keyword on a post (dry run unless --send)",
  builder: (yargs) =>
    yargs
      .positional("post-url", { type: "string", demandOption: true, describe: "Instagram post or reel URL" })
      .option("keyword", { type: "string", describe: 'keyword to look for, whole word, any case; comma-separate several ("PIPELINE,GUIDE")' })
      .option("message", { type: "string", describe: "DM text; {handle} becomes the commenter's handle" })
      .option("account", { type: "string", describe: "IG account to send from (saved session), e.g. heyiris.io" })
      .option("max", { type: "number", default: 10, describe: `most DMs this run (hard ceiling ${KEYWORD_DM_MAX_CEILING})` })
      .option("send", { type: "boolean", default: false, describe: "actually send (after showing the list and asking)" })
      .option("yes", { type: "boolean", default: false, describe: "with --send and no terminal: skip the question (you have seen the list)" })
      .option("ledger", { type: "boolean", default: false, describe: "show who has already been sent a DM for this post" })
      .option("json", { type: "boolean", default: false })
      .example('$0 instagram keyword-dm https://www.instagram.com/p/ABC123/ --keyword PIPELINE --message "here you go: https://…"', "dry run: who WOULD be messaged")
      .example("$0 instagram keyword-dm https://www.instagram.com/p/ABC123/ --ledger", "who has been sent"),
  async handler(args) {
    const json = !!args.json
    const built = buildKeywordDmBody({ ...args, url: args.postUrl as string })
    if ("error" in built) {
      prompts.log.error(built.error)
      process.exitCode = 1
      return
    }
    const preview = built.body
    if (!json) { UI.empty(); prompts.intro(args.ledger ? "◈  Keyword DM ledger" : "◈  Keyword DM") }

    try {
      if (args.ledger) {
        const data = await fetchKeywordDmLedger(preview.postUrl)
        if (json) { await writeJson(data); return }
        printLedger(data)
        prompts.outro("Done")
        return
      }

      // --send without a terminal: nobody can be shown the list, so require --yes up front.
      if (args.send && !args.yes && isNonInteractive()) {
        prompts.log.error(
          "Refusing to send DMs without a terminal to confirm in. Run without --send to see who would be messaged, then re-run with --send --yes.",
        )
        process.exitCode = 1
        return
      }

      const sp = json ? null : prompts.spinner()
      sp?.start("Reading the post's comments (dry run — nothing is sent; ~1–3 min)...")
      const dry = await postKeywordDm(preview)
      sp?.stop("Comments read")
      if (dry?.ok === false && dry?.error) throw new Error(dry.error)
      const targets: string[] = (dry?.targets ?? []).map((t: any) => t.handle)

      if (!args.send) {
        if (json) { await writeJson({ ...dry, dry: true, sent: 0 }); return }
        prompts.log.warn(bold("DRY RUN — NOTHING WAS SENT.") + " These people WOULD be messaged:")
        printTargets(dry, "would DM")
        if (targets.length) prompts.log.info(`To send: re-run with ${bold("--send")}`)
        prompts.outro("Dry run")
        return
      }

      if (!targets.length) {
        if (json) { await writeJson({ ...dry, sent: 0 }); return }
        printTargets(dry, "DM")
        prompts.outro("Nobody to message")
        return
      }

      if (!json) printTargets(dry, "DM")
      if (!args.yes) {
        const from = dry?.account ? ` from @${dry.account}` : ""
        const ok = await prompts.confirm({
          message: `Send this DM${from} to ${targets.length} ${targets.length === 1 ? "person" : "people"}? (~45s between each)`,
          initialValue: false,
        })
        if (prompts.isCancel(ok) || !ok) {
          prompts.outro("Cancelled — nothing sent")
          return
        }
      }

      const sp2 = json ? null : prompts.spinner()
      sp2?.start(`Sending ${targets.length} DM(s) — keep this open; Ctrl-C stops after the current one`)
      const result = await postKeywordDm(sendBody(preview, targets))
      sp2?.stop(result?.stoppedReason ? "Stopped" : "Done")
      if (json) { await writeJson(result); if (result?.ok === false) process.exitCode = 1; return }

      printDivider()
      for (const r of result?.results ?? []) {
        const mark = r.status === "sent" ? success("✓ sent") : warn(`✗ ${r.status}`)
        console.log(`  ${mark}  ${bold("@" + r.handle)}${r.error ? dim(`  ${r.error}`) : ""}`)
      }
      printDivider()
      if (result?.stoppedReason) {
        prompts.log.error(`Stopped: ${result.stoppedReason}`)
        process.exitCode = 1
      }
      prompts.outro(`${success("✓")} ${result?.sent ?? 0} sent · ${result?.failed ?? 0} failed`)
    } catch (err: any) {
      if (err?.name === "TimeoutError" || err?.message?.includes("fetch failed") || err?.code === "ConnectionRefused") {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else {
        prompts.log.error(err?.message ?? String(err))
      }
      process.exitCode = 1
      if (!json) prompts.outro("Done")
    }
  },
})

export const PlatformInstagramCommand = cmd({
  command: "instagram",
  aliases: ["ig"],
  describe: "scan Instagram DMs, scrape posts, DM comment-keyword askers (requires saved browser session)",
  builder: (yargs) =>
    yargs
      .command(InstagramInboxCommand)
      .command(InstagramScrapeCommand)
      .command(InstagramKeywordDmCommand)
      .strict(false),
  async handler() {
    return InstagramInboxCommand.handler({} as any)
  },
})