/**
 * `iris mcp list --json` (#191845) — the same two facts the human listing prints, as data:
 * the MCP servers this CLI session is configured with (and their live status), and which
 * external clients have the IRIS MCP server registered.
 *
 * Shape (stable; mirrors `iris mcp tools --json`, which answers `{ ok, server, tools }`):
 *
 *   {
 *     ok: true,
 *     servers: [{ name, type: "local"|"remote", target, status, error?, oauth }],
 *     clients: [{ id, label, registered, detected, configPath }],
 *     meta: { servers: n, clients_registered: n }
 *   }
 *
 * `status` is one of connected | disabled | failed | needs_auth | needs_client_registration |
 * not_initialized. `target` is the URL for a remote server and the joined command for a local
 * one — exactly what the human listing shows. Environment and headers are never included.
 */

export type McpListStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration"
  | "not_initialized"

export interface McpListServerInput {
  name: string
  config: { type: "local"; command: string[] } | { type: "remote"; url: string; oauth?: unknown }
  status?: { status: string; error?: string }
}

export interface McpListClientInput {
  id: string
  label: string
  configPath: string
  detected: boolean
  registered: boolean
}

export interface McpListServer {
  name: string
  type: "local" | "remote"
  target: string
  status: McpListStatus
  error?: string
  oauth: boolean
}

export interface McpListJson {
  ok: true
  servers: McpListServer[]
  clients: McpListClientInput[]
  meta: { servers: number; clients_registered: number }
}

const KNOWN: ReadonlySet<string> = new Set(["connected", "disabled", "failed", "needs_auth", "needs_client_registration"])

export function buildMcpListJson(servers: McpListServerInput[], clients: McpListClientInput[]): McpListJson {
  const rows = servers.map((s): McpListServer => {
    const raw = s.status?.status
    const status = (raw && KNOWN.has(raw) ? raw : raw ? "failed" : "not_initialized") as McpListStatus
    const row: McpListServer = {
      name: s.name,
      type: s.config.type,
      target: s.config.type === "remote" ? s.config.url : s.config.command.join(" "),
      status,
      oauth: s.config.type === "remote" && !!s.config.oauth,
    }
    if (s.status?.error) row.error = s.status.error
    return row
  })
  const clientRows = clients.map((c) => ({
    id: c.id,
    label: c.label,
    registered: c.registered,
    detected: c.detected,
    configPath: c.configPath,
  }))
  return {
    ok: true,
    servers: rows,
    clients: clientRows,
    meta: { servers: rows.length, clients_registered: clientRows.filter((c) => c.registered).length },
  }
}
