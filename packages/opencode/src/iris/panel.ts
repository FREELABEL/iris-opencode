import { GlobalBus } from "@/bus/global"

/**
 * THE SIDE PANEL, FROM THE AGENT'S SIDE (#190093).
 *
 * The desktop's side panel — which tab is open, which IRIS product and sub-view, which board,
 * which artifact — lived only in the webview. The agent could put things IN the panel (an
 * artifact, a browser page) but could not see what the user was looking at, switch it, or open
 * the thing it had just made; the only way in was the DOM, and the WKWebView has no debug port.
 *
 * Two directions, one module:
 *
 *   desktop → engine  The webview REPORTS its panel state (POST /iris/panel/state) whenever it
 *                     changes. Kept here in memory, per session. It is a report, not a source of
 *                     truth: nothing here is persisted, and a stale entry says how old it is.
 *
 *   engine → desktop  A COMMAND is an `iris.panel.command` event on the GlobalBus, which the
 *                     desktop receives over /global/event — the same road `iris.artifact.updated`
 *                     takes. The desktop applies it and reports its state back with `ack` set to
 *                     the command's id, so the caller learns what ACTUALLY happened, or that no
 *                     panel answered (CLI, desktop closed, another session on screen).
 *
 * WHY NOT DRIVE THE DOM. Tab ids and classes are presentation; they change with every redesign
 * and say nothing about which board or artifact is showing. The webview already has one way to
 * steer the panel (iris-nav.ts, used by the chat cards) — commands go through that, so an agent
 * opening an artifact takes exactly the path a click on its card takes.
 */
export namespace Panel {
  export const COMMAND_EVENT = "iris.panel.command"

  /** What the desktop says is on screen. Every field is optional: an older desktop sends less. */
  export type State = {
    session: string
    /** Whether the side panel is open at all. */
    open: boolean
    /** The panel's active tab: "iris", "review", "context", "web", "empty" or a file tab. */
    tab?: string
    /** Every tab in the strip, in order. */
    tabs?: string[]
    /** IRIS product (surface id) and sub-view on screen — meaningful when tab is "iris". */
    surface?: string
    sub?: string
    bloq?: { id: number; name?: string }
    /** Genesis › Artifacts: the artifact selected in the pane. */
    artifact?: string
    /** The Browser tab's address. */
    url?: string
    /** What the desktop can show: product id → its sub-view ids. Lets callers validate. */
    catalog?: { id: string; label: string; subs: { id: string; label: string }[] }[]
    /** The command this report answers, if any. */
    ack?: string
    /** Set by the desktop when a command could not be applied as asked. */
    error?: string
  }

  export type Stored = State & { received: number }

  export type Command =
    | { action: "open" }
    | { action: "close" }
    /** Show an IRIS product, optionally a sub-view and a board. */
    | { action: "show"; surface: string; sub?: string; bloq?: number }
    /** Genesis › Artifacts with this artifact selected. */
    | { action: "artifact"; id: string }
    /** A non-IRIS tab: review (files & changes), context. */
    | { action: "tab"; tab: string }
    /** The Browser tab, on this address. */
    | { action: "browse"; url: string }

  const states = new Map<string, Stored>()
  const waiters = new Map<string, (s: Stored) => void>()
  /** Bounded: one entry per session that ever opened a desktop panel against this engine. */
  const MAX_SESSIONS = 200

  const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/

  export function validSession(id: unknown): id is string {
    return typeof id === "string" && SESSION_RE.test(id)
  }

  export function report(state: State): Stored {
    const stored: Stored = { ...state, received: Date.now() }
    states.delete(state.session)
    states.set(state.session, stored)
    while (states.size > MAX_SESSIONS) states.delete(states.keys().next().value!)
    if (state.ack) {
      const w = waiters.get(state.ack)
      if (w) {
        waiters.delete(state.ack)
        w(stored)
      }
    }
    return stored
  }

  /** The last report for a session, or the most recent report from any session. */
  export function get(session?: string): Stored | undefined {
    if (session) return states.get(session)
    // report() re-inserts, so the Map's last entry is the newest — timestamps tie within a millisecond.
    let last: Stored | undefined
    for (const s of states.values()) last = s
    return last
  }

  /** Clear everything — tests only. */
  export function reset() {
    states.clear()
    waiters.clear()
  }

  /**
   * Refuse what the desktop could not show, BEFORE sending it, when the desktop has told us what
   * it can show. Without a catalog (no report yet, an older desktop) the command goes through
   * and the desktop's own answer is the check.
   */
  export function refuse(cmd: Command, catalog: State["catalog"]): string | undefined {
    if (cmd.action === "browse") {
      let u: URL
      try {
        u = new URL(cmd.url)
      } catch {
        return `not a URL: ${cmd.url}`
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return `only http(s) addresses open in the panel, not ${u.protocol}`
    }
    if (cmd.action === "tab" && !["review", "context"].includes(cmd.tab)) {
      return `tab must be review or context — use show for IRIS products, browse for the Browser tab, artifact for an artifact`
    }
    if (cmd.action === "show" && catalog?.length) {
      const s = catalog.find((x) => x.id === cmd.surface || x.label.toLowerCase() === cmd.surface.toLowerCase())
      if (!s) return `no product "${cmd.surface}" — one of: ${catalog.map((x) => `${x.id} (${x.label})`).join(", ")}`
      if (cmd.sub && s.subs.length && !s.subs.some((v) => v.id === cmd.sub || v.label.toLowerCase() === cmd.sub!.toLowerCase())) {
        return `${s.label} has no "${cmd.sub}" view — one of: ${s.subs.map((v) => v.id).join(", ")}`
      }
    }
    return undefined
  }

  /** Map a label ("Genesis", "Lists") to the id the desktop uses, when the catalog knows it. */
  export function canonical(cmd: Command, catalog: State["catalog"]): Command {
    if (cmd.action !== "show" || !catalog?.length) return cmd
    const s = catalog.find((x) => x.id === cmd.surface || x.label.toLowerCase() === cmd.surface.toLowerCase())
    if (!s) return cmd
    const sub = cmd.sub ? s.subs.find((v) => v.id === cmd.sub || v.label.toLowerCase() === cmd.sub!.toLowerCase())?.id ?? cmd.sub : undefined
    return { ...cmd, surface: s.id, sub }
  }

  /**
   * Send a command and wait for the desktop to answer it. Resolves with the desktop's report, or
   * undefined when nothing answered within `timeoutMs` — which is a fact worth telling the agent,
   * not an error: the user may simply be in the CLI.
   */
  export function send(input: { directory?: string; session: string; command: Command; timeoutMs?: number }): Promise<Stored | undefined> {
    const id = `pc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        resolve(undefined)
      }, input.timeoutMs ?? 4000)
      waiters.set(id, (s) => {
        clearTimeout(timer)
        resolve(s)
      })
      GlobalBus.emit("event", {
        directory: input.directory,
        payload: { type: COMMAND_EVENT, properties: { id, session: input.session, command: input.command } },
      })
    })
  }

  /** One line per fact, for an agent to read. */
  export function describe(s: Stored | undefined, now = Date.now()): string {
    if (!s) return "No desktop panel has reported for this session — the user may be in the CLI, or the desktop is not showing this session."
    const age = Math.max(0, Math.round((now - s.received) / 1000))
    const lines = [`panel: ${s.open ? "open" : "closed"}  (reported ${age}s ago)`]
    if (s.tab) lines.push(`active tab: ${s.tab}`)
    if (s.tabs?.length) lines.push(`tabs: ${s.tabs.join(", ")}`)
    if (s.tab === "iris" || s.surface) {
      const label = s.catalog?.find((x) => x.id === s.surface)
      const sub = label?.subs.find((v) => v.id === s.sub)
      lines.push(`product: ${label?.label ?? s.surface ?? "?"}${s.sub ? ` › ${sub?.label ?? s.sub}` : ""}  (${s.surface ?? "?"}${s.sub ? `/${s.sub}` : ""})`)
    }
    if (s.bloq) lines.push(`board: ${s.bloq.name ? `${s.bloq.name} ` : ""}#${s.bloq.id}`)
    if (s.artifact) lines.push(`artifact selected: ${s.artifact}`)
    if (s.url) lines.push(`browser: ${s.url}`)
    if (s.error) lines.push(`desktop said: ${s.error}`)
    return lines.join("\n")
  }

  export function describeCatalog(catalog: State["catalog"]): string {
    if (!catalog?.length) return ""
    return catalog.map((x) => `${x.id} (${x.label})${x.subs.length ? `: ${x.subs.map((v) => v.id).join(", ")}` : ""}`).join("\n")
  }
}
