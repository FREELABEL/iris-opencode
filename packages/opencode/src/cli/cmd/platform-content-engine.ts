import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success } from "./iris-api"

/**
 * iris content-engine — one-command onboarding for the article content engine.
 *
 * The pipeline (generalizes to every client):
 *   1. Content agent writes articles → bloq "Agent Deliverables" list
 *   2. Authors drop pre-approved articles → "Verbatim Inbox" list (published
 *      verbatim by the platform — never touches an LLM)
 *   3. iris-api `content:promote-articles` (hourly) promotes items →
 *      Genesis article pages via the fl-api pages API
 *   4. The client newsletter's BlogGrid autoPopulate picks up published
 *      pages by owner + type=article + slugPrefix
 *
 * Config lives in user_bloqs.business_context.content_engine, written via the
 * atomic /business-context/key endpoint (full-object PATCH would risk a
 * strategy-UI save clobbering it).
 */

const ENGINE_LISTS = ["Verbatim Inbox", "Topic Requests", "Sources"]

const ContentEngineInitCommand = cmd({
  command: "init <bloq>",
  describe: "set up the content engine on a bloq (lists + config) — one command per client",
  builder: (yargs) =>
    yargs
      .positional("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .option("newsletter", {
        describe: "newsletter page slug (brand template + BlogGrid home, e.g. ncma-fort-worth-newsletter)",
        type: "string",
        demandOption: true,
      })
      .option("prefix", {
        describe: "page slug prefix namespace for this client (e.g. ncma-)",
        type: "string",
        demandOption: true,
      })
      .option("auto-publish", {
        describe: "publish tier for agent-generated articles",
        type: "string",
        choices: ["verbatim_only", "all", "none"],
        default: "verbatim_only",
      })
      .option("byline", { describe: "label shown on article pages (e.g. 'NCMA Fort Worth Newsletter')", type: "string" })
      .option("hero-image", { describe: "default Hero background image URL", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Content Engine Init — Bloq #${args.bloq}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    // 1. Verify the bloq exists + read its current lists
    spinner.start("Reading bloq…")
    const bloqRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.bloq}`)
    if (!(await handleApiError(bloqRes, "Fetch bloq"))) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    const bloqData = (await bloqRes.json()) as any
    const bloq = bloqData?.data ?? bloqData
    const existingLists: string[] = (bloq?.lists ?? []).map((l: any) => l.name)
    spinner.stop(`Bloq: ${bold(bloq?.name ?? `#${args.bloq}`)} (${existingLists.length} lists)`)

    // 2. Verify the newsletter page exists (it's the brand template — promotion
    //    fails without it, so fail fast here)
    spinner.start(`Checking newsletter page '${args.newsletter}'…`)
    const pageRes = await irisFetch(`/api/v1/pages?search=${encodeURIComponent(args.newsletter)}&per_page=5`)
    let newsletterFound = false
    if (pageRes.ok) {
      const pageData = (await pageRes.json()) as any
      const pages = pageData?.data?.data ?? pageData?.data ?? []
      newsletterFound = (pages as any[]).some((p) => p.slug === args.newsletter)
    }
    if (!newsletterFound) {
      spinner.stop(`Newsletter page '${args.newsletter}' not found`, 1)
      prompts.log.error("The newsletter page is the brand template for article pages — create it first (iris pages push).")
      prompts.outro("Done")
      return
    }
    spinner.stop(`Newsletter page: ${success("found")}`)

    // 3. Create the engine lists (skip ones that already exist)
    for (const name of ENGINE_LISTS) {
      if (existingLists.includes(name)) {
        prompts.log.info(`List "${name}" already exists — skipping`)
        continue
      }
      spinner.start(`Creating list "${name}"…`)
      const res = await irisFetch(`/api/v1/user/bloqs/${args.bloq}/lists`, {
        method: "POST",
        body: JSON.stringify({ name }),
      })
      if (!(await handleApiError(res, `Create list ${name}`))) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`List "${name}" ${success("created")}`)
    }

    // 4. Write the content_engine config (atomic key patch — won't clobber
    //    the rest of business_context, and survives strategy-UI saves)
    const config = {
      enabled: true,
      newsletter_slug: args.newsletter,
      slug_prefix: args.prefix,
      auto_publish: args["auto-publish"],
      deliverables_list: "Agent Deliverables",
      verbatim_list: "Verbatim Inbox",
      promote_since: new Date().toISOString(),
      ...(args.byline ? { byline: args.byline } : {}),
      ...(args["hero-image"] ? { hero_image: args["hero-image"] } : {}),
    }

    spinner.start("Writing content_engine config…")
    const cfgRes = await irisFetch(`/api/v1/bloqs/${args.bloq}/business-context/key`, {
      method: "PATCH",
      body: JSON.stringify({ path: "content_engine", value: config, action: "set" }),
    })
    if (!(await handleApiError(cfgRes, "Write config"))) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    spinner.stop(`Config ${success("written")} (business_context.content_engine)`)

    prompts.log.message(
      [
        "",
        bold("Content engine is live on this bloq. Next steps:"),
        `  1. Add an ${bold("autoPopulate")} block to the newsletter BlogGrid:`,
        dim(`     { "ownerType": "user", "ownerId": ${userId}, "pageType": "article", "slugPrefix": "${args.prefix}" }`),
        `  2. Seed scrape sources:  ${dim(`iris bloqs add-item ${args.bloq} <sources-list-id> --title "SOURCE: ..." --text "https://..."`)}`,
        `  3. Authors' verbatim articles → "Verbatim Inbox" (published as-is, hourly)`,
        `  4. Topic requests → "Topic Requests" (the content agent picks them up next heartbeat)`,
        `  5. Generated articles land as ${bold(args["auto-publish"] === "all" ? "PUBLISHED pages" : "DRAFTS")} — Discord pings on every promotion`,
      ].join("\n"),
    )

    prompts.outro("Done")
  },
})

const ContentEngineStatusCommand = cmd({
  command: "status <bloq>",
  describe: "show content engine config + intake lists for a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Content Engine Status — Bloq #${args.bloq}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const ctxRes = await irisFetch(`/api/v1/bloqs/${args.bloq}/business-context`)
    if (!(await handleApiError(ctxRes, "Fetch business context"))) { prompts.outro("Done"); return }
    const ctxData = (await ctxRes.json()) as any
    const config = (ctxData?.data?.business_context ?? ctxData?.business_context ?? ctxData?.data ?? {})?.content_engine

    if (!config) {
      prompts.log.warn(`No content_engine config on bloq #${args.bloq}.`)
      prompts.log.info(`Set it up: ${dim(`iris content-engine init ${args.bloq} --newsletter <slug> --prefix <x->`)}`)
      prompts.outro("Done")
      return
    }

    prompts.log.message(
      [
        `${dim("Enabled:")}      ${config.enabled ? success("yes") : "no"}`,
        `${dim("Newsletter:")}   ${config.newsletter_slug} ${dim(`(https://freelabel.net/p/${config.newsletter_slug})`)}`,
        `${dim("Slug prefix:")}  ${config.slug_prefix}`,
        `${dim("Auto-publish:")} ${config.auto_publish ?? "verbatim_only"}`,
        `${dim("Since:")}        ${config.promote_since ?? "(last 7 days)"}`,
      ].join("\n"),
    )

    // List the intake lanes with item counts
    const bloqRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.bloq}`)
    if (bloqRes.ok) {
      const bloqData = (await bloqRes.json()) as any
      const lists = (bloqData?.data ?? bloqData)?.lists ?? []
      const watched = [config.verbatim_list ?? "Verbatim Inbox", "Topic Requests", "Sources", config.deliverables_list ?? "Agent Deliverables"]
      const lines: string[] = []
      for (const name of watched) {
        const list = (lists as any[]).find((l) => l.name === name)
        lines.push(list ? `  ${name}: ${list.items?.length ?? 0} item(s)` : `  ${name}: ${dim("MISSING — run init")}`)
      }
      prompts.log.message(["", bold("Intake lists:"), ...lines].join("\n"))
    }

    prompts.outro("Done")
  },
})

export const PlatformContentEngineCommand = cmd({
  command: "content-engine",
  aliases: ["ce"],
  describe: "client content engine — verbatim/topic/scrape intake to auto-published newsletter articles",
  builder: (yargs) =>
    yargs
      .command(ContentEngineInitCommand)
      .command(ContentEngineStatusCommand)
      .demandCommand(),
  async handler() {},
})
