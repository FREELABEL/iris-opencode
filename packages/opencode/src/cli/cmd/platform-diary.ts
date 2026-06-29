import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, IRIS_API } from "./iris-api"
import { apiMakePublic, type ShareOptions } from "./bloq-item-shared"
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { join, basename } from "path"
import matter from "gray-matter"

// Endpoints (DiaryResource):
//   GET  /api/v6/diary           ?agent_id=&bloq_id=&user_id=
//   GET  /api/v6/diary/list      ?agent_id=&bloq_id=&user_id=&days=
//   GET  /api/v6/diary/{date}    ?agent_id=&bloq_id=&user_id=
//   POST /api/v6/diary           { agent_id?, bloq_id?, user_id?, content }
//
// Scopes:
//   iris diary               → user-level (default, "My Diary")
//   iris diary --agent 11    → agent-level
//   iris diary --bloq 325    → bloq/project-level

function getSdkUserId(): string | undefined {
  const envPath = join(process.env.HOME || process.env.USERPROFILE || "~", ".iris", "sdk", ".env")
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8")
    const match = content.match(/IRIS_USER_ID=(\d+)/)
    if (match) return match[1]
  }
  return undefined
}

function buildParams(args: Record<string, any>, extra: Record<string, any> = {}): URLSearchParams {
  const p = new URLSearchParams()
  if (args.agent) p.set("agent_id", String(args.agent))
  if (args.bloq) p.set("bloq_id", String(args.bloq))
  // If neither agent nor bloq, send user_id for user-level diary
  if (!args.agent && !args.bloq) {
    const userId = getSdkUserId()
    if (userId) p.set("user_id", userId)
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
  return p
}

function scopeLabel(args: Record<string, any>): string {
  if (args.agent) return `Agent #${args.agent}`
  if (args.bloq) return `Bloq #${args.bloq}`
  return "My Diary"
}

const sharedOptions = (yargs: any) =>
  yargs
    .option("agent", { alias: "a", describe: "agent ID (agent-level diary)", type: "number" })
    .option("bloq", { alias: "b", describe: "bloq ID (project-level diary)", type: "number" })
    .option("json", { type: "boolean", default: false })

const DiaryTodayCommand = cmd({
  command: "today",
  describe: "show today's diary timeline",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Today (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args)
    const res = await irisFetch(`/api/v6/diary?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "Today's diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.bloq_name) console.log(`  ${dim(`Bloq: ${data.bloq_name}`)}`)
    if (data.agent_name) console.log(`  ${dim(`Agent: ${data.agent_name}`)}`)
    console.log()

    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? data?.entries ?? []
    if (timeline.length === 0) console.log(`  ${dim("(no entries today)")}`)
    else for (const e of timeline) {
      const ts = e.timestamp ?? e.created_at ?? ""
      const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
      console.log(`  ${bold(String(ts).slice(11, 19))}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
    }
    printDivider()
    prompts.outro(dim(`iris diary add "your entry here"${args.agent ? ` --agent ${args.agent}` : args.bloq ? ` --bloq ${args.bloq}` : ""}`))
  },
})

const DiaryListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list recent diary entries",
  builder: (yargs: any) => sharedOptions(yargs).option("days", { alias: "d", type: "number", default: 14 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Last ${args.days} Days (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args, { days: args.days })
    const res = await irisFetch(`/api/v6/diary/list?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "List diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.bloq_name) console.log(`  ${dim(`Bloq: ${data.bloq_name}`)}`)
    console.log()

    const entries: any[] = data?.entries ?? data?.data ?? (Array.isArray(data) ? data : [])
    printDivider()
    if (entries.length === 0) {
      console.log(`  ${dim("(no entries)")}`)
    } else {
      for (const e of entries) {
        const indicators = []
        if (e.has_diary) indicators.push(`${e.diary_sections} sections`)
        if (e.has_heartbeats) indicators.push(`${e.heartbeat_count} heartbeats`)
        const meta = indicators.length > 0 ? dim(` (${indicators.join(", ")})`) : ""
        console.log(`  ${bold(String(e.date ?? "?"))}${meta}`)
        if (e.summary) console.log(`    ${dim(String(e.summary).slice(0, 100))}`)
      }
    }
    printDivider()
    prompts.outro(`${data.total_entries ?? entries.length} entries`)
  },
})

const DiaryViewCommand = cmd({
  command: "view <date>",
  describe: "view a specific day's diary",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — ${args.date} (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args)
    const res = await irisFetch(`/api/v6/diary/${args.date}?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "View diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.diary_content) {
      console.log()
      console.log(data.diary_content)
    }

    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? []
    if (timeline.length === 0 && !data.diary_content) {
      console.log(`  ${dim("(no entries)")}`)
    } else {
      for (const e of timeline) {
        const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
        console.log(`  ${bold(e.time ?? "?")}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

const DiaryAddCommand = cmd({
  command: "add <content>",
  describe: "append a diary entry",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Add (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { content: args.content }
    if (args.agent) payload.agent_id = args.agent
    if (args.bloq) payload.bloq_id = args.bloq
    if (!args.agent && !args.bloq) {
      const userId = getSdkUserId()
      if (userId) payload.user_id = parseInt(userId, 10)
    }
    const res = await irisFetch(`/api/v6/diary`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
    const ok = await handleApiError(res, "Add diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    prompts.outro(`${success("✓")} Added to ${data.date ?? "today"} at ${data.time ?? "now"}`)
  },
})

// Expand a list of paths (files or directories) into a flat list of *.md files.
function expandMarkdownPaths(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith(".md")) out.push(join(p, f))
      }
    } else if (p.endsWith(".md")) {
      out.push(p)
    }
  }
  return out
}

// Derive the entry date (YYYY-MM-DD) from frontmatter `date:` or a filename prefix.
function deriveDiaryDate(fm: Record<string, any>, file: string): string | null {
  if (fm.date) {
    const d = String(fm.date).slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  }
  const m = basename(file).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

const DiarySyncCommand = cmd({
  command: "sync <paths..>",
  describe: "publish local markdown diary files to your IRIS diary (idempotent)",
  builder: (yargs: any) =>
    sharedOptions(yargs)
      .option("public", { describe: "make each synced entry publicly shareable", type: "boolean", default: false })
      .option("password", { describe: "password-protect the public share", type: "string" })
      .option("expires", { describe: "public share expiry (ISO date or e.g. 30d)", type: "string" })
      .option("no-frontmatter", { describe: "don't write iris_diary_item_id back into files", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Sync (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const files = expandMarkdownPaths((args.paths as string[]) ?? [])
    if (files.length === 0) { prompts.outro(dim("no .md files found")); return }

    const userId = getSdkUserId()
    let synced = 0, shared = 0, skipped = 0

    for (const file of files) {
      const raw = readFileSync(file, "utf8")
      const parsed = matter(raw)
      const fm: Record<string, any> = parsed.data || {}
      const date = deriveDiaryDate(fm, file)
      if (!date) { console.log(`  ${dim("skip")} ${basename(file)} — no date in frontmatter or filename`); skipped++; continue }

      const payload: any = { content: parsed.content.trim(), date, replace: true }
      if (args.agent) payload.agent_id = args.agent
      if (args.bloq) payload.bloq_id = args.bloq
      if (!args.agent && !args.bloq && userId) payload.user_id = parseInt(userId, 10)

      const res = await irisFetch(`/api/v6/diary`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
      const ok = await handleApiError(res, `Sync ${basename(file)}`)
      if (!ok) { skipped++; continue }
      const data = (await res.json()) as any
      const itemId: number | undefined = data?.item_id
      synced++

      let publicUrl: string | null = null
      if (args.public && itemId && userId) {
        const opts: ShareOptions = {}
        if (args.password) opts.password = String(args.password)
        if (args.expires) opts.expires = String(args.expires)
        const pub = await apiMakePublic(parseInt(userId, 10), itemId, opts)
        if (pub?.public_url) { publicUrl = pub.public_url; shared++ }
        if (pub?.public_uuid) fm.iris_diary_public_uuid = pub.public_uuid
      }

      if (!args["no-frontmatter"] && itemId) {
        const newData: Record<string, any> = { ...fm, iris_diary_item_id: itemId }
        if (publicUrl) newData.iris_diary_public_url = publicUrl
        writeFileSync(file, matter.stringify(parsed.content, newData))
      }

      const tag = data?.created ? success("new") : dim("updated")
      console.log(`  ${tag}  ${bold(date)}  ${dim(basename(file))}${publicUrl ? `  ${dim(publicUrl)}` : ""}`)
    }

    printDivider()
    prompts.outro(`${success("✓")} ${synced} synced${shared ? `, ${shared} shared` : ""}${skipped ? dim(`, ${skipped} skipped`) : ""}`)
  },
})

export const PlatformDiaryCommand = cmd({
  command: "diary",
  describe: "daily diary — user-level by default, --agent or --bloq for scoped diaries",
  builder: (yargs) =>
    yargs
      .command(DiaryTodayCommand)
      .command(DiaryListCommand)
      .command(DiaryViewCommand)
      .command(DiaryAddCommand)
      .command(DiarySyncCommand)
      .demandCommand(),
  async handler() {},
})
