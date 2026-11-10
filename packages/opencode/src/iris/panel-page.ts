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
 * READ-ONLY FOR NOW. Every script goes out as `mode: "read"` except the three that act, which go
 * as `act`; the app refuses `act` until acting ships (B2), so a tool bug cannot make it click.
 */
import { ScriptedPage } from "./browser-driver"
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

export class PanelPage extends ScriptedPage {
  private mode: "read" | "act" = "read"

  constructor(
    private readonly send: PanelSend,
    private readonly explainSilence: (o: Panel.Outcome) => string,
  ) {
    super()
  }

  async evaluate<T>(expression: string): Promise<T> {
    const o = await this.send({ action: "page", op: "eval", script: expression, mode: this.mode })
    return unpackPageAnswer(o, this.explainSilence) as T
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

  private async acting<T>(fn: () => Promise<T>): Promise<T> {
    this.mode = "act"
    try {
      return await fn()
    } finally {
      this.mode = "read"
    }
  }
  override clickRef(ref: number) {
    return this.acting(() => super.clickRef(ref))
  }
  override typeRef(ref: number, text: string) {
    return this.acting(() => super.typeRef(ref, text))
  }
  override selectRef(ref: number, value: string) {
    return this.acting(() => super.selectRef(ref, value))
  }

  async screenshot(): Promise<Uint8Array> {
    throw new Error("screenshots of the Browser pane aren't available yet: use read or find, or target agent")
  }

  /** The page is the person's: closing forgets it here and leaves it open in their pane. */
  async close(): Promise<void> {
    this.currentUrl = null
  }
}
