import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { EOL } from "os"
import path from "path"
import * as prompts from "./clack"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Bun.which("less")
  if (lessOnPath) {
    if (Bun.file(lessOnPath).size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  const git = Bun.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionLinkCommand)
      .command(SessionUnlinkCommand)
      .command(SessionLinkedCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = []
      for await (const session of Session.list()) {
        if (!session.parentID) {
          sessions.push(session)
        }
      }

      sessions.sort((a, b) => b.time.updated - a.time.updated)

      const limitedSessions = args.maxCount ? sessions.slice(0, args.maxCount) : sessions

      if (limitedSessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(limitedSessions)
      } else {
        output = formatSessionTable(limitedSessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Bun.spawn({
          cmd: pagerCmd(),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

// ─── Link / Unlink / Linked subcommands ────────────────────────────────────

export const SessionLinkCommand = cmd({
  command: "link [sessionID]",
  describe: "link a session to a BloqItem",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", { describe: "session ID to link (latest if omitted)", type: "string" })
      .option("item-id", { describe: "BloqItem ID to link to", type: "number", demandOption: true })
      .option("user-id", { describe: "override user ID", type: "number" })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const { irisFetch, requireAuth, requireUserId, handleApiError, bold, success } = await import("./iris-api")

      const token = await requireAuth()
      if (!token) { prompts.outro("Done"); return }
      const userId = await requireUserId(args.userId as number | undefined)
      if (!userId) { prompts.outro("Done"); return }

      // Resolve session ID
      let sessionID = args.sessionID as string | undefined
      if (!sessionID) {
        const sessions: Session.Info[] = []
        for await (const s of Session.list()) {
          if (!s.parentID) sessions.push(s)
        }
        sessions.sort((a, b) => b.time.updated - a.time.updated)

        if (sessions.length === 0) {
          prompts.log.error("No sessions found")
          prompts.outro("Done")
          return
        }

        const selected = await prompts.autocomplete({
          message: "Select session to link",
          maxItems: 10,
          options: sessions.slice(0, 30).map((s) => ({
            label: s.title,
            value: s.id,
            hint: `${new Date(s.time.updated).toLocaleString()} • ${s.id.slice(-8)}`,
          })),
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        sessionID = selected as string
      }

      // Sync first to ensure session exists in the API DB
      prompts.log.info("Syncing sessions...")
      const syncRes = await irisFetch(`/api/v1/users/${userId}/coding-sessions/sync`, { method: "POST", body: JSON.stringify({}) })
      if (!syncRes.ok) {
        prompts.log.warn("Sync failed, session may not exist in API yet")
      }

      // Find the run_id for this local session
      const listRes = await irisFetch(`/api/v1/users/${userId}/coding-sessions?limit=200`)
      if (!listRes.ok) { await handleApiError(listRes, "list sessions"); return }
      const listData = await listRes.json() as { data: Array<{ run_id: string; external_session_id?: string; name?: string }> }

      const match = listData.data.find(
        (s: any) => s.external_session_id === sessionID || s.run_id === sessionID || s.session_id === sessionID,
      )

      if (!match) {
        prompts.log.error(`Session ${sessionID} not found in API. Try running 'iris session link' from the project directory.`)
        prompts.outro("Done")
        return
      }

      // Compute session snapshot for permanent cost tracking
      let snapshot: any = null
      try {
        const { computeSessionSnapshot } = await import("./stats")
        snapshot = await computeSessionSnapshot(sessionID!)
      } catch {
        // Session may be remote-only (no local data) — link without snapshot
      }

      // Link with snapshot
      const linkRes = await irisFetch(`/api/v1/users/${userId}/coding-sessions/${match.run_id}/link`, {
        method: "POST",
        body: JSON.stringify({ bloq_item_id: args.itemId, snapshot }),
      })

      if (!linkRes.ok) { await handleApiError(linkRes, "link session"); return }

      const linkData = await linkRes.json() as { data: any; message: string }
      console.log(success(`Linked session "${linkData.data.name}" to BloqItem #${args.itemId}`))
      console.log(`  Run ID: ${bold(match.run_id)}`)
      console.log(`  Provider: ${linkData.data.provider}`)
      if (snapshot) {
        const costStr = snapshot.total_cost > 0 ? `$${snapshot.total_cost.toFixed(2)}` : "$0.00"
        const tokenStr = ((snapshot.tokens_input + snapshot.tokens_output) / 1000).toFixed(1) + "K"
        const modelCount = Object.keys(snapshot.model_usage || {}).length
        console.log(`  AI Cost: ${bold(costStr)} (${modelCount} model${modelCount !== 1 ? "s" : ""}, ${tokenStr} tokens)`)
      }
      prompts.outro("Done")
    })
  },
})

export const SessionUnlinkCommand = cmd({
  command: "unlink [sessionID]",
  describe: "unlink a session from its BloqItem",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", { describe: "session run_id or external_session_id", type: "string", demandOption: true })
      .option("user-id", { describe: "override user ID", type: "number" })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const { irisFetch, requireAuth, requireUserId, handleApiError, success } = await import("./iris-api")

      const token = await requireAuth()
      if (!token) { prompts.outro("Done"); return }
      const userId = await requireUserId(args.userId as number | undefined)
      if (!userId) { prompts.outro("Done"); return }

      const sessionID = args.sessionID as string

      // Try direct run_id first, then search by external_session_id
      let runId = sessionID
      const listRes = await irisFetch(`/api/v1/users/${userId}/coding-sessions?limit=200`)
      if (listRes.ok) {
        const listData = await listRes.json() as { data: Array<{ run_id: string; external_session_id?: string }> }
        const match = listData.data.find(
          (s: any) => s.external_session_id === sessionID || s.run_id === sessionID || s.session_id === sessionID,
        )
        if (match) runId = match.run_id
      }

      const res = await irisFetch(`/api/v1/users/${userId}/coding-sessions/${runId}/link`, { method: "DELETE" })
      if (!res.ok) { await handleApiError(res, "unlink session"); return }

      console.log(success("Session unlinked from BloqItem"))
      prompts.outro("Done")
    })
  },
})

export const SessionLinkedCommand = cmd({
  command: "linked",
  describe: "list coding sessions linked to a BloqItem",
  builder: (yargs: Argv) => {
    return yargs
      .option("item-id", { describe: "BloqItem ID", type: "number", demandOption: true })
      .option("user-id", { describe: "override user ID", type: "number" })
      .option("format", { describe: "output format", type: "string", choices: ["table", "json"], default: "table" })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold } = await import("./iris-api")

      const token = await requireAuth()
      if (!token) { prompts.outro("Done"); return }
      const userId = await requireUserId(args.userId as number | undefined)
      if (!userId) { prompts.outro("Done"); return }

      const res = await irisFetch(`/api/v1/users/${userId}/bloq-items/${args.itemId}/coding-sessions`)
      if (!res.ok) { await handleApiError(res, "list linked sessions"); return }

      const data = await res.json() as { data: any[]; count: number }

      if (data.count === 0) {
        prompts.log.info(`No sessions linked to BloqItem #${args.itemId}`)
        prompts.outro("Done")
        return
      }

      if (args.format === "json") {
        console.log(JSON.stringify(data.data, null, 2))
        return
      }

      console.log(bold(`Sessions linked to BloqItem #${args.itemId}`))
      console.log("")

      for (const s of data.data) {
        const status = s.status === "running" ? "RUNNING" : s.status === "paused" ? "PAUSED" : s.status?.toUpperCase() ?? "UNKNOWN"
        const tokens = s.total_tokens_used ? `${(s.total_tokens_used / 1000).toFixed(1)}K tokens` : ""
        const date = s.started_at ? new Date(s.started_at).toLocaleDateString() : ""

        console.log(`  ${bold(s.name ?? "Untitled")} ${dim(`[${s.provider}]`)} ${dim(status)}`)
        console.log(`  ${dim("run:")} ${s.run_id.slice(0, 8)}  ${dim("model:")} ${s.model ?? "—"}  ${tokens ? dim(tokens) : ""}  ${dim(date)}`)
        console.log("")
      }

      console.log(dim(`${data.count} session(s) total`))
      prompts.outro("Done")
    })
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
