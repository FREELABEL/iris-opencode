/**
 * The page, driven over CDP. (#186665, slice 1)
 *
 * Desktop is Tauri: there is no BrowserView to drive and no engine to borrow, so this uses the
 * Chrome ALREADY INSTALLED on the machine (ADR-02) and speaks the DevTools protocol to it. We do
 * not bundle a browser: a second browser stack inside a desktop app is a download nobody asked
 * for, and "Chrome not found" is a sentence a person can act on.
 *
 * A FRESH PROFILE, NOT THE USER'S SESSION. ADR-02 says "the user's Chrome"; this drives their
 * Chrome BINARY in a throwaway profile directory. Attaching to their running browser would put an
 * agent inside a window holding their logged-in banking, mail and admin sessions, where one
 * untrusted page could act as them. The cost is honest — a logged-out browser cannot read a page
 * behind a login — and that trade belongs to the user, not to this file (epic open question 2).
 *
 * NO GUARDS HERE ON PURPOSE. refuseUrlReason / refuseNavigationReason live at the TOOL boundary
 * (browser-verbs.ts), so this module can be pointed at 127.0.0.1 by its own test while the agent
 * can never be. One place decides what may be opened; if that place moves, the tests that prove
 * the refusals move with it.
 */
import { spawn, type ChildProcess } from "child_process"
import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

/** Where Chrome lives, in the order a machine is likely to have it. */
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
]

export async function findChrome(): Promise<string | null> {
  if (process.env["IRIS_BROWSER_CHROME"]) return process.env["IRIS_BROWSER_CHROME"]!
  for (const p of CHROMES) {
    if (await Bun.file(p).exists()) return p
  }

  return null
}

export class BrowserUnavailable extends Error {}

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: any; error?: { message: string } }

/**
 * One Chrome, one tab, for the life of a tool session.
 *
 * Opened lazily by the tool on the first `open`, and closed by `close` — or by the session
 * ending. A browser left running after the agent stops is a process the user never started and
 * cannot see.
 */
export class PageSession {
  private proc?: ChildProcess
  private ws?: WebSocket
  private profileDir?: string
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  currentUrl: string | null = null

  constructor(private readonly opts: { headless?: boolean; timeoutMs?: number } = {}) {}

  private get timeout() {
    return this.opts.timeoutMs ?? 30_000
  }

  async start(): Promise<void> {
    if (this.ws) return
    const chrome = await findChrome()
    if (!chrome) {
      throw new BrowserUnavailable(
        "no Chrome found on this machine — install Google Chrome, or set IRIS_BROWSER_CHROME to a Chromium binary",
      )
    }
    this.profileDir = await mkdtemp(path.join(tmpdir(), "iris-browser-"))
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--window-size=1280,900",
      ...(this.opts.headless === false ? [] : ["--headless=new"]),
      "about:blank",
    ]
    this.proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] })
    const port = await this.readDevToolsPort()
    // The BROWSER endpoint answers Target.* and nothing else — Runtime.evaluate and
    // Page.captureScreenshot live on a PAGE target, and asking the wrong one returns
    // "'Runtime.evaluate' wasn't found", which reads like a protocol version problem.
    const wsUrl = await this.pageEndpoint(port)
    this.ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new BrowserUnavailable("Chrome did not accept a DevTools connection")), this.timeout)
      this.ws!.addEventListener("open", () => {
        clearTimeout(t)
        resolve()
      })
      this.ws!.addEventListener("error", () => {
        clearTimeout(t)
        reject(new BrowserUnavailable("Chrome refused the DevTools connection"))
      })
    })
    this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)))
    await this.send("Page.enable")
  }

  /** Chrome writes the port it chose into the profile; poll for it rather than parse stderr. */
  private async readDevToolsPort(): Promise<number> {
    const file = path.join(this.profileDir!, "DevToolsActivePort")
    const deadline = Date.now() + this.timeout
    while (Date.now() < deadline) {
      try {
        const [port] = (await readFile(file, "utf8")).split("\n")
        if (port?.trim()) return Number(port.trim())
      } catch {
        // not written yet
      }
      await Bun.sleep(50)
    }
    throw new BrowserUnavailable("Chrome started but never reported a DevTools port")
  }

  /** The about:blank tab Chrome opened with — or a new one, if the list is somehow empty. */
  private async pageEndpoint(port: number): Promise<string> {
    const deadline = Date.now() + this.timeout
    while (Date.now() < deadline) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
          type: string
          webSocketDebuggerUrl?: string
        }>
        const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
        const made = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as {
          webSocketDebuggerUrl?: string
        }
        if (made?.webSocketDebuggerUrl) return made.webSocketDebuggerUrl
      } catch {
        // DevTools http endpoint not up yet
      }
      await Bun.sleep(50)
    }
    throw new BrowserUnavailable("Chrome opened no page to drive")
  }

  private onMessage(raw: string) {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id !== "number") return
    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws) throw new BrowserUnavailable("the browser is not open")
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${this.timeout}ms`))
      }, this.timeout)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        },
      })
      this.ws!.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Navigate and wait for the load event — a page read before load is a page half-read. */
  async open(url: string): Promise<{ url: string; title: string; status: string }> {
    await this.start()
    const loaded = new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        try {
          const m = JSON.parse(String(e.data)) as CdpMessage
          if (m.method === "Page.loadEventFired") {
            this.ws!.removeEventListener("message", onMsg as EventListener)
            resolve()
          }
        } catch {
          // ignore
        }
      }
      this.ws!.addEventListener("message", onMsg as EventListener)
      setTimeout(resolve, this.timeout) // a page that never fires load is still a page
    })
    const res = await this.send("Page.navigate", { url })
    if (res?.errorText) throw new Error(`could not open ${url}: ${res.errorText}`)
    await loaded
    this.currentUrl = await this.evaluate<string>("location.href")
    const title = await this.evaluate<string>("document.title")

    return { url: this.currentUrl ?? url, title: title ?? "", status: "ok" }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluation failed")

    return r?.result?.value as T
  }

  /** The text a person would read, not the markup. */
  async text(): Promise<string> {
    return (await this.evaluate<string>("document.body ? document.body.innerText : ''")) ?? ""
  }

  async screenshot(): Promise<Uint8Array> {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })

    return Buffer.from(String(r?.data ?? ""), "base64")
  }

  async close(): Promise<void> {
    try {
      this.ws?.close()
    } catch {
      // closing a closed socket is not an error worth surfacing
    }
    this.ws = undefined
    this.proc?.kill()
    this.proc = undefined
    this.currentUrl = null
    if (this.profileDir) {
      await rm(this.profileDir, { recursive: true, force: true }).catch(() => {})
      this.profileDir = undefined
    }
  }
}
