import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, IRIS_API } from "./iris-api"
import { apiMakePublic, type ShareOptions } from "./bloq-item-shared"
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, chmodSync, rmSync, watch } from "fs"
import { join, basename, resolve, dirname } from "path"
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

// Push one markdown file to the cloud diary (keyed by date+slug, idempotent).
// The lean core shared by `sync` and the `watch` daemon — no share-link or
// frontmatter-writeback (writeback would change mtimes and loop a watcher).
async function pushDiaryFile(
  file: string,
  opts: { agent?: number; bloq?: number; userId?: string },
): Promise<{ status: "synced" | "skipped" | "error"; itemId?: number; date?: string; slug?: string }> {
  let parsed: ReturnType<typeof matter>
  try { parsed = matter(readFileSync(file, "utf8")) } catch { return { status: "error" } }
  const fm: Record<string, any> = parsed.data || {}
  const date = deriveDiaryDate(fm, file)
  if (!date) return { status: "skipped" }
  const slug = deriveDiarySlug(fm, file)

  const payload: any = { content: parsed.content.trim(), date, replace: true }
  if (slug) payload.slug = slug
  if (opts.agent) payload.agent_id = opts.agent
  else if (opts.bloq) payload.bloq_id = opts.bloq
  else if (opts.userId) payload.user_id = parseInt(opts.userId, 10)

  try {
    const res = await irisFetch(`/api/v6/diary`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
    if (!res.ok) return { status: "error", date, slug }
    const data = (await res.json()) as any
    return { status: "synced", itemId: data?.item_id, date, slug }
  } catch {
    return { status: "error", date, slug }
  }
}

// Persisted autosync config so the boot service can launch `iris diary watch`
// with no args, and install/watch agree on the directory.
const autosyncConfigPath = () => join(homedir(), ".iris", "diary-autosync.json")
function readAutosyncConfig(): { dir?: string; agent?: number; bloq?: number } {
  try { return JSON.parse(readFileSync(autosyncConfigPath(), "utf8")) } catch { return {} }
}
function writeAutosyncConfig(cfg: { dir: string; agent?: number; bloq?: number }) {
  mkdirSync(dirname(autosyncConfigPath()), { recursive: true })
  writeFileSync(autosyncConfigPath(), JSON.stringify(cfg, null, 2))
}
function defaultDiaryDir(): string {
  return readAutosyncConfig().dir || join(process.cwd(), "daily-diary")
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
// Two pieces, both shipping to every IRIS CLI user:
//   • `iris diary watch [dir]` — a PORTABLE foreground daemon (Node fs.watch)
//     that syncs entries within seconds of a change. Works on any platform.
//   • `iris diary autosync install|uninstall|status` — wires the OS to keep the
//     watcher alive at login: launchd on macOS, systemd --user on Linux.
// Product mechanism for auto-sync-on-write — NOT a Claude Code hook.

const AUTOSYNC_LABEL = "io.heyiris.diary-sync"

const DiaryWatchCommand = cmd({
  command: "watch [dir]",
  describe: "foreground daemon that auto-syncs diary files as they change (used by autosync)",
  builder: (y: any) =>
    sharedOptions(y).option("full-interval", {
      describe: "seconds between full catch-up syncs",
      type: "number",
      default: 14400,
    }),
  async handler(args: any) {
    const dir = resolve(args.dir || defaultDiaryDir())
    if (!existsSync(dir)) { console.error(`[diary-watch] directory not found: ${dir}`); process.exit(1) }
    // Headless auth: relies on IRIS_API_KEY (from ~/.iris/sdk/.env). No prompts.
    const token = await requireAuth()
    if (!token) { console.error("[diary-watch] not authenticated — set IRIS_API_KEY"); process.exit(1) }

    const opts = { agent: args.agent as number | undefined, bloq: args.bloq as number | undefined, userId: getSdkUserId() }
    const log = (m: string) => console.error(`[diary-watch] ${m}`)

    async function fullSync() {
      const files = expandMarkdownPaths([dir])
      let n = 0
      for (const f of files) { if ((await pushDiaryFile(f, opts)).status === "synced") n++ }
      log(`full catch-up: ${n}/${files.length} synced`)
    }

    // Debounce a burst of saves; sync only the files that actually changed.
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    async function flush() {
      timer = null
      const batch = [...pending]; pending.clear()
      for (const f of batch) {
        if (!existsSync(f)) continue
        const r = await pushDiaryFile(f, opts)
        log(`${r.status} ${basename(f)}${r.slug ? ` (${r.slug})` : ""}`)
      }
    }

    log(`watching ${dir}`)
    await fullSync().catch((e) => log(`initial sync error: ${e}`))
    const fullMs = Math.max(60, Number(args["full-interval"]) || 14400) * 1000
    const interval = setInterval(() => { fullSync().catch((e) => log(`full sync error: ${e}`)) }, fullMs)

    const watcher = watch(dir, (_evt, filename) => {
      const name = filename ? String(filename) : ""
      if (!name.endsWith(".md")) return
      pending.add(join(dir, name))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { flush().catch((e) => log(`flush error: ${e}`)) }, 2000)
    })

    const shutdown = () => { try { watcher.close() } catch {} clearInterval(interval); process.exit(0) }
    process.on("SIGTERM", shutdown)
    process.on("SIGINT", shutdown)
    await new Promise<void>(() => {}) // run until signalled
  },
})

// The installed iris binary path for the boot service. In a compiled release
// process.execPath IS the iris binary; fall back to `iris` on PATH.
function irisBinaryPath(): string {
  const p = process.execPath
  return p && /iris/i.test(basename(p)) ? p : "iris"
}

const macPlist = (bin: string, watchArgs: string[], logFile: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[bin, ...watchArgs].map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`

const systemdUnit = (bin: string, watchArgs: string[], dir: string) => `[Unit]
Description=IRIS daily-diary auto-sync (watches ${dir})
After=network-online.target

[Service]
ExecStart=${[bin, ...watchArgs].join(" ")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

const DiaryAutosyncCommand = cmd({
  command: "autosync <action>",
  describe: "keep diary auto-sync running at login (install|uninstall|status)",
  builder: (y: any) =>
    y
      .positional("action", { choices: ["install", "uninstall", "status"], type: "string" })
      .option("dir", { describe: "diary directory to watch (default: ./daily-diary or saved config)", type: "string" })
      .option("agent", { alias: "a", type: "number", describe: "sync into an agent-scoped diary" })
      .option("bloq", { alias: "b", type: "number", describe: "sync into a bloq-scoped diary" }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Diary — Auto-sync")

    const home = homedir()
    const uid = () => String(process.getuid ? process.getuid() : "")
    const tryExec = (bin: string, cliArgs: string[]) => {
      try { execFileSync(bin, cliArgs, { stdio: "ignore" }); return true } catch { return false }
    }

    const isMac = process.platform === "darwin"
    const isLinux = process.platform === "linux"
    if (!isMac && !isLinux) {
      prompts.log.warn(`Install supports macOS + Linux. On ${process.platform}, run \`iris diary watch\` under your own process manager.`)
      prompts.outro("Done")
      return
    }

    const plist = join(home, "Library", "LaunchAgents", `${AUTOSYNC_LABEL}.plist`)
    const unit = join(home, ".config", "systemd", "user", "iris-diary-sync.service")
    const logFile = join(home, ".iris", "logs", "diary-watch.log")

    const macLoaded = () => { try { return execFileSync("launchctl", ["list"], { encoding: "utf8" }).includes(AUTOSYNC_LABEL) } catch { return false } }
    const linuxActive = () => { try { return execFileSync("systemctl", ["--user", "is-active", "iris-diary-sync"], { encoding: "utf8" }).trim() === "active" } catch { return false } }

    if (args.action === "status") {
      const running = isMac ? macLoaded() : linuxActive()
      const cfg = readAutosyncConfig()
      console.log(`  ${running ? success("● running") : dim("○ not installed")}  iris diary auto-sync (${process.platform})`)
      if (cfg.dir) console.log(`  ${dim("watching:")} ${cfg.dir}`)
      if (existsSync(logFile)) {
        const tail = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).slice(-4)
        if (tail.length) { console.log(`  ${dim("recent:")}`); for (const l of tail) console.log(`    ${dim(l)}`) }
      }
      prompts.outro("Done")
      return
    }

    if (args.action === "uninstall") {
      if (isMac) {
        tryExec("launchctl", ["bootout", `gui/${uid()}/${AUTOSYNC_LABEL}`])
        tryExec("launchctl", ["unload", plist])
        try { rmSync(plist) } catch {}
      } else {
        tryExec("systemctl", ["--user", "disable", "--now", "iris-diary-sync"])
        try { rmSync(unit) } catch {}
        tryExec("systemctl", ["--user", "daemon-reload"])
      }
      prompts.log.success("Auto-sync removed. Local files stay; nothing is deleted from the cloud.")
      prompts.outro("Done")
      return
    }

    // install
    const dir = resolve(args.dir || defaultDiaryDir())
    if (!existsSync(dir)) {
      prompts.log.error(`Diary directory not found: ${dir}\n  Create it or pass --dir <path>.`)
      prompts.outro("Done")
      return
    }
    mkdirSync(join(home, ".iris", "logs"), { recursive: true })
    writeAutosyncConfig({ dir, agent: args.agent, bloq: args.bloq })

    const bin = irisBinaryPath()
    const watchArgs = ["diary", "watch", dir]
    if (args.agent) watchArgs.push("--agent", String(args.agent))
    else if (args.bloq) watchArgs.push("--bloq", String(args.bloq))

    let ok = false
    if (isMac) {
      mkdirSync(dirname(plist), { recursive: true })
      writeFileSync(plist, macPlist(bin, watchArgs, logFile))
      tryExec("launchctl", ["bootout", `gui/${uid()}/${AUTOSYNC_LABEL}`])
      tryExec("launchctl", ["unload", plist])
      ok = (tryExec("launchctl", ["bootstrap", `gui/${uid()}`, plist]) || tryExec("launchctl", ["load", "-w", plist])) && macLoaded()
    } else {
      mkdirSync(dirname(unit), { recursive: true })
      writeFileSync(unit, systemdUnit(bin, watchArgs, dir))
      tryExec("systemctl", ["--user", "daemon-reload"])
      ok = tryExec("systemctl", ["--user", "enable", "--now", "iris-diary-sync"]) && linuxActive()
    }

    if (ok) {
      prompts.log.success(`Watching ${bold(dir)} — new/edited entries sync automatically.`)
      console.log(`  ${dim("On write → within seconds · full catch-up every 4h & at login.")}`)
      console.log(`  ${dim("Status: iris diary autosync status  ·  Remove: iris diary autosync uninstall")}`)
    } else {
      prompts.log.warn("Wrote the service but couldn't confirm it started. Check: iris diary autosync status")
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
      .command(DiaryWatchCommand)
      .command(DiaryAutosyncCommand)
      .demandCommand(),
  async handler() {},
})
