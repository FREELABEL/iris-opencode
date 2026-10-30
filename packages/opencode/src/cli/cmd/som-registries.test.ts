import { test, expect } from "bun:test"
import { pickTemplateForCampaign, mergeTemplateStrategy, registryDrift, extractTemplates } from "./som-registries"
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
