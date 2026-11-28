import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { homedir } from "os"
import { IRIS_API, irisFetch, resolveUserId, tokenSource } from "./platform"

/**
 * The writes behind three detail views that had none (#194582): revoke a Hive peer connection,
 * and take an MCP server out of this project's settings. (Publishing a site is in genesis-sites.ts,
 * with the other site writes.) There is no CLI command for either, so a button could only copy a
 * command that does not exist. Each answers in words and never claims more than it did.
 */

export interface ActionResult {
  ok: boolean
  reason?: string
}

/** The seam a test replaces: the platform call and who is signed in. */
export const peerDeps = {
  fetch: (p: string, init?: RequestInit) => irisFetch(p, IRIS_API, init),
  userId: () => resolveUserId(),
}

/** A connection id is a UUID; anything else is refused before it reaches a URL. */
const CONNECTION_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * End a Hive peer connection — or cancel an invite nobody accepted (the same row upstream).
 * iris-api DELETE /api/v6/nodes/connections/{id}: marks it revoked and deletes it, for either side.
 */
export async function revokeHivePeer(id: string): Promise<ActionResult> {
  if (!CONNECTION_ID.test(id)) return { ok: false, reason: "that is not a connection this panel knows" }
  const userId = await peerDeps.userId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  try {
    const res = await peerDeps.fetch(`/api/v6/nodes/connections/${id}?user_id=${userId}`, { method: "DELETE" })
    if (res.ok) return { ok: true }
    if (res.status === 404) return { ok: false, reason: "that connection no longer exists" }
    if (res.status === 403) return { ok: false, reason: "you are not part of that connection" }
    const j = (await res.json().catch(() => ({}))) as any
    return { ok: false, reason: String(j?.message ?? j?.error ?? `iris-api ${res.status}`) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export interface McpRemoveResult extends ActionResult {
  /** The settings file it was taken out of. */
  file?: string
}

/** The global settings folder, derived like dataDir() in platform.ts (importing core/global makes directories at load). */
export function globalConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(homedir(), ".config", "opencode")
}

const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"]

/**
 * Where an MCP server can be written down, nearest first: the project folder and each folder above
 * it up to the repository root (each with its `.opencode/`), then the global settings folder.
 * The same files `iris mcp add` writes to. Managed (admin) settings are never edited.
 */
export function mcpConfigCandidates(project: string | undefined, globalDir: string = globalConfigDir()): string[] {
  const out: string[] = []
  if (project) {
    let dir = path.resolve(project)
    for (let i = 0; i < 32; i++) {
      for (const n of CONFIG_NAMES) out.push(path.join(dir, n), path.join(dir, ".opencode", n))
      if (existsSync(path.join(dir, ".git"))) break
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  for (const n of [...CONFIG_NAMES, "config.json"]) out.push(path.join(globalDir, n))
  return out
}

/**
 * Take an MCP server out of the settings file that defines it, keeping the file's comments and
 * formatting. Only the first file that has it is changed; if it is defined nowhere IRIS edits,
 * nothing is written and the reason says so.
 */
export async function removeMcpServer(input: { name: string; project?: string; globalDir?: string }): Promise<McpRemoveResult> {
  const name = input.name
  if (!name || name.length > 200) return { ok: false, reason: "no server name" }
  for (const file of mcpConfigCandidates(input.project, input.globalDir)) {
    let text: string
    try {
      text = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    const data = parseJsonc(text, [], { allowTrailingComma: true }) as any
    if (!data || typeof data !== "object" || !data.mcp || typeof data.mcp !== "object" || !(name in data.mcp)) continue
    const edits = modify(text, ["mcp", name], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    const next = applyEdits(text, edits)
    const after = parseJsonc(next, [], { allowTrailingComma: true }) as any
    if (after?.mcp && name in after.mcp) return { ok: false, reason: `could not take it out of ${file}`, file }
    await fs.writeFile(file, next)
    return { ok: true, file }
  }
  return { ok: false, reason: "it is not in a settings file IRIS edits (it may come from an admin or a plugin)" }
}
