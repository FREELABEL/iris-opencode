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
import { normalizeDate, type ElementListing, type PageElement, type PageSignals } from "./browser-verbs"
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


type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } }

/**
 * The page-script prelude every verb shares (#193355): the page is more than `document`.
 *
 * A web component keeps its buttons in an (open) shadow root and an embedded checkout lives in a
 * same-origin iframe; `document.querySelectorAll` sees neither, so the list missed them and a ref
 * stamped inside one could never be found again. One walker, one lookup, used by every script, so a
 * control that is listed is a control that can be clicked, typed into, inspected and read back.
 * A cross-origin frame stays closed: the browser refuses, and so do we.
 */
const DEEP = `
const frameDoc = (el) => { if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null; try { const d = el.contentDocument; return d && d.documentElement ? d : null } catch (e) { return null } };
const deepEach = (root, fn) => { for (const el of root.querySelectorAll('*')) { fn(el); if (el.shadowRoot) deepEach(el.shadowRoot, fn); const d = frameDoc(el); if (d) deepEach(d, fn) } };
const byRef = (n) => {
  const sel = '[data-iris-ref="' + n + '"]';
  const look = (root) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      const inner = el.shadowRoot || frameDoc(el);
      if (inner) { const x = look(inner); if (x) return x }
    }
    return null;
  };
  return look(document);
};
const upOf = (x) => x.parentNode || x.host || (x.defaultView && x.defaultView.frameElement) || null;
const within = (root, el) => { for (let x = el; x; x = upOf(x)) if (x === root) return true; return false };
const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;
const cs = (el) => viewOf(el).getComputedStyle(el);
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  for (let w = viewOf(el); w !== window && w.frameElement; w = w.parent) { const f = w.frameElement.getBoundingClientRect(); dx += f.left + w.frameElement.clientLeft; dy += f.top + w.frameElement.clientTop }
  return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy, width: r.width, height: r.height };
};
const deepHit = (doc, x, y) => {
  let h = doc.elementFromPoint(x, y);
  while (h && h.shadowRoot) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner }
  return h;
};
const deepActive = () => {
  let a = document.activeElement;
  for (;;) {
    if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue }
    const d = a && frameDoc(a);
    if (d && d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue }
    return a;
  }
};
`

/**
 * Wait-for-the-page support (#193355 item 5). A click arms a watch on the page: when the DOM last
 * changed, whether the page is leaving, and the timers, fetches and XHRs the click's OWN handlers
 * started. A click that navigates 900 ms later (an async router) is then waited for instead of being
 * read back as "nothing changed" and clicked again. Only work started by the action is followed,
 * so a page's own clock does not hold every click to the cap.
 */
const SETTLE = `
const arm = () => {
  const old = window.__irisSettle;
  if (old && old.mo) old.mo.disconnect();
  const s = window.__irisSettle = { url: location.href, last: performance.now(), until: 0, pending: 0, leaving: false, mo: null };
  try { s.mo = new MutationObserver(() => { s.last = performance.now() }); s.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }) } catch (e) {}
  const leave = () => { s.leaving = true };
  addEventListener('beforeunload', leave, { once: true });
  addEventListener('pagehide', leave, { once: true });
  return s;
};
const track = (s, fn) => {
  const st = window.setTimeout, f = window.fetch, XS = window.XMLHttpRequest && XMLHttpRequest.prototype.send;
  window.setTimeout = function (cb, ms, ...a) {
    const d = Number(ms) || 0;
    if (typeof cb !== 'function' || d > 2500) return st.call(window, cb, ms, ...a);
    s.until = Math.max(s.until, performance.now() + d);
    return st.call(window, function () { return track(s, () => cb.apply(this, a)) }, ms);
  };
  if (f) window.fetch = function () { s.pending++; const p = f.apply(this, arguments); p.then(() => s.pending--, () => s.pending--); return p };
  if (XS) XMLHttpRequest.prototype.send = function () { s.pending++; this.addEventListener('loadend', () => s.pending--, { once: true }); return XS.apply(this, arguments) };
  try { return fn() } finally { window.setTimeout = st; if (f) window.fetch = f; if (XS) XMLHttpRequest.prototype.send = XS }
};
`

const SETTLE_READ = `(() => {
  const s = window.__irisSettle;
  if (!s) return { fresh: true, ready: document.readyState };
  const now = performance.now();
  return { fresh: false, leaving: s.leaving, pending: s.pending, wait: s.until - now, quiet: now - s.last };
})()`

const SETTLE_DONE = `(() => { const s = window.__irisSettle; if (s && s.mo) s.mo.disconnect(); window.__irisSettle = undefined; return true })()`

/** The keys `press` knows, with the codes old widgets still read off the event. */
export const KEYS = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Backspace: 8,
} as const
export type Key = keyof typeof KEYS

/** What Enter would do where it is pressed: the tool gates a submit or a send on it. */
export type EnterEffect = {
  found: boolean
  /** submit: submits a form (label: its submit button or the form's name). activate: presses a
   * button or link (label: its name). newline: a message box, where Enter often SENDS. */
  kind: "submit" | "activate" | "newline" | "none"
  label: string
}

const SIGNALS = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const h = document.querySelector('h1, h2');
  return {
    url: location.href,
    title: document.title || '',
    heading: ((h && h.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    text: text.slice(0, 600),
    textLength: text.trim().length,
    frames: Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((f) => f.src || ''),
    cfChallenge: typeof window._cf_chl_opt === 'object' && window._cf_chl_opt !== null,
    blockWidget: !!document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running, #px-captcha, #sec-if-cpt-container, iframe[src*="captcha-delivery.com"]'),
  };
})()`

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
  /** How the last `elements` call was cut: what exists, what matched, what was left out where. */
  lastListing: ElementListing | null = null
  /** What the last action did that its diff cannot show (a new tab kept in this one, a date the
   * field refused). Read once with takeNotes. */
  protected notes: string[] = []

  abstract evaluate<T>(expression: string): Promise<T>
  abstract open(url: string): Promise<{ url: string; title: string; status: string }>
  abstract screenshot(): Promise<Uint8Array>
  abstract close(): Promise<void>

  takeNotes(): string[] {
    const out = [...new Set(this.notes)]
    this.notes = []
    return out
  }

  /** The text a person would read, not the markup. */
  async text(): Promise<string> {
    return (await this.evaluate<string>("document.body ? document.body.innerText : ''")) ?? ""
  }

  /** The facts a bot check is recognised by; browser-verbs decides. */
  async signals(): Promise<PageSignals | null> {
    return await this.evaluate<PageSignals | null>(SIGNALS)
  }

  /**
   * The page as a numbered menu, rebuilt on every call (S3).
   *
   * Refs are assigned here and stamped onto the elements as a data attribute, so a later click
   * addresses the SAME node even if the page reflowed — and a ref from a previous page simply is
   * not found, rather than hitting whatever now sits in that position. Never coordinates: a
   * screenshot-and-click loop misses when a banner shifts the layout by ten pixels.
   */
  async elements(limit = 150, opts: { query?: string; include?: number } = {}): Promise<PageElement[]> {
    const query = JSON.stringify(String(opts.query ?? "").trim().toLowerCase())
    const include = Number.isInteger(opts.include) ? Number(opts.include) : -1
    const js = `(() => {
      ${DEEP}
      const SEL = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [contenteditable=true]'
      const LIMIT = ${Math.max(1, Math.trunc(limit))}
      const QUERY = ${query}
      const INCLUDE = ${include}
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
      // aria-labelledby points at other elements by id, in the element's own tree.
      const byIds = (el, attr) => {
        const ids = (el.getAttribute(attr) || '').split(/\\s+/).filter(Boolean)
        if (!ids.length) return ''
        const root = el.getRootNode()
        return ids.map((id) => { const x = (root.getElementById && root.getElementById(id)) || el.ownerDocument.getElementById(id); return x ? (x.innerText || x.textContent || '') : '' }).join(' ')
      }
      // An icon button says what it does in its svg <title> or its image's alt, not in text.
      const iconName = (el) => { const t = el.querySelector && el.querySelector('svg title'); const i = el.querySelector && el.querySelector('img[alt]'); return (t && t.textContent) || (i && i.getAttribute('alt')) || '' }
      const nameOf = (el, label) =>
        clean(byIds(el, 'aria-labelledby') || el.getAttribute('aria-label') || (label && label.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') ||
         (el.innerText || (el.type === 'radio' || el.type === 'checkbox' ? '' : el.type === 'password' ? '' : el.value) || '').trim() || iconName(el) || el.getAttribute('name') || '').slice(0, 120)
      const shown = (el) => {
        const rect = el.getBoundingClientRect()
        const style = cs(el)
        return !(style.display === 'none' || style.visibility === 'hidden' || (rect.width === 0 && rect.height === 0))
      }
      // A choice drawn by the site: the real radio/checkbox is hidden (0 size, opacity 0, off
      // screen) and its LABEL is what a person clicks (Toast, 2026-11-11: the protein choices).
      const labelOf = (el) => (el.labels && el.labels[0]) || el.closest('label')
      const tiny = (el) => { const r = el.getBoundingClientRect(); return r.width < 2 || r.height < 2 || Number(cs(el).opacity) === 0 }
      // A control drawn by the site with no button under it: a <div> that answers a click
      // (Southwest's fare cells, #193331). A person knows it by the pointer cursor, so do we.
      // Only the OUTERMOST such box, and never one that holds or sits in a real control — that
      // control is listed itself.
      const SKIP_TAG = /^(html|body|head|script|style|noscript|template|svg|path|g|use|iframe|img|br|hr)$/i
      const isArea = (el) => {
        if (SKIP_TAG.test(el.tagName)) return false
        const own = el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0) || cs(el).cursor === 'pointer'
        if (!own) return false
        const p = el.parentElement
        if (p && p !== el.ownerDocument.body && cs(p).cursor === 'pointer' && !p.matches(SEL)) return false
        if (el.closest(SEL) || el.querySelector(SEL)) return false
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) return false
        if (r.width * r.height > innerWidth * innerHeight * 0.5) return false // a page-sized wrapper is not a button
        return !!(clean(el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title'))
      }

      // 0. Everything, across open shadow roots and same-origin frames (#193355).
      const all = []
      deepEach(document, (el) => all.push(el))

      // An open pop-up that BLOCKS the page is the page right now: list only it, so a long page
      // behind it (a whole menu) can't push its choices past the limit. A pop-up that does not
      // block — a cookie banner along the bottom, a sign-in flyout at the side — is just more of
      // the page (Southwest: a OneTrust banner hid 157 of 159 controls, #193355).
      const H = innerHeight
      const W = innerWidth
      const blocking = (d) => {
        if (d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'alertdialog') return true
        try { if (d.matches('dialog:modal')) return true } catch (e) {}
        const r = rectOf(d)
        if (!(r.left <= W / 2 && W / 2 <= r.right && r.top <= H / 2 && H / 2 <= r.bottom)) return false
        const hit = deepHit(document, W / 2, H / 2)
        return !!hit && within(d, hit)
      }
      const modals = all.filter((el) => el.matches('[aria-modal=true], dialog[open], [role=dialog], [role=alertdialog]') && shown(el) && blocking(el))
      const root = modals.length ? modals[modals.length - 1] : null

      // 1. Every control on the page, in document order.
      const found = []
      let behind = 0
      for (const el of all) {
        let entry = null
        if (el.matches(SEL)) {
          const isChoice = el.tagName.toLowerCase() === 'input' && (el.type === 'radio' || el.type === 'checkbox')
          const label = isChoice ? labelOf(el) : null
          const box = isChoice && (!shown(el) || tiny(el)) && label && shown(label) ? label : el
          if (shown(box)) entry = { el, box, label, area: false }
        } else if (isArea(el) && shown(el)) {
          entry = { el, box: el, label: null, area: true }
        }
        if (!entry) continue
        if (root && !within(root, el)) behind++
        else found.push(entry)
      }

      // 2. Numbers that stay put. A control keeps the number it was given on an earlier listing,
      // so scrolling, or asking for a subset, never renumbers what the agent already saw; a new
      // control gets the next free number. A node copied with its number (a carousel's clone) is
      // given a new one, so one number is never two places.
      let next = 1
      for (const x of all) { const n = x.getAttribute('data-iris-ref'); if (n) next = Math.max(next, (parseInt(n, 10) || 0) + 1) }
      const taken = new Set()
      for (const f of found) {
        const had = parseInt(f.el.getAttribute('data-iris-ref') || '', 10)
        f.ref = had > 0 && !taken.has(had) ? had : next++
        taken.add(f.ref)
        f.el.setAttribute('data-iris-ref', String(f.ref))
      }

      // 3. What a person can see first, then what is below, then what is above. A long header
      // must not push the part of the page they are looking at off the list (#193331).
      for (const f of found) {
        const r = rectOf(f.box)
        f.rect = r
        f.zone = r.bottom <= 0 ? 'above' : r.top >= H ? 'below' : r.right <= 0 || r.left >= W ? 'aside' : 'view'
      }
      const rank = { view: 0, below: 1, aside: 2, above: 3 }
      const ordered = found.slice().sort((a, b) =>
        rank[a.zone] - rank[b.zone] ||
        (a.zone === 'view' ? 0 : a.zone === 'above' ? b.rect.bottom - a.rect.bottom : a.rect.top - b.rect.top))

      // 3b. A strip of look-alike controls (a 148-day date bar, a seat map, page numbers) is one
      // thing to a person: keep a few, say what the rest are, so it cannot fill the list and push
      // the rest of the page off it (Southwest, #193443). Only when the list would overflow, and
      // never for a query: a query is how the agent reaches one of them.
      const collapsed = []
      const stripOf = (el) => {
        for (let x = el, i = 0; x && x.parentElement && i < 5; x = x.parentElement, i++) {
          if (x.parentElement.children.length >= 12) return x.parentElement
        }
        return null
      }
      const squeeze = (list) => {
        if (QUERY || list.length <= LIMIT) return list
        const groups = new Map()
        for (const f of list) {
          const c = stripOf(f.el)
          if (!c) continue
          const k = roleOf(f.el)
          if (!groups.has(c)) groups.set(c, new Map())
          const byRole = groups.get(c)
          if (!byRole.has(k)) byRole.set(k, [])
          byRole.get(k).push(f)
        }
        const drop = new Set()
        for (const byRole of groups.values()) for (const [role, fs] of byRole) {
          if (fs.length <= 24) continue
          const keep = new Set([...fs.filter((f) => f.zone === 'view'), ...fs].slice(0, 12))
          const gone = fs.filter((f) => !keep.has(f))
          gone.forEach((f) => drop.add(f))
          const names = fs.map((f) => nameOf(f.el, f.label)).filter(Boolean)
          collapsed.push({ role, count: gone.length, first: (names[0] || '').slice(0, 40), last: (names[names.length - 1] || '').slice(0, 40) })
        }
        return list.filter((f) => !drop.has(f))
      }
      const matches = QUERY
        ? ordered.filter((f) => (nameOf(f.el, f.label) + ' ' + clean(f.box.innerText).slice(0, 200)).toLowerCase().includes(QUERY))
        : squeeze(ordered)
      const picked = matches.slice(0, LIMIT)
      if (INCLUDE > 0 && !picked.some((f) => f.ref === INCLUDE)) {
        const extra = found.find((f) => f.ref === INCLUDE)
        if (extra) picked.push(extra)
      }
      const left = matches.slice(LIMIT)

      // 4. Two controls with the same words are two different things: say which (#193355). A
      // calendar's "10" carries its month, a results row's "Select" its flight.
      const contextOf = (el, name) => {
        const t = el.closest('table, [role=grid], fieldset')
        if (t) {
          const cap = t.tagName === 'TABLE' && t.caption ? t.caption.innerText : t.tagName === 'FIELDSET' && t.querySelector('legend') ? t.querySelector('legend').innerText : ''
          const lab = clean(cap || t.getAttribute('aria-label') || byIds(t, 'aria-labelledby'))
          if (lab) return lab.slice(0, 60)
        }
        for (let x = el.parentElement, i = 0; x && x !== x.ownerDocument.body && i < 6; x = x.parentElement, i++) {
          const txt = clean(x.innerText)
          if (txt.length > 160) break
          const rest = clean(txt.split(name).join(' '))
          if (rest && rest.length <= 80 && !/^[\\d\\s]+$/.test(rest)) return rest
        }
        for (let x = el, i = 0; x && x !== x.ownerDocument.body && i < 8; x = x.parentElement, i++) {
          for (let s = x.previousElementSibling, j = 0; s && j < 10; s = s.previousElementSibling, j++) {
            const h = s.matches('h1, h2, h3, h4, h5, h6, [role=heading]') ? s : Array.from(s.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')).pop()
            if (h && clean(h.innerText)) return clean(h.innerText).slice(0, 60)
          }
        }
        return ''
      }
      const names = picked.map((f) => nameOf(f.el, f.label))
      const seen = {}
      for (const n of names) seen[n.toLowerCase()] = (seen[n.toLowerCase()] || 0) + 1
      picked.forEach((f, i) => {
        if (!names[i] || seen[names[i].toLowerCase()] < 2) return
        const c = contextOf(f.box, names[i])
        if (c && c !== names[i]) names[i] = names[i] + ' (' + c + ')'
      })

      // 5. Something on top of it (a cookie overlay, a sticky bar): a person's click would land
      // there, so say so and let the agent clear it first (#193355).
      const coveredBy = (f) => {
        if (f.zone !== 'view') return undefined
        const r = f.box.getBoundingClientRect()
        const doc = f.box.ownerDocument
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        const v = viewOf(f.box)
        if (x < 0 || y < 0 || x > v.innerWidth || y > v.innerHeight) return undefined
        const hit = deepHit(doc, x, y)
        if (!hit || within(f.box, hit) || within(hit, f.box) || within(f.el, hit) || (f.label && within(f.label, hit))) return undefined
        const cov = hit.closest('[role=dialog], [role=alertdialog], dialog, [aria-modal]') || hit
        const said = clean(cov.getAttribute('aria-label') || cov.innerText).slice(0, 40)
        return said || cov.tagName.toLowerCase() + (cov.id ? '#' + cov.id : '')
      }

      const items = picked.map((f, i) => {
        const el = f.el
        const isChoice = !f.area && el.tagName.toLowerCase() === 'input' && (el.type === 'radio' || el.type === 'checkbox')
        const isSelect = !f.area && el.tagName.toLowerCase() === 'select'
        const opts = isSelect ? Array.from(el.options).slice(0, 60) : []
        const aria = el.getAttribute('aria-checked')
        return {
          options: isSelect ? opts.map((o) => o.value) : undefined,
          // What a person reads in the dropdown: "Austin: DoubleTree University Area", not "30".
          optionLabels: isSelect ? opts.map((o) => (o.label || o.textContent || '').trim()) : undefined,
          ref: f.ref,
          role: f.area ? 'button' : roleOf(el),
          area: f.area || undefined,
          name: names[i],
          tag: el.tagName.toLowerCase(),
          // A password is never read back, not even to the agent that typed it.
          value: f.area || isChoice || el.value === undefined ? undefined : el.type === 'password' ? (el.value ? '(hidden)' : '') : String(el.value),
          checked: isChoice ? !!el.checked : aria === 'true' ? true : aria === 'false' ? false : undefined,
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          inViewport: f.zone === 'view',
          href: (() => { const a = el.closest('a[href]'); return a && /^https?:/.test(a.href) ? a.href : undefined })(),
          ids: (() => {
            const ID_ATTR = /^data-(.*[-_])?(id|jk|sku|key|slug|uuid|item|listing|product|job)([-_]?id)?$/i
            const ids = {}
            let n = 0
            for (let x = el; x && x !== el.ownerDocument.body && n < 4; x = x.parentElement) {
              for (const a of Array.from(x.attributes || [])) {
                if (n < 4 && ID_ATTR.test(a.name) && a.value && a.value.length <= 80 && !(a.name in ids)) { ids[a.name] = a.value; n++ }
              }
            }
            return n ? ids : undefined
          })(),
          inDialog: root ? true : undefined,
          covered: coveredBy(f),
        }
      })
      return {
        items,
        total: found.length,
        matched: matches.length,
        above: left.filter((f) => f.zone === 'above').length,
        below: left.filter((f) => f.zone !== 'above').length,
        behind: root ? behind : undefined,
        collapsed: collapsed.length ? collapsed : undefined,
        signals: ${SIGNALS},
      }
    })()`

    const got = await this.evaluate<{
      items: PageElement[]
      total: number
      matched: number
      above: number
      below: number
      behind?: number
      collapsed?: ElementListing["collapsed"]
      signals?: PageSignals
    } | null>(js)
    this.lastListing = got
      ? {
          total: got.total,
          matched: got.matched,
          above: got.above,
          below: got.below,
          behind: got.behind,
          collapsed: got.collapsed,
          query: opts.query?.trim() || undefined,
          signals: got.signals,
        }
      : null
    return got?.items ?? []
  }

  /**
   * Everything that identifies ONE element without clicking it: its attributes, the links and
   * ids on it and around it (the card it sits in), and the page's canonical address. Facts with
   * where each came from; nothing is built from a guessed URL pattern.
   */
  async inspect(ref: number): Promise<InspectedElement | null> {
    return await this.evaluate<InspectedElement | null>(`(() => {
      ${DEEP}
      const el = byRef(${Math.trunc(ref)})
      if (!el) return null
      const ID_ATTR = /^data-(.*[-_])?(id|jk|sku|key|slug|uuid|item|listing|product|job)([-_]?id)?$/i
      const SKIP = /^(style|class|data-iris-ref|on.*)$/i
      const attrs = (x) => {
        const o = {}
        for (const a of Array.from(x.attributes || [])) if (!SKIP.test(a.name) && a.value.length <= 300) o[a.name] = a.value
        if (x.type === 'password') delete o.value
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
      for (let x = el.parentElement, i = 0; x && x !== el.ownerDocument.body && i < 8; x = x.parentElement, i++) {
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
  async state(): Promise<{ url: string; title: string; textLength: number; textHash: string; values: Record<string, string>; head: string }> {
    const js = `(() => {
      ${DEEP}
      const text = document.body ? document.body.innerText : ''
      let h = 0
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
      const values = {}
      deepEach(document, (el) => {
        const n = el.getAttribute('data-iris-ref')
        if (n && el.value !== undefined) values[n] = el.type === 'password' ? (el.value ? '(hidden)' : '') : String(el.value)
      })
      return { url: location.href, title: document.title, textLength: text.length, textHash: String(h), values, head: text.slice(0, 400) }
    })()`

    return await this.evaluate(js)
  }

  /**
   * Wait until the page has finished answering an action: it navigated and the new page is up, or
   * its DOM has been quiet for 300 ms with nothing the action started still pending. Capped, so a
   * page that never stops moving costs one wait, not a hang. (#193355 item 5)
   */
  protected async settle(capMs = 2500): Promise<void> {
    const start = Date.now()
    await Bun.sleep(60)
    while (Date.now() - start < capMs) {
      // An error is a page between documents: look again. An answer that is not the watch's is a
      // target that does not run it: stop waiting.
      const s = await this.evaluate<
        { fresh: true; ready: string } | { fresh: false; leaving: boolean; pending: number; wait: number; quiet: number } | null
      >(SETTLE_READ).catch(() => undefined)
      if (s !== undefined && (s === null || typeof s !== "object")) break
      if (s?.fresh === true && s.ready !== "loading") break
      if (s?.fresh === false && !s.leaving && s.pending <= 0 && s.wait <= 0 && s.quiet >= 300) break
      await Bun.sleep(100)
    }
    await this.evaluate(SETTLE_DONE).catch(() => undefined)
    this.currentUrl = (await this.evaluate<string>("location.href").catch(() => null)) ?? this.currentUrl
  }

  /**
   * Click the element holding this ref, the way a mouse does (#193355 item 3): pointer and mouse
   * events at its centre, focus, then the click. Menus and pickers built on pointerdown/mousedown
   * (Radix, MUI, react-select) never saw a bare el.click(). The click is dispatched once, here;
   * nothing else fires one. Returns false when the ref is no longer on the page.
   */
  async clickRef(ref: number): Promise<boolean> {
    const ok = await this.evaluate<boolean>(`(() => {
      ${DEEP}
      ${SETTLE}
      const el = byRef(${Math.trunc(ref)})
      if (!el) return false
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const s = arm()
      track(s, () => {
        const V = viewOf(el)
        const lab = (el.labels && el.labels[0]) || null
        const r0 = el.getBoundingClientRect()
        const r = (r0.width < 2 || r0.height < 2) && lab ? lab.getBoundingClientRect() : r0
        const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, screenX: r.left + r.width / 2, screenY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, view: V }
        const P = V.PointerEvent || V.MouseEvent
        const ptr = (type, buttons, extra) => el.dispatchEvent(new P(type, Object.assign({}, at, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons }, extra || {})))
        const mouse = (type, buttons, extra) => el.dispatchEvent(new V.MouseEvent(type, Object.assign({}, at, { button: 0, buttons }, extra || {})))
        ptr('pointerover', 0)
        ptr('pointerenter', 0, { bubbles: false, cancelable: false })
        mouse('mouseover', 0)
        mouse('mousemove', 0)
        // A cancelled pointerdown suppresses the mouse events after it, as in a browser.
        const down = ptr('pointerdown', 1)
        const mdown = down ? mouse('mousedown', 1, { detail: 1 }) : true
        if (mdown && typeof el.focus === 'function' && el.isConnected) el.focus({ preventScroll: true })
        if (!el.isConnected) return
        ptr('pointerup', 0)
        if (down) mouse('mouseup', 0, { detail: 1 })
        if (el.isConnected) mouse('click', 0, { detail: 1 })
      })
      return true
    })()`)
    if (ok) await this.settle()
    else this.currentUrl = (await this.evaluate<string>("location.href").catch(() => null)) ?? this.currentUrl

    return !!ok
  }

  /**
   * Type into the element holding this ref, one key at a time (#193355 item 4): keydown,
   * keypress, beforeinput, input, keyup per character, through the field's NATIVE value setter so
   * React sees it. Autocompletes that listen on keyup now suggest; editors that build their text
   * from beforeinput (Lexical, ProseMirror) now receive it. A new line is a line break, never an
   * Enter key: Enter can SEND, and that goes through `press`, where it is gated.
   *
   * A date field takes ISO only; "12/10/2026" is turned into 2026-12-10 first (normalizeDate). If
   * the field still ends empty, a note says so instead of reporting success.
   */
  async typeRef(ref: number, text: string): Promise<boolean> {
    const iso = normalizeDate(text)
    const got = await this.evaluate<{ ok: boolean; empty?: boolean; date?: boolean } | null>(`(() => {
      ${DEEP}
      ${SETTLE}
      const el = byRef(${Math.trunc(ref)})
      if (!el) return { ok: false }
      const V = viewOf(el)
      const D = el.ownerDocument
      const v = ${JSON.stringify(text)}
      const ISO = ${JSON.stringify(iso)}
      el.scrollIntoView({ block: 'center' })
      el.focus()
      const s = arm()
      const proto = el.tagName === 'TEXTAREA' ? V.HTMLTextAreaElement.prototype : el.tagName === 'INPUT' ? V.HTMLInputElement.prototype : Object.getPrototypeOf(el)
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      const setVal = (x) => (desc && desc.set ? desc.set.call(el, x) : (el.value = x))
      const ed = el.isContentEditable
      const charwise = ed || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|)$/i.test(el.getAttribute('type') || ''))
      const codeOf = (ch) => /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : ''
      const key = (type, ch) => {
        const ev = new V.KeyboardEvent(type, { key: ch, code: codeOf(ch), bubbles: true, cancelable: true, composed: true, view: V })
        const c = type === 'keypress' ? ch.charCodeAt(0) : ch.toUpperCase().charCodeAt(0)
        try { Object.defineProperty(ev, 'keyCode', { get: () => c }); Object.defineProperty(ev, 'which', { get: () => c }); if (type === 'keypress') Object.defineProperty(ev, 'charCode', { get: () => c }) } catch (e) {}
        return el.dispatchEvent(ev)
      }
      const beforeInput = (inputType, data) => el.dispatchEvent(new V.InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, composed: true }))
      const input = (inputType, data) => el.dispatchEvent(new V.InputEvent('input', { inputType, data, bubbles: true, composed: true }))
      const toEnd = () => { const sel = V.getSelection(); if (!sel) return; const r = D.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r) }
      track(s, () => {
        // Replace, never append: what was in the field goes first.
        if (ed) {
          if (el.textContent) {
            const sel = V.getSelection(); if (sel) { const r = D.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r) }
            if (beforeInput('deleteContentBackward', null)) { if (!D.execCommand('delete')) { el.textContent = ''; input('deleteContentBackward', null) } }
          }
        } else if (el.value) {
          if (beforeInput('deleteContentBackward', null)) { setVal(''); input('deleteContentBackward', null) }
        }
        if (!charwise) {
          for (const ch of v) { key('keydown', ch); key('keypress', ch); key('keyup', ch) }
          if (beforeInput('insertText', v)) { setVal(el.type === 'date' && ISO ? ISO : v); input('insertText', v) }
          return
        }
        for (const ch of v) {
          const nl = ch === '\\n'
          if (!nl && !key('keydown', ch)) { key('keyup', ch); continue }
          if (!nl) key('keypress', ch)
          const it = nl ? (el.tagName === 'TEXTAREA' ? 'insertLineBreak' : ed ? 'insertParagraph' : '') : 'insertText'
          if (it && beforeInput(it, nl ? null : ch)) {
            if (ed) {
              toEnd()
              if (!D.execCommand(nl ? 'insertLineBreak' : 'insertText', false, nl ? undefined : ch)) { el.appendChild(D.createTextNode(ch)); input(it, nl ? null : ch) }
            } else if (!(el.maxLength > 0 && el.value.length >= el.maxLength)) {
              setVal(el.value + ch)
              input(it, nl ? null : ch)
            }
          }
          if (!nl) key('keyup', ch)
        }
      })
      if (!ed) el.dispatchEvent(new V.Event('change', { bubbles: true }))
      const now = ed ? el.textContent : el.value
      return { ok: true, empty: v.trim() !== '' && !String(now || '').trim(), date: el.type === 'date' }
    })()`)
    if (got?.ok) await this.settle(1500)
    if (got?.empty) {
      this.notes.push(
        got.date
          ? "the date field is still EMPTY: it did not take that date. Type it as YYYY-MM-DD (e.g. 2026-12-10), or pick it in the site's calendar."
          : "the field is still EMPTY after typing: the site did not take the text. Look at it (screenshot) before going on.",
      )
    }

    return !!got?.ok
  }

  /**
   * What Enter would do on this ref, or on whatever has focus: the tool asks before an Enter that
   * submits a pay/send form, or presses Enter in a message box (where Enter often sends).
   */
  async enterEffect(ref?: number): Promise<EnterEffect> {
    return await this.evaluate<EnterEffect>(`(() => {
      ${DEEP}
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const REF = ${ref === undefined ? "null" : Math.trunc(ref)}
      const el = REF === null ? deepActive() : byRef(REF)
      if (!el) return { found: REF === null, kind: 'none', label: '' }
      const nameOf = (x) => clean(x.getAttribute('aria-label') || x.innerText || x.value || x.getAttribute('title') || '').slice(0, 80)
      if (el.isContentEditable || el.tagName === 'TEXTAREA') return { found: true, kind: 'newline', label: nameOf(el) || 'a message box' }
      if (el.tagName === 'INPUT' && el.form && !/^(button|submit|reset|image|checkbox|radio|file|color|range)$/i.test(el.type)) {
        const btn = el.form.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]')
        return { found: true, kind: 'submit', label: btn ? nameOf(btn) : clean(el.form.getAttribute('aria-label') || el.form.getAttribute('name') || nameOf(el)) }
      }
      if (el.matches('a[href], button, [role=button], [role=link], summary, input[type=submit], input[type=button]')) return { found: true, kind: 'activate', label: nameOf(el) }
      return { found: true, kind: 'none', label: nameOf(el) }
    })()`)
  }

  /**
   * Press one key on this ref, or on whatever has focus (#193355 item 4): keydown (and keypress
   * for Enter), then what the browser itself would do if the page did not stop it, then keyup.
   * Enter in a form submits it (its submit button, or requestSubmit when there is none — a search
   * box with no button); Tab moves focus; Backspace deletes; Escape closes a <dialog>. Then waits
   * for the page to settle, like a click.
   */
  async pressKey(ref: number | undefined, key: Key): Promise<boolean> {
    const ok = await this.evaluate<boolean>(`(() => {
      ${DEEP}
      ${SETTLE}
      const REF = ${ref === undefined ? "null" : Math.trunc(ref)}
      const KEY = ${JSON.stringify(key)}
      const CODE = ${KEYS[key]}
      const found = REF === null ? deepActive() : byRef(REF)
      if (REF !== null && !found) return false
      const el = found || document.body
      if (REF !== null) { el.scrollIntoView({ block: 'center' }); if (typeof el.focus === 'function') el.focus() }
      const V = viewOf(el)
      const D = el.ownerDocument
      const send = (type) => {
        const ev = new V.KeyboardEvent(type, { key: KEY, code: KEY, bubbles: true, cancelable: true, composed: true, view: V })
        try { Object.defineProperty(ev, 'keyCode', { get: () => CODE }); Object.defineProperty(ev, 'which', { get: () => CODE }) } catch (e) {}
        return el.dispatchEvent(ev)
      }
      const s = arm()
      track(s, () => {
        let go = send('keydown')
        if (go && KEY === 'Enter') go = send('keypress')
        if (go) {
          const proto = el.tagName === 'TEXTAREA' ? V.HTMLTextAreaElement.prototype : V.HTMLInputElement.prototype
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          const setVal = (x) => (desc && desc.set ? desc.set.call(el, x) : (el.value = x))
          const textual = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset|image|checkbox|radio|file|color|range|hidden)$/i.test(el.type))
          const bi = (inputType) => el.dispatchEvent(new V.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true, composed: true }))
          const inp = (inputType) => el.dispatchEvent(new V.InputEvent('input', { inputType, bubbles: true, composed: true }))
          if (KEY === 'Enter') {
            if (el.tagName === 'INPUT' && textual && el.form) {
              const btn = el.form.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]')
              if (btn) { if (!btn.disabled) btn.click() }
              else if (el.form.requestSubmit) el.form.requestSubmit()
              else el.form.submit()
            } else if (el.tagName === 'TEXTAREA') {
              if (bi('insertLineBreak')) { setVal(el.value + '\\n'); inp('insertLineBreak') }
            } else if (el.isContentEditable) {
              if (bi('insertParagraph')) D.execCommand('insertParagraph')
            } else if (el.matches('a[href], button, [role=button], [role=link], summary, input[type=submit], input[type=button], input[type=checkbox], input[type=radio]')) {
              el.click()
            }
          } else if (KEY === 'Backspace') {
            if (textual && el.value) { if (bi('deleteContentBackward')) { setVal(el.value.slice(0, -1)); inp('deleteContentBackward') } }
            else if (el.isContentEditable && bi('deleteContentBackward')) D.execCommand('delete')
          } else if (KEY === 'Tab') {
            const all = Array.from(D.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable=true]'))
              .filter((x) => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length && x.type !== 'hidden')
            const i = all.indexOf(el)
            const nx = all[i + 1] || all[0]
            if (nx) nx.focus()
          } else if (KEY === 'Escape') {
            const d = el.closest('dialog') || D.querySelector('dialog[open]')
            if (d && d.open) { const c = new V.Event('cancel', { cancelable: true }); if (d.dispatchEvent(c)) d.close() }
          } else if ((KEY === 'ArrowDown' || KEY === 'ArrowUp') && el.tagName === 'SELECT') {
            const n = el.selectedIndex + (KEY === 'ArrowDown' ? 1 : -1)
            if (n >= 0 && n < el.options.length) { el.selectedIndex = n; el.dispatchEvent(new V.Event('input', { bubbles: true })); el.dispatchEvent(new V.Event('change', { bubbles: true })) }
          }
        }
        // keyup goes to what has focus now (Tab moved it).
        const after = deepActive() || el
        const up = new V.KeyboardEvent('keyup', { key: KEY, code: KEY, bubbles: true, cancelable: true, composed: true, view: V })
        try { Object.defineProperty(up, 'keyCode', { get: () => CODE }) } catch (e) {}
        ;(after.isConnected ? after : D.body).dispatchEvent(up)
      })
      return true
    })()`)
    if (ok) await this.settle()

    return !!ok
  }

  /** Set a dropdown to one of ITS values, firing the events a real choice would. */
  async selectRef(ref: number, value: string): Promise<boolean> {
    const ok = await this.evaluate<boolean>(
      `(() => {
        ${DEEP}
        const el = byRef(${Math.trunc(ref)})
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
 * The agent's Chrome keeps one tab (#193355 item 6). A link with target=_blank or a window.open
 * opened a tab nobody was driving, and the click read back "nothing changed". Here it opens in
 * THIS tab instead, and the binding tells the session so the answer can say it. Installed only in
 * PageSession: the desktop Browser pane decides its own tabs.
 */
const SAME_TAB = `(() => {
  const note = (u) => { try { window.__irisNewTab(String(u || '')) } catch (e) {} };
  const SELF = /^(_self|_parent|_top)$/i;
  const open = window.open;
  window.open = function (u, t, f) {
    if (!u || (t && SELF.test(String(t)))) return open.apply(this, arguments);
    let to = String(u);
    try { to = new URL(to, location.href).href } catch (e) {}
    note(to);
    location.assign(to);
    return null;
  };
  const retarget = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    for (const x of path) {
      if (!x || !x.tagName) continue;
      const tag = x.tagName.toUpperCase();
      if ((tag === 'A' || tag === 'AREA' || tag === 'FORM') && x.target && !SELF.test(x.target)) {
        note(tag === 'FORM' ? x.action : x.href);
        x.target = '_self';
        return;
      }
    }
  };
  addEventListener('click', retarget, true);
  addEventListener('submit', retarget, true);
})()`

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
  override pressKey(ref: number | undefined, key: Key) {
    return this.kind.visible && ref !== undefined
      ? withCursor((e) => this.evaluate(e), ref, () => super.pressKey(ref, key))
      : super.pressKey(ref, key)
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
    // One tab: new-tab links and window.open land here, and say so (#193355 item 6).
    await this.send("Runtime.enable")
    await this.send("Runtime.addBinding", { name: "__irisNewTab" })
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: SAME_TAB })
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
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "__irisNewTab") {
      this.notes.push(
        `the page asked for a NEW TAB${msg.params.payload ? ` (${String(msg.params.payload).slice(0, 160)})` : ""}; it opened in this tab instead. To get back, open the previous address again.`,
      )
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
