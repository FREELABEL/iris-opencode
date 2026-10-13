import { render } from "solid-js/web"
import "@/index.css"
import { IrisPulseContact, IrisPulseTopic } from "@/components/session/iris-pulse"
import fixture from "./pulse-fixture.json"

/**
 * The REAL Pulse panes (#189286) over a fixture captured from the sidecar on 2026-10-13 — counts,
 * stops, provenance and dates are real; names and item text are replaced. `?route=topic|contact`,
 * `?scheme=light|dark`, `?state=loading|empty`.
 */
const q = new URLSearchParams(location.search)
const route = q.get("route") ?? "topic"
const state = q.get("state")
document.documentElement.style.colorScheme = q.get("scheme") ?? "dark"
document.documentElement.dataset.theme = q.get("scheme") ?? "dark"
localStorage.removeItem("iris.pulse.topic")
localStorage.removeItem("iris.pulse.contact")
if (state !== "empty") {
  localStorage.setItem("iris.pulse.topic", "heartbeat")
  localStorage.setItem("iris.pulse.contact", "4242")
}
const json = (body: unknown, ms = 0) =>
  new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })), ms))
const doFetch = (path: string) => {
  const p = new URL(path, "http://x").pathname
  const slow = state === "loading" ? 1e9 : 0
  if (p === "/iris/pulse/topic") return json(fixture.topic, slow)
  if (p === "/iris/pulse/contacts") return json({ measured: true, data: [fixture.contact.data!.lead] })
  if (p.startsWith("/iris/pulse/contacts/")) return json(fixture.contact, slow)
  return json({ measured: false, reason: "unexpected " + p, data: null })
}
const now = () => Date.parse("2026-10-13T06:30:00Z")
const root = document.getElementById("root")!
render(
  () =>
    route === "contact" ? <IrisPulseContact doFetch={doFetch} now={now} /> : <IrisPulseTopic doFetch={doFetch} now={now} project="/Users/you/work" />,
  root,
)
// The topic pane waits for "Drive the route" — press it, as a person would.
if (route === "topic" && state !== "empty") setTimeout(() => (document.querySelector(".pls-query button[type=submit]") as HTMLButtonElement)?.click(), 50)
