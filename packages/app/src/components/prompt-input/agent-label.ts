/**
 * What the composer's agent picker calls an agent (#192926).
 *
 * `iris agents desktop-sync` writes each IRIS agent to ~/.config/opencode/agents/iris-<slug>.md, and
 * the engine names an agent after its file — so the picker listed `iris-aiai-newsroom-agent`, which
 * CSS `capitalize` turned into "Iris-Aiai-Newsroom-Agent". The sync already writes the agent's real
 * name into its description: "AIAI Newsroom Agent (IRIS agent #702) — …". That is the label, the same
 * name the Agents gallery shows. Anything else keeps its id, first letter capitalised ("Build").
 *
 * Two IRIS agents can share a name; each then carries its #id, so the picker never shows two rows
 * that read the same.
 */
const SYNCED = /^(.+?) \(IRIS agent #(\d+)\)/

export function agentLabels(agents: readonly { name: string; description?: string }[]): Record<string, string> {
  const parsed = agents.map((agent) => {
    const match = agent.description?.match(SYNCED)
    return match
      ? { name: agent.name, label: match[1]!.trim(), id: match[2] }
      : { name: agent.name, label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1), id: undefined }
  })
  const count = new Map<string, number>()
  for (const p of parsed) count.set(p.label, (count.get(p.label) ?? 0) + 1)
  return Object.fromEntries(
    parsed.map((p) => [p.name, p.id && count.get(p.label)! > 1 ? `${p.label} #${p.id}` : p.label]),
  )
}
