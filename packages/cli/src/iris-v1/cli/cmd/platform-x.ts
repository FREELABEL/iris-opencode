import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import {
  irisFetch,
  streamAgentChat,
  requireUserId,
  isJsonMode,
  isNonInteractive,
  writeJson,
  handleApiError,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"
import { UI } from "../ui"
import { readFileSync } from "fs"

/**
 * `iris x` — compose content and put it on X, as separable steps.
 *
 * The two halves are deliberately separate commands rather than one `iris x "topic"`
 * that drafts and posts in a breath. Drafting is cheap and repeatable; posting is
 * public and permanent. Fusing them means every retry of the cheap half risks the
 * permanent one.
 *
 * Everything composes through stdin/stdout, so a workflow is a pipeline:
 *
 *   iris x draft "the ownership bug" | iris x post --stdin
 *   iris x draft "topic" --json | jq -r .text | iris x post --stdin --yes
 *   iris x draft "topic" --thread 5 | iris x post --stdin --thread
 *   iris x post --file ./approved.txt --brand freelabel --also threads
 *
 * Defaults are chosen so the safe thing happens when a flag is forgotten:
 * `post` previews and asks before sending, and refuses outright when it cannot ask.
 */

const X_LIMIT = 280

/** Platform aliases — the API accepts both, our help says one. */
const PLATFORM = "x"

type SocialAccount = {
  integration_id: number
  platform: string
  profile: string
  handle: string
  brand_slug: string | null
  brand_name: string | null
  enabled: boolean
}

/** Options every subcommand shares, so flags mean the same thing everywhere. */
function commonOpts(y: any) {
  return y
    .option("brand", {
      alias: "b",
      type: "string",
      describe: "brand slug to act as (default: your only connected X account)",
    })
    .option("user-id", { type: "number", describe: "user ID (or IRIS_USER_ID env)" })
    .option("json", { type: "boolean", default: false, describe: "machine-readable output for chaining" })
}

/** Read the caller's connected accounts, filtered to X. */
async function xAccounts(): Promise<SocialAccount[]> {
  const res = await irisFetch("/api/v1/social-media/accounts")
  if (!res.ok) return []
  const data = (await res.json()) as { brands?: any[] }
  const out: SocialAccount[] = []
  for (const brand of data.brands ?? []) {
    const cell = (brand.platforms ?? {})[PLATFORM]
    if (!cell || cell.state === "not_connected") continue
    out.push({
      integration_id: cell.integration_id,
      platform: PLATFORM,
      profile: cell.profile,
      handle: cell.handle,
      brand_slug: brand.brand_slug,
      brand_name: brand.brand_name,
      enabled: cell.state === "connected",
    })
  }
  return out
}

/**
 * Pick the brand to post as.
 *
 * One connected account is unambiguous, so use it. Several is a decision only the
 * caller can make — ask, or refuse when there is nobody to ask. Guessing here is
 * how a post ends up on the wrong account.
 */
async function resolveBrand(explicit: string | undefined, accounts: SocialAccount[]): Promise<string | null> {
  if (explicit) return explicit

  const usable = accounts.filter((a) => a.enabled)
  if (usable.length === 1) return usable[0].brand_slug
  if (usable.length === 0) return null

  if (isNonInteractive() || isJsonMode()) return null

  const picked = await prompts.select({
    message: "Post as which account?",
    options: usable.map((a) => ({
      label: `${a.brand_name} (@${a.handle.replace(/^@/, "")})`,
      value: String(a.brand_slug),
    })),
  })
  if (prompts.isCancel(picked)) return null
  return picked as string
}

/** Body text from a positional, --file, or stdin — whichever the caller used. */
async function resolveText(args: any): Promise<string> {
  if (args.stdin) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8").trim()
  }
  if (args.file) return readFileSync(String(args.file), "utf8").trim()
  if (args.text) return String(args.text).trim()
  return ""
}

// ============================================================================
// iris x accounts
// ============================================================================

const AccountsCommand = cmd({
  command: "accounts",
  describe: "show which X accounts you can post as",
  builder: (y: any) => commonOpts(y),
  async handler(args) {
    const accounts = await xAccounts()

    if (args.json || isJsonMode()) {
      await writeJson({ accounts })
      return
    }

    UI.empty()
    prompts.intro("◈  X accounts")

    if (accounts.length === 0) {
      prompts.log.warn("No X account connected.")
      console.log(dim("  Connect one:  iris post --help  ·  or the Creator OS matrix"))
      prompts.outro("Done")
      return
    }

    for (const a of accounts) {
      const state = a.enabled ? success("connected") : dim("disabled")
      console.log(`  ${bold(String(a.brand_slug))}  @${a.handle.replace(/^@/, "")}  ${state}`)
      console.log(dim(`    profile: ${a.profile}`))
    }

    console.log()
    console.log(dim(`  Post as one:  iris x post "text" --brand <slug>`))
    prompts.outro("Done")
  },
})

// ============================================================================
// iris x draft
// ============================================================================

const DraftCommand = cmd({
  command: "draft <topic>",
  describe: "stream a draft post from an agent (does NOT publish)",
  builder: (y: any) =>
    commonOpts(y)
      .positional("topic", { type: "string", describe: "what the post is about" })
      .option("agent", { alias: "a", type: "number", describe: "agent id to draft with (or IRIS_X_AGENT)" })
      .option("model", { type: "string", default: "gpt-5-nano", describe: "model override (nano models only)" })
      .option("tone", { type: "string", describe: "voice/tone hint, e.g. 'dry, technical, no hype'" })
      .option("thread", { type: "number", describe: "draft an N-post thread instead of one post" })
      .option("max-chars", { type: "number", default: X_LIMIT, describe: "per-post character ceiling" })
      .option("bloq", { type: "number", describe: "bloq id for context (RAG)" })
      .option("no-rag", { type: "boolean", default: false, describe: "answer from the model only, no context" })
      .option("raw", { type: "boolean", default: false, describe: "print only the text — ideal for piping" }),
  async handler(args) {
    const isJson = args.json || isJsonMode()
    const agentId = args.agent ?? Number(process.env.IRIS_X_AGENT ?? 0)

    if (!agentId) {
      const msg = "No agent — pass --agent <id> or set IRIS_X_AGENT. See: iris agents list"
      if (isJson) {
        await writeJson({ ok: false, error: msg })
      } else {
        prompts.log.error(msg)
      }
      process.exitCode = 1
      return
    }

    const limit = Number(args["max-chars"] ?? X_LIMIT)
    const count = args.thread ? Math.max(2, Number(args.thread)) : 1

    // The instruction is explicit about the output contract because a nano model
    // asked for "a tweet" returns commentary, quote marks and a sign-off, all of
    // which would be published verbatim.
    const instruction = [
      count > 1
        ? `Write a ${count}-post thread for X about: ${args.topic}`
        : `Write ONE post for X about: ${args.topic}`,
      `Hard limit ${limit} characters per post.`,
      args.tone ? `Tone: ${args.tone}.` : "Tone: plain and specific. No hype, no hashtag spam.",
      "Output ONLY the post text.",
      count > 1 ? "Separate posts with a line containing only ---." : "",
      "No preamble, no explanation, no surrounding quotes, no sign-off.",
    ]
      .filter(Boolean)
      .join(" ")

    const userId = await requireUserId(args["user-id"] as number | undefined)

    // Stream to stderr so stdout stays a clean pipe. `iris x draft ... | iris x post
    // --stdin` must not receive the progress ticks as part of the post body.
    const streamToTty = !isJson && !args.raw && process.stderr.isTTY

    if (streamToTty) {
      UI.empty()
      prompts.intro(`◈  Draft — ${args.topic}`)
      process.stderr.write(dim("  "))
    }

    const result = await streamAgentChat({
      agentId: Number(agentId),
      message: instruction,
      userId,
      bloqId: (args.bloq as number | undefined) ?? null,
      overrideModel: args.model ? String(args.model) : undefined,
      enableRag: !args["no-rag"],
      onEvent: (evt) => {
        if (!streamToTty) return
        if (evt.type === "content" && typeof evt.content === "string") {
          process.stderr.write(evt.content)
        } else if (evt.type === "tool" && evt.tool) {
          process.stderr.write(dim(`\n  [${evt.tool}]\n  `))
        }
      },
    })

    if (streamToTty) process.stderr.write("\n")

    if (!result.ok || !result.content.trim()) {
      const msg = result.error ?? "The agent returned nothing."
      if (isJson) {
        await writeJson({ ok: false, error: msg })
      } else {
        prompts.log.error(msg)
      }
      process.exitCode = result.timedOut ? 2 : 1
      return
    }

    // Nano models append their input context after the answer often enough that
    // trimming is not optional. Take the text, drop anything after a blank-line
    // block that looks like echoed instructions.
    const cleaned = result.content
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim()

    const posts = count > 1
      ? cleaned
          .split(/^\s*---\s*$/m)
          .map((p) => p.trim())
          .filter(Boolean)
      : [cleaned]

    const over = posts
      .map((p, i) => ({ i: i + 1, len: p.length }))
      .filter((p) => p.len > limit)

    if (args.json || isJsonMode()) {
      await writeJson({ ok: true, topic: args.topic, posts, text: posts.join("\n---\n"), over_limit: over })
      return
    }

    // stdout carries ONLY the text, so the pipe is the composition primitive.
    process.stdout.write(posts.join("\n---\n") + "\n")

    if (streamToTty) {
      console.error()
      for (const p of posts) {
        const marker = p.length > limit ? `${p.length}/${limit} OVER` : `${p.length}/${limit}`
        console.error(dim(`  ${marker}`))
      }
      if (over.length > 0) {
        console.error(`  ${bold("Over the limit")} — trim before posting, or raise --max-chars.`)
      }
      console.error()
      console.error(dim(`  Post it:  iris x draft "${args.topic}" | iris x post --stdin`))
      prompts.outro("Draft only — nothing was published")
    }
  },
})

// ============================================================================
// iris x post
// ============================================================================

const PostCommand = cmd({
  command: "post [text]",
  describe: "publish to X (previews and asks first unless --yes)",
  builder: (y: any) =>
    commonOpts(y)
      .positional("text", { type: "string", describe: "post body" })
      .option("stdin", { type: "boolean", default: false, describe: "read the body from stdin" })
      .option("file", { alias: "f", type: "string", describe: "read the body from a file" })
      .option("image", { type: "array", string: true, describe: "image URL(s) to attach (repeatable)" })
      .option("video", { type: "string", describe: "video URL to attach" })
      .option("also", { type: "string", describe: "cross-post to more platforms, e.g. threads,instagram" })
      .option("thread", { type: "boolean", default: false, describe: "treat --- separated blocks as a thread" })
      .option("max-chars", { type: "number", default: X_LIMIT, describe: "per-post ceiling; over this refuses" })
      .option("dry-run", { type: "boolean", default: false, describe: "resolve and validate, but never send" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "skip the confirmation prompt" }),
  async handler(args) {
    const isJson = args.json || isJsonMode()
    const text = await resolveText(args)

    if (!text && !args.video && !(args.image as string[] | undefined)?.length) {
      const msg = "Nothing to post — pass text, --stdin, --file, --image or --video."
      if (isJson) await writeJson({ ok: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 1
      return
    }

    const limit = Number(args["max-chars"] ?? X_LIMIT)
    const blocks = args.thread
      ? text.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean)
      : [text]

    // Refuse rather than truncate. Silently trimming a post changes what the
    // author approved, and they only find out by reading their own timeline.
    const over = blocks.map((b, i) => ({ i: i + 1, len: b.length })).filter((b) => b.len > limit)
    if (over.length > 0) {
      const msg = `Over the ${limit}-character limit: ${over.map((o) => `post ${o.i} is ${o.len}`).join(", ")}.`
      if (isJson) await writeJson({ ok: false, error: msg, over_limit: over })
      else prompts.log.error(msg + " Trim it, or raise --max-chars.")
      process.exitCode = 1
      return
    }

    const accounts = await xAccounts()
    const brand = await resolveBrand(args.brand ? String(args.brand) : undefined, accounts)

    if (!brand) {
      const usable = accounts.filter((a) => a.enabled)
      const msg =
        usable.length === 0
          ? "No X account connected. Run: iris x accounts"
          : `Several X accounts connected (${usable.map((a) => a.brand_slug).join(", ")}) — pass --brand.`
      if (isJson) await writeJson({ ok: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 1
      return
    }

    const platforms = [PLATFORM, ...String(args.also ?? "").split(",").map((p) => p.trim()).filter(Boolean)]
    const chosen = accounts.find((a) => a.brand_slug === brand)

    // Preview before anything leaves the machine — the same shape for dry-run and
    // for the confirmation, so what you approve is what you saw.
    if (!isJson) {
      UI.empty()
      prompts.intro(args["dry-run"] ? "◈  X post — dry run" : "◈  X post")
      console.log(`  ${dim("as")}       ${highlight(brand)}${chosen ? dim(` (@${chosen.handle.replace(/^@/, "")})`) : ""}`)
      console.log(`  ${dim("to")}       ${platforms.join(", ")}`)
      if (args.video) console.log(`  ${dim("video")}    ${args.video}`)
      if ((args.image as string[] | undefined)?.length) {
        console.log(`  ${dim("images")}   ${(args.image as string[]).join(", ")}`)
      }
      console.log()
      blocks.forEach((b, i) => {
        if (blocks.length > 1) console.log(dim(`  ── ${i + 1}/${blocks.length} ──`))
        b.split("\n").forEach((line) => console.log(`  ${line}`))
        console.log(dim(`  ${b.length}/${limit}`))
        console.log()
      })
    }

    if (args["dry-run"]) {
      if (isJson) await writeJson({ ok: true, dry_run: true, brand, platforms, posts: blocks })
      else prompts.outro("Dry run — nothing was published")
      return
    }

    // Confirmation is the default because this is public and permanent. In a
    // non-interactive context there is nobody to ask, so an unconfirmed post is
    // refused rather than assumed — a cron job must say --yes on purpose.
    if (!args.yes) {
      if (isNonInteractive() || isJson) {
        const msg = "Refusing to post without confirmation. Pass --yes to publish non-interactively."
        if (isJson) await writeJson({ ok: false, error: msg })
        else prompts.log.error(msg)
        process.exitCode = 1
        return
      }
      const go = await prompts.confirm({ message: `Publish to ${platforms.join(", ")} as ${brand}?` })
      if (prompts.isCancel(go) || !go) {
        prompts.outro("Cancelled — nothing was published")
        return
      }
    }

    const results: any[] = []
    const spinner = !isJson ? prompts.spinner() : null

    for (let i = 0; i < blocks.length; i++) {
      spinner?.start(blocks.length > 1 ? `Publishing ${i + 1}/${blocks.length}…` : "Publishing…")

      const body: Record<string, unknown> = { platforms, brand }
      if (args.video && i === 0) {
        body.video_url = args.video
        body.title = blocks[i]
      } else if ((args.image as string[] | undefined)?.length && i === 0) {
        body.photo_urls = args.image
        body.title = blocks[i]
      } else {
        body.text = blocks[i]
      }

      const res = await irisFetch("/api/v1/social-media/publish", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as any

      if (!res.ok || !data?.success) {
        spinner?.stop("Failed", 1)
        const detail = data?.message ?? data?.error ?? `HTTP ${res.status}`
        if (isJson) {
          await writeJson({ ok: false, error: detail, published: results, failed_at: i + 1 })
        } else {
          prompts.log.error(detail)
          // A 403 here is an ownership refusal, not a transport error — say which.
          if (res.status === 403) console.log(dim("  That account is not yours to post as. Try: iris x accounts"))
          if (res.status === 422) console.log(dim("  Nothing connected for X on that brand. Try: iris x accounts"))
          if (results.length > 0) console.log(dim(`  ${results.length} post(s) already went out — the thread is partial.`))
        }
        process.exitCode = 1
        return
      }

      spinner?.stop(blocks.length > 1 ? `Published ${i + 1}/${blocks.length}` : "Published")
      results.push(data)
    }

    if (isJson) {
      await writeJson({ ok: true, brand, platforms, count: results.length, results })
      return
    }

    console.log()
    for (const r of results) {
      const byPlatform = (r.results ?? {}) as Record<string, any>
      for (const [plat, detail] of Object.entries(byPlatform)) {
        if (detail?.url) console.log(`  ${dim(plat + ":")} ${detail.url}`)
      }
      if (r.skipped && Object.keys(r.skipped).length > 0) {
        for (const [plat, why] of Object.entries(r.skipped as Record<string, string>)) {
          console.log(dim(`  skipped ${plat}: ${why}`))
        }
      }
    }
    prompts.outro(`Published as ${brand}`)
  },
})

export const XCommand = cmd({
  command: "x <subcommand>",
  describe: "draft and publish to X/Twitter",
  builder: (y: any) =>
    y
      .command(AccountsCommand)
      .command(DraftCommand)
      .command(PostCommand)
      .demandCommand(1, "Pick a subcommand: accounts, draft, post"),
  async handler() {},
})
