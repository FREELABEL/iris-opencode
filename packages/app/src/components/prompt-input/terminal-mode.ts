import { createStore, produce } from "solid-js/store"

// Terminal mode (#190530). Shell mode used to send each command into the chat as its own turn
// (session.shell), so running three commands meant three chat exchanges and re-entering shell
// mode each time. Now the commands run through the sidecar's terminal routes, which record
// nothing in the session; their output lives here while the terminal is open, and closing it
// appends the whole transcript to the session as ONE message that does not wake the model.
//
// Module state, keyed by session, because the polling loop must outlive whichever composer
// started it (the legacy and v2 composers swap, and a re-render must not drop a running command).

export type TerminalStatus = "starting" | "running" | "exited" | "cancelled" | "error"

export type TerminalEntry = {
  key: string
  runID?: string
  command: string
  output: string
  truncated: boolean
  status: TerminalStatus
  exitCode: number | null
  error: string | null
  started: number
  ended: number | null
}

type TerminalState = {
  directory?: string
  entries: TerminalEntry[]
  // A close was asked for while a command was running: the view asks Wait / Stop and close.
  confirm: boolean
  // Close as soon as nothing is running. Set by Stop and close and by the close button.
  closing: boolean
}

export type TerminalRequest = (path: string, init?: RequestInit) => Promise<Response>

type RunRead = {
  status: "running" | "exited" | "cancelled" | "error"
  output: string
  next: number
  truncated: boolean
  exitCode: number | null
  error: string | null
}

export const POLL_MS = 300
// The client keeps at most this much of one command's output; the sidecar caps the same.
export const OUTPUT_LIMIT = 1024 * 1024
// A transcript goes into the chat and from there into the model's context, so each command
// contributes at most its last TRANSCRIPT_OUTPUT_LIMIT characters.
export const TRANSCRIPT_OUTPUT_LIMIT = 20_000
const MISSES_BEFORE_LOST = 5

const [state, setState] = createStore<Record<string, TerminalState>>({})
const requests = new Map<string, TerminalRequest>()
let sequence = 0

const blank = (): TerminalState => ({ entries: [], confirm: false, closing: false })
const ensure = (sessionID: string) => {
  if (!state[sessionID]) setState(sessionID, blank())
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const update = (sessionID: string, key: string, fn: (entry: TerminalEntry) => void) =>
  setState(
    sessionID,
    "entries",
    (entry) => entry.key === key,
    produce((entry) => fn(entry)),
  )

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g
export const stripAnsi = (text: string) => text.replace(ANSI, "")

const encode = (sessionID: string) => encodeURIComponent(sessionID)

async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  const body = await res.text().catch(() => "")
  let message = body
  try {
    const parsed = JSON.parse(body) as { message?: string; data?: { message?: string } }
    message = parsed.data?.message ?? parsed.message ?? body
  } catch {}
  throw new Error(message || `HTTP ${res.status}`)
}

async function follow(sessionID: string, key: string, runID: string, request: TerminalRequest) {
  let from = 0
  let misses = 0
  while (true) {
    let read: RunRead
    try {
      read = await readJson<RunRead>(
        await request(`/session/${encode(sessionID)}/terminal/${encodeURIComponent(runID)}?from=${from}`),
      )
      misses = 0
    } catch (err) {
      misses += 1
      if (misses < MISSES_BEFORE_LOST) {
        await sleep(POLL_MS)
        continue
      }
      update(sessionID, key, (entry) => {
        entry.status = "error"
        entry.error = `Lost track of this command: ${err instanceof Error ? err.message : String(err)}`
        entry.ended = Date.now()
      })
      return
    }
    from = read.next
    update(sessionID, key, (entry) => {
      if (read.output) {
        const next = entry.output + read.output
        entry.output = next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next
        if (next.length > OUTPUT_LIMIT) entry.truncated = true
      }
      if (read.truncated) entry.truncated = true
      entry.status = read.status
      entry.exitCode = read.exitCode
      entry.error = read.error
      if (read.status !== "running") entry.ended = Date.now()
    })
    if (read.status !== "running") return
    await sleep(POLL_MS)
  }
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

export function statusText(entry: Pick<TerminalEntry, "status" | "exitCode" | "error">) {
  if (entry.status === "starting" || entry.status === "running") return "still running when the terminal closed"
  if (entry.status === "cancelled") return "stopped"
  if (entry.status === "error") return `error: ${entry.error ?? "unknown"}`
  return `exit ${entry.exitCode ?? "?"}`
}

/**
 * The one message a closed terminal leaves in the session. Plain text laid out like a terminal
 * log, because the chat shows a user message as written (markdown fences would show as
 * backticks). Pure, so it is tested directly.
 */
export function transcript(entries: TerminalEntry[], directory?: string) {
  const count = `${entries.length} command${entries.length === 1 ? "" : "s"}`
  const lines = [`Terminal · ${count}${directory ? ` · ${directory}` : ""}`]
  for (const entry of entries) {
    let output = stripAnsi(entry.output).replace(/\s+$/, "")
    let omitted = entry.truncated
    if (output.length > TRANSCRIPT_OUTPUT_LIMIT) {
      output = output.slice(output.length - TRANSCRIPT_OUTPUT_LIMIT)
      omitted = true
    }
    lines.push("", `$ ${entry.command}`)
    if (omitted) lines.push("[earlier output omitted]")
    if (output) lines.push(output)
    const meta = [statusText(entry)]
    if (entry.ended !== null) meta.push(formatDuration(entry.ended - entry.started))
    lines.push(`[${meta.join(" · ")}]`)
  }
  return lines.join("\n")
}

export const TerminalMode = {
  entries: (sessionID: string | undefined) => (sessionID ? (state[sessionID]?.entries ?? []) : []),
  directory: (sessionID: string | undefined) => (sessionID ? state[sessionID]?.directory : undefined),
  confirming: (sessionID: string | undefined) => !!(sessionID && state[sessionID]?.confirm),
  closing: (sessionID: string | undefined) => !!(sessionID && state[sessionID]?.closing),
  running: (sessionID: string | undefined) =>
    TerminalMode.entries(sessionID).some((entry) => entry.status === "starting" || entry.status === "running"),

  /** Remember where this session's commands run and how to reach the sidecar. */
  attach(sessionID: string, directory: string, request: TerminalRequest) {
    ensure(sessionID)
    setState(sessionID, "directory", directory)
    requests.set(sessionID, request)
  },

  async run(sessionID: string, command: string) {
    const request = requests.get(sessionID)
    ensure(sessionID)
    const key = `t${++sequence}`
    setState(sessionID, "entries", (entries) => [
      ...entries,
      {
        key,
        command,
        output: "",
        truncated: false,
        status: "starting",
        exitCode: null,
        error: null,
        started: Date.now(),
        ended: null,
      },
    ])
    if (!request) {
      update(sessionID, key, (entry) => {
        entry.status = "error"
        entry.error = "Terminal is not connected"
        entry.ended = Date.now()
      })
      return
    }
    try {
      const started = await readJson<{ id: string }>(
        await request(`/session/${encode(sessionID)}/terminal`, {
          method: "POST",
          body: JSON.stringify({ command }),
        }),
      )
      update(sessionID, key, (entry) => {
        entry.runID = started.id
        if (entry.status === "starting") entry.status = "running"
      })
      await follow(sessionID, key, started.id, request)
    } catch (err) {
      update(sessionID, key, (entry) => {
        entry.status = "error"
        entry.error = err instanceof Error ? err.message : String(err)
        entry.ended = Date.now()
      })
    }
  },

  async cancel(sessionID: string, key?: string) {
    const request = requests.get(sessionID)
    if (!request) return
    const targets = TerminalMode.entries(sessionID).filter(
      (entry) => entry.runID && entry.status === "running" && (!key || entry.key === key),
    )
    await Promise.all(
      targets.map((entry) =>
        request(`/session/${encode(sessionID)}/terminal/${encodeURIComponent(entry.runID!)}/cancel`, {
          method: "POST",
        }).catch(() => undefined),
      ),
    )
  },

  /** Close asked for (close button, Esc, toggle). Returns true when it may close now. */
  requestClose(sessionID: string) {
    ensure(sessionID)
    if (TerminalMode.running(sessionID)) {
      setState(sessionID, "confirm", true)
      return false
    }
    setState(sessionID, "closing", true)
    return true
  },
  keepOpen(sessionID: string) {
    ensure(sessionID)
    setState(sessionID, { confirm: false, closing: false })
  },
  stopAndClose(sessionID: string) {
    ensure(sessionID)
    setState(sessionID, { confirm: false, closing: true })
    void TerminalMode.cancel(sessionID)
  },

  /**
   * Hand the transcript to `send` and start the next terminal fresh. Nothing is lost if `send`
   * fails: the entries stay, so the user can close again.
   */
  async close(sessionID: string, send: (text: string) => Promise<unknown>) {
    const current = state[sessionID]
    if (!current) return
    const entries = current.entries.map((entry) => ({ ...entry }))
    setState(sessionID, { confirm: false, closing: false })
    if (!entries.length) return
    const text = transcript(entries, current.directory)
    setState(sessionID, "entries", [])
    try {
      await send(text)
    } catch (err) {
      setState(sessionID, "entries", (now) => [...entries, ...now])
      throw err
    }
  },

  reset() {
    for (const key of Object.keys(state)) setState(key, undefined!)
    requests.clear()
  },
}
