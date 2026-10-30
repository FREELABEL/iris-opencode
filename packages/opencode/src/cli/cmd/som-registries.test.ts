import { test, expect } from "bun:test"
import { pickTemplateForCampaign, mergeTemplateStrategy, registryDrift, extractTemplates, confirmSenderStrategy, senderView, mergeTemplateCampaign } from "./som-registries"
import { toggleTarget } from "./platform-schedules"

// The two SOM registries (#191770): raichu som_campaigns, and the freelabel.net campaign templates the
// hive daemon reads (daemon-configs) and writes into the cache before every batch.
const templates = [
  { id: "a", type: "som", prompt_base: "courses", config: { boardId: "38", strategy: "AI Course | V3", igAccount: "heyiris.io" } },
  { id: "b", type: "som", prompt_base: "creators", config: { boardId: "80", strategy: "Creator Outreach | V1", igAccount: "thediscoverpage_" } },
  { id: "c", type: "som", prompt_base: "freelabelnet", config: { boardId: "80", strategy: "Creator Outreach | V1", igAccount: "freelabelnet" } },
  { id: "d", type: "leadgen", prompt_base: "courses", config: { boardId: "38", igAccount: "heyiris.io" } },
]

test("pickTemplateForCampaign: matches board + IG account, som type only", () => {
  expect(pickTemplateForCampaign(templates, { name: "courses", bloq_id: "38", ig_account: "heyiris.io" })?.id).toBe("a")
  // board 80 has two som templates; the IG account decides
  expect(pickTemplateForCampaign(templates, { name: "creators", bloq_id: 80, ig_account: "thediscoverpage_" })?.id).toBe("b")
  expect(pickTemplateForCampaign(templates, { name: "freelabelnet", bloq_id: "80", ig_account: "freelabelnet" })?.id).toBe("c")
})

test("pickTemplateForCampaign: null when nothing matches (never guesses)", () => {
  expect(pickTemplateForCampaign(templates, { name: "venues", bloq_id: "292", ig_account: "x" })).toBeNull()
})

test("mergeTemplateStrategy: keeps every other config key (PUT replaces config wholesale)", () => {
  const merged = mergeTemplateStrategy({ boardId: "38", strategy: "AI Course | V3", igAccount: "heyiris.io", extra: 1 }, "Roadmap Commenters | V1")
  expect(merged).toEqual({ boardId: "38", strategy: "Roadmap Commenters | V1", igAccount: "heyiris.io", extra: 1 })
})

test("registryDrift: reports campaigns whose strategy differs between the registries", () => {
  const som = [
    { name: "courses", strategy_name: "Roadmap Commenters | V1" },
    { name: "creators", strategy_name: "IRIS for Creators | V1" },
    { name: "beatbox", strategy_name: "DJ Outreach | V2" },
  ]
  const daemon = {
    courses: { strategy: "AI Course | V3" },
    creators: { strategy: "IRIS for Creators | V1" },
    beatbox: { strategy: "DJ Outreach | V2" },
  }
  expect(registryDrift(som, daemon)).toEqual([{ name: "courses", som: "Roadmap Commenters | V1", daemon: "AI Course | V3" }])
})

test("extractTemplates: reads the list whatever envelope the API uses", () => {
  expect(extractTemplates({ data: templates })).toHaveLength(4)
  expect(extractTemplates({ templates })).toHaveLength(4)
  expect(extractTemplates({ data: { templates } })).toHaveLength(4)
  expect(extractTemplates(templates)).toHaveLength(4)
  expect(extractTemplates(null)).toEqual([])
})

// `iris schedules toggle <id>` always ENABLED (2026-10-29: it re-enabled a follow-up schedule the
// operator meant to pause). With no flag it must flip the current status.
test("toggleTarget: flips the current status when no flag is given", () => {
  expect(toggleTarget("scheduled", {})).toBe("paused")
  expect(toggleTarget("active", {})).toBe("paused")
  expect(toggleTarget("paused", {})).toBe("scheduled")
  expect(toggleTarget("disabled", {})).toBe("scheduled")
})

test("toggleTarget: explicit flags win over the current status", () => {
  expect(toggleTarget("scheduled", { disable: true })).toBe("paused")
  expect(toggleTarget("paused", { enable: true })).toBe("scheduled")
  expect(toggleTarget("scheduled", { enable: true })).toBe("scheduled")
})

// ── #191686 / #191770: after `iris som campaign update`, the sender must read the NEW script ──

function world(api: "current" | "older") {
  const som = { courses: { name: "courses", strategy_name: "AI Course | V3", bloq_id: 38 as number | string | null } }
  const template = { boardId: "38", strategy: "AI Course | V3", igAccount: "heyiris.io", limit: 9 }
  let templateWrites = 0
  const readSender = async () => ({
    courses: api === "current"
      ? { boardId: String(som.courses.bloq_id), strategy: som.courses.strategy_name, strategySource: "som_campaigns" }
      : { boardId: template.boardId, strategy: template.strategy },
  })
  const writeLegacyTemplate = async () => {
    templateWrites++
    Object.assign(template, mergeTemplateCampaign(template, { strategy: som.courses.strategy_name!, bloq_id: som.courses.bloq_id }))
    return true
  }
  return { som, template, readSender, writeLegacyTemplate, writes: () => templateWrites }
}

test("confirmSenderStrategy: a current API serves the updated strategy and nothing else is written", async () => {
  const w = world("current")
  w.som.courses.strategy_name = "Roadmap Commenters | V1" // PUT /som/campaigns/courses
  const r = await confirmSenderStrategy(w.som.courses, w)
  expect(r).toEqual({ ok: true, how: "served", seen: "Roadmap Commenters | V1" })
  expect(w.writes()).toBe(0)
})

test("confirmSenderStrategy: an older API gets its template copy moved, and the sender then reads the new one", async () => {
  const w = world("older")
  w.som.courses.strategy_name = "Roadmap Commenters | V1"
  w.som.courses.bloq_id = 355 // the board moved too (freelabelnet, 2026-10-30)
  const r = await confirmSenderStrategy(w.som.courses, w)
  expect(r).toEqual({ ok: true, how: "template", seen: "Roadmap Commenters | V1" })
  expect(w.template).toEqual({ boardId: "355", strategy: "Roadmap Commenters | V1", igAccount: "heyiris.io", limit: 9 })
})

test("confirmSenderStrategy: reports failure when the sender still reads the old strategy", async () => {
  const w = world("older")
  w.som.courses.strategy_name = "Roadmap Commenters | V1"
  const r = await confirmSenderStrategy(w.som.courses, { readSender: w.readSender, writeLegacyTemplate: async () => true })
  expect(r.ok).toBe(false)
  expect(r.seen).toBe("AI Course | V3")
})

test("senderView: shows what the sender uses and whether it matches som_campaigns", () => {
  const c = { name: "freelabelnet", strategy_name: "Artist Outreach | FFAT V1", bloq_id: 355 }
  expect(senderView(c, { freelabelnet: { boardId: "80", strategy: "Creator Outreach | V1" } })).toEqual({
    known: true, strategy: "Creator Outreach | V1", board: "80", source: "template (older API)", matches: false,
  })
  expect(senderView(c, { freelabelnet: { boardId: "355", strategy: "Artist Outreach | FFAT V1", strategySource: "som_campaigns" } }).matches).toBe(true)
  expect(senderView(c, {}).known).toBe(false)
})

test("pickTemplateForCampaign: the template NAMED for the campaign wins even when its board is stale", () => {
  const t = [{ id: "x", type: "som", prompt_base: "freelabelnet", config: { boardId: "80", strategy: "Creator Outreach | V1", igAccount: "freelabelnet" } }]
  expect(pickTemplateForCampaign(t, { name: "freelabelnet", bloq_id: 355, ig_account: "freelabelnet" })?.id).toBe("x")
})
