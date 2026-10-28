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
    /** Atlas: the card open in the card editor, and the board it is on (#191507). */
    card?: { id: number; bloq?: number }
    /** What the desktop can show: product id → its sub-view ids. Lets callers validate. */
    catalog?: { id: string; label: string; hint?: string; subs: { id: string; label: string; hint?: string }[] }[]
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
    /** Atlas on this board with this card open — the app's ?project=<bloq>&row=<list>&card=<item> (#191507). */
    | { action: "card"; bloq: number; item: number; list?: number }
    /** Change nothing; answer with what is on screen now. A live `state` (#191506). */
    | { action: "report" }

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

  /**
   * How many clients hold the engine's /global/event stream open — the only road a command takes
   * to a desktop. Zero is the one case where "no desktop can see this" is a FACT rather than a
   * guess (#191506). Not every stream is a desktop (a CLI live attach holds one too), so a
   * non-zero count proves only that the road is open.
   */
  let streams = 0
  export function streamOpened() {
    streams++
  }
  export function streamClosed() {
    streams = Math.max(0, streams - 1)
  }
  export function openStreams() {
    return streams
  }

  /** Clear everything — tests only. */
  export function reset() {
    states.clear()
    waiters.clear()
    streams = 0
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
    if (cmd.action === "card") {
      const id = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0
      if (!id(cmd.bloq)) return `card needs bloq: the board id (the ?project= in an Atlas link)`
      if (!id(cmd.item)) return `card needs item: the card id (the ?card= in an Atlas link)`
      if (cmd.list !== undefined && !id(cmd.list)) return `card list must be a list id (the ?row= in an Atlas link)`
    }
    if (cmd.action === "show" && catalog?.length) {
      const s = catalog.find((x) => x.id === cmd.surface || x.label.toLowerCase() === cmd.surface.toLowerCase())
      if (!s) return `no product "${cmd.surface}" — one of: ${catalog.map((x) => `${x.id} (${x.label})`).join(", ")}`
      if (cmd.sub && s.subs.length && !s.subs.some((v) => v.id === cmd.sub || v.label.toLowerCase() === cmd.sub!.toLowerCase())) {
        const card = /^\d+$/.test(cmd.sub) ? ` — "${cmd.sub}" looks like a card id: use action "card" with bloq and item to open a card` : ""
        return `${s.label} has no "${cmd.sub}" view — one of: ${s.subs.map((v) => v.id).join(", ")}${card}`
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

  /** What came of a command: the desktop's answer, or the facts about why there was none. */
  export type Outcome = {
    /** The desktop's report answering this command; undefined when none arrived in time. */
    state?: Stored
    elapsedMs: number
    /** How many times the command was put on the event stream (it is re-sent while unanswered). */
    attempts: number
    /** /global/event streams open when the wait ended. */
    streams: number
    /** The newest report for this session that arrived DURING the wait, without the ack. */
    heard?: Stored
  }

  /**
   * Send a command and wait for the desktop to answer it (#191506).
   *
   * RE-SENT WHILE UNANSWERED, under the same id. The desktop applies an id once and, asked again,
   * re-posts its answer — so a re-send recovers both a command the desktop never got and an
   * answer the engine never got, and never applies anything twice. One 6 s shot used to turn any
   * single lost message, either way, into "the user is not looking", while they were.
   */
  export function send(input: {
    directory?: string
    session: string
    command: Command
    timeoutMs?: number
    resendMs?: number
  }): Promise<Outcome> {
    const id = `pc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const started = Date.now()
    const timeoutMs = input.timeoutMs ?? timing.sendMs
    const resendMs = input.resendMs ?? timing.resendMs
    let attempts = 0
    const emit = () => {
      attempts++
      GlobalBus.emit("event", {
        directory: input.directory,
        payload: { type: COMMAND_EVENT, properties: { id, session: input.session, command: input.command } },
      })
    }
    return new Promise((resolve) => {
      const outcome = (state?: Stored): Outcome => {
        const last = states.get(input.session)
        return {
          state,
          elapsedMs: Date.now() - started,
          attempts,
          streams,
          heard: !state && last && last.received >= started ? last : undefined,
        }
      }
      const resend = setInterval(emit, resendMs)
      const timer = setTimeout(() => {
        clearInterval(resend)
        waiters.delete(id)
        resolve(outcome())
      }, timeoutMs)
      waiters.set(id, (s) => {
        clearTimeout(timer)
        clearInterval(resend)
        resolve(outcome(s))
      })
      emit()
    })
  }
  /**
   * The budget for one command: re-sent every 3 s, given up after 12 s. The desktop's own settle
   * waits up to 5 s for the panel to land, so the old single 6 s wait left one second for both
   * messages to cross. A live read (state) gets 3 s. Mutable for tests only.
   */
  export const timing = { sendMs: 12_000, resendMs: 3_000, liveReadMs: 3_000, liveResendMs: 1_000 }

  /**
   * Why no answer came, from what the engine KNOWS — never a guess about where the user is
   * looking (#191506). The old text ("the user is not looking at this session") was printed for
   * every timeout, including a lost message on a panel the person was staring at; agents believed
   * it and switched to dictating click-by-click directions.
   */
  export function explainSilence(o: Outcome, session: string, now = Date.now()): string {
    const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`
    const waited = `${secs(o.elapsedMs)} (sent ${o.attempts} time${o.attempts === 1 ? "" : "s"})`
    if (o.streams === 0) {
      return `No IRIS Desktop is connected to this engine (no event stream is open), so no panel could receive the command. Nothing changed. The user may be in the terminal; give directions in words.`
    }
    if (o.heard) {
      return `The desktop is connected and reported this session's panel ${secs(now - o.heard.received)} ago, but did not confirm this command within ${waited}. It may have applied it anyway. Call side_panel state to see what is on screen now; do not assume the user is away.`
    }
    const last = states.get(session)
    const newest = get()
    const elsewhere =
      newest && newest.session !== session
        ? ` The newest panel report (${secs(now - newest.received)} ago) is from another session, ${newest.session} — the desktop may be showing that one.`
        : ""
    const lastSeen = last ? `this session's panel last reported ${secs(now - last.received)} ago` : "this session's panel has never reported to this engine"
    return `The desktop did not answer within ${waited}; ${o.streams} event stream${o.streams === 1 ? " is" : "s are"} connected and ${lastSeen}.${elsewhere} It may or may not have applied the command. This is a failed round trip, not evidence the user is away: try once more, or call side_panel state.`
  }

  /** The web app's own address for a card — what the desktop's card action mirrors. */
  export function cardLink(c: { bloq: number; item: number; list?: number }) {
    const q = new URLSearchParams({ project: String(c.bloq) })
    if (c.list) q.set("row", String(c.list))
    q.set("card", String(c.item))
    return `https://heyiris.io/atlas?${q}`
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
    if (s.card) lines.push(`card open: #${s.card.id}${s.card.bloq ? ` on board #${s.card.bloq}` : ""}`)
    if (s.error) lines.push(`desktop said: ${s.error}`)
    return lines.join("\n")
  }

  /** One line per product, then one per view, each with what it is for — the agent's map of the app. */
  export function describeCatalog(catalog: State["catalog"]): string {
    if (!catalog?.length) return ""
    return catalog
      .map((x) =>
        [
          `${x.id} (${x.label})${x.hint ? ` — ${x.hint}` : ""}`,
          ...x.subs.map((v) => `  ${x.id}/${v.id} (${v.label})${v.hint ? ` — ${v.hint}` : ""}`),
        ].join("\n"),
      )
      .join("\n")
  }
}
