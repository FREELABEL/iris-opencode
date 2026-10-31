import { describe, expect, test } from "bun:test"
import {
  FALLBACK_CATALOG,
  STEPS,
  addToList,
  alertSources,
  alertsChanges,
  alertsForm,
  alertValue,
  approvalBadge,
  attachmentCounts,
  createBody,
  defaultTools,
  draftFromAgent,
  effectSummary,
  emptyDraft,
  groupTools,
  heartbeatBody,
  isDirty,
  isOffered,
  modelPatch,
  policyDraft,
  policyPayload,
  readCatalog,
  riskyTools,
  saveCalls,
  shortDays,
  stepComplete,
  stepErrors,
  toggleTool,
  toolFor,
  unknownEntries,
  visibleSteps,
} from "./iris-agent-editor-model"

/** fl-iris-api #253's shape, cut down to what the editor reads. Synthetic — this repo is public. */
const RAW = {
  version: 1,
  effects: [
    { id: "read", rank: 0, label: "Reads only", description: "Looks things up." },
    { id: "egress", rank: 5, label: "Sends or publishes", description: "Leaves the workspace." },
    { id: "payment", rank: 6, label: "Moves money", description: "Money moves." },
  ],
  approval: { held: ["payment"], planned: ["egress", "shared_overwrite"] },
  trust_levels: { intern: ["own_write", "shared_write", "shared_overwrite", "egress", "payment"], lead: ["payment"] },
  groups: [
    { id: "research", name: "Research", description: "" },
    { id: "business", name: "Business", description: "" },
    { id: "built_in", name: "Built in", description: "" },
    { id: "knowledge", name: "Knowledge", description: "" },
  ],
  defaults: ["agent_memory", "knowledge_base", "executeWebSearch"],
  always_on: ["agent_memory", "environmentAwareness"],
  tools: [
    { id: "executeWebSearch", aliases: ["websearchtool"], name: "Web Search", group: "research", effect: "read", approval: null, is_default: true },
    { id: "knowledge_base", aliases: ["searchknowledgebasetool"], name: "Knowledge base", group: "knowledge", effect: "read", is_default: true },
    { id: "agent_memory", aliases: [], name: "Agent memory", group: "built_in", effect: "own_write", always_on: true },
    { id: "SendEmailTool", aliases: ["sendemail", "send_email"], name: "Send email", group: "built_in", effect: "egress", needs_approval: true, approval: "planned" },
    { id: "marketplacePurchase", aliases: [], name: "Marketplace purchase", group: "business", effect: "payment", needs_approval: true, approval: "held" },
    { id: "hiveBrowserUse", aliases: [], name: "Browser", group: "browser_automation", effect: "egress", approval: "planned" },
    { id: "weird", name: "Weird", group: "research", effect: "teleport" },
  ],
  integrations: [{ id: "gmail", name: "Gmail", description: "Mail", effect: "egress", granted_via: "integrations" }],
}
const catalog = readCatalog({ available: true, catalog: RAW })
const models = [{ id: "iris/kimi-k2.6", name: "Kimi K2.6", reasoning: true, toolCalling: true, context: 262144 }]

/** An agent as fl-api returns it (shape of a real row, values invented). */
const AGENT = {
  id: 77,
  name: "Bid Desk",
  type: "assistant",
  description: "First-pass analyst",
  initial_prompt: "Each run: read the pipeline.",
  personality_traits: "Careful.",
  bloq_id: 839,
  heartbeat_mode: "passive",
  config: {
    model: "gpt-4o-mini",
    tools: ["manageboardstool", "websearchtool"],
    autonomy: "specialist",
    system_prompt: "You are the advisor.",
    policy: { denied_tools: ["publish_*"], max_calls_per_day: { send_email: 20 }, quiet_hours: { start: "22:00", end: "07:00" } },
    provider: "openrouter",
    apiKey: "sk-x",
  },
  settings: { isHuman: false, heartbeat_frequency: "every_4_hours", heartbeat_working_days: ["mon", "wed"], useKnowledgeBase: false },
  file_attachments: [{ type: "memory" }, { type: "memory" }, { type: "pdf" }],
}

describe("agent editor: steps (ELON SimpleAgentModal port, #191840)", () => {
  test("every ELON step is mapped; Capabilities became Tools", () => {
    expect(STEPS.map((s) => s.elon)).toContain("capabilities")
    expect(STEPS.find((s) => s.elon === "capabilities")!.id).toBe("tools")
    for (const e of ["basic", "model", "voice", "capabilities", "schedule", "prompts", "api-public", "channels", "monetization"])
      expect(STEPS.some((s) => s.elon.includes(e))).toBe(true)
    expect(STEPS.filter((s) => s.phase === 1).map((s) => s.id)).toEqual(["basic", "model", "tools", "rules", "schedule", "memory", "alerts"])
  })
  test("a human team member does not get model, tools, rules or schedule — as in ELON", () => {
    expect(visibleSteps(true).map((s) => s.id)).not.toContain("model")
    expect(visibleSteps(true).map((s) => s.id)).not.toContain("tools")
    expect(visibleSteps(true).map((s) => s.id)).not.toContain("schedule")
    expect(visibleSteps(false).map((s) => s.id)).toContain("tools")
  })
})

describe("agent editor: tool catalogue", () => {
  test("reads #253's shape; an unknown effect is unclassified, never read", () => {
    expect(catalog.available).toBe(true)
    expect(toolFor(catalog, "weird")!.effect).toBe("unclassified")
    expect(catalog.integrations[0]).toMatchObject({ id: "gmail", effect: "egress" })
    expect(catalog.trustLevels.lead).toEqual(["payment"])
  })
  test("no catalogue (404) → the read-only default set fl-api writes today", () => {
    const c = readCatalog({ available: false, catalog: null })
    expect(c).toBe(FALLBACK_CATALOG)
    expect(defaultTools(c)).toEqual(["agent_memory", "searchknowledgebasetool", "websearchtool"])
    expect(c.tools.every((t) => t.effect === "read" || t.effect === "own_write")).toBe(true)
  })
  test("a new agent starts with the defaults CHECKED — never an absent list (P2)", () => {
    const d = emptyDraft(12, catalog)
    expect(d.tools).toEqual(["agent_memory", "knowledge_base", "executeWebSearch"])
    expect(createBody(d).config).toMatchObject({ tools: ["agent_memory", "knowledge_base", "executeWebSearch"] })
    expect(createBody({ ...emptyDraft(12, FALLBACK_CATALOG), tools: [] }).config).toMatchObject({ tools: [] })
  })
  test("an allowlist entry matches by id, alias or tool__function, case-insensitively", () => {
    expect(toolFor(catalog, "WEBSEARCHTOOL")!.id).toBe("executeWebSearch")
    expect(toolFor(catalog, "send_email")!.id).toBe("SendEmailTool")
    expect(toolFor(catalog, "hiveBrowserUse__render_check")!.id).toBe("hiveBrowserUse")
    expect(toolFor(catalog, "manageboardstool")).toBeUndefined()
  })
  test("unchecking removes every spelling; unknown entries are kept and listed", () => {
    const sel = ["websearchtool", "manageboardstool", "SendEmailTool"]
    expect(toggleTool(catalog, sel, toolFor(catalog, "executeWebSearch")!, false)).toEqual(["manageboardstool", "SendEmailTool"])
    expect(toggleTool(catalog, sel, toolFor(catalog, "marketplacePurchase")!, true)).toContain("marketplacePurchase")
    expect(unknownEntries(catalog, sel)).toEqual(["manageboardstool"])
  })
  test("approval badges: held = Needs approval, planned = Will need approval, a trust level wins", () => {
    expect(approvalBadge(catalog, toolFor(catalog, "marketplacePurchase")!)).toEqual({ kind: "held", label: "Needs approval" })
    expect(approvalBadge(catalog, toolFor(catalog, "SendEmailTool")!)).toEqual({ kind: "planned", label: "Will need approval" })
    expect(approvalBadge(catalog, toolFor(catalog, "executeWebSearch")!)).toBeNull()
    expect(approvalBadge(catalog, toolFor(catalog, "SendEmailTool")!, "lead")).toBeNull()
    expect(approvalBadge(catalog, toolFor(catalog, "SendEmailTool")!, "intern")).toEqual({ kind: "held", label: "Needs approval (intern)" })
  })
  test("groups keep catalogue order with client-specific Business last; search narrows", () => {
    expect(groupTools(catalog).map((g) => g.id)).toEqual(["research", "built_in", "knowledge", "browser_automation", "business"])
    expect(groupTools(catalog, "email").flatMap((g) => g.tools.map((t) => t.id))).toEqual(["SendEmailTool"])
  })
  test("the effect summary counts each tool once", () => {
    expect(effectSummary(catalog, ["websearchtool", "executeWebSearch", "send_email", "marketplacePurchase"])).toEqual([
      { effect: "read", count: 1 },
      { effect: "egress", count: 1 },
      { effect: "payment", count: 1 },
    ])
  })
})

describe("agent editor: reading an agent", () => {
  const d = draftFromAgent(AGENT, catalog)
  test("every phase-1 field comes from where fl-api stores it", () => {
    expect(d).toMatchObject({
      name: "Bid Desk",
      personality: "Careful.",
      instructions: "Each run: read the pipeline.",
      systemPrompt: "You are the advisor.",
      model: "gpt-4o-mini",
      tools: ["manageboardstool", "websearchtool"],
      toolsLegacy: false,
      bloqId: 839,
      useKnowledgeBase: false,
      heartbeat: { mode: "passive", frequency: "every_4_hours", workingDays: ["mon", "wed"] },
    })
    expect(d.policy.denied).toBe("publish_*")
    expect(d.policy.caps).toBe("send_email: 20")
    expect(attachmentCounts(AGENT)).toEqual({ files: 1, memory: 2 })
  })
  test("an agent never given a tool list is flagged, not silently given the defaults", () => {
    const legacy = draftFromAgent({ ...AGENT, config: { model: "x" } }, catalog)
    expect(legacy.toolsLegacy).toBe(true)
    expect(stepComplete("tools", legacy, { models })).toBe(false)
    expect(isDirty("tools", legacy, { ...legacy, toolsLegacy: false })).toBe(true)
  })
  test("a model the manifest no longer offers must be re-picked", () => {
    expect(stepErrors("model", d, { models })[0]).toContain("not offered")
    expect(isOffered(models, "kimi-k2.6")).toBe(true)
    expect(stepComplete("model", { ...d, model: "iris/kimi-k2.6" }, { models })).toBe(true)
  })
  test("ELON's long working-day names read as fl-api's short ones", () => {
    expect(shortDays(["monday", "Friday", "mon", "nope"])).toEqual(["mon", "fri"])
  })
})

describe("agent editor: saving never erases what another step owns", () => {
  const d = draftFromAgent(AGENT, catalog)
  test("Personality sends no config; a changed system prompt is a one-key patch", () => {
    const [call] = saveCalls("basic", d, d, AGENT.config)
    expect(call.kind).toBe("agent")
    expect((call as any).body.config).toBeUndefined()
    expect((call as any).configPatch).toBeUndefined()
    const [edited] = saveCalls("basic", { ...d, systemPrompt: "New" }, d, AGENT.config)
    expect((edited as any).configPatch).toEqual({ system_prompt: "New" })
  })
  test("Model is a patch of model keys only — tools, policy and autonomy are not in it", () => {
    const [call] = saveCalls("model", { ...d, model: "iris/kimi-k2.6", responseMode: "precise" }, d, AGENT.config) as any[]
    expect(call.body).toEqual({})
    expect(Object.keys(call.configPatch).sort()).toEqual(["apiKey", "endpoint", "maxTokens", "model", "modelName", "provider", "temperature"])
    expect(call.configPatch).toMatchObject({ model: "iris/kimi-k2.6", temperature: 0.3, provider: null })
    expect(modelPatch(d, { provider: "openai" })).not.toHaveProperty("provider")
  })
  test("Tools go to /tools, Rules to /policy, Schedule to the heartbeat — each alone", () => {
    expect(saveCalls("tools", d, d)).toEqual([{ kind: "tools", tools: ["manageboardstool", "websearchtool"] }])
    expect(saveCalls("rules", d, d)[0]).toMatchObject({ kind: "policy", policy: { denied_tools: ["publish_*"] } })
    expect(saveCalls("schedule", d, d)).toEqual([{ kind: "heartbeat", body: heartbeatBody(d) }])
    expect(heartbeatBody(d)).toEqual({ mode: "passive", frequency: "every_4_hours", working_days: ["mon", "wed"] })
    expect(saveCalls("memory", d, d)[0]).toMatchObject({ kind: "agent", body: { bloq_id: 839, settings: { useKnowledgeBase: false } } })
  })
  test("dirty is per step", () => {
    expect(isDirty("basic", { ...d, name: "X" }, d)).toBe(true)
    expect(isDirty("tools", { ...d, name: "X" }, d)).toBe(false)
    expect(isDirty("tools", { ...d, tools: ["websearchtool", "manageboardstool"] }, d)).toBe(false)
  })
})

describe("agent editor: rules & approvals", () => {
  test("the form round-trips iris-api's policy", () => {
    const p = { denied_tools: ["publish_*"], require_approval: ["send_email"], max_calls_per_day: { send_email: 20 }, spend_cap_per_day: 50, quiet_hours: { start: "22:00", end: "07:00", timezone: "America/Chicago" }, timezone: "America/Chicago" }
    expect(policyPayload(policyDraft(p))).toEqual({ policy: p, errors: [] })
    expect(policyPayload(policyDraft(null))).toEqual({ policy: null, errors: [] })
  })
  test("bad input is refused before it reaches the server", () => {
    const e = policyPayload({ ...policyDraft(null), caps: "send_email twenty", spendCap: "-1", quietStart: "9" }).errors
    expect(e).toHaveLength(3)
    expect(saveCalls("rules", { ...emptyDraft(1, catalog), policy: { ...policyDraft(null), spendCap: "-1" } }, null)).toEqual([])
  })
  test("one click asks approval for the selected tools that send or pay", () => {
    const risky = riskyTools(catalog, ["websearchtool", "send_email", "marketplacePurchase"])
    expect(risky).toEqual(["sendemailtool", "marketplacepurchase"])
    expect(addToList("publish_*", risky)).toBe("publish_*, sendemailtool, marketplacepurchase")
  })
})

describe("agent editor: alerts (fl-api #170)", () => {
  const data = {
    project: { emails: ["ops@example.com"] },
    user: { min_severity: "minor", channels: ["email", "database"] },
    effective: { channels: ["email", "database"], min_severity: "minor", platform_notices: "affected", emails: ["ops@example.com"], user_ids: [] },
  }
  test("each value says which level it comes from", () => {
    const s = alertSources(data)
    expect(s.emails.from).toBe("project")
    expect(s.min_severity.from).toBe("account")
    expect(s.platform_notices.from).toBe("default")
    expect(alertValue("channels", s.channels.value)).toBe("email + in-app")
    expect(alertValue("channels", null)).toBe("by severity")
    expect(alertValue("channels", [])).toBe("off")
  })
  test("a level's own keys fill the form; anything it does not set is inherit", () => {
    expect(alertsForm(data, "project")).toEqual({ channels: "inherit", minSeverity: "inherit", platformNotices: "inherit", emails: "ops@example.com", userIds: "" })
    expect(alertsForm(data, "account").channels).toEqual({ email: true, in_app: true, sms: false })
  })
  test("inherit sends null (removes the key), off sends [], contacts are checked", () => {
    expect(alertsChanges(alertsForm(data, "project"))).toEqual({
      changes: { channels: null, min_severity: null, platform_notices: null, emails: ["ops@example.com"], user_ids: null },
      errors: [],
    })
    expect(alertsChanges({ ...alertsForm(data, "project"), channels: "off" }).changes.channels).toEqual([])
    const bad = alertsChanges({ ...alertsForm(data, "project"), emails: "nope", userIds: "x", channels: { email: false, in_app: false, sms: false } })
    expect(bad.errors).toHaveLength(3)
    const many = Array.from({ length: 11 }, (_, i) => `a${i}@example.com`).join(",")
    expect(alertsChanges({ ...alertsForm(data, "project"), emails: many }).errors).toEqual(["At most 10 email contacts."])
  })
})
