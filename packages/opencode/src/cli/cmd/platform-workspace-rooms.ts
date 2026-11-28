import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, writeJson, IRIS_API } from "./iris-api"
import { mintShareLink, inviteWebUrl } from "./platform-bloqs"
import {
  unseen,
  formatLine,
  parseProjectId,
  sessionLines,
  HARNESS_HINT,
  parseAgentIds,
  createRoomBody,
  readRoomView,
  readRoomRow,
  chainLine,
  presentLine,
  agentLines,
} from "./workspace-rooms-core"

// ============================================================================
// iris workspace rooms|open|share|unshare|say|watch|stop|invite — shared workspaces (#194307)
//
// A workspace is an Atlas project: its id is the shared id, its members are the team, its
// permission is the role (viewer watches, editor prompts, owner stops). A room is one live
// chat with an agent — on any member's machine, in any repo — filed under the project, so
// every member sees it as it happens. Headless by design: every command takes --json and does
// one HTTP call, so a script, a CI job or another agent (over MCP iris_run) drives it the same
// way a person does.
//
// Multi-agent rooms (#194603): `open --agents --lead` puts your IRIS agents in a room with one lead;
// `iris agents join|leave|role` change who is in it; `watch` shows the hand-off chain and who is here.
//
// Endpoints (fl-iris-api): GET/POST /api/threads, GET /api/threads/{id},
// PUT /api/threads/{id}/workspace, POST /api/threads/{id}/messages, POST /api/threads/{id}/stop.
// IRIS_API explicitly — irisFetch defaults to FL_API, and these live on iris-api (a 404 there
// reads as "no such room" when it means "wrong host").
// ============================================================================

type Args = Record<string, any>

async function fail(args: Args, msg: string): Promise<void> {
  if (args.json) await writeJson({ error: msg })
  else {
    prompts.log.error(msg)
    prompts.outro("Done")
  }
  process.exitCode = 1
}

/** One authed call to iris-api. Returns the parsed body, or null after reporting the failure. */
async function api(args: Args, what: string, path: string, init: RequestInit = {}): Promise<any | null> {
  const token = await requireAuth()
  if (!token) {
    process.exitCode = 1
    return null
  }
  const res = await irisFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }, IRIS_API)
  const text = await res.text().catch(() => "")
  let body: any = null
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  if (!res.ok) {
    const why =
      res.status === 404
        ? "No such room — or it is not shared with you."
        : res.status === 403
          ? body?.message || "Your role on this project does not allow that."
          : body?.message || body?.error || `HTTP ${res.status}`
    await fail(args, `${what}: ${why}`)
    return null
  }
  return body
}

const room = (y: any) => y.positional("room", { describe: "room id (from `iris workspace rooms <project>`)", type: "string" })
const project = (y: any) => y.positional("project", { describe: "Atlas project id — the workspace", type: "string" })
const json = (y: any) => y.option("json", { describe: "JSON output", type: "boolean", default: false })

export const WorkspaceRoomsCommand = cmd({
  command: "rooms <project>",
  describe: "every room in a workspace (an Atlas project) — the live chats your team can see",
  builder: (y) => json(project(y)),
  async handler(args: Args) {
    const id = parseProjectId(args.project)
    if (!id) return fail(args, `"${args.project}" is not an Atlas project id.`)
    const body = await api(args, "List rooms", `/api/threads?bloq_id=${id}`)
    if (!body) return
    const rows = (body.data ?? []).map((t: any) => ({ ...readRoomRow(t), owner_user_id: t.user_id, updated_at: t.updated_at }))
    if (args.json) return writeJson({ project: id, rooms: rows })
    UI.empty()
    prompts.intro(`◈  Workspace #${id} — ${rows.length} room${rows.length === 1 ? "" : "s"}`)
    if (!rows.length) console.log(`  ${dim("No rooms yet. Share a live chat: iris workspace open " + id + " --session <id>")}`)
    for (const r of rows) {
      console.log(`  ${bold(r.name || "(unnamed)")}  ${dim(r.id)}`)
      const bits = [
        `${r.sessions.length} live session${r.sessions.length === 1 ? "" : "s"}`,
        ...(r.agents.length ? [`${r.agents.length} agent${r.agents.length === 1 ? "" : "s"}`] : []),
        `${r.messages ?? 0} message${r.messages === 1 ? "" : "s"}`,
        ...(r.unread ? [`${r.unread} unread`] : []),
        ...(r.present.length ? [`${r.present.length} here`] : []),
        ...(r.working ? ["working"] : []),
      ]
      console.log(`    ${dim(bits.join(" · "))}`)
      if (r.last) console.log(`    ${dim(r.last)}`)
    }
    prompts.outro(dim("iris workspace watch <room>"))
  },
})

export const WorkspaceOpenCommand = cmd({
  command: "open <project>",
  describe: "open a room in a workspace — around a live chat (--session) and/or a multi-agent room of your IRIS agents with a lead (--agents, --lead)",
  builder: (y) =>
    json(project(y))
      .option("session", { describe: "a live chat to share (Claude Code, opencode, or an `iris acp run --keep` Codex/Gemini) — ids from `iris hive sessions`", type: "string" })
      .option("agents", { describe: "your IRIS agents to put in the room, comma-separated ids (see: iris agents list)", type: "string" })
      .option("lead", { describe: "the agent that takes your request first and hands parts to the others (one per room)", type: "string" })
      .option("always-on", { describe: "agents answer every message, not only when @mentioned", type: "boolean", default: false })
      .option("name", { describe: "room name", type: "string" })
      .example("iris workspace open 652 --session ses_abc123", "share one live chat with the team")
      .example("iris workspace open 652 --agents 101,102,103 --lead 101 --name \"Launch plan\"", "three agents, 101 leads")
      .example("iris workspace open 652 --session ses_abc123 --agents 101 --lead 101", "your chat and an agent, side by side"),
  async handler(args: Args) {
    const id = parseProjectId(args.project)
    if (!id) return fail(args, `"${args.project}" is not an Atlas project id.`)
    const sid = args.session === undefined ? "" : String(args.session).trim()
    if (args.session !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) return fail(args, `"${args.session}" is not a session id. ${HARNESS_HINT}`)
    const picked = args.agents === undefined ? { ids: [] as string[] } : parseAgentIds(args.agents)
    if ("error" in picked) return fail(args, picked.error)
    const name = String(args.name ?? "").trim() || (sid ? `session ${sid.slice(0, 8)}` : "Agents room")
    const roomBody = createRoomBody({ name, agents: picked.ids, lead: args.lead ?? null, sessionId: sid || null, alwaysOn: Boolean(args["always-on"]) })
    if ("error" in roomBody) return fail(args, roomBody.error)
    const created = await api(args, "Open room", "/api/threads", { method: "POST", body: JSON.stringify(roomBody) })
    if (!created) return
    const roomId = created.thread?.id
    const filed = await api(args, "Share with the workspace", `/api/threads/${encodeURIComponent(roomId)}/workspace`, {
      method: "PUT",
      body: JSON.stringify({ bloq_id: id }),
    })
    if (!filed) return
    const agents = readRoomView(created).agents
    if (args.json) return writeJson({ room: roomId, project: id, session: sid || null, name, agents })
    console.log(`  ${success("✓")} ${bold(name)} is shared with workspace #${id}`)
    console.log(`  ${dim("room")} ${roomId}`)
    for (const line of agentLines(agents)) console.log(`  ${dim(line)}`)
    if (agents.length) console.log(`  ${dim("ask the agents: iris workspace say " + roomId + ' --agents "…"   ·   change who leads: iris agents role ' + roomId + " lead --agent <id>")}`)
    console.log(`  ${dim("teammates: iris workspace watch " + roomId + "   ·   iris workspace say " + roomId + ' "…"')}`)
  },
})

function shareCommand(mode: "share" | "unshare") {
  return cmd({
    command: mode === "share" ? "share <room> <project>" : "unshare <room>",
    describe: mode === "share" ? "file an existing room under a workspace (you need editor on the project)" : "make a room personal again",
    builder: (y) => json(mode === "share" ? project(room(y)) : room(y)),
    async handler(args: Args) {
      let bloq: number | null = null
      if (mode === "share") {
        bloq = parseProjectId(args.project)
        if (!bloq) return fail(args, `"${args.project}" is not an Atlas project id.`)
      }
      const body = await api(args, mode === "share" ? "Share room" : "Unshare room", `/api/threads/${encodeURIComponent(args.room)}/workspace`, {
        method: "PUT",
        body: JSON.stringify({ bloq_id: bloq }),
      })
      if (!body) return
      if (args.json) return writeJson(body)
      console.log(`  ${success("✓")} ${body.message ?? "done"}`)
    },
  })
}
export const WorkspaceShareCommand = shareCommand("share")
export const WorkspaceUnshareCommand = shareCommand("unshare")

export const WorkspaceSayCommand = cmd({
  command: "say <room> <message..>",
  describe: "prompt a shared room — your words go into its live session(s), labelled with your name",
  builder: (y) =>
    json(room(y))
      .positional("message", { describe: "what to say", type: "string", array: true })
      .option("agents", { describe: "also let the room's IRIS agents reply — room owner only (they run on the owner's account)", type: "boolean", default: false }),
  async handler(args: Args) {
    const content = (Array.isArray(args.message) ? args.message.join(" ") : String(args.message ?? "")).trim()
    if (!content) return fail(args, "Nothing to say.")
    const body = await api(args, "Send", `/api/threads/${encodeURIComponent(args.room)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, trigger_responses: Boolean(args.agents) }),
    })
    if (!body) return
    if (args.json) return writeJson(body)
    if (body.delivery_held) {
      console.log(`  ${success("✓")} saved in the room ${dim("· " + (body.delivery_note ?? "not typed into the live session this minute"))}`)
      return
    }
    if (body.agents_note) console.log(`  ${dim(body.agents_note)}`)
    if ((body.node_deliveries ?? []).some((d: any) => d.parked)) {
      console.log(`  ${success("✓")} saved ${dim("· " + (body.delivery_note ?? "the computer is offline; it will get this when it is back"))}`)
      return
    }
    const reached = (body.node_deliveries ?? []).length
    console.log(`  ${success("✓")} sent ${dim(reached ? `· delivered to ${reached} live session${reached === 1 ? "" : "s"}` : "· no live session took it (is the host machine on?)")}`)
  },
})

export const WorkspaceWatchCommand = cmd({
  command: "watch <room>",
  describe: "follow a room as it happens — messages, its agents and who leads, agents handing work to each other, who is here (Ctrl-C to stop)",
  builder: (y) =>
    json(room(y))
      .option("interval", { describe: "seconds between reads", type: "number", default: 2 })
      .option("once", { describe: "print what is there and exit", type: "boolean", default: false })
      .example("iris workspace watch <room>", "follow along")
      .example("iris workspace watch <room> --once --json", "one JSON line per message, plus {kind:\"room\"} lines for agents, chain and who is here"),
  async handler(args: Args) {
    const seen = new Set<string>()
    const every = Math.max(1, Number(args.interval) || 2) * 1000
    let first = true
    let lastState = ""
    while (true) {
      const body = await api(args, "Read room", `/api/threads/${encodeURIComponent(args.room)}`)
      if (!body) return
      const view = readRoomView(body)
      if (first && !args.json) {
        UI.empty()
        prompts.intro(`◈  ${view.name}`)
        for (const line of sessionLines(body.sessions)) console.log(`  ${dim(line)}`)
        for (const line of agentLines(view.agents)) console.log(`  ${dim(line)}`)
        first = false
      }
      // The hand-off chain and who is here change between polls: print them when they do.
      const state = JSON.stringify({ chain: view.chain, present: view.present, agents: view.agents })
      if (state !== lastState) {
        if (args.json) console.log(JSON.stringify({ kind: "room", agents: view.agents, chain: view.chain, present: view.present }))
        else {
          const prev = lastState ? JSON.parse(lastState) : null
          const changed = (k: "chain" | "present" | "agents") => !prev || JSON.stringify(prev[k]) !== JSON.stringify(view[k])
          if (prev && changed("agents")) for (const line of agentLines(view.agents)) console.log(`  ${dim(line)}`)
          if (changed("chain")) {
            const talk = chainLine(view.chain)
            if (talk) console.log(`  ${bold(talk)}`)
            else if (prev?.chain) console.log(`  ${dim("agents finished handing off")}`)
          }
          if (changed("present")) console.log(`  ${dim(presentLine(view.present) ?? "nobody here right now")}`)
        }
        lastState = state
      }
      for (const m of unseen(seen, body.messages ?? [])) {
        if (args.json) console.log(JSON.stringify(m))
        else console.log(`  ${formatLine(m)}`)
      }
      if (args.once) return
      await new Promise((r) => setTimeout(r, every))
    }
  },
})

export const WorkspaceStopCommand = cmd({
  command: "stop <room>",
  describe: "stop what a shared room's sessions are doing right now (project or room owners)",
  builder: (y) => json(room(y)),
  async handler(args: Args) {
    const body = await api(args, "Stop", `/api/threads/${encodeURIComponent(args.room)}/stop`, { method: "POST", body: "{}" })
    if (!body) return
    if (args.json) return writeJson(body)
    for (const s of body.stopped ?? []) {
      if (s.error) console.log(`  ${dim("✗")} ${s.session_id}: ${s.error}`)
      else console.log(`  ${success("✓")} stop sent to ${s.session_id} ${dim(`(${s.provider})`)}`)
    }
    if (!(body.stopped ?? []).length) console.log(`  ${dim("This room has no live session to stop.")}`)
  },
})

export const WorkspaceInviteCommand = cmd({
  command: "invite <project>",
  describe: "a join link for the workspace — an Atlas invite (viewer watches, editor prompts)",
  builder: (y) =>
    json(project(y))
      .option("role", { describe: "what the link grants", type: "string", choices: ["viewer", "editor"], default: "editor" })
      .option("email", { describe: "only this address can use the link (recommended)", type: "string" })
      .option("expires", { describe: "expiry, ISO date (e.g. 2026-12-31)", type: "string" })
      .option("max-uses", { describe: "how many people can use it", type: "number" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args: Args) {
    const id = parseProjectId(args.project)
    if (!id) return fail(args, `"${args.project}" is not an Atlas project id.`)
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return
    let link
    try {
      link = await mintShareLink(id, userId, { permission: args.role, email: args.email ?? null, expiresAt: args.expires ?? null, maxUses: args["max-uses"] ?? null })
    } catch (err) {
      return fail(args, err instanceof Error ? err.message : String(err))
    }
    const url = inviteWebUrl(link.token)
    if (args.json) return writeJson({ ...link, url, project: id })
    console.log(url)
    console.log(dim(`  ${link.permission} · ${args.email ? `only ${args.email}` : "anyone with the link"}${link.expires_at ? ` · until ${link.expires_at}` : ""}`))
  },
})
