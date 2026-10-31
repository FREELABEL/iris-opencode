import { expect, test, type Page, type Route } from "@playwright/test"
import { mkdirSync } from "node:fs"

/**
 * Agents › New agent / Edit agent (#191840) — the ELON SimpleAgentModal port, end to end.
 *
 * Real app, real sidecar (a compiled `iris serve`), but every /iris/bloqs, /iris/agents and
 * /iris/agent-editor call is answered HERE: this suite creates and edits agents, and it must
 * never create one on a real account. The fake keeps state, so "created → appears in the list"
 * and "edit tools → saved" are checked against what the editor actually sent.
 *
 *   iris serve --port 4098 (compiled, see the iris-os-dev playbook)
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:4098 IRIS_E2E_DIR=<dir> bunx playwright test e2e/iris/agent-editor
 *
 * Screenshots of every phase-1 step, light and dark: e2e/test-results/agent-editor/.
 */

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
const SHOTS = process.env.IAE_SHOTS ?? "e2e/test-results/agent-editor"

const BOARD = { id: 501, name: "Demo — Client Ops" }
const BOARDS = [BOARD, { id: 502, name: "Demo — Research" }]

const MODELS = [
  { id: "iris/iris-ai", name: "IRIS AI", reasoning: false, toolCalling: true, context: 128000 },
  { id: "iris/kimi-k2.6", name: "Kimi K2.6", reasoning: true, toolCalling: true, context: 262144 },
  { id: "iris/deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, toolCalling: true, context: 131072 },
  { id: "iris/glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false, toolCalling: true, context: 131072 },
  { id: "iris/minimax-m3", name: "MiniMax M3", reasoning: true, toolCalling: true, context: 204800 },
  { id: "iris/qwen3.8-flash", name: "Qwen3.8 Flash", reasoning: false, toolCalling: true, context: 131072 },
]

/** fl-iris-api #253's shape. Synthetic tools — this repo is public. */
const t = (id: string, name: string, group: string, effect: string, description: string, extra: Record<string, unknown> = {}) => ({
  id,
  aliases: [],
  name,
  group,
  description,
  effect,
  effects: [effect],
  functions: [],
  source: "system",
  needs_approval: effect === "payment" || effect === "egress" || effect === "shared_overwrite",
  approval: effect === "payment" ? "held" : effect === "egress" || effect === "shared_overwrite" ? "planned" : null,
  is_default: false,
  always_on: false,
  ...extra,
})
const CATALOG = {
  version: 1,
  effects: [
    { id: "read", rank: 0, label: "Reads only", description: "Looks things up. Changes nothing and contacts nobody." },
    { id: "own_write", rank: 1, label: "Changes your workspace", description: "" },
    { id: "shared_write", rank: 3, label: "Adds to shared data", description: "" },
    { id: "shared_overwrite", rank: 4, label: "Changes shared data", description: "" },
    { id: "egress", rank: 5, label: "Sends or publishes", description: "" },
    { id: "payment", rank: 6, label: "Moves money", description: "" },
    { id: "unclassified", rank: 2, label: "Unclassified", description: "" },
  ],
  approval: { held: ["payment"], planned: ["egress", "shared_overwrite"] },
  trust_levels: { intern: ["own_write", "shared_write", "shared_overwrite", "egress", "payment"], specialist: ["shared_write", "shared_overwrite", "egress", "payment"], lead: ["payment"] },
  groups: [
    { id: "research", name: "Research", description: "" },
    { id: "knowledge", name: "Knowledge", description: "" },
    { id: "content", name: "Content", description: "" },
    { id: "built_in", name: "Built in", description: "" },
    { id: "business", name: "Business", description: "" },
  ],
  defaults: ["agent_memory", "knowledge_base", "executeWebSearch"],
  always_on: ["agent_memory", "environmentAwareness"],
  tools: [
    t("executeWebSearch", "Web search", "research", "read", "Search the web for current information.", { aliases: ["websearchtool"], is_default: true }),
    t("searchNews", "News search", "research", "read", "Recent news articles on a topic."),
    t("scrapeWebPage", "Read a web page", "research", "read", "Fetch one page and read its text."),
    t("knowledge_base", "Knowledge base", "knowledge", "read", "Search the board's own knowledge.", { aliases: ["searchknowledgebasetool"], is_default: true }),
    t("agent_memory", "Agent memory", "built_in", "own_write", "Remember and recall notes across runs.", { is_default: true, always_on: true }),
    t("manageBoards", "Boards", "content", "own_write", "Create and update cards on your boards."),
    t("upsertDatasetRecords", "Dataset upsert", "content", "shared_overwrite", "Write rows into a shared dataset, replacing matches."),
    t("SendEmailTool", "Send email", "built_in", "egress", "Send an email to a person.", { aliases: ["sendemail", "send_email"] }),
    t("makeBloqItemPublic", "Publish a card", "content", "egress", "Give a card a public link."),
    t("delegate_to_agent", "Delegate to agent", "built_in", "shared_write", "Hand a task to another agent."),
    t("marketplacePurchase", "Marketplace purchase", "business", "payment", "Buy a listing on the marketplace."),
    t("searchMarketplace", "Marketplace search", "business", "read", "Find listings on the marketplace."),
  ],
  integrations: [
    { id: "gmail", name: "Gmail", description: "Mail", effect: "egress", effects: ["read", "egress"], functions: [], granted_via: "integrations", needs_approval: true, approval: "planned" },
    { id: "slack", name: "Slack", description: "Chat", effect: "egress", effects: ["read", "egress"], functions: [], granted_via: "integrations", needs_approval: true, approval: "planned" },
  ],
}

type Call = { path: string; method: string; body: any }

function fakeBackend() {
  const calls: Call[] = []
  let nextId = 9100
  const records = new Map<number, any>([
    [
      9001,
      {
        id: 9001,
        name: "Inbox Triage",
        type: "support",
        description: "Sorts the shared inbox and drafts replies.",
        personality_traits: "Warm, brief, never promises dates.",
        initial_prompt: "Each run: read new mail, label it, draft replies for anything a person must answer.",
        bloq_id: BOARD.id,
        heartbeat_mode: "passive",
        config: { model: "iris/kimi-k2.6", temperature: 0.3, maxTokens: 2048, tools: ["agent_memory", "knowledge_base", "websearchtool", "SendEmailTool"], policy: { require_approval: ["sendemailtool"], max_calls_per_day: { sendemailtool: 20 }, quiet_hours: { start: "22:00", end: "07:00", timezone: "America/Chicago" } } },
        settings: { isHuman: false, heartbeat_frequency: "every_30_minutes", heartbeat_working_days: ["mon", "tue", "wed", "thu", "fri"] },
        file_attachments: [{ type: "memory" }, { type: "memory" }, { type: "pdf" }],
      },
    ],
  ])
  const row = (r: any) => ({ id: r.id, name: r.name, status: "healthy", heartbeat: r.heartbeat_mode && r.heartbeat_mode !== "off", schedule: r.heartbeat_mode && r.heartbeat_mode !== "off" ? "30m" : undefined, description: r.description })
  const alerts = {
    project: { emails: ["ops@example.com"] },
    user: { min_severity: "minor" },
    effective: { channels: null, min_severity: "minor", platform_notices: "affected", emails: ["ops@example.com"], user_ids: [] },
    effective_channels: { minor: ["database"], major: ["database"], critical: ["database", "email"] },
    defaults: { channels: null, min_severity: "major", platform_notices: "affected", emails: [], user_ids: [] },
  }
  const ok = (route: Route, data: unknown) => route.fulfill({ json: { ok: true, status: 200, data } })

  async function handle(route: Route) {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    const body = req.postDataJSON?.() ?? null
    if (path.startsWith("/iris/agent-editor")) calls.push({ path, method, body })

    if (path === "/iris/bloqs") return route.fulfill({ json: { measured: true, page: 1, perPage: 200, total: BOARDS.length, totalIsExact: true, hasMore: false, bloqs: BOARDS } })
    if (/^\/iris\/agents\/\d+$/.test(path)) {
      const list = [...records.values()].filter((r) => r.bloq_id === Number(path.split("/").pop())).map(row)
      return route.fulfill({ json: { measured: true, page: 1, perPage: 50, total: list.length, totalIsExact: true, hasMore: false, agents: list } })
    }
    if (path === "/iris/agent-editor/tool-catalog") return ok(route, { available: true, catalog: CATALOG })
    if (path === "/iris/agent-editor/models") return ok(route, { models: MODELS })
    if (path === "/iris/agent-editor/alerts") return ok(route, alerts)
    if (path === "/iris/agent-editor/alerts/save") return ok(route, alerts)
    if (path === "/iris/agent-editor/save") {
      if (body.agentID) {
        const r = records.get(body.agentID)
        Object.assign(r, body.body)
        if (body.configPatch) r.config = { ...r.config, ...body.configPatch }
        return ok(route, r)
      }
      const id = nextId++
      records.set(id, { id, ...body.body, settings: body.body.settings ?? {}, heartbeat_mode: "off" })
      return route.fulfill({ json: { ok: true, status: 201, data: { id, name: body.body.name } } })
    }
    const m = path.match(/^\/iris\/agent-editor\/agent\/(\d+)(\/.*)?$/)
    if (m) {
      const r = records.get(Number(m[1]))
      const rest = m[2] ?? ""
      if (rest === "") return ok(route, r)
      if (rest === "/policy") return ok(route, { agent_id: r.id, policy: r.config?.policy ?? null, autonomy: { level: null, set: false, recognised: false, holds: ["payment"], meaning: "no trust level — holds payments for approval" }, recent_refusals: [] })
      if (rest === "/policy/save") {
        r.config = { ...r.config, policy: body.policy }
        return ok(route, { ok: true, policy: body.policy })
      }
      if (rest === "/tools/save") {
        r.config = { ...r.config, tools: body.tools }
        return ok(route, { ok: true, agent_id: r.id, state: "scoped", tools: body.tools, resolved: body.tools, unknown: [] })
      }
      if (rest === "/heartbeat") {
        r.heartbeat_mode = body.body.mode
        return ok(route, { success: true })
      }
    }
    return route.fallback()
  }
  return { calls, records, handle }
}

async function open(page: Page, backend: ReturnType<typeof fakeBackend>, sessionID: string) {
  await page.route(/\/iris\/(bloqs|agents\/\d+|agent-editor)/, (r) => backend.handle(r))
  await page.addInitScript(
    ([dir, board]) => {
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [], projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir }, recentlyClosed: {} }))
      localStorage.setItem("iris.panel.surface", "agents")
      localStorage.setItem("iris.panel.bloq", String(board))
      localStorage.removeItem("iris.panel.subviews")
    },
    [directory, BOARD.id] as const,
  )
  await page.goto(`/${btoa(directory)}/session/${sessionID}`)
  await page.waitForLoadState("domcontentloaded")
  // The side panel opens on its own with the last product; Agents is one of its product tabs.
  const agents = page.getByRole("tab", { name: "Agents", exact: true })
  const toggle = page.getByRole("button", { name: "Toggle review" })
  await expect(agents.or(toggle)).toBeVisible({ timeout: 30_000 })
  if (!(await agents.isVisible())) await toggle.click()
  await expect(agents).toBeVisible({ timeout: 30_000 })
  await agents.click()
  await expect(agents).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "All", exact: true }).click()
  await expect(page.getByTestId("iris-agent-new")).toBeVisible({ timeout: 30_000 })
}

async function session(page: Page): Promise<string> {
  if (process.env.IRIS_E2E_SESSION) return process.env.IRIS_E2E_SESSION
  const res = await page.request.post(`/session?directory=${encodeURIComponent(directory)}`, { data: {} })
  return (await res.json()).id
}

// This machine's Playwright browser build may not match the resolved Playwright; IAE_CHROME points at one.
test.use({ launchOptions: process.env.IAE_CHROME ? { executablePath: process.env.IAE_CHROME } : {} })

const editor = (page: Page) => page.getByTestId("iris-agent-editor")
const stepTab = (page: Page, label: string) => editor(page).getByRole("tab", { name: new RegExp(`^${label}`) })

test.describe("agents › new agent / edit agent (#191840)", () => {
  test.setTimeout(180_000)
  test.use({ viewport: { width: 1600, height: 1000 } })

  test("New agent → Personality → Tools → Create → it is in the list, with an explicit tool list", async ({ page }) => {
    const backend = fakeBackend()
    await open(page, backend, await session(page))
    await page.getByTestId("iris-agent-new").click()
    await expect(editor(page)).toHaveAttribute("data-mode", "create")

    await page.getByTestId("iris-agent-name").fill("Bid Desk")
    await page.getByTestId("iris-agent-personality").fill("Careful. Cites the board.")
    await page.getByTestId("iris-agent-instructions").fill("Each run: read the pipeline and report the blocking gap.")
    await expect(stepTab(page, "Personality")).toContainText("✓")

    await stepTab(page, "Tools").click()
    // P2: a new agent starts with the read-only defaults CHECKED.
    for (const id of ["executeWebSearch", "knowledge_base", "agent_memory"])
      await expect(editor(page).locator(`[data-tool="${id}"] input`)).toBeChecked()
    await expect(editor(page).locator(`[data-tool="SendEmailTool"] input`)).not.toBeChecked()
    await expect(editor(page).locator(`[data-tool="SendEmailTool"] .iae-approval`)).toHaveText("Will need approval")
    await editor(page).locator(`[data-tool="SendEmailTool"] input`).check()

    await page.getByTestId("iris-agent-save-all").click()
    await expect(editor(page)).toHaveAttribute("data-mode", "edit", { timeout: 15_000 })

    const create = backend.calls.find((c) => c.path === "/iris/agent-editor/save" && !c.body.agentID)!
    expect(create.body.body).toMatchObject({ name: "Bid Desk", bloq_id: BOARD.id, personality_traits: "Careful. Cites the board." })
    expect(create.body.body.config.tools).toEqual(["agent_memory", "knowledge_base", "executeWebSearch", "SendEmailTool"])
    expect(create.body.body.config.model).toBe("iris/iris-ai")
    expect(backend.calls.some((c) => /\/tools\/save$/.test(c.path))).toBe(true)

    await editor(page).getByRole("button", { name: "Close" }).click()
    await expect(page.locator('[data-testid="iris-agent-row"]', { hasText: "Bid Desk" })).toBeVisible({ timeout: 15_000 })
  })

  test("edit → change tools → saved through /tools; Personality never sends config", async ({ page }) => {
    const backend = fakeBackend()
    await open(page, backend, await session(page))
    await page.locator('[data-testid="iris-agent-row"][data-agent-id="9001"]').click()
    await expect(editor(page)).toHaveAttribute("data-mode", "edit")
    await expect(page.getByTestId("iris-agent-name")).toHaveValue("Inbox Triage")

    await stepTab(page, "Tools").click()
    await expect(editor(page).locator(`[data-tool="executeWebSearch"] input`)).toBeChecked()
    await editor(page).locator(`[data-tool="executeWebSearch"] input`).uncheck()
    await page.getByTestId("iris-agent-save-step").click()
    await expect(page.getByTestId("iris-agent-note")).toHaveText("Saved.")
    const save = backend.calls.filter((c) => /\/agent\/9001\/tools\/save$/.test(c.path)).at(-1)!
    expect(save.body.tools).toEqual(["agent_memory", "knowledge_base", "SendEmailTool"])
    expect(backend.records.get(9001).config.policy.require_approval).toEqual(["sendemailtool"])

    await stepTab(page, "Personality").click()
    await page.getByTestId("iris-agent-name").fill("Inbox Triage 2")
    await page.getByTestId("iris-agent-save-step").click()
    await expect(page.getByTestId("iris-agent-note")).toHaveText("Saved.")
    const personality = backend.calls.filter((c) => c.path === "/iris/agent-editor/save").at(-1)!
    expect(personality.body.agentID).toBe(9001)
    expect(personality.body.body.config).toBeUndefined()
    expect(personality.body.configPatch).toBeUndefined()
    // the tools and the policy saved a moment ago are still there
    expect(backend.records.get(9001).config.tools).toEqual(["agent_memory", "knowledge_base", "SendEmailTool"])
    expect(backend.records.get(9001).config.policy.max_calls_per_day).toEqual({ sendemailtool: 20 })
  })

  for (const scheme of ["light", "dark"] as const) {
    test(`screenshots of every phase-1 step (${scheme})`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true })
      await page.emulateMedia({ colorScheme: scheme })
      const backend = fakeBackend()
      await open(page, backend, await session(page))
      await page.screenshot({ path: `${SHOTS}/${scheme}-0-agents-list.png` })
      await page.getByTestId("iris-agent-new").click()
      await page.getByTestId("iris-agent-name").fill("Bid Desk")
      await editor(page).screenshot({ path: `${SHOTS}/${scheme}-1-new-agent.png` })
      await editor(page).getByRole("button", { name: "Close" }).click()

      await page.locator('[data-testid="iris-agent-row"][data-agent-id="9001"]').click()
      await expect(page.getByTestId("iris-agent-name")).toHaveValue("Inbox Triage")
      const steps: [string, string][] = [
        ["Personality", "basic"],
        ["Model", "model"],
        ["Tools", "tools"],
        ["Rules & approvals", "rules"],
        ["Schedule", "schedule"],
        ["Memory & files", "memory"],
        ["Alerts", "alerts"],
        ["Voice", "voice"],
      ]
      for (const [i, [label, id]] of steps.entries()) {
        await stepTab(page, label).click()
        await expect(page.getByTestId(`iris-agent-step-${id}`)).toBeVisible()
        await expect(stepTab(page, label)).toHaveAttribute("aria-selected", "true")
        await editor(page).screenshot({ path: `${SHOTS}/${scheme}-${i + 2}-${id}.png` })
      }
    })
  }
})
