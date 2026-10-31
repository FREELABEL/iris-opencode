// SOM keeps a campaign's strategy in TWO registries (#191770):
//   1. raichu  /api/v1/som/campaigns            — what `iris som campaign update` and `iris som toggle` write
//   2. freelabel.net campaign templates (type=som, config.strategy) — what the hive daemon reads through
//      /api/v1/campaign-templates/daemon-configs and writes into som/.som-campaigns-cache.json before
//      EVERY batch, and what `iris som sync` writes into the same cache (#191686).
// Updating only (1) left (2) on the old strategy, and the 2026-10-29 02:01 run sent 9 old openers.
//
// fl-iris-api now builds daemon-configs FROM (1) (strategySource: "som_campaigns"), so (1) is the one
// source and nothing has to be copied. The helpers below read what the sender will actually use, and
// only write (2) when talking to an older API that still serves the template copy.

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

/**
 * The som-type template for a campaign. daemon-configs keys campaigns by the template's prompt_base,
 * so a template NAMED for the campaign is the one the sender reads — even when its board is the
 * stale part (freelabelnet: template board 80, campaign board 355). Otherwise same board AND same IG
 * account. Never guesses.
 */
export function pickTemplateForCampaign(templates: SomTemplate[], c: CampaignRef): SomTemplate | null {
  const named = templates.filter((t) => t.type === "som" && t.config && t.prompt_base === c.name)
  if (named.length === 1) return named[0]
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

/** Legacy write: lay the campaign's script-defining fields over a template's config, keeping every other key. */
export function mergeTemplateCampaign(
  config: Record<string, any> | null | undefined,
  c: { strategy: string; bloq_id?: string | number | null; ig_account?: string | null },
): Record<string, any> {
  const out: Record<string, any> = { ...(config ?? {}), strategy: c.strategy }
  if (c.bloq_id != null && String(c.bloq_id) !== "") out.boardId = String(c.bloq_id)
  if (c.ig_account) out.igAccount = c.ig_account
  return out
}

export interface SenderEntry {
  boardId?: string | number | null
  strategy?: string | null
  igAccount?: string | null
  strategySource?: string | null
  templateId?: string | null
}

/** What the hive sender will use for a campaign, next to what som_campaigns says. */
export function senderView(
  c: { name: string; strategy_name: string | null; bloq_id: string | number | null },
  configs: Record<string, SenderEntry> | null | undefined,
) {
  const e = configs?.[c.name] ?? null
  if (!e) return { known: false as const, strategy: null, board: null, source: null, matches: false }
  const strategy = e.strategy ?? null
  const board = e.boardId != null ? String(e.boardId) : null
  const matches = strategy === (c.strategy_name ?? null) && (c.bloq_id == null || board === String(c.bloq_id))
  return { known: true as const, strategy, board, source: e.strategySource ?? "template (older API)", matches }
}

/**
 * After som_campaigns has been written: make sure the sender reads the new strategy.
 * A current API already serves it (one source) and nothing else is written. An older API still
 * serves the template copy, so that copy is moved too and read back. Returns how it was confirmed.
 */
export async function confirmSenderStrategy(
  c: { name: string; strategy_name: string | null; bloq_id: string | number | null },
  deps: {
    readSender: () => Promise<Record<string, SenderEntry> | null>
    writeLegacyTemplate: () => Promise<boolean>
  },
): Promise<{ ok: boolean; how: "served" | "template" | "failed"; seen: string | null }> {
  const first = senderView(c, await deps.readSender())
  if (first.known && first.matches) return { ok: true, how: "served", seen: first.strategy }
  if (first.known && first.source === "som_campaigns") {
    // The API reads som_campaigns and still disagrees: copying the template would not help.
    return { ok: false, how: "failed", seen: first.strategy }
  }
  const wrote = await deps.writeLegacyTemplate()
  if (!wrote) return { ok: false, how: "failed", seen: first.strategy }
  const second = senderView(c, await deps.readSender())
  return { ok: second.known && second.matches, how: second.known && second.matches ? "template" : "failed", seen: second.strategy }
}
