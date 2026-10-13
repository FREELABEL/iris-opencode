import { render } from "solid-js/web"
import "@/index.css"
import { IrisHiveInbox } from "@/components/session/iris-hive-inbox"
import fx from "@/components/session/__fixtures__/hive-inbox.json"

/**
 * Hive › Inbox (#189279) with fictional messages, for a render check in a real browser.
 * `?theme=light|dark`, `?empty=1`, `?open=N` opens the Nth row.
 * Serve: bunx vite --config preview/vite.preview.config.ts → /preview/hive-inbox.html
 */
const q = new URLSearchParams(location.search)
document.documentElement.style.colorScheme = q.get("theme") === "light" ? "light" : "dark"
document.body.style.background = q.get("theme") === "light" ? "#f6f5f1" : "#131312"

const NOW = Date.now()
const items = q.get("empty")
  ? []
  : fx.items.map(({ minutesAgo, ...r }) => ({ ...r, receivedAt: new Date(NOW - minutesAgo * 60_000).toISOString() }))
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
const doFetch = async (path: string, init?: RequestInit) => {
  const u = new URL(path, location.origin)
  if (u.pathname === "/iris/inbox") return json({ measured: true, unread: items.filter((r) => !r.read).length, items })
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
        status: r.type === "job" ? "completed" : undefined,
        item: r.type === "job" ? "atlas:item:5501" : undefined,
        result: r.type === "job" ? "Updated 4 cards, moved 1 to Done.\nexit 0" : undefined,
      },
    })
  }
  return json({ measured: false, reason: "unexpected " + path })
}

const root = document.getElementById("root")!
root.style.cssText = "width:720px;height:640px;display:flex;flex-direction:column;border-right:1px solid #8884"
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
