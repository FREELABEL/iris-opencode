import { resolve } from "path"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { dim, bold, printDivider } from "./iris-api"
import {
  asContext,
  desktopAccounts,
  DesktopSessionsError,
  getSession,
  findDb,
  channelsIn,
  listSessions,
  openDesktopDb,
  pickAccount,
  readTranscript,
  searchPassages,
} from "../lib/desktop-sessions"

// `iris desktop sessions …` — IRIS Desktop's chat history on THIS machine, read-only (#190641).
// The data lives on disk (lib/desktop-sessions.ts), so none of this needs Desktop to be running.

const accountOpt = {
  type: "string" as const,
  describe: "Desktop account (user id or email, see `iris desktop sessions accounts`). Default: the first account",
}

const directoryOpt = {
  type: "string" as const,
  describe: "only sessions in this project folder or below it (as Desktop recorded it, e.g. /Users/you/app; '.' = here)",
}

/** '.' or a relative folder means the folder you are in, the way Desktop records it (absolute). */
function dirArg(d?: string): string | undefined {
  if (!d) return undefined
  return resolve(d)
}

const channelOpt = {
  type: "string" as const,
  describe: "read a preview/dev build's history (opencode-<channel>.db) instead of the released app's",
}

function open(account?: string, channel?: string) {
  const acct = pickAccount(desktopAccounts(), account)
  const db = channel ? findDb(acct.dataHome, channel) : acct.db
  if (!db)
    throw new DesktopSessionsError(
      channel
        ? `No "${channel}" history for Desktop account ${acct.id}. Channels: ${channelsIn(acct.dataHome).join(", ") || "none"}`
        : `Desktop account ${acct.id} has no chat history on this machine yet.`,
    )
  return { acct, db: openDesktopDb(db) }
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16)
}

/** Run a handler, turning a known refusal into one plain line and exit code 1. */
async function guarded(fn: () => void | Promise<void>) {
  try {
    await fn()
  } catch (e) {
    if (!(e instanceof DesktopSessionsError)) throw e
    UI.error(e.message)
    process.exitCode = 1
  }
}

function printList(rows: ReturnType<typeof listSessions>, json: boolean, offset: number, limit: number) {
  if (json) return console.log(JSON.stringify({ sessions: rows, offset, limit, more: rows.length === limit }, null, 2))
  if (!rows.length) return console.log(dim("  no sessions"))
  for (const s of rows)
    console.log(`  ${bold(s.title || "(untitled)")}  ${dim(s.id)}\n    ${dim(`${when(s.updated)} · ${s.messages} messages · ${s.directory}${s.archived ? " · archived" : ""}`)}`)
  if (rows.length === limit) console.log(dim(`\n  more: --offset ${offset + limit}`))
}

const ListCommand = cmd({
  command: ["list", "$0"],
  describe: "list IRIS Desktop chat sessions on this machine, newest first",
  builder: (y) =>
    y
      .option("account", accountOpt)
      .option("channel", channelOpt)
      .option("limit", { type: "number", default: 20, describe: "how many (max 200)" })
      .option("offset", { type: "number", default: 0, describe: "skip this many (paging)" })
      .option("archived", { type: "boolean", default: false, describe: "include archived sessions" })
      .option("directory", directoryOpt)
      .option("since", { type: "string", describe: "only sessions active since this date/time (ISO) — for incremental sync" })
      .option("json", { type: "boolean", default: false }),
  handler: (a) =>
    guarded(() => {
      const { db } = open(a.account, a.channel)
      try {
        const since = a.since ? Date.parse(a.since) : undefined
        if (a.since && Number.isNaN(since)) throw new DesktopSessionsError(`--since: not a date: ${a.since}`)
        printList(
          listSessions(db, { limit: a.limit, offset: a.offset, archived: a.archived, since, directory: dirArg(a.directory) }),
          a.json,
          a.offset,
          a.limit,
        )
      } finally {
        db.close()
      }
    }),
})

const SearchCommand = cmd({
  command: "search <query>",
  describe: "find what was said about <query> — the passages, each with the session and message it came from",
  builder: (y) =>
    y
      .positional("query", { type: "string", demandOption: true })
      .option("account", accountOpt)
      .option("channel", channelOpt)
      .option("directory", directoryOpt)
      .option("sessions", { type: "boolean", default: false, describe: "list matching sessions instead of passages" })
      .option("limit", { type: "number", default: 20 })
      .option("offset", { type: "number", default: 0 })
      .option("archived", { type: "boolean", default: true, describe: "include archived sessions" })
      .option("json", { type: "boolean", default: false }),
  handler: (a) =>
    guarded(() => {
      const { db } = open(a.account, a.channel)
      try {
        const o = { query: a.query, limit: a.limit, offset: a.offset, archived: a.archived, directory: dirArg(a.directory) }
        if (a.sessions) return printList(listSessions(db, o), a.json, a.offset, a.limit)
        const hits = searchPassages(db, a.query, o)
        if (a.json) return console.log(JSON.stringify({ passages: hits, offset: a.offset, limit: a.limit, more: hits.length === a.limit }, null, 2))
        if (!hits.length) return console.log(dim("  no passages"))
        for (const h of hits)
          console.log(
            `  ${bold(h.sessionTitle || "(untitled)")} ${dim(`· ${h.role} · ${when(h.time)}`)}\n    ${h.excerpt}\n    ${dim(`iris desktop sessions show ${h.sessionId} --around ${h.messageId}`)}`,
          )
        if (hits.length === a.limit) console.log(dim(`\n  more: --offset ${a.offset + a.limit}`))
      } finally {
        db.close()
      }
    }),
})

const ShowCommand = cmd({
  command: "show <id>",
  describe: "print what was said in a Desktop session (secrets redacted; --context for Markdown to hand an agent)",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .option("account", accountOpt)
      .option("channel", channelOpt)
      .option("last", { type: "number", describe: "only the last N turns" })
      .option("around", { type: "string", describe: "only this message (a search result's message id) and the turns either side" })
      .option("turns", { type: "number", default: 2, describe: "with --around: how many turns either side" })
      .option("context", { type: "boolean", default: false, describe: "Markdown for an agent's context (e.g. > ctx.md, or pipe to iris chat)" })
      .option("json", { type: "boolean", default: false }),
  handler: (a) =>
    guarded(() => {
      const { db } = open(a.account, a.channel)
      try {
        const turns = readTranscript(db, a.id, { limit: a.last, around: a.around, context: a.turns })
        const s = getSession(db, a.id) ?? { id: a.id, title: "(untitled)", directory: "" }
        if (a.json) return console.log(JSON.stringify({ session: s, turns }, null, 2))
        if (a.context) return console.log(asContext(s, turns))
        console.log(bold(s.title))
        printDivider()
        for (const t of turns) console.log(`${bold(t.role)} ${dim(when(t.time))}\n${t.text.trim()}\n`)
      } finally {
        db.close()
      }
    }),
})

const AccountsCommand = cmd({
  command: "accounts",
  describe: "Desktop accounts on this machine and whether each has chat history (no keys shown)",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  handler: (a) => {
    const accts = desktopAccounts()
    if (a.json) return console.log(JSON.stringify(accts, null, 2))
    for (const x of accts) {
      console.log(`  ${bold(x.id)}  ${x.label}\n    ${dim(x.db ?? "no history yet")}`)
      const ch = channelsIn(x.dataHome)
      if (ch.length) console.log(dim(`    preview/dev channels (--channel): ${ch.join(", ")}`))
    }
  },
})

const SessionsCommand = cmd({
  command: "sessions",
  describe: "IRIS Desktop chat history on this machine — list, search, show, use as context",
  builder: (y) => y.command(ListCommand).command(SearchCommand).command(ShowCommand).command(AccountsCommand),
  async handler() {},
})

export const PlatformDesktopCommand = cmd({
  command: "desktop",
  describe: "IRIS Desktop on this machine, from the terminal",
  builder: (y) => y.command(SessionsCommand).demandCommand(),
  async handler() {},
})
