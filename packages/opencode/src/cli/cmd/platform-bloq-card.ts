/**
 * A card's checklist and its assignees, from the CLI (#189800, epic #189801).
 *
 * fl-api has had nested card tasks since February 2026 — status, parent_id, agent, due date,
 * roll-up completion — and the CLI could not reach any of it (#181892), so every epic was
 * modelled as an item plus loose sibling items. Assignees arrived with fl-api #121: assigning a
 * person who is not on the board gives them the cards assigned to them (ADR-02).
 *
 *   iris bloqs tasks <item-id>                         the checklist, nested
 *   iris bloqs task-add <item-id> <title> [--parent N] [--due D] [--agent N]
 *   iris bloqs task-done <item-id> <task-id> [--undo]
 *   iris bloqs task-delete <item-id> <task-id> --force
 *   iris bloqs assignees <item-id>
 *   iris bloqs assign <item-id> (--user N | --email E | --agent N)
 *   iris bloqs unassign <item-id> <assignee-id>
 *
 * Every write goes through the same fl-api routes and policy as IRIS Desktop.
 */
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, success, isNonInteractive } from "./iris-api"
import { normalizeDueDate } from "./bloq-item-format"

export interface CardTask {
  id: number
  title: string
  done: boolean
  depth: number
  status?: string
  agentId?: number
  agentName?: string
  dueDate?: string
  parentId?: number
}

/** fl-api's getTasks nests children under `children[]`; flatten with a depth, top to bottom. */
export function flattenTasks(rows: unknown, depth = 0, out: CardTask[] = []): CardTask[] {
  for (const t of Array.isArray(rows) ? (rows as any[]) : []) {
    out.push({
      id: Number(t.id),
      title: String(t.title ?? "untitled"),
      done: Boolean(t.is_completed) || t.status === "done",
      depth,
      ...(t.status ? { status: String(t.status) } : {}),
      ...(t.agent_id != null ? { agentId: Number(t.agent_id) } : {}),
      ...(t.agent?.name ? { agentName: String(t.agent.name) } : {}),
      ...(t.due_date ? { dueDate: String(t.due_date).slice(0, 10) } : {}),
      ...(t.parent_id != null ? { parentId: Number(t.parent_id) } : {}),
    })
    if (Array.isArray(t.children) && t.children.length) flattenTasks(t.children, depth + 1, out)
  }
  return out
}

/** The checklist as a person reads it: indented, ticked, with progress on top. */
export function formatTaskTree(tasks: CardTask[]): string {
  if (!tasks.length) return "No checklist on this card yet."
  const done = tasks.filter((t) => t.done).length
  const lines = [`${done}/${tasks.length} done`]
  for (const t of tasks) {
    const extra = [t.agentName ? `agent: ${t.agentName}` : t.agentId ? `agent #${t.agentId}` : "", t.dueDate ? `due ${t.dueDate}` : ""]
      .filter(Boolean)
      .join(" · ")
    lines.push(`${"  ".repeat(t.depth)}${t.done ? "[x]" : "[ ]"} ${t.title}  ${dim(`#${t.id}`)}${extra ? `  ${dim(extra)}` : ""}`)
  }
  return lines.join("\n")
}

export interface CardAssignee {
  id: number
  type: "user" | "agent"
  user_id?: number
  agent_id?: number
  name?: string | null
}

export function formatAssignees(rows: CardAssignee[]): string {
  if (!rows.length) return "Nobody is assigned to this card."
  return rows
    .map((a) => `${a.type === "agent" ? "agent" : "person"}  ${a.name ?? "(no name)"}  ${dim(`assignee #${a.id} · ${a.type === "agent" ? `agent ${a.agent_id}` : `user ${a.user_id}`}`)}`)
    .join("\n")
}

/** JSON body of a fl-api reply, and a reason to print when it failed. */
async function reply(res: Response): Promise<{ ok: boolean; data: any; reason: string }> {
  const j = (await res.json().catch(() => ({}))) as any
  const errs = j?.errors && typeof j.errors === "object" ? Object.values(j.errors).flat().join("; ") : ""
  return { ok: res.ok, data: j?.data ?? j, reason: String(errs || j?.message || `HTTP ${res.status}`) }
}

function fail(json: boolean, msg: string, code = 1) {
  if (json) console.log(JSON.stringify({ success: false, error: msg }))
  else {
    prompts.log.error(msg)
    prompts.outro("Done")
  }
  process.exitCode = code
}

async function loadTasks(itemId: number): Promise<{ ok: boolean; tasks: CardTask[]; reason: string }> {
  const r = await reply(await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks`))
  const rows = Array.isArray(r.data) ? r.data : (r.data?.tasks ?? [])
  return { ok: r.ok, tasks: r.ok ? flattenTasks(rows) : [], reason: r.reason }
}

// ── checklist ───────────────────────────────────────────────────────────────

export const BloqsTasksCommand = cmd({
  command: "tasks <item-id>",
  aliases: ["checklist"],
  describe: "show a card's checklist (tasks and nested subtasks)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Checklist · card #${args["item-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const r = await loadTasks(Number(args["item-id"]))
    if (!r.ok) return fail(json, `Could not read the checklist: ${r.reason}`)
    if (json) return void console.log(JSON.stringify({ success: true, tasks: r.tasks }))
    console.log(formatTaskTree(r.tasks))
    prompts.outro(dim(`iris bloqs task-add ${args["item-id"]} "<title>" [--parent <task-id>]  ·  iris bloqs task-done ${args["item-id"]} <task-id>`))
  },
})

export const BloqsTaskAddCommand = cmd({
  command: "task-add <item-id> <title>",
  aliases: ["add-task"],
  describe: "add a checklist item to a card (--parent makes it a subtask)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .positional("title", { describe: "what needs doing", type: "string", demandOption: true })
      .option("parent", { describe: "make it a subtask of this task ID — finishing every child completes the parent", type: "number" })
      .option("due", { describe: "due date (YYYY-MM-DD)", type: "string" })
      .option("agent", { describe: "give the task to this agent ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Add to checklist · card #${args["item-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const title = String(args.title ?? "").trim()
    if (!title) return fail(json, "A task needs a title", 2)
    const body: Record<string, unknown> = { title, status: "todo" }
    if (args.parent !== undefined) body.parent_id = Number(args.parent)
    if (args.agent !== undefined) body.agent_id = Number(args.agent)
    if (args.due !== undefined) {
      const d = normalizeDueDate(String(args.due))
      if (!d) return fail(json, `Invalid --due "${args.due}" — use YYYY-MM-DD`, 2)
      body.due_date = d
    }
    const r = await reply(
      await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}/tasks`, { method: "POST", body: JSON.stringify(body) }),
    )
    if (!r.ok) return fail(json, `Not added: ${r.reason}`)
    const id = Number(r.data?.id ?? r.data?.task?.id)
    if (json) return void console.log(JSON.stringify({ success: true, task: Number.isFinite(id) ? { id, ...body } : body }))
    prompts.log.success(`${success("✓")} Added${args.parent !== undefined ? ` under task #${args.parent}` : ""}: ${title}${Number.isFinite(id) ? dim(`  #${id}`) : ""}`)
    prompts.outro("Done")
  },
})

export const BloqsTaskDoneCommand = cmd({
  command: "task-done <item-id> <task-id>",
  aliases: ["done-task", "tick"],
  describe: "tick a checklist item (--undo to reopen it)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .positional("task-id", { describe: "task ID (from iris bloqs tasks)", type: "number", demandOption: true })
      .option("undo", { describe: "reopen instead of completing", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  ${args.undo ? "Reopen" : "Complete"} task #${args["task-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const done = !args.undo
    const r = await reply(
      await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}/tasks/${args["task-id"]}`, {
        method: "PUT",
        body: JSON.stringify({ is_completed: done }),
      }),
    )
    if (!r.ok) return fail(json, `Not saved: ${r.reason}`)
    // Read it back: completing the last child completes its parent, and the reader should see that.
    const after = await loadTasks(Number(args["item-id"]))
    if (json) return void console.log(JSON.stringify({ success: true, done, tasks: after.ok ? after.tasks : undefined }))
    prompts.log.success(`${success("✓")} ${done ? "Done" : "Reopened"}`)
    if (after.ok) console.log(formatTaskTree(after.tasks))
    prompts.outro("Done")
  },
})

export const BloqsTaskDeleteCommand = cmd({
  command: "task-delete <item-id> <task-id>",
  aliases: ["rm-task"],
  describe: "delete a checklist item (and its subtasks)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .positional("task-id", { describe: "task ID", type: "number", demandOption: true })
      .option("force", { describe: "skip confirmation (required in a non-interactive shell)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!args.force && isNonInteractive()) return fail(json, "Refusing to delete without --force in a non-interactive shell.", 2)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Delete task #${args["task-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    if (!args.force) {
      const ok = await prompts.confirm({ message: "Delete this checklist item and its subtasks?" })
      if (prompts.isCancel(ok) || !ok) return void prompts.outro("Cancelled")
    }
    const r = await reply(
      await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}/tasks/${args["task-id"]}`, { method: "DELETE" }),
    )
    if (!r.ok) return fail(json, `Not deleted: ${r.reason}`)
    if (json) return void console.log(JSON.stringify({ success: true }))
    prompts.log.success(`${success("✓")} Deleted`)
    prompts.outro("Done")
  },
})

// ── assignees ───────────────────────────────────────────────────────────────

async function assigneesUrl(itemId: number): Promise<string | null> {
  const userId = await requireUserId()
  return userId ? `/api/v1/user/${userId}/bloqs/list/item/${itemId}/assignees` : null
}

export const BloqsAssigneesCommand = cmd({
  command: "assignees <item-id>",
  describe: "who a card is assigned to",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Assignees · card #${args["item-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const url = await assigneesUrl(Number(args["item-id"]))
    if (!url) return void (!json && prompts.outro("Done"))
    const r = await reply(await irisFetch(url))
    if (!r.ok) return fail(json, `Could not read assignees: ${r.reason}`)
    const rows: CardAssignee[] = r.data?.assignees ?? []
    if (json) return void console.log(JSON.stringify({ success: true, assignees: rows }))
    console.log(formatAssignees(rows))
    prompts.outro(dim(`iris bloqs assign ${args["item-id"]} --user <id> | --email <address> | --agent <id>`))
  },
})

export const BloqsAssignCommand = cmd({
  command: "assign <item-id>",
  describe: "assign a person (by id or email) or an agent to a card — someone not on the board gets access to the cards assigned to them",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .option("user", { describe: "user ID of a person", type: "number" })
      .option("email", { describe: "a person's email — invited if not on the board (owner only)", type: "string" })
      .option("agent", { describe: "agent ID", type: "number" })
      // Registered as "no-notify" explicitly: this CLI's parser does not accept an implied --no-X
      // (negated-flags.test.ts).
      .option("no-notify", { describe: "do not email someone this assignment invites to the board", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    const given = [args.user, args.email, args.agent].filter((v) => v !== undefined && v !== "")
    if (given.length !== 1) return fail(json, "Give exactly one of --user, --email or --agent", 2)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Assign · card #${args["item-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const url = await assigneesUrl(Number(args["item-id"]))
    if (!url) return void (!json && prompts.outro("Done"))
    const body =
      args.user !== undefined
        ? { user_id: Number(args.user) }
        : args.agent !== undefined
          ? { agent_id: Number(args.agent) }
          : { email: String(args.email).trim() }
    const r = await reply(
      await irisFetch(url, { method: "POST", body: JSON.stringify({ ...body, notify: !args["no-notify"] }) }),
    )
    if (!r.ok) return fail(json, `Not assigned: ${r.reason}`)
    const granted = r.data?.access_granted === true
    if (json) return void console.log(JSON.stringify({ success: true, access_granted: granted, assignees: r.data?.assignees ?? [] }))
    prompts.log.success(`${success("✓")} Assigned`)
    if (granted) prompts.log.info("They were not on this board: they can now see and work on the cards assigned to them, and nothing else.")
    console.log(formatAssignees(r.data?.assignees ?? []))
    prompts.outro("Done")
  },
})

export const BloqsUnassignCommand = cmd({
  command: "unassign <item-id> <assignee-id>",
  describe: "unassign someone from a card (assignee ID from iris bloqs assignees)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "card (item) ID", type: "number", demandOption: true })
      .positional("assignee-id", { describe: "assignee ID (not the user ID)", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = Boolean(args.json)
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Unassign · card #${args["item-id"]}`)
    }
    if (!(await requireAuth())) return void (!json && prompts.outro("Done"))
    const base = await assigneesUrl(Number(args["item-id"]))
    if (!base) return void (!json && prompts.outro("Done"))
    const r = await reply(await irisFetch(`${base}/${args["assignee-id"]}`, { method: "DELETE" }))
    if (!r.ok) return fail(json, `Not unassigned: ${r.reason}`)
    const removed = r.data?.access_removed === true
    if (json) return void console.log(JSON.stringify({ success: true, access_removed: removed, assignees: r.data?.assignees ?? [] }))
    prompts.log.success(`${success("✓")} Unassigned`)
    if (removed) prompts.log.info("That was their last card on this board, so their access to it has ended.")
    prompts.outro("Done")
  },
})
