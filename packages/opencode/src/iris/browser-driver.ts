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
import { chmod, mkdir, mkdtemp, readFile, readlink, rm } from "fs/promises"
import { homedir, tmpdir } from "os"
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

/**
 * The agent's SAVED profile (#193187, B3): where logins the person made in the agent's Chrome are
 * kept between runs. Never the person's own Chrome profile: a directory of its own, owner-only.
 */
export function savedProfileDir(): string {
  return process.env["IRIS_BROWSER_PROFILE_DIR"] || path.join(homedir(), ".iris", "browser", "agent-profile")
}

/**
 * Is another Chrome already using this profile? Chrome leaves a `SingletonLock` symlink whose
 * target ends in "-<pid>". A second launch on a locked profile hands its window to the first
 * process and exits, which looks like a hang ("never reported a DevTools port"): refuse with a
 * sentence instead. A lock whose process is gone is stale and does not count.
 */
export async function profileInUse(dir: string): Promise<boolean> {
  const target = await readlink(path.join(dir, "SingletonLock")).catch(() => undefined)
  const pid = Number(target?.split("-").pop())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: any; error?: { message: string } }

/**
 * What every browser target can do to a page, written ONCE (#193145, epic #193144 B0).
 *
 * Every verb is a page script run through `evaluate`, so a target is only a way to run a script
 * and open an address: the CDP Chrome below (PageSession), or the IRIS Browser pane
 * (iris/panel-page.ts). The scripts, the refs stamped on elements, and the state the change check
 * compares are the same for both, so a verb cannot behave differently depending on where it runs.
 */
export abstract class ScriptedPage {
  currentUrl: string | null = null

  abstract evaluate<T>(expression: string): Promise<T>
  abstract open(url: string): Promise<{ url: string; title: string; status: string }>
  abstract screenshot(): Promise<Uint8Array>
  abstract close(): Promise<void>

  /** The text a person would read, not the markup. */
  async text(): Promise<string> {
    return (await this.evaluate<string>("document.body ? document.body.innerText : ''")) ?? ""
  }

  /**
   * The page as a numbered menu, rebuilt on every call (S3).
   *
   * Refs are assigned here and stamped onto the elements as a data attribute, so a later click
   * addresses the SAME node even if the page reflowed — and a ref from a previous page simply is
   * not found, rather than hitting whatever now sits in that position. Never coordinates: a
   * screenshot-and-click loop misses when a banner shifts the layout by ten pixels.
   */
  async elements(limit = 150): Promise<
    Array<{ ref: number; role: string; name: string; tag: string; value?: string; enabled: boolean; inViewport: boolean; options?: string[] }>
  > {
    const js = `(() => {
      const SEL = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [contenteditable=true]'
      const roleOf = (el) => {
        const r = el.getAttribute('role')
        if (r) return r
        const tag = el.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textarea'
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase()
          if (t === 'checkbox' || t === 'radio') return t
          if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
          if (t === 'search') return 'searchbox'
          return 'textbox'
        }
        return 'textbox'
      }
      const nameOf = (el) =>
        (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') ||
         (el.innerText || el.value || '').trim() || el.getAttribute('name') || '').replace(/\\s+/g, ' ').slice(0, 120)
      const out = []
      let ref = 0
      for (const el of document.querySelectorAll(SEL)) {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || (rect.width === 0 && rect.height === 0)) continue
        ref++
        if (ref > ${limit}) break
        el.setAttribute('data-iris-ref', String(ref))
        const options = el.tagName.toLowerCase() === 'select'
          ? Array.from(el.options).map((o) => o.value).slice(0, 60)
          : undefined
        out.push({
          options,
          ref,
          role: roleOf(el),
          name: nameOf(el),
          tag: el.tagName.toLowerCase(),
          value: el.value === undefined ? undefined : String(el.value),
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          inViewport: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
        })
      }
      return out
    })()`

    return (await this.evaluate<any[]>(js)) ?? []
  }

  /** Everything the change check compares, taken before and after an action. */
  async state(): Promise<{ url: string; title: string; textLength: number; textHash: string; values: Record<string, string> }> {
    const js = `(() => {
      const text = document.body ? document.body.innerText : ''
      let h = 0
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
      const values = {}
      for (const el of document.querySelectorAll('[data-iris-ref]')) {
        if (el.value !== undefined) values[el.getAttribute('data-iris-ref')] = String(el.value)
      }
      return { url: location.href, title: document.title, textLength: text.length, textHash: String(h), values }
    })()`

    return await this.evaluate(js)
  }

  /** Click the element holding this ref. Returns false when the ref is no longer on the page. */
  async clickRef(ref: number): Promise<boolean> {
    const ok = await this.evaluate<boolean>(
      `(() => { const el = document.querySelector('[data-iris-ref="${ref}"]'); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true })()`,
    )
    await Bun.sleep(400) // let a navigation or a re-render start before the state is read back
    this.currentUrl = await this.evaluate<string>("location.href")

    return !!ok
  }

  /** Type into the element holding this ref, firing the events a real keystroke would. */
  async typeRef(ref: number, text: string): Promise<boolean> {
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector('[data-iris-ref="${ref}"]')
        if (!el) return false
        el.focus()
        const v = ${JSON.stringify(text)}
        if (el.isContentEditable) { el.textContent = v }
        else {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
          setter ? setter.call(el, v) : (el.value = v)
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`,
    )
    await Bun.sleep(150)

    return !!ok
  }

  /** Set a dropdown to one of ITS values, firing the events a real choice would. */
  async selectRef(ref: number, value: string): Promise<boolean> {
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector('[data-iris-ref="${ref}"]')
        if (!el) return false
        el.value = ${JSON.stringify(value)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`,
    )
    await Bun.sleep(150)

    return !!ok
  }

  /** Move the viewport. Lazy pages load on scroll, so this is how the rest of a page appears. */
  async scroll(direction: "up" | "down" | "top" | "bottom"): Promise<void> {
    const js = {
      up: "scrollBy(0, -Math.round(innerHeight * 0.9))",
      down: "scrollBy(0, Math.round(innerHeight * 0.9))",
      top: "scrollTo(0, 0)",
      bottom: "scrollTo(0, document.body.scrollHeight)",
    }[direction]
    await this.evaluate(`(() => { ${js}; return true })()`)
    await Bun.sleep(250)
  }

}

/**
 * One Chrome, one tab, for the life of a tool session.
 *
 * Opened lazily by the tool on the first `open`, and closed by `close` — or by the session
 * ending. A browser left running after the agent stops is a process the user never started and
 * cannot see.
 */
export class PageSession extends ScriptedPage {
  private proc?: ChildProcess
  private port?: number
  private ws?: WebSocket
  private profileDir?: string
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  constructor(
    private readonly opts: {
      headless?: boolean
      timeoutMs?: number
      /** A profile kept between runs (B3). Absent: a throwaway profile, deleted on close. */
      profileDir?: string
    } = {},
  ) {
    super()
  }

  /** Whether this session keeps its profile (logins persist) and shows a window. */
  get kind(): { saved: boolean; visible: boolean } {
    return { saved: !!this.opts.profileDir, visible: this.opts.headless === false }
  }

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
    if (this.opts.profileDir) {
      const dir = this.opts.profileDir
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700).catch(() => {})
      if (await profileInUse(dir)) {
        throw new BrowserUnavailable(
          "the agent's saved browser profile is already open in another session: close that one first (action=close), or use profile fresh",
        )
      }
      // The port file from the LAST run would be read before Chrome writes this run's.
      await rm(path.join(dir, "DevToolsActivePort"), { force: true }).catch(() => {})
      this.profileDir = dir
    } else {
      this.profileDir = await mkdtemp(path.join(tmpdir(), "iris-browser-"))
    }
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--window-size=1280,900",
      // macOS: never touch the person's Keychain. Without this, the first persistent cookie makes
      // Chrome ask for "Chrome Safe Storage", a system prompt that blocks the browser until someone
      // answers it (measured #193187: every navigate timed out). The cost: the agent profile's
      // cookies are encrypted with Chrome's fixed mock key, so the profile folder's 0700 is what
      // protects a saved sign-in. It is the agent's profile, never the person's own Chrome.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ...(this.opts.headless === false ? [] : ["--headless=new"]),
      "about:blank",
    ]
    this.proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] })
    const port = await this.readDevToolsPort()
    this.port = port
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

  /** Ask Chrome to quit in order (flushes cookies), over its BROWSER endpoint. */
  private async browserClose(port: number): Promise<void> {
    const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }
    if (!v.webSocketDebuggerUrl) return
    const ws = new WebSocket(v.webSocketDebuggerUrl)
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      const t = setTimeout(done, 3000)
      ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })))
      ws.addEventListener("message", () => (clearTimeout(t), done()))
      ws.addEventListener("close", () => (clearTimeout(t), done()))
      ws.addEventListener("error", () => (clearTimeout(t), done()))
    })
    try {
      ws.close()
    } catch {}
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
    const proc = this.proc
    this.proc = undefined
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
      // A SAVED profile must be shut down CLEANLY: Chrome writes cookies to disk lazily and SIGTERM
      // ends it before it does (measured #193187: close took 70 ms and the sign-in was gone on the
      // next launch). Browser.close is Chrome's own orderly quit; SIGTERM is only the fallback.
      if (this.opts.profileDir && this.port) {
        await this.browserClose(this.port).catch(() => {})
        await Promise.race([exited, Bun.sleep(8000)])
      }
      if (proc.exitCode === null) {
        proc.kill()
        if (this.opts.profileDir) await Promise.race([exited, Bun.sleep(5000)])
      }
    }
    this.port = undefined
    this.currentUrl = null
    // A throwaway profile is deleted; a saved one is the point of saving it (B3).
    if (this.profileDir && !this.opts.profileDir) {
      await rm(this.profileDir, { recursive: true, force: true }).catch(() => {})
    }
    this.profileDir = undefined
  }
}
