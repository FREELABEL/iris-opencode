/**
 * Agents › New agent / Edit agent (#191840) — the view-model.
 *
 * The Desktop port of ELON's SimpleAgentModal (fl-elon-web-ui components/Profile/Builder/
 * SimpleAgentModal.vue). Its step layout, completion ticks and field logic are kept; the parts
 * that changed are the ones the platform changed under it:
 *
 *  - Capabilities → TOOLS. ELON toggled feature flags (webAccess, canCreateContent…) that the V6
 *    runtime no longer reads. What decides what an agent can touch is `config.tools`, an
 *    allowlist, and each tool's EFFECT (read … payment). New agents start with the default
 *    read-only set CHECKED — never "no list", which used to mean every tool (P2 #191437).
 *  - RULES & APPROVALS and ALERTS are new (fl-iris-api #230, fl-api #170).
 *  - Model offers only what the IRIS model manifest serves (OpenCode Go), like the chat picker.
 *
 * Everything here is pure, so the payloads that reach fl-api / iris-api are tested without a
 * network. The component (iris-agent-editor.tsx) only renders and calls the sidecar.
 */

// ── steps ──────────────────────────────────────────────────────────────────────────────────

export type StepId =
  | "basic"
  | "model"
  | "tools"
  | "rules"
  | "schedule"
  | "memory"
  | "alerts"
  | "voice"
  | "prompts"
  | "public"
  | "channels"
  | "monetization"

export interface Step {
  id: StepId
  label: string
  /** 1 = built in #191840; 2 = listed as a follow-up and shown as "In ELON for now". */
  phase: 1 | 2
  /** ELON hides these for a human team member (model, capabilities, schedule). */
  aiOnly?: boolean
  /** The ELON step this replaces or carries. */
  elon: string
}

export const STEPS: readonly Step[] = [
  { id: "basic", label: "Personality", phase: 1, elon: "basic" },
  { id: "model", label: "Model", phase: 1, aiOnly: true, elon: "model" },
  { id: "tools", label: "Tools", phase: 1, aiOnly: true, elon: "capabilities" },
  { id: "rules", label: "Rules & approvals", phase: 1, aiOnly: true, elon: "— (new)" },
  { id: "schedule", label: "Schedule", phase: 1, aiOnly: true, elon: "schedule" },
  { id: "memory", label: "Memory & files", phase: 1, elon: "files + memory" },
  { id: "alerts", label: "Alerts", phase: 1, elon: "— (new)" },
  { id: "voice", label: "Voice", phase: 2, aiOnly: true, elon: "voice" },
  { id: "prompts", label: "Prompts", phase: 2, elon: "prompts" },
  { id: "public", label: "Public", phase: 2, elon: "api-public" },
  { id: "channels", label: "Channels", phase: 2, elon: "channels" },
  { id: "monetization", label: "Monetization", phase: 2, elon: "monetization" },
]

export function visibleSteps(isHuman: boolean): Step[] {
  return STEPS.filter((s) => !(isHuman && s.aiOnly))
}

// ── tool catalogue ─────────────────────────────────────────────────────────────────────────

export type Effect = "read" | "own_write" | "shared_write" | "shared_overwrite" | "egress" | "payment" | "unclassified"
export type Approval = "held" | "planned" | null

export const EFFECT_ORDER: Effect[] = ["read", "own_write", "unclassified", "shared_write", "shared_overwrite", "egress", "payment"]

/** Used until the catalogue answers (it carries its own labels, which win). */
const EFFECT_LABELS: Record<Effect, string> = {
  read: "Reads only",
  own_write: "Changes your workspace",
  shared_write: "Adds to shared data",
  shared_overwrite: "Changes shared data",
  egress: "Sends or publishes",
  payment: "Moves money",
  unclassified: "Unclassified",
}

export interface CatalogTool {
  id: string
  aliases: string[]
  name: string
  group: string
  description: string
  effect: Effect
  needsApproval: boolean
  approval: Approval
  isDefault: boolean
  alwaysOn: boolean
}

export interface Catalog {
  /** false = iris-api has no /tool-catalog yet; `tools` is the built-in default set only. */
  available: boolean
  tools: CatalogTool[]
  groups: { id: string; name: string; description: string }[]
  effects: { id: Effect; label: string; description: string }[]
  defaults: string[]
  alwaysOn: string[]
  approval: { held: Effect[]; planned: Effect[] }
  trustLevels: Record<string, Effect[]>
  integrations: { id: string; name: string; description: string; effect: Effect }[]
}

const asEffect = (v: unknown): Effect => (EFFECT_ORDER.includes(v as Effect) ? (v as Effect) : "unclassified")
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/**
 * The read-only set fl-api writes onto a new agent today (config/agents.php
 * default_tool_allowlist) — what the editor pre-checks when the catalogue is not deployed yet.
 * Spelled the way fl-api spells it, so the runtime resolves it exactly as it does for every
 * agent created elsewhere.
 */
export const FALLBACK_CATALOG: Catalog = {
  available: false,
  tools: [
    { id: "agent_memory", aliases: [], name: "Agent memory", group: "knowledge", description: "Remember and recall notes across conversations.", effect: "own_write", needsApproval: false, approval: null, isDefault: true, alwaysOn: true },
    { id: "searchknowledgebasetool", aliases: ["knowledge_base"], name: "Knowledge base", group: "knowledge", description: "Search this board's knowledge.", effect: "read", needsApproval: false, approval: null, isDefault: true, alwaysOn: false },
    { id: "websearchtool", aliases: ["executewebsearch"], name: "Web search", group: "research", description: "Search the web.", effect: "read", needsApproval: false, approval: null, isDefault: true, alwaysOn: false },
  ],
  groups: [
    { id: "knowledge", name: "Knowledge", description: "Knowledge base and memory" },
    { id: "research", name: "Research", description: "Search and discovery tools" },
  ],
  effects: EFFECT_ORDER.map((id) => ({ id, label: EFFECT_LABELS[id], description: "" })),
  defaults: ["agent_memory", "searchknowledgebasetool", "websearchtool"],
  alwaysOn: ["agent_memory"],
  approval: { held: ["payment"], planned: ["egress", "shared_overwrite"] },
  trustLevels: {},
  integrations: [],
}

/** fl-iris-api #253's catalogue → the editor's. Unknown effects read as "unclassified". */
export function readCatalog(data: { available?: boolean; catalog?: any } | undefined): Catalog {
  const c = data?.catalog
  if (!data?.available || !c || !Array.isArray(c.tools)) return FALLBACK_CATALOG
  const defaults = strs(c.defaults)
  const alwaysOn = strs(c.always_on)
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()))
  const def = lower(defaults)
  const on = lower(alwaysOn)
  const tools: CatalogTool[] = c.tools
    .filter((t: any) => t && (typeof t.id === "string" || typeof t.name === "string"))
    .map((t: any) => {
      const id = str(t.id) || str(t.name)
      const aliases = strs(t.aliases)
      const names = [id, ...aliases].map((x) => x.toLowerCase())
      return {
        id,
        aliases,
        name: str(t.name, id) || id,
        group: str(t.group, "other") || "other",
        description: str(t.description),
        effect: asEffect(t.effect),
        needsApproval: t.needs_approval === true,
        approval: t.approval === "held" || t.approval === "planned" ? t.approval : null,
        isDefault: t.is_default === true || names.some((n) => def.has(n)),
        alwaysOn: t.always_on === true || names.some((n) => on.has(n)),
      }
    })
  const effects = Array.isArray(c.effects)
    ? c.effects
        .filter((e: any) => typeof e?.id === "string")
        .map((e: any) => ({ id: asEffect(e.id), label: str(e.label, EFFECT_LABELS[asEffect(e.id)]), description: str(e.description) }))
    : FALLBACK_CATALOG.effects
  const trust: Record<string, Effect[]> = {}
  for (const [k, v] of Object.entries(c.trust_levels ?? {})) trust[k] = strs(v).map(asEffect)
  return {
    available: true,
    tools,
    groups: Array.isArray(c.groups)
      ? c.groups.filter((g: any) => typeof g?.id === "string").map((g: any) => ({ id: g.id, name: str(g.name, g.id), description: str(g.description) }))
      : [],
    effects,
    defaults,
    alwaysOn,
    approval: { held: strs(c.approval?.held).map(asEffect), planned: strs(c.approval?.planned).map(asEffect) },
    trustLevels: trust,
    integrations: Array.isArray(c.integrations)
      ? c.integrations
          .filter((i: any) => typeof i?.id === "string")
          .map((i: any) => ({ id: i.id, name: str(i.name, i.id), description: str(i.description), effect: asEffect(i.effect) }))
      : [],
  }
}

/**
 * Which catalogue tool an allowlist entry grants. Case-insensitive, by id or any alias, and
 * `<tool>__<function>` grants that one function of `<tool>` — the same rules iris-api's /tools uses.
 */
export function toolFor(catalog: Catalog, entry: string): CatalogTool | undefined {
  const e = entry.toLowerCase()
  const head = e.includes("__") ? e.slice(0, e.indexOf("__")) : e
  for (const t of catalog.tools) {
    const names = [t.id, ...t.aliases].map((x) => x.toLowerCase())
    if (names.includes(e) || names.includes(head)) return t
  }
  return undefined
}

export const isChecked = (catalog: Catalog, selected: readonly string[], tool: CatalogTool) =>
  selected.some((s) => toolFor(catalog, s)?.id === tool.id)

/** Check or uncheck one tool; unchecking removes every spelling of it (an alias, a function). */
export function toggleTool(catalog: Catalog, selected: readonly string[], tool: CatalogTool, on: boolean): string[] {
  const rest = selected.filter((s) => toolFor(catalog, s)?.id !== tool.id)
  return on ? [...rest, tool.id] : rest
}

/** Allowlist entries no catalogue tool answers to. Kept, shown, never silently dropped. */
export function unknownEntries(catalog: Catalog, selected: readonly string[]): string[] {
  return selected.filter((s) => !toolFor(catalog, s))
}

/** The pre-checked set for a new agent: the catalogue's defaults (always a non-empty list). */
export function defaultTools(catalog: Catalog): string[] {
  const ids = catalog.defaults.length ? catalog.defaults : FALLBACK_CATALOG.defaults
  return ids.map((d) => toolFor(catalog, d)?.id ?? d).filter((v, i, a) => a.indexOf(v) === i)
}

/**
 * The badge a tool's approval wears. "held" — the gate holds it today; "planned" — logged as
 * "would hold", next to be held, so it must NOT claim it needs approval yet. An agent with a
 * trust level (config.autonomy) is held by that level's list instead.
 */
export function approvalBadge(catalog: Catalog, tool: Pick<CatalogTool, "effect" | "approval">, autonomy?: string | null) {
  const level = autonomy ? catalog.trustLevels[autonomy] : undefined
  if (level) return level.includes(tool.effect) ? { kind: "held" as const, label: `Needs approval (${autonomy})` } : null
  const approval = tool.approval ?? (catalog.approval.held.includes(tool.effect) ? "held" : catalog.approval.planned.includes(tool.effect) ? "planned" : null)
  if (approval === "held") return { kind: "held" as const, label: "Needs approval" }
  if (approval === "planned") return { kind: "planned" as const, label: "Will need approval" }
  return null
}

export function effectLabel(catalog: Catalog, effect: Effect): string {
  return catalog.effects.find((e) => e.id === effect)?.label ?? EFFECT_LABELS[effect]
}

/** Groups in catalogue order, each with its tools; "business" (client-specific tools) last, collapsed by the view. */
export function groupTools(catalog: Catalog, query = ""): { id: string; name: string; tools: CatalogTool[] }[] {
  const q = query.trim().toLowerCase()
  const match = (t: CatalogTool) =>
    !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  const order = catalog.groups.map((g) => g.id)
  const ids = [...new Set([...order, ...catalog.tools.map((t) => t.group)])].sort((a, b) => {
    const rank = (x: string) => (x === "business" ? 1e6 : order.indexOf(x) < 0 ? 1e5 : order.indexOf(x))
    return rank(a) - rank(b)
  })
  return ids
    .map((id) => ({
      id,
      name: catalog.groups.find((g) => g.id === id)?.name ?? id.replace(/_/g, " "),
      tools: catalog.tools
        .filter((t) => t.group === id && match(t))
        .sort((a, b) => EFFECT_ORDER.indexOf(a.effect) - EFFECT_ORDER.indexOf(b.effect) || a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.tools.length)
}

/** How many of the selected tools carry each effect — the summary line above the list. */
export function effectSummary(catalog: Catalog, selected: readonly string[]): { effect: Effect; count: number }[] {
  const counts = new Map<Effect, number>()
  const seen = new Set<string>()
  for (const s of selected) {
    const t = toolFor(catalog, s)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    counts.set(t.effect, (counts.get(t.effect) ?? 0) + 1)
  }
  return EFFECT_ORDER.filter((e) => counts.has(e)).map((effect) => ({ effect, count: counts.get(effect)! }))
}

// ── models ─────────────────────────────────────────────────────────────────────────────────

export interface OfferedModel {
  id: string
  name: string
  reasoning: boolean
  toolCalling: boolean
  context: number | null
}

/** ELON's response modes → temperature (getTemperatureFromResponseMode). */
export const RESPONSE_MODES = { creative: 0.9, balanced: 0.7, precise: 0.3, analytical: 0.1 } as const
/** ELON's response lengths → max tokens (getMaxTokensFromLength). */
export const RESPONSE_LENGTHS = { concise: 1024, balanced: 2048, detailed: 4096, comprehensive: 8192 } as const
export type ResponseMode = keyof typeof RESPONSE_MODES
export type ResponseLength = keyof typeof RESPONSE_LENGTHS

const nearest = <K extends string>(map: Record<K, number>, v: unknown, d: K): K => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  if (!Number.isFinite(n)) return d
  return (Object.keys(map) as K[]).reduce((best, k) => (Math.abs(map[k] - n) < Math.abs(map[best] - n) ? k : best), d)
}

/** Is this the model the agent has, in either spelling (`iris/kimi-k2.6` or `kimi-k2.6`)? */
export function sameModel(a: string, b: string): boolean {
  const n = (x: string) => x.replace(/^iris\//, "").toLowerCase()
  return !!a && !!b && n(a) === n(b)
}

export const isOffered = (models: readonly OfferedModel[], id: string) => models.some((m) => sameModel(m.id, id))

// ── heartbeat (Schedule) ───────────────────────────────────────────────────────────────────

export const HEARTBEAT_MODES = [
  { id: "off", label: "Off", hint: "Runs only when someone asks it." },
  { id: "passive", label: "Passive", hint: "Wakes on its cadence, reads the board, writes a diary entry." },
  { id: "reactive", label: "Reactive", hint: "Wakes when something on the board changes." },
  { id: "autonomous", label: "Autonomous", hint: "Wakes on its cadence and acts on what it finds." },
  { id: "briefing", label: "Briefing", hint: "One briefing a day at a set time." },
] as const
export type HeartbeatMode = (typeof HEARTBEAT_MODES)[number]["id"]

export const FREQUENCIES = [
  { id: "every_15_minutes", label: "Every 15 minutes" },
  { id: "every_30_minutes", label: "Every 30 minutes" },
  { id: "hourly", label: "Hourly" },
  { id: "every_2_hours", label: "Every 2 hours" },
  { id: "every_4_hours", label: "Every 4 hours" },
  { id: "every_8_hours", label: "Every 8 hours" },
  { id: "every_12_hours", label: "Every 12 hours" },
  { id: "daily", label: "Daily" },
] as const

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
const LONG_DAYS: Record<string, string> = { monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat", sunday: "sun" }

/** fl-api's working_days are short; ELON's schedule tab stored long names. Read either. */
export function shortDays(v: unknown): string[] {
  return strs(v)
    .map((d) => LONG_DAYS[d.toLowerCase()] ?? d.toLowerCase())
    .filter((d, i, a) => (DAYS as readonly string[]).includes(d) && a.indexOf(d) === i)
    .sort((a, b) => DAYS.indexOf(a as any) - DAYS.indexOf(b as any))
}

// ── the draft ──────────────────────────────────────────────────────────────────────────────

export const AGENT_TYPES = [
  { id: "assistant", label: "Assistant" },
  { id: "content", label: "Content creator" },
  { id: "marketing", label: "Marketing" },
  { id: "support", label: "Customer support" },
  { id: "research", label: "Research" },
  { id: "analysis", label: "Data analyst" },
  { id: "sales", label: "Sales" },
  { id: "operations", label: "Operations" },
] as const

export interface PolicyDraft {
  denied: string
  allowed: string
  requireApproval: string
  preApproved: string
  /** One per line: `pattern: calls per day`. */
  caps: string
  spendCap: string
  quietStart: string
  quietEnd: string
  quietTimezone: string
  timezone: string
}

export interface Draft {
  isHuman: boolean
  name: string
  type: string
  description: string
  role: string
  /** personality_traits — ELON's Personality box. */
  personality: string
  /** initial_prompt — what it does each time it runs. */
  instructions: string
  /** config.system_prompt — set by the CLI/agents API; shown so it is never invisible. */
  systemPrompt: string
  email: string
  phone: string
  model: string
  responseMode: ResponseMode
  responseLength: ResponseLength
  /** The allowlist. `toolsLegacy` = the agent was never given one (null config.tools). */
  tools: string[]
  toolsLegacy: boolean
  policy: PolicyDraft
  heartbeat: { mode: HeartbeatMode; frequency: string; workingDays: string[]; briefingTime: string }
  /** bloq_id — the agent's board, which is also its knowledge base (RAG). */
  bloqId: number | null
  useKnowledgeBase: boolean
  memoryPersistence: boolean
}

export const emptyPolicy = (): PolicyDraft => ({
  denied: "",
  allowed: "",
  requireApproval: "",
  preApproved: "",
  caps: "",
  spendCap: "",
  quietStart: "",
  quietEnd: "",
  quietTimezone: "",
  timezone: "",
})

export function emptyDraft(bloqId: number | null, catalog: Catalog, model = ""): Draft {
  return {
    isHuman: false,
    name: "",
    type: "assistant",
    description: "",
    role: "",
    personality: "",
    instructions: "",
    systemPrompt: "",
    email: "",
    phone: "",
    model,
    responseMode: "balanced",
    responseLength: "balanced",
    tools: defaultTools(catalog),
    toolsLegacy: false,
    policy: emptyPolicy(),
    heartbeat: { mode: "off", frequency: "every_30_minutes", workingDays: ["mon", "tue", "wed", "thu", "fri"], briefingTime: "08:00" },
    bloqId,
    useKnowledgeBase: true,
    memoryPersistence: true,
  }
}

const obj = (v: unknown): Record<string, any> => {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {}
}

export const agentConfig = (raw: any) => obj(raw?.config)
export const agentSettings = (raw: any) => obj(raw?.settings)
export const agentAutonomy = (raw: any): string | null => str(agentConfig(raw).autonomy) || null

/** An agent as fl-api returns it → the editor's draft. */
export function draftFromAgent(raw: any, catalog: Catalog): Draft {
  const config = agentConfig(raw)
  const settings = agentSettings(raw)
  const human = settings.isHuman === true || settings.isHuman === "true" || raw?.type === "human"
  const declared = Array.isArray(config.tools) ? strs(config.tools) : null
  const days = shortDays(settings.heartbeat_working_days ?? settings.schedule?.working_days)
  return {
    isHuman: human,
    name: str(raw?.name),
    type: str(raw?.type, "assistant") || "assistant",
    description: str(raw?.description),
    role: str(raw?.role) || str(settings.role),
    personality: str(raw?.personality_traits),
    instructions: str(raw?.initial_prompt),
    systemPrompt: str(config.system_prompt),
    email: str(raw?.email),
    phone: str(raw?.phone_number),
    model: str(config.model) || str(config.modelName),
    responseMode: nearest(RESPONSE_MODES, config.temperature, "balanced"),
    responseLength: nearest(RESPONSE_LENGTHS, config.maxTokens, "balanced"),
    tools: declared ?? defaultTools(catalog),
    toolsLegacy: declared === null && !human,
    policy: policyDraft(config.policy),
    heartbeat: {
      mode: (HEARTBEAT_MODES.some((m) => m.id === raw?.heartbeat_mode) ? raw.heartbeat_mode : "off") as HeartbeatMode,
      frequency: str(settings.heartbeat_frequency) || "every_30_minutes",
      workingDays: days.length ? days : ["mon", "tue", "wed", "thu", "fri"],
      briefingTime: str(settings.heartbeat_briefing_time) || "08:00",
    },
    bloqId: typeof raw?.bloq_id === "number" ? raw.bloq_id : raw?.bloq_id ? Number(raw.bloq_id) : null,
    useKnowledgeBase: settings.useKnowledgeBase !== false,
    memoryPersistence: settings.memoryPersistence !== false,
  }
}

/** file_attachments, split the way ELON's Files and Memory steps split them. */
export function attachmentCounts(raw: any): { files: number; memory: number } {
  const list = Array.isArray(raw?.file_attachments) ? raw.file_attachments : []
  const memory = list.filter((f: any) => f?.type === "memory").length
  return { files: list.length - memory, memory }
}

// ── policy (Rules & approvals) ─────────────────────────────────────────────────────────────

const list = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i)

/** iris-api's stored policy → the form. */
export function policyDraft(p: any): PolicyDraft {
  const o = obj(p)
  const join = (v: unknown) => strs(v).join(", ")
  return {
    denied: join(o.denied_tools),
    allowed: join(o.allowed_tools),
    requireApproval: join(o.require_approval),
    preApproved: join(o.pre_approved),
    caps: Object.entries(obj(o.max_calls_per_day))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
    spendCap: typeof o.spend_cap_per_day === "number" ? String(o.spend_cap_per_day) : "",
    quietStart: str(o.quiet_hours?.start),
    quietEnd: str(o.quiet_hours?.end),
    quietTimezone: str(o.quiet_hours?.timezone),
    timezone: str(o.timezone),
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** The form → iris-api's PUT {policy}. Null = no rules (clears it). Errors are per field. */
export function policyPayload(d: PolicyDraft): { policy: Record<string, unknown> | null; errors: string[] } {
  const errors: string[] = []
  const out: Record<string, unknown> = {}
  const lists: [keyof PolicyDraft, string][] = [
    ["denied", "denied_tools"],
    ["allowed", "allowed_tools"],
    ["requireApproval", "require_approval"],
    ["preApproved", "pre_approved"],
  ]
  for (const [k, key] of lists) {
    const v = list(d[k])
    if (v.length) out[key] = v
  }
  const caps: Record<string, number> = {}
  for (const line of d.caps.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(.+?)\s*[:=]\s*(\d+)$/)
    if (!m) errors.push(`Daily call limit "${line}" — write it as pattern: number, e.g. send_email: 20`)
    else caps[m[1].trim().toLowerCase()] = Number(m[2])
  }
  if (Object.keys(caps).length) out.max_calls_per_day = caps
  if (d.spendCap.trim()) {
    const n = Number(d.spendCap)
    if (!Number.isFinite(n) || n < 0) errors.push("Daily spend cap must be a number ≥ 0.")
    else out.spend_cap_per_day = Math.round(n * 100) / 100
  }
  if (d.quietStart || d.quietEnd) {
    if (!HHMM.test(d.quietStart) || !HHMM.test(d.quietEnd)) errors.push("Quiet hours need a start and an end, as HH:MM (24-hour).")
    else
      out.quiet_hours = {
        start: d.quietStart,
        end: d.quietEnd,
        ...(d.quietTimezone.trim() ? { timezone: d.quietTimezone.trim() } : {}),
      }
  }
  if (d.timezone.trim()) out.timezone = d.timezone.trim()
  return { policy: Object.keys(out).length ? out : null, errors }
}

/** Selected tools that send or pay — what "Require approval for these" adds to require_approval. */
export function riskyTools(catalog: Catalog, selected: readonly string[]): string[] {
  const out: string[] = []
  for (const s of selected) {
    const t = toolFor(catalog, s)
    if (t && (t.effect === "egress" || t.effect === "payment") && !out.includes(t.id.toLowerCase())) out.push(t.id.toLowerCase())
  }
  return out
}

export function addToList(text: string, names: string[]): string {
  return [...list(text), ...names.map((n) => n.toLowerCase())].filter((x, i, a) => a.indexOf(x) === i).join(", ")
}

// ── validation & completion ────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FREQ = /^(hourly|daily|every_\d+_(minutes|hours))$/

export interface Ctx {
  models: readonly OfferedModel[]
  /** Alerts have their own state; the step is complete once they were read. */
  alertsRead?: boolean
}

export function stepErrors(step: StepId, d: Draft, ctx: Ctx): string[] {
  const e: string[] = []
  switch (step) {
    case "basic":
      if (!d.name.trim()) e.push("Give it a name.")
      if (d.name.length > 255) e.push("Names are at most 255 characters.")
      if (d.isHuman && d.email.trim() && !EMAIL.test(d.email.trim())) e.push("That email address does not look right.")
      if (d.instructions.length > 50000) e.push("Instructions are at most 50,000 characters.")
      break
    case "model":
      if (d.isHuman) break
      if (!d.model) e.push("Pick a model.")
      else if (ctx.models.length && !isOffered(ctx.models, d.model))
        e.push(`${d.model} is not offered any more — pick one of the models below.`)
      break
    case "tools":
      if (d.isHuman) break
      if (d.toolsLegacy) e.push("This agent was never given a tool list, so it may use every tool. Save a list to scope it.")
      break
    case "rules":
      e.push(...policyPayload(d.policy).errors)
      break
    case "schedule":
      if (d.isHuman || d.heartbeat.mode === "off") break
      if (!FREQ.test(d.heartbeat.frequency)) e.push("Pick how often it wakes.")
      if (!d.heartbeat.workingDays.length) e.push("Pick at least one working day.")
      if (d.heartbeat.mode === "briefing" && !HHMM.test(d.heartbeat.briefingTime)) e.push("Briefing time is HH:MM (24-hour).")
      break
    case "memory":
      if (d.bloqId == null) e.push("Pick the board it works from.")
      break
  }
  return e
}

/** ELON's completion ticks (isStepCompleted), for the steps that exist here. */
export function stepComplete(step: StepId, d: Draft, ctx: Ctx): boolean {
  if (stepErrors(step, d, ctx).length) return false
  switch (step) {
    case "basic":
      return !!d.name.trim() && (d.isHuman ? !!d.role.trim() : !!(d.instructions.trim() || d.personality.trim() || d.systemPrompt.trim()))
    case "model":
      return d.isHuman || !!d.model
    case "tools":
      return d.isHuman || !d.toolsLegacy
    case "rules":
      return true
    case "schedule":
      return true
    case "memory":
      return d.bloqId != null
    case "alerts":
      return !!ctx.alertsRead
    default:
      return false
  }
}

/** Steps whose saved part differs from what was read. */
export function slice(step: StepId, d: Draft): unknown {
  switch (step) {
    case "basic":
      return [d.isHuman, d.name, d.type, d.description, d.role, d.personality, d.instructions, d.systemPrompt, d.email, d.phone]
    case "model":
      return [d.model, d.responseMode, d.responseLength]
    case "tools":
      return [[...d.tools].map((t) => t.toLowerCase()).sort(), d.toolsLegacy]
    case "rules":
      return policyPayload(d.policy).policy
    case "schedule":
      return d.heartbeat.mode === "off" ? ["off"] : [d.heartbeat.mode, d.heartbeat.frequency, d.heartbeat.workingDays, d.heartbeat.mode === "briefing" ? d.heartbeat.briefingTime : ""]
    case "memory":
      return [d.bloqId, d.useKnowledgeBase, d.memoryPersistence]
    default:
      return null
  }
}

export const isDirty = (step: StepId, d: Draft, original: Draft | null) =>
  !original || JSON.stringify(slice(step, d)) !== JSON.stringify(slice(step, original))

// ── payloads ───────────────────────────────────────────────────────────────────────────────

/** The Personality step's fields, as fl-api's store/update reads them. No `config`. */
export function basicBody(d: Draft): Record<string, unknown> {
  return {
    name: d.name.trim(),
    type: d.isHuman ? "human" : d.type || "assistant",
    isHuman: d.isHuman ? "true" : "false",
    description: d.description.trim(),
    role: d.role.trim(),
    initial_prompt: d.instructions,
    personality_traits: d.personality,
    ...(d.email.trim() ? { email: d.email.trim() } : {}),
    ...(d.phone.trim() ? { phone_number: d.phone.trim() } : {}),
  }
}

/**
 * The Model step as a config PATCH. A model picked here is served by IRIS, so a provider an older
 * editor set (openrouter, ollama, a custom endpoint) would route the new model to the wrong place:
 * those keys are cleared, nothing else in config is touched.
 */
export function modelPatch(d: Draft, storedConfig: Record<string, any> = {}): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    model: d.model,
    modelName: d.model,
    temperature: RESPONSE_MODES[d.responseMode],
    maxTokens: RESPONSE_LENGTHS[d.responseLength],
  }
  const p = str(storedConfig.provider)
  if (p && p !== "iris" && p !== "openai") Object.assign(patch, { provider: null, endpoint: null, apiKey: null })
  return patch
}

export function memoryBody(d: Draft): Record<string, unknown> {
  return {
    ...(d.bloqId != null ? { bloq_id: d.bloqId } : {}),
    settings: { useKnowledgeBase: d.useKnowledgeBase, memoryPersistence: d.memoryPersistence },
  }
}

export function heartbeatBody(d: Draft): Record<string, unknown> {
  const h = d.heartbeat
  if (h.mode === "off") return { mode: "off" }
  return {
    mode: h.mode,
    frequency: h.frequency,
    working_days: h.workingDays,
    ...(h.mode === "briefing" ? { briefing_time: h.briefingTime } : {}),
  }
}

/**
 * The create body. The ONE time config travels with the agent: a new agent has nothing to
 * erase, and its allowlist must be explicit from the first save (P2 #191437) — never absent,
 * which reads as the full legacy tool set.
 */
export function createBody(d: Draft): Record<string, unknown> {
  return {
    ...basicBody(d),
    ...(d.bloqId != null ? { bloq_id: d.bloqId } : {}),
    settings: { isHuman: d.isHuman, useKnowledgeBase: d.useKnowledgeBase, memoryPersistence: d.memoryPersistence },
    config: d.isHuman
      ? { tools: [] }
      : { ...modelPatch(d), ...(d.systemPrompt.trim() ? { system_prompt: d.systemPrompt } : {}), tools: [...d.tools] },
  }
}

/** What one step's save sends, in order. The component runs these against the sidecar. */
export type SaveCall =
  | { kind: "agent"; body: Record<string, unknown>; configPatch?: Record<string, unknown> }
  | { kind: "tools"; tools: string[] }
  | { kind: "policy"; policy: Record<string, unknown> | null }
  | { kind: "heartbeat"; body: Record<string, unknown> }

export function saveCalls(step: StepId, d: Draft, original: Draft | null, storedConfig: Record<string, any> = {}): SaveCall[] {
  switch (step) {
    case "basic": {
      const changedPrompt = !original || d.systemPrompt !== original.systemPrompt
      return [{ kind: "agent", body: basicBody(d), ...(changedPrompt && !d.isHuman ? { configPatch: { system_prompt: d.systemPrompt } } : {}) }]
    }
    case "model":
      return d.isHuman ? [] : [{ kind: "agent", body: {}, configPatch: modelPatch(d, storedConfig) }]
    case "tools":
      return d.isHuman ? [] : [{ kind: "tools", tools: [...d.tools] }]
    case "rules": {
      const p = policyPayload(d.policy)
      return p.errors.length || d.isHuman ? [] : [{ kind: "policy", policy: p.policy }]
    }
    case "schedule":
      return d.isHuman ? [] : [{ kind: "heartbeat", body: heartbeatBody(d) }]
    case "memory":
      return [{ kind: "agent", body: memoryBody(d) }]
    default:
      return []
  }
}

// ── alerts (status settings, fl-api #170) ──────────────────────────────────────────────────

export const ALERT_FIELDS = ["channels", "min_severity", "platform_notices", "emails", "user_ids"] as const
export type AlertField = (typeof ALERT_FIELDS)[number]
export type AlertLevel = "project" | "account" | "default"

export interface AlertsForm {
  /** "inherit" leaves the key unset at this level, so the next level applies. */
  channels: "inherit" | "off" | { email: boolean; in_app: boolean; sms: boolean }
  minSeverity: "inherit" | "minor" | "major" | "critical"
  platformNotices: "inherit" | "affected" | "all" | "none"
  /** Blank = inherit. */
  emails: string
  userIds: string
}

/** Where each effective value comes from: project > account > default, field by field. */
export function alertSources(data: any): Record<AlertField, { value: unknown; from: AlertLevel }> {
  const project = obj(data?.project)
  const user = obj(data?.user)
  const effective = obj(data?.effective)
  const out = {} as Record<AlertField, { value: unknown; from: AlertLevel }>
  for (const f of ALERT_FIELDS) {
    const from: AlertLevel = f in project ? "project" : f in user ? "account" : "default"
    out[f] = { value: effective[f] ?? null, from }
  }
  return out
}

/** One level's OWN keys → the form (a key it does not set reads as "inherit"). */
export function alertsForm(data: any, level: "project" | "account"): AlertsForm {
  const own = obj(level === "project" ? data?.project : data?.user)
  const ch = own.channels
  return {
    channels: !("channels" in own) || ch === null
      ? "inherit"
      : Array.isArray(ch) && ch.length === 0
        ? "off"
        : {
            email: strs(ch).includes("email"),
            in_app: strs(ch).some((c) => c === "database" || c === "in_app"),
            sms: strs(ch).includes("sms"),
          },
    minSeverity: ["minor", "major", "critical"].includes(own.min_severity) ? own.min_severity : "inherit",
    platformNotices: ["affected", "all", "none"].includes(own.platform_notices) ? own.platform_notices : "inherit",
    emails: strs(own.emails).join(", "),
    userIds: Array.isArray(own.user_ids) ? own.user_ids.join(", ") : "",
  }
}

/** The form → a PUT body. Null removes the key at this level. Errors stop the save. */
export function alertsChanges(f: AlertsForm): { changes: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []
  const changes: Record<string, unknown> = {}
  changes.channels =
    f.channels === "inherit"
      ? null
      : f.channels === "off"
        ? []
        : [f.channels.email && "email", f.channels.in_app && "database", f.channels.sms && "sms"].filter(Boolean)
  if (Array.isArray(changes.channels) && f.channels !== "off" && !(changes.channels as string[]).length)
    errors.push("Pick at least one channel, or choose Off.")
  changes.min_severity = f.minSeverity === "inherit" ? null : f.minSeverity
  changes.platform_notices = f.platformNotices === "inherit" ? null : f.platformNotices
  const emails = f.emails
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const bad = emails.filter((e) => !EMAIL.test(e))
  if (bad.length) errors.push(`Not an email address: ${bad.join(", ")}`)
  if (emails.length > 10) errors.push("At most 10 email contacts.")
  changes.emails = emails.length ? emails : null
  const ids = f.userIds
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const badIds = ids.filter((x) => !/^\d+$/.test(x) || Number(x) < 1)
  if (badIds.length) errors.push(`User ids are numbers: ${badIds.join(", ")}`)
  if (ids.length > 10) errors.push("At most 10 people.")
  changes.user_ids = ids.length ? ids.map(Number) : null
  return { changes, errors }
}

/** A value as one short line, for the "effective" column. */
export function alertValue(field: AlertField, v: unknown): string {
  if (field === "channels") {
    if (v === null || v === undefined) return "by severity"
    const c = strs(v).map((x) => (x === "database" ? "in-app" : x))
    return c.length ? c.join(" + ") : "off"
  }
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none"
  return v === null || v === undefined || v === "" ? "—" : String(v)
}
