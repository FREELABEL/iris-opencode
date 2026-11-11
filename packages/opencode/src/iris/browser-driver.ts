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
import { withCursor } from "./agent-cursor"
import type { PageElement } from "./browser-verbs"
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

/** What inspect found. Every link says where it came from. */
export type InspectedElement = {
  tag: string
  attributes: Record<string, string>
  ids: Record<string, string>
  links: { url: string; source: "anchor" | "ancestor-anchor" | "card-anchor"; where: string }[]
  ancestors: { tag: string; role?: string; id?: string; ids?: Record<string, string> }[]
  canonical?: string
  page: string
}

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
  async elements(limit = 150): Promise<PageElement[]> {
    const js = `(() => {
      const SEL = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [contenteditable=true]'
      const roleOf = (el) => {
        const r = el.getAttribute('role')
        if (r) return r === 'menuitemradio' ? 'radio' : r === 'menuitemcheckbox' ? 'checkbox' : r
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
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const nameOf = (el, label) =>
        clean(el.getAttribute('aria-label') || (label && label.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') ||
         (el.innerText || (el.type === 'radio' || el.type === 'checkbox' ? '' : el.value) || '').trim() || el.getAttribute('name') || '').slice(0, 120)
      const shown = (el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return !(style.display === 'none' || style.visibility === 'hidden' || (rect.width === 0 && rect.height === 0))
      }
      // A choice drawn by the site: the real radio/checkbox is hidden (0 size, opacity 0, off
      // screen) and its LABEL is what a person clicks (Toast, 2026-11-11: the protein choices).
      const labelOf = (el) => (el.labels && el.labels[0]) || el.closest('label')
      const tiny = (el) => { const r = el.getBoundingClientRect(); return r.width < 2 || r.height < 2 || Number(getComputedStyle(el).opacity) === 0 }
      // An open pop-up is the page right now: what is behind it is inert. List only the pop-up,
      // so a long page behind it (a whole menu) can't push its choices past the limit.
      const modals = Array.from(document.querySelectorAll('[aria-modal=true], dialog[open], [role=dialog], [role=alertdialog]')).filter(shown)
      const root = modals.length ? modals[modals.length - 1] : document
      // What the element IS, not only what it says: its link and the site's ids for the record.
      const ID_ATTR = /^data-(.*[-_])?(id|jk|sku|key|slug|uuid|item|listing|product|job)([-_]?id)?$/i
      const idsOf = (el) => {
        const ids = {}
        let n = 0
        for (let x = el; x && x !== document.body && n < 4; x = x.parentElement) {
          for (const a of Array.from(x.attributes || [])) {
            if (n < 4 && ID_ATTR.test(a.name) && a.value && a.value.length <= 80 && !(a.name in ids)) { ids[a.name] = a.value; n++ }
          }
        }
        return n ? ids : undefined
      }
      const hrefOf = (el) => {
        const a = el.closest('a[href]')
        if (!a) return undefined
        const h = a.href
        return /^https?:/.test(h) ? h : undefined
      }
      const out = []
      let ref = 0
      for (const el of root.querySelectorAll(SEL)) {
        const isChoice = el.tagName.toLowerCase() === 'input' && (el.type === 'radio' || el.type === 'checkbox')
        const label = isChoice ? labelOf(el) : null
        const box = isChoice && (!shown(el) || tiny(el)) && label && shown(label) ? label : el
        if (!shown(box)) continue
        ref++
        if (ref > ${limit}) break
        el.setAttribute('data-iris-ref', String(ref))
        const rect = box.getBoundingClientRect()
        const isSelect = el.tagName.toLowerCase() === 'select'
        const opts = isSelect ? Array.from(el.options).slice(0, 60) : []
        const options = isSelect ? opts.map((o) => o.value) : undefined
        // What a person reads in the dropdown: "Austin: DoubleTree University Area", not "30".
        const optionLabels = isSelect ? opts.map((o) => (o.label || o.textContent || '').trim()) : undefined
        const aria = el.getAttribute('aria-checked')
        out.push({
          options,
          optionLabels,
          ref,
          role: roleOf(el),
          name: nameOf(el, label),
          tag: el.tagName.toLowerCase(),
          value: isChoice || el.value === undefined ? undefined : String(el.value),
          checked: isChoice ? !!el.checked : aria === 'true' ? true : aria === 'false' ? false : undefined,
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          inViewport: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
          href: hrefOf(el),
          ids: idsOf(el),
          inDialog: root !== document ? true : undefined,
        })
      }
      return out
    })()`

    return (await this.evaluate<PageElement[]>(js)) ?? []
  }

  /**
   * Everything that identifies ONE element without clicking it: its attributes, the links and
   * ids on it and around it (the card it sits in), and the page's canonical address. Facts with
   * where each came from; nothing is built from a guessed URL pattern.
   */
  async inspect(ref: number): Promise<InspectedElement | null> {
    return await this.evaluate<InspectedElement | null>(`(() => {
      const el = document.querySelector('[data-iris-ref="${ref}"]')
      if (!el) return null
      const ID_ATTR = /^data-(.*[-_])?(id|jk|sku|key|slug|uuid|item|listing|product|job)([-_]?id)?$/i
      const SKIP = /^(style|class|data-iris-ref|on.*)$/i
      const attrs = (x) => {
        const o = {}
        for (const a of Array.from(x.attributes || [])) if (!SKIP.test(a.name) && a.value.length <= 300) o[a.name] = a.value
        return o
      }
      const web = (h) => (/^https?:/.test(h || '') ? h : undefined)
      const found = []
      const seen = new Set()
      const add = (url, source, where) => { if (url && !seen.has(url)) { seen.add(url); found.push({ url, source, where }) } }
      if (el.tagName.toLowerCase() === 'a') add(web(el.href), 'anchor', 'the element')
      const up = el.closest('a[href]')
      if (up && up !== el) add(web(up.href), 'ancestor-anchor', 'a link around the element')
      const ancestors = []
      const ids = {}
      let card = null
      for (let x = el.parentElement, i = 0; x && x !== document.body && i < 8; x = x.parentElement, i++) {
        const own = {}
        for (const a of Array.from(x.attributes || [])) if (ID_ATTR.test(a.name) && a.value.length <= 120) { own[a.name] = a.value; if (!(a.name in ids)) ids[a.name] = a.value }
        const r = x.getAttribute('role')
        if (!card && (Object.keys(own).length || /^(li|article)$/i.test(x.tagName) || r === 'listitem' || r === 'article')) card = x
        ancestors.push({ tag: x.tagName.toLowerCase(), role: r || undefined, id: x.id || undefined, ids: Object.keys(own).length ? own : undefined })
      }
      for (const a of Array.from(el.attributes || [])) if (ID_ATTR.test(a.name)) ids[a.name] = a.value
      if (card) for (const a of Array.from(card.querySelectorAll('a[href]')).slice(0, 10)) add(web(a.href), 'card-anchor', 'a link in the same card: ' + (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60))
      const canon = document.querySelector('link[rel=canonical]')
      return {
        tag: el.tagName.toLowerCase(),
        attributes: attrs(el),
        ids,
        links: found,
        ancestors,
        canonical: canon ? web(canon.href) : undefined,
        page: location.href,
      }
    })()`)
  }

  /** Where the page is now, read fresh: a site that routes in place (pushState) changes this
   * without loading a page. */
  async where(): Promise<{ url: string; title: string }> {
    const w = await this.evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")
    if (w?.url) this.currentUrl = w.url
    return w ?? { url: this.currentUrl ?? "", title: "" }
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
        const want = ${JSON.stringify(value)}
        // A value or the words a person sees: both pick the same option.
        const opt = el.options ? Array.from(el.options).find((o) => o.value === want) || Array.from(el.options).find((o) => (o.label || o.textContent || '').trim().toLowerCase() === want.trim().toLowerCase()) : null
        el.value = opt ? opt.value : want
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
  // A VISIBLE window is watched by the person: IRIS's cursor glides to what it acts on there too.
  // Headless, nobody is watching, so no glide and no wait.
  override clickRef(ref: number) {
    return this.kind.visible ? withCursor((e) => this.evaluate(e), ref, () => super.clickRef(ref)) : super.clickRef(ref)
  }
  override typeRef(ref: number, text: string) {
    return this.kind.visible ? withCursor((e) => this.evaluate(e), ref, () => super.typeRef(ref, text)) : super.typeRef(ref, text)
  }
  override selectRef(ref: number, value: string) {
    return this.kind.visible
      ? withCursor((e) => this.evaluate(e), ref, () => super.selectRef(ref, value))
      : super.selectRef(ref, value)
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
