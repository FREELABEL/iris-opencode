/**
 * The IRIS Browser pane as a browser target (#193145, epic #193144 B1).
 *
 * The pane is a native webview in the desktop app; the agent runs here, in the engine. The two
 * already talk: the side panel's command channel (iris/panel.ts, #190093), re-sent until
 * answered, idempotent by id. A page verb rides it: the engine sends `{action:"page"}` with one of
 * ScriptedPage's scripts, the app checks the person has granted that site, Rust runs the script
 * in the pane and awaits its value, and the app's ack carries that value back.
 *
 * WHAT THIS FILE DOES NOT DECIDE. Whether the agent may use a site is the person's grant, checked
 * in the app (browser-grants.ts). Whether a verb may run at all is browser-verbs.ts, at the tool
 * boundary, the same for every target. This file only moves scripts and answers.
 *
 * READ AND ACT (#193186). Every script goes out as `mode: "read"` except the three that act,
 * which go as `act`: the app checks the person allowed CLICKING on that site, separately from
 * reading, and refuses while they have taken over. An irreversible click carries its label as
 * `confirm`, and the app asks the person to allow it once; that wait is why such a call gets a
 * long timeout. IRIS's cursor glides to the element first (agent-cursor.ts), so the person sees where.
 */
import { ScriptedPage } from "./browser-driver"
import { withCursor } from "./agent-cursor"
import type { Panel } from "./panel"

export type PanelSend = (command: Panel.Command, timeoutMs?: number) => Promise<Panel.Outcome>

/** Turn the desktop's answer into a value, or a sentence the agent can act on. */
export function unpackPageAnswer(o: Panel.Outcome, explainSilence: (o: Panel.Outcome) => string): unknown {
  if (!o.state) throw new Error(explainSilence(o))
  if (o.state.error) throw new Error(o.state.error)
  if (o.state.result === undefined) {
    throw new Error("the desktop answered without a result: this IRIS Desktop has no Browser pane yet (update it)")
  }
  let env: { ok?: boolean; value?: unknown; error?: string }
  try {
    env = JSON.parse(o.state.result)
  } catch {
    throw new Error("the page's answer could not be read")
  }
  if (!env || env.ok !== true) throw new Error(`the page script failed: ${env?.error ?? "no reason given"}`)
  return env.value
}

/** How long the person has to answer an Allow once prompt, plus the round trip. */
export const CONFIRM_TIMEOUT_MS = 75_000
/** One page script round trip: the desktop gives a script 10 s, plus the trip both ways. */
export const PAGE_TIMEOUT_MS = 16_000
/** The app's refusal while its Allow is on screen (browser-grants pageRefusal). */
export const WAITING_FOR_ALLOW = /click Allow in the Browser bar/

export class PanelPage extends ScriptedPage {
  private mode: "read" | "act" = "read"
  private doing?: string
  /** Set by the tool just before an irreversible click: the label the person will be asked about. */
  confirmNext?: string
  /** How long a page operation waits for the person's Allow (like a question: the agent is paused
   * on them, it never goes ahead without it), and how often it looks. */
  allowWaitMs = 5 * 60_000
  allowPollMs = 1_500

  constructor(
    private readonly send: PanelSend,
    private readonly explainSilence: (o: Panel.Outcome) => string,
  ) {
    super()
  }

  async evaluate<T>(expression: string): Promise<T> {
    // The confirm rides only the FIRST act script (the click itself), never the reads after it.
    const confirm = this.mode === "act" ? this.confirmNext : undefined
    if (confirm) this.confirmNext = undefined
    const command: Panel.Command = {
      action: "page",
      op: "eval",
      script: expression,
      mode: this.mode,
      ...(confirm ? { confirm } : {}),
      ...(this.mode === "act" && this.doing ? { doing: this.doing } : {}),
    }
    // Not allowed yet: the app is showing Allow in the Browser bar right now. Wait for the
    // person's one click instead of making them click, then tell the agent to try again (#193200).
    // Each try is a quick round trip; the same command (confirm included) is re-sent.
    // Longer than the desktop's own 10 s page timeout, so its "the page took too long" answer
    // arrives instead of a bare "the desktop did not answer" (Vonlane, 2026-11-11).
    return (await this.sendWaiting(command, confirm ? CONFIRM_TIMEOUT_MS : PAGE_TIMEOUT_MS)) as T
  }

  /** Send, and while the app says "click Allow", wait for that click and send again. */
  private async sendWaiting(command: Panel.Command, timeoutMs?: number): Promise<unknown> {
    const until = Date.now() + this.allowWaitMs
    for (;;) {
      const o = await this.send(command, timeoutMs)
      try {
        return unpackPageAnswer(o, this.explainSilence)
      } catch (err) {
        if (!(err instanceof Error) || !WAITING_FOR_ALLOW.test(err.message) || Date.now() >= until) throw err
        await Bun.sleep(this.allowPollMs)
      }
    }
  }

  /** The page the person has open in the pane: what a first read of the pane reads. */
  async attach(): Promise<string> {
    this.currentUrl = await this.evaluate<string>("location.href")
    return this.currentUrl ?? ""
  }

  /** Navigate the pane. The person sees it happen; the app waits for the page to load. */
  async open(url: string): Promise<{ url: string; title: string; status: string }> {
    const o = await this.send({ action: "page", op: "open", url }, 25_000)
    const v = (unpackPageAnswer(o, this.explainSilence) ?? {}) as { url?: string; title?: string }
    this.currentUrl = v.url ?? url
    return { url: this.currentUrl, title: v.title ?? "", status: "ok" }
  }

  private async acting<T>(ref: number, doing: string, fn: () => Promise<T>): Promise<T> {
    // The cursor glides there first (reads: it only draws), so the person sees where IRIS works.
    // The strip already says "IRIS is working" while it moves.
    this.mode = "read"
    try {
      return await withCursor(
        (e) => this.evaluate(e),
        ref,
        async () => {
          this.mode = "act"
          this.doing = doing
          return fn()
        },
      )
    } finally {
      this.mode = "read"
      this.doing = undefined
      this.confirmNext = undefined
    }
  }
  override clickRef(ref: number) {
    return this.acting(ref, this.confirmNext ? `clicking "${this.confirmNext}"` : `clicking [${ref}]`, () => super.clickRef(ref))
  }
  override typeRef(ref: number, text: string) {
    return this.acting(ref, `typing into [${ref}]`, () => super.typeRef(ref, text))
  }
  override selectRef(ref: number, value: string) {
    return this.acting(ref, `choosing "${value.slice(0, 30)}"`, () => super.selectRef(ref, value))
  }

  /** A JPEG of what the person sees in the pane (macOS for now). Same Allow as reading. */
  async screenshot(): Promise<Uint8Array> {
    const b64 = await this.sendWaiting({ action: "page", op: "screenshot" }, 20_000)
    if (typeof b64 !== "string" || !b64) throw new Error("the Browser sent no picture")
    return new Uint8Array(Buffer.from(b64, "base64"))
  }

  /** The page is the person's: closing forgets it here and leaves it open in their pane. */
  async close(): Promise<void> {
    this.currentUrl = null
  }
}
