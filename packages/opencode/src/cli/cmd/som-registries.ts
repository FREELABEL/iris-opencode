// SOM keeps a campaign's strategy in TWO registries (#191770):
//   1. raichu  /api/v1/som/campaigns            — what `iris som campaign update` and `iris som toggle` write
//   2. freelabel.net campaign templates (type=som, config.strategy) — what the hive daemon reads through
//      /api/v1/campaign-templates/daemon-configs and writes into som/.som-campaigns-cache.json before
//      EVERY batch, and what `iris som sync` writes into the same cache (#191686).
// Updating only (1) left (2) on the old strategy, and the 2026-10-29 02:01 run sent 9 old openers.
// These helpers keep the two in step and make drift visible.

export interface SomTemplate {
  id: string
  type?: string
  prompt_base?: string
  config?: Record<string, any> | null
}

export interface CampaignRef {
  name: string
  bloq_id: string | number | null
  ig_account: string | null
}

/** The som-type template for a campaign: same board AND same IG account. Never guesses. */
export function pickTemplateForCampaign(templates: SomTemplate[], c: CampaignRef): SomTemplate | null {
  const board = String(c.bloq_id ?? "")
  const ig = String(c.ig_account ?? "").replace(/^@/, "").toLowerCase()
  const som = templates.filter((t) => t.type === "som" && t.config)
  const matches = som.filter(
    (t) => String(t.config!.boardId ?? "") === board && String(t.config!.igAccount ?? "").replace(/^@/, "").toLowerCase() === ig,
  )
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return matches.find((t) => t.prompt_base === c.name) ?? null
  return null
}

/** PUT /campaign-templates/{id} replaces `config` wholesale, so carry every other key across. */
export function mergeTemplateStrategy(config: Record<string, any> | null | undefined, strategy: string): Record<string, any> {
  return { ...(config ?? {}), strategy }
}

/** Campaigns whose strategy differs between raichu and the daemon's registry. */
export function registryDrift(
  somCampaigns: { name: string; strategy_name: string | null }[],
  daemonConfigs: Record<string, { strategy?: string | null }>,
) {
  const out: { name: string; som: string; daemon: string }[] = []
  for (const c of somCampaigns) {
    const d = daemonConfigs[c.name]
    if (!d) continue
    const a = c.strategy_name ?? ""
    const b = d.strategy ?? ""
    if (a && b && a !== b) out.push({ name: c.name, som: a, daemon: b })
  }
  return out
}

/** The template list, whichever envelope the API answers with. */
export function extractTemplates(body: any): SomTemplate[] {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.templates)) return body.templates
  if (Array.isArray(body?.data?.templates)) return body.data.templates
  if (Array.isArray(body?.data?.data)) return body.data.data
  return []
}
