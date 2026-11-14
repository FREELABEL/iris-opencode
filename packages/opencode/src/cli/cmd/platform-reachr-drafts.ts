import { cmd } from "./cmd"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, writeJson } from "./iris-api"

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

interface Batch {
  id: number
  name: string
  status: string
  stopped_reason: string | null
  starts_at: string | null
  pace_min_seconds: number
  pace_max_seconds: number
  counts: Record<string, number>
  messages?: Draft[]
}

interface Draft {
  id: number
  status: string
  to_email: string | null
  subject: string | null
  body: string | null
  warning: string | null
  hold_reason: string | null
  send_error: string | null
  scheduled_for: string | null
}

/** The answer's data, or null after reporting the refusal. Exits non-zero so `&&` chains stop here. */
async function call<T>(path: string, action: string, init?: RequestInit): Promise<T | null> {
  const res = await irisFetch(`/api/v1/outreach/${path}`, init ?? {}, RAICHU)
  if (!res.ok) {
    await handleApiError(res, action)
    process.exitCode = 1
    return null
  }
  return ((await res.json()) as { data: T }).data
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

/** A batch by id or exact name. The newest wins when a name was reused. */
async function resolveBatch(ref: string): Promise<Batch | null> {
  const found = /^\d+$/.test(ref)
    ? { id: Number(ref) }
    : (await call<Batch[]>("batches", "list batches"))?.find((b) => b.name === ref)
  if (!found) {
    if (!process.exitCode) console.error(`No batch named "${ref}"`)
    process.exitCode = 1
    return null
  }
  return call<Batch>(`batches/${found.id}`, `read batch ${ref}`)
}

/** "30s", "5m" or "2h" as seconds. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)(s|m|h)$/.exec(text.trim())
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"] : null
}

/** "5m" is exactly five minutes apart, "3m-5m" a random spacing inside that range. */
export function parsePace(text: string): { min: number; max: number } | null {
  const [low, high] = text.split("-")
  const min = parseDuration(low ?? "")
  const max = high === undefined ? min : parseDuration(high)
  return min !== null && max !== null && min <= max ? { min, max } : null
}

/** "+1m" from now, or anything Date understands. Null rather than a wrong send time. */
export function parseWhen(text: string, now = Date.now()): string | null {
  if (text.startsWith("+")) {
    const seconds = parseDuration(text.slice(1))
    return seconds === null ? null : new Date(now + seconds * 1000).toISOString()
  }
  const at = new Date(text)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

function refuse(message: string) {
  console.error(message)
  process.exitCode = 1
}

const batchOption = (y: any) => y.option("batch", { type: "string", demandOption: true, describe: "batch name or id" })
const jsonOption = (y: any) => y.option("json", { type: "boolean", default: false })

const DraftsCreateCommand = cmd({
  command: "create",
  describe: "add drafts to a batch for a person to review. Sends nothing",
  builder: (y) =>
    jsonOption(batchOption(y))
      .option("from", { type: "string", demandOption: true, describe: "JSON file: a list of {lead_id, to_email, to_name, subject, body, warning, group}" })
      .option("account", { type: "number", describe: "integration id every message in a new batch leaves from" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const drafts = await Bun.file(args.from as string).json().catch(() => null)
    if (!Array.isArray(drafts) || drafts.length === 0) return refuse(`${args.from} must be a JSON list of drafts`)

    const name = args.batch as string
    const existing = (await call<Batch[]>("batches", "list batches"))?.find((b) => b.name === name)
    const batch = existing ?? (await call<Batch>("batches", "create batch", post({ name, integration_id: args.account })))
    if (!batch) return

    const ids: number[] = []
    for (const draft of drafts) {
      const made = await call<Draft>(`batches/${batch.id}/messages`, `add draft for ${draft.to_email}`, post(draft))
      if (!made) return
      ids.push(made.id)
    }
    if (args.json) return writeJson({ batch_id: batch.id, message_ids: ids })
    console.log(`${success("✓")} ${ids.length} drafts in ${bold(name)} (#${batch.id}). Nothing has been sent.`)
    console.log(dim(`Review them: iris reachr drafts list --batch ${batch.id}`))
  },
})

const DraftsListCommand = cmd({
  command: "list",
  describe: "list batches, or the exact messages in one",
  builder: (y) => jsonOption(y).option("batch", { type: "string", describe: "batch name or id" }),
  async handler(args) {
    if (!(await requireAuth())) return
    if (!args.batch) {
      const batches = await call<Batch[]>("batches", "list batches")
      if (!batches) return
      if (args.json) return writeJson(batches)
      for (const b of batches) {
        const counts = Object.entries(b.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")
        console.log(`  ${bold(`#${b.id}`)} ${b.name}  ${b.status}  ${dim(counts)}`)
      }
      return
    }
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    if (args.json) return writeJson(batch)
    console.log(`${bold(batch.name)} #${batch.id}  ${batch.status}${batch.stopped_reason ? `: ${batch.stopped_reason}` : ""}`)
    for (const m of batch.messages ?? []) {
      console.log(`\n  ${bold(`#${m.id}`)} ${m.status}${m.scheduled_for ? ` ${dim(m.scheduled_for)}` : ""}  → ${m.to_email ?? "?"}`)
      console.log(`  ${m.subject ?? "(no subject)"}`)
      if (m.warning) console.log(`  ${highlight(`⚠ ${m.warning}`)}`)
      if (m.hold_reason) console.log(`  ${dim(`held: ${m.hold_reason}`)}`)
      if (m.send_error) console.log(`  ${highlight(`✗ ${m.send_error}`)}`)
      console.log(dim((m.body ?? "").replace(/^/gm, "    ")))
    }
  },
})

const DraftsEditCommand = cmd({
  command: "edit <id>",
  describe: "change a message's words. An edit clears its approval and send time",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("subject", { type: "string" })
      .option("body", { type: "string", describe: "the new body" })
      .option("body-file", { type: "string", describe: "read the new body from a file" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const body = args.bodyFile ? await Bun.file(args.bodyFile as string).text() : (args.body as string | undefined)
    if (!body) return refuse("Give the new words with --body or --body-file")
    const made = await call<Draft>(`messages/${args.id}/text`, `edit message #${args.id}`, {
      method: "PUT",
      body: JSON.stringify({ body, ...(args.subject ? { subject: args.subject } : {}) }),
    })
    if (made) console.log(`${success("✓")} Message #${made.id} is ${made.status}`)
  },
})

const DraftsApproveCommand = cmd({
  command: "approve [ids..]",
  describe: "record a person's approval of the exact text. Sends nothing",
  builder: (y) =>
    jsonOption(batchOption(y))
      .positional("ids", { type: "number", array: true })
      .option("all", { type: "boolean", default: false, describe: "every message waiting in the batch" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const ids = (args.ids as number[] | undefined) ?? []
    if (!args.all && ids.length === 0) return refuse("Name message ids, or pass --all")
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    const done = await call<{ approved: number[]; refused: { id: number; error: string }[] }>(
      `batches/${batch.id}/approve`,
      "approve",
      post(args.all ? { all: true } : { ids }),
    )
    if (!done) return
    if (done.refused.length) process.exitCode = 1
    if (args.json) return writeJson(done)
    console.log(`${success("✓")} ${done.approved.length} approved. Not sent: ${highlight(`iris reachr drafts schedule --batch ${batch.id} --at <when>`)}`)
    for (const r of done.refused) console.log(`  ✗ #${r.id} ${r.error}`)
  },
})

const DraftsHoldCommand = cmd({
  command: "hold <id>",
  describe: "keep a message out of the send until a person releases it",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("reason", { type: "string" })
      .option("release", { type: "boolean", default: false, describe: "put a held message back in review" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const made = args.release
      ? await call<Draft>(`messages/${args.id}/release`, `release message #${args.id}`, post({}))
      : await call<Draft>(`messages/${args.id}/hold`, `hold message #${args.id}`, post({ reason: args.reason }))
    if (made) console.log(`${success("✓")} Message #${made.id} is ${made.status}`)
  },
})

const DraftsScheduleCommand = cmd({
  command: "schedule",
  describe: "give approved messages a send time. They go one at a time; the first failure stops the batch",
  builder: (y) =>
    jsonOption(batchOption(y))
      .option("at", { type: "string", demandOption: true, describe: 'when the first goes: "+1m" or a date and time with its zone' })
      .option("pace", { type: "string", describe: 'time between messages: "5m" or "3m-5m"' }),
  async handler(args) {
    if (!(await requireAuth())) return
    const at = parseWhen(args.at as string)
    if (!at) return refuse(`Can't read --at "${args.at}"`)
    const pace = args.pace ? parsePace(args.pace as string) : undefined
    if (pace === null) return refuse(`Can't read --pace "${args.pace}". Use 5m or 3m-5m`)
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    const done = await call<Batch>(`batches/${batch.id}/schedule`, "schedule", post({ at, ...(pace ? { pace_min_seconds: pace.min, pace_max_seconds: pace.max } : {}) }))
    if (!done) return
    if (args.json) return writeJson(done)
    console.log(`${success("✓")} ${done.counts?.scheduled ?? 0} scheduled from ${at}`)
  },
})

const DraftsStopCommand = cmd({
  command: "stop",
  describe: "stop a batch. What has not gone stays scheduled until you schedule it again",
  builder: (y) => batchOption(y).option("reason", { type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    const done = await call<Batch>(`batches/${batch.id}/stop`, "stop", post({ reason: args.reason }))
    if (done) console.log(`${success("✓")} ${done.name} stopped`)
  },
})

const DraftsWaitCommand = cmd({
  command: "wait",
  describe: "wait until every scheduled message reached a state. Exits non-zero if the batch stops or time runs out",
  builder: (y) =>
    batchOption(y)
      .option("state", { type: "string", default: "sent", describe: "the state to wait for" })
      .option("timeout", { type: "string", default: "5m" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const timeout = parseDuration(args.timeout as string)
    if (timeout === null) return refuse(`Can't read --timeout "${args.timeout}"`)
    const deadline = Date.now() + timeout * 1000
    while (true) {
      const batch = await resolveBatch(args.batch as string)
      if (!batch) return
      if (batch.status === "stopped") return refuse(`The batch stopped: ${batch.stopped_reason ?? "no reason recorded"}`)
      const inFlight = (batch.messages ?? []).filter((m) => ["approved", "scheduled", "pre_check"].includes(m.status))
      if (inFlight.length === 0 && (batch.messages ?? []).some((m) => m.status === args.state)) {
        console.log(`${success("✓")} ${batch.name}: ${batch.counts?.[args.state as string] ?? 0} ${args.state}`)
        return
      }
      if (Date.now() >= deadline) return refuse(`Timed out with ${inFlight.length} not yet ${args.state}`)
      await Bun.sleep(5000)
    }
  },
})

const DraftsCheckCommand = cmd({
  command: "check",
  describe: "read-only: what would stop or should worry you before scheduling",
  builder: (y) => jsonOption(batchOption(y)),
  async handler(args) {
    if (!(await requireAuth())) return
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    const messages = batch.messages ?? []
    const seen = new Set<string>()
    const findings = messages.flatMap((m) => {
      const found: string[] = []
      const address = (m.to_email ?? "").toLowerCase()
      if (!address) found.push("no recipient")
      if (address && seen.has(address)) found.push(`a second message to ${address}`)
      seen.add(address)
      if (!m.subject?.trim()) found.push("no subject")
      if (!m.body?.trim()) found.push("no body")
      if (m.warning) found.push(m.warning)
      return found.map((problem) => ({ id: m.id, status: m.status, problem }))
    })
    if (args.json) await writeJson({ ok: findings.length === 0, findings })
    else if (findings.length === 0) console.log(`${success("✓")} Nothing to flag in ${messages.length} messages`)
    else for (const f of findings) console.log(`  ⚠ #${f.id} (${f.status}) ${f.problem}`)
    if (findings.length) process.exitCode = 1
  },
})

const DraftsAuditCommand = cmd({
  command: "audit",
  describe: "prove it: every sent message has a person's approval, one send, a ledger entry and the approved text",
  builder: (y) => jsonOption(batchOption(y)),
  async handler(args) {
    if (!(await requireAuth())) return
    const batch = await resolveBatch(args.batch as string)
    if (!batch) return
    const audit = await call<{ ok: boolean; messages: { id: number; status: string; ok: boolean; problems: string[] }[] }>(`batches/${batch.id}/audit`, "audit")
    if (!audit) return
    if (!audit.ok) process.exitCode = 1
    if (args.json) return writeJson(audit)
    for (const m of audit.messages) console.log(`  ${m.ok ? success("✓") : "✗"} #${m.id} ${m.status}${m.problems.length ? `: ${m.problems.join("; ")}` : ""}`)
    console.log(audit.ok ? `${success("✓")} Audit passed` : "Audit failed")
  },
})

export const ReachrDraftsCmd = cmd({
  command: "drafts",
  describe: "review a batch of exact messages, approve some, hold others, schedule the rest, and prove what went out",
  builder: (y) =>
    y
      .command(DraftsCreateCommand)
      .command(DraftsListCommand)
      .command(DraftsEditCommand)
      .command(DraftsApproveCommand)
      .command(DraftsHoldCommand)
      .command(DraftsScheduleCommand)
      .command(DraftsStopCommand)
      .command(DraftsWaitCommand)
      .command(DraftsCheckCommand)
      .command(DraftsAuditCommand)
      .demandCommand(1),
  handler() {},
})
