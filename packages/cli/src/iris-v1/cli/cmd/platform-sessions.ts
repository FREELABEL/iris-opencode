import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { bridgeFetch, dim, bold, highlight, success, writeJson } from "./iris-api"
import { probeBridge, assessBridge, printDegradations } from "./subsystem-health"
import { firstArray } from "../../util/array"
import { candidateServers, deliverLive, shouldFallBackToBridge, deliveryTimeoutMs, findSessionAcrossServers } from "./session-live-delivery"

// ============================================================================
// iris sessions — see and steer the AI sessions running on this machine (#181239)
//
// The bridge has exposed list / detail / history / message for claude-code,
// opencode and ollama for some time. Nothing in the CLI ever called it, so the
// only way to reach a session was to hand-roll curl with the token out of
// ~/.iris/bridge-token. This is the surface over an API that already worked.
//
// Listing used to take 18.75 seconds because the bridge read every transcript
// end to end — 870 MB across 164 files here — purely to count messages. That is
// fixed upstream (iris-daemon 49130dd) and message_count is now opt-in, which is
// why `list` sends counts=0 by default: the count is the ONLY field that costs a
// full read, and a picker does not need it.
// ============================================================================

const PROVIDERS = ["claude-code", "opencode", "ollama"] as const
type Provider = (typeof PROVIDERS)[number]

interface SessionRow {
  session_id: string
  name?: string | null
  project_path?: string | null
  git_branch?: string | null
  model?: string | null
  created_at?: string | null
  updated_at?: string | null
  message_count?: number | null
  provider?: string | null
}

function printDivider() {
  console.log(dim("  " + "─".repeat(74)))
}

/**
 * The bridge is the only way to reach a session. When it is down every endpoint
 * below returns nothing, which reads as "no sessions" rather than "not
 * connected" — the same ambiguity the degraded-mode work exists to remove. So
 * probe once and say so, rather than printing an empty list.
 */
async function requireBridge(): Promise<boolean> {
  const probe = await probeBridge()
  const degradation = assessBridge(probe)
  if (degradation) {
    printDegradations([degradation])
    return false
  }
  return true
}

function relativeAge(iso?: string | null): string {
  if (!iso) return dim("—")
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return dim("—")
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Trim a session name to one readable line — they are first-user-message derived and can be long. */
function shortName(row: SessionRow): string {
  const raw = (row.name ?? "").replace(/\s+/g, " ").trim()
  if (!raw) return dim("(unnamed)")
  return raw.length > 58 ? raw.slice(0, 57) + "…" : raw
}

async function fetchSessions(provider: Provider, limit: number, withCounts: boolean): Promise<SessionRow[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  // counts=0 is the fast path — see the header note.
  if (!withCounts) params.set("counts", "0")
  const res = await bridgeFetch(`/api/sessions/${provider}?${params}`)
  if (!res.ok) return []
  const data = (await res.json().catch(() => null)) as any
  const rows: SessionRow[] = firstArray(data?.sessions)
  return rows.map((r) => ({ ...r, provider: r.provider ?? provider }))
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list AI sessions running on this machine (claude-code, opencode, ollama)",
  builder: (y: any) =>
    y
      .option("provider", { type: "string", describe: `only one provider (${PROVIDERS.join(", ")})` })
      .option("limit", { type: "number", default: 20, describe: "max sessions per provider" })
      .option("counts", {
        type: "boolean",
        default: false,
        describe: "include message counts — costs a full read of every transcript",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  AI Sessions")

    if (!(await requireBridge())) {
      prompts.outro("Done")
      return
    }

    const requested: Provider[] = args.provider
      ? [String(args.provider).toLowerCase() as Provider]
      : [...PROVIDERS]

    const bad = requested.filter((p) => !PROVIDERS.includes(p))
    if (bad.length > 0) {
      prompts.log.error(`Unknown provider: ${bad.join(", ")}. Known: ${PROVIDERS.join(", ")}`)
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start(args.counts ? "Reading sessions (with counts — slower)…" : "Reading sessions…")

    const results = await Promise.all(
      requested.map(async (p) => ({ provider: p, rows: await fetchSessions(p, args.limit, args.counts) })),
    )

    const total = results.reduce((n, r) => n + r.rows.length, 0)
    spinner.stop(`${total} session(s)`)

    if (args.json) {
      await writeJson(results.flatMap((r) => r.rows))
      prompts.outro("Done")
      return
    }

    if (total === 0) {
      prompts.log.warn("No sessions found.")
      prompts.outro(dim("Start one, then re-run: iris sessions list"))
      return
    }

    for (const { provider, rows } of results) {
      if (rows.length === 0) continue
      console.log("")
      console.log(`  ${bold(provider)} ${dim(`(${rows.length})`)}`)
      printDivider()
      for (const row of rows) {
        const id = dim(row.session_id.slice(0, 8))
        const age = relativeAge(row.updated_at)
        const count = row.message_count == null ? "" : dim(` · ${row.message_count} msgs`)
        const branch = row.git_branch ? dim(` · ${row.git_branch}`) : ""
        console.log(`  ${id}  ${shortName(row)}`)
        console.log(`            ${dim(row.project_path ?? "—")}${branch}${dim(` · ${age} ago`)}${count}`)
      }
    }
    printDivider()
    prompts.outro(dim("iris sessions send <id> \"message\"   ·   iris sessions history <id>"))
  },
})

/**
 * Sessions are addressed by full id on the bridge, but nobody types a UUID. Accept
 * a prefix and resolve it, refusing when it is ambiguous rather than guessing —
 * picking one of two matching sessions would send a message into the wrong one.
 */
async function resolveSession(
  idPrefix: string,
  provider: Provider | null,
): Promise<{ row: SessionRow; provider: Provider } | { error: string }> {
  const search: Provider[] = provider ? [provider] : [...PROVIDERS]
  const matches: { row: SessionRow; provider: Provider }[] = []

  for (const p of search) {
    for (const row of await fetchSessions(p, 50, false)) {
      if (row.session_id === idPrefix) return { row, provider: p }
      if (row.session_id.startsWith(idPrefix)) matches.push({ row, provider: p })
    }
  }

  if (matches.length === 0) return { error: `No session matching '${idPrefix}'.` }
  if (matches.length > 1) {
    const list = matches.map((m) => `${m.row.session_id.slice(0, 12)} (${m.provider})`).join(", ")
    return { error: `'${idPrefix}' matches ${matches.length} sessions: ${list}. Use more characters.` }
  }
  return matches[0]
}

const ShowCommand = cmd({
  command: "show <id>",
  describe: "show one session's details (id may be a prefix)",
  builder: (y: any) =>
    y
      .positional("id", { type: "string", describe: "session id or prefix" })
      .option("provider", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Session")
    if (!(await requireBridge())) { prompts.outro("Done"); return }

    const resolved = await resolveSession(String(args.id), args.provider ?? null)
    if ("error" in resolved) {
      prompts.log.error(resolved.error)
      prompts.outro("Done")
      return
    }

    const { row, provider } = resolved
    if (args.json) { await writeJson({ ...row, provider }); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${dim("id:")}       ${row.session_id}`)
    console.log(`  ${dim("provider:")} ${highlight(provider)}`)
    console.log(`  ${dim("name:")}     ${shortName(row)}`)
    console.log(`  ${dim("project:")}  ${row.project_path ?? "—"}`)
    if (row.git_branch) console.log(`  ${dim("branch:")}   ${row.git_branch}`)
    if (row.model) console.log(`  ${dim("model:")}    ${row.model}`)
    console.log(`  ${dim("updated:")}  ${row.updated_at ?? "—"} ${dim(`(${relativeAge(row.updated_at)} ago)`)}`)
    if (row.message_count != null) console.log(`  ${dim("messages:")} ${row.message_count}`)
    printDivider()
    prompts.outro(dim(`iris sessions send ${row.session_id.slice(0, 8)} "your message"`))
  },
})

const HistoryCommand = cmd({
  command: "history <id>",
  describe: "print a session's transcript",
  builder: (y: any) =>
    y
      .positional("id", { type: "string", describe: "session id or prefix" })
      .option("provider", { type: "string" })
      .option("limit", { type: "number", default: 20, describe: "most recent N messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Session History")
    if (!(await requireBridge())) { prompts.outro("Done"); return }

    const resolved = await resolveSession(String(args.id), args.provider ?? null)
    if ("error" in resolved) { prompts.log.error(resolved.error); prompts.outro("Done"); return }

    const { row, provider } = resolved
    const res = await bridgeFetch(`/api/sessions/${provider}/${row.session_id}/history`)
    if (!res.ok) {
      prompts.log.error(`Bridge returned HTTP ${res.status} for this session's history.`)
      prompts.outro("Done")
      return
    }
    const data = (await res.json().catch(() => null)) as any
    const messages: any[] = firstArray(data?.messages, data?.history)

    if (args.json) { await writeJson(messages); prompts.outro("Done"); return }

    if (messages.length === 0) {
      prompts.log.warn("No messages in this session's history.")
      prompts.outro("Done")
      return
    }

    const tail = messages.slice(-args.limit)
    console.log(dim(`  showing ${tail.length} of ${messages.length} messages`))
    printDivider()
    for (const m of tail) {
      const role = String(m.role ?? m.type ?? "?")
      const text = String(m.content ?? m.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
      const label = role === "user" ? highlight("user") : dim(role)
      console.log(`  ${label}  ${text.length > 160 ? text.slice(0, 159) + "…" : text}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const SendCommand = cmd({
  command: "send <id> <message>",
  aliases: ["message", "msg"],
  describe: "send a message into a running session",
  builder: (y: any) =>
    y
      .positional("id", { type: "string", describe: "session id or prefix" })
      .positional("message", { type: "string", describe: "the message to send" })
      .option("provider", { type: "string" })
      .option("url", { type: "string", describe: "session server to deliver through (default: $IRIS_SERVER, else http://127.0.0.1:4096)" })
      .option("submit", { type: "boolean", default: false, describe: "also make their agent take a turn (spends THEIR tokens). Off by default." })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Send to Session")

    const message = String(args.message ?? "").trim()
    if (message === "") {
      prompts.log.error("Refusing to send an empty message.")
      prompts.outro("Done")
      return
    }

    // ── LIVE PATH ─────────────────────────────────────────────────────────────────────────
    // Tried BEFORE the bridge, and without it. The bridge is only ever needed to RESOLVE a
    // session id; delivery is a POST to a server that is already listening. Reading the list
    // from that same server removes the bridge from the opencode path entirely, so this works
    // with the daemon down — which is when you most want to message another session.
    if (args.provider !== "claude-code") {
      const candidates = candidateServers({ url: args.url, env: process.env })
      const found = await findSessionAcrossServers(String(args.id), candidates)

      // An AMBIGUOUS id is a user error, not a reason to try another mechanism: resolving it
      // again against the bridge could pick a different session from a different list.
      if (found && "error" in found) {
        prompts.log.error(found.error)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      if (found) {
        const { base, session } = found
        const name = (session.title ?? "").trim() || "(unnamed)"
        console.log(`  ${dim("to:")} ${name} ${dim(`(opencode · ${session.id.slice(0, 12)})`)}`)

        const sp = prompts.spinner()
        sp.start("Sending…")
        // --submit runs the recipient's model turn synchronously, so it needs a turn-length
        // budget. With the notify timeout it reported "Failed" on a turn that then succeeded.
        if (args.submit) sp.message("Running their agent's turn…")
        const ok = await deliverLive(base, session.id, message, deliveryTimeoutMs({ submit: Boolean(args.submit) }), {
          submit: Boolean(args.submit),
        })
        if (ok) {
          sp.stop("Sent")
          if (args.json) { await writeJson({ ok: true, via: "live", server: base, session_id: session.id }); prompts.outro("Done"); return }
          console.log(`  ${success("✓")} ${dim("delivered live via")} ${base}`)
          if (!args.submit) console.log(`  ${dim("no model turn was spent — pass --submit to make their agent act")}`)
          prompts.outro(dim(`iris sessions history ${session.id.slice(0, 8)}`))
          return
        }
        // The server was there and the POST failed. Say so against THAT server, and do not
        // silently retry on the bridge, which cannot reach an opencode session anyway.
        sp.stop("Failed", 1)
        prompts.log.error(`Live delivery to ${base} failed for session ${session.id.slice(0, 12)}.`)
        if (args.submit) prompts.log.info(dim("--submit waits for the whole turn; a long turn can still be running."))
        prompts.log.info(dim(`Check with: iris sessions history ${session.id.slice(0, 8)}`))
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      // A named server that holds nothing is a hard failure — never a silent downgrade to the
      // bridge, which spent 180s on a known-broken path after the user had named a target.
      if (!shouldFallBackToBridge({ explicitUrl: args.url ?? null, liveFound: false })) {
        prompts.log.error(`No live session server at ${args.url} holds session '${String(args.id)}'.`)
        prompts.log.info(dim("Drop --url to try $IRIS_SERVER and the default http://127.0.0.1:4096."))
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
    }

    // ── BRIDGE PATH ───────────────────────────────────────────────────────────────────────
    // claude-code has no live server, so it still needs the daemon. Reached only after the
    // live path declined, so the bridge is no longer a precondition for the common case.
    if (!(await requireBridge())) { prompts.outro("Done"); return }

    const resolved = await resolveSession(String(args.id), args.provider ?? null)
    if ("error" in resolved) { prompts.log.error(resolved.error); prompts.outro("Done"); return }

    const { row, provider } = resolved

    // Name the target before sending. This writes into a live conversation the
    // user may be watching in another window, and a prefix that resolved to the
    // wrong session is not recoverable once the message lands.
    console.log(`  ${dim("to:")} ${shortName(row)} ${dim(`(${provider} · ${row.session_id.slice(0, 12)})`)}`)

    const spinner = prompts.spinner()
    spinner.start("Sending…")

    const res = await bridgeFetch(`/api/sessions/${provider}/${row.session_id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    })
    const body = (await res.json().catch(() => null)) as any

    if (!res.ok) {
      spinner.stop("Failed", 1)
      prompts.log.error(`Bridge returned HTTP ${res.status}${body?.error ? ` — ${body.error}` : ""}`)
      prompts.outro("Done")
      return
    }

    spinner.stop("Sent")
    if (args.json) { await writeJson(body ?? { ok: true }); prompts.outro("Done"); return }
    console.log(`  ${success("✓")} ${dim("delivered to")} ${row.session_id.slice(0, 12)}`)
    prompts.outro(dim(`iris sessions history ${row.session_id.slice(0, 8)}`))
  },
})

export const PlatformSessionsCommand = cmd({
  command: "sessions <subcommand>",
  describe: "see and steer the AI sessions running on this machine",
  builder: (y: any) =>
    y
      .command(ListCommand)
      .command(ShowCommand)
      .command(HistoryCommand)
      .command(SendCommand)
      .demandCommand(1),
  async handler() {},
})
