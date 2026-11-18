import { render } from "solid-js/web"
import "@/index.css"
import { IrisHiveInbox } from "@/components/session/iris-hive-inbox"
import fx from "@/components/session/__fixtures__/hive-inbox.json"

/**
 * Hive › Inbox (#189279; v2 #190917) with fictional messages, for a render check in a real browser.
 * `?theme=light|dark`, `?empty=1`, `?open=N` opens the Nth row, `?w=460` sets the panel width,
 * `?lens=activity` starts in Activity. Writes (done, unread, reply) change the fixture in memory.
 * Serve: bunx vite --config preview/vite.preview.config.ts → /preview/hive-inbox.html
 */
const q = new URLSearchParams(location.search)
document.documentElement.style.colorScheme = q.get("theme") === "light" ? "light" : "dark"
document.body.style.background = q.get("theme") === "light" ? "#f6f5f1" : "#131312"

const NOW = Date.now()
const items: any[] = q.get("empty")
  ? []
  : fx.items.map(({ minutesAgo, ...r }) => ({ ...r, receivedAt: new Date(NOW - minutesAgo * 60_000).toISOString() }))
const sent: any[] = q.get("empty") ? [] : fx.sent.map(({ minutesAgo, ...s }) => ({ ...s, sentAt: new Date(NOW - minutesAgo * 60_000).toISOString() }))
try {
  localStorage.setItem("iris.hive-inbox.v2", JSON.stringify({ lens: q.get("lens") === "activity" ? "activity" : "inbox", filter: "all" }))
} catch {}
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
const doFetch = async (path: string, init?: RequestInit) => {
  const u = new URL(path, location.origin)
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (u.pathname === "/iris/inbox") return json({ measured: true, unread: items.filter((r) => !r.read).length, items })
  if (u.pathname === "/iris/inbox-sent") return json({ measured: true, items: sent })
  if (u.pathname === "/iris/inbox-send") {
    const s = { id: `o${sent.length + 1}`, to: body.to, text: body.text, sentAt: new Date().toISOString(), taskId: "t-preview", replyTo: body.replyTo }
    sent.push(s)
    return json({ measured: true, ok: true, sent: s })
  }
  const st = u.pathname.match(/^\/iris\/inbox\/(\d+)\/state$/)
  if (st) {
    const r = items.find((x) => x.index === Number(st[1]))
    if (r && body.read !== undefined) r.read = body.read
    if (r && body.done !== undefined) Object.assign(r, { done: body.done, doneAt: new Date().toISOString() }, body.done ? { read: true } : {})
    return json({ measured: true, read: !!r?.read, done: !!r?.done, ...(body.resolveCard && r?.item ? { card: { item: r.item, ok: true } } : {}) })
  }
  const read = u.pathname.match(/^\/iris\/inbox\/(\d+)\/read$/)
  if (read && init?.method === "POST") {
    const r = items.find((x) => x.index === Number(read[1]))
    if (r) r.read = true
    return json({ measured: true, read: true, burned: false })
  }
  const one = u.pathname.match(/^\/iris\/inbox\/(\d+)$/)
  if (one) {
    const r = items.find((x) => x.index === Number(one[1]))!
    const body = (fx.bodies as Record<string, string | null>)[r.id]
    return json({
      measured: true,
      message: {
        ...r,
        body,
        bodyState: body === null ? "binary" : "ok",
        burn: false,
        url: r.type === "link" ? r.label : undefined,
        originalName: r.type === "file" ? r.label : undefined,
        status: r.status ?? (r.type === "job" ? "completed" : undefined),
        item: r.item ?? (r.type === "job" ? "atlas:item:5501" : undefined),
        result: r.type === "job" ? "Updated 4 cards, moved 1 to Done.\nexit 0" : undefined,
      },
    })
  }
  return json({ measured: false, reason: "unexpected " + path })
}

const root = document.getElementById("root")!
root.style.cssText = `width:${Number(q.get("w") ?? 460)}px;height:720px;display:flex;flex-direction:column;border-right:1px solid #8884`
render(() => <IrisHiveInbox doFetch={doFetch} />, root)

const open = Number(q.get("open") ?? 0)
if (open > 0) {
  // `?open=N` clicks the Nth row as listed (newest first).
  const tryOpen = () => {
    const row = document.querySelectorAll<HTMLButtonElement>(".hib-row")[open - 1]
    if (row) row.click()
    else setTimeout(tryOpen, 50)
  }
  tryOpen()
}
