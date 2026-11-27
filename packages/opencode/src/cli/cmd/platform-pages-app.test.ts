import { describe, expect, test } from "bun:test"
import { appSlug, buildAppContent, shortLabel } from "./platform-pages-app"

/** #194355 — one command makes an app; these pin what that app is made of. */
describe("iris pages app", () => {
  test("an agents app shows your agents, pauses them, and can change nothing but status", () => {
    const c = buildAppContent("My Command Center", "agents") as any
    expect(c.render_mode).toBe("html")
    expect(c.bindings).toEqual({ agents: "agents:all", beats: "heartbeat:all" })
    expect(c.actions.status).toEqual({ run: "agent-settings:personality", roles: ["admin"], fields: ["status"] })
    expect(c.app).toMatchObject({ name: "My Command Center", short_name: "My Command" })
    expect(c.html).toContain("My Command Center")
    expect(c.html).not.toContain("{{NAME}}")
    expect(c.html).not.toContain("{{WHAT}}")
  })

  test("any dataset or collection becomes a read-only app — no actions it did not ask for", () => {
    const c = buildAppContent("Open Leads", "leads:all", "Deals in one place") as any
    expect(c.bindings).toEqual({ items: "leads:all" })
    expect(c.actions).toBeUndefined()
    expect(c.html).toContain("Deals in one place")
  })

  test("a name cannot inject markup into the page", () => {
    const c = buildAppContent('<img src=x onerror=alert(1)>', "agents") as any
    expect(c.html).not.toContain("<img src=x")
    expect(c.html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  test("slugs are readable and never collide; labels fit under an icon", () => {
    expect(appSlug("Open Leads!", "k3x9")).toBe("open-leads-k3x9")
    expect(appSlug("???", "ab12")).toBe("app-ab12")
    expect(appSlug("Open Leads")).not.toBe(appSlug("Open Leads"))
    expect(shortLabel("Command")).toBe("Command")
    expect(shortLabel("My Command Center").length).toBeLessThanOrEqual(12)
  })
})
