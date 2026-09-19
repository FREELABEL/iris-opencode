import * as McpCatalog from "./catalog"

export interface ServerTool {
  name: string
  description?: string
}

/**
 * The tools one MCP server exposes, from the flat `sanitize(server)_sanitize(tool)` map the MCP
 * service returns.
 *
 * A key cannot be split back into (server, tool): with servers "a" and "a_b", the key "a_b_run"
 * fits both. Each entry is therefore confirmed by recomposing its key from the server name and the
 * tool's OWN name — an exact match or it belongs to someone else. Sorted, so a list of tools does
 * not reorder itself between reads.
 */
export function toolsOfServer(server: string, tools: Record<string, { def: { name: string; description?: string } }>): ServerTool[] {
  const out: ServerTool[] = []
  for (const [key, value] of Object.entries(tools)) {
    const name = value?.def?.name
    if (!name || McpCatalog.toolName(server, name) !== key) continue
    out.push({ name, description: value.def.description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
