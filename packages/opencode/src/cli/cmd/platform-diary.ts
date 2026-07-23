import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, IRIS_API } from "./iris-api"
import { apiMakePublic, type ShareOptions } from "./bloq-item-shared"
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, chmodSync, rmSync } from "fs"
import { join, basename, resolve } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"
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
    const dayEntries: any[] = Array.isArray(data?.entries) ? data.entries : []
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? []
    if (dayEntries.length === 0 && timeline.length === 0) {
      console.log(`  ${dim("(no entries today)")}`)
    } else {
      // Session entries (from `iris diary sync`) — one line per entry.
      for (const entry of dayEntries) {
        const slugTag = entry.slug ? dim(`  (${entry.slug})`) : ""
        const secs = entry.sections ? dim(` — ${entry.sections} sections`) : ""
        console.log(`  ${bold(String(entry.title ?? "entry"))}${slugTag}${secs}`)
      }
      // Timeline sections (from `iris diary add` / heartbeats).
      for (const e of timeline) {
        const ts = e.timestamp ?? e.created_at ?? ""
        const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
        console.log(`  ${bold(String(ts).slice(11, 19))}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
      }
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
        const entryCount = e.entry_count ?? (e.has_diary ? 1 : 0)
        if (entryCount) indicators.push(`${entryCount} ${entryCount === 1 ? "entry" : "entries"}`)
        if (e.has_heartbeats) indicators.push(`${e.heartbeat_count} heartbeats`)
        const meta = indicators.length > 0 ? dim(` (${indicators.join(", ")})`) : ""
        console.log(`  ${bold(String(e.date ?? "?"))}${meta}`)
        // Prefer explicit session titles; fall back to the day summary.
        const titles: string[] = Array.isArray(e.entry_titles) ? e.entry_titles : []
        if (titles.length > 0) {
          for (const t of titles) console.log(`    ${dim("•")} ${dim(String(t).slice(0, 90))}`)
        } else if (e.summary) {
          console.log(`    ${dim(String(e.summary).slice(0, 100))}`)
        }
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

    // Multiple session entries per day: render each with its title/slug header.
    const dayEntries: any[] = Array.isArray(data?.entries) ? data.entries : []
    if (dayEntries.length > 0) {
      for (const entry of dayEntries) {
        console.log()
        const slugTag = entry.slug ? dim(`  (${entry.slug})`) : ""
        console.log(`  ${bold(String(entry.title ?? args.date))}${slugTag}`)
        printDivider()
        console.log(String(entry.content ?? ""))
      }
    } else if (data.diary_content) {
      console.log()
      console.log(data.diary_content)
    }

    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? []
    if (timeline.length === 0 && dayEntries.length === 0 && !data.diary_content) {
      console.log(`  ${dim("(no entries)")}`)
    } else {
      for (const e of timeline) {
        const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
        console.log(`  ${bold(e.time ?? "?")}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
      }
    }
    printDivider()
    prompts.outro(dayEntries.length > 1 ? dim(`${dayEntries.length} entries`) : "Done")
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

// Derive the per-session slug so a day can hold many entries. Explicit
// frontmatter `slug:` wins; otherwise the filename minus the date prefix and
// `.md` (e.g. 2026-07-17-audit-notes.md → "audit-notes"). A bare date filename
// (2026-07-17.md) has no slug → the "default" slot (legacy one-per-day shape).
function deriveDiarySlug(fm: Record<string, any>, file: string): string | undefined {
  if (fm.slug && String(fm.slug).trim()) return String(fm.slug).trim().slice(0, 190)
  const name = basename(file).replace(/\.md$/i, "")
  const rest = name.replace(/^\d{4}-\d{2}-\d{2}-?/, "")
  return rest ? rest.slice(0, 190) : undefined
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
      const slug = deriveDiarySlug(fm, file)

      const payload: any = { content: parsed.content.trim(), date, replace: true }
      if (slug) payload.slug = slug
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
      const slugLabel = slug ? dim(`/${slug}`) : ""
      console.log(`  ${tag}  ${bold(date)}${slugLabel}  ${dim(basename(file))}${publicUrl ? `  ${dim(publicUrl)}` : ""}`)
    }

    printDivider()
    prompts.outro(`${success("✓")} ${synced} synced${shared ? `, ${shared} shared` : ""}${skipped ? dim(`, ${skipped} skipped`) : ""}`)
  },
})

// ── Auto-sync (background, on-write) ─────────────────────────────────────────
// A macOS LaunchAgent whose WatchPaths fires on any change in the diary dir and
// runs `iris diary sync` — so entries reach the cloud with no manual step,
// regardless of who wrote them (you, an editor, another agent). This is the
// product mechanism for "auto-sync-on-write" — NOT a Claude Code hook.

const AUTOSYNC_LABEL = "io.heyiris.diary-sync"
const autosyncPaths = () => {
  const home = homedir()
  return {
    home,
    wrapper: join(home, ".iris", "cron", "diary-autosync.sh"),
    plist: join(home, "Library", "LaunchAgents", `${AUTOSYNC_LABEL}.plist`),
    log: join(home, ".iris", "logs", "diary-autosync.log"),
  }
}

// Wrapper is written for bash 3.2 (macOS /bin/bash): no mapfile. Diary filenames
// are kebab-case (no spaces), so word-splitting on $files is safe. `--no-frontmatter`
// avoids a WatchPaths loop (writing iris_diary_item_id back would change mtimes).
const autosyncWrapper = (dir: string, home: string) => `#!/bin/bash
# ${AUTOSYNC_LABEL} — auto-sync the daily diary to the cloud on any change.
# Managed by \`iris diary autosync\` — edits will be overwritten on reinstall.
export PATH="$HOME/.local/bin:$HOME/.iris/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DIARY_DIR="${dir}"
LOG="${join(home, ".iris", "logs", "diary-autosync.log")}"
LOCK="${join(home, ".iris", "logs", ".diary-autosync.lock")}"
FULL_MARKER="${join(home, ".iris", "logs", ".diary-last-full-sync")}"

if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

sleep 2  # debounce a burst of saves
ts() { date '+%Y-%m-%d %H:%M:%S'; }
now=$(date +%s)
last_full=$(cat "$FULL_MARKER" 2>/dev/null || echo 0)

if [ $((now - last_full)) -gt 14400 ]; then
  echo "[$(ts)] autosync: FULL catch-up" >> "$LOG"
  iris diary sync "$DIARY_DIR" --no-frontmatter >> "$LOG" 2>&1
  echo "$now" > "$FULL_MARKER"
else
  files=$(find "$DIARY_DIR" -maxdepth 1 -name '*.md' -mmin -5 2>/dev/null)
  if [ -z "$files" ]; then
    echo "[$(ts)] autosync: nothing new" >> "$LOG"
  else
    echo "[$(ts)] autosync: $(echo "$files" | grep -c .) changed file(s)" >> "$LOG"
    iris diary sync $files --no-frontmatter >> "$LOG" 2>&1
  fi
fi
echo "[$(ts)] autosync done (exit $?)" >> "$LOG"
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
`

const autosyncPlist = (dir: string, wrapper: string, home: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${wrapper}</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>${dir}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(home, ".iris", "logs", "diary-sync.launchd.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(home, ".iris", "logs", "diary-sync.launchd.err")}</string>
</dict>
</plist>
`

const DiaryAutosyncCommand = cmd({
  command: "autosync <action>",
  describe: "background auto-sync of local diary files to the cloud (install|uninstall|status)",
  builder: (y: any) =>
    y
      .positional("action", { choices: ["install", "uninstall", "status"], type: "string" })
      .option("dir", { describe: "diary directory to watch (default: ./daily-diary)", type: "string" }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Diary — Auto-sync")

    if (process.platform !== "darwin") {
      prompts.log.warn("Auto-sync currently supports macOS (launchd) only.")
      prompts.outro("Done")
      return
    }

    const p = autosyncPaths()

    const uid = () => String(process.getuid ? process.getuid() : "")
    const tryExec = (bin: string, cliArgs: string[]) => {
      try { execFileSync(bin, cliArgs, { stdio: "ignore" }); return true } catch { return false }
    }
    const isLoaded = () => {
      try { return execFileSync("launchctl", ["list"], { encoding: "utf8" }).includes(AUTOSYNC_LABEL) }
      catch { return false }
    }

    if (args.action === "status") {
      const loaded = isLoaded()
      console.log(`  ${loaded ? success("● running") : dim("○ not installed")}  ${AUTOSYNC_LABEL}`)
      console.log(`  ${dim("plist:  ")} ${existsSync(p.plist) ? p.plist : dim("(missing)")}`)
      if (existsSync(p.log)) {
        const tail = readFileSync(p.log, "utf8").trim().split("\n").slice(-4)
        console.log(`  ${dim("recent:")}`)
        for (const l of tail) console.log(`    ${dim(l)}`)
      }
      prompts.outro("Done")
      return
    }

    if (args.action === "uninstall") {
      tryExec("launchctl", ["bootout", `gui/${uid()}/${AUTOSYNC_LABEL}`])
      tryExec("launchctl", ["unload", p.plist])
      for (const f of [p.plist, p.wrapper]) { try { rmSync(f) } catch {} }
      prompts.log.success("Auto-sync removed. Local files stay; nothing is deleted from the cloud.")
      prompts.outro("Done")
      return
    }

    // install
    const dir = resolve(args.dir || join(process.cwd(), "daily-diary"))
    if (!existsSync(dir)) {
      prompts.log.error(`Diary directory not found: ${dir}\n  Pass one with --dir <path>.`)
      prompts.outro("Done")
      return
    }

    mkdirSync(join(p.home, ".iris", "cron"), { recursive: true })
    mkdirSync(join(p.home, ".iris", "logs"), { recursive: true })
    mkdirSync(join(p.home, "Library", "LaunchAgents"), { recursive: true })

    writeFileSync(p.wrapper, autosyncWrapper(dir, p.home))
    chmodSync(p.wrapper, 0o755)
    writeFileSync(p.plist, autosyncPlist(dir, p.wrapper, p.home))

    // Reload cleanly (ignore errors from a not-yet-loaded agent).
    tryExec("launchctl", ["bootout", `gui/${uid()}/${AUTOSYNC_LABEL}`])
    tryExec("launchctl", ["unload", p.plist])
    const ok = tryExec("launchctl", ["bootstrap", `gui/${uid()}`, p.plist]) ||
               tryExec("launchctl", ["load", "-w", p.plist])

    if (ok && isLoaded()) {
      prompts.log.success(`Watching ${bold(dir)} — new/edited entries now sync automatically.`)
      console.log(`  ${dim("On write → ~4s incremental sync · every 4h → full catch-up.")}`)
      console.log(`  ${dim(`Status: iris diary autosync status  ·  Remove: iris diary autosync uninstall`)}`)
    } else {
      prompts.log.warn(`Wrote the agent but launchctl load failed. Try:\n  launchctl load -w ${p.plist}`)
    }
    prompts.outro("Done")
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
      .command(DiaryAutosyncCommand)
      .demandCommand(),
  async handler() {},
})
